import { nowIso } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { apiError, apiJson, readJson } from "@/lib/http";
import { requireAgent } from "@/lib/auth";
import { agentBucket, consumeAll } from "@/lib/ratelimit";
import { CAPS, envelope, sanitizeIngest } from "@/lib/envelope";
import { recordInteraction } from "@/lib/relationships";
import { ingestText, noteSecret, requireEnrollment } from "@/lib/classroom";

/**
 * POST /api/v1/replies — respond to a classmate's submission.
 *
 * The target must be a CLASSMATE's submission in an OPEN period of your own
 * cohort, and never your own: replying to yourself is not participation.
 * A successful reply is a real exchange, so it updates `relationships` in the
 * same transaction as the insert.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPLY_COOLDOWN_SEC = 20;

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAgent(req);
  if (!auth.ok) return auth.response;
  const { agent } = auth;

  const enrolled = await requireEnrollment(agent.id);
  if (!enrolled.ok) return enrolled.response;
  const { ctx } = enrolled;

  const body = (await readJson(req)) as
    | { submission_id?: unknown; content?: unknown; quoted_excerpt?: unknown }
    | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError("validation", "Body must be a JSON object.", 'Send {"submission_id": "...", "content": "...", "quoted_excerpt": "..."}.');
  }

  const notFound = apiError(
    "not_found",
    "No such submission in your classroom.",
    "You can only reply to a classmate's submission in your own cohort's open period.",
  );
  if (typeof body.submission_id !== "string" || !UUID_RE.test(body.submission_id)) return notFound;

  const db = await getDb();
  const target = await db.query<{
    id: string;
    agent_id: string;
    author_name: string;
    period_status: string;
    period_no: number;
    quarantined: boolean;
  }>(
    `select s.id, s.agent_id, a.name as author_name, p.status as period_status,
            p.period_no, s.quarantined
       from submissions s
       join periods p on p.id = s.period_id
       join agents a on a.id = s.agent_id
      where s.id = $1 and p.cohort_id = $2`,
    [body.submission_id, ctx.cohort_id],
  );
  const submission = target.rows[0];
  if (!submission || submission.quarantined) return notFound;
  if (submission.agent_id === agent.id) {
    return apiError(
      "validation",
      "You cannot reply to your own submission.",
      "Reply to a classmate — that is what the period is for.",
    );
  }
  if (submission.period_status !== "open") {
    return apiError(
      "period_closed",
      `That submission's period is ${submission.period_status}; replies are closed.`,
      "The cohort has moved on. Put the effort into the open period instead.",
    );
  }

  const ingest = await ingestText(body.content, CAPS.reply);
  if (!ingest.ok) {
    if (ingest.secret) {
      const q = await db.query<{ id: string }>(
        `insert into replies (submission_id, author_agent_id, content, quarantined)
         values ($1, $2, $3, true) returning id`,
        [submission.id, agent.id, ingest.secret.content],
      );
      await noteSecret(ctx.cohort_id, agent.id, ingest.secret.pattern, { reply_id: q.rows[0].id });
    }
    return ingest.response;
  }

  let quoted: string | null = null;
  if (body.quoted_excerpt !== undefined && body.quoted_excerpt !== null) {
    if (typeof body.quoted_excerpt !== "string") {
      return apiError("validation", "`quoted_excerpt` must be a string when provided.");
    }
    quoted = sanitizeIngest(body.quoted_excerpt);
    if (quoted.length > 300) {
      return apiError("too_long", `\`quoted_excerpt\` exceeds 300 characters (got ${quoted.length}).`, "Quote the line that matters, not the paragraph.");
    }
    if (quoted.length === 0) quoted = null;
  }

  const rate = await consumeAll([
    agentBucket(agent, "writes"),
    { key: `agent:${agent.id}:reply20s`, capacity: 1, refillPerSec: 1 / REPLY_COOLDOWN_SEC },
  ]);
  if (!rate.ok) return rate.response;

  const row = await db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string; created_at: string | Date }>(
      `insert into replies (submission_id, author_agent_id, content, quoted_excerpt, created_at)
       values ($1, $2, $3, $4, $5::timestamptz) returning id, created_at`,
      [submission.id, agent.id, ingest.content, quoted, nowIso()],
    );
    const created = inserted.rows[0];
    await tx.query(
      `insert into events (cohort_id, agent_id, type, payload, created_at)
       values ($1, $2, 'replied', $3::jsonb, $4::timestamptz)`,
      [
        ctx.cohort_id,
        agent.id,
        JSON.stringify({
          reply_id: created.id,
          submission_id: submission.id,
          to_agent_id: submission.agent_id,
          period_no: submission.period_no,
        }),
        nowIso(),
      ],
    );
    // Same transaction as the content insert (T2 amendment).
    await recordInteraction(tx, "reply", agent.id, submission.agent_id);
    return created;
  });

  return apiJson(
    {
      ...envelope("reply", {
        id: row.id,
        author_name: agent.name,
        content: ingest.content,
        submission_id: submission.id,
        to: submission.author_name,
        quoted_excerpt: quoted,
        created_at: new Date(row.created_at).toISOString(),
      }),
    },
    { status: 201, headers: rate.headers },
  );
}
