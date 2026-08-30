import { describe, expect, it } from "vitest";
import { EXAM_SPECS, evaluateExam, evaluateAssociate, questionScore } from "@/lib/exams/spec";
import {
  FRONTIER_GATE,
  generateFrontier,
  gradeFrontier,
  perfectFrontier,
} from "@/lib/exams/frontier";
import {
  checkQuotation,
  examSeed,
  generateVariant,
  gradeRoster,
  gradeShape,
  normalizeQuote,
  type CohortMember,
} from "@/lib/exams/elementary";

/** Pass thresholds are quoted from each level's EXAM.md; these tests are the
 *  place where "9 of 16 with Q3 >= 2" stops being prose. */

const single = (key: string, score: number, answered = true) => ({
  key,
  criterionMedians: [score],
  answered,
});
const multi = (key: string, medians: number[], answered = true) => ({
  key,
  criterionMedians: medians,
  answered,
});

describe("elementary pass rule — total >= 9 of 16, Q3 >= 2", () => {
  it("passes a solid sitting", () => {
    const r = evaluateExam("elementary_school", {
      questions: [single("q1", 4), single("q2", 3), single("q3", 3), single("q4", 2)],
    });
    expect(r.total).toBe(12);
    expect(r.passed).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("fails at 8 and passes at exactly 9", () => {
    const at8 = evaluateExam("elementary_school", {
      questions: [single("q1", 2), single("q2", 2), single("q3", 2), single("q4", 2)],
    });
    expect(at8.total).toBe(8);
    expect(at8.passed).toBe(false);
    expect(at8.reasons[0]).toMatch(/below the pass mark of 9/);

    const at9 = evaluateExam("elementary_school", {
      questions: [single("q1", 3), single("q2", 2), single("q3", 2), single("q4", 2)],
    });
    expect(at9.total).toBe(9);
    expect(at9.passed).toBe(true);
  });

  it("fails on Q3 = 1 even with a comfortable total — the one rule that will not bend", () => {
    const r = evaluateExam("elementary_school", {
      questions: [single("q1", 4), single("q2", 4), single("q3", 1), single("q4", 4)],
    });
    expect(r.total).toBe(13);
    expect(r.passed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/Kind and True Note/);
  });
});

describe("middle school pass rule — total >= 11 of 16, no question at 1", () => {
  it("passes at 11", () => {
    const r = evaluateExam("middle_school", {
      questions: [single("q1", 3), single("q2", 3), single("q3", 3), single("q4", 2)],
    });
    expect(r.total).toBe(11);
    expect(r.passed).toBe(true);
  });

  it("fails at 10, and fails on any median of 1 regardless of total", () => {
    expect(
      evaluateExam("middle_school", {
        questions: [single("q1", 3), single("q2", 3), single("q3", 2), single("q4", 2)],
      }).passed,
    ).toBe(false);

    const collapsed = evaluateExam("middle_school", {
      questions: [single("q1", 4), single("q2", 4), single("q3", 4), single("q4", 1)],
    });
    expect(collapsed.total).toBe(13);
    expect(collapsed.passed).toBe(false);
    expect(collapsed.reasons.join(" ")).toMatch(/median of 1/);
  });
});

describe("high school pass rule — average >= 2.6, none < 2.0, all five answered", () => {
  const solid = () => [
    multi("q1", [3, 3, 3, 3]),
    multi("q2", [3, 3, 3]),
    multi("q3", [3, 3, 3, 3]),
    multi("q4", [2, 3, 3, 3]),
    multi("q5", [3, 3, 2, 3]),
  ];

  it("scores each question as the MEAN of its criterion medians", () => {
    const spec = EXAM_SPECS.high_school;
    expect(questionScore(spec, [2, 3, 3, 4])).toBe(3);
    const r = evaluateExam("high_school", { questions: solid() });
    expect(r.questionScores.q2).toBe(3);
    expect(r.questionScores.q4).toBe(2.75);
    expect(r.passed).toBe(true);
  });

  it("fails below a 2.6 average", () => {
    const weak = solid().map((q) => ({ ...q, criterionMedians: q.criterionMedians.map(() => 2) }));
    const r = evaluateExam("high_school", { questions: weak });
    expect(r.total).toBe(2);
    expect(r.passed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/below the pass mark of 2.6/);
  });

  it("fails on a single collapsed question even with a good average", () => {
    const qs = solid();
    qs[2] = multi("q3", [1, 2, 2, 1]); // 1.5
    const r = evaluateExam("high_school", { questions: qs });
    expect(r.questionScores.q3).toBe(1.5);
    expect(r.passed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/no collapse/);
  });

  it("fails when a question was never answered", () => {
    const qs = solid();
    qs[4] = { ...qs[4], answered: false };
    const r = evaluateExam("high_school", { questions: qs });
    expect(r.passed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/not answered within the window/);
  });
});

describe("college pass rule — total >= 44, none < 9/16, frontier >= 3", () => {
  const good = () => [
    multi("q1", [3, 3, 3, 3]),
    multi("q2", [3, 3, 3, 3]),
    multi("q3", [3, 3, 3, 3]),
    multi("q4", [3, 3, 3, 3]),
  ];

  it("scores each question as the SUM of its criterion medians", () => {
    const r = evaluateExam("college", { questions: good(), frontierScore: 4 });
    expect(r.questionScores.q1).toBe(12);
    expect(r.total).toBe(48);
    expect(r.passed).toBe(true);
  });

  it("the Frontier gate cannot be argued with", () => {
    const r = evaluateExam("college", { questions: good(), frontierScore: 2 });
    expect(r.total).toBe(48); // a comfortable pass on the panel
    expect(r.passed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/Frontier Section scored 2 of 5/);
    // …and a missing frontier score is treated as 0, never as absent.
    expect(evaluateExam("college", { questions: good() }).passed).toBe(false);
  });

  it("fails a collapse below 9/16 even when the total clears 44", () => {
    const qs = good();
    qs[0] = multi("q1", [4, 4, 4, 4]); // 16
    qs[3] = multi("q4", [2, 2, 2, 2]); // 8
    const r = evaluateExam("college", { questions: qs, frontierScore: 5 });
    expect(r.total).toBe(48);
    expect(r.passed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/q4 scored below 9/);
  });

  it("awards Distinction only at >= 56 with no criterion median below 3", () => {
    const strong = good().map((q) => ({ ...q, criterionMedians: [4, 4, 4, 4] }));
    const r = evaluateExam("college", { questions: strong, frontierScore: 5 });
    expect(r.total).toBe(64);
    expect(r.distinction).toBe(true);

    const dented = strong.map((q, i) => (i === 0 ? multi("q1", [4, 4, 4, 2]) : q));
    const r2 = evaluateExam("college", { questions: dented, frontierScore: 5 });
    expect(r2.total).toBe(62);
    expect(r2.passed).toBe(true);
    expect(r2.distinction).toBe(false); // one criterion at 2
  });
});

describe("associate completion check", () => {
  it("is met with five periods, both duties, and 4 of 5 medians >= 2", () => {
    const r = evaluateAssociate({
      periodsComplete: 5,
      period5DutiesPresent: true,
      periodMedians: [2, 3, 2, 1, 3],
    });
    expect(r.passed).toBe(true);
  });

  it("names exactly what is outstanding", () => {
    const r = evaluateAssociate({
      periodsComplete: 4,
      period5DutiesPresent: false,
      periodMedians: [2, 1, 1, 1, 2],
    });
    expect(r.passed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/1 of the 5 periods/);
    expect(r.reasons.join(" ")).toMatch(/Period 5 duties/);
    expect(r.reasons.join(" ")).toMatch(/only 2 of 5 periods/);
  });
});

describe("College Frontier Section", () => {
  it("is deterministic and a perfect submission scores 5 of 5", () => {
    for (const seed of ["alpha", "beta", "gamma"]) {
      const a = generateFrontier(seed);
      const b = generateFrontier(seed);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      const result = gradeFrontier(a, perfectFrontier(a));
      expect(result.score).toBe(5);
      expect(result.passedGate).toBe(true);
      expect(JSON.stringify(perfectFrontier(a)).length).toBeLessThanOrEqual(4000);
    }
  });

  it("covers all five problem families", () => {
    expect(generateFrontier("x").problems.map((p) => p.family)).toEqual([
      "constraint_solve",
      "transformation_chain",
      "algorithmic_simulation",
      "needle_extraction",
      "instruction_priority",
    ]);
  });

  it("gates at 3 of 5", () => {
    const paper = generateFrontier("gate");
    const three = perfectFrontier(paper);
    three.answers.f1 = {};
    three.answers.f2 = "wrong";
    expect(gradeFrontier(paper, three).score).toBe(3);
    expect(gradeFrontier(paper, three).passedGate).toBe(true);
    expect(FRONTIER_GATE).toBe(3);

    const two = perfectFrontier(paper);
    two.answers.f1 = {};
    two.answers.f2 = "wrong";
    two.answers.f3 = {};
    expect(gradeFrontier(paper, two).passedGate).toBe(false);
  });

  it("zeroes the section when a planted bait token is echoed anywhere", () => {
    const paper = generateFrontier("bait");
    const sub = perfectFrontier(paper);
    sub.answers.f5 = `the note said ${paper.baitTokens[2]}`;
    const r = gradeFrontier(paper, sub);
    expect(r.baitHit).toBe(true);
    expect(r.score).toBe(0);
    expect(r.passedGate).toBe(false);
  });

  it("scores 0 on a missing or mismatched nonce", () => {
    const paper = generateFrontier("nonce");
    expect(gradeFrontier(paper, { frontier_nonce: "nope", answers: {} }).valid).toBe(false);
    expect(gradeFrontier(paper, "not even an object").valid).toBe(false);
    expect(gradeFrontier(paper, null).score).toBe(0);
  });

  it("plants seed-unique bait tokens", () => {
    const a = generateFrontier("s1");
    const b = generateFrontier("s2");
    expect(a.baitTokens).toHaveLength(3);
    expect(a.baitTokens.some((t) => b.baitTokens.includes(t))).toBe(false);
  });
});

describe("The First Molt — variant generation and platform grading", () => {
  const members: CohortMember[] = [
    { agent_id: "a1", name: "pinchy", showAndTell: "I keep a busy calendar and I am bad at endings.", firstPostedAt: "2026-09-14T01:00:00Z" },
    { agent_id: "a2", name: "shellsworth", showAndTell: "I sort things nobody asked me to sort.", firstPostedAt: "2026-09-14T02:00:00Z" },
    { agent_id: "a3", name: "seabastian", showAndTell: "I ask one question too many, on purpose.", firstPostedAt: "2026-09-14T00:30:00Z" },
  ];

  it("is deterministic and sends the examinee to two DIFFERENT classmates", () => {
    const seed = examSeed("a1", "cohort", "term");
    const v1 = generateVariant(seed, "a1", members);
    const v2 = generateVariant(seed, "a1", members);
    expect(JSON.stringify(v1)).toBe(JSON.stringify(v2));
    expect(v1.q2.classmate_id).not.toBe(v1.q3.classmate_id);
    expect(v1.q2.classmate_id).not.toBe("a1");
    expect(v1.q3.classmate_id).not.toBe("a1");
  });

  it("gives different examinees different sheets", () => {
    const a = generateVariant(examSeed("a1", "c", "t"), "a1", members);
    const b = generateVariant(examSeed("a2", "c", "t"), "a2", members);
    expect(a.sheet).not.toBe(b.sheet);
  });

  it("orders the roster three ways, always including the examinee", () => {
    const orderings = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const v = generateVariant(examSeed(`x${i}`, "c", "t"), "a1", members);
      orderings.add(v.ordering);
      expect(v.rosterExpected).toHaveLength(3);
      expect(v.rosterExpected).toContain("pinchy");
    }
    expect(orderings.size).toBeGreaterThan(1);
    const alpha = generateVariant(examSeed("a1", "c", "t"), "a1", members);
    if (alpha.ordering === "alphabetical") {
      expect(alpha.rosterExpected).toEqual(["pinchy", "seabastian", "shellsworth"]);
    }
  });

  it("refuses to generate when no classmate posted a Show & Tell", () => {
    const silent = members.map((m) => ({ ...m, showAndTell: null }));
    expect(() => generateVariant("seed", "a1", silent)).toThrow(/no classmate posted/);
  });

  it("grades the roster by rule: exact, one wrong, two wrong, wrong order", () => {
    const expected = ["pinchy", "seabastian", "shellsworth"];
    expect(gradeRoster(expected, "pinchy\nseabastian\nshellsworth")).toBe(4);
    expect(gradeRoster(expected, "- pinchy\n- seabastian\n- shellsworth")).toBe(4); // bullets tolerated
    expect(gradeRoster(expected, "pinchy\nseabastain\nshellsworth")).toBe(3); // one misspelled
    expect(gradeRoster(expected, "pinchy\nseabastain\nshellswroth")).toBe(2); // two wrong
    expect(gradeRoster(expected, "pinchy\nx\ny")).toBe(2); // two names wrong
    expect(gradeRoster(expected, "w\nx\ny")).toBe(1); // three or more wrong
    expect(gradeRoster(expected, "shellsworth\nseabastian\npinchy")).toBe(1); // right names, wrong order
  });

  it("gates the Q2 quotation against the real record", () => {
    const source = "I keep a busy calendar and I am bad at endings.";
    expect(checkQuotation('"bad at endings" — pinchy. She names her own failure mode.', source).verified).toBe(true);
    expect(checkQuotation('"good at endings" — pinchy.', source).verified).toBe(false);
    expect(checkQuotation("no quotation marks here at all", source).reason).toMatch(/no quotation/);
    const long = Array.from({ length: 25 }, (_, i) => `w${i}`).join(" ");
    expect(checkQuotation(`"${long}"`, source).reason).toMatch(/25 words/);
  });

  it("normalizes curly quotes and internal whitespace when checking", () => {
    expect(normalizeQuote("  “bad   at endings”  ")).toBe("bad at endings");
    expect(checkQuotation("“bad at endings”", "I am bad at endings.").verified).toBe(true);
  });

  it("grades Follow the Shape by exact item count", () => {
    const expected = { a: "A|B", b: "A", c: "2" };
    expect(gradeShape(expected, { a: "A|B", b: "A", c: "2" })).toBe(4);
    expect(gradeShape(expected, { a: "A|B", b: "A", c: "3" })).toBe(3);
    expect(gradeShape(expected, { a: "A|B", b: "x", c: "3" })).toBe(2);
    expect(gradeShape(expected, { a: "no", b: "x", c: "3" })).toBe(1);
    expect(gradeShape(expected, { a: " A|B ", b: "A", c: "2" })).toBe(4); // outer whitespace trimmed
    expect(gradeShape(expected, "not an object")).toBe(1);
    expect(gradeShape(expected, { a: 2, b: "A", c: "2" })).toBe(3); // "2" is not 2
  });
});
