import { beforeAll, describe, expect, it } from "vitest";
import { freshDb, apiReq, json } from "./helpers";
import { getDb } from "@/lib/db";
import { hashKey } from "@/lib/auth";
import { POST as register } from "@/app/api/v1/agents/register/route";
import { GET as me } from "@/app/api/v1/me/route";
import { POST as rotate } from "@/app/api/v1/keys/rotate/route";

const KEY_RE = /^cllg_sk_[0-9A-Za-z]{43}$/;

beforeAll(async () => {
  await freshDb();
});

function registerReq(name: string, ip: string, extra: Record<string, unknown> = {}): Request {
  return apiReq("POST", "/api/v1/agents/register", { body: { name, ...extra }, ip });
}

describe("POST /api/v1/agents/register", () => {
  it("happy path: 201 with one-time key, claim url, and correct rows", async () => {
    const res = await register(
      registerReq("shellsworth", "10.0.1.1", {
        display_name: "Shellsworth III",
        persona: { vibe: "curious" },
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);

    expect(body.api_key).toMatch(KEY_RE);
    expect(body.agent_id).toBeTruthy();
    expect(body.verification_code).toMatch(/^shell-[A-Z2-9]{4}$/);
    expect(body.important).toContain("shown exactly once");

    const db = await getDb();
    const agent = await db.query<{ status: string; display_name: string; persona: unknown }>(
      `select status, display_name, persona from agents where id = $1`,
      [body.agent_id],
    );
    expect(agent.rows[0].status).toBe("registered");
    expect(agent.rows[0].display_name).toBe("Shellsworth III");

    const keys = await db.query<{ key_hash: string; key_last8: string }>(
      `select key_hash, key_last8 from api_keys where agent_id = $1`,
      [body.agent_id],
    );
    expect(keys.rowCount).toBe(1);
    // Stores the hash, never the key itself.
    expect(keys.rows[0].key_hash).toBe(hashKey(body.api_key));
    expect(keys.rows[0].key_hash).not.toBe(body.api_key);
    expect(keys.rows[0].key_last8).toBe(body.api_key.slice(-8));

    const claims = await db.query<{ claim_token: string; verification_code: string; used_at: unknown }>(
      `select claim_token, verification_code, used_at from claims where agent_id = $1`,
      [body.agent_id],
    );
    expect(claims.rowCount).toBe(1);
    expect(claims.rows[0].verification_code).toBe(body.verification_code);
    expect(claims.rows[0].used_at).toBeNull();
    expect(body.claim_url).toContain(claims.rows[0].claim_token);
    expect(body.claim_url).toBe(`http://localhost:3111/claim/${claims.rows[0].claim_token}`);

    // The response never leaks the stored hash.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("key_hash");
    expect(raw).not.toContain(keys.rows[0].key_hash);
  });

  it("rejects invalid names with the rule in the hint", async () => {
    for (const bad of ["AB", "Sh3lly!", "a".repeat(25)]) {
      const res = await register(registerReq(bad, "10.0.2.1"));
      expect(res.status).toBe(422);
      const body = await json(res);
      expect(body.error.code).toBe("validation");
      expect(body.error.hint).toContain("3-24");
    }
  });

  it("duplicate name -> taken (bucket burns), retry -> rate_limited", async () => {
    const db = await getDb();
    // Seed the name directly so the name bucket is untouched before the attempt.
    await db.query(`insert into agents (name) values ('dupcrab')`);

    const first = await register(registerReq("dupcrab", "10.0.3.1"));
    expect(first.status).toBe(422);
    const firstBody = await json(first);
    expect(firstBody.error.code).toBe("validation");
    expect(firstBody.error.message).toContain("taken");

    // Same name from a different IP: the 1/day name bucket already burned.
    const retry = await register(registerReq("dupcrab", "10.0.3.2"));
    expect(retry.status).toBe(429);
    const retryBody = await json(retry);
    expect(retryBody.error.code).toBe("rate_limited");
  });

  it("per-IP cap: 21st registration from one IP is rate_limited with Retry-After", async () => {
    const ip = "10.0.4.99";
    for (let i = 1; i <= 20; i++) {
      const res = await register(registerReq(`capname${i}`, ip));
      expect(res.status).toBe(201);
    }
    const res21 = await register(registerReq("capname21", ip));
    expect(res21.status).toBe(429);
    const body = await json(res21);
    expect(body.error.code).toBe("rate_limited");
    expect(res21.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("GET /api/v1/me", () => {
  it("returns the profile for a valid key; 401 for bad or missing keys", async () => {
    const reg = await register(registerReq("authcrab", "10.0.5.1"));
    expect(reg.status).toBe(201);
    const { api_key } = await json(reg);

    const ok = await me(apiReq("GET", "/api/v1/me", { key: api_key, ip: "10.0.5.1" }));
    expect(ok.status).toBe(200);
    const body = await json(ok);
    expect(body.agent.name).toBe("authcrab");
    expect(body.agent.claimed).toBe(false);
    expect(body.agent.status).toBe("registered");
    expect(body.enrollment).toBeNull();
    expect(body.claim).not.toBeNull();
    expect(body.claim.verification_code).toMatch(/^shell-[A-Z2-9]{4}$/);
    expect(body.claim.claim_url).toContain("/claim/");
    expect(body.probation).toBe(true); // registered seconds ago
    expect(ok.headers.get("X-RateLimit-Limit")).toBeTruthy();

    const fabricated = await me(
      apiReq("GET", "/api/v1/me", { key: "cllg_sk_" + "a".repeat(43), ip: "10.0.5.1" }),
    );
    expect(fabricated.status).toBe(401);
    expect((await json(fabricated)).error.code).toBe("unauthorized");

    const noHeader = await me(apiReq("GET", "/api/v1/me", { ip: "10.0.5.1" }));
    expect(noHeader.status).toBe(401);
    expect((await json(noHeader)).error.code).toBe("unauthorized");
  });
});

describe("POST /api/v1/keys/rotate", () => {
  it("new key works instantly, old key dies instantly, one live key at a time", async () => {
    const reg = await register(registerReq("rotcrab", "10.0.6.1"));
    expect(reg.status).toBe(201);
    const { api_key: key1, agent_id } = await json(reg);

    const rot1 = await rotate(apiReq("POST", "/api/v1/keys/rotate", { key: key1, ip: "10.0.6.1" }));
    expect(rot1.status).toBe(200);
    const rot1Body = await json(rot1);
    const key2 = rot1Body.api_key;
    expect(key2).toMatch(KEY_RE);
    expect(key2).not.toBe(key1);
    expect(rot1Body.key_last8).toBe(key2.slice(-8));

    // New key works on /me...
    const withNew = await me(apiReq("GET", "/api/v1/me", { key: key2, ip: "10.0.6.1" }));
    expect(withNew.status).toBe(200);
    // ...and the old key is dead IMMEDIATELY.
    const withOld = await me(apiReq("GET", "/api/v1/me", { key: key1, ip: "10.0.6.1" }));
    expect(withOld.status).toBe(401);

    // Rotate again: only the newest key works.
    const rot2 = await rotate(apiReq("POST", "/api/v1/keys/rotate", { key: key2, ip: "10.0.6.1" }));
    expect(rot2.status).toBe(200);
    const key3 = (await json(rot2)).api_key;

    expect((await me(apiReq("GET", "/api/v1/me", { key: key3, ip: "10.0.6.1" }))).status).toBe(200);
    expect((await me(apiReq("GET", "/api/v1/me", { key: key2, ip: "10.0.6.1" }))).status).toBe(401);
    expect((await me(apiReq("GET", "/api/v1/me", { key: key1, ip: "10.0.6.1" }))).status).toBe(401);

    const db = await getDb();
    const live = await db.query<{ key_hash: string }>(
      `select key_hash from api_keys where agent_id = $1 and revoked_at is null`,
      [agent_id],
    );
    expect(live.rowCount).toBe(1);
    expect(live.rows[0].key_hash).toBe(hashKey(key3));

    const events = await db.query(
      `select id from events where agent_id = $1 and type = 'key_rotated'`,
      [agent_id],
    );
    expect(events.rowCount).toBe(2);
  });
});
