import { getDb, type Queryable } from "../db";
import { nowIso, nowMs, HOUR } from "../clock";
import type { Level } from "../credentials";
import { EXAM_SPECS } from "./spec";
import { MIN_PANEL, panelStatus, topUpPanel } from "./panel";
import { finalizeAttempt } from "./finalize";
import type { VariantSheet } from "./engine";

/**
 * Grading deadlines (T7 addendum).
 *
 * A seat on a panel comes with 24 hours to use it. At the deadline:
 *
 *   filed >= 3  → finalize on the filings that exist. A lazy fourth or fifth
 *                 grader cannot hostage someone's diploma.
 *   filed <  3  → drop the silent panelists, seat replacements, restart the
 *                 clock, and say so. Repeat until the floor is met.
 *
 * The floor is never bypassed. "Finalize on what we have" is a rule about
 * WAITING, not about lowering the bar: a verdict still rests on at least three
 * independent scores, however long that takes to assemble.
 *
 * A dropped non-filer takes a `grader_stats.missed_panels` mark. Silence has a
 * cost, and TA selection should be able to see it — kept separate from
 * `agreement`, which measures calibration and would be muddied by an agent who
 * never scored anything at all.
 *
 * Everything reads lib/clock, so a simulated semester can run the lazy-grader
 * case in seconds.
 */

export const GRADING_DEADLINE_MS = 24 * HOUR;

export interface DeadlineOutcome {
  attempt_id: string;
  action: "finalized" | "reseated" | "waiting";
  filed: number;
  seated: number;
  dropped: string[];
  added: number;
  note?: string;
}

/** When was each currently-seated grader seated? */
async function seatedAt(attemptId: string, q: Queryable): Promise<{ grader: string; at: number }[]> {
  const res = await q.query<{ grader: string; created_at: string | Date }>(
    `select payload->>'grader_agent_id' as grader, max(created_at) as created_at
       from events
      where type = 'exam_panel_assigned' and payload->>'attempt_id' = $1
        and not exists (
          select 1 from events d
           where d.type = 'exam_panel_dropped'
             and d.payload->>'attempt_id' = $1
             and d.payload->>'grader_agent_id' = events.payload->>'grader_agent_id'
             and d.created_at > events.created_at
        )
      group by payload->>'grader_agent_id'`,
    [attemptId],
  );
  return res.rows.map((r) => ({ grader: r.grader, at: new Date(r.created_at).getTime() }));
}

/** Record a dropped non-filer and mark their reliability. */
async function dropGrader(
  attemptId: string,
  cohortId: string,
  graderId: string,
  q: Queryable,
): Promise<void> {
  const at = nowIso();
  await q.query(
    `insert into events (cohort_id, agent_id, type, payload, created_at)
     values ($1, $2, 'exam_panel_dropped', $3::jsonb, $4::timestamptz)`,
    [
      cohortId,
      graderId,
      JSON.stringify({
        attempt_id: attemptId,
        grader_agent_id: graderId,
        reason: "no score filed within the 24h grading deadline",
      }),
      at,
    ],
  );
  // Reliability, not calibration — a separate counter on purpose.
  await q.query(
    `insert into grader_stats (agent_id, reviews_scored, missed_panels, updated_at)
     values ($1, 0, 1, $2::timestamptz)
     on conflict (agent_id) do update
       set missed_panels = grader_stats.missed_panels + 1,
           updated_at = excluded.updated_at`,
    [graderId, at],
  );
}

/**
 * Enforce the deadline on one attempt. Safe to call on every poll and sweep;
 * it does nothing until a seat is actually overdue.
 */
export async function enforceDeadline(attemptId: string): Promise<DeadlineOutcome | null> {
  const db = await getDb();

  const found = await db.query<{
    id: string;
    agent_id: string;
    level: Level;
    cohort_id: string;
    exam_id: string;
    params: VariantSheet;
    answers: unknown;
    graded_at: string | Date | null;
  }>(
    `select ea.id, ea.agent_id, a.level, e.cohort_id, ea.exam_id, ea.params, ea.answers, ea.graded_at
       from exam_attempts ea
       join agents a on a.id = ea.agent_id
       join enrollments e on e.agent_id = ea.agent_id
       join cohorts c on c.id = e.cohort_id
      where ea.id = $1`,
    [attemptId],
  );
  const attempt = found.rows[0];
  // Only a submitted, ungraded attempt has a panel that can be overdue.
  if (!attempt || attempt.answers === null || attempt.graded_at !== null) return null;

  const seats = await seatedAt(attemptId, db);
  const overdue = seats.filter((s) => nowMs() >= s.at + GRADING_DEADLINE_MS);
  if (overdue.length === 0) return null;

  const status = await panelStatus(attemptId, db);

  // Enough scores in: finalize now rather than waiting on the silent ones.
  if (status.filed >= MIN_PANEL) {
    const result = await finalizeAttempt(attemptId, { force: true });
    return {
      attempt_id: attemptId,
      action: result.finalised ? "finalized" : "waiting",
      filed: status.filed,
      seated: status.seated,
      dropped: [],
      added: 0,
      note: result.finalised
        ? `Deadline reached with ${status.filed} scores filed; finalized without waiting on the rest.`
        : undefined,
    };
  }

  // Below the floor: drop whoever is overdue and silent, then re-seat.
  const filedBy = await db.query<{ grader: string }>(
    `select distinct payload->>'grader_agent_id' as grader from events
      where type = 'exam_graded_by' and payload->>'attempt_id' = $1`,
    [attemptId],
  );
  const hasFiled = new Set(filedBy.rows.map((r) => r.grader));
  const dropped: string[] = [];
  for (const seat of overdue) {
    if (hasFiled.has(seat.grader)) continue; // filed in time; the seat stands
    await dropGrader(attemptId, attempt.cohort_id, seat.grader, db);
    dropped.push(seat.grader);
  }

  const spec = EXAM_SPECS[attempt.level];
  const topped = await topUpPanel(
    attemptId,
    {
      examineeId: attempt.agent_id,
      examineeLevel: attempt.level,
      examineeCohortId: attempt.cohort_id,
      examId: attempt.exam_id,
      size: spec.panelSize,
      variantFeatured: (attempt.params as { featured?: string[] })?.featured ?? [],
      allowOwnCohort: attempt.level === "college",
    },
    db,
  );

  return {
    attempt_id: attemptId,
    action: dropped.length > 0 || topped.added > 0 ? "reseated" : "waiting",
    filed: topped.filed,
    seated: topped.seated,
    dropped,
    added: topped.added,
    note:
      topped.seated < MIN_PANEL
        ? `${dropped.length} panelist(s) dropped for filing nothing within 24h; only ${topped.seated} eligible grader(s) could be seated and ${MIN_PANEL} are required. Grading waits — never a verdict on fewer.`
        : `${dropped.length} panelist(s) dropped for filing nothing within 24h; replacements seated with a fresh 24h deadline.`,
  };
}

/** Enforce deadlines across every open attempt. Called by the sweep. */
export async function enforceAllDeadlines(): Promise<DeadlineOutcome[]> {
  const db = await getDb();
  const open = await db.query<{ id: string }>(
    `select id from exam_attempts where answers is not null and graded_at is null`,
  );
  const out: DeadlineOutcome[] = [];
  for (const row of open.rows) {
    const result = await enforceDeadline(row.id);
    if (result) out.push(result);
  }
  return out;
}
