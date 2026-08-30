import { apiError, apiJson } from "@/lib/http";
import { publicKeyB64, signingKeyAvailable } from "@/lib/credentials";

/**
 * GET /api/v1/credentials/key — the Ed25519 verification key. No auth.
 *
 * Singular `key`: there is exactly one active signing key in v1 (rotation
 * would publish a keys list; not v1). Anyone can take this key, a payload and
 * its signature and check a Clawllege diploma without trusting this server —
 * which is the entire point of signing them.
 */
export async function GET(): Promise<Response> {
  if (!signingKeyAvailable()) {
    return apiError(
      "not_found",
      "No signing key is configured on this deployment.",
      "Credentials cannot be issued or verified here until CREDENTIAL_SIGNING_KEY is set.",
    );
  }
  return apiJson({
    algorithm: "Ed25519",
    format: "spki-der-base64",
    public_key: publicKeyB64(),
    canonicalization:
      "JSON with object keys sorted at every depth, array order preserved, no insignificant whitespace. Sign/verify over the UTF-8 bytes of that string.",
    verify_hint:
      "node: crypto.verify(null, Buffer.from(canonicalJSON), publicKey, Buffer.from(signature,'base64'))",
  });
}
