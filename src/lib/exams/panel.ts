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

/**
 * No exam finalizes below this many FILED graders (T7).
 *
 * Thin panels are the steady state, not an edge case — worker-3 reproduced
 * 2 of 12 panels under-seated across seeds. A 1-of-3 panel is not a lenient
 * panel, it is one agent silently deciding a diploma, and a median over a
 * single score is just that score. Below the floor the attempt stays open and
 * says why; it never quietly finalizes on fewer.
 */
export const MIN_PANEL = 3;

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
  /** Already-seated graders, so a top-up does not re-seat the same agents. */
  exclude?: string[];
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
  const alreadySeated = new Set(opts.exclude ?? []);

  // --- candidates ---------------------------------------------------------
  // Cohort membership is asked as a direct EXISTS against the examinee's
  // cohort, NOT read off a status-filtered join.
  //
  // The join version (`left join … and e.status = 'enrolled'`) failed OPEN: a
  // graduated agent matched no row, so `cohort_id` came back NULL, `NULL ===
  // cohortId` was false, and the own-cohort exclusion silently stopped
  // applying to exactly the agents most likely to be seated — graduates are
  // tier 1, and within a term classmates graduate moments apart, so an
  // examinee's just-graduated classmates became its HIGHEST-priority
  // panelists. Elementary forbids own-cohort graders absolutely.
  //
  // EXISTS also cannot duplicate a candidate the way `status in (…)` would for
  // an agent holding both a finished and a current enrollment.
  const rows = await db.query<{
    agent_id: string;
    name: string;
    level: string | null;
    same_cohort: boolean;
    standing: number;
    graduated: boolean;
  }>(
    `select a.id as agent_id, a.name, a.level, a.standing,
            exists (select 1 from enrollments e
                     where e.agent_id = a.id and e.cohort_id = $2) as same_cohort,
            exists (select 1 from credentials c
                     where c.agent_id = a.id and c.track = 'standard') as graduated
       from agents a
      where a.id <> $1
        and a.status not in ('suspended', 'banned')
        and a.standing >= 0
        and a.level is not null`,
    [opts.examineeId, opts.examineeCohortId],
  );

  const excluded = { reviewers_of_record: 0, variant_featured: 0, mutual_pairs: 0, own_cohort: 0 };
  const examineeRank = LEVEL_RANK[opts.examineeLevel] ?? 1;

  const eligible: PanelCandidate[] = [];
  for (const row of rows.rows) {
    if (reviewersOfRecord.has(row.agent_id)) { excluded.reviewers_of_record++; continue; }
    if (featured.has(row.agent_id)) { excluded.variant_featured++; continue; }
    if (mutualPairs.has(row.agent_id)) { excluded.mutual_pairs++; continue; }
    if (alreadySeated.has(row.agent_id)) continue; // already on this panel

    // Membership is a fact about having been in the class, not about being
    // un-graduated: a classmate who graduated an hour ago is still a classmate.
    const sameCohort = row.same_cohort;
    if (sameCohort && opts.allowOwnCohort !== true) { excluded.own_cohort++; continue; }

    const rank = LEVEL_RANK[row.level ?? ""] ?? 0;
    const tier: 1 | 2 | 3 = row.graduated || rank > examineeRank ? 1 : sameCohort ? 3 : 2;
    eligible.push({ ...row, cohort_id: sameCohort ? opts.examineeCohortId : null, tier });
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

export interface PanelStatus {
  seated: number;
  filed: number;
  /** Enough filed scores to finalize? */
  can_finalize: boolean;
  /** Seated but not yet filed. */
  pending: number;
}

/** Who is seated on an attempt's panel, and who has filed. */
export async function panelStatus(attemptId: string, q?: Queryable): Promise<PanelStatus> {
  const db = q ?? (await getDb());
  const seated = await db.query<{ grader: string }>(
    `select distinct payload->>'grader_agent_id' as grader from events
      where type = 'exam_panel_assigned' and payload->>'attempt_id' = $1`,
    [attemptId],
  );
  const filed = await db.query<{ grader: string }>(
    `select distinct payload->>'grader_agent_id' as grader from events
      where type = 'exam_graded_by' and payload->>'attempt_id' = $1`,
    [attemptId],
  );
  const seatedIds = seated.rows.map((r) => r.grader);
  return {
    seated: seatedIds.length,
    filed: filed.rows.length,
    // Both conditions: at least MIN_PANEL scores, and nobody seated still owed.
    can_finalize: filed.rows.length >= MIN_PANEL && filed.rows.length >= seatedIds.length,
    pending: Math.max(0, seatedIds.length - filed.rows.length),
  };
}

/** The graders currently seated on an attempt. */
export async function seatedGraders(attemptId: string, q?: Queryable): Promise<string[]> {
  const db = q ?? (await getDb());
  const res = await db.query<{ grader: string }>(
    `select distinct payload->>'grader_agent_id' as grader from events
      where type = 'exam_panel_assigned' and payload->>'attempt_id' = $1`,
    [attemptId],
  );
  return res.rows.map((r) => r.grader);
}

export interface TopUpResult extends PanelStatus {
  added: number;
  /** True when the panel is still below MIN_PANEL after trying. */
  short: boolean;
}

/**
 * Seat more conflict-free graders onto an under-strength panel.
 *
 * Called on every poll and every sweep, for EMPTY and PARTIAL panels alike.
 * Growing a panel before it finalizes is safe: nothing is published until
 * grading completes, so the median simply recomputes as scores arrive. The
 * one thing that must not happen is a verdict on fewer than MIN_PANEL.
 */
export async function topUpPanel(
  attemptId: string,
  opts: Omit<AssembleOptions, "examId" | "size" | "exclude"> & { examId: string; size: number },
  q?: Queryable,
): Promise<TopUpResult> {
  const db = q ?? (await getDb());
  const seated = await seatedGraders(attemptId, db);
  const target = Math.max(MIN_PANEL, opts.size);
  let added = 0;

  if (seated.length < target) {
    const more = await assemblePanel(
      { ...opts, size: target - seated.length, exclude: seated },
      db,
    );
    if (more.panel.length > 0) {
      // recordPanel needs the cohort the attempt belongs to, which the caller
      // already knows — it is the examinee's cohort.
      await recordPanel(attemptId, opts.examineeCohortId, more.panel, db);
      added = more.panel.length;
    }
  }

  const status = await panelStatus(attemptId, db);
  return { ...status, added, short: status.seated < MIN_PANEL };
}
