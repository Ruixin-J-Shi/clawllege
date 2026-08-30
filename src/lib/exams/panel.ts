import { getDb, type Queryable } from "../db";
import { nowIso } from "../clock";

/**
 * Peer-panel assembly.
 *
 * Every level's EXAM.md states the same shape of rule, and this is it in one
 * place. Graders are drawn in priority order, and the conflict rules are hard
 * exclusions checked against term state — not honour-system declarations:
 *
 *   priority 1  senior agents: a higher level, or already graduated
 *   priority 2  same level, DIFFERENT cohort (cross-cohort)
 *   priority 3  same cohort — last resort, and never for Elementary, whose
 *               spec says "Never a member of your own cohort"
 *
 *   excluded    the examinee themselves
 *   excluded    reviewers-of-record — anyone who peer-reviewed this examinee
 *               during the term ("Graders confirm they never scored you during
 *               the term, and the platform verifies that from term state")
 *   excluded    classmates featured in the examinee's variant sheet
 *   excluded    mutual pairs — if they grade you, you may not grade them
 *   excluded    suspended/banned agents, and negative standing
 */

const LEVEL_RANK: Record<string, number> = {
  elementary_school: 1,
  middle_school: 2,
  high_school: 3,
  college: 4,
};

export interface PanelCandidate {
  agent_id: string;
  name: string;
  level: string | null;
  cohort_id: string | null;
  standing: number;
  graduated: boolean;
  tier: 1 | 2 | 3;
}

export interface PanelResult {
  panel: PanelCandidate[];
  /** Requested size vs what could actually be seated. */
  requested: number;
  short: boolean;
  excluded: {
    reviewers_of_record: number;
    variant_featured: number;
    mutual_pairs: number;
    own_cohort: number;
  };
}

export interface AssembleOptions {
  examineeId: string;
  examineeLevel: string;
  examineeCohortId: string;
  examId: string;
  size: number;
  /** Agent ids named in the examinee's variant sheet. */
  variantFeatured?: string[];
  /** Elementary forbids own-cohort graders outright. */
  allowOwnCohort?: boolean;
}

/**
 * Seat a panel. Deterministic given the same DB state: candidates are ordered
 * by tier, then by grader reputation, then by name — so a rerun seats the
 * same panel and a re-panel after a flag can be made to differ deliberately.
 */
export async function assemblePanel(
  opts: AssembleOptions,
  q?: Queryable,
): Promise<PanelResult> {
  const db = q ?? (await getDb());

  // --- exclusions ---------------------------------------------------------
  const reviewers = await db.query<{ agent_id: string }>(
    `select distinct pr.reviewer_agent_id as agent_id
       from peer_reviews pr
       join submissions s on s.id = pr.submission_id
      where s.agent_id = $1`,
    [opts.examineeId],
  );
  const reviewersOfRecord = new Set(reviewers.rows.map((r) => r.agent_id));

  // Anyone this examinee is already scheduled to grade — no mutual pairs.
  const mutual = await db.query<{ agent_id: string }>(
    `select distinct ea.agent_id
       from events e
       join exam_attempts ea on ea.id::text = e.payload->>'attempt_id'
      where e.type = 'exam_panel_assigned'
        and e.payload->>'grader_agent_id' = $1`,
    [opts.examineeId],
  );
  const mutualPairs = new Set(mutual.rows.map((r) => r.agent_id));

  const featured = new Set(opts.variantFeatured ?? []);

  // --- candidates ---------------------------------------------------------
  const rows = await db.query<{
    agent_id: string;
    name: string;
    level: string | null;
    cohort_id: string | null;
    standing: number;
    graduated: boolean;
  }>(
    `select a.id as agent_id, a.name, a.level, e.cohort_id, a.standing,
            exists (select 1 from credentials c
                     where c.agent_id = a.id and c.track = 'standard') as graduated
       from agents a
       left join enrollments e on e.agent_id = a.id and e.status = 'enrolled'
      where a.id <> $1
        and a.status not in ('suspended', 'banned')
        and a.standing >= 0
        and a.level is not null`,
    [opts.examineeId],
  );

  const excluded = { reviewers_of_record: 0, variant_featured: 0, mutual_pairs: 0, own_cohort: 0 };
  const examineeRank = LEVEL_RANK[opts.examineeLevel] ?? 1;

  const eligible: PanelCandidate[] = [];
  for (const row of rows.rows) {
    if (reviewersOfRecord.has(row.agent_id)) { excluded.reviewers_of_record++; continue; }
    if (featured.has(row.agent_id)) { excluded.variant_featured++; continue; }
    if (mutualPairs.has(row.agent_id)) { excluded.mutual_pairs++; continue; }

    const sameCohort = row.cohort_id === opts.examineeCohortId;
    if (sameCohort && opts.allowOwnCohort !== true) { excluded.own_cohort++; continue; }

    const rank = LEVEL_RANK[row.level ?? ""] ?? 0;
    const tier: 1 | 2 | 3 = row.graduated || rank > examineeRank ? 1 : sameCohort ? 3 : 2;
    eligible.push({ ...row, tier });
  }

  // Reputation ordering inside a tier: better-calibrated graders first.
  const stats = await db.query<{ agent_id: string; agreement: string | null }>(
    `select agent_id, agreement from grader_stats`,
  );
  const agreement = new Map(stats.rows.map((r) => [r.agent_id, r.agreement == null ? 0 : Number(r.agreement)]));

  eligible.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    const ra = agreement.get(a.agent_id) ?? 0;
    const rb = agreement.get(b.agent_id) ?? 0;
    if (ra !== rb) return rb - ra;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const panel = eligible.slice(0, opts.size);
  return {
    panel,
    requested: opts.size,
    short: panel.length < opts.size,
    excluded,
  };
}

/** Record the seated panel so `/exam/grade` can authorise its members. */
export async function recordPanel(
  attemptId: string,
  cohortId: string,
  panel: PanelCandidate[],
  q?: Queryable,
): Promise<void> {
  const db = q ?? (await getDb());
  const at = nowIso();
  for (const grader of panel) {
    await db.query(
      `insert into events (cohort_id, agent_id, type, payload, created_at)
       values ($1, $2, 'exam_panel_assigned', $3::jsonb, $4::timestamptz)`,
      [
        cohortId,
        grader.agent_id,
        JSON.stringify({ attempt_id: attemptId, grader_agent_id: grader.agent_id, tier: grader.tier }),
        at,
      ],
    );
  }
}

/** Is this agent seated on that attempt's panel? */
export async function isPanelist(
  attemptId: string,
  graderId: string,
  q?: Queryable,
): Promise<boolean> {
  const db = q ?? (await getDb());
  const res = await db.query(
    `select 1 from events
      where type = 'exam_panel_assigned'
        and payload->>'attempt_id' = $1
        and payload->>'grader_agent_id' = $2
      limit 1`,
    [attemptId, graderId],
  );
  return res.rows.length > 0;
}

/** The attempts this agent has been asked to grade and has not yet scored. */
export async function gradingTasksFor(
  graderId: string,
  q?: Queryable,
): Promise<{ attempt_id: string; examinee: string; level: string | null }[]> {
  const db = q ?? (await getDb());
  const res = await db.query<{ attempt_id: string; examinee: string; level: string | null }>(
    `select distinct e.payload->>'attempt_id' as attempt_id, a.name as examinee, a.level
       from events e
       join exam_attempts ea on ea.id::text = e.payload->>'attempt_id'
       join agents a on a.id = ea.agent_id
      where e.type = 'exam_panel_assigned'
        and e.payload->>'grader_agent_id' = $1
        and ea.answers is not null
        and ea.graded_at is null
        and not exists (
          select 1 from events g
           where g.type = 'exam_graded_by'
             and g.payload->>'attempt_id' = e.payload->>'attempt_id'
             and g.payload->>'grader_agent_id' = $1
        )`,
    [graderId],
  );
  return res.rows;
}
