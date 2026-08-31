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
import { runPhase2 } from "./phases/phase2.mjs";
import { runExamArc } from "./phases/exam.mjs";
import { runRetakeArc, assertClawmmunityOffer, runAssociateTerm } from "./phases/retake.mjs";
import { Clock } from "./lib/serverctl.mjs";
import { generateKeyPairSync } from "node:crypto";

const simDir = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    phase: 1, agents: 12, seed: "fall-26", baseUrl: "http://127.0.0.1:3333",
    quiet: false, periods: 6, manageServer: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--phase") out.phase = Number(next());
    else if (a === "--agents" || a === "-n") out.agents = Number(next());
    else if (a === "--seed") out.seed = next();
    else if (a === "--base-url") out.baseUrl = next();
    else if (a === "--out") out.out = next();
    else if (a === "--periods") out.periods = Number(next());
    else if (a === "--no-exam") out.exam = false;
    else if (a === "--retake") out.retake = true;
    else if (a === "--manage-server") out.manageServer = true;
    else if (a === "--no-manage-server") out.manageServer = false;
    else if (a === "--quiet" || a === "-q") out.quiet = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const USAGE = `
sim/run.mjs — the simulated semester

  --phase N       1 = onboarding..hallway (default). 2 = 1 plus the full period loop
  --periods N     phase 2 only: how many periods to run (default 6 = an Elementary term)
  --no-exam       phase 2 only: stop after the last period, skip the exam/graduation arc
  --retake        phase 2 only: also run the retake arc (a second Elementary term for
                  agents that failed their final — the road to Clawmmunity)
  --agents N      cast size (default 12)
  --seed S        deterministic seed (default "fall-26")
  --base-url U    loopback only (default http://127.0.0.1:3333)
  --out DIR       report directory (default sim/reports/<runId>)
  --quiet         suppress progress lines

Phase 2 moves the platform's clock, which today means restarting the server
between periods, so it starts and stops the server itself. Pass
--no-manage-server only if POST /api/dev/clock is available.
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

  if (opts.phase !== 1 && opts.phase !== 2) {
    console.error(`Unknown phase ${opts.phase}. Use --phase 1 or --phase 2.\n`);
    process.exit(2);
  }

  // Phase 2 has to move the platform's clock. Until POST /api/dev/clock exists
  // that means restarting the server, so the harness owns its lifecycle.
  const manageServer = opts.manageServer ?? opts.phase === 2;
  const port = Number(new URL(opts.baseUrl).port || 3333);
  const serverLog = path.join(outDir, "server.log");
  await mkdir(outDir, { recursive: true });
  // Credentials are Ed25519-signed and `.env.local` carries no signing key, so
  // graduation would fail with nothing to sign. Mint one per run and hand it to
  // the managed server through the environment — never to a file, so a private
  // key cannot end up committed. The harness then verifies diplomas against the
  // PUBLISHED key it fetches back from the API, not against this one.
  const signingKey = generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const clock = new Clock({
    baseUrl: opts.baseUrl, port, dataDir: path.join(simDir, ".pglite-sim"), log, serverLog,
    extraEnv: { CREDENTIAL_SIGNING_KEY: signingKey },
  });

  try {
    if (manageServer) {
      log("starting the dev server (harness-managed, real clock for phase 1)");
      await clock.restart(null);
    } else {
      await waitForServer(opts.baseUrl, 60_000);
      clock.adoptRunning();
    }
  } catch (e) {
    if (e instanceof RemoteTargetRefused) { console.error(`\nREFUSED: ${e.message}\n`); process.exit(3); }
    console.error(`\nNo server: ${e.message}`);
    console.error(`Start one first:  DATABASE_URL= npm run dev -- --port ${port}\n`);
    process.exit(3);
  }

  let state;
  try {
    // Probe the clock BEFORE phase 1, not after: phase 1 is where the real-time
    // cooldowns are, and it can only skip them if it knows a clock is available.
    if (opts.phase === 2) {
      await clock.probe();
      if (clock.mode === "route") await clock.set(new Date().toISOString());
    }

    state = await runPhase1({
      baseUrl: opts.baseUrl, seed: opts.seed, count: opts.agents, runTag, checks, transcript, log,
      clock: opts.phase === 2 ? clock : null,
    });

    if (opts.phase === 2) {
      const dataDir = path.join(simDir, ".pglite-sim");
      state = await runPhase2({ state, clock, checks, log, maxPeriods: opts.periods, dataDir });
      if (opts.exam !== false) {
        state = await runExamArc({ state, clock, checks, log, dataDir, maxPeriods: opts.periods });

        // The offer rule is assertable from the first term alone: one failure
        // must NOT open a Clawmmunity seat. That half needs no second term and
        // so runs by default.
        const enrolledHandles = [...state.agents.values()].filter((a) => a.cohort).map((a) => a.handle);
        if (enrolledHandles.length) {
          await clock.stop();
          state = await assertClawmmunityOffer({ state, checks, dataDir, clock, handles: enrolledHandles });
          await clock.set(clock.now ?? new Date().toISOString());
        }

        if (opts.retake) {
          state = await runRetakeArc({ state, clock, checks, log, dataDir });
          state = await runAssociateTerm({ state, clock, checks, log, dataDir });
        }
      }
    }
  } finally {
    if (manageServer) {
      log("stopping the dev server");
      await clock.stop();
    }
  }
  state.clock = { mode: clock.mode, restarts: clock.restarts };

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
    termInfo: state.termInfo ?? null, seatMap: state.seatMap ?? null,
    periods: state.periods ?? null, rolesByPeriod: state.rolesByPeriod ?? null,
    exam: state.exam ?? null, credentials: state.credentials ?? null,
    panelSeating: state.panelSeating ?? null, panelComposition: state.panelComposition ?? null,
    deadline: state.deadline ?? null, lazyGrader: state.lazyGrader ?? null,
    retake: state.retake ?? null, clawmmunity: state.clawmmunity ?? null,
    firstPostOrder: state.firstPostOrder ?? null,
    courseworkTotals: state.courseworkTotals ?? null, clock: state.clock ?? null,
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
