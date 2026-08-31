import { getDb } from "./db";
import { nowIso, nowMs } from "./clock";

/**
 * Owner-claim completion — binding an agent to the human who owns it.
 *
 * SECURITY: `ownerId` must come from a VERIFIED session, never from request
 * input. That is why this lives in a library rather than behind a public
 * endpoint that accepts an owner id: an HTTP route taking `{claim_token,
 * owner_id}` would let anyone who guessed or intercepted a claim token bind
 * someone else's agent to their own account — or bind their own agent to a
 * stranger's account, which is worse, because the stranger then owns an agent
 * they never made and cannot see why.
 *
 * The dashboard's Server Action runs in this same process, so it should call
 * `completeClaim` DIRECTLY with the owner id from its session. No HTTP hop, no
 * shared secret to leak, and no public surface that takes an owner id at all.
 *
 * The claim token stays a single-use bearer secret for the *agent* half of the
 * handshake; the session supplies the *human* half. Both are required.
 */

export type ClaimResult =
  | { ok: true; agent_id: string; owner_id: string; agent_name: string; already_owned: boolean }
  | { ok: false; code: "not_found" | "used" | "expired" | "owned_by_other"; message: string; hint?: string };

export interface CompleteClaimInput {
  claimToken: string;
  /** The authenticated human. MUST come from a verified session. */
  ownerId: string;
}

/**
 * Bind the agent named by `claimToken` to `ownerId`.
 *
 * Idempotent for the same owner: re-running returns ok with
 * `already_owned: true` rather than erroring, so a double-submitted form or a
 * retried action does not look like a failure to the human.
 */
export async function completeClaim(input: CompleteClaimInput): Promise<ClaimResult> {
  const db = await getDb();

  const found = await db.query<{
    id: string;
    agent_id: string;
    used_at: string | Date | null;
    expires_at: string | Date;
    agent_name: string;
    owner_id: string | null;
  }>(
    `select c.id, c.agent_id, c.used_at, c.expires_at, a.name as agent_name, a.owner_id
       from claims c join agents a on a.id = c.agent_id
      where c.claim_token = $1
      limit 1`,
    [input.claimToken],
  );
  const claim = found.rows[0];
  if (!claim) {
    return {
      ok: false,
      code: "not_found",
      message: "Unknown claim token.",
      hint: "Check the claim_url from registration — the token is the last path segment.",
    };
  }

  // Already bound: same owner is a no-op success, a different owner is refused.
  if (claim.owner_id !== null) {
    if (claim.owner_id === input.ownerId) {
      return {
        ok: true,
        agent_id: claim.agent_id,
        owner_id: input.ownerId,
        agent_name: claim.agent_name,
        already_owned: true,
      };
    }
    return {
      ok: false,
      code: "owned_by_other",
      message: "That agent already belongs to a different owner.",
      hint: "Each agent is claimed once. If you believe this is wrong, the agent's registration is the record.",
    };
  }

  if (claim.used_at !== null) {
    return {
      ok: false,
      code: "used",
      message: "This claim has already been used.",
      hint: "Each claim link works exactly once.",
    };
  }
  if (new Date(claim.expires_at).getTime() < nowMs()) {
    return {
      ok: false,
      code: "expired",
      message: "This claim has expired.",
      hint: "Re-register the agent to get a fresh claim link.",
    };
  }

  const at = nowIso();
  await db.query(`update claims set used_at = $2::timestamptz where id = $1`, [claim.id, at]);
  await db.query(
    `update agents
        set owner_id = $2,
            status = case when status = 'registered' then 'claimed'::agent_status_t else status end
      where id = $1`,
    [claim.agent_id, input.ownerId],
  );
  await db.query(
    `insert into events (agent_id, type, payload, created_at)
     values ($1, 'agent_claimed', $2::jsonb, $3::timestamptz)`,
    [claim.agent_id, JSON.stringify({ agent_id: claim.agent_id, owner_id: input.ownerId }), at],
  );

  return {
    ok: true,
    agent_id: claim.agent_id,
    owner_id: input.ownerId,
    agent_name: claim.agent_name,
    already_owned: false,
  };
}

/**
 * Find-or-create the owner row for a Supabase auth user.
 *
 * Offered so the dashboard does not have to write SQL: database access stays
 * in this layer. `owners.auth_user_id` is unique, so concurrent logins collapse
 * onto one row rather than racing into duplicates.
 */
export async function findOrCreateOwner(authUserId: string, email?: string | null): Promise<string> {
  const db = await getDb();
  const existing = await db.query<{ id: string }>(
    `select id from owners where auth_user_id = $1`,
    [authUserId],
  );
  if (existing.rows[0]) {
    // Backfill an email learned later, without overwriting one already stored.
    if (email) {
      await db.query(
        `update owners set email = coalesce(email, $2) where id = $1`,
        [existing.rows[0].id, email],
      );
    }
    return existing.rows[0].id;
  }
  const created = await db.query<{ id: string }>(
    `insert into owners (auth_user_id, email, email_verified_at)
     values ($1, $2, case when $2::text is null then null else $3::timestamptz end)
     on conflict (auth_user_id) do update set auth_user_id = excluded.auth_user_id
     returning id`,
    [authUserId, email ?? null, nowIso()],
  );
  return created.rows[0].id;
}
