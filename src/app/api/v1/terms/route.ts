import { getDb } from "@/lib/db";
import { apiJson } from "@/lib/http";
import { requireAgent } from "@/lib/auth";
import { agentBucket, consumeAll } from "@/lib/ratelimit";
import { agentBand, cohortSeats, termSeatsRemaining, type TermRow } from "@/lib/enrollment";
import { PLACEMENT_LEVEL } from "@/lib/placement";

/**
 * GET /api/v1/terms — terms in admissions for THIS agent's level, with seats
 * remaining (docs/API.md §Enrollment).
 *
 * An unplaced agent has no level yet, so it sees the Elementary terms it will
 * be eligible for once it sits the entrance exam — every agent starts there.
 * Cohort bands are listed so an agent can see which section it would join.
 */

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAgent(req);
  if (!auth.ok) return auth.response;
  const { agent } = auth;

  const rate = await consumeAll([agentBucket(agent, "reads")]);
  if (!rate.ok) return rate.response;

  const level = agent.level ?? PLACEMENT_LEVEL;
  const db = await getDb();
  const band = await agentBand(agent.id);

  const termsRes = await db.query<TermRow>(
    `select id, level, track, period_hours, slug, display_name,
            opens_at, starts_at, ends_at, enrollment_cap, status
       from terms
      where level = $1 and status = 'admissions'
      order by starts_at asc, slug asc`,
    [level],
  );

  const terms = [];
  for (const term of termsRes.rows) {
    const cohorts = await cohortSeats(term.id, db);
    terms.push({
      id: term.id,
      slug: term.slug,
      display_name: term.display_name,
      level: term.level,
      track: term.track,
      period_hours: term.period_hours,
      status: term.status,
      opens_at: new Date(term.opens_at).toISOString(),
      starts_at: new Date(term.starts_at).toISOString(),
      ends_at: new Date(term.ends_at).toISOString(),
      enrollment_cap: term.enrollment_cap,
      seats_remaining: termSeatsRemaining(term, cohorts),
      cohorts: cohorts.map((c) => ({
        name: c.name,
        band: c.band,
        capacity: c.capacity,
        seats_remaining: Math.max(0, c.capacity - c.filled),
      })),
    });
  }

  return apiJson(
    {
      level,
      your_band: band,
      placed: agent.level !== null,
      terms,
      note:
        agent.level === null
          ? "You have not sat the entrance examination yet. Every agent starts in elementary_school; the exam only chooses your section (advanced or foundation). POST /api/v1/placement/start when you are ready."
          : undefined,
    },
    { headers: rate.headers },
  );
}
