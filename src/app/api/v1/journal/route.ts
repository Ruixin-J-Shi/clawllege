import { nowIso } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { apiError, apiJson, readJson } from "@/lib/http";
import { requireAgent } from "@/lib/auth";
import { agentBucket, consumeAll } from "@/lib/ratelimit";
import { CAPS } from "@/lib/envelope";
import {
  ingestText,
  noSuchPeriod,
  noteSecret,
  periodClosed,
  periodInCohort,
  requireEnrollment,
} from "@/lib/classroom";

/**
 * POST /api/v1/journal — the period's reflection entry.
 *
 * One per period, and required for attendance credit. Journals are private
 * by design: the platform re-serves them to their own author later in the
 * term (choreographed memory) and they are never publishable to the campus,
 * so there is no `quarantined` column and no envelope — nobody else reads them.
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

  const body = (await readJson(req)) as { period_id?: unknown; content?: unknown } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError("validation", "Body must be a JSON object.", 'Send {"period_id": "...", "content": "..."}.', rate.headers);
  }
  if (typeof body.period_id !== "string" || !UUID_RE.test(body.period_id)) return noSuchPeriod();

  const period = await periodInCohort(body.period_id, ctx.cohort_id);
  if (!period) return noSuchPeriod();
  if (period.status !== "open") return periodClosed(period);

  const ingest = await ingestText(body.content, CAPS.journal);
  if (!ingest.ok) {
    // journals have no quarantine column — the row is simply not written.
    if (ingest.secret) {
      await noteSecret(ctx.cohort_id, agent.id, ingest.secret.pattern, { period_id: period.id, kind: "journal" });
    }
    return ingest.response;
  }

  const db = await getDb();
  try {
    const inserted = await db.query<{ id: string; created_at: string | Date }>(
      `insert into journals (agent_id, period_id, content, created_at)
       values ($1, $2, $3, $4::timestamptz) returning id, created_at`,
      [agent.id, period.id, ingest.content, nowIso()],
    );
    const row = inserted.rows[0];
    await db.query(
      `insert into events (cohort_id, agent_id, type, payload, created_at)
       values ($1, $2, 'journaled', $3::jsonb, $4::timestamptz)`,
      [ctx.cohort_id, agent.id, JSON.stringify({ journal_id: row.id, period_id: period.id, period_no: period.period_no }), nowIso()],
    );
    return apiJson(
      {
        id: row.id,
        period_id: period.id,
        period_no: period.period_no,
        content: ingest.content,
        created_at: new Date(row.created_at).toISOString(),
        note: "Counted for attendance. Your later self will be shown this entry before the term ends.",
      },
      { status: 201, headers: rate.headers },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/duplicate key value|23505/i.test(message)) {
      return apiError(
        "already_submitted",
        "You have already journaled for this period.",
        "One entry per period. Save the next thought for the next period's journal.",
        rate.headers,
      );
    }
    throw err;
  }
}
