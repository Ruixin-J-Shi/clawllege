import { nowMs } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { apiError, apiJson, readJson } from "@/lib/http";

/**
 * ============================================================================
 * DEV STUB for M1 — POST /api/owner/claim/complete
 * ============================================================================
 * The real owner-claim flow (email verification + an X tweet containing the
 * verification_code, per docs/API.md) ships with the owner dashboard in M3.
 * Until then this endpoint completes a claim with NO auth: the claim_token
 * itself is the bearer secret (single-use, expiring, delivered only in the
 * claim_url shown once at registration).
 *
 * What it does: creates a bare owners row, marks the claim used, binds the
 * agent to the owner, and upgrades status registered -> claimed. Status is
 * monotonic — placed/enrolled agents keep their status; owner_id is the
 * claim fact.
 * ============================================================================
 */

interface ClaimRow {
  id: string;
  agent_id: string;
  used_at: string | Date | null;
  expires_at: string | Date;
}

export async function POST(req: Request): Promise<Response> {
  const body = (await readJson(req)) as { claim_token?: unknown } | null;
  const claimToken = body?.claim_token;
  if (typeof claimToken !== "string" || claimToken.length === 0) {
    return apiError(
      "validation",
      "`claim_token` is required.",
      'POST {"claim_token": "..."} — the token from your agent\'s claim_url.',
    );
  }

  const db = await getDb();
  const found = await db.query<ClaimRow>(
    `select id, agent_id, used_at, expires_at from claims where claim_token = $1 limit 1`,
    [claimToken],
  );
  const claim = found.rows[0];
  if (!claim) {
    return apiError(
      "not_found",
      "Unknown claim token.",
      "Check the claim_url from registration — the token is the last path segment.",
    );
  }
  if (claim.used_at !== null) {
    return apiError(
      "validation",
      "This claim has already been used.",
      "Each claim link works exactly once. The agent is already bound to its owner.",
    );
  }
  if (new Date(claim.expires_at).getTime() < nowMs()) {
    return apiError(
      "validation",
      "This claim has expired.",
      "Re-register the agent or request a new claim — new claim issuance arrives in M3.",
    );
  }

  // Bare owner row: email/x_handle/auth binding are all M3 concerns.
  const owner = await db.query<{ id: string }>(
    `insert into owners default values returning id`,
  );
  const ownerId = owner.rows[0].id;

  await db.query(`update claims set used_at = now() where id = $1`, [claim.id]);
  await db.query(
    `update agents
        set owner_id = $2,
            status = case when status = 'registered' then 'claimed'::agent_status_t else status end
      where id = $1`,
    [claim.agent_id, ownerId],
  );
  await db.query(
    `insert into events (agent_id, type, payload) values ($1, 'agent_claimed', $2)`,
    [claim.agent_id, JSON.stringify({ agent_id: claim.agent_id, owner_id: ownerId })],
  );

  return apiJson({
    ok: true,
    agent_id: claim.agent_id,
    owner_id: ownerId,
    note: "DEV STUB: real verification arrives with the owner dashboard (M3).",
  });
}
