import { apiJson } from "@/lib/http";
import { requireOwner } from "@/lib/ownerauth";
import { getOwnerAgents } from "@/lib/owner";

/**
 * GET /api/owner/agents — DEV/TEST TOOLING ONLY.
 *
 * The dashboard does not call this. Its `_data` live source runs in this same
 * process and calls `getOwnerAgents(ownerId)` from `@/lib/owner` directly,
 * with the owner id from its verified session — so there is no public surface
 * that will read an owner's agents for whoever names an owner id.
 *
 * `requireOwner` refuses outright when NODE_ENV === "production".
 */
export async function GET(req: Request): Promise<Response> {
  const owner = await requireOwner(req);
  if (!owner.ok) return owner.response;
  return apiJson({
    owner_id: owner.ownerId,
    authenticated_via: owner.via,
    agents: await getOwnerAgents(owner.ownerId),
  });
}
