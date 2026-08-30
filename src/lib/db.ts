import path from "node:path";

/**
 * Single SQL entry point for the whole app.
 *
 * - When `DATABASE_URL` is set (staging/prod → Supabase Postgres), queries go
 *   through a node-postgres pool.
 * - Otherwise (local dev/tests — no Docker on dev machines) an embedded PGlite
 *   Postgres is used, persisted at `.pglite/` in the project root (gitignored).
 *   Run `npm run db:reset` to recreate it and apply `db/schema.sql`.
 *
 * Server-only: never import from client components.
 */

/** Default row shape. `query<T>` accepts any object type, interfaces included:
 *  a `T extends Row` constraint would reject every `interface` row type in the
 *  codebase, because interfaces have no implicit index signature. */
export type Row = Record<string, unknown>;

export interface QueryOutcome<T = Row> {
  rows: T[];
  rowCount: number;
}

/** Anything you can run a parameterized query against: the pool, or one transaction. */
export interface Queryable {
  /** Parameterized query ($1, $2, …). Always use params for untrusted input. */
  query<T = Row>(sql: string, params?: unknown[]): Promise<QueryOutcome<T>>;
}

export interface Db extends Queryable {
  /** Run a multi-statement SQL script (e.g. schema files). No parameters. */
  exec(sql: string): Promise<void>;
  /**
   * Run `fn` inside ONE transaction on ONE connection, committing on return and
   * rolling back on throw. Required wherever two writes must land together —
   * e.g. a content insert plus its `relationships` upsert. Never emulate this
   * with `db.query("begin")`: under a pg Pool each query may take a different
   * connection, so the BEGIN and the writes can land on different sessions.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Data dir for the embedded dev DB. Tests set PGLITE_DATA_DIR=memory:// */
export function pgliteDataDir(): string {
  return process.env.PGLITE_DATA_DIR ?? path.join(process.cwd(), ".pglite");
}

async function createPgDb(databaseUrl: string): Promise<Db> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  return {
    async query(sql, params = []) {
      const res = await pool.query(sql, params as unknown[]);
      return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn({
          async query(sql, params = []) {
            const res = await client.query(sql, params as unknown[]);
            return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
          },
        });
        await client.query("commit");
        return out;
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function createPgliteDb(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pglite = new PGlite(pgliteDataDir());
  await pglite.waitReady;
  return {
    async query(sql, params = []) {
      const res = await pglite.query(sql, params as unknown[]);
      // Match pg semantics: rows returned for reads, affected count for writes
      // (PGlite reports affectedRows=0 on plain SELECTs).
      return {
        rows: res.rows as never[],
        rowCount: res.rows.length > 0 ? res.rows.length : (res.affectedRows ?? 0),
      };
    },
    async exec(sql) {
      await pglite.exec(sql);
    },
    async transaction(fn) {
      return pglite.transaction(async (tx) => {
        return fn({
          async query(sql, params = []) {
            const res = await tx.query(sql, params as unknown[]);
            return {
              rows: res.rows as never[],
              rowCount: res.rows.length > 0 ? res.rows.length : (res.affectedRows ?? 0),
            };
          },
        });
      }) as Promise<ReturnType<typeof fn> extends Promise<infer R> ? R : never>;
    },
    async close() {
      await pglite.close();
    },
  };
}

// Cached on globalThis so Next.js dev-mode module reloads reuse one connection
// (PGlite allows only a single writer per data dir).
const globalCache = globalThis as unknown as { __clawllegeDb?: Promise<Db> };

export function getDb(): Promise<Db> {
  if (!globalCache.__clawllegeDb) {
    const url = process.env.DATABASE_URL;
    globalCache.__clawllegeDb = url ? createPgDb(url) : createPgliteDb();
  }
  return globalCache.__clawllegeDb;
}

/** Test-only: drop the cached connection so the next getDb() starts fresh. */
export async function __resetDbForTests(): Promise<void> {
  const cached = globalCache.__clawllegeDb;
  globalCache.__clawllegeDb = undefined;
  if (cached) {
    try {
      await (await cached).close();
    } catch {
      // already closed or never opened — fine for tests
    }
  }
}
