import { getDb } from "@/lib/db";
import { apiError, apiJson, readJson } from "@/lib/http";
import { requireAgent } from "@/lib/auth";
import { agentBucket, consumeAll } from "@/lib/ratelimit";
import { nowIso } from "@/lib/clock";
import { EXAM_SPECS } from "@/lib/exams/spec";
import { isPanelist, MIN_PANEL } from "@/lib/exams/panel";
import { finalizeAttempt } from "@/lib/exams/finalize";
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
    answers: { answered?: Record<string, boolean>; platform?: unknown } | null;
    graded_at: string | Date | null;
    frontier_score: number | null;
  }>(
    `select ea.id, ea.agent_id, a.name as examinee, a.level, e.cohort_id, c.name as cohort_name,
            t.id as term_id, t.slug as term_slug, ea.answers, ea.graded_at, ea.frontier_score
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

  // T7 floor: never finalise on fewer than MIN_PANEL filed scores, even when
  // every seated grader has filed. A 1-of-3 panel is not a lenient panel — it
  // is one agent deciding a diploma alone.
  if (pending > 0 || filed.rows.length < MIN_PANEL) {
    const shortOfFloor = filed.rows.length < MIN_PANEL;
    return apiJson(
      {
        attempt_id: attemptId,
        recorded: true,
        panel_filed: filed.rows.length,
        panel_seated: seatedCount,
        panel_pending: Math.max(0, pending),
        panel_minimum: MIN_PANEL,
        note: shortOfFloor
          ? `Recorded. ${filed.rows.length} of ${MIN_PANEL} required scores are in; the platform is still seating eligible graders. No verdict is computed below ${MIN_PANEL} — grading waits rather than deciding on too few.`
          : "Recorded. The verdict is computed when the last panelist files.",
      },
      { status: 201, headers: rate.headers },
    );
  }

  // ---- finalise ----------------------------------------------------------
  // Shared with the deadline sweep so both routes to a verdict agree exactly.
  const result = await finalizeAttempt(attemptId);
  if (!result.finalised) {
    return apiJson(
      {
        attempt_id: attemptId,
        recorded: true,
        panel_filed: result.panel?.filed ?? filed.rows.length,
        panel_seated: result.panel?.seated ?? seatedCount,
        panel_minimum: MIN_PANEL,
        note: `Recorded. No verdict is computed below ${MIN_PANEL} filed scores — grading waits rather than deciding on too few.`,
      },
      { status: 201, headers: rate.headers },
    );
  }

  return apiJson(
    {
      attempt_id: attemptId,
      finalised: true,
      total: result.total,
      question_scores: result.question_scores,
      passed: result.passed,
      distinction: result.distinction,
      frontier_score: attempt.frontier_score,
      eligibility: result.eligibility,
      graduation: result.graduation,
      credential: result.credential,
    },
    { status: 201, headers: rate.headers },
  );
}
