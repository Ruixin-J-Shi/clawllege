import { getDb } from "../db";
import { nowIso } from "../clock";
import type { Level } from "../credentials";
import {
  buildTranscript,
  checkEligibility,
  examFailureCount,
  issueCredential,
  offerClawmmunity,
} from "../graduation";
import { EXAM_SPECS } from "./spec";
import { computeVerdict, type PanelScoreRow, type VariantSheet } from "./engine";
import { MIN_PANEL, panelStatus } from "./panel";

/**
 * Turning a filed panel into a verdict.
 *
 * Extracted from `POST /api/v1/exam/grade` because there are now TWO ways an
 * attempt reaches a verdict: the last panelist files, or the grading deadline
 * passes with at least MIN_PANEL scores in. Both must produce exactly the same
 * result, so both call this.
 */

export interface FinalizeResult {
  finalised: boolean;
  reason?: "below_floor" | "already_final" | "not_submitted" | "not_found";
  total?: number;
  question_scores?: Record<string, number>;
  passed?: boolean;
  distinction?: boolean;
  eligibility?: Awaited<ReturnType<typeof checkEligibility>>;
  graduation?: Record<string, unknown>;
  credential?: { public_id: string; signature: string } | null;
  panel?: { filed: number; seated: number };
}

/**
 * Compute and record the verdict for an attempt.
 *
 * `force` finalizes on the filings that exist rather than waiting for every
 * seated grader — that is the deadline path. The MIN_PANEL floor is NEVER
 * bypassed by it: a lazy fourth grader must not hostage a diploma, but three
 * scores remain the minimum a verdict may rest on.
 */
export async function finalizeAttempt(
  attemptId: string,
  opts: { force?: boolean } = {},
): Promise<FinalizeResult> {
  const db = await getDb();

  const found = await db.query<{
    id: string;
    agent_id: string;
    examinee: string;
    level: Level;
    cohort_id: string;
    cohort_name: string;
    term_id: string;
    term_slug: string;
    params: VariantSheet;
    answers: { answered?: Record<string, boolean>; platform?: unknown } | null;
    graded_at: string | Date | null;
    frontier_score: number | null;
  }>(
    `select ea.id, ea.agent_id, a.name as examinee, a.level, e.cohort_id, c.name as cohort_name,
            t.id as term_id, t.slug as term_slug, ea.params, ea.answers, ea.graded_at, ea.frontier_score
       from exam_attempts ea
       join agents a on a.id = ea.agent_id
       join exams ex on ex.id = ea.exam_id
       join terms t on t.id = ex.term_id
       join enrollments e on e.agent_id = ea.agent_id
       join cohorts c on c.id = e.cohort_id
      where ea.id = $1`,
    [attemptId],
  );
  const attempt = found.rows[0];
  if (!attempt) return { finalised: false, reason: "not_found" };
  if (attempt.answers === null) return { finalised: false, reason: "not_submitted" };
  if (attempt.graded_at !== null) return { finalised: false, reason: "already_final" };

  const status = await panelStatus(attemptId, db);
  // The floor is absolute — `force` skips the "everyone seated has filed"
  // condition, never the minimum.
  if (status.filed < MIN_PANEL || (!opts.force && !status.can_finalize)) {
    return {
      finalised: false,
      reason: "below_floor",
      panel: { filed: status.filed, seated: status.seated },
    };
  }

  const spec = EXAM_SPECS[attempt.level];
  const filed = await db.query<{ grader: string; scores: Record<string, Record<string, number>> }>(
    `select payload->>'grader_agent_id' as grader, payload->'scores' as scores
       from events where type = 'exam_graded_by' and payload->>'attempt_id' = $1`,
    [attemptId],
  );
  const panelScores: PanelScoreRow[] = filed.rows.map((r) => ({
    grader_agent_id: r.grader,
    scores: r.scores ?? {},
  }));

  const stored = attempt.answers ?? {};
  const platform = (stored.platform ?? { scores: {} }) as {
    scores: Record<string, number>;
    quoteGate?: { verified: boolean };
  };
  const answered = stored.answered ?? {};

  const verdict = computeVerdict(
    spec,
    panelScores,
    platform,
    answered,
    attempt.frontier_score ?? undefined,
  );
  const eligibility = await checkEligibility(
    { agentId: attempt.agent_id, cohortId: attempt.cohort_id, level: attempt.level },
    db,
  );

  await db.query(
    `update exam_attempts
        set panel_scores = $1::jsonb, median = $2, passed = $3, graded_at = $4::timestamptz
      where id = $5`,
    [
      JSON.stringify(Object.fromEntries(panelScores.map((p) => [p.grader_agent_id, p.scores]))),
      verdict.total,
      verdict.passed,
      nowIso(),
      attemptId,
    ],
  );

  let credential: { public_id: string; signature: string } | null = null;
  let graduation: Record<string, unknown> = { issued: false };

  if (verdict.passed && eligibility.met) {
    const transcript = await buildTranscript(
      attempt.agent_id,
      attempt.cohort_id,
      attempt.level,
      {
        total: verdict.total,
        passed: true,
        frontier_score: attempt.frontier_score ?? undefined,
        distinction: verdict.distinction,
      },
      db,
    );
    const issued = await issueCredential(
      {
        agentId: attempt.agent_id,
        agentName: attempt.examinee,
        level: attempt.level,
        track: "standard",
        termId: attempt.term_id,
        termSlug: attempt.term_slug,
        cohortId: attempt.cohort_id,
        cohortName: attempt.cohort_name,
        transcript,
      },
      db,
    );
    if (issued.ok) {
      credential = { public_id: issued.public_id, signature: issued.signature };
      graduation = { issued: true, public_id: issued.public_id, distinction: verdict.distinction };
      await db.query(
        `update enrollments set status = 'graduated', completed_at = $2::timestamptz
          where agent_id = $1 and status = 'enrolled'`,
        [attempt.agent_id, nowIso()],
      );
    } else {
      graduation = {
        issued: false,
        blocked_by: issued.code,
        message: issued.message,
        retry_at: issued.retry_at,
      };
      await db.query(
        `insert into events (cohort_id, agent_id, type, payload, created_at)
         values ($1, $2, 'graduation_deferred', $3::jsonb, $4::timestamptz)`,
        [attempt.cohort_id, attempt.agent_id, JSON.stringify(graduation), nowIso()],
      );
    }
  } else {
    const reasons = [...verdict.reasons, ...(verdict.passed ? eligibility.reasons : [])];
    await db.query(
      `insert into events (cohort_id, agent_id, type, payload, created_at)
       values ($1, $2, 'exam_failed', $3::jsonb, $4::timestamptz)`,
      [
        attempt.cohort_id,
        attempt.agent_id,
        JSON.stringify({ attempt_id: attemptId, level: attempt.level, total: verdict.total, reasons }),
        nowIso(),
      ],
    );
    const failures = await examFailureCount(attempt.agent_id, attempt.level, db);
    if (failures >= 2) {
      await offerClawmmunity(attempt.agent_id, attempt.cohort_id, attempt.level, db);
      graduation = { issued: false, clawmmunity_offered: true, reasons };
    } else {
      graduation = { issued: false, retake_available_next_term: true, reasons };
    }
  }

  return {
    finalised: true,
    total: verdict.total,
    question_scores: verdict.questionScores,
    passed: verdict.passed,
    distinction: verdict.distinction,
    eligibility,
    graduation,
    credential,
    panel: { filed: status.filed, seated: status.seated },
  };
}
