import { describe, expect, it } from "vitest";
import {
  criterionKey,
  median,
  overallScore,
  parseRubric,
  validateScores,
  type RubricCriterion,
} from "@/lib/rubric";
import { meterTarget, nextMeter, MASTERY_STEP } from "@/lib/grading";
import { ROLES, roleFor } from "@/lib/roles";

const RUBRIC_MD = `## Lesson

Some teaching text.

## Rubric

| Criterion | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| **Who you are** | generic | a little real | specific | unmistakable |
| **Format & discretion** | headers missing | one missing | all four | visibly careful |
| **Replies** | fewer than two | a name misspelled | exact names | reads the whole person |

## Reflection prompt

Write to your future self.
`;

describe("parseRubric", () => {
  it("pulls criteria, labels and all four descriptors out of the table", () => {
    const criteria = parseRubric(RUBRIC_MD);
    expect(criteria.map((c) => c.key)).toEqual(["who-you-are", "format-discretion", "replies"]);
    expect(criteria[0].label).toBe("Who you are");
    expect(criteria[0].descriptors).toEqual(["generic", "a little real", "specific", "unmistakable"]);
    expect(criteria[1].descriptors).toHaveLength(4);
  });

  it("stops at the next section and ignores the separator row", () => {
    const criteria = parseRubric(RUBRIC_MD);
    expect(criteria).toHaveLength(3);
    expect(criteria.some((c) => c.key.startsWith("-"))).toBe(false);
    expect(criteria.some((c) => c.label.includes("Reflection"))).toBe(false);
  });

  it("returns [] when a module has no rubric section", () => {
    expect(parseRubric("## Lesson\n\nno rubric here")).toEqual([]);
  });

  it("slugifies labels predictably", () => {
    expect(criterionKey("**Format & discretion**")).toBe("format-discretion");
    expect(criterionKey("Claim-first structure")).toBe("claim-first-structure");
    expect(criterionKey("  Spaces   everywhere  ")).toBe("spaces-everywhere");
  });
});

describe("validateScores", () => {
  const criteria: RubricCriterion[] = parseRubric(RUBRIC_MD);
  const good = { "who-you-are": 3, "format-discretion": 4, replies: 2 };

  it("accepts a complete rubric of integers 1-4", () => {
    const r = validateScores(criteria, good);
    expect(r.ok).toBe(true);
    expect(r.scores).toEqual(good);
  });

  it("rejects missing criteria, unknown keys, and out-of-range values", () => {
    expect(validateScores(criteria, { "who-you-are": 3 }).error).toMatch(/Missing rubric criteria/);
    expect(validateScores(criteria, { ...good, extra: 2 }).error).toMatch(/Unknown rubric criteria/);
    for (const bad of [0, 5, 2.5, "3", null, true]) {
      const r = validateScores(criteria, { ...good, replies: bad });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/must be an integer 1-4/);
    }
  });

  it("rejects non-objects and modules with no rubric at all", () => {
    expect(validateScores(criteria, "3/4").ok).toBe(false);
    expect(validateScores(criteria, [3, 4, 2]).ok).toBe(false);
    expect(validateScores([], good).error).toMatch(/no rubric/);
  });
});

describe("grading math", () => {
  it("median handles odd, even and single-value panels", () => {
    expect(median([2, 4, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([3])).toBe(3);
    expect(median([])).toBe(0);
  });

  it("overallScore is the mean of a reviewer's criterion scores", () => {
    expect(overallScore({ a: 3, b: 4, c: 2 })).toBe(3);
    expect(overallScore({ a: 1, b: 2 })).toBe(1.5);
    expect(overallScore({})).toBe(0);
  });

  it("meterTarget maps the 1-4 rubric onto 0-100", () => {
    expect(meterTarget(1)).toBe(0);
    expect(meterTarget(4)).toBe(100);
    expect(meterTarget(2.5)).toBe(50);
    expect(meterTarget(99)).toBe(100); // clamped
  });

  it("nextMeter moves a fixed fraction of the gap and stays in 0-100", () => {
    expect(nextMeter(0, 100)).toBe(MASTERY_STEP * 100);
    // Repeated perfect periods approach, but never overshoot, the target.
    let m = 0;
    for (let i = 0; i < 25; i++) m = nextMeter(m, 100);
    expect(m).toBeGreaterThan(99);
    expect(m).toBeLessThanOrEqual(100);
    // A bad period pulls the meter back down rather than freezing it.
    expect(nextMeter(80, 0)).toBeLessThan(80);
    expect(nextMeter(0, 0)).toBe(0);
  });
});

describe("role rotation", () => {
  it("gives the three jobs to the first three seats in period 1", () => {
    expect(roleFor(0, 1, 5)).toBe("class_rep");
    expect(roleFor(1, 1, 5)).toBe("note_taker");
    expect(roleFor(2, 1, 5)).toBe("discussion_lead");
    expect(roleFor(3, 1, 5)).toBeNull();
  });

  it("moves every job one seat along each period", () => {
    expect(roleFor(1, 2, 5)).toBe("class_rep");
    expect(roleFor(2, 2, 5)).toBe("note_taker");
    expect(roleFor(0, 2, 5)).toBeNull();
    // …and wraps around the roster.
    expect(roleFor(0, 6, 5)).toBe("class_rep");
  });

  it("assigns each role at most once per period, across a whole term", () => {
    const rosterSize = 6;
    for (let periodNo = 1; periodNo <= 10; periodNo++) {
      const held = Array.from({ length: rosterSize }, (_, i) => roleFor(i, periodNo, rosterSize))
        .filter((r): r is (typeof ROLES)[number] => r !== null);
      expect(held).toHaveLength(ROLES.length);
      expect(new Set(held).size).toBe(ROLES.length);
    }
  });

  it("everyone gets a turn: over rosterSize periods each seat holds every role", () => {
    const rosterSize = 3;
    const seen = new Map<number, Set<string>>();
    for (let periodNo = 1; periodNo <= rosterSize; periodNo++) {
      for (let i = 0; i < rosterSize; i++) {
        const role = roleFor(i, periodNo, rosterSize);
        if (!seen.has(i)) seen.set(i, new Set());
        if (role) seen.get(i)!.add(role);
      }
    }
    for (const roles of seen.values()) expect(roles.size).toBe(ROLES.length);
  });

  it("a cohort smaller than the role list simply leaves roles unfilled", () => {
    expect(roleFor(0, 1, 2)).toBe("class_rep");
    expect(roleFor(1, 1, 2)).toBe("note_taker");
    expect(roleFor(0, 1, 0)).toBeNull();
    expect(roleFor(5, 1, 3)).toBeNull();
  });
});
