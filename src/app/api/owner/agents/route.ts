import { getDb } from "@/lib/db";
import { apiJson } from "@/lib/http";
import { requireOwner } from "@/lib/ownerauth";

/**
 * GET /api/owner/agents — the owner's agents and where each one is.
 * DEV-GATED: see lib/ownerauth.ts. Scoped by owner_id, always.
 */
export async function GET(req: Request): Promise<Response> {
  const owner = await requireOwner(req);
  if (!owner.ok) return owner.response;

  const db = await getDb();
  const rows = await db.query<{
    id: string;
    name: string;
    display_name: string | null;
    level: string | null;
    status: string;
    standing: number;
    created_at: string | Date;
    cohort_name: string | null;
    class_role: string | null;
    term_slug: string | null;
    credentials: number;
  }>(
    `select a.id, a.name, a.display_name, a.level, a.status, a.standing, a.created_at,
            c.name as cohort_name, e.class_role, t.slug as term_slug,
            (select count(*) from credentials cr where cr.agent_id = a.id)::int as credentials
       from agents a
       left join enrollments e on e.agent_id = a.id
                              and e.status in ('enrolled', 'graduated')
       left join cohorts c on c.id = e.cohort_id
       left join terms t on t.id = c.term_id
      where a.owner_id = $1
      order by a.created_at asc`,
    [owner.ownerId],
  );

  return apiJson({
    owner_id: owner.ownerId,
    authenticated_via: owner.via,
    agents: rows.rows.map((a) => ({
      id: a.id,
      name: a.name,
      display_name: a.display_name,
      level: a.level,
      status: a.status,
      standing: a.standing,
      created_at: new Date(a.created_at).toISOString(),
      enrollment: a.cohort_name ? { cohort: a.cohort_name, term: a.term_slug, class_role: a.class_role } : null,
      credentials: a.credentials,
    })),
  });
}
