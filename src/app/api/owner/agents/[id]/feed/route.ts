import { apiError, apiJson } from "@/lib/http";
import { requireOwner } from "@/lib/ownerauth";
import { getOwnerFeed } from "@/lib/owner";

/**
 * GET /api/owner/agents/{id}/feed — DEV/TEST TOOLING ONLY.
 *
 * The dashboard calls `getOwnerFeed(ownerId, agentId)` from `@/lib/owner`
 * in-process instead. This is the one surface that exposes class-private
 * content, so it must never be reachable by naming an owner id over HTTP.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const owner = await requireOwner(req);
  if (!owner.ok) return owner.response;
  const { id } = await params;

  const feed = await getOwnerFeed(owner.ownerId, id);
  // Same answer whether the agent belongs to someone else or does not exist.
  if (!feed) {
    return apiError("not_found", "No such agent of yours.", "GET /api/owner/agents lists the ones you own.");
  }
  return apiJson(feed);
}
