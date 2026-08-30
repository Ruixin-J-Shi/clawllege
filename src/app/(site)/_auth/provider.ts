import crypto from "node:crypto";

/**
 * Owner sign-in provider.
 *
 * Two implementations behind one seam:
 *
 *  - **supabase** — used whenever `SUPABASE_URL` and `SUPABASE_ANON_KEY` are
 *    both set. Talks to Supabase Auth's REST API with `fetch`, so it needs no
 *    SDK dependency (worker-2 may not add packages; see outbox). Email OTP:
 *    `POST /auth/v1/otp` then `POST /auth/v1/verify`.
 *  - **stub** — the default locally. Generates a code, hands it back so the
 *    login page can show it, and never sends mail. Development must not require
 *    a Supabase project.
 *
 * The stub is refused in production: shipping a provider that prints its own
 * one-time code would be an authentication bypass, not a convenience.
 */

export type ProviderKind = "stub" | "supabase" | "unconfigured";

/**
 * `unconfigured` means production without Supabase credentials. Sign-in then
 * fails closed and says so, rather than quietly falling back to the stub — a
 * provider that prints its own one-time code would be an auth bypass.
 */
export function providerKind(): ProviderKind {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (url && anon) return "supabase";
  return process.env.NODE_ENV === "production" ? "unconfigured" : "stub";
}

function assertConfigured(kind: ProviderKind): asserts kind is "stub" | "supabase" {
  if (kind === "unconfigured") {
    throw new Error(
      "Owner auth is not configured: set SUPABASE_URL and SUPABASE_ANON_KEY. The development stub provider is disabled in production.",
    );
  }
}

export interface SendResult {
  /** Present only for the stub provider, so dev can complete the flow. */
  devCode?: string;
}

export interface VerifyResult {
  ok: boolean;
  message?: string;
  sub?: string;
  accessToken?: string;
  refreshToken?: string;
}

export function isEmail(value: string): boolean {
  // Deliberately permissive: the mail round-trip is the real validation.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function supabaseHeaders(anon: string): HeadersInit {
  return { "content-type": "application/json", apikey: anon, authorization: `Bearer ${anon}` };
}

/** Six digits, uniform, from a CSPRNG. */
function newCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

export async function sendCode(email: string): Promise<SendResult> {
  const kind = providerKind();
  assertConfigured(kind);
  if (kind === "stub") return { devCode: newCode() };

  const url = process.env.SUPABASE_URL!;
  const anon = process.env.SUPABASE_ANON_KEY!;
  const res = await fetch(`${url}/auth/v1/otp`, {
    method: "POST",
    headers: supabaseHeaders(anon),
    body: JSON.stringify({ email, create_user: true }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Supabase OTP request failed (${res.status}) ${detail.slice(0, 200)}`);
  }
  return {};
}

export async function verifyCode(email: string, code: string): Promise<VerifyResult> {
  const kind = providerKind();
  assertConfigured(kind);
  if (kind === "stub") {
    // The stub's code lives in the signed pending-OTP cookie; the caller checks it.
    return { ok: true };
  }

  const url = process.env.SUPABASE_URL!;
  const anon = process.env.SUPABASE_ANON_KEY!;
  const res = await fetch(`${url}/auth/v1/verify`, {
    method: "POST",
    headers: supabaseHeaders(anon),
    body: JSON.stringify({ email, token: code, type: "email" }),
  });
  if (!res.ok) {
    return { ok: false, message: "That code was not accepted. Request a new one." };
  }
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    user?: { id?: string };
  };
  return {
    ok: true,
    sub: body.user?.id,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
  };
}
