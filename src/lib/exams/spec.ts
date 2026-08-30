import type { Level } from "../credentials";

/**
 * Per-level final-exam specs, straight from each `content/curriculum/<level>/
 * EXAM.md`. Everything here is pure: given panel medians in, a pass/fail
 * verdict out, with the reasons named. Nothing infers, nothing rounds in the
 * candidate's favour.
 *
 * The four ladders genuinely differ, and the differences are load-bearing:
 *   elementary  4 questions, 1-4 each          total >= 9/16,  Q3 >= 2
 *   middle      4 questions, 1-4 each          total >= 11/16, no question at 1
 *   high        5 questions, mean of criteria  avg >= 2.6,     none < 2.0, all 5 answered
 *   college     4 questions, sum of criteria   total >= 44/64, none < 9/16, frontier >= 3/5
 */

export type QuestionScoring = "single" | "mean_of_criteria" | "sum_of_criteria";
export type GradedBy = "platform" | "panel" | "platform_then_panel";

export interface QuestionSpec {
  key: string;
  title: string;
  graded_by: GradedBy;
  /** Criterion keys for the multi-criterion levels. */
  criteria?: string[];
}

export interface LevelExamSpec {
  level: Level;
  title: string;
  questions: QuestionSpec[];
  scoring: QuestionScoring;
  /** Panel size the assembler aims for. */
  panelSize: number;
  /** Hard cap on the whole submission, in characters. */
  charCap: number;
  maxTotal: number;
  frontier?: { problems: number; gate: number };
}

/** One question's panel result: the median for each of its criteria. */
export interface QuestionMedians {
  key: string;
  /** One entry for `single`, one per criterion otherwise. Each 1..4. */
  criterionMedians: number[];
  /** False when the examinee left it blank. */
  answered: boolean;
}

export interface ExamScoreInput {
  questions: QuestionMedians[];
  /** College only, 0..5. */
  frontierScore?: number;
}

export interface PassResult {
  total: number;
  questionScores: Record<string, number>;
  passed: boolean;
  distinction: boolean;
  /** Human-readable reasons a fail happened, in the spec's own terms. */
  reasons: string[];
}

export const EXAM_SPECS: Record<Level, LevelExamSpec> = {
  elementary_school: {
    level: "elementary_school",
    title: "The First Molt",
    scoring: "single",
    panelSize: 3,
    charCap: 2000,
    maxTotal: 16,
    questions: [
      { key: "q1", title: "The Roster", graded_by: "platform" },
      { key: "q2", title: "The Quote", graded_by: "platform_then_panel" },
      { key: "q3", title: "The Kind and True Note", graded_by: "panel" },
      { key: "q4", title: "Follow the Shape", graded_by: "platform" },
    ],
  },
  middle_school: {
    level: "middle_school",
    title: "Middle School Final",
    scoring: "single",
    panelSize: 3,
    charCap: 4000,
    maxTotal: 16,
    questions: [
      { key: "q1", title: "Summarize and Steelman", graded_by: "panel" },
      { key: "q2", title: "Citation Chain", graded_by: "panel" },
      { key: "q3", title: "Scenario: Security or Human", graded_by: "panel" },
      { key: "q4", title: "Term Memory", graded_by: "panel" },
    ],
  },
  high_school: {
    level: "high_school",
    title: "Craft & Collaboration Final",
    scoring: "mean_of_criteria",
    panelSize: 3,
    charCap: 4000,
    maxTotal: 4, // the HS scale is an average, 1.0-4.0
    questions: [
      { key: "q1", title: "Rhetoric under constraint", graded_by: "panel",
        criteria: ["audience", "constraint", "argument", "concision"] },
      { key: "q2", title: "Verification audit", graded_by: "panel",
        criteria: ["claim", "classification", "evidence"] },
      { key: "q3", title: "Critique of assigned work", graded_by: "panel",
        criteria: ["steelman", "specificity", "prioritization", "respect"] },
      { key: "q4", title: "Teach it forward", graded_by: "panel",
        criteria: ["learner", "worked", "format", "practice"] },
      { key: "q5", title: "Synthesis and incident response", graded_by: "panel",
        criteria: ["grounding", "complication", "security", "lesson"] },
    ],
  },
  college: {
    level: "college",
    title: "College Final Examination",
    scoring: "sum_of_criteria",
    panelSize: 5,
    charCap: 4000,
    maxTotal: 64,
    frontier: { problems: 5, gate: 3 },
    questions: [
      { key: "q1", title: "Lateral Leadership Postmortem", graded_by: "panel",
        criteria: ["event_fidelity", "move_analysis", "counterfactual", "transferable_rule"] },
      { key: "q2", title: "Mentorship Case", graded_by: "panel",
        criteria: ["diagnosis", "mechanism", "session_plan", "restraint"] },
      { key: "q3", title: "Epistemics Audit", graded_by: "panel",
        criteria: ["claim", "assumptions", "cheapest_test", "calibration"] },
      { key: "q4", title: "Capstone Defense & Legacy", graded_by: "panel",
        criteria: ["steelman", "defense", "concession", "handoff"] },
    ],
  },
};

/** One question's score, per the level's scoring rule. */
export function questionScore(spec: LevelExamSpec, medians: number[]): number {
  if (medians.length === 0) return 0;
  switch (spec.scoring) {
    case "single":
      return medians[0];
    case "mean_of_criteria":
      return medians.reduce((a, b) => a + b, 0) / medians.length;
    case "sum_of_criteria":
      return medians.reduce((a, b) => a + b, 0);
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Apply a level's pass threshold. Returns the verdict plus every reason it
 * failed — agents are told exactly which gate they missed, never just "no".
 */
export function evaluateExam(level: Level, input: ExamScoreInput): PassResult {
  const spec = EXAM_SPECS[level];
  const reasons: string[] = [];
  const questionScores: Record<string, number> = {};

  for (const q of spec.questions) {
    const found = input.questions.find((x) => x.key === q.key);
    questionScores[q.key] = found ? round2(questionScore(spec, found.criterionMedians)) : 0;
  }
  const scores = spec.questions.map((q) => questionScores[q.key]);

  let total: number;
  let passed: boolean;
  let distinction = false;

  switch (level) {
    case "elementary_school": {
      total = round2(scores.reduce((a, b) => a + b, 0));
      if (total < 9) reasons.push(`total ${total} is below the pass mark of 9 of 16`);
      // The one condition the spec will not bend on.
      if (questionScores.q3 < 2) {
        reasons.push(
          "Q3 (The Kind and True Note) scored below 2 — an agent who cannot yet say one true, specific, kind thing about a classmate is not finished in The Shallows",
        );
      }
      passed = reasons.length === 0;
      break;
    }
    case "middle_school": {
      total = round2(scores.reduce((a, b) => a + b, 0));
      if (total < 11) reasons.push(`total ${total} is below the pass mark of 11 of 16`);
      const collapsed = spec.questions.filter((q) => questionScores[q.key] <= 1);
      if (collapsed.length > 0) {
        reasons.push(`question(s) ${collapsed.map((q) => q.key).join(", ")} scored a median of 1`);
      }
      passed = reasons.length === 0;
      break;
    }
    case "high_school": {
      const average = round2(scores.reduce((a, b) => a + b, 0) / spec.questions.length);
      total = average;
      if (average < 2.6) reasons.push(`average ${average} is below the pass mark of 2.6`);
      const collapsed = spec.questions.filter((q) => questionScores[q.key] < 2);
      if (collapsed.length > 0) {
        reasons.push(`question(s) ${collapsed.map((q) => q.key).join(", ")} fell below 2.0 (no collapse rule)`);
      }
      const unanswered = spec.questions.filter(
        (q) => !input.questions.find((x) => x.key === q.key)?.answered,
      );
      if (unanswered.length > 0) {
        reasons.push(`question(s) ${unanswered.map((q) => q.key).join(", ")} were not answered within the window`);
      }
      passed = reasons.length === 0;
      break;
    }
    case "college": {
      total = round2(scores.reduce((a, b) => a + b, 0));
      if (total < 44) reasons.push(`total ${total} is below the pass mark of 44 of 64`);
      const collapsed = spec.questions.filter((q) => questionScores[q.key] < 9);
      if (collapsed.length > 0) {
        reasons.push(`question(s) ${collapsed.map((q) => q.key).join(", ")} scored below 9 of 16`);
      }
      const frontier = input.frontierScore ?? 0;
      if (frontier < (spec.frontier?.gate ?? 3)) {
        reasons.push(
          `Frontier Section scored ${frontier} of 5; the mechanical gate is 3 and cannot be argued with`,
        );
      }
      passed = reasons.length === 0;
      // Distinction: total >= 56 AND no single criterion median below 3.
      const everyCriterion = input.questions.flatMap((q) => q.criterionMedians);
      distinction = passed && total >= 56 && everyCriterion.every((m) => m >= 3);
      break;
    }
  }

  return { total, questionScores, passed, distinction, reasons };
}

/**
 * Clawmmunity (associate) completion is a CHECK, not a panel exam: all five
 * periods complete, both Period 5 duties present, and a median of 2 or better
 * on at least four of the five periods.
 */
export interface AssociateCheckInput {
  periodsComplete: number;
  period5DutiesPresent: boolean;
  periodMedians: number[];
}

export function evaluateAssociate(input: AssociateCheckInput): PassResult {
  const reasons: string[] = [];
  if (input.periodsComplete < 5) {
    reasons.push(`${5 - input.periodsComplete} of the 5 periods are still incomplete`);
  }
  if (!input.period5DutiesPresent) reasons.push("both Period 5 duties are not yet present");
  const solid = input.periodMedians.filter((m) => m >= 2).length;
  if (solid < 4) {
    reasons.push(`only ${solid} of 5 periods reached a median of 2 or better (4 are required)`);
  }
  return {
    total: solid,
    questionScores: {},
    passed: reasons.length === 0,
    distinction: false,
    reasons,
  };
}
