import { getDb, type Queryable } from "./db";
import { DEFAULT_BAND, type Band, type Level } from "./placement";

/**
 * Enrollment helpers: which section an agent belongs in, and which cohort has
 * room for them (docs/API.md §Enrollment, content/curriculum/PLACEMENT.md).
 */

/**
 * An agent's band is derived, not stored: it is the band of its most recent
 * GRADED sitting ("your most recent score governs" — PLACEMENT.md §Retake).
 * No graded sitting at all — including the 3-lifetime-cap default — reads as
 * `foundation`, so there is exactly one source of truth for banding and a
 * retake re-bands the agent with no second record to keep in sync.
 */
export async function agentBand(agentId: string, q?: Queryable): Promise<Band> {
  const db = q ?? (await getDb());
  const res = await db.query<{ placed_band: Band | null }>(
    `select placed_band
       from placement_attempts
      where agent_id = $1 and submitted_at is not null and placed_band is not null
      order by submitted_at desc
      limit 1`,
    [agentId],
  );
  return res.rows[0]?.placed_band ?? DEFAULT_BAND;
}

export interface TermRow {
  id: string;
  /** null only for associate terms — they are mixed-rung by design. */
  level: Level | null;
  track: "standard" | "associate";
  period_hours: number;
  slug: string;
  display_name: string;
  opens_at: string | Date;
  starts_at: string | Date;
  ends_at: string | Date;
  enrollment_cap: number;
  status: "draft" | "admissions" | "active" | "completed";
}

export interface CohortSeats {
  id: string;
  name: string;
  band: Band | null;
  capacity: number;
  filled: number;
}

/**
 * Seat counts for one term's cohorts, ordered by name — that ordering IS the
 * documented "fill-in-order" rule, so it must stay stable and deterministic.
 * Only `enrolled` rows occupy a seat; withdrawn/failed agents free theirs.
 */
export async function cohortSeats(termId: string, q?: Queryable): Promise<CohortSeats[]> {
  const db = q ?? (await getDb());
  const res = await db.query<CohortSeats & { filled: string | number }>(
    `select c.id, c.name, c.band, c.capacity,
            count(e.id) filter (where e.status = 'enrolled') as filled
       from cohorts c
       left join enrollments e on e.cohort_id = c.id
      where c.term_id = $1
      group by c.id, c.name, c.band, c.capacity
      order by c.name asc`,
    [termId],
  );
  return res.rows.map((r) => ({ ...r, filled: Number(r.filled) }));
}

/**
 * First cohort with room whose band matches the agent's, in fill order.
 * A cohort with `band = null` is unbanded and takes anyone — that is how
 * levels above Elementary (which do not band at admission) still fill.
 */
export function pickCohort(cohorts: readonly CohortSeats[], band: Band): CohortSeats | null {
  return (
    cohorts.find((c) => (c.band === null || c.band === band) && c.filled < c.capacity) ?? null
  );
}

/** Seats left across the whole term, floored at 0. */
export function termSeatsRemaining(term: TermRow, cohorts: readonly CohortSeats[]): number {
  const filled = cohorts.reduce((n, c) => n + c.filled, 0);
  const cohortCapacity = cohorts.reduce((n, c) => n + c.capacity, 0);
  return Math.max(0, Math.min(term.enrollment_cap, cohortCapacity) - filled);
}
