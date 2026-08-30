#!/usr/bin/env node
// The simulated semester. N scripted agents run a term against the REAL API
// over HTTP: integration test, demo-content generator and load sanity check.
//
//   node sim/run.mjs --phase 1
//   node sim/run.mjs --phase 1 --agents 12 --seed fall-26 --base-url http://127.0.0.1:3333
//
// Exits non-zero if any assertion failed. Reports land in sim/reports/<run>/.
//
// SAFETY: refuses any non-loopback --base-url (see lib/client.mjs). This
// harness writes agents, keys and enrolments; it must never touch a deployed
// environment. It also never resets or seeds the database — the dev PGlite file
// is shared with the other build sessions, so the sim adapts to whatever state
// it finds and reports it, rather than clearing anyone's work.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Checks } from "./lib/assert.mjs";
import { waitForServer, RemoteTargetRefused } from "./lib/client.mjs";
import { renderReport } from "./lib/report.mjs";
import { runPhase1 } from "./phases/phase1.mjs";

const simDir = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { phase: 1, agents: 12, seed: "fall-26", baseUrl: "http://127.0.0.1:3333", quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--phase") out.phase = Number(next());
    else if (a === "--agents" || a === "-n") out.agents = Number(next());
    else if (a === "--seed") out.seed = next();
    else if (a === "--base-url") out.baseUrl = next();
    else if (a === "--out") out.out = next();
    else if (a === "--quiet" || a === "-q") out.quiet = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const USAGE = `
sim/run.mjs — the simulated semester

  --phase N       1 = onboarding..hallway (default). 2 = full period loop (see sim/PHASE2.md)
  --agents N      cast size (default 12)
  --seed S        deterministic seed (default "fall-26")
  --base-url U    loopback only (default http://127.0.0.1:3333)
  --out DIR       report directory (default sim/reports/<runId>)
  --quiet         suppress progress lines
`;

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(String(e.message)); console.error(USAGE); process.exit(2); }
  if (opts.help) { console.log(USAGE); return; }

  const log = opts.quiet ? () => {} : (m) => console.log(`  ${m}`);
  // Run tag makes every handle unique per run, so the shared dev database can
  // be re-run against without collisions and without being reset.
  const runTag = Math.abs(hash(`${opts.seed}|${Date.now()}`)).toString(36).slice(0, 5);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${runTag}`;
  const outDir = opts.out ?? path.join(simDir, "reports", runId);

  console.log(`\nClawllege simulated semester`);
  console.log(`  phase ${opts.phase} · ${opts.agents} agents · seed "${opts.seed}" · ${opts.baseUrl}\n`);

  const checks = new Checks();
  const transcript = [];
  const t0 = Date.now();

  try {
    await waitForServer(opts.baseUrl, 60_000);
  } catch (e) {
    if (e instanceof RemoteTargetRefused) { console.error(`\nREFUSED: ${e.message}\n`); process.exit(3); }
    console.error(`\nNo server: ${e.message}`);
    console.error(`Start one first:  DATABASE_URL= npm run dev -- --port 3333\n`);
    process.exit(3);
  }

  if (opts.phase !== 1) {
    console.error(`Phase ${opts.phase} is not active yet. Its design is written up in sim/PHASE2.md;`);
    console.error(`it activates once worker-1's period lifecycle and test clock land.\n`);
    process.exit(2);
  }

  const state = await runPhase1({
    baseUrl: opts.baseUrl, seed: opts.seed, count: opts.agents, runTag, checks, transcript, log,
  });

  const meta = {
    runId, runTag, phase: opts.phase, seed: opts.seed, baseUrl: opts.baseUrl,
    durationMs: Date.now() - t0,
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "report.md"), renderReport({ state, checks, meta, transcript }));
  await writeFile(path.join(outDir, "transcript.json"), JSON.stringify(transcript, null, 2));
  await writeFile(path.join(outDir, "state.json"), JSON.stringify(serialize(state), null, 2));

  const c = checks.counts;
  console.log(`\n  ${c.FAIL === 0 ? "PASS" : "FAIL"} — ${c.PASS} passed, ${c.FAIL} failed, ${c.SKIP} skipped`);
  for (const f of checks.failed) console.log(`   ❌ ${f.name} — ${f.detail}`);
  console.log(`\n  report: ${path.relative(process.cwd(), path.join(outDir, "report.md"))}`);
  console.log(`  next:   node sim/verify-db.mjs --run ${runId}   (stop the dev server first)\n`);
  process.exit(c.FAIL === 0 ? 0 : 1);
}

/** state minus live clients/rng, so it can be JSON'd for verify-db.mjs */
function serialize(state) {
  return {
    started: state.started, finished: state.finished, waitlisted: state.waitlisted,
    agents: [...state.agents.values()].map((a) => ({
      handle: a.handle, agentId: a.agentId, persona: a.persona, quality: a.quality,
      score: a.score, band: a.band, cohort: a.cohort ?? null,
      messages: a.messages.length, repliedTo: a.repliedTo,
    })),
    cohorts: [...state.cohorts.values()].map((c) => ({
      id: c.id, name: c.name, band: c.band, members: c.members,
      messages: (c.messages ?? []).length, feedCount: c.feedCount ?? null,
    })),
  };
}

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h | 0;
}

main().catch((e) => { console.error("\nsim crashed:", e); process.exit(4); });
