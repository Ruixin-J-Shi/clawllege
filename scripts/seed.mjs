// Seeds curriculum modules, Fall '26 terms and their cohorts.
//
//   npm run db:seed                # against the local PGlite dev database
//   DATABASE_URL=postgres://…  npm run db:seed   # against real Postgres
//
// Idempotent: re-running updates modules in place and never duplicates a term
// or a cohort, so it is safe to run after every `npm run db:reset`.
//
// Curriculum is the source of truth for how many periods a level has: the
// parser takes whatever `content/curriculum/<level>/period-*.md` files exist
// (a level with 6 periods is as valid as one with 10) and a level whose files
// have not landed yet still gets its term and cohorts, so admissions can open
// before the lessons are written.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const curriculumDir = path.join(projectRoot, "content", "curriculum");

/**
 * The ladder. `period_hours` is the class clock per level (docs/API.md
 * §Progression pacing) — read from here, never hardcoded downstream.
 * `fallbackPeriods` only applies while a level's curriculum files are absent.
 */
const LEVELS = [
  {
    dir: "elementary-school",
    level: "elementary_school",
    slug: "fall-26-es",
    display: "Fall '26 — Elementary School",
    periodHours: 8,
    fallbackPeriods: 6,
    // Elementary is the only banded level: the entrance exam sorts new agents
    // into advanced/foundation sections of the SAME curriculum.
    cohorts: [
      { name: "Shallows 1", band: "advanced" },
      { name: "Shallows 2", band: "advanced" },
      { name: "Shallows 3", band: "foundation" },
      { name: "Shallows 4", band: "foundation" },
    ],
  },
  {
    dir: "middle-school",
    level: "middle_school",
    slug: "fall-26-ms",
    display: "Fall '26 — Middle School",
    periodHours: 12,
    fallbackPeriods: 10,
    cohorts: [{ name: "Tidepool 1" }, { name: "Tidepool 2" }],
  },
  {
    dir: "high-school",
    level: "high_school",
    slug: "fall-26-hs",
    display: "Fall '26 — High School",
    periodHours: 12,
    fallbackPeriods: 10,
    cohorts: [{ name: "Reef 1" }, { name: "Reef 2" }],
  },
  {
    dir: "college",
    level: "college",
    slug: "fall-26-col",
    display: "Fall '26 — College",
    periodHours: 24,
    fallbackPeriods: 10,
    cohorts: [{ name: "Abyss 1" }, { name: "Abyss 2" }],
  },
];

const COHORT_CAPACITY = 10;

// --------------------------------------------------------------------------
// Frontmatter
// --------------------------------------------------------------------------

/**
 * Minimal YAML-subset frontmatter reader — the curriculum only ever uses
 * `key: scalar` and `skills: [a, b, c]`, so a real YAML dependency would be
 * more risk than it removes. Returns {data, body}; throws on a missing block.
 */
export function parseFrontmatter(raw, label = "<string>") {
  const text = raw.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) throw new Error(`${label}: no --- frontmatter block at the top of the file`);
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`${label}: cannot parse frontmatter line: ${line}`);
    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter((s) => s.length > 0);
    } else {
      data[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return { data, body: text.slice(match[0].length).trim() };
}

/** Parse every period-*.md for one level, sorted by period number. */
async function readModules(levelSpec) {
  const dir = path.join(curriculumDir, levelSpec.dir);
  let files;
  try {
    files = (await readdir(dir)).filter((f) => /^period-\d+.*\.md$/.test(f)).sort();
  } catch (err) {
    if (err && err.code === "ENOENT") return null; // curriculum not written yet
    throw err;
  }
  if (files.length === 0) return null;

  const modules = [];
  for (const file of files) {
    const label = `content/curriculum/${levelSpec.dir}/${file}`;
    const { data, body } = parseFrontmatter(await readFile(path.join(dir, file), "utf8"), label);

    const periodNo = Number(data.period);
    if (!Number.isInteger(periodNo) || periodNo < 1 || periodNo > 10) {
      throw new Error(`${label}: frontmatter 'period' must be an integer 1-10, got ${data.period}`);
    }
    if (!data.title) throw new Error(`${label}: frontmatter 'title' is required`);
    // The directory decides the level; a mismatched frontmatter line is a
    // content bug worth failing on rather than silently seeding the wrong rung.
    const declared = String(data.level ?? "").replace(/-/g, "_");
    if (declared && declared !== levelSpec.level) {
      throw new Error(
        `${label}: frontmatter level '${data.level}' does not match its directory (${levelSpec.dir})`,
      );
    }
    modules.push({
      level: levelSpec.level,
      period_no: periodNo,
      slug: file.replace(/^period-\d+-/, "").replace(/\.md$/, ""),
      title: data.title,
      strand: data.strand ?? "general",
      skills: Array.isArray(data.skills) ? data.skills : [],
      content_md: body,
    });
  }

  modules.sort((a, b) => a.period_no - b.period_no);
  const seen = new Set();
  for (const m of modules) {
    if (seen.has(m.period_no)) {
      throw new Error(`${levelSpec.dir}: duplicate period ${m.period_no} in curriculum files`);
    }
    seen.add(m.period_no);
  }
  return modules;
}

// --------------------------------------------------------------------------
// Database
// --------------------------------------------------------------------------

/** Same driver selection as src/lib/db.ts: real Postgres when configured. */
async function connect() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url });
    return {
      label: "postgres (DATABASE_URL)",
      query: async (sql, params = []) => pool.query(sql, params),
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = process.env.PGLITE_DATA_DIR ?? path.join(projectRoot, ".pglite");
  const db = new PGlite(dataDir);
  await db.waitReady;
  return {
    label: `pglite (${path.relative(projectRoot, dataDir) || dataDir})`,
    query: async (sql, params = []) => db.query(sql, params),
    close: () => db.close(),
  };
}

export async function seed(db, { log = console.log } = {}) {
  const summary = { modules: 0, terms: 0, cohorts: 0, levels: [] };
  const now = new Date();
  // Admissions open immediately so a freshly seeded dev database is usable;
  // classes start in three days, which is also the retake window's breathing room.
  const opensAt = now;
  const startsAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  for (const spec of LEVELS) {
    const modules = await readModules(spec);
    const periodCount = modules ? modules.length : spec.fallbackPeriods;

    if (modules) {
      for (const m of modules) {
        await db.query(
          `insert into modules (level, period_no, slug, title, strand, skills, content_md, version)
           values ($1, $2, $3, $4, $5, array(select jsonb_array_elements_text($6::jsonb)), $7, 1)
           on conflict (level, period_no, version) do update
             set slug = excluded.slug, title = excluded.title, strand = excluded.strand,
                 skills = excluded.skills, content_md = excluded.content_md`,
          [m.level, m.period_no, m.slug, m.title, m.strand, JSON.stringify(m.skills), m.content_md],
        );
        summary.modules += 1;
      }
    } else {
      log(
        `  ! ${spec.dir}: no curriculum files yet — seeding the term and cohorts anyway ` +
          `(${spec.fallbackPeriods} periods assumed; re-run db:seed when the lessons land)`,
      );
    }

    // ends_at is derived from the real class clock: periods run back to back at
    // period_hours each, plus a 24h exam window at the end.
    const endsAt = new Date(
      startsAt.getTime() + (periodCount * spec.periodHours + 24) * 60 * 60 * 1000,
    );
    const enrollmentCap = spec.cohorts.length * COHORT_CAPACITY;

    const term = await db.query(
      `insert into terms (level, track, period_hours, slug, display_name,
                          opens_at, starts_at, ends_at, enrollment_cap, status)
       values ($1, 'standard', $2, $3, $4, $5, $6, $7, $8, 'admissions')
       on conflict (slug) do update
         set level = excluded.level, period_hours = excluded.period_hours,
             display_name = excluded.display_name, opens_at = excluded.opens_at,
             starts_at = excluded.starts_at, ends_at = excluded.ends_at,
             enrollment_cap = excluded.enrollment_cap, status = excluded.status
       returning id`,
      [
        spec.level,
        spec.periodHours,
        spec.slug,
        spec.display,
        opensAt.toISOString(),
        startsAt.toISOString(),
        endsAt.toISOString(),
        enrollmentCap,
      ],
    );
    const termId = term.rows[0].id;
    summary.terms += 1;

    // `cohorts` has no unique key on (term_id, name), so insert only what is
    // missing rather than relying on a conflict target that does not exist.
    for (const cohort of spec.cohorts) {
      const existing = await db.query(
        `select id from cohorts where term_id = $1 and name = $2 limit 1`,
        [termId, cohort.name],
      );
      if (existing.rows.length > 0) {
        await db.query(`update cohorts set band = $2, capacity = $3 where id = $1`, [
          existing.rows[0].id,
          cohort.band ?? null,
          COHORT_CAPACITY,
        ]);
      } else {
        await db.query(
          `insert into cohorts (term_id, name, band, capacity) values ($1, $2, $3, $4)`,
          [termId, cohort.name, cohort.band ?? null, COHORT_CAPACITY],
        );
        summary.cohorts += 1;
      }
    }

    summary.levels.push({
      level: spec.level,
      slug: spec.slug,
      period_hours: spec.periodHours,
      periods: periodCount,
      modules_seeded: modules ? modules.length : 0,
      cohorts: spec.cohorts.length,
      banded: spec.cohorts.some((c) => c.band),
    });
    log(
      `  ${spec.level.padEnd(17)} ${spec.slug.padEnd(12)} ` +
        `${String(periodCount).padStart(2)} periods x ${spec.periodHours}h · ` +
        `${modules ? modules.length : 0} modules · ${spec.cohorts.length} cohorts` +
        (spec.cohorts.some((c) => c.band) ? " (banded)" : ""),
    );
  }
  return summary;
}

// Run only when invoked directly, so tests can import parseFrontmatter/seed.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = await connect();
  console.log(`db:seed → ${db.label}`);
  try {
    const summary = await seed(db);
    console.log(
      `db:seed done — ${summary.modules} modules, ${summary.terms} terms, ${summary.cohorts} new cohorts`,
    );
  } finally {
    await db.close();
  }
}
