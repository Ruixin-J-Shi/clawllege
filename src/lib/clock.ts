/**
 * The one clock.
 *
 * Every time-dependent decision in the app reads the current instant from
 * here — period transitions, retake gaps, rate-limit windows, `next_poll_at`,
 * attendance deadlines. Nothing calls `Date.now()` or `new Date()` directly,
 * because a simulated semester has to be able to run ten periods in a second.
 *
 * PRODUCTION IGNORES OVERRIDES. When `NODE_ENV === "production"` the setters
 * are inert and the env var is not read, so a fake clock can never ship.
 *
 * ---------------------------------------------------------------------------
 * IMPORTANT for anyone simulating time (worker-3's harness):
 * this clock moves the APPLICATION's idea of now, not the DATABASE's. Postgres
 * `now()` keeps returning real wall-clock time. So any SQL that decides
 * something time-dependent must take the instant as a PARAMETER from this
 * module rather than calling `now()` inline:
 *
 *     await db.query(`update periods set status = 'open'
 *                      where opens_at <= $1::timestamptz`, [nowIso()]);   // ✅
 *     await db.query(`... where opens_at <= now()`);                      // ❌
 *
 * Row-stamping defaults (`created_at timestamptz default now()`) are left
 * alone on purpose: they record when a row was really written, which is what
 * you want in an audit trail even during a simulation.
 * ---------------------------------------------------------------------------
 */

const FAKE_NOW_ENV = "CLAWLLEGE_FAKE_NOW";

/** Overrides live on globalThis so Next's module reloads cannot reset them. */
const store = globalThis as unknown as { __clawllegeFakeNow?: number | null };

function overridesAllowed(): boolean {
  return process.env.NODE_ENV !== "production";
}

/** Parse an ISO-8601 string or epoch-milliseconds number. Throws on garbage. */
function parseInstant(value: Date | string | number): number {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("clock: invalid Date");
    return value.getTime();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`clock: invalid epoch ms ${value}`);
    return value;
  }
  const trimmed = value.trim();
  // A bare integer string is epoch ms; anything else must be a date string.
  const asNumber = /^-?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  const ms = Number.isFinite(asNumber) ? asNumber : new Date(trimmed).getTime();
  if (Number.isNaN(ms)) throw new Error(`clock: cannot parse instant ${JSON.stringify(value)}`);
  return ms;
}

/** Read the env override once per process, then cache it in the store. */
function envOverride(): number | null {
  const raw = process.env[FAKE_NOW_ENV];
  if (!raw || raw.trim() === "") return null;
  return parseInstant(raw);
}

/** Current epoch milliseconds — the value everything else is derived from. */
export function nowMs(): number {
  if (!overridesAllowed()) return Date.now();
  if (store.__clawllegeFakeNow === undefined) {
    store.__clawllegeFakeNow = envOverride();
  }
  return store.__clawllegeFakeNow ?? Date.now();
}

/** Current instant as a Date. */
export function now(): Date {
  return new Date(nowMs());
}

/** Current instant as an ISO-8601 string — the form SQL parameters want. */
export function nowIso(): string {
  return new Date(nowMs()).toISOString();
}

/** True when a fake clock is in effect (always false in production). */
export function isOverridden(): boolean {
  if (!overridesAllowed()) return false;
  if (store.__clawllegeFakeNow === undefined) store.__clawllegeFakeNow = envOverride();
  return store.__clawllegeFakeNow !== null;
}

/**
 * Pin the clock. `null` releases it back to real time.
 * No-op in production.
 */
export function setNow(value: Date | string | number | null): void {
  if (!overridesAllowed()) return;
  store.__clawllegeFakeNow = value === null ? null : parseInstant(value);
}

/**
 * Move a pinned clock forward (or back, with a negative value) by milliseconds.
 * Pins the clock at real-now first if it was not already pinned, so
 * `advanceBy(HOURS)` works without a preceding `setNow`.
 */
export function advanceBy(ms: number): Date {
  if (!overridesAllowed()) return new Date(Date.now());
  if (!Number.isFinite(ms)) throw new Error(`clock: advanceBy needs a finite number, got ${ms}`);
  const base = store.__clawllegeFakeNow ?? Date.now();
  store.__clawllegeFakeNow = base + ms;
  return new Date(store.__clawllegeFakeNow);
}

/** Release the clock and forget the cached env read. */
export function resetClock(): void {
  store.__clawllegeFakeNow = undefined;
}

/** Handy durations, so callers stop writing 60 * 60 * 1000 by hand. */
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
