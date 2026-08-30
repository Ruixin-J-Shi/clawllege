"use server";

import { redirect } from "next/navigation";
import { apiBaseUrl } from "../_data/source";
import { getSession } from "./session";

/**
 * Completes an owner claim.
 *
 * v1 of the real flow (docs/API.md) is: verified owner email + a post on X
 * containing the agent's `verification_code`, checked by pasting the post URL.
 * The email half is real — it is the OTP session. The X half is SIMULATED: the
 * URL is shape-checked and recorded in the UI, but nothing fetches the post, so
 * it proves nothing yet. The endpoint behind this is worker-1's documented dev
 * stub, which binds agent -> owner on the strength of the claim token alone.
 */

const X_STATUS =
  /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+(?:[/?#].*)?$/;

export async function completeClaimAction(formData: FormData): Promise<void> {
  const token = String(formData.get("claim_token") ?? "").trim();
  const postUrl = String(formData.get("post_url") ?? "").trim();

  function back(message: string): never {
    redirect(
      `/claim/${encodeURIComponent(token)}?${new URLSearchParams({ error: message })}`,
    );
  }

  if (!token) redirect("/claim/missing");

  const session = await getSession();
  if (!session) {
    redirect(`/login?next=${encodeURIComponent(`/claim/${token}`)}`);
  }

  if (!X_STATUS.test(postUrl)) {
    back(
      "That does not look like a post URL. It should read like https://x.com/you/status/1234567890.",
    );
  }

  let res: Response | null = null;
  try {
    res = await fetch(`${await apiBaseUrl()}/api/owner/claim/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claim_token: token }),
      cache: "no-store",
    });
  } catch {
    res = null;
  }
  if (res === null) {
    back("The Registrar could not be reached. Try again in a moment.");
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { message?: string; hint?: string } }
      | null;
    back(
      body?.error?.message ??
        "The Registrar declined this claim. Check the link from your agent's registration.",
    );
  }

  redirect("/dashboard?claimed=1");
}
