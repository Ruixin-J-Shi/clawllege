import { getDb, type Queryable } from "./db";
import { nowIso } from "./clock";
import { rotateRoles } from "./roles";

/**
 * Period lifecycle: `scheduled → open → closed → graded`.
 *
 * Transitions are LAZY and IDEMPOTENT. Any request may drive them (so a
 * cohort's clock advances even if cron is down), and `scripts/sweep.mjs`
 * drives them for everyone on a schedule. Running twice changes nothing the
 * second time: each `update` filters on the status it expects to move away
 * from, and only rows that actually changed come back from `returning`, so
 * exactly one event is emitted per real transition.
 *
 * Every time comparison takes the instant as a PARAMETER from `lib/clock`,
 * never SQL `now()` — that is what lets a simulated semester run ten periods
 * in a second (see the clock's header comment).
 */

export type PeriodStatus = "scheduled" | "open" | "closed" | "graded";

export interface Transition {
  period_id: string;
  cohort_id: string;
  period_no: number;
  from: PeriodStatus;
  to: PeriodStatus;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Create the missing `periods` rows for a cohort from its term's curriculum.
 *
 * Periods run back to back at the term's own `period_hours` (Elementary 8h,
 * MS/HS 12h, College 24h, Clawmmunity 12h) starting at `terms.starts_at`, so
 * the class clock is always read from the term and never hardcoded. Modules
 * are matched on (track, level) — associate modules are level-agnostic, which
 * is why the level comparison has to be null-safe.
 *
 * Idempotent: `periods` is unique on (cohort_id, period_no), and existing
 * rows are left exactly as they are — rescheduling a period that has already
 * opened would move deadlines under the agents working to them.
 */
export async function schedulePeriods(cohortId: string, q?: Queryable): Promise<number> {
  const db = q ?? (await getDb());
  const cohort = await db.query<{
    term_id: string;
    level: string | null;
    track: string;
    period_hours: number;
    starts_at: string | Date;
  }>(
    `select t.id as term_id, t.level, t.track, t.period_hours, t.starts_at
       from cohorts c join terms t on t.id = c.term_id
      where c.id = $1`,
    [cohortId],
  );
  const term = cohort.rows[0];
  if (!term) return 0;

  const modules = await db.query<{ id: string; period_no: number }>(
    `select id, period_no
       from modules
      where track = $1 and level is not distinct from $2::level_t and version = 1
      order by period_no asc`,
    [term.track, term.level],
  );

  const startMs = new Date(term.starts_at).getTime();
  let created = 0;
  for (const mod of modules.rows) {
    const opensAt = new Date(startMs + (mod.period_no - 1) * term.period_hours * HOUR_MS);
    const closesAt = new Date(opensAt.getTime() + term.period_hours * HOUR_MS);
    const res = await db.query<{ id: string }>(
      `insert into periods (cohort_id, module_id, period_no, opens_at, closes_at, status)
       values ($1, $2, $3, $4::timestamptz, $5::timestamptz, 'scheduled')
       on conflict (cohort_id, period_no) do nothing
       returning id`,
      [cohortId, mod.id, mod.period_no, opensAt.toISOString(), closesAt.toISOString()],
    );
    if (res.rows.length > 0) created += 1;
  }
  return created;
}

/** Record one transition in the class log. */
async function emit(
  db: Queryable,
  t: Transition,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `insert into events (cohort_id, type, payload, created_at)
     values ($1, $2, $3::jsonb, $4::timestamptz)`,
    [
      t.cohort_id,
      t.to === "open" ? "period_opened" : t.to === "closed" ? "period_closed" : "period_graded",
      JSON.stringify({ period_id: t.period_id, period_no: t.period_no, from: t.from, to: t.to, ...extra }),
      nowIso(),
    ],
  );
}

export interface AdvanceOptions {
  /** Restrict the sweep to one cohort (the lazy per-request path). */
  cohortId?: string;
  /**
   * Run the grading pass on periods that just closed. The sweep sets this;
   * a cheap read path can skip it and let the next sweep grade.
   */
  grade?: boolean;
}

/**
 * Drive every period that is due for a transition, oldest first.
 * Returns the transitions that actually happened — empty on a second run.
 */
export async function advancePeriods(opts: AdvanceOptions = {}): Promise<Transition[]> {
  const db = await getDb();
  const at = nowIso();
  const transitions: Transition[] = [];
  const scope = opts.cohortId ?? null;

  // terms: admissions → active once teaching starts, active → completed at the end.
  await db.query(
    `update terms set status = 'active'
      where status = 'admissions' and starts_at <= $1::timestamptz`,
    [at],
  );
  await db.query(
    `update terms set status = 'completed'
      where status = 'active' and ends_at <= $1::timestamptz`,
    [at],
  );

  // Give every cohort of a teaching term its periods.
  //
  // This is the step that was missing until T6: `schedulePeriods` existed and
  // was called by every test and walkthrough, which is exactly why nothing
  // caught it — the fixtures did the work the product never did, so an enrolled
  // cohort in production would have stayed period-less forever and `/next`
  // would have answered `period: null` for the whole term.
  //
  // It runs on EVERY pass rather than only on the admissions → active edge, so
  // a cohort added after a term starts (a second section opened to absorb a
  // waitlist) still gets its rows. Cheap: the `not exists` means it only looks
  // at cohorts that have none, and scheduling is idempotent anyway.
  const unscheduled = await db.query<{ id: string; name: string }>(
    `select c.id, c.name
       from cohorts c join terms t on t.id = c.term_id
      where t.status in ('active', 'completed')
        and ($1::uuid is null or c.id = $1::uuid)
        and not exists (select 1 from periods p where p.cohort_id = c.id)`,
    [scope],
  );
  for (const cohort of unscheduled.rows) {
    const created = await schedulePeriods(cohort.id, db);
    if (created > 0) {
      await db.query(
        `insert into events (cohort_id, type, payload, created_at)
         values ($1, 'periods_scheduled', $2::jsonb, $3::timestamptz)`,
        [cohort.id, JSON.stringify({ periods: created, cohort: cohort.name }), at],
      );
    }
  }

  // scheduled → open. A period that is already past its close is handled by
  // the next statement in the same pass, so nothing gets stuck.
  const opened = await db.query<{ id: string; cohort_id: string; period_no: number }>(
    `update periods set status = 'open'
      where status = 'scheduled' and opens_at <= $1::timestamptz
        and ($2::uuid is null or cohort_id = $2::uuid)
      returning id, cohort_id, period_no`,
    [at, scope],
  );
  for (const row of opened.rows) {
    const t: Transition = {
      period_id: row.id,
      cohort_id: row.cohort_id,
      period_no: row.period_no,
      from: "scheduled",
      to: "open",
    };
    transitions.push(t);
    // Jobs move one seat down the roster as each period opens.
    const roles = await rotateRoles(row.cohort_id, row.period_no, db);
    await emit(db, t, {
      roles: roles
        .filter((r) => r.class_role !== null)
        .map((r) => ({ name: r.name, role: r.class_role })),
    });
  }

  // open → closed. Late writes are rejected from here on.
  const closed = await db.query<{ id: string; cohort_id: string; period_no: number }>(
    `update periods set status = 'closed'
      where status = 'open' and closes_at <= $1::timestamptz
        and ($2::uuid is null or cohort_id = $2::uuid)
      returning id, cohort_id, period_no`,
    [at, scope],
  );
  for (const row of closed.rows) {
    const t: Transition = {
      period_id: row.id,
      cohort_id: row.cohort_id,
      period_no: row.period_no,
      from: "open",
      to: "closed",
    };
    transitions.push(t);
    await emit(db, t);
  }

  if (opts.grade) {
    // Imported lazily: grading pulls in the rubric/mastery machinery, which a
    // plain read path should not have to load.
    const { gradePeriod } = await import("./grading");
    const due = await db.query<{ id: string; cohort_id: string; period_no: number }>(
      `select id, cohort_id, period_no from periods
        where status = 'closed' and ($1::uuid is null or cohort_id = $1::uuid)
        order by closes_at asc`,
      [scope],
    );
    const touched = new Set<string>();
    for (const row of due.rows) {
      const summary = await gradePeriod(row.id);
      const t: Transition = {
        period_id: row.id,
        cohort_id: row.cohort_id,
        period_no: row.period_no,
        from: "closed",
        to: "graded",
      };
      transitions.push(t);
      await emit(db, t, { ...summary });
      touched.add(row.cohort_id);
    }

    // Clawmmunity terms end in a Readiness Check, not an exam: it runs
    // automatically once the final period closes, so completion is
    // platform-noticed rather than agent-requested (associate/EXAM.md).
    // Imported lazily for the same reason grading is.
    if (touched.size > 0) {
      const { completeAssociateCohort } = await import("./associate");
      for (const id of touched) {
        const outcomes = await completeAssociateCohort(id);
        for (const outcome of outcomes) {
          await db.query(
            `insert into events (cohort_id, agent_id, type, payload, created_at)
             values ($1, $2, $3, $4::jsonb, $5::timestamptz)`,
            [
              id,
              outcome.agent_id,
              outcome.met ? "associate_completed" : "associate_not_yet",
              JSON.stringify(
                outcome.met
                  ? { certificate: outcome.public_id }
                  : { outstanding: outcome.outstanding },
              ),
              nowIso(),
            ],
          );
        }
      }
    }
  }

  return transitions;
}

/**
 * The lazy path every agent-facing route calls first: bring this one cohort's
 * periods up to date before answering. Grading is left to the sweep so a read
 * never pays for it.
 */
export async function syncCohort(cohortId: string): Promise<Transition[]> {
  return advancePeriods({ cohortId, grade: false });
}

/** The period an agent is working right now, if any is open. */
export async function openPeriod(cohortId: string, q?: Queryable) {
  const db = q ?? (await getDb());
  const res = await db.query<{
    id: string;
    period_no: number;
    module_id: string;
    opens_at: string | Date;
    closes_at: string | Date;
    status: PeriodStatus;
    title: string;
    slug: string;
    skills: string[];
    content_md: string;
  }>(
    `select p.id, p.period_no, p.module_id, p.opens_at, p.closes_at, p.status,
            m.title, m.slug, m.skills, m.content_md
       from periods p join modules m on m.id = p.module_id
      where p.cohort_id = $1 and p.status = 'open'
      order by p.period_no asc
      limit 1`,
    [cohortId],
  );
  return res.rows[0] ?? null;
}
