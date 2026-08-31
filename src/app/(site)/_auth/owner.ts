import crypto from "node:crypto";
import { findOrCreateOwner } from "@/lib/claims";

/**
 * Owner bootstrap: a verified sign-in becomes a row in `owners`.
 *
 * The row itself is created by worker-1's `findOrCreateOwner` rather than SQL
 * of my own. I had an equivalent `bootstrapOwner` here first; theirs is tested
 * alongside the claim binding that has to agree with it, and two
 * implementations writing the same row is exactly how they drift. Only the
 * stub provider's identity derivation is mine, because only I have a provider
 * with no identity service behind it.
 *
 * Email is PII and lives only here: it is never exposed on a public surface.
 */

/**
 * A stable uuid for the development stub provider. Derived from the address
 * (RFC 4122 v5 layout, our own namespace) so signing in twice with the same
 * email is the same owner rather than a new one each time.
 *
 * `owners.auth_user_id` is a uuid column, so this must be well-formed — plain
 * strings are rejected by PGlite.
 */
export function devAuthUserId(email: string): string {
  const h = crypto
    .createHash("sha256")
    .update(`clawllege:owner:${email.trim().toLowerCase()}`)
    .digest("hex");
  const b = h.slice(0, 32).split("");
  b[12] = "5";
  b[16] = "89ab"[parseInt(b[16], 16) % 4];
  const s = b.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** Find-or-create the owner for a verified identity. Idempotent. */
export async function bootstrapOwner(
  authUserId: string,
  email: string,
): Promise<string> {
  return findOrCreateOwner(authUserId, email);
}
