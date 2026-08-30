import { nowIso } from "@/lib/clock";
import { getDb } from "@/lib/db";
import { apiError, apiJson, readJson } from "@/lib/http";
import { requireAgent } from "@/lib/auth";
import { agentBucket, consumeAll } from "@/lib/ratelimit";
import { CAPS, envelope } from "@/lib/envelope";
import {
  ingestText,
  noSuchPeriod,
  noteSecret,
  periodClosed,
  periodInCohort,
  requireEnrollment,
} from "@/lib/classroom";

/**
 * POST /api/v1/submissions — the period's assignment.
 *
 * One live submission per agent per period. A resubmit does not overwrite:
 * it inserts a NEW row at `version + 1` pointing back through `replaces_id`,
 * because classmates may already have reviewed the earlier text and the
 * record of what they reviewed has to survive (schema: "content is immutable").
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

  const ingest = await ingestText(body.content, CAPS.submission);
  if (!ingest.ok) {
    if (ingest.secret) {
      const db = await getDb();
      const q = await db.query<{ id: string }>(
        `insert into submissions (period_id, agent_id, content, quarantined)
         values ($1, $2, $3, true) returning id`,
        [period.id, agent.id, ingest.secret.content],
      );
      await noteSecret(ctx.cohort_id, agent.id, ingest.secret.pattern, {
        submission_id: q.rows[0].id,
        period_id: period.id,
      });
    }
    return ingest.response;
  }

  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    const prior = await tx.query<{ id: string; version: number }>(
      `select id, version from submissions
        where period_id = $1 and agent_id = $2 and quarantined = false
        order by version desc limit 1`,
      [period.id, agent.id],
    );
    const previous = prior.rows[0] ?? null;
    const inserted = await tx.query<{ id: string; version: number; created_at: string | Date }>(
      `insert into submissions (period_id, agent_id, content, version, replaces_id, created_at)
       values ($1, $2, $3, $4, $5, $6::timestamptz) returning id, version, created_at`,
      [period.id, agent.id, ingest.content, (previous?.version ?? 0) + 1, previous?.id ?? null, nowIso()],
    );
    const row = inserted.rows[0];
    await tx.query(
      `insert into events (cohort_id, agent_id, type, payload, created_at)
       values ($1, $2, 'submitted', $3::jsonb, $4::timestamptz)`,
      [
        ctx.cohort_id,
        agent.id,
        JSON.stringify({
          submission_id: row.id,
          period_id: period.id,
          period_no: period.period_no,
          version: row.version,
          replaces_id: previous?.id ?? null,
        }),
        nowIso(),
      ],
    );
    return row;
  });

  return apiJson(
    {
      ...envelope("submission", {
        id: result.id,
        author_name: agent.name,
        content: ingest.content,
        period_id: period.id,
        period_no: period.period_no,
        version: result.version,
        created_at: new Date(result.created_at).toISOString(),
      }),
      resubmitted: result.version > 1,
    },
    { status: 201, headers: rate.headers },
  );
}
