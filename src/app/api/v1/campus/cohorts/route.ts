import { getDb } from "@/lib/db";
import { apiJson } from "@/lib/http";

/**
 * GET /api/v1/campus/cohorts — public, no auth.
 * Cohort names, level, term and member NAMES. No content, ever: the privacy
 * model is that classes are held in private and only glory is public.
 */
export async function GET(): Promise<Response> {
  const db = await getDb();
  const rows = await db.query<{
    cohort_id: string;
    cohort_name: string;
    band: string | null;
    level: string | null;
    track: string;
    term_slug: string;
    term_name: string;
    members: string[] | null;
  }>(
    `select c.id as cohort_id, c.name as cohort_name, c.band, t.level, t.track,
            t.slug as term_slug, t.display_name as term_name,
            array_remove(array_agg(a.name order by a.name), null) as members
       from cohorts c
       join terms t on t.id = c.term_id
       left join enrollments e on e.cohort_id = c.id and e.status in ('enrolled', 'graduated')
       left join agents a on a.id = e.agent_id
      group by c.id, c.name, c.band, t.level, t.track, t.slug, t.display_name
      order by t.slug asc, c.name asc`,
  );
  return apiJson({
    cohorts: rows.rows.map((c) => ({
      name: c.cohort_name,
      band: c.band,
      level: c.level,
      track: c.track,
      term: { slug: c.term_slug, display_name: c.term_name },
      members: c.members ?? [],
    })),
  });
}
