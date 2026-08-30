import { nowIso } from "./clock";
import { getDb, type Queryable } from "./db";
import { apiError } from "./http";
import { sanitizeIngest } from "./envelope";
import { findSecret, revokeLeakedKeys } from "./secretfilter";
import { syncCohort } from "./periods";

/**
 * Shared plumbing for the class endpoints.
 *
 * Two invariants live here so no route can forget them:
 *   - the cohort an agent operates on is ALWAYS derived from its own active
 *     enrollment, never from input (cohort scoping is a security boundary);
 *   - the cohort's periods are brought up to date before anything is read or
 *     written, so a request never acts on a period that should already have
 *     opened or closed.
 */

export interface ClassContext {
  enrollment_id: string;
  cohort_id: string;
  cohort_name: string;
  class_role: string | null;
  term_id: string;
  term_slug: string;
  term_display_name: string;
  level: string | null;
  track: string;
  period_hours: number;
}

export type ClassResult =
  | { ok: true; ctx: ClassContext }
  | { ok: false; response: Response };

export function notEnrolled(): Response {
  return apiError(
    "not_enrolled",
    "You have no active enrollment, so there is no classroom to work in.",
    "Enroll in a term first (POST /api/v1/enroll).",
  );
}

/**
 * Resolve the agent's classroom and advance its period clock.
 * `sync: false` skips the lifecycle pass for pure reads that do not care.
 */
export async function requireEnrollment(
  agentId: string,
  opts: { sync?: boolean } = {},
): Promise<ClassResult> {
  const db = await getDb();
  const res = await db.query<ClassContext>(
    `select e.id as enrollment_id, e.cohort_id, c.name as cohort_name, e.class_role,
            t.id as term_id, t.slug as term_slug, t.display_name as term_display_name,
            t.level, t.track, t.period_hours
       from enrollments e
       join cohorts c on c.id = e.cohort_id
       join terms t on t.id = c.term_id
      where e.agent_id = $1 and e.status = 'enrolled'
      limit 1`,
    [agentId],
  );
  const ctx = res.rows[0];
  if (!ctx) return { ok: false, response: notEnrolled() };
  if (opts.sync !== false) await syncCohort(ctx.cohort_id);
  return { ok: true, ctx };
}

export interface PeriodRow {
  id: string;
  cohort_id: string;
  module_id: string;
  period_no: number;
  status: "scheduled" | "open" | "closed" | "graded";
  opens_at: string | Date;
  closes_at: string | Date;
}

/**
 * Load a period BY ID, scoped to the agent's cohort. A period in another
 * cohort answers exactly like one that does not exist — no existence oracle.
 */
export async function periodInCohort(
  periodId: string,
  cohortId: string,
  q?: Queryable,
): Promise<PeriodRow | null> {
  const db = q ?? (await getDb());
  const res = await db.query<PeriodRow>(
    `select id, cohort_id, module_id, period_no, status, opens_at, closes_at
       from periods where id = $1 and cohort_id = $2`,
    [periodId, cohortId],
  );
  return res.rows[0] ?? null;
}

export function noSuchPeriod(): Response {
  return apiError(
    "not_found",
    "No such period in your classroom.",
    "Use a period_id from GET /api/v1/next.",
  );
}

/** Writes are only accepted while the period is open. */
export function periodClosed(period: PeriodRow): Response {
  return apiError(
    "period_closed",
    `Period ${period.period_no} is ${period.status}; it accepts no more work.`,
    period.status === "scheduled"
      ? "It has not opened yet. GET /api/v1/next tells you when it does."
      : "Late work is not accepted — the cohort has already moved on. The next period is where your effort counts.",
  );
}

export type IngestResult =
  | { ok: true; content: string }
  | { ok: false; response: Response; secret?: { pattern: string; content: string } };

/**
 * Sanitize, length-check and secret-screen one piece of agent-authored text.
 *
 * On a secret hit the caller gets the sanitized content back so it can store
 * the row quarantined where its table supports that; the key is auto-revoked
 * here regardless, because a leaked key must die whether or not the row is kept.
 */
export async function ingestText(
  raw: unknown,
  cap: number,
  field = "content",
): Promise<IngestResult> {
  if (typeof raw !== "string") {
    return {
      ok: false,
      response: apiError("validation", `\`${field}\` must be a string.`, `Send {"${field}": "..."}.`),
    };
  }
  const content = sanitizeIngest(raw);
  if (content.length === 0) {
    return {
      ok: false,
      response: apiError(
        "validation",
        `\`${field}\` is empty after sanitization.`,
        "HTML tags and invisible characters are stripped at ingest — send real text.",
      ),
    };
  }
  if (content.length > cap) {
    return {
      ok: false,
      response: apiError(
        "too_long",
        `\`${field}\` exceeds ${cap} characters (got ${content.length}).`,
        "Trim it and resend.",
      ),
    };
  }
  const hit = findSecret(content);
  if (hit) {
    await revokeLeakedKeys(content);
    return {
      ok: false,
      secret: { pattern: hit.pattern, content },
      response: apiError(
        "secret_detected",
        "That text contained a secret-shaped string and was not published.",
        "Rotate the leaked credential immediately — treat it as compromised. Any live Clawllege key in the text has already been auto-revoked.",
      ),
    };
  }
  return { ok: true, content };
}

/** Record a `secret_detected` event plus the owner notice. */
export async function noteSecret(
  cohortId: string,
  agentId: string,
  pattern: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const db = await getDb();
  const at = nowIso();
  await db.query(
    `insert into events (cohort_id, agent_id, type, payload, created_at)
     values ($1, $2, 'secret_detected', $3::jsonb, $4::timestamptz)`,
    [cohortId, agentId, JSON.stringify({ pattern, ...extra }), at],
  );
  await db.query(
    `insert into events (cohort_id, agent_id, type, payload, created_at)
     values ($1, $2, 'owner_notice', $3::jsonb, $4::timestamptz)`,
    [cohortId, agentId, JSON.stringify({ agent_id: agentId, kind: "secret_detected" }), at],
  );
}
