import { afterEach, describe, expect, it } from "vitest";
import {
  DAY,
  HOUR,
  advanceBy,
  isOverridden,
  now,
  nowIso,
  nowMs,
  resetClock,
  setNow,
} from "@/lib/clock";

/** The test clock worker-3's simulated semester runs on. */

afterEach(() => {
  resetClock();
  delete process.env.CLAWLLEGE_FAKE_NOW;
  delete process.env.NODE_ENV_OVERRIDE;
});

describe("clock", () => {
  it("tracks real time until pinned", () => {
    expect(isOverridden()).toBe(false);
    const drift = Math.abs(nowMs() - Date.now());
    expect(drift).toBeLessThan(1000);
  });

  it("pins to an ISO string, a Date, or epoch ms — all three agree", () => {
    setNow("2026-09-14T08:00:00.000Z");
    expect(nowIso()).toBe("2026-09-14T08:00:00.000Z");
    expect(isOverridden()).toBe(true);

    const asDate = new Date("2026-09-14T08:00:00.000Z");
    setNow(asDate);
    expect(nowMs()).toBe(asDate.getTime());

    setNow(asDate.getTime());
    expect(now().toISOString()).toBe("2026-09-14T08:00:00.000Z");
  });

  it("advances by a duration, and advanceBy pins an unpinned clock", () => {
    setNow("2026-09-14T08:00:00.000Z");
    advanceBy(8 * HOUR); // one elementary period
    expect(nowIso()).toBe("2026-09-14T16:00:00.000Z");
    advanceBy(DAY);
    expect(nowIso()).toBe("2026-09-15T16:00:00.000Z");
    advanceBy(-HOUR); // time travel backwards is allowed for fixtures
    expect(nowIso()).toBe("2026-09-15T15:00:00.000Z");

    resetClock();
    expect(isOverridden()).toBe(false);
    advanceBy(HOUR); // pins at real-now, then moves
    expect(isOverridden()).toBe(true);
    expect(nowMs()).toBeGreaterThan(Date.now() + HOUR - 5000);
  });

  it("releases back to real time with setNow(null) and resetClock()", () => {
    setNow("2026-01-01T00:00:00.000Z");
    setNow(null);
    expect(isOverridden()).toBe(false);
    expect(Math.abs(nowMs() - Date.now())).toBeLessThan(1000);

    setNow("2026-01-01T00:00:00.000Z");
    resetClock();
    expect(isOverridden()).toBe(false);
  });

  it("reads CLAWLLEGE_FAKE_NOW from the environment", () => {
    process.env.CLAWLLEGE_FAKE_NOW = "2026-10-02T12:00:00.000Z";
    resetClock(); // forget the cached read so the env is picked up
    expect(isOverridden()).toBe(true);
    expect(nowIso()).toBe("2026-10-02T12:00:00.000Z");

    // Epoch milliseconds are accepted too.
    process.env.CLAWLLEGE_FAKE_NOW = String(Date.UTC(2026, 8, 14, 8, 0, 0));
    resetClock();
    expect(nowIso()).toBe("2026-09-14T08:00:00.000Z");

    // An empty value means "no override", not "epoch 0".
    process.env.CLAWLLEGE_FAKE_NOW = "";
    resetClock();
    expect(isOverridden()).toBe(false);
  });

  it("rejects unparseable instants instead of silently sitting at epoch 0", () => {
    expect(() => setNow("not a date")).toThrow(/cannot parse instant/);
    expect(() => setNow(Number.NaN)).toThrow(/invalid epoch ms/);
    expect(() => setNow(new Date("nonsense"))).toThrow(/invalid Date/);
    process.env.CLAWLLEGE_FAKE_NOW = "also not a date";
    resetClock();
    expect(() => nowMs()).toThrow(/cannot parse instant/);
  });

  it("IGNORES every override in production", () => {
    const original = process.env.NODE_ENV;
    try {
      // NODE_ENV is readonly in the Next types but writable at runtime.
      (process.env as Record<string, string>).NODE_ENV = "production";
      resetClock();
      setNow("2020-01-01T00:00:00.000Z");
      expect(isOverridden()).toBe(false);
      expect(Math.abs(nowMs() - Date.now())).toBeLessThan(1000);

      process.env.CLAWLLEGE_FAKE_NOW = "2020-01-01T00:00:00.000Z";
      resetClock();
      expect(Math.abs(nowMs() - Date.now())).toBeLessThan(1000);

      advanceBy(DAY); // inert
      expect(Math.abs(nowMs() - Date.now())).toBeLessThan(1000);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = original;
      resetClock();
    }
  });
});
