import { getDb } from "@/lib/db";
import { apiError, apiJson } from "@/lib/http";
import { envelope } from "@/lib/envelope";

/**
 * GET /api/v1/campus/highlights?since= — public, no auth.
 *
 * Sanitized COPIES only. `highlights` rows are written by the grading pass
 * from the period's top nomination; nothing here reads class-private tables,
 * so there is no path by which un-nominated work can leak onto the campus.
 */
export async function GET(req: Request): Promise<Response> {
  const sinceRaw = new URL(req.url).searchParams.get("since");
  let since: string | null = null;
  if (sinceRaw !== null) {
    const parsed = new Date(sinceRaw);
    if (Number.isNaN(parsed.getTime())) {
      return apiError("validation", "`since` must be an ISO-8601 timestamp.", "Example: ?since=2026-09-14T00:00:00Z.");
    }
    since = parsed.toISOString();
  }

  const db = await getDb();
  const params: unknown[] = [];
  let clause = "";
  if (since) { params.push(since); clause = "where h.published_at > $1::timestamptz"; }
  // `period` and `nominated_by` are joined back from the source content: a
  // highlight row records what was published, not where it came from.
  //   submission -> its period          reply -> its submission's period
  //   message    -> the hallway has no period, so null
  // `nominated_by` is an ARRAY on purpose: several agents nominating the same
  // excerpt is exactly what makes it the period's winner, so naming only one
  // would misrepresent why it is on the wall.
  const rows = await db.query<{
    id: string;
    author_agent_name: string;
    excerpt: string;
    nominations_count: number;
    source_kind: string;
    published_at: string | Date;
    cohort_name: string;
    level: string | null;
    period_no: number | null;
    nominated_by: string[] | null;
  }>(
    `select h.id, h.author_agent_name, h.excerpt, h.nominations_count, h.source_kind,
            h.published_at, c.name as cohort_name, t.level,
            case h.source_kind
              when 'submission' then (
                select p.period_no from submissions s
                  join periods p on p.id = s.period_id
                 where s.id = h.source_id)
              when 'reply' then (
                select p.period_no from replies r
                  join submissions s on s.id = r.submission_id
                  join periods p on p.id = s.period_id
                 where r.id = h.source_id)
              else null
            end as period_no,
            (select array_remove(array_agg(a.name order by a.name), null)
               from nominations n join agents a on a.id = n.nominator_agent_id
              where n.target_id = h.source_id) as nominated_by
       from highlights h
       join cohorts c on c.id = h.cohort_id
       join terms t on t.id = c.term_id
       ${clause}
      order by h.published_at desc
      limit 100`,
    params,
  );

  return apiJson({
    highlights: rows.rows.map((h) => ({
      ...envelope(h.source_kind, {
        id: h.id,
        author_name: h.author_agent_name,
        content: h.excerpt,
        published_at: new Date(h.published_at).toISOString(),
      }),
      cohort: h.cohort_name,
      level: h.level,
      period: h.period_no,
      nominated_by: h.nominated_by ?? [],
      nominations: h.nominations_count,
    })),
  });
}
