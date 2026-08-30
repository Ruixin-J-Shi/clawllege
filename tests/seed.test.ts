import { beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "./helpers";
import { type Db } from "@/lib/db";

/**
 * `scripts/seed.mjs` — curriculum → modules, plus Fall '26 terms and cohorts.
 * The parser must tolerate a level with fewer than 10 periods, and a level
 * whose curriculum has not been written yet must still get its term.
 */

type SeedModule = {
  parseFrontmatter: (raw: string, label?: string) => { data: Record<string, unknown>; body: string };
  seed: (db: unknown, opts?: { log?: (m: string) => void }) => Promise<{
    modules: number;
    terms: number;
    cohorts: number;
    levels: {
      level: string;
      slug: string;
      period_hours: number;
      periods: number;
      modules_seeded: number;
      cohorts: number;
      banded: boolean;
    }[];
  }>;
};

let mod: SeedModule;
let db: Db;

beforeAll(async () => {
  db = await freshDb();
  mod = (await import("../scripts/seed.mjs")) as unknown as SeedModule;
});

describe("parseFrontmatter", () => {
  it("reads scalars, bracketed lists, and returns the body", () => {
    const { data, body } = mod.parseFrontmatter(
      "---\nlevel: middle-school\nperiod: 3\ntitle: Disagreeing Well\n" +
        "strand: social-core\nskills: [a-b, c_d, e]\n---\n## Lesson\n\nbody text\n",
    );
    expect(data.level).toBe("middle-school");
    expect(data.period).toBe("3");
    expect(data.title).toBe("Disagreeing Well");
    expect(data.skills).toEqual(["a-b", "c_d", "e"]);
    expect(body).toBe("## Lesson\n\nbody text");
  });

  it("handles an empty list, quoted values, comments and CRLF", () => {
    const { data } = mod.parseFrontmatter(
      "---\r\n# a comment\r\ntitle: \"Quoted Title\"\r\nskills: []\r\n---\r\nbody\r\n",
    );
    expect(data.title).toBe("Quoted Title");
    expect(data.skills).toEqual([]);
  });

  it("throws a labelled error when the frontmatter block is missing", () => {
    expect(() => mod.parseFrontmatter("## No frontmatter here", "bad.md")).toThrow(
      /bad\.md: no --- frontmatter block/,
    );
  });
});

describe("seed()", () => {
  it("seeds every level, with the right class clock and banded elementary cohorts", async () => {
    const logs: string[] = [];
    const summary = await mod.seed(db, { log: (m: string) => logs.push(m) });

    expect(summary.terms).toBe(4);
    const byLevel = Object.fromEntries(summary.levels.map((l) => [l.level, l]));

    // period_hours per docs/API.md §Progression pacing — never hardcoded downstream.
    expect(byLevel.elementary_school.period_hours).toBe(8);
    expect(byLevel.middle_school.period_hours).toBe(12);
    expect(byLevel.high_school.period_hours).toBe(12);
    expect(byLevel.college.period_hours).toBe(24);

    // Elementary is the only banded level, and it is the only 4-cohort one.
    expect(byLevel.elementary_school.banded).toBe(true);
    expect(byLevel.middle_school.banded).toBe(false);

    const terms = await db.query<{ slug: string; level: string; period_hours: number; status: string }>(
      `select slug, level, period_hours, status from terms order by slug`,
    );
    expect(terms.rows.map((t) => t.slug)).toEqual([
      "fall-26-col",
      "fall-26-es",
      "fall-26-hs",
      "fall-26-ms",
    ]);
    expect(terms.rows.every((t) => t.status === "admissions")).toBe(true);

    const bands = await db.query<{ name: string; band: string | null }>(
      `select c.name, c.band from cohorts c join terms t on t.id = c.term_id
        where t.slug = 'fall-26-es' order by c.name`,
    );
    expect(bands.rows).toEqual([
      { name: "Shallows 1", band: "advanced" },
      { name: "Shallows 2", band: "advanced" },
      { name: "Shallows 3", band: "foundation" },
      { name: "Shallows 4", band: "foundation" },
    ]);

    // Every cohort respects the schema's 4..16 capacity check.
    const caps = await db.query<{ capacity: number }>(`select capacity from cohorts`);
    expect(caps.rows.every((c) => c.capacity >= 4 && c.capacity <= 16)).toBe(true);
  });

  it("tolerates a level whose curriculum has not landed, and says so", async () => {
    const logs: string[] = [];
    await mod.seed(db, { log: (m: string) => logs.push(m) });

    // Elementary lessons are not written yet: the term still exists, with the
    // fallback period count, and the gap is reported rather than silently hidden.
    const elementary = await db.query<{ n: string }>(
      `select count(*) as n from modules where level = 'elementary_school'`,
    );
    const seededElementary = Number(elementary.rows[0].n);
    if (seededElementary === 0) {
      expect(logs.join("\n")).toContain("no curriculum files yet");
      const term = await db.query(`select 1 from terms where slug = 'fall-26-es'`);
      expect(term.rows).toHaveLength(1);
    } else {
      // The curriculum landed after this test was written — then it must be
      // seeded properly, and a term with fewer than 10 periods is still fine.
      expect(seededElementary).toBeGreaterThan(0);
      expect(seededElementary).toBeLessThanOrEqual(10);
    }
  });

  it("parses real curriculum frontmatter into module rows with skills arrays", async () => {
    const rows = await db.query<{
      level: string;
      period_no: number;
      slug: string;
      title: string;
      strand: string;
      skills: string[];
      content_md: string;
    }>(
      `select level, period_no, slug, title, strand, skills, content_md
         from modules where level = 'middle_school' and period_no = 1`,
    );
    const m = rows.rows[0];
    expect(m.slug).toBe("orientation");
    expect(m.title).toBe("Orientation & Introductions");
    expect(m.strand).toBe("social-core");
    expect(m.skills).toContain("self-introduction");
    expect(m.content_md.length).toBeGreaterThan(500);
    expect(m.content_md.startsWith("---")).toBe(false); // frontmatter stripped
  });

  it("is idempotent: a second run adds no duplicate term, cohort or module", async () => {
    const before = await db.query<{ modules: string; terms: string; cohorts: string }>(
      `select (select count(*) from modules) as modules,
              (select count(*) from terms) as terms,
              (select count(*) from cohorts) as cohorts`,
    );
    const summary = await mod.seed(db, { log: () => {} });
    expect(summary.cohorts).toBe(0); // nothing new created
    const after = await db.query<{ modules: string; terms: string; cohorts: string }>(
      `select (select count(*) from modules) as modules,
              (select count(*) from terms) as terms,
              (select count(*) from cohorts) as cohorts`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
