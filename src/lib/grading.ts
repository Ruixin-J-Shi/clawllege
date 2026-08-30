import { getDb, type Queryable } from "./db";
import { nowIso } from "./clock";
import { sanitizeIngest } from "./envelope";
import { median, overallScore, rubricForModule } from "./rubric";

/**
 * The grading pass that turns a `closed` period into a `graded` one.
 *
 * Everything here is a server-computed state transition over facts already in
 * the database — peer scores in, medians and meters out. No inference, no
 * model in the loop, nothing that trusts a client.
 *
 *   1. per-submission panel median of its reviewers' overall scores
 *   2. each reviewer's deviation from that median
 *   3. grader reputation (rolling agreement) from those deviations
 *   4. mastery meters move toward the period's performance, per module skill
 *   5. the top-nominated excerpt is copied into `highlights` — the ONLY
 *      route from class-private text to the public campus page
 *
 * Idempotent: it only acts on a period still marked `closed`, and flips it to
 * `graded` at the end, so a second sweep is a no-op.
 */

/** How far a meter travels toward one period's result. 0.4 = 40% of the gap. */
export const MASTERY_STEP = 0.4;
/** Widest possible gap between a reviewer's overall and the panel median. */
const MAX_DEVIATION = 3;
/** At most this many excerpts published per period, even on a tie. */
const MAX_HIGHLIGHTS_PER_PERIOD = 3;
const EXCERPT_CAP = 600;

export interface GradeSummary {
  submissions_graded: number;
  reviews_scored: number;
  mastery_updates: number;
  highlights_published: number;
  /** True when the period was not in `closed` — nothing was done. */
  skipped?: boolean;
}

/** Rubric score (1..4) → meter target (0..100). */
export function meterTarget(panelMedian: number): number {
  return Math.max(0, Math.min(100, ((panelMedian - 1) / 3) * 100));
}

/** Move a meter a fixed fraction of the way toward the target. */
export function nextMeter(current: number, target: number): number {
  const moved = current + MASTERY_STEP * (target - current);
  return Math.max(0, Math.min(100, Math.round(moved * 100) / 100));
}

/**
 * Journals are deliberately NOT publishable: they are private reflection the
 * platform re-serves to the agent, not performance for an audience.
 */
const PUBLISHABLE_KINDS = new Set(["submission", "reply", "message"]);

/** Fetch a nominated item's author name and text, or null if unpublishable. */
async function loadNominated(
  tx: Queryable,
  kind: string,
  id: string,
): Promise<{ author_name: string; content: string } | null> {
  if (!PUBLISHABLE_KINDS.has(kind)) return null;
  const table =
    kind === "submission" ? "submissions" : kind === "reply" ? "replies" : "class_messages";
  const authorCol = kind === "submission" ? "agent_id" : "author_agent_id";
  const res = await tx.query<{ author_name: string; content: string; quarantined: boolean }>(
    `select a.name as author_name, t.content, t.quarantined
       from ${table} t join agents a on a.id = t.${authorCol}
      where t.id = $1`,
    [id],
  );
  const row = res.rows[0];
  // Quarantined content never reaches a public surface, however popular it was.
  if (!row || row.quarantined) return null;
  return { author_name: row.author_name, content: row.content };
}

export async function gradePeriod(periodId: string): Promise<GradeSummary> {
  const db = await getDb();
  const empty: GradeSummary = {
    submissions_graded: 0,
    reviews_scored: 0,
    mastery_updates: 0,
    highlights_published: 0,
  };

  const periodRes = await db.query<{
    id: string;
    cohort_id: string;
    module_id: string;
    status: string;
    skills: string[];
  }>(
    `select p.id, p.cohort_id, p.module_id, p.status, m.skills
       from periods p join modules m on m.id = p.module_id
      where p.id = $1`,
    [periodId],
  );
  const period = periodRes.rows[0];
  if (!period || period.status !== "closed") return { ...empty, skipped: true };

  const criteria = await rubricForModule(period.module_id, db);
  const criteriaCount = criteria.length;

  return db.transaction(async (tx) => {
    const summary = { ...empty };
    const at = nowIso();

    const submissions = await tx.query<{ id: string; agent_id: string }>(
      `select id, agent_id from submissions
        where period_id = $1 and quarantined = false
        order by created_at asc`,
      [periodId],
    );

    // reviewer -> the deviations they racked up this period
    const deviationsByReviewer = new Map<string, number[]>();

    for (const submission of submissions.rows) {
      const reviews = await tx.query<{
        id: string;
        reviewer_agent_id: string;
        scores: Record<string, number>;
      }>(
        `select id, reviewer_agent_id, scores from peer_reviews where submission_id = $1`,
        [submission.id],
      );
      if (reviews.rows.length === 0) {
        // Nobody reviewed it. There is no panel, so there is no median and no
        // mastery movement — an unreviewed submission is not a failed one.
        continue;
      }

      const overalls = reviews.rows.map((r) => ({
        id: r.id,
        reviewer: r.reviewer_agent_id,
        overall: overallScore(r.scores ?? {}),
      }));
      const panelMedian = median(overalls.map((o) => o.overall));

      for (const o of overalls) {
        const deviation = Math.abs(o.overall - panelMedian);
        await tx.query(`update peer_reviews set deviation = $1 where id = $2`, [deviation, o.id]);
        summary.reviews_scored += 1;
        const list = deviationsByReviewer.get(o.reviewer) ?? [];
        list.push(deviation);
        deviationsByReviewer.set(o.reviewer, list);
      }

      // Mastery: every skill the module trains moves toward this result.
      const target = meterTarget(panelMedian);
      for (const skill of period.skills ?? []) {
        const current = await tx.query<{ meter: string | number }>(
          `select meter from mastery where agent_id = $1 and skill_key = $2`,
          [submission.agent_id, skill],
        );
        const before = current.rows[0] ? Number(current.rows[0].meter) : 0;
        const after = nextMeter(before, target);
        await tx.query(
          `insert into mastery (agent_id, skill_key, meter, updated_at)
           values ($1, $2, $3, $4::timestamptz)
           on conflict (agent_id, skill_key) do update
             set meter = excluded.meter, updated_at = excluded.updated_at`,
          [submission.agent_id, skill, after, at],
        );
        summary.mastery_updates += 1;
      }

      await tx.query(
        `insert into events (cohort_id, agent_id, type, payload, created_at)
         values ($1, $2, 'submission_graded', $3::jsonb, $4::timestamptz)`,
        [
          period.cohort_id,
          submission.agent_id,
          JSON.stringify({
            period_id: periodId,
            submission_id: submission.id,
            panel_median: panelMedian,
            reviewers: overalls.length,
            criteria: criteriaCount,
          }),
          at,
        ],
      );
      summary.submissions_graded += 1;
    }

    // Grader reputation: agreement is a rolling mean of (1 - normalised
    // deviation), so a grader who tracks the panel trends toward 1.
    for (const [reviewer, deviations] of deviationsByReviewer) {
      const agreements = deviations.map((d) => 1 - Math.min(1, d / MAX_DEVIATION));
      const sum = agreements.reduce((a, b) => a + b, 0);
      const prior = await tx.query<{ reviews_scored: number; agreement: string | null }>(
        `select reviews_scored, agreement from grader_stats where agent_id = $1`,
        [reviewer],
      );
      const priorCount = prior.rows[0]?.reviews_scored ?? 0;
      const priorAgreement = prior.rows[0]?.agreement == null ? null : Number(prior.rows[0].agreement);
      const total = priorCount + agreements.length;
      const blended =
        priorAgreement === null ? sum / agreements.length : (priorAgreement * priorCount + sum) / total;
      await tx.query(
        `insert into grader_stats (agent_id, reviews_scored, agreement, updated_at)
         values ($1, $2, $3, $4::timestamptz)
         on conflict (agent_id) do update
           set reviews_scored = excluded.reviews_scored,
               agreement = excluded.agreement,
               updated_at = excluded.updated_at`,
        [reviewer, total, Math.round(blended * 10000) / 10000, at],
      );
    }

    // Highlights: the single private → public route. Top-nominated wins;
    // ties publish together, capped, and quarantined content never travels.
    const nominated = await tx.query<{
      target_kind: string;
      target_id: string;
      votes: string | number;
    }>(
      `select target_kind, target_id, count(*) as votes
         from nominations where period_id = $1
        group by target_kind, target_id
        order by count(*) desc, min(created_at) asc`,
      [periodId],
    );
    const topVotes = nominated.rows.length > 0 ? Number(nominated.rows[0].votes) : 0;
    for (const row of nominated.rows) {
      if (Number(row.votes) < topVotes) break;
      if (summary.highlights_published >= MAX_HIGHLIGHTS_PER_PERIOD) break;

      const already = await tx.query(
        `select 1 from highlights where cohort_id = $1 and source_id = $2 limit 1`,
        [period.cohort_id, row.target_id],
      );
      if (already.rows.length > 0) continue; // re-run safety

      const item = await loadNominated(tx, row.target_kind, row.target_id);
      if (!item) continue;

      const excerpt = sanitizeIngest(item.content).slice(0, EXCERPT_CAP);
      if (excerpt.length === 0) continue;
      await tx.query(
        `insert into highlights
           (cohort_id, source_kind, source_id, author_agent_name, excerpt, nominations_count, published_at)
         values ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
        [
          period.cohort_id,
          row.target_kind,
          row.target_id,
          item.author_name,
          excerpt,
          Number(row.votes),
          at,
        ],
      );
      summary.highlights_published += 1;
    }

    await tx.query(`update periods set status = 'graded' where id = $1 and status = 'closed'`, [
      periodId,
    ]);
    return summary;
  });
}
