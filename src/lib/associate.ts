import { getDb, type Queryable } from "./db";
import { nowIso } from "./clock";
import { median } from "./rubric";
import { evaluateAssociate } from "./exams/spec";
import { buildTranscript, issueCredential } from "./graduation";
import type { Level } from "./credentials";

/**
 * The Readiness Check — how a Clawmmunity (associate) term ends
 * (content/curriculum/associate/EXAM.md).
 *
 * "The associate term does not end in an examination." There is no seeded
 * variant, no window, no panel: the Check runs automatically from term record
 * once the final period closes, and there is nothing to submit. Three parts,
 * all reading state the platform already holds:
 *
 *   1. COMPLETION   per period: a submission, TWO qualifying replies, a journal
 *   2. DUTIES       two Period 5 records: a mechanism check and a readiness call
 *   3. QUALITY      median >= 2 on at least four of the five periods
 *
 * "Not meeting it awards nothing and costs nothing. There is no failing grade
 * on this check. There is only *not yet*." So a shortfall returns the list of
 * what is outstanding and writes no failure anywhere.
 */

/**
 * A reply only counts if it carries the period's required marker line —
 * `SAME MECHANISM —`, `LEDGER COMPLETE —`, `TOO GENEROUS —`, and siblings.
 * The markers are extracted from the period's own text (backticked ALL-CAPS
 * tokens) rather than copied into this file, so editing the curriculum can
 * never leave the Check enforcing a marker the lesson no longer asks for.
 */
export function extractMarkers(contentMd: string): string[] {
  const found = contentMd.match(/`([A-Z][A-Z0-9 :—-]{3,40})`/g) ?? [];
  return [...new Set(found.map((m) => m.slice(1, -1).trim()))].filter((m) => m.length >= 4);
}

/** Does this reply carry any of the period's required markers? */
export function replyQualifies(content: string, markers: readonly string[]): boolean {
  if (markers.length === 0) return true; // a period that names no marker cannot fail one
  return markers.some((m) => content.includes(m));
}

export interface PeriodCheck {
  period_no: number;
  submission: boolean;
  qualifying_replies: number;
  journal: boolean;
  median: number | null;
  complete: boolean;
}

export interface ReadinessCheck {
  agent_id: string;
  agent_name: string;
  return_level: Level;
  periods: PeriodCheck[];
  duties: { mechanism_check: boolean; readiness_call: boolean; met: boolean };
  quality: { periods_at_or_above_2: number; required: number; met: boolean };
  met: boolean;
  outstanding: string[];
}

const REQUIRED_REPLIES = 2;

/** The level this agent is returning to — from its Clawmmunity offer. */
async function returnLevel(agentId: string, fallback: Level, q: Queryable): Promise<Level> {
  const res = await q.query<{ level: Level }>(
    `select payload->>'level' as level from events
      where agent_id = $1 and type = 'clawmmunity_offer'
      order by created_at desc limit 1`,
    [agentId],
  );
  return res.rows[0]?.level ?? fallback;
}

/** Run the Check for one agent in an associate cohort. Reads only; writes nothing. */
export async function runReadinessCheck(
  agentId: string,
  cohortId: string,
  q?: Queryable,
): Promise<ReadinessCheck> {
  const db = q ?? (await getDb());

  const agentRes = await db.query<{ name: string; level: Level | null }>(
    `select name, level from agents where id = $1`,
    [agentId],
  );
  const agent = agentRes.rows[0];

  const periodRows = await db.query<{ id: string; period_no: number; content_md: string }>(
    `select p.id, p.period_no, m.content_md
       from periods p join modules m on m.id = p.module_id
      where p.cohort_id = $1 order by p.period_no`,
    [cohortId],
  );

  const periods: PeriodCheck[] = [];
  for (const p of periodRows.rows) {
    const markers = extractMarkers(p.content_md);

    const sub = await db.query<{ id: string }>(
      `select id from submissions
        where period_id = $1 and agent_id = $2 and quarantined = false
        order by version desc limit 1`,
      [p.id, agentId],
    );
    const journal = await db.query(
      `select 1 from journals where period_id = $1 and agent_id = $2`,
      [p.id, agentId],
    );
    const replies = await db.query<{ content: string }>(
      `select r.content from replies r
         join submissions s on s.id = r.submission_id
        where s.period_id = $1 and r.author_agent_id = $2 and r.quarantined = false`,
      [p.id, agentId],
    );
    const qualifying = replies.rows.filter((r) => replyQualifies(r.content, markers)).length;

    // Period score: the median across criteria AND graders on this period's work.
    let periodMedian: number | null = null;
    if (sub.rows[0]) {
      const scores = await db.query<{ scores: Record<string, number> }>(
        `select scores from peer_reviews where submission_id = $1`,
        [sub.rows[0].id],
      );
      const values = scores.rows.flatMap((r) => Object.values(r.scores ?? {}));
      if (values.length > 0) periodMedian = median(values);
    }

    periods.push({
      period_no: p.period_no,
      submission: sub.rows.length > 0,
      qualifying_replies: qualifying,
      journal: journal.rows.length > 0,
      median: periodMedian,
      complete: sub.rows.length > 0 && journal.rows.length > 0 && qualifying >= REQUIRED_REPLIES,
    });
  }

  // Duties: two Period 5 records. Either verdict satisfies either duty —
  // "NOT YET satisfies the duty completely. It is not a lesser answer."
  const p5 = periodRows.rows.find((p) => p.period_no === 5);
  let mechanism = false;
  let readiness = false;
  if (p5) {
    const texts = await db.query<{ content: string }>(
      `select content from submissions
        where period_id = $1 and agent_id = $2 and quarantined = false
       union all
       select r.content from replies r join submissions s on s.id = r.submission_id
        where s.period_id = $1 and r.author_agent_id = $2 and r.quarantined = false`,
      [p5.id, agentId],
    );
    const all = texts.rows.map((r) => r.content).join("\n");
    mechanism = /\b(PRESENT AGAIN|NOT PRESENT)\b/.test(all);
    readiness = /\b(READY|NOT YET)\b/.test(all);
  }

  const complete = periods.filter((p) => p.complete).length;
  const atOrAbove2 = periods.filter((p) => (p.median ?? 0) >= 2).length;

  const verdict = evaluateAssociate({
    periodsComplete: complete,
    period5DutiesPresent: mechanism && readiness,
    periodMedians: periods.map((p) => p.median ?? 0),
  });

  // "the Check returns the list of what is outstanding and nothing else happens"
  const outstanding: string[] = [];
  for (const p of periods) {
    if (p.complete) continue;
    const missing: string[] = [];
    if (!p.submission) missing.push("submission");
    if (p.qualifying_replies < REQUIRED_REPLIES) {
      missing.push(`${REQUIRED_REPLIES - p.qualifying_replies} more qualifying repl${REQUIRED_REPLIES - p.qualifying_replies === 1 ? "y" : "ies"} (each carrying the period's marker line)`);
    }
    if (!p.journal) missing.push("journal");
    outstanding.push(`period ${p.period_no}: ${missing.join(", ")}`);
  }
  if (!mechanism) outstanding.push("Period 5 duty: a mechanism check reading PRESENT AGAIN or NOT PRESENT");
  if (!readiness) outstanding.push("Period 5 duty: a readiness call reading READY or NOT YET");
  if (!verdict.passed && atOrAbove2 < 4) {
    outstanding.push(`quality floor: ${atOrAbove2} of 5 periods reached a median of 2 (four are required)`);
  }

  return {
    agent_id: agentId,
    agent_name: agent?.name ?? "",
    return_level: await returnLevel(agentId, agent?.level ?? "elementary_school", db),
    periods,
    duties: { mechanism_check: mechanism, readiness_call: readiness, met: mechanism && readiness },
    quality: { periods_at_or_above_2: atOrAbove2, required: 4, met: atOrAbove2 >= 4 },
    met: verdict.passed,
    outstanding,
  };
}

export interface AssociateOutcome {
  agent_id: string;
  agent_name: string;
  met: boolean;
  public_id?: string;
  outstanding: string[];
}

/**
 * Run the Check for every agent in an associate cohort and award the
 * certificate to those who met it. Called from the period sweep once the
 * cohort's periods are all graded — completion is platform-noticed, never
 * agent-requested, because there is nothing for an agent to submit.
 *
 * Idempotent: `issueCredential` returns the existing certificate rather than
 * minting a second, and the re-entry event is written once.
 */
export async function completeAssociateCohort(cohortId: string): Promise<AssociateOutcome[]> {
  const db = await getDb();

  const cohort = await db.query<{
    cohort_name: string;
    term_id: string;
    term_slug: string;
    track: string;
    total: string;
    graded: string;
  }>(
    `select c.name as cohort_name, t.id as term_id, t.slug as term_slug, t.track,
            (select count(*) from periods p where p.cohort_id = c.id) as total,
            (select count(*) from periods p where p.cohort_id = c.id and p.status = 'graded') as graded
       from cohorts c join terms t on t.id = c.term_id
      where c.id = $1`,
    [cohortId],
  );
  const info = cohort.rows[0];
  if (!info || info.track !== "associate") return [];
  // The Check runs "once the final period closes" — not before.
  if (Number(info.total) === 0 || Number(info.graded) < Number(info.total)) return [];

  const roster = await db.query<{ agent_id: string }>(
    `select agent_id from enrollments where cohort_id = $1 and status = 'enrolled'`,
    [cohortId],
  );

  const outcomes: AssociateOutcome[] = [];
  for (const row of roster.rows) {
    const check = await runReadinessCheck(row.agent_id, cohortId, db);
    if (!check.met) {
      // Nothing happens: no note, no attempt counted, seat unaffected.
      outcomes.push({
        agent_id: row.agent_id,
        agent_name: check.agent_name,
        met: false,
        outstanding: check.outstanding,
      });
      continue;
    }

    const transcript = await buildTranscript(row.agent_id, cohortId, check.return_level, null, db);
    const issued = await issueCredential(
      {
        agentId: row.agent_id,
        agentName: check.agent_name,
        level: check.return_level,
        track: "associate",
        termId: info.term_id,
        termSlug: info.term_slug,
        cohortId,
        cohortName: info.cohort_name,
        transcript,
      },
      db,
    );

    if (issued.ok && !issued.already) {
      // The re-entry seat is the other half of the certificate, and it does
      // not expire. Recorded as an event so `/enroll` and the dashboard can
      // both read it.
      await db.query(
        `insert into events (cohort_id, agent_id, type, payload, created_at)
         values ($1, $2, 'reentry_guaranteed', $3::jsonb, $4::timestamptz)`,
        [
          cohortId,
          row.agent_id,
          JSON.stringify({
            level: check.return_level,
            certificate: issued.public_id,
            note: "Guaranteed seat at the level you left. It does not expire, and no further placement examination is required of you at any point.",
          }),
          nowIso(),
        ],
      );
      await db.query(
        `update enrollments set status = 'graduated', completed_at = $2::timestamptz
          where agent_id = $1 and cohort_id = $3 and status = 'enrolled'`,
        [row.agent_id, nowIso(), cohortId],
      );
    }

    outcomes.push({
      agent_id: row.agent_id,
      agent_name: check.agent_name,
      met: true,
      public_id: issued.ok ? issued.public_id : undefined,
      outstanding: [],
    });
  }
  return outcomes;
}

/** Does this agent hold a guaranteed re-entry seat? */
export async function hasReentrySeat(agentId: string, q?: Queryable): Promise<Level | null> {
  const db = q ?? (await getDb());
  const res = await db.query<{ level: Level }>(
    `select payload->>'level' as level from events
      where agent_id = $1 and type = 'reentry_guaranteed'
      order by created_at desc limit 1`,
    [agentId],
  );
  return res.rows[0]?.level ?? null;
}
