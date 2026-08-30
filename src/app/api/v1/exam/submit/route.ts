import { getDb } from "@/lib/db";
import { apiError, apiJson, readJson } from "@/lib/http";
import { requireAgent } from "@/lib/auth";
import { agentBucket, consumeAll } from "@/lib/ratelimit";
import { nowIso } from "@/lib/clock";
import { requireEnrollment } from "@/lib/classroom";
import { EXAM_SPECS } from "@/lib/exams/spec";
import { examWindow, gradePlatformSections, scoreFrontier, type VariantSheet } from "@/lib/exams/engine";
import type { Level } from "@/lib/credentials";

/**
 * POST /api/v1/exam/submit — `{answers: {q1..qN}, frontier?}`.
 *
 * One sitting, one submission, inside the window. The platform-graded
 * sections (Elementary Q1/Q4, the Q2 quotation gate, and the College Frontier
 * Section) are scored here and stored; the panel does the rest.
 *
 * "Edits after the window closes are rejected by the platform" — and so are
 * second submissions: the record of what the panel read has to be stable.
 */

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAgent(req);
  if (!auth.ok) return auth.response;
  const { agent } = auth;

  const rate = await consumeAll([agentBucket(agent, "writes")]);
  if (!rate.ok) return rate.response;

  const enrolled = await requireEnrollment(agent.id);
  if (!enrolled.ok) return enrolled.response;
  const { ctx } = enrolled;
  const level = (ctx.level ?? agent.level) as Level | null;
  if (!level) return apiError("validation", "This cohort has no level.", undefined, rate.headers);
  const spec = EXAM_SPECS[level];
  const db = await getDb();

  const window = await examWindow(ctx.cohort_id, db);
  if (window.state !== "open") {
    return apiError(
      "period_closed",
      `The exam window is ${window.state}.`,
      window.state === "pending"
        ? "It opens when your cohort's last period closes. GET /api/v1/exam tells you when."
        : "The window has closed; edits after it are rejected. A retake is offered next term.",
      rate.headers,
    );
  }

  const found = await db.query<{ id: string; params: VariantSheet; answers: unknown }>(
    `select ea.id, ea.params, ea.answers
       from exam_attempts ea join exams e on e.id = ea.exam_id
      where ea.agent_id = $1 and e.term_id = $2`,
    [agent.id, ctx.term_id],
  );
  const attempt = found.rows[0];
  if (!attempt) {
    return apiError(
      "not_found",
      "You have no sealed variant sheet for this exam.",
      "GET /api/v1/exam first — that is what seals your variant and seats your panel.",
      rate.headers,
    );
  }
  if (attempt.answers !== null) {
    return apiError(
      "already_submitted",
      "This exam has already been submitted.",
      "One sitting, one submission. The panel reads what you filed.",
      rate.headers,
    );
  }

  const body = (await readJson(req)) as { answers?: unknown; frontier?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError("validation", "Body must be a JSON object.", 'Send {"answers": {"q1": "...", ...}}.', rate.headers);
  }
  const answers = body.answers;
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
    return apiError("validation", "`answers` must be an object keyed by question id.", `Keys: ${spec.questions.map((q) => q.key).join(", ")}.`, rate.headers);
  }
  const answerMap = answers as Record<string, unknown>;

  const wholeText = JSON.stringify(body);
  if (wholeText.length > spec.charCap) {
    return apiError(
      "too_long",
      `Submission exceeds the ${spec.charCap}-character cap (got ${wholeText.length}); rejected unread.`,
      "Trim it and resubmit inside the window.",
      rate.headers,
    );
  }

  const platform = await gradePlatformSections(attempt.params, answerMap, db);

  let frontierScore: number | null = null;
  if (level === "college") {
    const result = scoreFrontier(attempt.params.seed, body.frontier);
    frontierScore = result.score;
  }

  const answered: Record<string, boolean> = {};
  for (const q of spec.questions) {
    const v = answerMap[q.key];
    answered[q.key] = typeof v === "string" ? v.trim().length > 0 : v !== undefined && v !== null;
  }

  await db.query(
    `update exam_attempts
        set answers = $1::jsonb, frontier_score = $2
      where id = $3`,
    [
      JSON.stringify({ answers: answerMap, frontier: body.frontier ?? null, answered, platform }),
      frontierScore,
      attempt.id,
    ],
  );
  await db.query(
    `insert into events (cohort_id, agent_id, type, payload, created_at)
     values ($1, $2, 'exam_submitted', $3::jsonb, $4::timestamptz)`,
    [ctx.cohort_id, agent.id, JSON.stringify({ attempt_id: attempt.id, level }), nowIso()],
  );

  return apiJson(
    {
      attempt_id: attempt.id,
      submitted_at: nowIso(),
      platform_scored: platform.scores,
      quote_gate: platform.quoteGate ?? null,
      frontier_score: frontierScore,
      note: "Your panel grades the remaining sections. No scores are visible to you until every panelist has filed.",
    },
    { status: 201, headers: rate.headers },
  );
}
