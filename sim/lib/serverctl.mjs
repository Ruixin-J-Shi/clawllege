// Moving the platform's clock from outside the platform.
//
// A simulated term has to run ten periods in seconds, so the harness must be
// able to say "it is now the middle of period 4". worker-1's `src/lib/clock.ts`
// does exactly that, but it is driven by the CLAWLLEGE_FAKE_NOW environment
// variable INSIDE the server process — and the harness is a different process.
//
// Two strategies, and the harness picks whichever is available:
//
//   (a) POST /api/dev/clock          — a dev-only route (production-inert).
//       One process, instant clock moves. worker-1 is adding this in T4;
//       `probe()` detects it at startup and uses it automatically.
//   (b) restart with a new env var   — needs nothing from anyone. Costs a few
//       seconds per clock move, which for a six-period term is well under a
//       minute. This is what runs today.
//
// Everything else in the harness is written against `Clock`, so when (a) lands
// nothing but this file changes.

import { spawn } from "node:child_process";
import { openSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForServer, sleep } from "./client.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export class Clock {
  /**
   * @param {{baseUrl:string, port:number, dataDir:string, log?:Function, serverLog?:string}} opts
   */
  constructor({ baseUrl, port, dataDir, log = () => {}, serverLog = null, extraEnv = {} }) {
    this.baseUrl = baseUrl;
    this.port = port;
    this.dataDir = dataDir;
    this.log = log;
    this.serverLog = serverLog;
    this.extraEnv = extraEnv;
    this.proc = null;
    this.mode = null;          // "route" | "restart"
    this.now = null;           // ISO string of the pinned instant
    this.restarts = 0;
    this.externallyManaged = false;
  }

  /** Decide which strategy to use. Call once, before any clock move. */
  async probe() {
    try {
      const res = await fetch(`${this.baseUrl}/api/dev/clock`, { method: "GET" });
      // Only a working 200 earns the fast path. A 404 (route absent) or a 403
      // (production-inert) both mean fall back to restarting the server.
      this.mode = res.status === 200 ? "route" : "restart";
    } catch {
      this.mode = "restart";
    }
    this.log(`clock strategy: ${this.mode === "route" ? "POST /api/dev/clock (option a)" : "server restart (option b)"}`);
    return this.mode;
  }

  /** Adopt a server this process did not start (so we never kill someone else's). */
  adoptRunning() {
    this.externallyManaged = true;
  }

  /** Start the server if it is not running, pinned at the current instant. */
  async ensureRunning() {
    if (this.externallyManaged || this.proc) return;
    await this.restart(this.now);
  }

  /** Pin the platform's clock to `iso`. */
  async set(iso) {
    this.now = iso;
    if (this.mode === "route") {
      // The harness stops the server for in-process database work (grading,
      // scheduling — PGlite is single-writer), so by the time the next clock
      // move comes the server may be down. Bring it back before posting, or the
      // route strategy fails with a bare ECONNREFUSED that looks like a
      // platform fault and is not one.
      await this.ensureRunning();
      let res;
      try {
        res = await fetch(`${this.baseUrl}/api/dev/clock`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "set", to: iso }),
        });
      } catch (e) {
        throw new Error(`POST /api/dev/clock could not be reached: ${String(e?.message ?? e)}`);
      }
      if (!res.ok) throw new Error(`POST /api/dev/clock returned ${res.status}: ${await res.text()}`);
      const body = await res.json().catch(() => ({}));
      if (body.now && body.now !== iso) {
        // Not fatal — the route reports the instant it actually landed on.
        this.now = body.now;
      }
      return { mode: "route", now: this.now };
    }
    if (this.externallyManaged) {
      throw new Error(
        "clock move needs a server restart, but the server was started outside the harness.\n" +
          "  Run through sim/run-semester.sh, or wait for POST /api/dev/clock (option a).",
      );
    }
    await this.restart(iso);
    return { mode: "restart", now: iso };
  }

  /**
   * Move the clock forward by `ms`.
   *
   * This is not a convenience — it is how the harness satisfies rate limits.
   * `rate_buckets` refill on the platform's own clock, so while that clock is
   * pinned a token bucket NEVER refills, and sleeping in real time achieves
   * exactly nothing: an agent's second reply inside one period returns 429
   * forever. Advancing simulated time is both the fix and the realistic model —
   * a real student does not fire two replies in the same millisecond.
   */
  async advance(ms) {
    const base = this.now ? new Date(this.now).getTime() : Date.now();
    return this.set(iso(base + ms));
  }

  /** Start (or replace) the dev server pinned to `iso`. */
  async restart(iso) {
    await this.stop();
    this.restarts++;
    const env = {
      ...process.env,
      DATABASE_URL: "",                      // never a real Postgres — see README
      PGLITE_DATA_DIR: this.dataDir,
      CLAWLLEGE_FAKE_NOW: iso ?? "",
      NODE_ENV: "development",               // clock overrides are inert in production
      ...this.extraEnv,
    };
    // Keep the server's output. A managed server that dies mid-period used to
    // surface only as ECONNREFUSED from the next request, with nothing to read.
    let out = "ignore";
    if (this.serverLog) {
      appendFileSync(this.serverLog, `\n===== server start @ ${iso2(iso)} (restart #${this.restarts}) =====\n`);
      out = openSync(this.serverLog, "a");
    }
    this.proc = spawn("npm", ["run", "dev", "--", "--port", String(this.port)], {
      cwd: appDir,
      env,
      detached: true,                        // own process group, so the whole
      stdio: out === "ignore" ? "ignore" : ["ignore", out, out],  // tree can be killed
    });
    this.proc.unref();
    try {
      await waitForServer(this.baseUrl, 90_000);
    } catch (e) {
      throw new Error(`${e.message}\n  server log: ${this.serverLog ?? "(not captured)"}`);
    }
  }

  /**
   * Stop the managed server and WAIT until the port is genuinely free.
   *
   * This has to be strict. `npm run dev` spawns next-server as a child, and a
   * SIGTERM to the group is not always instant. An earlier version gave up
   * after ten seconds and returned anyway; `restart()` then spawned a second
   * server while the first still held the port, so requests kept being answered
   * by the OLD process — on the OLD clock — until it finally died, at which
   * point everything in flight failed with ECONNREFUSED partway through a
   * period. Waiting properly, and escalating to SIGKILL, is the fix.
   */
  async stop() {
    if (this.externallyManaged || !this.proc) return;
    const pid = this.proc.pid;
    this.proc = null;
    try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }

    const deadline = Date.now() + 30_000;
    let escalated = false;
    while (Date.now() < deadline) {
      let listening = true;
      try {
        await fetch(`${this.baseUrl}/api/health`, { signal: AbortSignal.timeout(500) });
      } catch {
        listening = false;
      }
      if (!listening) { await sleep(150); return; }   // settle, then hand the file back
      if (!escalated && Date.now() > deadline - 20_000) {
        escalated = true;
        try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
      }
      await sleep(250);
    }
    throw new Error(
      `server on port ${this.port} did not release after SIGTERM and SIGKILL.\n` +
        "  Refusing to start a second server on the same port and the same database.",
    );
  }

  /**
   * Run `npm run sweep` at the pinned instant, in its own process with its own
   * clock.
   *
   * ⚠️ PGlite is SINGLE-WRITER: this cannot run while the dev server holds the
   * database. Stop the server first. In practice the harness rarely needs it —
   * worker-1 made the lifecycle lazy, so any class request (`GET /next`) syncs
   * the cohort to the current clock. The period loop relies on that instead,
   * which is also more honest: it is how a real agent's heartbeat advances the
   * class. This stays for out-of-band catch-up.
   */
  async sweep() {
    return new Promise((resolve) => {
      const p = spawn("npm", ["run", "sweep"], {
        cwd: appDir,
        env: {
          ...process.env,
          DATABASE_URL: "",
          PGLITE_DATA_DIR: this.dataDir,
          CLAWLLEGE_FAKE_NOW: this.now ?? "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      p.stdout.on("data", (d) => { out += d; });
      p.stderr.on("data", (d) => { out += d; });
      p.on("close", (code) => resolve({ code, out }));
    });
  }
}

export const iso = (ms) => new Date(ms).toISOString();
const iso2 = (v) => (v == null ? "real clock" : String(v));
