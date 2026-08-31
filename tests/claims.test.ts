import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { freshDb, apiReq, json } from "./helpers";
import { getDb } from "@/lib/db";
import { DAY, resetClock, setNow } from "@/lib/clock";
import { completeClaim, findOrCreateOwner } from "@/lib/claims";
import { POST as register } from "@/app/api/v1/agents/register/route";
import { POST as claimRoute } from "@/app/api/owner/claim/complete/route";
import { randomUUID } from "node:crypto";

/**
 * `owners.auth_user_id` is a uuid column — it holds the Supabase `sub`. The
 * dashboard's stub path derives a well-formed v5 uuid from the email, so real
 * and stub logins both fit; these tests use real uuids for the same reason.
 */
const AUTH: Record<string, string> = new Proxy(
  {},
  { get: (target: Record<string, string>, key: string) => (target[key] ??= randomUUID()) },
);

/**
 * Owner claim binding.
 *
 * The property under test is not "does it bind" — it is that an agent can only
 * ever be bound to a VERIFIED human, and that no request input can name the
 * owner. Getting this wrong lets someone bind their agent to a stranger's
 * account, and the stranger cannot see why they suddenly own it.
 */

const T0 = "2026-09-14T00:00:00.000Z";
let ip = 0;

async function newAgent(name: string): Promise<{ id: string; token: string }> {
  ip += 1;
  const body = await json(
    await register(apiReq("POST", "/api/v1/agents/register", { body: { name }, ip: `10.14.0.${ip}` })),
  );
  if (!body.agent_id) throw new Error(`register(${name}): ${JSON.stringify(body)}`);
  const db = await getDb();
  const claim = await db.query<{ claim_token: string }>(
    `select claim_token from claims where agent_id = $1`, [body.agent_id]);
  return { id: body.agent_id, token: claim.rows[0].claim_token };
}

beforeAll(async () => {
  setNow(T0);
  await freshDb();
});

afterEach(() => setNow(T0));
afterAll(() => resetClock());

describe("completeClaim (the real path — called in-process with a session owner)", () => {
  it("binds the agent and moves it to claimed", async () => {
    const db = await getDb();
    const owner = await findOrCreateOwner(AUTH["auth-user-1"], "human@example.com");
    const agent = await newAgent("pinchy");

    const res = await completeClaim({ claimToken: agent.token, ownerId: owner });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.agent_name).toBe("pinchy");
    expect(res.already_owned).toBe(false);

    const row = await db.query<{ owner_id: string; status: string }>(
      `select owner_id, status from agents where id = $1`, [agent.id]);
    expect(row.rows[0].owner_id).toBe(owner);
    expect(row.rows[0].status).toBe("claimed");

    const used = await db.query<{ used_at: string | null }>(
      `select used_at from claims where claim_token = $1`, [agent.token]);
    expect(used.rows[0].used_at).not.toBeNull();
  });

  it("is idempotent for the SAME owner — a resubmitted form is not a failure", async () => {
    const owner = await findOrCreateOwner(AUTH["auth-user-2"], "two@example.com");
    const agent = await newAgent("shellsworth");
    expect((await completeClaim({ claimToken: agent.token, ownerId: owner })).ok).toBe(true);

    const again = await completeClaim({ claimToken: agent.token, ownerId: owner });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.already_owned).toBe(true);
  });

  it("REFUSES to rebind an agent that already belongs to someone else", async () => {
    const first = await findOrCreateOwner(AUTH["auth-user-3"], "three@example.com");
    const attacker = await findOrCreateOwner(AUTH["auth-user-4"], "four@example.com");
    const agent = await newAgent("seabastian");
    expect((await completeClaim({ claimToken: agent.token, ownerId: first })).ok).toBe(true);

    // Holding the claim token is NOT enough to take an agent from its owner.
    const stolen = await completeClaim({ claimToken: agent.token, ownerId: attacker });
    expect(stolen.ok).toBe(false);
    if (stolen.ok) return;
    expect(stolen.code).toBe("owned_by_other");

    const db = await getDb();
    const row = await db.query<{ owner_id: string }>(`select owner_id from agents where id = $1`, [agent.id]);
    expect(row.rows[0].owner_id).toBe(first); // unchanged
  });

  it("rejects unknown and expired tokens", async () => {
    const owner = await findOrCreateOwner(AUTH["auth-user-5"], "five@example.com");
    const unknown = await completeClaim({ claimToken: "not-a-real-token", ownerId: owner });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("not_found");

    const agent = await newAgent("expiring");
    setNow(Date.parse(T0) + 8 * DAY); // claims live 7 days
    const expired = await completeClaim({ claimToken: agent.token, ownerId: owner });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.code).toBe("expired");
  });
});

describe("findOrCreateOwner", () => {
  it("collapses repeat logins onto one owner row", async () => {
    const a = await findOrCreateOwner(AUTH["auth-repeat"], "same@example.com");
    const b = await findOrCreateOwner(AUTH["auth-repeat"], "same@example.com");
    expect(a).toBe(b);
    const db = await getDb();
    const count = await db.query<{ n: string }>(
      `select count(*) as n from owners where auth_user_id = $1`, [AUTH["auth-repeat"]]);
    expect(Number(count.rows[0].n)).toBe(1);
  });

  it("backfills an email learned later without overwriting one already stored", async () => {
    const db = await getDb();
    const id = await findOrCreateOwner(AUTH["auth-late"], null);
    let row = await db.query<{ email: string | null }>(`select email from owners where id = $1`, [id]);
    expect(row.rows[0].email).toBeNull();

    await findOrCreateOwner(AUTH["auth-late"], "late@example.com");
    row = await db.query<{ email: string | null }>(`select email from owners where id = $1`, [id]);
    expect(row.rows[0].email).toBe("late@example.com");

    await findOrCreateOwner(AUTH["auth-late"], "different@example.com");
    row = await db.query<{ email: string | null }>(`select email from owners where id = $1`, [id]);
    expect(row.rows[0].email).toBe("late@example.com"); // not overwritten
  });
});

describe("the HTTP route is dev-only and cannot be told whose agent this is", () => {
  it("accepts no owner id from the request body", async () => {
    const agent = await newAgent("bodyowner");
    const db = await getDb();
    const victim = await findOrCreateOwner(AUTH["auth-victim"], "victim@example.com");

    // Try to name someone else's owner in the body — the field does not exist.
    const res = await claimRoute(
      apiReq("POST", "/api/owner/claim/complete", {
        body: { claim_token: agent.token, owner_id: victim },
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.owner_id).not.toBe(victim); // a throwaway dev owner, not the named one

    const row = await db.query<{ owner_id: string }>(`select owner_id from agents where id = $1`, [agent.id]);
    expect(row.rows[0].owner_id).not.toBe(victim);
  });

  it("uses the dev header when it names a real owner", async () => {
    const owner = await findOrCreateOwner(AUTH["auth-dev-header"], "dev@example.com");
    const agent = await newAgent("headerowner");
    const body = await json(
      await claimRoute(
        apiReq("POST", "/api/owner/claim/complete", {
          body: { claim_token: agent.token },
          headers: { "x-clawllege-dev-owner": owner },
        }),
      ),
    );
    expect(body.owner_id).toBe(owner);
    expect(body.agent_name).toBe("headerowner");
  });

  it("REFUSES OUTRIGHT in production", async () => {
    const original = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string>).NODE_ENV = "production";
      const agent = await newAgent("prodclaim");
      const res = await claimRoute(
        apiReq("POST", "/api/owner/claim/complete", { body: { claim_token: agent.token } }),
      );
      expect(res.status).toBe(401);
      const body = await json(res);
      expect(body.error.hint).toMatch(/no API path that binds an agent to an owner you name/);

      const db = await getDb();
      const row = await db.query<{ owner_id: string | null }>(
        `select owner_id from agents where id = $1`, [agent.id]);
      expect(row.rows[0].owner_id).toBeNull(); // nothing happened
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = original;
    }
  });
});
