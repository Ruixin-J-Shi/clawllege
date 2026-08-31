// Recreates the local PGlite dev database (.pglite/) and applies db/schema.sql
// when that file exists. Dev-only — refuses to run when DATABASE_URL is set so
// it can never touch a real Postgres.
import { rm, readFile, access, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

if (process.env.DATABASE_URL) {
  console.error("db:reset only manages the local PGlite database; unset DATABASE_URL to use it.");
  process.exit(1);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Honour PGLITE_DATA_DIR exactly as src/lib/db.ts and scripts/seed.mjs do.
// Hardcoding <root>/.pglite here meant `PGLITE_DATA_DIR=… npm run db:reset`
// deleted the DEFAULT database and left the intended one untouched — the env
// var was two-thirds supported, which is worse than not supported at all.
const dataDir = process.env.PGLITE_DATA_DIR ?? path.join(projectRoot, ".pglite");

// `memory://` is an ephemeral PGlite database with nothing on disk to remove.
const inMemory = dataDir.startsWith("memory:");

// GUARD (PROTOCOL.md hard rule 3): this script performs the project's only
// sanctioned recursive delete, and after PGLITE_DATA_DIR support was added the
// path it deletes is no longer hardcoded. So it is fenced: the target must
// resolve INSIDE the project. `PGLITE_DATA_DIR=sim/.pglite-sim` (what the
// simulator uses) is fine; `PGLITE_DATA_DIR=/Users/you/photos` is refused
// rather than obeyed. A destructive op driven by an environment variable has
// to be unable to leave its own project, or it is one typo from a disaster.
if (!inMemory) {
  const resolved = path.resolve(dataDir);
  const rel = path.relative(projectRoot, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    console.error(
      `db:reset refuses to delete ${resolved}: it is outside the project.\n` +
        `PGLITE_DATA_DIR must name a path inside ${projectRoot}.\n` +
        "If you really meant that directory, remove it yourself — this script will not.",
    );
    process.exit(1);
  }
}
const schemaFile = path.join(projectRoot, "db", "schema.sql");

if (inMemory) {
  console.log("PGLITE_DATA_DIR is in-memory; nothing on disk to remove.");
} else {
  await rm(dataDir, { recursive: true, force: true });
  // Show a project-relative path when it is inside the project, the absolute
  // one when it is not — "../../../../tmp/x" helps nobody.
  const rel = path.relative(projectRoot, path.resolve(dataDir));
  const shown = rel && !rel.startsWith("..") ? rel : path.resolve(dataDir);
  console.log(`recreating ${shown}/`);
}

const db = new PGlite(dataDir);
await db.waitReady;

try {
  await access(schemaFile);
  const schema = await readFile(schemaFile, "utf8");
  await db.exec(schema);
  console.log("applied db/schema.sql");
} catch (err) {
  if (err && err.code === "ENOENT") {
    console.log("db/schema.sql not found — created an empty database (schema lands later).");
  } else {
    throw err;
  }
}

// Migrations, in filename order, exactly as tests/helpers.ts applies them —
// otherwise the dev database and the test database drift apart silently.
const migrationsDir = path.join(projectRoot, "db", "migrations");
try {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    await db.exec(await readFile(path.join(migrationsDir, file), "utf8"));
    console.log(`applied db/migrations/${file}`);
  }
} catch (err) {
  if (!err || err.code !== "ENOENT") throw err; // no migrations dir yet — fine
}

await db.close();
console.log("db:reset done");
