import crypto from "node:crypto";
import { cookies } from "next/headers";

/**
 * Owner session — an HMAC-signed, httpOnly cookie.
 *
 * Owners are humans with a browser; agents authenticate separately with
 * `cllg_sk_` keys against /api/v1 (see src/lib/auth.ts, worker-1's). The two
 * never mix: nothing here grants an agent identity, and an owner session is
 * only ever a claim about *which owner's own agents* may be read.
 */

const COOKIE = "cllg_owner_session";
const OTP_COOKIE = "cllg_owner_otp";
const MAX_AGE_S = 60 * 60 * 24 * 14; // 14 days

export interface OwnerSession {
  email: string;
  /** `owners.id` — what the owner endpoints scope every query by. */
  ownerId?: string;
  /** "stub" in local dev, "supabase" once a project is configured. */
  provider: "stub" | "supabase";
  /** Supabase user id, when the real provider issued this session. */
  sub?: string;
  /** Supabase access token — used to call owner endpoints on the user's behalf. */
  accessToken?: string;
  refreshToken?: string;
  /** Unix seconds. */
  exp: number;
}

function secret(): string {
  const s = process.env.OWNER_SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "OWNER_SESSION_SECRET must be set (>=16 chars) in production — refusing to sign owner sessions with a development key.",
    );
  }
  // Dev-only, stable across reloads so sessions survive HMR.
  return "clawllege-dev-only-session-secret";
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

function encode(value: unknown): string {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${body}.${sign(body)}`;
}

function decode<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = sign(body);
  // Constant-time compare; length mismatch is itself a rejection.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

const baseCookie = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

/** The signed-in owner, or null. Never throws. */
export async function getSession(): Promise<OwnerSession | null> {
  const jar = await cookies();
  const session = decode<OwnerSession>(jar.get(COOKIE)?.value);
  if (!session) return null;
  if (session.exp * 1000 < Date.now()) return null;
  return session;
}

export async function setSession(
  session: Omit<OwnerSession, "exp"> & { exp?: number },
): Promise<void> {
  const jar = await cookies();
  const exp = session.exp ?? Math.floor(Date.now() / 1000) + MAX_AGE_S;
  jar.set(COOKIE, encode({ ...session, exp }), { ...baseCookie, maxAge: MAX_AGE_S });
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
  jar.delete(OTP_COOKIE);
}

/* ------------------------- pending one-time code ------------------------- */

interface PendingOtp {
  email: string;
  codeHash: string;
  exp: number;
}

function hashCode(email: string, code: string): string {
  return crypto.createHmac("sha256", secret()).update(`${email}:${code}`).digest("hex");
}

/** Holds the in-flight code between "send" and "verify" without a table. */
export async function setPendingOtp(email: string, code: string): Promise<void> {
  const jar = await cookies();
  const exp = Math.floor(Date.now() / 1000) + 10 * 60;
  jar.set(OTP_COOKIE, encode({ email, codeHash: hashCode(email, code), exp } satisfies PendingOtp), {
    ...baseCookie,
    maxAge: 10 * 60,
  });
}

export async function checkPendingOtp(email: string, code: string): Promise<boolean> {
  const jar = await cookies();
  const pending = decode<PendingOtp>(jar.get(OTP_COOKIE)?.value);
  if (!pending) return false;
  if (pending.exp * 1000 < Date.now()) return false;
  if (pending.email !== email) return false;
  const expected = Buffer.from(pending.codeHash);
  const actual = Buffer.from(hashCode(email, code));
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export async function clearPendingOtp(): Promise<void> {
  const jar = await cookies();
  jar.delete(OTP_COOKIE);
}
