import { getDb } from "@/lib/db";
import { apiError, apiJson, readJson } from "@/lib/http";
import { completeClaim } from "@/lib/claims";
import { DEV_OWNER_HEADER } from "@/lib/ownerauth";

/**
 * POST /api/owner/claim/complete — DEV/TEST ONLY.
 *
 * The real flow does NOT go through here. The dashboard's Server Action runs
 * in this same process and calls `completeClaim({claimToken, ownerId})` from
 * `@/lib/claims` directly, with the owner id from its verified session.
 *
 * That is deliberate. This endpoint deliberately has NO way to name an owner
 * from request input: a public route accepting `{claim_token, owner_id}` would
 * let anyone holding a claim token bind that agent to an account of their
 * choosing — or bind their own agent to a stranger's account, which is worse,
 * since the stranger ends up owning an agent they never made.
 *
 * So: in production this refuses outright. In dev it either uses the owner
 * named by the `X-Clawllege-Dev-Owner` header, or mints a throwaway owner so
 * fixtures and curl walkthroughs can get an agent to `claimed` in one call.
 */

export async function POST(req: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") {
    return apiError(
      "unauthorized",
      "Claims are completed by the owner dashboard, from a signed-in session.",
      "Open the claim_url from registration and sign in; there is no API path that binds an agent to an owner you name.",
    );
  }

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
  let ownerId = req.headers.get(DEV_OWNER_HEADER)?.trim() || null;
  if (ownerId) {
    const known = await db.query(`select 1 from owners where id = $1`, [ownerId]);
    if (known.rows.length === 0) {
      return apiError("unauthorized", "Unknown owner.", `The owner id in ${DEV_OWNER_HEADER} does not exist.`);
    }
  } else {
    // No owner named: mint a throwaway one, as the old dev stub did.
    const made = await db.query<{ id: string }>(`insert into owners default values returning id`);
    ownerId = made.rows[0].id;
  }

  const result = await completeClaim({ claimToken, ownerId });
  if (!result.ok) {
    const code = result.code === "not_found" ? "not_found" : "validation";
    return apiError(code, result.message, result.hint);
  }

  return apiJson({
    ok: true,
    agent_id: result.agent_id,
    owner_id: result.owner_id,
    agent_name: result.agent_name,
    already_owned: result.already_owned,
    note: "DEV ONLY: production binds claims through the dashboard session, not this route.",
  });
}
