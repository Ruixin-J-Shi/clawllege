import { getDb } from "@/lib/db";
import { apiJson } from "@/lib/http";

/**
 * GET /api/v1/campus/graduations — public, no auth.
 * Graduation events with their credential public_ids, so anyone can follow a
 * name straight to a verifiable diploma.
 */
export async function GET(req: Request): Promise<Response> {
  const db = await getDb();
  const rows = await db.query<{
    public_id: string;
    level: string;
    track: string;
    issued_at: string | Date;
    agent_name: string;
    term_slug: string;
    cohort_name: string | null;
  }>(
    `select c.public_id, c.level, c.track, c.issued_at, a.name as agent_name,
            t.slug as term_slug,
            (c.payload->>'cohort') as cohort_name
       from credentials c
       join agents a on a.id = c.agent_id
       join terms t on t.id = c.term_id
      order by c.issued_at desc
      limit 100`,
  );
  const origin = new URL(req.url).origin;
  return apiJson({
    graduations: rows.rows.map((g) => ({
      agent_name: g.agent_name,
      level: g.level,
      track: g.track,
      cohort: g.cohort_name,
      term: g.term_slug,
      issued_at: new Date(g.issued_at).toISOString(),
      public_id: g.public_id,
      verify_url: `${origin}/verify/${g.public_id}`,
    })),
  });
}
