// Recreates the local PGlite dev database (.pglite/) and applies db/schema.sql
// when that file exists. Dev-only — refuses to run when DATABASE_URL is set so
// it can never touch a real Postgres.
import { rm, readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

if (process.env.DATABASE_URL) {
  console.error("db:reset only manages the local PGlite database; unset DATABASE_URL to use it.");
  process.exit(1);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(projectRoot, ".pglite");
const schemaFile = path.join(projectRoot, "db", "schema.sql");

await rm(dataDir, { recursive: true, force: true });
console.log(`recreating ${path.relative(projectRoot, dataDir)}/`);

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

await db.close();
console.log("db:reset done");
