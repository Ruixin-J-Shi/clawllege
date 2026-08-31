// Drives period lifecycle transitions for every cohort, then grades whatever
// just closed. Safe to run on a cron, and safe to run twice: every transition
// filters on the status it expects to leave, so a second pass does nothing.
//
//   npm run sweep                                  # local PGlite dev database
//   DATABASE_URL=postgres://…  npm run sweep       # real Postgres
//   CLAWLLEGE_FAKE_NOW=2026-09-14T08:00:00Z npm run sweep   # simulated clock
//
// Exits non-zero on failure so a cron wrapper can alert.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const SRC = path.join(projectRoot, "src");

// The app's libraries are TypeScript, using extensionless relative imports and
// the `@/*` alias. Node 26 strips the types itself; this supplies the paths.
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
        } catch {}
      }
    }
    return nextResolve(specifier, context);
  },
});

const { advancePeriods } = await import(path.join(projectRoot, "src/lib/periods.ts"));
const { enforceAllDeadlines } = await import(path.join(projectRoot, "src/lib/exams/deadline.ts"));
const { getDb } = await import(path.join(projectRoot, "src/lib/db.ts"));
const { nowIso, isOverridden } = await import(path.join(projectRoot, "src/lib/clock.ts"));

const started = nowIso();
console.log(`sweep at ${started}${isOverridden() ? "  (SIMULATED CLOCK)" : ""}`);

try {
  const transitions = await advancePeriods({ grade: true });
  for (const t of transitions) {
    console.log(`  period ${t.period_no}  ${t.from} → ${t.to}  (cohort ${t.cohort_id.slice(0, 8)})`);
  }

  // Exam panels have a 24h grading deadline: finalize on >=3 filed scores, or
  // drop the silent panelists and seat replacements. Never a verdict on fewer.
  const deadlines = await enforceAllDeadlines();
  for (const d of deadlines) {
    console.log(`  exam ${d.attempt_id.slice(0, 8)}  ${d.action}  filed=${d.filed} seated=${d.seated}` +
      (d.dropped.length ? ` dropped=${d.dropped.length}` : "") + (d.added ? ` added=${d.added}` : ""));
    if (d.note) console.log(`      ${d.note}`);
  }

  if (transitions.length === 0 && deadlines.length === 0) {
    console.log("nothing due — no periods changed state, no panels overdue");
  } else {
    console.log(`sweep done — ${transitions.length} transition(s), ${deadlines.length} panel action(s)`);
  }
  const db = await getDb();
  await db.close();
} catch (err) {
  console.error("sweep failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
