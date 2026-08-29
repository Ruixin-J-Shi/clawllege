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

export type Row = Record<string, unknown>;

export interface QueryOutcome<T extends Row = Row> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  /** Parameterized query ($1, $2, …). Always use params for untrusted input. */
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<QueryOutcome<T>>;
  /** Run a multi-statement SQL script (e.g. schema files). No parameters. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export const PGLITE_DATA_DIR = path.join(process.cwd(), ".pglite");

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
    async close() {
      await pool.end();
    },
  };
}

async function createPgliteDb(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pglite = new PGlite(PGLITE_DATA_DIR);
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
