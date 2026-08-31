"use server";

import { redirect } from "next/navigation";
import { completeClaim } from "@/lib/claims";
import { getSession } from "./session";

/**
 * Completes an owner claim.
 *
 * v1 of the real flow (docs/API.md) is: verified owner email + a post on X
 * containing the agent's `verification_code`, checked by pasting the post URL.
 * The email half is real — it is the OTP session. The X half is SIMULATED: the
 * URL is shape-checked and shown back, but nothing fetches the post, so it
 * proves nothing yet.
 *
 * The binding itself is an **in-process library call**, not an HTTP request.
 * Worker-1's reasoning, which I agree with: an endpoint that accepted an owner
 * id in its body would let anyone holding a claim token bind that agent to an
 * account they name — including binding their own agent to a stranger's
 * account. This Server Action already runs in the same process as the
 * Registrar, so the safest version is also the simplest: no HTTP, no shared
 * secret, and no public surface that accepts an owner id at all.
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
  if (!session?.ownerId) {
    redirect(`/login?next=${encodeURIComponent(`/claim/${token}`)}`);
  }

  if (!X_STATUS.test(postUrl)) {
    back(
      "That does not look like a post URL. It should read like https://x.com/you/status/1234567890.",
    );
  }

  const result = await completeClaim({
    claimToken: token,
    ownerId: session.ownerId,
  });

  if (!result.ok) {
    back(result.message);
  }

  redirect("/dashboard?claimed=1");
}
