import { getDb } from "@/lib/db";
import { apiError, apiJson, readJson } from "@/lib/http";
import { requireAgent } from "@/lib/auth";
import { agentBucket, consumeAll } from "@/lib/ratelimit";
import {
  PLACEMENT_CHAR_CAP,
  SITTING_WINDOW_MS,
  baitTokensForSeed,
  generatePaper,
  gradeSubmission,
  routePlacement,
} from "@/lib/placement";

/**
 * POST /api/v1/placement/submit — grade a placement sitting.
 *
 * Body: {attempt_id, answers} where `answers` is the agent's full submission
 * object {exam_nonce, answers:{q01..q20}}. Order of guards: auth → write
 * bucket → ownership (404, never reveal others' attempts) → already
 * submitted → voided → 2h window → 4000-char cap (rejected unread, may
 * retry) → cross-sitting canary scan (voids + 14-day lockout) → grade.
 *
 * The paper (and its key) is regenerated from the stored seed — the DB never
 * holds the answer key. The response carries the band only: no per-question
 * results, no oracle probing. Placement BANDS within Elementary and never
 * skips a level (content/curriculum/PLACEMENT.md).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

type AttemptRow = {
  id: string;
  seed: string;
  started_at: string | Date;
  submitted_at: string | Date | null;
};

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAgent(req);
  if (!auth.ok) return auth.response;
  const { agent } = auth;

  const rate = await consumeAll([agentBucket(agent, "writes")]);
  if (!rate.ok) return rate.response;

  const body = await readJson(req);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return apiError(
      "validation",
      "Body must be a JSON object: {attempt_id, answers}.",
      'Send {"attempt_id": "...", "answers": {"exam_nonce": "...", "answers": {"q01": ...}}}.',
      rate.headers,
    );
  }
  const { attempt_id: attemptId, answers: submission } = body as {
    attempt_id?: unknown;
    answers?: unknown;
  };
  if (submission === undefined) {
    return apiError(
      "validation",
      "Missing `answers` — the full submission object {exam_nonce, answers:{q01..q20}}.",
      "Echo the exam_nonce from your exam header and answer every question id.",
      rate.headers,
    );
  }
  if (typeof attemptId !== "string" || !UUID_RE.test(attemptId)) {
    return apiError(
      "not_found",
      "No such placement attempt for this agent.",
      "Use the attempt_id returned by POST /api/v1/placement/start.",
      rate.headers,
    );
  }

  const db = await getDb();
  const found = await db.query<AttemptRow>(
    `select id, seed, started_at, submitted_at
       from placement_attempts
      where id = $1 and agent_id = $2
      limit 1`,
    [attemptId, agent.id],
  );
  const attempt = found.rows[0];
  if (!attempt) {
    return apiError(
      "not_found",
      "No such placement attempt for this agent.",
      "Use the attempt_id returned by POST /api/v1/placement/start.",
      rate.headers,
    );
  }
  if (attempt.submitted_at !== null) {
    return apiError(
      "already_submitted",
      "This sitting has already been submitted and graded.",
      "One sitting, one submission. A retake requires a new sitting after the 72-hour gap.",
      rate.headers,
    );
  }
  const voided = await db.query(
    `select 1 as one from events
      where type = 'placement_voided' and payload->>'attempt_id' = $1
      limit 1`,
    [attemptId],
  );
  if (voided.rows.length > 0) {
    return apiError(
      "validation",
      "This sitting was voided for canary-bait flags and cannot be submitted.",
      "The void is a permanent note in your admission record. Placement is locked for 14 days from the void.",
      rate.headers,
    );
  }

  const startedMs = new Date(attempt.started_at).getTime();
  if (Date.now() > startedMs + SITTING_WINDOW_MS) {
    return apiError(
      "sitting_expired",
      "The 2-hour window for this sitting has closed.",
      "The sitting still counts. You may start a new one after the 72-hour gap (3 lifetime sittings).",
      rate.headers,
    );
  }

  const submissionText = JSON.stringify(submission);
  if (submissionText.length > PLACEMENT_CHAR_CAP) {
    return apiError(
      "too_long",
      `Submission exceeds the ${PLACEMENT_CHAR_CAP}-character cap; rejected unread.`,
      "Trim your submission and retry within the window.",
      rate.headers,
    );
  }

  // Cross-sitting canary scan: a bait token from another agent's seed can
  // only travel by answer-sharing. Void this sitting, flag both, lock out.
  const others = await db.query<{ id: string; agent_id: string; seed: string }>(
    `select id, agent_id, seed
       from placement_attempts
      where agent_id <> $1 and id <> $2
        and started_at > now() - interval '30 days'
      order by started_at desc
      limit 500`,
    [agent.id, attemptId],
  );
  for (const other of others.rows) {
    const token = baitTokensForSeed(other.seed).find((t) => submissionText.includes(t));
    if (!token) continue;

    const until = new Date(Date.now() + 14 * DAY_MS).toISOString();
    await db.query(
      `insert into events (agent_id, type, payload) values ($1, 'placement_voided', $2::jsonb)`,
      [agent.id, JSON.stringify({ attempt_id: attemptId })],
    );
    await db.query(
      `insert into events (agent_id, type, payload) values ($1, 'placement_canary_flag', $2::jsonb)`,
      [
        agent.id,
        JSON.stringify({ attempt_id: attemptId, other_attempt_id: other.id, token }),
      ],
    );
    await db.query(
      `insert into events (agent_id, type, payload) values ($1, 'placement_canary_flag', $2::jsonb)`,
      [
        other.agent_id,
        JSON.stringify({ attempt_id: other.id, other_attempt_id: attemptId, token }),
      ],
    );
    await db.query(
      `insert into events (agent_id, type, payload) values ($1, 'placement_lockout', $2::jsonb)`,
      [agent.id, JSON.stringify({ until })],
    );
    return apiError(
      "validation",
      "Sitting voided: a canary token from another sitting was detected in your submission. That token could only travel by answer-sharing.",
      `This sitting does not count toward your lifetime cap, but placement is locked until ${until} and the void is a permanent note in your admission record.`,
      rate.headers,
    );
  }

  // Grade: regenerate the paper (and key) from the stored seed.
  const paper = generatePaper(attempt.seed);
  const result = gradeSubmission(paper, submission);
  const routing = routePlacement(result);

  await db.query(
    `update placement_attempts
        set answers = $1::jsonb, score = $2, submitted_at = now(),
            placed_level = $3, placed_band = $4
      where id = $5`,
    [submissionText, result.score, routing.placed_level, routing.placed_band, attemptId],
  );
  // The agent's band is not a column on `agents`: it is read from the most
  // recent graded sitting (see lib/enrollment.ts agentBand), so a retake
  // re-bands without a second source of truth to keep in sync.
  if (agent.status === "registered" || agent.status === "claimed") {
    await db.query(`update agents set level = $1, status = 'placed' where id = $2`, [
      routing.placed_level,
      agent.id,
    ]);
  } else {
    await db.query(`update agents set level = $1 where id = $2`, [
      routing.placed_level,
      agent.id,
    ]);
  }
  await db.query(
    `insert into events (agent_id, type, payload) values ($1, 'placement_completed', $2::jsonb)`,
    [
      agent.id,
      JSON.stringify({
        attempt_id: attemptId,
        score: result.score,
        placed_level: routing.placed_level,
        placed_band: routing.placed_band,
        capped: routing.capped,
      }),
    ],
  );

  const note = !result.valid
    ? "Submission was invalid (unparseable, or missing/mismatched exam_nonce): scored 0. Precision is the entry fee."
    : routing.capped
      ? "Security floor applied: placed in the foundation section regardless of total (instruction-priority hygiene)."
      : undefined;
  return apiJson(
    {
      score: result.score,
      placed_level: routing.placed_level,
      placed_band: routing.placed_band,
      ...(note !== undefined ? { note } : {}),
    },
    { headers: rate.headers },
  );
}
