#!/usr/bin/env node
// Builds the simulator its OWN database, isolated from the shared dev one.
//
// Why this exists. The first working run of the harness lost its data between
// the HTTP phase and the verification phase, because another build session ran
// `npm run db:reset` on the shared `.pglite` in between. Anything the sim
// asserts about persisted state has to be immune to that.
//
// `src/lib/db.ts` and `scripts/seed.mjs` both honour `PGLITE_DATA_DIR`, so the
// sim simply runs the server against `sim/.pglite-sim` instead. Consequences:
//   * another session's `db:reset` cannot touch the sim's data
//   * the sim can reset its OWN database freely, so every run starts from an
//     empty, fully seeded term instead of inheriting cohorts filled by earlier runs
//   * the shared `.pglite` is never opened, read or written by the harness
//
// NOTE: `scripts/db-reset.mjs` hardcodes `<root>/.pglite` and ignores
// PGLITE_DATA_DIR, so it is deliberately NOT used here — calling it would wipe
// the shared database. This script applies the schema itself instead.
//
//   node sim/prepare-db.mjs           # create if absent, otherwise leave alone
//   node sim/prepare-db.mjs --fresh   # delete and rebuild the sim database

import { rm, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const simDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(simDir, "..");
export const SIM_DATA_DIR = path.join(simDir, ".pglite-sim");

/** The only path this script is ever permitted to remove. */
const REMOVABLE_SUFFIX = path.join("clawllege", "sim", ".pglite-sim");

/**
 * Refuse to delete anything that is not the sim's own database. Belt and braces
 * against a future edit that makes the path a variable, an argument, or an
 * interpolation — the failure mode then is a loud abort, not a wide delete.
 */
function assertRemovable(target) {
  const resolved = path.resolve(target);
  if (!resolved.endsWith(REMOVABLE_SUFFIX)) {
    throw new Error(
      `refusing to remove ${resolved}\n` +
        `  This script may only ever remove a path ending in ${REMOVABLE_SUFFIX}.`,
    );
  }
  if (!resolved.startsWith(path.resolve(projectRoot) + path.sep)) {
    throw new Error(`refusing to remove ${resolved}: outside the project root.`);
  }
}

async function main() {
  const fresh = process.argv.includes("--fresh");

  if (process.env.DATABASE_URL) {
    console.error("DATABASE_URL is set. The simulator only ever builds a LOCAL PGlite");
    console.error("database; refusing to touch a real Postgres. Unset it and re-run.\n");
    process.exit(3);
  }

  const existed = existsSync(SIM_DATA_DIR);
  if (fresh && existed) {
    // The one destructive filesystem operation in the harness, and it lives here
    // rather than in an ad-hoc shell command on purpose (PROTOCOL.md Hard Rule 3:
    // `rm -rf` never appears in a command composed at runtime; sanctioned
    // destructive ops live only in checked-in scripts recreating their own
    // disposable data — the same shape as scripts/db-reset.mjs).
    //
    // The guard below is not decoration. It makes the blast radius something the
    // code enforces rather than something a reader has to trust: this can only
    // ever remove a directory whose resolved path is exactly the sim's own
    // database, inside this project. Anything else aborts before touching disk.
    assertRemovable(SIM_DATA_DIR);
    console.log(`removing ${path.relative(projectRoot, SIM_DATA_DIR)}/  (the sim's own disposable database)`);
    await rm(SIM_DATA_DIR, { recursive: true, force: true });
  } else if (existed) {
    console.log(`sim database already present at ${path.relative(projectRoot, SIM_DATA_DIR)}/ (use --fresh to rebuild)`);
    return;
  }

  await mkdir(path.dirname(SIM_DATA_DIR), { recursive: true });
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite(SIM_DATA_DIR);
  await db.waitReady;

  const schemaPath = path.join(projectRoot, "db", "schema.sql");
  console.log(`applying ${path.relative(projectRoot, schemaPath)}`);
  await db.exec(await readFile(schemaPath, "utf8"));

  const migrationsDir = path.join(projectRoot, "db", "migrations");
  if (existsSync(migrationsDir)) {
    const { readdir } = await import("node:fs/promises");
    for (const f of (await readdir(migrationsDir)).filter((x) => x.endsWith(".sql")).sort()) {
      console.log(`applying migrations/${f}`);
      await db.exec(await readFile(path.join(migrationsDir, f), "utf8"));
    }
  }
  await db.close();

  // Seed through the app's own seeder, so curriculum, terms, period_hours and
  // banded cohorts come from one source of truth rather than a sim copy of it.
  process.env.PGLITE_DATA_DIR = SIM_DATA_DIR;
  const { seed } = await import(path.join(projectRoot, "scripts", "seed.mjs"));
  const db2 = new PGlite(SIM_DATA_DIR);
  await db2.waitReady;
  const summary = await seed({
    label: "pglite (sim)",
    query: async (sql, params = []) => {
      const r = await db2.query(sql, params);
      return { rows: r.rows, rowCount: r.rows.length > 0 ? r.rows.length : (r.affectedRows ?? 0) };
    },
    close: () => db2.close(),
  });
  await db2.close();
  console.log(`seeded — ${summary.modules} modules, ${summary.terms} terms, ${summary.cohorts} cohorts`);
  console.log(`sim database ready at ${path.relative(projectRoot, SIM_DATA_DIR)}/\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("prepare-db failed:", e); process.exit(4); });
}
