/**
 * Public verification records.
 *
 * Live shape follows `GET /api/v1/credentials/{public_id}` in `docs/API.md`
 * ({payload, signature, valid}). That route is not on disk yet, so the live
 * branch is written against the documented contract and is UNVERIFIED.
 */
import { VERIFIED_RECORDS } from "../_mock/credentials";
import type { VerifiedRecord } from "./types";
import { ApiError, fetchApi, isLive } from "./source";

interface ApiCredential {
  payload?: {
    kind?: string;
    public_id?: string;
    holder?: string;
    level?: string;
    house?: string;
    term?: string;
    issued_at?: string;
    issuer_key?: string;
    capstone?: string;
    attests?: string[];
  };
  signature?: string;
  valid?: boolean;
}

/** Returns null when nothing is filed under the identifier (never throws 404). */
export async function getVerifiedRecord(
  publicId: string,
): Promise<VerifiedRecord | null> {
  if (!isLive("credentials")) return VERIFIED_RECORDS[publicId] ?? null;

  let res: ApiCredential;
  try {
    res = await fetchApi<ApiCredential>(
      `/api/v1/credentials/${encodeURIComponent(publicId)}`,
      { revalidate: 300 },
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }

  const p = res.payload ?? {};
  const isCredential = p.kind !== "record";
  const signature = res.signature ?? "";
  return {
    kind: isCredential ? "credential" : "record",
    publicId: p.public_id ?? publicId,
    holder: p.holder ?? "",
    bridgeLine: isCredential
      ? "has completed the requirements of the"
      : "is the named holder of the following",
    description: [p.level, p.house].filter(Boolean).join(" — ") +
      (p.term ? ` · ${p.term}` : ""),
    issuedLine: p.issued_at ? `Conferred ${p.issued_at}` : "",
    capstone: p.capstone,
    issuerKey: p.issuer_key ?? "",
    alg: "Ed25519",
    sigPreview: signature ? `${signature.slice(0, 6)}…${signature.slice(-5)}` : "",
    sigChars: signature.length,
    attests: p.attests ?? [],
  };
}

/** Identifiers to prerender / offer as examples. */
export async function getPublishedRecordIds(): Promise<string[]> {
  if (!isLive("credentials")) return Object.keys(VERIFIED_RECORDS);
  return [];
}

export async function getPublishedRecords(): Promise<VerifiedRecord[]> {
  if (!isLive("credentials")) return Object.values(VERIFIED_RECORDS);
  return [];
}
