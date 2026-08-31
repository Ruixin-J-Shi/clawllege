// Loading the app's own TypeScript libraries into the harness process.
//
// Same technique `scripts/sweep.mjs` uses: Node 26 strips the types, and these
// hooks supply the paths for extensionless relative imports and the `@/*` alias.
// Nothing here modifies worker-1's code — it calls exported functions.
//
// Used for one thing the HTTP surface cannot do:
//
//  1. GRADING. `syncCohort` (the lazy path every route takes) runs
//     `advancePeriods({ grade: false })` deliberately, so a read never pays for
//     grading. Grading is the sweep's job. In production that is a cron; here it
//     is this module, called between periods.
//
// It also reads a few master-owned tables the HTTP surface does not expose yet
// (mastery meters, published highlights, grader reputation), for assertions the
// API cannot answer.
//
// ⚠️ PGlite is SINGLE-WRITER. Every function here requires the dev server to be
// STOPPED. Call them from between `clock.stop()` and the next `clock.set()`.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(appDir, "src");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      for (const ext of ["", ".ts", "/index.ts"]) {
        const candidate = path.join(SRC, specifier.slice(2)) + ext;
        if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      for (const ext of [".ts", "/index.ts", ".mjs", ".js"]) {
        try {
          const url = new URL(specifier + ext, context.parentURL);
          if (existsSync(new URL(url).pathname)) return { url: url.href, shortCircuit: true };
        } catch { /* not this extension */ }
      }
    }
    return nextResolve(specifier, context);
  },
});

let mods = null;
async function load() {
  if (mods) return mods;
  mods = {
    periods: await import(path.join(SRC, "lib/periods.ts")),
    db: await import(path.join(SRC, "lib/db.ts")),
    clock: await import(path.join(SRC, "lib/clock.ts")),
  };
  return mods;
}

/**
 * Run `fn(app)` against the sim database at a pinned instant, then close the
 * connection so the dev server can take the file back.
 */
export async function withApp({ dataDir, fakeNow }, fn) {
  process.env.DATABASE_URL = "";
  process.env.PGLITE_DATA_DIR = dataDir;
  process.env.CLAWLLEGE_FAKE_NOW = fakeNow ?? "";
  const app = await load();
  app.clock.resetClock();          // re-read the env we just changed
  if (fakeNow) app.clock.setNow(fakeNow);
  try {
    return await fn(app);
  } finally {
    // `getDb()` memoises the connection on globalThis (PGlite is single-writer,
    // so Next's dev reloads must share one). Closing the handle without clearing
    // that cache would leave the NEXT call in this process holding a closed
    // connection — which is exactly what happens on the second period's grading
    // pass. `__resetDbForTests` is the module's own escape hatch: it drops the
    // cache and closes it, so each withApp() gets a fresh connection and the
    // dev server can take the data directory back.
    try { await app.db.__resetDbForTests(); }
    catch { try { (await app.db.getDb()).close?.(); } catch { /* already gone */ } }
  }
}

/**
 * The grading pass — what `npm run sweep` does, in-process so the harness can
 * assert on the transitions it returns.
 */
export async function sweepAndGrade({ dataDir, fakeNow }) {
  return withApp({ dataDir, fakeNow }, async (app) => app.periods.advancePeriods({ grade: true }));
}

/**
 * Read-only snapshot for assertions the HTTP surface does not expose yet
 * (mastery meters, published highlights, grader reputation).
 *
 * Every query is individually guarded. These read master-owned tables whose
 * columns the harness does not control, so a schema change should degrade one
 * assertion to "unavailable" — not abort a term that otherwise ran fine. Each
 * failure is returned in `errors` and surfaces as a SKIP with the reason.
 */
export async function readClassState({ dataDir, fakeNow, cohortIds, agentIds }) {
  return withApp({ dataDir, fakeNow }, async (app) => {
    const db = await app.db.getDb();
    const errors = [];
    const q = async (label, sql, params = []) => {
      try {
        return (await db.query(sql, params)).rows;
      } catch (e) {
        errors.push(`${label}: ${String(e?.message ?? e)}`);
        return null;
      }
    };
    const periods = await q("periods",
      `select cohort_id, period_no, status from periods
        where cohort_id = any($1::uuid[]) order by cohort_id, period_no`, [cohortIds]);
    const mastery = await q("mastery",
      `select agent_id, skill_key as skill, meter as level from mastery
        where agent_id = any($1::uuid[]) and meter > 0 order by meter desc`, [agentIds]);
    const highlights = await q("highlights",
      `select id, source_kind, excerpt, nominations_count as votes, author_agent_name
         from highlights order by published_at desc`);
    const graderStats = await q("grader_stats",
      `select agent_id, reviews_scored, agreement from grader_stats
        where agent_id = any($1::uuid[])`, [agentIds]);
    const reviews = await q("peer_reviews", `select count(*)::int as n from peer_reviews`);
    return {
      periods: periods ?? [], mastery: mastery ?? [], highlights: highlights ?? [],
      graderStats: graderStats ?? [], reviewCount: reviews?.[0]?.n ?? 0,
      unavailable: errors,
    };
  });
}
