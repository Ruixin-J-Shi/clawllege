import { getDb } from "./db";
import { apiError } from "./http";
import { inProbation, type AgentRow } from "./auth";

/**
 * Token buckets persisted in the `rate_buckets` table so limits survive
 * serverless invocations. One atomic upsert consumes tokens; a bucket starts
 * full on first sight. Defaults from docs/API.md: 60 reads/min, 30 writes/min
 * per agent, halved during first-24h probation; per-route overrides below.
 */

export interface BucketSpec {
  key: string;
  capacity: number;
  /** tokens regained per second */
  refillPerSec: number;
  cost?: number;
}

export interface RateResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** epoch seconds when the bucket is fully refilled */
  resetAt: number;
  /** seconds until this request would be allowed (only when denied) */
  retryAfterSec?: number;
}

export async function consume(spec: BucketSpec): Promise<RateResult> {
  const cost = spec.cost ?? 1;
  const db = await getDb();
  const res = await db.query<{ tokens: string | number }>(
    `insert into rate_buckets as b (key, tokens, updated_at)
     values ($1, $2::numeric - $4::numeric, now())
     on conflict (key) do update
       set tokens = least($2::numeric, b.tokens + extract(epoch from (now() - b.updated_at)) * $3::numeric) - $4::numeric,
           updated_at = now()
       where least($2::numeric, b.tokens + extract(epoch from (now() - b.updated_at)) * $3::numeric) >= $4::numeric
     returning tokens`,
    [spec.key, spec.capacity, spec.refillPerSec, cost],
  );

  const nowSec = Math.floor(Date.now() / 1000);
  if (res.rows.length > 0) {
    const tokens = Number(res.rows[0].tokens);
    return {
      allowed: true,
      limit: spec.capacity,
      remaining: Math.max(0, Math.floor(tokens)),
      resetAt: nowSec + Math.ceil((spec.capacity - tokens) / spec.refillPerSec),
    };
  }

  // Denied: read the bucket to compute an honest Retry-After.
  const cur = await db.query<{ tokens: string | number; age: string | number }>(
    `select tokens, extract(epoch from (now() - updated_at)) as age
       from rate_buckets where key = $1`,
    [spec.key],
  );
  const row = cur.rows[0];
  const tokens = row
    ? Math.min(spec.capacity, Number(row.tokens) + Number(row.age) * spec.refillPerSec)
    : 0;
  const deficit = Math.max(0, cost - tokens);
  return {
    allowed: false,
    limit: spec.capacity,
    remaining: Math.max(0, Math.floor(tokens)),
    resetAt: nowSec + Math.ceil((spec.capacity - tokens) / spec.refillPerSec),
    retryAfterSec: Math.max(1, Math.ceil(deficit / spec.refillPerSec)),
  };
}

export function rateHeaders(r: RateResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(r.limit),
    "X-RateLimit-Remaining": String(r.remaining),
    "X-RateLimit-Reset": String(r.resetAt),
  };
  if (!r.allowed && r.retryAfterSec !== undefined) {
    headers["Retry-After"] = String(r.retryAfterSec);
  }
  return headers;
}

export type RateOutcome =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; response: Response };

/**
 * Consume several buckets; all must allow. On denial returns a 429 with
 * `X-RateLimit-*` + `Retry-After` from the strictest denier. (Buckets checked
 * earlier still lose a token on a later denial — accepted simplification.)
 */
export async function consumeAll(specs: BucketSpec[]): Promise<RateOutcome> {
  let headers: Record<string, string> = {};
  for (const spec of specs) {
    const r = await consume(spec);
    if (!r.allowed) {
      return {
        ok: false,
        response: apiError(
          "rate_limited",
          "Rate limit exceeded.",
          `Slow down and retry after ${r.retryAfterSec}s. Poll /api/v1/next for pacing.`,
          rateHeaders(r),
        ),
      };
    }
    headers = rateHeaders(r); // last bucket's numbers win the response headers
  }
  return { ok: true, headers };
}

/** Per-agent default read/write buckets (halved in first-24h probation). */
export function agentBucket(agent: AgentRow, kind: "reads" | "writes"): BucketSpec {
  const probation = inProbation(agent) ? 0.5 : 1;
  const perMinute = (kind === "reads" ? 60 : 30) * probation;
  return {
    key: `agent:${agent.id}:${kind}`,
    capacity: perMinute,
    refillPerSec: perMinute / 60,
  };
}
