import { afterEach, describe, expect, it } from "vitest";
import { apiReq, json } from "./helpers";
import { isOverridden, nowIso, resetClock, DAY, HOUR } from "@/lib/clock";
import { GET as readClock, POST as driveClock } from "@/app/api/dev/clock/route";

/**
 * The dev clock route worker-3's harness drives. Two things matter here: that
 * it works out of process, and that it is completely inert in production.
 */

afterEach(() => resetClock());

describe("POST /api/dev/clock", () => {
  it("sets an absolute instant", async () => {
    const res = await driveClock(
      apiReq("POST", "/api/dev/clock", { body: { action: "set", to: "2026-09-14T00:00:00.000Z" } }),
    );
    expect(res.status).toBe(200);
    expect((await json(res)).now).toBe("2026-09-14T00:00:00.000Z");
    expect(nowIso()).toBe("2026-09-14T00:00:00.000Z");
    expect(isOverridden()).toBe(true);
  });

  it("advances by ms, minutes, hours or days", async () => {
    await driveClock(apiReq("POST", "/api/dev/clock", { body: { action: "set", to: "2026-09-14T00:00:00.000Z" } }));

    await driveClock(apiReq("POST", "/api/dev/clock", { body: { action: "advance", hours: 8 } }));
    expect(nowIso()).toBe("2026-09-14T08:00:00.000Z"); // one elementary period

    await driveClock(apiReq("POST", "/api/dev/clock", { body: { action: "advance", days: 1 } }));
    expect(nowIso()).toBe("2026-09-15T08:00:00.000Z");

    await driveClock(apiReq("POST", "/api/dev/clock", { body: { action: "advance", ms: -1 * HOUR } }));
    expect(nowIso()).toBe("2026-09-15T07:00:00.000Z"); // backwards, for fixtures

    await driveClock(apiReq("POST", "/api/dev/clock", { body: { action: "advance", minutes: 30 } }));
    expect(nowIso()).toBe("2026-09-15T07:30:00.000Z");
  });

  it("resets back to real time", async () => {
    await driveClock(apiReq("POST", "/api/dev/clock", { body: { action: "set", to: "2020-01-01T00:00:00Z" } }));
    const res = await driveClock(apiReq("POST", "/api/dev/clock", { body: { action: "reset" } }));
    expect((await json(res)).overridden).toBe(false);
    expect(Math.abs(Date.parse(nowIso()) - Date.now())).toBeLessThan(1000);
  });

  it("reads the clock without changing it", async () => {
    await driveClock(apiReq("POST", "/api/dev/clock", { body: { action: "set", to: "2026-10-02T12:00:00.000Z" } }));
    const body = await json(await readClock());
    expect(body).toEqual({ now: "2026-10-02T12:00:00.000Z", overridden: true });
  });

  it("rejects nonsense rather than silently sitting at epoch 0", async () => {
    expect((await driveClock(apiReq("POST", "/api/dev/clock", { body: { action: "wind" } }))).status).toBe(422);
    expect((await driveClock(apiReq("POST", "/api/dev/clock", { body: { action: "set", to: "yesterday" } }))).status).toBe(422);
    expect((await driveClock(apiReq("POST", "/api/dev/clock", { body: { action: "set" } }))).status).toBe(422);
    expect((await driveClock(apiReq("POST", "/api/dev/clock", { body: { action: "advance" } }))).status).toBe(422);
    expect((await driveClock(apiReq("POST", "/api/dev/clock", { body: [] }))).status).toBe(422);
  });

  it("IS INERT IN PRODUCTION — and does not admit it exists", async () => {
    const original = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string>).NODE_ENV = "production";
      const before = nowIso();

      const post = await driveClock(
        apiReq("POST", "/api/dev/clock", { body: { action: "set", to: "2020-01-01T00:00:00Z" } }),
      );
      expect(post.status).toBe(404);
      const body = await json(post);
      expect(body.error.code).toBe("not_found");
      // Nothing in the response hints at a clock — an agent must not learn
      // this endpoint exists, let alone that it is disabled.
      expect(JSON.stringify(body).toLowerCase()).not.toContain("clock");

      expect((await readClock()).status).toBe(404);
      // The clock did not move.
      expect(Math.abs(Date.parse(nowIso()) - Date.parse(before))).toBeLessThan(2000);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = original;
      resetClock();
    }
  });
});

describe("rate limiting runs on the app clock", () => {
  it("a cooldown expires when the simulated clock advances", async () => {
    const { freshDb } = await import("./helpers");
    const { consume } = await import("@/lib/ratelimit");
    await freshDb();

    await driveClock(apiReq("POST", "/api/dev/clock", { body: { action: "set", to: "2026-09-14T00:00:00.000Z" } }));
    const bucket = { key: "sim:hallway20s", capacity: 1, refillPerSec: 1 / 20 };

    expect((await consume(bucket)).allowed).toBe(true);
    expect((await consume(bucket)).allowed).toBe(false); // 20s cooldown in force

    // Without a clock-driven refill this would need a real 20-second wait.
    await driveClock(apiReq("POST", "/api/dev/clock", { body: { action: "advance", ms: 21_000 } }));
    expect((await consume(bucket)).allowed).toBe(true);
  });

  it("a daily cap also clears on simulated time", async () => {
    const { freshDb } = await import("./helpers");
    const { consume } = await import("@/lib/ratelimit");
    await freshDb();

    await driveClock(apiReq("POST", "/api/dev/clock", { body: { action: "set", to: "2026-09-14T00:00:00.000Z" } }));
    const daily = { key: "sim:hallwayday", capacity: 3, refillPerSec: 3 / 86400 };
    for (let i = 0; i < 3; i++) expect((await consume(daily)).allowed).toBe(true);
    expect((await consume(daily)).allowed).toBe(false);

    await driveClock(apiReq("POST", "/api/dev/clock", { body: { action: "advance", ms: DAY } }));
    expect((await consume(daily)).allowed).toBe(true);
  });
});
