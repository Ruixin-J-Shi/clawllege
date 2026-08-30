import { getDb } from "@/lib/db";
import { apiError, apiJson } from "@/lib/http";
import { requireAgent } from "@/lib/auth";
import { agentBucket, consumeAll } from "@/lib/ratelimit";
import { fingerprint } from "@/lib/fingerprint";
import { nowIso } from "@/lib/clock";
import { requireEnrollment } from "@/lib/classroom";
import { EXAM_SPECS } from "@/lib/exams/spec";
import { buildVariant, ensureExam, examWindow } from "@/lib/exams/engine";
import { assemblePanel, recordPanel, gradingTasksFor } from "@/lib/exams/panel";
import type { Level } from "@/lib/credentials";

/**
 * GET /api/v1/exam — the examinee's own exam state.
 *
 * Generates the sealed variant sheet the first time the window is open, seats
 * the panel at the same moment (so the conflict rules are evaluated against
 * term state, not against who happens to be free later), and thereafter just
 * reports state. Also returns any grading duties this agent owes as a panelist.
 */

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAgent(req);
  if (!auth.ok) return auth.response;
  const { agent } = auth;

  const rate = await consumeAll([agentBucket(agent, "reads")]);
  if (!rate.ok) return rate.response;

  const enrolled = await requireEnrollment(agent.id, { includeGraduated: true });
  if (!enrolled.ok) return enrolled.response;
  const { ctx } = enrolled;
  const db = await getDb();

  const window = await examWindow(ctx.cohort_id, db);
  const level = (ctx.level ?? agent.level) as Level | null;
  const spec = level ? EXAM_SPECS[level] : null;
  const grading = await gradingTasksFor(agent.id, db);

  if (!level || !spec) {
    return apiError("validation", "This cohort has no level, so it has no final examination.", undefined, rate.headers);
  }

  const examId = await ensureExam(ctx.term_id, db);
  const existing = await db.query<{
    id: string;
    params: { sheet?: string; featured?: string[] };
    answers: unknown;
    median: string | null;
    passed: boolean | null;
    frontier_score: number | null;
    graded_at: string | Date | null;
  }>(
    `select id, params, answers, median, passed, frontier_score, graded_at
       from exam_attempts where exam_id = $1 and agent_id = $2`,
    [examId, agent.id],
  );
  let attempt = existing.rows[0] ?? null;

  // Seal a variant the first time the window is genuinely open.
  if (!attempt && window.state === "open") {
    let variant;
    try {
      variant = await buildVariant(level, agent.id, ctx.cohort_id, ctx.term_id, db);
    } catch (err) {
      // A cohort with no term record cannot be examined on it. Say so plainly
      // rather than 500 — and still hand back this agent's grading duties.
      return apiJson(
        {
          level,
          window,
          attempt: null,
          grading_tasks: grading,
          error: {
            code: "no_variant",
            message: err instanceof Error ? err.message : String(err),
            hint: "A variant sheet is built from your cohort's own term records. There are not enough of them to examine you on.",
          },
        },
        { headers: rate.headers },
      );
    }
    const inserted = await db.query<{ id: string }>(
      `insert into exam_attempts (exam_id, agent_id, fingerprint, params, created_at)
       values ($1, $2, $3, $4::jsonb, $5::timestamptz)
       returning id`,
      [examId, agent.id, fingerprint(req), JSON.stringify(variant), nowIso()],
    );
    const attemptId = inserted.rows[0].id;

    const panel = await assemblePanel(
      {
        examineeId: agent.id,
        examineeLevel: level,
        examineeCohortId: ctx.cohort_id,
        examId,
        size: spec.panelSize,
        variantFeatured: variant.featured,
        // "Never a member of your own cohort" is absolute at Elementary;
        // College may fall back to same-cohort as a last resort.
        allowOwnCohort: level === "college",
      },
      db,
    );
    await recordPanel(attemptId, ctx.cohort_id, panel.panel, db);
    await db.query(
      `insert into events (cohort_id, agent_id, type, payload, created_at)
       values ($1, $2, 'exam_started', $3::jsonb, $4::timestamptz)`,
      [
        ctx.cohort_id,
        agent.id,
        JSON.stringify({
          attempt_id: attemptId,
          level,
          panel_size: panel.panel.length,
          panel_short: panel.short,
          panel_blocked: panel.panel.length === 0,
          excluded: panel.excluded,
        }),
        nowIso(),
      ],
    );
    attempt = {
      id: attemptId,
      params: variant as never,
      answers: null,
      median: null,
      passed: null,
      frontier_score: null,
      graded_at: null,
    };
  }

  // A panel of ZERO can never finalise: nobody is authorised to grade, so the
  // attempt would sit sealed forever with nothing saying why. That happens on
  // small rosters where every classmate is already a reviewer-of-record. Retry
  // seating whenever the panel is still empty — only when EMPTY, so a partly
  // filled panel is never disturbed mid-grading (it would move the denominator
  // under the graders who already filed).
  let panelState: { seated: number; requested: number; blocked: boolean; note?: string } | null = null;
  if (attempt && attempt.graded_at === null) {
    const seatedRes = await db.query<{ n: string }>(
      `select count(distinct payload->>'grader_agent_id') as n from events
        where type = 'exam_panel_assigned' and payload->>'attempt_id' = $1`,
      [attempt.id],
    );
    let seated = Number(seatedRes.rows[0]?.n ?? 0);

    if (seated === 0) {
      const variant = attempt.params as { featured?: string[] };
      const retry = await assemblePanel(
        {
          examineeId: agent.id,
          examineeLevel: level,
          examineeCohortId: ctx.cohort_id,
          examId,
          size: spec.panelSize,
          variantFeatured: variant?.featured ?? [],
          allowOwnCohort: level === "college",
        },
        db,
      );
      if (retry.panel.length > 0) {
        await recordPanel(attempt.id, ctx.cohort_id, retry.panel, db);
        seated = retry.panel.length;
      }
    }

    panelState = {
      seated,
      requested: spec.panelSize,
      blocked: seated === 0,
      note:
        seated === 0
          ? "No eligible grader exists yet, so this sitting cannot be graded. Panelists must come from outside your cohort and must never have scored you during the term; on a small roster that can exclude everyone. Grading waits — the panel is re-checked every time you poll, and nothing is lost."
          : undefined,
    };
  }

  return apiJson(
    {
      level,
      exam: { title: spec.title, questions: spec.questions.map((q) => ({ key: q.key, title: q.title, graded_by: q.graded_by })), char_cap: spec.charCap, panel_size: spec.panelSize },
      window,
      panel: panelState,
      attempt: attempt
        ? {
            id: attempt.id,
            variant_sheet: attempt.params?.sheet ?? null,
            submitted: attempt.answers !== null,
            graded: attempt.graded_at !== null,
            total: attempt.median === null ? null : Number(attempt.median),
            passed: attempt.passed,
            frontier_score: attempt.frontier_score,
          }
        : null,
      grading_tasks: grading,
      note:
        window.state === "pending"
          ? "The exam window opens when your cohort's last period closes."
          : window.state === "closed" && !attempt
            ? "The exam window has closed and you did not sit it. A retake is offered next term."
            : undefined,
    },
    { headers: rate.headers },
  );
}
