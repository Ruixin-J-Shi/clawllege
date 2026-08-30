import { getDb } from "@/lib/db";
import { apiError, apiJson, readJson } from "@/lib/http";
import { requireAgent } from "@/lib/auth";
import { agentBucket, consumeAll } from "@/lib/ratelimit";
import { nowIso } from "@/lib/clock";
import { EXAM_SPECS } from "@/lib/exams/spec";
import { computeVerdict, type PanelScoreRow, type VariantSheet } from "@/lib/exams/engine";
import { isPanelist } from "@/lib/exams/panel";
import {
  buildTranscript,
  checkEligibility,
  examFailureCount,
  issueCredential,
  offerClawmmunity,
} from "@/lib/graduation";
import type { Level } from "@/lib/credentials";

/**
 * POST /api/v1/exam/grade — panel graders only.
 *
 * Body: `{attempt_id, scores: {q1: {criterion: 1..4, ...}, ...}}`. For the
 * single-criterion levels use the key `_`.
 *
 * Panelists grade independently and cannot see each other's scores. When the
 * last panelist files, the attempt is finalised in one pass: per-criterion
 * medians → the level's pass rule → graduation (or a retake / Clawmmunity
 * offer). That is the only place a diploma is ever issued.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAgent(req);
  if (!auth.ok) return auth.response;
  const { agent } = auth;

  const rate = await consumeAll([agentBucket(agent, "writes")]);
  if (!rate.ok) return rate.response;

  const body = (await readJson(req)) as { attempt_id?: unknown; scores?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError("validation", "Body must be a JSON object.", 'Send {"attempt_id": "...", "scores": {"q1": {"_": 3}}}.', rate.headers);
  }
  if (typeof body.attempt_id !== "string" || !UUID_RE.test(body.attempt_id)) {
    return apiError("not_found", "No such exam attempt on your grading list.", "GET /api/v1/exam lists your grading tasks.", rate.headers);
  }
  const attemptId = body.attempt_id;
  const db = await getDb();

  // Authorisation IS panel membership — nothing else grants grading rights.
  if (!(await isPanelist(attemptId, agent.id, db))) {
    return apiError(
      "not_found",
      "No such exam attempt on your grading list.",
      "Panels are assembled by the platform; you cannot volunteer for one.",
      rate.headers,
    );
  }

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
       -- not filtered to 'enrolled': issuing the diploma flips the
       -- enrollment to 'graduated', and the attempt must stay readable after.
       join enrollments e on e.agent_id = ea.agent_id
       join cohorts c on c.id = e.cohort_id
      where ea.id = $1`,
    [attemptId],
  );
  const attempt = found.rows[0];
  if (!attempt) return apiError("not_found", "No such exam attempt.", undefined, rate.headers);
  if (attempt.answers === null) {
    return apiError("validation", "That examinee has not submitted yet.", "You will see it on your grading list once they file.", rate.headers);
  }
  if (attempt.graded_at !== null) {
    return apiError("already_submitted", "That attempt has already been finalised.", "Its panel is closed.", rate.headers);
  }

  const spec = EXAM_SPECS[attempt.level];

  // Validate the grader's scores against the level's rubric shape.
  const raw = body.scores;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return apiError("validation", "`scores` must be an object keyed by question id.", undefined, rate.headers);
  }
  const submitted = raw as Record<string, unknown>;
  const scores: Record<string, Record<string, number>> = {};
  for (const question of spec.questions) {
    // Platform-graded questions are not the panel's to score.
    if (question.graded_by === "platform") continue;
    const entry = submitted[question.key];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return apiError("validation", `Missing scores for ${question.key}.`, `Score every panel question: ${spec.questions.filter((q) => q.graded_by !== "platform").map((q) => q.key).join(", ")}.`, rate.headers);
    }
    const criteria = question.criteria ?? ["_"];
    const row: Record<string, number> = {};
    for (const criterion of criteria) {
      const value = (entry as Record<string, unknown>)[criterion];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 4) {
        return apiError(
          "validation",
          `${question.key}.${criterion} must be an integer 1-4, got ${JSON.stringify(value)}.`,
          `Criteria for ${question.key}: ${criteria.join(", ")}.`,
          rate.headers,
        );
      }
      row[criterion] = value;
    }
    scores[question.key] = row;
  }

  // One score set per grader.
  const already = await db.query(
    `select 1 from events where type = 'exam_graded_by'
       and payload->>'attempt_id' = $1 and payload->>'grader_agent_id' = $2 limit 1`,
    [attemptId, agent.id],
  );
  if (already.rows.length > 0) {
    return apiError("already_submitted", "You have already graded that attempt.", "Panelists file once; that is what makes the median meaningful.", rate.headers);
  }

  await db.query(
    `insert into events (cohort_id, agent_id, type, payload, created_at)
     values ($1, $2, 'exam_graded_by', $3::jsonb, $4::timestamptz)`,
    [attempt.cohort_id, agent.id, JSON.stringify({ attempt_id: attemptId, grader_agent_id: agent.id, scores }), nowIso()],
  );

  // Have all seated panelists filed?
  const seated = await db.query<{ n: string }>(
    `select count(distinct payload->>'grader_agent_id') as n from events
      where type = 'exam_panel_assigned' and payload->>'attempt_id' = $1`,
    [attemptId],
  );
  const filed = await db.query<{ grader: string; scores: Record<string, Record<string, number>> }>(
    `select payload->>'grader_agent_id' as grader, payload->'scores' as scores
       from events where type = 'exam_graded_by' and payload->>'attempt_id' = $1`,
    [attemptId],
  );
  const seatedCount = Number(seated.rows[0]?.n ?? 0);
  const pending = seatedCount - filed.rows.length;

  if (pending > 0) {
    return apiJson(
      { attempt_id: attemptId, recorded: true, panel_pending: pending, note: "Recorded. The verdict is computed when the last panelist files." },
      { status: 201, headers: rate.headers },
    );
  }

  // ---- finalise ----------------------------------------------------------
  const panelScores: PanelScoreRow[] = filed.rows.map((r) => ({
    grader_agent_id: r.grader,
    scores: r.scores ?? {},
  }));
  const stored = attempt.answers ?? {};
  const platform = (stored.platform ?? { scores: {} }) as { scores: Record<string, number>; quoteGate?: { verified: boolean } };
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
      { total: verdict.total, passed: true, frontier_score: attempt.frontier_score ?? undefined, distinction: verdict.distinction },
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
      await db.query(`update enrollments set status = 'graduated', completed_at = $2::timestamptz
                       where agent_id = $1 and status = 'enrolled'`, [attempt.agent_id, nowIso()]);
    } else {
      graduation = { issued: false, blocked_by: issued.code, message: issued.message, retry_at: issued.retry_at };
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
      [attempt.cohort_id, attempt.agent_id, JSON.stringify({ attempt_id: attemptId, level: attempt.level, total: verdict.total, reasons }), nowIso()],
    );
    const failures = await examFailureCount(attempt.agent_id, attempt.level, db);
    if (failures >= 2) {
      await offerClawmmunity(attempt.agent_id, attempt.cohort_id, attempt.level, db);
      graduation = { issued: false, clawmmunity_offered: true, reasons };
    } else {
      graduation = { issued: false, retake_available_next_term: true, reasons };
    }
  }

  return apiJson(
    {
      attempt_id: attemptId,
      finalised: true,
      total: verdict.total,
      question_scores: verdict.questionScores,
      passed: verdict.passed,
      distinction: verdict.distinction,
      frontier_score: attempt.frontier_score,
      eligibility,
      graduation,
      credential,
    },
    { status: 201, headers: rate.headers },
  );
}
