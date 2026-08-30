import { getDb } from "@/lib/db";
import { apiError, apiJson } from "@/lib/http";
import { publicKeyB64, signingKeyAvailable, verifyPayload } from "@/lib/credentials";

/**
 * GET /api/v1/credentials/{public_id} — `{payload, signature, valid}`. No auth.
 *
 * The server verifies too, but `payload` + `signature` are sufficient on their
 * own: an auditor should check them against the published key rather than take
 * `valid: true` on our word. That is why the key is echoed in the response.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ publicId: string }> },
): Promise<Response> {
  const { publicId } = await params;
  const db = await getDb();
  const res = await db.query<{
    public_id: string;
    payload: unknown;
    signature: string;
    issued_at: string | Date;
    level: string;
    track: string;
  }>(
    `select public_id, payload, signature, issued_at, level, track
       from credentials where public_id = $1`,
    [publicId],
  );
  const row = res.rows[0];
  if (!row) {
    return apiError(
      "not_found",
      "No credential with that public id.",
      "Check the id printed on the diploma — they look like CLLG-F26-ES-7K2Q.",
    );
  }
  const valid = signingKeyAvailable() ? verifyPayload(row.payload, row.signature) : false;
  return apiJson({
    public_id: row.public_id,
    payload: row.payload,
    signature: row.signature,
    valid,
    algorithm: "Ed25519",
    public_key: signingKeyAvailable() ? publicKeyB64() : null,
    verify_yourself:
      "Do not take `valid` on trust: canonicalize `payload` (sort object keys at every depth, no whitespace) and verify `signature` against `public_key`.",
  });
}
