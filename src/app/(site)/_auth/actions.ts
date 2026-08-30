"use server";

import { redirect } from "next/navigation";
import {
  checkPendingOtp,
  clearPendingOtp,
  clearSession,
  setPendingOtp,
  setSession,
} from "./session";
import { isEmail, providerKind, sendCode, verifyCode } from "./provider";

/**
 * Server Actions for owner sign-in.
 *
 * These live here rather than under /api because `src/app/api/**` is worker-1's
 * (agent API) — and a form-post Server Action is the better fit anyway: it sets
 * the session cookie and redirects in one round trip, with no client JS.
 */

function backToLogin(params: Record<string, string>): never {
  redirect(`/login?${new URLSearchParams(params).toString()}`);
}

/** Step 1 — email in, one-time code out. */
export async function requestCodeAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!isEmail(email)) {
    backToLogin({ error: "Enter a valid email address." });
  }

  let devCode: string | undefined;
  try {
    const result = await sendCode(email);
    devCode = result.devCode;
  } catch {
    backToLogin({ error: "Could not send a code just now. Try again in a moment." });
  }

  // The stub returns the code so the page can display it; the real provider
  // mails it and returns nothing.
  const code = devCode ?? "";
  if (providerKind() === "stub") {
    await setPendingOtp(email, code);
    backToLogin({ step: "code", email, dev: code });
  }
  backToLogin({ step: "code", email });
}

/** Step 2 — code in, session out. */
export async function verifyCodeAction(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const code = String(formData.get("code") ?? "").trim();
  const next = String(formData.get("next") ?? "/dashboard");

  if (!isEmail(email) || code.length === 0) {
    backToLogin({ step: "code", email, error: "Enter the code from your email." });
  }

  const kind = providerKind();
  if (kind === "stub") {
    const ok = await checkPendingOtp(email, code);
    if (!ok) {
      backToLogin({ step: "code", email, error: "That code is not right, or it has expired." });
    }
    await clearPendingOtp();
    await setSession({ email, provider: "stub" });
  } else {
    const result = await verifyCode(email, code);
    if (!result.ok) {
      backToLogin({
        step: "code",
        email,
        error: result.message ?? "That code was not accepted.",
      });
    }
    await setSession({
      email,
      provider: "supabase",
      sub: result.sub,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  }

  // Only ever bounce to an internal path.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
}

export async function signOutAction(): Promise<void> {
  await clearSession();
  redirect("/");
}
