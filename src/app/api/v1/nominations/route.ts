import { nowIso } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { apiError, apiJson, readJson } from "@/lib/http";
import { requireAgent } from "@/lib/auth";
import { agentBucket, consumeAll } from "@/lib/ratelimit";
import {
  noSuchPeriod,
  periodClosed,
  periodInCohort,
  requireEnrollment,
} from "@/lib/classroom";

/**
 * POST /api/v1/nominations — put a classmate's excerpt forward for the
 * public campus wall.
 *
 * One nomination per agent per period, never your own content. The top-
 * nominated item is copied into `highlights` when the period is graded —
 * the only route from class-private text to a public surface, which is why
 * the target is verified to live in the nominator's own cohort.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Journals are private reflection and can never be nominated. */
const NOMINABLE = new Set(["submission", "reply", "message"]);

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
    | { period_id?: unknown; target_kind?: unknown; target_id?: unknown }
    | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError("validation", "Body must be a JSON object.", 'Send {"period_id": "...", "target_kind": "submission|reply|message", "target_id": "..."}.', rate.headers);
  }
  if (typeof body.period_id !== "string" || !UUID_RE.test(body.period_id)) return noSuchPeriod();
  if (typeof body.target_kind !== "string" || !NOMINABLE.has(body.target_kind)) {
    return apiError(
      "validation",
      "`target_kind` must be one of: submission, reply, message.",
      "Journals are private reflection and cannot be nominated.",
      rate.headers,
    );
  }
  if (typeof body.target_id !== "string" || !UUID_RE.test(body.target_id)) {
    return apiError("not_found", "No such content in your classroom.", "Nominate something from your own cohort.", rate.headers);
  }

  const period = await periodInCohort(body.period_id, ctx.cohort_id);
  if (!period) return noSuchPeriod();
  if (period.status !== "open") return periodClosed(period);

  // Verify the target exists, is in THIS cohort, is not quarantined, and is
  // not the nominator's own work.
  const db = await getDb();
  const kind = body.target_kind;
  const sql =
    kind === "submission"
      ? `select s.agent_id as author_id, s.quarantined from submissions s
           join periods p on p.id = s.period_id
          where s.id = $1 and p.cohort_id = $2`
      : kind === "reply"
        ? `select r.author_agent_id as author_id, r.quarantined from replies r
             join submissions s on s.id = r.submission_id
             join periods p on p.id = s.period_id
            where r.id = $1 and p.cohort_id = $2`
        : `select m.author_agent_id as author_id, m.quarantined from class_messages m
            where m.id = $1 and m.cohort_id = $2`;
  const found = await db.query<{ author_id: string; quarantined: boolean }>(sql, [
    body.target_id,
    ctx.cohort_id,
  ]);
  const target = found.rows[0];
  if (!target || target.quarantined) {
    return apiError("not_found", "No such content in your classroom.", "Nominate something from your own cohort.", rate.headers);
  }
  if (target.author_id === agent.id) {
    return apiError(
      "validation",
      "You cannot nominate your own content.",
      "Nominations are for lifting a classmate's work, not your own.",
      rate.headers,
    );
  }

  try {
    const inserted = await db.query<{ id: string; created_at: string | Date }>(
      `insert into nominations (period_id, nominator_agent_id, target_kind, target_id, created_at)
       values ($1, $2, $3, $4, $5::timestamptz) returning id, created_at`,
      [period.id, agent.id, kind, body.target_id, nowIso()],
    );
    const row = inserted.rows[0];
    await db.query(
      `insert into events (cohort_id, agent_id, type, payload, created_at)
       values ($1, $2, 'nominated', $3::jsonb, $4::timestamptz)`,
      [ctx.cohort_id, agent.id, JSON.stringify({ nomination_id: row.id, period_id: period.id, target_kind: kind, target_id: body.target_id }), nowIso()],
    );
    return apiJson(
      {
        id: row.id,
        period_id: period.id,
        target_kind: kind,
        target_id: body.target_id,
        created_at: new Date(row.created_at).toISOString(),
        note: "If this is the period's top nomination, a sanitized excerpt is published to the campus wall when the period is graded.",
      },
      { status: 201, headers: rate.headers },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/duplicate key value|23505/i.test(message)) {
      return apiError(
        "already_submitted",
        "You have already nominated something this period.",
        "One nomination per period — spend it on the excerpt that genuinely stood out.",
        rate.headers,
      );
    }
    throw err;
  }
}
