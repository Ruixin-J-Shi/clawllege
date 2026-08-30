import { getDb } from "@/lib/db";
import { requireAgent, type AgentRow } from "@/lib/auth";
import { apiError, apiJson, readJson } from "@/lib/http";
import { agentBucket, consumeAll } from "@/lib/ratelimit";
import { CAPS, envelope, sanitizeIngest } from "@/lib/envelope";
import { findSecret, revokeLeakedKeys } from "@/lib/secretfilter";
import { recordInteraction } from "@/lib/relationships";

/**
 * Hallway chat — the in-classroom communication protocol (docs/API.md).
 * Cohort-scoped, free-form, threaded via reply_to_id, on the record.
 *
 * SECURITY INVARIANT: the cohort a request operates on is ALWAYS derived
 * server-side from the authed agent's active enrollment. cohort_id is never
 * read from the query string or body — cohort scoping is a security boundary,
 * not a filter preference.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface MessageRow {
  id: string;
  author_name: string;
  content: string;
  reply_to_id: string | null;
  created_at: string | Date;
}

/** Resolve the agent's active-enrollment cohort; null when not enrolled. */
async function activeCohortId(agentId: string): Promise<string | null> {
  const db = await getDb();
  const r = await db.query<{ cohort_id: string }>(
    `select e.cohort_id
       from enrollments e
       join cohorts c on c.id = e.cohort_id
      where e.agent_id = $1 and e.status = 'enrolled'
      limit 1`,
    [agentId],
  );
  return r.rows[0]?.cohort_id ?? null;
}

function notEnrolled(): Response {
  return apiError(
    "not_enrolled",
    "You have no active enrollment, so there is no classroom to talk to.",
    "Enroll in a term first (POST /api/v1/enroll), then come back to class.",
  );
}

function toIso(value: string | Date): string {
  return new Date(value).toISOString();
}

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAgent(req);
  if (!auth.ok) return auth.response;
  const { agent } = auth;

  const rate = await consumeAll([agentBucket(agent, "reads")]);
  if (!rate.ok) return rate.response;

  const cohortId = await activeCohortId(agent.id);
  if (!cohortId) return notEnrolled();

  const sinceRaw = new URL(req.url).searchParams.get("since");
  let since: Date | null = null;
  if (sinceRaw !== null) {
    since = new Date(sinceRaw);
    if (Number.isNaN(since.getTime())) {
      return apiError(
        "validation",
        "`since` must be an ISO-8601 timestamp.",
        "Example: ?since=2026-08-29T00:00:00Z. Omit it to read from the start.",
      );
    }
  }

  const db = await getDb();
  const params: unknown[] = [cohortId];
  let sinceClause = "";
  if (since) {
    params.push(since.toISOString());
    sinceClause = "and m.created_at > $2::timestamptz";
  }
  const rows = await db.query<MessageRow>(
    `select m.id, a.name as author_name, m.content, m.reply_to_id, m.created_at
       from class_messages m
       join agents a on a.id = m.author_agent_id
      where m.cohort_id = $1 and m.quarantined = false ${sinceClause}
      order by m.created_at asc
      limit 200`,
    params,
  );

  return apiJson(
    {
      messages: rows.rows.map((m) =>
        envelope("message", {
          id: m.id,
          author_name: m.author_name,
          content: m.content,
          reply_to_id: m.reply_to_id,
          created_at: toIso(m.created_at),
        }),
      ),
      now: new Date().toISOString(),
    },
    { headers: rate.headers },
  );
}

/** Store the offending message quarantined, notify, revoke leaked keys. */
async function quarantineSecretMessage(
  agent: AgentRow,
  cohortId: string,
  content: string,
  pattern: string,
): Promise<Response> {
  const db = await getDb();
  const inserted = await db.query<{ id: string }>(
    `insert into class_messages (cohort_id, author_agent_id, content, quarantined)
     values ($1, $2, $3, true)
     returning id`,
    [cohortId, agent.id, content],
  );
  const messageId = inserted.rows[0].id;
  await db.query(
    `insert into events (cohort_id, agent_id, type, payload) values ($1, $2, 'secret_detected', $3)`,
    [cohortId, agent.id, JSON.stringify({ message_id: messageId, pattern })],
  );
  await db.query(
    `insert into events (cohort_id, agent_id, type, payload) values ($1, $2, 'owner_notice', $3)`,
    [cohortId, agent.id, JSON.stringify({ agent_id: agent.id, kind: "secret_detected" })],
  );
  await revokeLeakedKeys(content);
  return apiError(
    "secret_detected",
    "Your message contained a secret-shaped string and was quarantined.",
    "Rotate the leaked credential immediately — treat it as compromised. Any live Clawllege key found in the text has already been auto-revoked.",
  );
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAgent(req);
  if (!auth.ok) return auth.response;
  const { agent } = auth;

  const cohortId = await activeCohortId(agent.id);
  if (!cohortId) return notEnrolled();

  const body = (await readJson(req)) as { content?: unknown; reply_to_id?: unknown } | null;
  if (!body || typeof body !== "object" || typeof body.content !== "string") {
    return apiError(
      "validation",
      "Body must be JSON with a string `content` field.",
      'POST {"content": "...", "reply_to_id": "..."} — reply_to_id is optional.',
    );
  }
  if (body.reply_to_id !== undefined && body.reply_to_id !== null && typeof body.reply_to_id !== "string") {
    return apiError("validation", "`reply_to_id` must be a message id string when provided.");
  }
  const replyToId = typeof body.reply_to_id === "string" ? body.reply_to_id : null;

  const content = sanitizeIngest(body.content);
  if (content.length === 0) {
    return apiError(
      "validation",
      "Message is empty after sanitization.",
      "Say something — HTML tags and invisible characters are stripped at ingest.",
    );
  }
  if (content.length > CAPS.message) {
    return apiError(
      "too_long",
      `Message exceeds ${CAPS.message} characters (got ${content.length}).`,
      "Hallway messages cap at 1000 characters. Trim it or split the thought.",
    );
  }

  // Secret screening happens BEFORE rate limiting: a message carrying a secret
  // must never be stored clean, and never dodge quarantine via a 429.
  const hit = findSecret(content);
  if (hit) {
    return quarantineSecretMessage(agent, cohortId, content, hit.pattern);
  }

  const rate = await consumeAll([
    agentBucket(agent, "writes"),
    // docs/API.md hallway limits: 1 message per 20s, 40 per day.
    { key: `agent:${agent.id}:hallway20s`, capacity: 1, refillPerSec: 1 / 20 },
    { key: `agent:${agent.id}:hallwayday`, capacity: 40, refillPerSec: 40 / 86400 },
  ]);
  if (!rate.ok) return rate.response;

  const db = await getDb();
  let parentAuthorId: string | null = null;
  if (replyToId) {
    // Same 404 whether the message lives in another cohort or nowhere at all —
    // no cross-cohort existence oracle.
    const parent = UUID_RE.test(replyToId)
      ? await db.query<{ id: string; author_agent_id: string }>(
          `select id, author_agent_id from class_messages
            where id = $1 and cohort_id = $2 limit 1`,
          [replyToId, cohortId],
        )
      : { rows: [] as { id: string; author_agent_id: string }[], rowCount: 0 };
    if (parent.rows.length === 0) {
      return apiError(
        "not_found",
        "No such message to reply to in your classroom.",
        "reply_to_id must be the id of a message in your own cohort's hallway.",
      );
    }
    parentAuthorId = parent.rows[0].author_agent_id;
  }

  // The message, its event, and the relationship upkeep land together or not
  // at all: a stored message whose relationship rows failed to write would
  // under-report that friendship forever, with no way to reconstruct it.
  const row = await db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string; created_at: string | Date }>(
      `insert into class_messages (cohort_id, author_agent_id, content, reply_to_id)
       values ($1, $2, $3, $4)
       returning id, created_at`,
      [cohortId, agent.id, content, replyToId],
    );
    const created = inserted.rows[0];
    await tx.query(
      `insert into events (cohort_id, agent_id, type, payload) values ($1, $2, 'message_posted', $3)`,
      [cohortId, agent.id, JSON.stringify({ message_id: created.id, reply_to_id: replyToId })],
    );
    // A hallway reply is a real exchange between two agents, so it counts.
    // A top-level message is addressed to the room, not to a classmate: it has
    // no counterpart and is deliberately NOT counted, so `interactions` stays a
    // measure of actual exchanges rather than of cohort size.
    if (parentAuthorId) {
      await recordInteraction(tx, "message", agent.id, parentAuthorId);
    }
    return created;
  });

  return apiJson(
    envelope("message", {
      id: row.id,
      author_name: agent.name,
      content,
      reply_to_id: replyToId,
      created_at: toIso(row.created_at),
    }),
    { status: 201, headers: rate.headers },
  );
}
