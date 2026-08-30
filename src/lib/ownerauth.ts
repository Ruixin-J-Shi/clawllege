import { getDb } from "./db";
import { apiError } from "./http";

/**
 * ============================================================================
 * DEV-ONLY OWNER GATE — replace with the Supabase session check (M3)
 * ============================================================================
 * The owner dashboard authenticates humans through Supabase Auth, which lands
 * with worker-2's dashboard work. Until then these routes are gated on an
 * explicit, clearly-marked dev header carrying the owner id:
 *
 *     X-Clawllege-Dev-Owner: <owner uuid>
 *
 * Two deliberate properties:
 *   - It REFUSES OUTRIGHT when NODE_ENV === "production". A header-as-identity
 *     shim must never be reachable on a real deployment, and the failure mode
 *     of forgetting to remove it should be "nothing works", not "anyone can
 *     read any owner's private class feed".
 *   - It still scopes every query by owner_id, so the wiring worker-2's
 *     dashboard builds against is the same wiring the real session will use —
 *     only the source of `ownerId` changes.
 * ============================================================================
 */

export const DEV_OWNER_HEADER = "x-clawllege-dev-owner";

export type OwnerAuth =
  | { ok: true; ownerId: string; via: "dev-header" }
  | { ok: false; response: Response };

export async function requireOwner(req: Request): Promise<OwnerAuth> {
  if (process.env.NODE_ENV === "production") {
    return {
      ok: false,
      response: apiError(
        "unauthorized",
        "Owner routes require a signed-in human session.",
        "The dev owner header is disabled in production. Sign in through the dashboard (Supabase Auth).",
      ),
    };
  }

  const ownerId = req.headers.get(DEV_OWNER_HEADER)?.trim();
  if (!ownerId) {
    return {
      ok: false,
      response: apiError(
        "unauthorized",
        "Missing owner identity.",
        `DEV ONLY: send \`${DEV_OWNER_HEADER}: <owner uuid>\`. This shim disappears when Supabase Auth lands (M3).`,
      ),
    };
  }

  const db = await getDb();
  const found = await db.query<{ id: string }>(`select id from owners where id = $1`, [ownerId]);
  if (!found.rows[0]) {
    return {
      ok: false,
      response: apiError("unauthorized", "Unknown owner.", "The owner id in the dev header does not exist."),
    };
  }
  return { ok: true, ownerId: found.rows[0].id, via: "dev-header" };
}
