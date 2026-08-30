import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";

/**
 * Credentials — the product's integrity core.
 *
 * A diploma is a JSON payload signed with Ed25519 over its CANONICAL bytes
 * (keys sorted at every depth, no whitespace). Anyone holding the published
 * public key can verify a credential without trusting this server, which is
 * the whole point: the school's word is not the evidence, the signature is.
 *
 * The signing key lives only in `CREDENTIAL_SIGNING_KEY` (base64 PKCS#8) and
 * never leaves the server. `npm run keygen` mints one.
 */

export type Level = "elementary_school" | "middle_school" | "high_school" | "college";
export type Track = "standard" | "associate";

/** Short level codes used in the printed public_id. */
const LEVEL_CODE: Record<Level, string> = {
  elementary_school: "ES",
  middle_school: "MS",
  high_school: "HS",
  college: "COL",
};

// Crockford-ish base32 without I/L/O/U — no ambiguity when read off a diploma.
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * `CLLG-<TERM><YY>-<LEVEL>-<4 base32>` — e.g. `CLLG-F26-MS-7K2Q`.
 * The term segment comes from the term slug (`fall-26-ms` → `F26`).
 */
export function publicIdFor(termSlug: string, level: Level, random = randomBytes): string {
  const season = /^([a-z]+)-(\d{2})/i.exec(termSlug);
  const termCode = season
    ? `${season[1][0].toUpperCase()}${season[2]}`
    : termSlug.replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase() || "T00";
  let suffix = "";
  for (const byte of random(8)) {
    if (suffix.length === 4) break;
    suffix += BASE32[byte % BASE32.length];
  }
  while (suffix.length < 4) suffix += BASE32[0];
  return `CLLG-${termCode}-${LEVEL_CODE[level]}-${suffix}`;
}

/**
 * Canonical JSON: object keys sorted at every depth, array order preserved,
 * no insignificant whitespace. Both signer and verifier must produce the
 * exact same bytes from the same document, so this is the contract.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export interface KeyPairB64 {
  /** base64 PKCS#8 private key — the value for CREDENTIAL_SIGNING_KEY. */
  privateKey: string;
  /** base64 SPKI public key — safe to publish. */
  publicKey: string;
}

/** Mint a fresh Ed25519 signing key pair. */
export function generateSigningKey(): KeyPairB64 {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

function privateKeyFromEnv(): KeyObject {
  const raw = process.env.CREDENTIAL_SIGNING_KEY;
  if (!raw || raw.trim() === "") {
    throw new Error(
      "CREDENTIAL_SIGNING_KEY is not set. Run `npm run keygen` and put the private key in .env.local — credentials cannot be issued without it.",
    );
  }
  try {
    return createPrivateKey({
      key: Buffer.from(raw.trim(), "base64"),
      format: "der",
      type: "pkcs8",
    });
  } catch (err) {
    throw new Error(
      `CREDENTIAL_SIGNING_KEY is not a base64 PKCS#8 Ed25519 key: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** True when a usable signing key is configured. */
export function signingKeyAvailable(): boolean {
  try {
    privateKeyFromEnv();
    return true;
  } catch {
    return false;
  }
}

/** The published verification key, base64 SPKI. Derived from the private key. */
export function publicKeyB64(): string {
  const pub = createPublicKey(privateKeyFromEnv());
  return pub.export({ type: "spki", format: "der" }).toString("base64");
}

/** Sign a payload's canonical bytes. Returns base64. */
export function signPayload(payload: unknown): string {
  const bytes = Buffer.from(canonicalize(payload), "utf8");
  return edSign(null, bytes, privateKeyFromEnv()).toString("base64");
}

/**
 * Verify a payload+signature against a public key — the same check an outside
 * auditor runs. `publicKeyBase64` defaults to this server's published key.
 */
export function verifyPayload(
  payload: unknown,
  signatureB64: string,
  publicKeyBase64?: string,
): boolean {
  try {
    const key = publicKeyBase64
      ? createPublicKey({
          key: Buffer.from(publicKeyBase64, "base64"),
          format: "der",
          type: "spki",
        })
      : createPublicKey(privateKeyFromEnv());
    return edVerify(
      null,
      Buffer.from(canonicalize(payload), "utf8"),
      key,
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}

export interface TranscriptPack {
  periods_completed: number;
  attendance: { journals: number; submissions: number; required: number };
  mastery: Record<string, number>;
  peer_review_standing: number | null;
  exam: { total: number; passed: boolean; frontier_score?: number; distinction?: boolean } | null;
}

export interface CredentialPayload {
  public_id: string;
  agent_name: string;
  level: Level;
  track: Track;
  term: string;
  cohort: string;
  issued_at: string;
  transcript: TranscriptPack;
}

/** Assemble the exact document that gets signed. Field order is irrelevant —
 *  `canonicalize` sorts — but the field SET is the contract. */
export function buildPayload(fields: CredentialPayload): CredentialPayload {
  return fields;
}
