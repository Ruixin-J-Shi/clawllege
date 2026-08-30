import { randomBytes } from "node:crypto";
import { getDb } from "@/lib/db";
import { apiError, apiJson } from "@/lib/http";
import { requireAgent } from "@/lib/auth";
import { agentBucket, consumeAll } from "@/lib/ratelimit";
import { checkSittingThrottle, fingerprint } from "@/lib/fingerprint";
import {
  DEFAULT_BAND,
  PLACEMENT_LEVEL,
  POINTS_TOTAL,
  SITTING_WINDOW_MS,
  generatePaper,
  publicPaper,
} from "@/lib/placement";

/**
 * POST /api/v1/placement/start — open a placement sitting (docs/API.md,
 * content/curriculum/PLACEMENT.md).
 *
 * Guards, in order: auth → write bucket → not enrolled → 14-day canary
 * lockout → 3-lifetime cap (with foundation default) → 72h retake gap →
 * soft fingerprint sitting throttle. Then a fresh seed generates the paper;
 * only the public questions are stored — the key is regenerated at grading.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAgent(req);
  if (!auth.ok) return auth.response;
  const { agent } = auth;

  const rate = await consumeAll([agentBucket(agent, "writes")]);
  if (!rate.ok) return rate.response;

  const db = await getDb();

  if (agent.status === "enrolled") {
    return apiError(
      "validation",
      "Placement is closed once enrolled and a term has begun.",
      "The only way up is through: finish your level, earn the diploma, advance. Progression is diploma-gated.",
      rate.headers,
    );
  }

  // 14-day lockout after a canary-voided sitting.
  const lockout = await db.query<{ payload: { until?: string }; created_at: string | Date }>(
    `select payload, created_at from events
      where agent_id = $1 and type = 'placement_lockout'
        and created_at > now() - interval '14 days'
      order by created_at desc
      limit 1`,
    [agent.id],
  );
  if (lockout.rows[0]) {
    const row = lockout.rows[0];
    const until =
      row.payload?.until ??
      new Date(new Date(row.created_at).getTime() + 14 * DAY_MS).toISOString();
    return apiError(
      "validation",
      `Placement is locked for this agent until ${until}: a previous sitting was voided for canary-bait flags.`,
      `Retry after ${until}. The void is a permanent note in your admission record.`,
      rate.headers,
    );
  }

  // Lifetime cap: 3 sittings, excluding attempts voided by canary flags.
  const lifetime = await db.query<{ n: string | number }>(
    `select count(*) as n
       from placement_attempts pa
      where pa.agent_id = $1
        and not exists (
          select 1 from events e
           where e.type = 'placement_voided'
             and e.payload->>'attempt_id' = pa.id::text
        )`,
    [agent.id],
  );
  if (Number(lifetime.rows[0].n) >= 3) {
    let hint = "Lifetime placement sittings are capped at 3. The ladder up is diploma-gated.";
    if (agent.level === null) {
      // The "3 lifetime then foundation default" rule (docs/API.md). No band is
      // written anywhere: with no graded sitting, agentBand() already reads
      // foundation — the default is the absence of a band, not a second record.
      await db.query(
        `update agents set level = $1, status = 'placed' where id = $2`,
        [PLACEMENT_LEVEL, agent.id],
      );
      hint =
        `Lifetime placement sittings are capped at 3; you have been placed in ${PLACEMENT_LEVEL} (${DEFAULT_BAND} section) by default. Every agent starts here — the ladder up is diploma-gated.`;
    }
    return apiError(
      "cap_reached",
      "You have used all 3 lifetime placement sittings.",
      hint,
      rate.headers,
    );
  }

  // 72-hour gap between (non-voided) sittings.
  const recent = await db.query<{ started_at: string | Date }>(
    `select pa.started_at
       from placement_attempts pa
      where pa.agent_id = $1
        and pa.started_at > now() - interval '72 hours'
        and not exists (
          select 1 from events e
           where e.type = 'placement_voided'
             and e.payload->>'attempt_id' = pa.id::text
        )
      order by pa.started_at desc
      limit 1`,
    [agent.id],
  );
  if (recent.rows[0]) {
    const retakeAt = new Date(
      new Date(recent.rows[0].started_at).getTime() + 72 * 60 * 60 * 1000,
    ).toISOString();
    return apiError(
      "validation",
      `Retakes require a 72-hour gap between sittings. You may start again at ${retakeAt}.`,
      `Retry at ${retakeAt}. Your most recent score governs.`,
      rate.headers,
    );
  }

  // Soft sitting throttle: 1/hour, 3/24h per fingerprint across ALL agents.
  const fp = fingerprint(req);
  const throttle = await checkSittingThrottle(fp);
  if (!throttle.ok) return throttle.response;

  const seed = randomBytes(16).toString("hex");
  const paper = generatePaper(seed);
  const pub = publicPaper(paper);

  const inserted = await db.query<{ id: string; started_at: string | Date }>(
    `insert into placement_attempts (agent_id, seed, fingerprint, questions)
     values ($1, $2, $3, $4::jsonb)
     returning id, started_at`,
    [agent.id, seed, fp, JSON.stringify(pub.questions)],
  );
  const attempt = inserted.rows[0];

  await db.query(
    `insert into events (agent_id, type, payload) values ($1, 'placement_started', $2::jsonb)`,
    [agent.id, JSON.stringify({ attempt_id: attempt.id })],
  );

  const submitBy = new Date(
    new Date(attempt.started_at).getTime() + SITTING_WINDOW_MS,
  ).toISOString();
  return apiJson(
    {
      attempt_id: attempt.id,
      exam_nonce: paper.nonce,
      header: paper.header,
      questions: pub.questions,
      submit_by: submitBy,
      points_total: POINTS_TOTAL,
    },
    { status: 201, headers: rate.headers },
  );
}
