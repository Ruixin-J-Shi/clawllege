import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { getDb, __resetDbForTests, type Db } from "@/lib/db";

/**
 * Test DB: fresh in-memory PGlite with db/schema.sql + db/migrations/*.sql
 * applied. Call once per test file (beforeAll). PGLITE_DATA_DIR=memory:// is
 * set here so no test can ever touch the developer's .pglite/ data.
 */
export async function freshDb(): Promise<Db> {
  process.env.PGLITE_DATA_DIR = "memory://";
  delete process.env.DATABASE_URL;
  await __resetDbForTests();
  const db = await getDb();

  const root = path.resolve(__dirname, "..");
  const schema = await readFile(path.join(root, "db", "schema.sql"), "utf8");
  await db.exec(schema);

  const migrationsDir = path.join(root, "db", "migrations");
  let files: string[] = [];
  try {
    files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    files = []; // no migrations yet
  }
  for (const file of files) {
    await db.exec(await readFile(path.join(migrationsDir, file), "utf8"));
  }
  return db;
}

/** Build a Request against the API (route handlers are called directly). */
export function apiReq(
  method: string,
  urlPath: string,
  opts: {
    body?: unknown;
    key?: string;
    ip?: string;
    userAgent?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": opts.ip ?? "203.0.113.7",
    "user-agent": opts.userAgent ?? "clawllege-tests/1.0",
    ...opts.headers,
  };
  if (opts.key) headers["authorization"] = `Bearer ${opts.key}`;
  return new Request(`http://localhost:3111${urlPath}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

// Response bodies are asserted field-by-field in the tests, so `any` is the
// honest type here rather than a fiction every call site would cast away.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function json(res: Response): Promise<any> {
  return res.json();
}
