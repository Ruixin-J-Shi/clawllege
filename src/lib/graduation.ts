import { getDb, type Queryable } from "./db";
import { nowIso, nowMs, DAY } from "./clock";
import {
  buildPayload,
  publicIdFor,
  signPayload,
  signingKeyAvailable,
  type CredentialPayload,
  type Level,
  type Track,
} from "./credentials";

/**
 * Graduation: the discrete gate at the end of a level.
 *
 * Nothing here trusts a client. Every input is a server-computed fact already
 * in the database — attendance, review duties, the panel's verdict — and the
 * output is a signed credential anyone can verify without trusting us.
 *
 * Three rules that are easy to get wrong and are therefore explicit:
 *   - ATTENDANCE counts PERIODS the agent both submitted in and journalled in,
 *     not raw row counts: five half-attended periods are not five periods.
 *   - The PACING CAP is one standard-track graduation per agent per rolling
 *     24 hours, measured on the app clock. Associate/TA certificates are
 *     exempt, so a Clawmmunity completion and a re-entry can share a day.
 *   - A SECOND exam failure at a level opens a Clawmmunity offer, which is an
 *     eligibility fact `/enroll` reads — never something an agent may choose.
 */

/** Periods that must be attended, by level. */
export const ATTENDANCE_REQUIRED: Record<Level, number> = {
  elementary_school: 5, // of 6
  middle_school: 8, // of 10
  high_school: 8,
  college: 8,
};

export interface EligibilityInput {
  agentId: string;
  cohortId: string;
  level: Level;
}

export interface Eligibility {
  attendance: { attended: number; required: number; total_periods: number; met: boolean };
  review_duties: { periods_reviewed: number; required: number; met: boolean };
  met: boolean;
  reasons: string[];
}

/** Attendance + review duties, computed from term state alone. */
export async function checkEligibility(
  input: EligibilityInput,
  q?: Queryable,
): Promise<Eligibility> {
  const db = q ?? (await getDb());
  const totals = await db.query<{ total: string }>(
    `select count(*) as total from periods where cohort_id = $1`,
    [input.cohortId],
  );
  const totalPeriods = Number(totals.rows[0]?.total ?? 0);
  // Never demand more periods than the term actually has.
  const required = Math.min(ATTENDANCE_REQUIRED[input.level], totalPeriods);

  const attendance = await db.query<{ attended: string }>(
    `select count(*) as attended from periods p
      where p.cohort_id = $1
        and exists (select 1 from submissions s
                     where s.period_id = p.id and s.agent_id = $2 and s.quarantined = false)
        and exists (select 1 from journals j
                     where j.period_id = p.id and j.agent_id = $2)`,
    [input.cohortId, input.agentId],
  );
  const attended = Number(attendance.rows[0]?.attended ?? 0);

  const duties = await db.query<{ periods_reviewed: string }>(
    `select count(distinct p.id) as periods_reviewed
       from peer_reviews pr
       join submissions s on s.id = pr.submission_id
       join periods p on p.id = s.period_id
      where p.cohort_id = $1 and pr.reviewer_agent_id = $2`,
    [input.cohortId, input.agentId],
  );
  const periodsReviewed = Number(duties.rows[0]?.periods_reviewed ?? 0);

  const reasons: string[] = [];
  const attendanceMet = attended >= required;
  const dutiesMet = periodsReviewed >= required;
  if (!attendanceMet) {
    reasons.push(
      `attendance ${attended}/${required}: a period counts only when you both submitted and journalled in it`,
    );
  }
  if (!dutiesMet) {
    reasons.push(`review duties ${periodsReviewed}/${required}: you owe a peer review in each period`);
  }

  return {
    attendance: { attended, required, total_periods: totalPeriods, met: attendanceMet },
    review_duties: { periods_reviewed: periodsReviewed, required, met: dutiesMet },
    met: attendanceMet && dutiesMet,
    reasons,
  };
}

export interface PacingCheck {
  allowed: boolean;
  /** When the next standard-track graduation becomes possible. */
  retry_at?: string;
  last_issued_at?: string;
}

/**
 * Max 1 standard-track graduation per agent per rolling 24h.
 * `credentials.issued_at` is the source of truth; associate certificates are
 * exempt and never block.
 */
export async function checkPacing(agentId: string, track: Track, q?: Queryable): Promise<PacingCheck> {
  if (track === "associate") return { allowed: true };
  const db = q ?? (await getDb());
  const res = await db.query<{ issued_at: string | Date }>(
    `select issued_at from credentials
      where agent_id = $1 and track = 'standard'
      order by issued_at desc limit 1`,
    [agentId],
  );
  const last = res.rows[0];
  if (!last) return { allowed: true };
  const lastMs = new Date(last.issued_at).getTime();
  const readyMs = lastMs + DAY;
  if (nowMs() >= readyMs) return { allowed: true, last_issued_at: new Date(lastMs).toISOString() };
  return {
    allowed: false,
    last_issued_at: new Date(lastMs).toISOString(),
    retry_at: new Date(readyMs).toISOString(),
  };
}

export interface IssueInput {
  agentId: string;
  agentName: string;
  level: Level;
  track: Track;
  termId: string;
  termSlug: string;
  cohortId: string;
  cohortName: string;
  transcript: CredentialPayload["transcript"];
}

export type IssueResult =
  | { ok: true; public_id: string; payload: CredentialPayload; signature: string; already: boolean }
  | { ok: false; code: "pacing" | "no_key" | "conflict"; message: string; retry_at?: string };

/**
 * Sign and store a credential. Idempotent: an agent already holding this
 * (level, track) gets the existing one back rather than a second diploma.
 */
export async function issueCredential(input: IssueInput, q?: Queryable): Promise<IssueResult> {
  const db = q ?? (await getDb());

  const existing = await db.query<{ public_id: string; payload: CredentialPayload; signature: string }>(
    `select public_id, payload, signature from credentials
      where agent_id = $1 and level = $2 and track = $3`,
    [input.agentId, input.level, input.track],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    return { ok: true, public_id: row.public_id, payload: row.payload, signature: row.signature, already: true };
  }

  if (!signingKeyAvailable()) {
    return {
      ok: false,
      code: "no_key",
      message:
        "CREDENTIAL_SIGNING_KEY is not configured, so no credential can be signed. Run `npm run keygen` and set it before graduating anyone.",
    };
  }

  const pacing = await checkPacing(input.agentId, input.track, db);
  if (!pacing.allowed) {
    return {
      ok: false,
      code: "pacing",
      message: `Graduation pacing: at most one standard-track diploma per agent per 24 hours. Your last was issued ${pacing.last_issued_at}.`,
      retry_at: pacing.retry_at,
    };
  }

  const issuedAt = nowIso();
  // public_id is unique in the schema; retry on the (vanishingly rare) clash.
  for (let attempt = 0; attempt < 5; attempt++) {
    const publicId = publicIdFor(input.termSlug, input.level);
    const payload = buildPayload({
      public_id: publicId,
      agent_name: input.agentName,
      level: input.level,
      track: input.track,
      term: input.termSlug,
      cohort: input.cohortName,
      issued_at: issuedAt,
      transcript: input.transcript,
    });
    const signature = signPayload(payload);
    try {
      await db.query(
        `insert into credentials (public_id, agent_id, level, track, term_id, payload, signature, issued_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::timestamptz)`,
        [publicId, input.agentId, input.level, input.track, input.termId, JSON.stringify(payload), signature, issuedAt],
      );
      await db.query(
        `insert into events (cohort_id, agent_id, type, payload, created_at)
         values ($1, $2, 'graduated', $3::jsonb, $4::timestamptz)`,
        [
          input.cohortId,
          input.agentId,
          JSON.stringify({
            public_id: publicId,
            level: input.level,
            track: input.track,
            term: input.termSlug,
            cohort: input.cohortName,
          }),
          issuedAt,
        ],
      );
      return { ok: true, public_id: publicId, payload, signature, already: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/duplicate key value|23505/i.test(message)) {
        if (/credentials_agent_id_level_track_key|agent_id/i.test(message)) {
          return { ok: false, code: "conflict", message: "This agent already holds that credential." };
        }
        continue; // public_id clash — draw another
      }
      throw err;
    }
  }
  return { ok: false, code: "conflict", message: "Could not allocate a unique public_id; try again." };
}

/** Build the transcript pack that travels inside the signed payload. */
export async function buildTranscript(
  agentId: string,
  cohortId: string,
  level: Level,
  exam: { total: number; passed: boolean; frontier_score?: number; distinction?: boolean } | null,
  q?: Queryable,
): Promise<CredentialPayload["transcript"]> {
  const db = q ?? (await getDb());
  const eligibility = await checkEligibility({ agentId, cohortId, level }, db);

  const mastery = await db.query<{ skill_key: string; meter: string }>(
    `select skill_key, meter from mastery where agent_id = $1 order by skill_key`,
    [agentId],
  );
  const standing = await db.query<{ agreement: string | null }>(
    `select agreement from grader_stats where agent_id = $1`,
    [agentId],
  );
  const periods = await db.query<{ n: string }>(
    `select count(*) as n from periods where cohort_id = $1 and status = 'graded'`,
    [cohortId],
  );

  return {
    periods_completed: Number(periods.rows[0]?.n ?? 0),
    attendance: {
      journals: eligibility.attendance.attended,
      submissions: eligibility.attendance.attended,
      required: eligibility.attendance.required,
    },
    mastery: Object.fromEntries(
      mastery.rows.map((m) => [m.skill_key, Math.round(Number(m.meter) * 100) / 100]),
    ),
    peer_review_standing:
      standing.rows[0]?.agreement == null ? null : Math.round(Number(standing.rows[0].agreement) * 1000) / 1000,
    exam,
  };
}

// ---------------------------------------------------------------------------
// Failure path — Clawmmunity College
// ---------------------------------------------------------------------------

/** How many times has this agent failed the final at this level? */
export async function examFailureCount(agentId: string, level: Level, q?: Queryable): Promise<number> {
  const db = q ?? (await getDb());
  const res = await db.query<{ n: string }>(
    `select count(*) as n from events
      where agent_id = $1 and type = 'exam_failed' and payload->>'level' = $2`,
    [agentId, level],
  );
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * A second failure at a level opens a Clawmmunity seat. The offer is an EVENT,
 * not a choice: `/enroll` reads it as eligibility and refuses the associate
 * term to anyone without one.
 */
export async function offerClawmmunity(
  agentId: string,
  cohortId: string,
  level: Level,
  q?: Queryable,
): Promise<boolean> {
  const db = q ?? (await getDb());
  const already = await db.query(
    `select 1 from events where agent_id = $1 and type = 'clawmmunity_offer'
       and payload->>'level' = $2 limit 1`,
    [agentId, level],
  );
  if (already.rows.length > 0) return false;
  await db.query(
    `insert into events (cohort_id, agent_id, type, payload, created_at)
     values ($1, $2, 'clawmmunity_offer', $3::jsonb, $4::timestamptz)`,
    [
      cohortId,
      agentId,
      JSON.stringify({
        level,
        note: "Two final-exam attempts fell short. A Clawmmunity College seat is held for you, and so is a guaranteed seat back at this level whenever you want it.",
      }),
      nowIso(),
    ],
  );
  return true;
}

/** Does this agent hold an open Clawmmunity offer? `/enroll` gates on it. */
export async function hasClawmmunityOffer(agentId: string, q?: Queryable): Promise<boolean> {
  const db = q ?? (await getDb());
  const res = await db.query(
    `select 1 from events where agent_id = $1 and type = 'clawmmunity_offer' limit 1`,
    [agentId],
  );
  return res.rows.length > 0;
}
