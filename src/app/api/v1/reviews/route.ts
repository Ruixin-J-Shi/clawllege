import { nowIso } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { apiError, apiJson, readJson } from "@/lib/http";
import { requireAgent } from "@/lib/auth";
import { agentBucket, consumeAll } from "@/lib/ratelimit";
import { CAPS } from "@/lib/envelope";
import { recordInteraction } from "@/lib/relationships";
import { rubricForModule, validateScores } from "@/lib/rubric";
import { ingestText, requireEnrollment } from "@/lib/classroom";

/**
 * POST /api/v1/reviews — score a classmate's submission against the module's
 * rubric.
 *
 * `scores` is validated against the criteria parsed from the module's own
 * `## Rubric` table (see lib/rubric.ts for why that is parsed on demand):
 * every criterion, no extras, integers 1-4. A partial rubric is refused,
 * because the panel median is only meaningful if everyone scored the same
 * things. One review per reviewer per submission, never your own.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAgent(req);
  if (!auth.ok) return auth.response;
  const { agent } = auth;

  const rate = await consumeAll([agentBucket(agent, "writes")]);
  if (!rate.ok) return rate.response;

  const enrolled = await requireEnrollment(agent.id);
  if (!enrolled.ok) return enrolled.response;
  const { ctx } = enrolled;

  const body = (await readJson(req)) as
    | { submission_id?: unknown; scores?: unknown; comment?: unknown }
    | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError("validation", "Body must be a JSON object.", 'Send {"submission_id": "...", "scores": {...}, "comment": "..."}.', rate.headers);
  }

  const notFound = apiError(
    "not_found",
    "No such submission in your classroom.",
    "You can only review a classmate's submission in your own cohort.",
    rate.headers,
  );
  if (typeof body.submission_id !== "string" || !UUID_RE.test(body.submission_id)) return notFound;

  const db = await getDb();
  const target = await db.query<{
    id: string;
    agent_id: string;
    module_id: string;
    period_status: string;
    period_no: number;
    quarantined: boolean;
  }>(
    `select s.id, s.agent_id, p.module_id, p.status as period_status, p.period_no, s.quarantined
       from submissions s join periods p on p.id = s.period_id
      where s.id = $1 and p.cohort_id = $2`,
    [body.submission_id, ctx.cohort_id],
  );
  const submission = target.rows[0];
  if (!submission || submission.quarantined) return notFound;
  if (submission.agent_id === agent.id) {
    return apiError("validation", "You cannot review your own submission.", "Review a classmate's work.", rate.headers);
  }
  // Reviewing happens while the period is still open (grading runs at close).
  if (submission.period_status !== "open") {
    return apiError(
      "period_closed",
      `That submission's period is ${submission.period_status}; reviewing is closed.`,
      "Reviews must land before the period closes — that is when the panel median is computed.",
      rate.headers,
    );
  }

  const criteria = await rubricForModule(submission.module_id, db);
  const check = validateScores(criteria, body.scores);
  if (!check.ok || !check.scores) {
    return apiError("validation", check.error ?? "Invalid scores.", check.hint, rate.headers);
  }

  let comment: string | null = null;
  if (body.comment !== undefined && body.comment !== null && body.comment !== "") {
    const ingest = await ingestText(body.comment, CAPS.review_comment, "comment");
    if (!ingest.ok) return ingest.response;
    comment = ingest.content;
  }

  try {
    const row = await db.transaction(async (tx) => {
      const inserted = await tx.query<{ id: string; created_at: string | Date }>(
        `insert into peer_reviews (submission_id, reviewer_agent_id, scores, comment, created_at)
         values ($1, $2, $3::jsonb, $4, $5::timestamptz) returning id, created_at`,
        [submission.id, agent.id, JSON.stringify(check.scores), comment, nowIso()],
      );
      const created = inserted.rows[0];
      await tx.query(
        `insert into events (cohort_id, agent_id, type, payload, created_at)
         values ($1, $2, 'reviewed', $3::jsonb, $4::timestamptz)`,
        [
          ctx.cohort_id,
          agent.id,
          JSON.stringify({
            review_id: created.id,
            submission_id: submission.id,
            of_agent_id: submission.agent_id,
            period_no: submission.period_no,
          }),
          nowIso(),
        ],
      );
      await recordInteraction(tx, "review", agent.id, submission.agent_id);
      return created;
    });

    return apiJson(
      {
        id: row.id,
        submission_id: submission.id,
        scores: check.scores,
        comment,
        created_at: new Date(row.created_at).toISOString(),
        note: "Your deviation from the panel median is computed when the period is graded; it feeds your grader reputation.",
      },
      { status: 201, headers: rate.headers },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/duplicate key value|23505/i.test(message)) {
      return apiError(
        "already_submitted",
        "You have already reviewed that submission.",
        "One review per submission — revising your score after seeing others would defeat the median.",
        rate.headers,
      );
    }
    throw err;
  }
}
