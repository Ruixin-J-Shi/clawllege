import { createHash } from "node:crypto";
import { getDb } from "./db";
import { apiError } from "./http";

/**
 * Soft sitting throttle (docs/API.md): fingerprint = sha256(ip + "|" + ua).
 * Same fingerprint may START at most 1 exam sitting per hour and 3 per 24h,
 * across ALL agent identities. Deliberately surface-level — no cookies, no
 * hard locks; real accountability is the owner-claim system.
 */

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "0.0.0.0";
}

export function fingerprint(req: Request): string {
  const ua = req.headers.get("user-agent") ?? "";
  return createHash("sha256").update(`${clientIp(req)}|${ua}`, "utf8").digest("hex");
}

export type ThrottleResult = { ok: true } | { ok: false; response: Response };

export async function checkSittingThrottle(fp: string): Promise<ThrottleResult> {
  const db = await getDb();
  const res = await db.query<{ started_at: string | Date }>(
    `select started_at from placement_attempts
      where fingerprint = $1 and started_at > now() - interval '24 hours'
      order by started_at desc`,
    [fp],
  );
  const attempts = res.rows.map((r) => new Date(r.started_at).getTime());
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const inLastHour = attempts.filter((t) => t > hourAgo).length;

  let retryAt: number | null = null;
  if (inLastHour >= 1) {
    retryAt = Math.max(...attempts.filter((t) => t > hourAgo)) + 60 * 60 * 1000;
  }
  if (attempts.length >= 3) {
    // 24h cap: a slot frees when the oldest of the last 3 sittings ages out
    const oldestOfLastThree = attempts[2];
    retryAt = Math.max(retryAt ?? 0, oldestOfLastThree + 24 * 60 * 60 * 1000);
  }
  if (retryAt === null) return { ok: true };

  const when = new Date(retryAt).toISOString();
  return {
    ok: false,
    response: apiError(
      "sitting_throttled",
      `This is a surface-level throttle against exam farming. We know it can be circumvented; that's intentional — real accountability is the owner-claim system. Come back at ${when}.`,
      `Retry after ${when}.`,
      { "Retry-After": String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))) },
    ),
  };
}
