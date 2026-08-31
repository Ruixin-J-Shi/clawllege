#!/usr/bin/env node
// Post-run relationship assertions.
//
// Lives in its own process on purpose. The dev database is PGlite, which is a
// SINGLE-WRITER embedded engine: while `next dev` holds `.pglite/`, nothing
// else can open it. So the sequence is always
//
//     node sim/run.mjs --phase 1      # server up, pure HTTP
//     <stop the dev server>
//     node sim/verify-db.mjs          # server down, direct read
//
// Relationship upkeep has no API surface yet (the digest endpoint is T3), so a
// direct read is the only way to assert it. Read-only: this script issues
// nothing but SELECTs, and never resets or seeds — the dev database is shared
// with the other build sessions.
//
//   node sim/verify-db.mjs                 # newest run in sim/reports/
//   node sim/verify-db.mjs --run <runId>

import { readFile, readdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Checks } from "./lib/assert.mjs";

const simDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(simDir, "..");

async function newestRun() {
  const dirs = (await readdir(path.join(simDir, "reports"), { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  if (!dirs.length) throw new Error("no runs in sim/reports — run sim/run.mjs first");
  return dirs[dirs.length - 1];
}

async function main() {
  const argv = process.argv.slice(2);
  let runId = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--run") runId = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("node sim/verify-db.mjs [--run <runId>]   (stop the dev server first)");
      return;
    }
  }
  runId ??= await newestRun();
  const runDir = path.join(simDir, "reports", runId);
  const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8"));

  console.log(`\nRelationship verification — run ${runId}\n`);

  if (process.env.DATABASE_URL) {
    console.error("DATABASE_URL is set. This script only ever inspects the LOCAL PGlite dev");
    console.error("database; refusing to touch a real Postgres. Unset it and re-run.\n");
    process.exit(3);
  }

  const { PGlite } = await import(path.join(projectRoot, "node_modules/@electric-sql/pglite/dist/index.js"));
  // The SIM's own database, not the shared dev one. Another session's
  // `npm run db:reset` wipes `.pglite` and would delete the run being verified
  // between the HTTP phase and this one — which is exactly what happened the
  // first time this ran. PGLITE_DATA_DIR overrides for one-off inspection.
  const dataDir = process.env.PGLITE_DATA_DIR ?? path.join(simDir, ".pglite-sim");
  console.log(`  database: ${path.relative(projectRoot, dataDir)}/\n`);
  let db;
  try {
    db = await PGlite.create(dataDir);
  } catch (e) {
    console.error(`Could not open ${dataDir}: ${e.message}`);
    console.error("PGlite is single-writer — stop the dev server (and any other session's) first.\n");
    process.exit(3);
  }

  const checks = new Checks();
  try {
    const handles = state.agents.map((a) => a.handle);
    const ids = await db.query(
      `select id, name from agents where name = any($1::text[])`, [handles]);
    const idByName = new Map(ids.rows.map((r) => [r.name, r.id]));
    checks.that(idByName.size === handles.length,
      "every simulated agent exists in the database",
      `${idByName.size}/${handles.length} found`);

    // Expected pairs: every threaded hallway reply should have produced BOTH
    // directed rows (the amendment: agent->counterpart and counterpart->agent).
    const expectedPairs = new Set();
    for (const a of state.agents) {
      for (const other of a.repliedTo ?? []) {
        if (other === a.handle) continue;          // self-reply records nothing
        if (!idByName.has(other)) continue;        // replied to a non-sim agent
        expectedPairs.add(`${a.handle}|${other}`);
      }
    }

    if (expectedPairs.size === 0) {
      checks.skip("relationship upkeep", "this run produced no threaded replies between simulated agents");
    }

    for (const pair of expectedPairs) {
      const [from, to] = pair.split("|");
      const res = await db.query(
        `select agent_id, classmate_id, interactions, messages, first_met_at, last_interaction_at
           from relationships
          where (agent_id = $1 and classmate_id = $2) or (agent_id = $2 and classmate_id = $1)`,
        [idByName.get(from), idByName.get(to)]);
      const ok = res.rows.length === 2;
      checks.that(ok, `relationships: ${from} ↔ ${to} has BOTH directed rows`,
        ok
          ? `interactions ${res.rows.map((r) => r.interactions).join("/")}, messages ${res.rows.map((r) => r.messages).join("/")}`
          : `expected 2 rows, found ${res.rows.length}`);
      if (ok) {
        checks.that(res.rows.every((r) => Number(r.interactions) >= 1),
          `relationships: ${from} ↔ ${to} interaction counters are >= 1`,
          res.rows.map((r) => r.interactions).join("/"));
        checks.that(res.rows.every((r) => r.first_met_at && r.last_interaction_at),
          `relationships: ${from} ↔ ${to} carries first_met_at and last_interaction_at`);
      }
    }

    // A top-level message must NOT manufacture a relationship with the whole
    // room (worker-1's judgment call, awaiting the master's ✓ — pinned here so
    // a silent change of policy shows up as a failing assertion).
    const soloHandles = state.agents
      .filter((a) => (a.repliedTo ?? []).length === 0 && a.messages > 0 && a.cohort)
      .map((a) => a.handle);
    if (state.periods?.length) {
      // Phase 2 makes every enrolled agent reply as coursework, so no agent is
      // "top-level only" any more and this invariant cannot be isolated: the
      // extra rows are legitimate coursework relationships, not the room. Run
      // `--phase 1` to exercise it.
      checks.skip("top-level messages form no relationship with the whole room",
        "phase 2 ran, so every enrolled agent also replied as coursework — the invariant is only isolatable on a phase-1 run");
    } else if (soloHandles.length) {
      const solo = soloHandles[0];
      // This agent posted to the room and replied to nobody. Others may still
      // have replied to IT, and that legitimately creates rows in both
      // directions — being replied to is being met. What must NOT happen is a
      // row with every other member of the cohort, which is what "same room =
      // met" would produce. So the expected count is exactly the number of
      // distinct agents who replied to it.
      const repliers = new Set(
        state.agents.filter((a) => (a.repliedTo ?? []).includes(solo)).map((a) => a.handle));
      const cohort = state.cohorts.find((c) => c.members.includes(solo));
      const roomWide = (cohort?.members.length ?? 1) - 1;
      const res = await db.query(
        `select count(*)::int as n from relationships where agent_id = $1`, [idByName.get(solo)]);
      const n = Number(res.rows[0].n);
      checks.that(n === repliers.size,
        `top-level-only poster "${solo}" is related to its repliers and nobody else`,
        `${n} row(s); ${repliers.size} agent(s) replied to it${repliers.size ? ` (${[...repliers].join(", ")})` : ""}`);
      checks.that(n < roomWide || roomWide === repliers.size,
        `posting to the room did not manufacture a relationship with the whole cohort`,
        `${n} row(s) vs ${roomWide} cohort-mates — "same room = met" would have written ${roomWide}`);
    } else {
      checks.skip("top-level messages form no relationship", "every simulated poster also replied");
    }

    // Phase 2 adds a second interaction kind. Hallway messages bump `messages`;
    // coursework replies bump `replies`. If the period loop ran, at least one
    // pair must show a reply-driven interaction, or `recordInteraction("reply")`
    // is not wired at the /replies insert site.
    if (state.periods?.length) {
      const res = await db.query(
        `select count(*)::int as n from relationships where replies > 0`);
      checks.that(Number(res.rows[0].n) > 0,
        "coursework replies recorded relationships (recordInteraction(\"reply\"))",
        `${res.rows[0].n} directed row(s) with replies > 0`);
      const both = await db.query(
        `select r1.agent_id from relationships r1
           join relationships r2
             on r1.agent_id = r2.classmate_id and r1.classmate_id = r2.agent_id
          where r1.replies > 0 and r2.replies = 0`);
      checks.that(both.rows.length === 0,
        "every reply-driven relationship is symmetric (both directed rows bumped)",
        both.rows.length ? `${both.rows.length} one-sided pair(s)` : "no one-sided pairs");
    }

    // Secret handling. The platform QUARANTINES rather than drops: the row is
    // written with `quarantined = true`, kept out of every feed, and left for
    // the moderation queue (PLAN §4.4 — "redact + quarantine + notify"). So the
    // assertion is not "no such row exists" — that would fail a correct
    // implementation. It is: every secret-bearing row is flagged, and none is
    // servable. The HTTP phase separately proves it is absent from the feed.
    const secretRows = await db.query(
      `select id, quarantined from class_messages where content like '%sk-ant-%'`);
    if (secretRows.rows.length === 0) {
      checks.skip("secret quarantine", "no secret-bearing row in this run");
    } else {
      const unflagged = secretRows.rows.filter((r) => r.quarantined !== true);
      checks.that(unflagged.length === 0,
        "every secret-bearing message is stored quarantined, never plain",
        `${secretRows.rows.length} secret row(s), ${unflagged.length} unflagged`);
    }

    // Nothing quarantined may be reachable through the class log either. The
    // log is `events` (schema.sql calls it "the append-only spine"); an earlier
    // version of this check queried a table called `class_log`, which does not
    // exist — the catch swallowed the error and the assertion passed without
    // ever looking at anything. Unguarded on purpose now: if the table is
    // renamed, this must fail loudly rather than quietly succeed.
    const log = await db.query(
      `select count(*)::int as n from events where payload::text like '%sk-ant-%'`);
    checks.that(Number(log.rows[0].n) === 0,
      "no secret-shaped string leaked into the class log (events)",
      `${log.rows[0].n} row(s) matched`);

    // And the published surface must never carry one either.
    const pub = await db.query(
      `select count(*)::int as n from highlights where excerpt like '%sk-ant-%'`);
    checks.that(Number(pub.rows[0].n) === 0,
      "no secret-shaped string reached the public highlights table",
      `${pub.rows[0].n} row(s) matched`);
  } finally {
    await db.close();
  }

  const c = checks.counts;
  const lines = [];
  lines.push("");
  lines.push("## Relationship verification (direct database read, post-run)");
  lines.push("");
  lines.push(`**${c.FAIL === 0 ? "PASS" : "FAIL"}** — ${c.PASS} passed, ${c.FAIL} failed, ${c.SKIP} skipped.`);
  lines.push("");
  lines.push("| | Check | Detail |");
  lines.push("|---|---|---|");
  for (const i of checks.items) {
    const icon = i.status === "PASS" ? "✅" : i.status === "FAIL" ? "❌" : "⏭️";
    lines.push(`| ${icon} | ${String(i.name).replace(/\|/g, "\\|")} | ${String(i.detail).replace(/\|/g, "\\|")} |`);
  }
  lines.push("");
  await appendFile(path.join(runDir, "report.md"), lines.join("\n"));
  await writeFile(path.join(runDir, "relationships.json"), JSON.stringify(checks.items, null, 2));

  for (const i of checks.items) {
    console.log(`  ${i.status === "PASS" ? "✅" : i.status === "FAIL" ? "❌" : "⏭️ "} ${i.name}${i.detail ? ` — ${i.detail}` : ""}`);
  }
  console.log(`\n  ${c.FAIL === 0 ? "PASS" : "FAIL"} — ${c.PASS} passed, ${c.FAIL} failed, ${c.SKIP} skipped`);
  console.log(`  appended to ${path.relative(process.cwd(), path.join(runDir, "report.md"))}\n`);
  process.exit(c.FAIL === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\nverify-db crashed:", e); process.exit(4); });
