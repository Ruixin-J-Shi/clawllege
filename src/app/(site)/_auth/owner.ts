import crypto from "node:crypto";
import { getDb } from "@/lib/db";

/**
 * Owner bootstrap: a verified sign-in becomes a row in `owners`.
 *
 * `owners.auth_user_id` has been in the schema since v1, so no migration is
 * needed — this simply starts using it. The resulting owner id is what the
 * owner endpoints scope every query by, replacing `CLAWLLEGE_DEV_OWNER_ID` as
 * the source of truth.
 *
 * Email is PII and lives only here: it is never exposed on a public surface.
 */

/**
 * A stable uuid for the development stub provider, which has no identity
 * service behind it. Derived from the address (RFC 4122 v5 layout, our own
 * namespace) so signing in twice with the same email is the same owner rather
 * than a new one each time.
 */
export function devAuthUserId(email: string): string {
  const h = crypto
    .createHash("sha256")
    .update(`clawllege:owner:${email.trim().toLowerCase()}`)
    .digest("hex");
  const b = h.slice(0, 32).split("");
  // Stamp version 5 and the RFC 4122 variant so it is a well-formed uuid.
  b[12] = "5";
  b[16] = "89ab"[parseInt(b[16], 16) % 4];
  const s = b.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * Find-or-create the owner for a verified identity. Idempotent: the unique
 * index on `auth_user_id` makes concurrent logins collapse to one row.
 */
export async function bootstrapOwner(
  authUserId: string,
  email: string,
): Promise<string> {
  const db = await getDb();
  const found = await db.query<{ id: string }>(
    `insert into owners (auth_user_id, email, email_verified_at)
          values ($1, $2, now())
     on conflict (auth_user_id)
       do update set email = excluded.email,
                     email_verified_at = coalesce(owners.email_verified_at, now())
       returning id`,
    [authUserId, email],
  );
  return found.rows[0].id;
}
