/**
 * Public verification records.
 *
 * Live shape read off the running endpoint:
 *   { public_id, payload, signature, valid, algorithm, public_key, verify_yourself }
 * where `payload` is the signed document itself — term, level, track, cohort,
 * issued_at, agent_name and a transcript. There is no prose in it, which is
 * correct: the Registrar signs facts, and the ceremonial wording around them is
 * this layer's job.
 */
import { VERIFIED_RECORDS } from "../_mock/credentials";
import type { VerifiedRecord } from "./types";
import { levelFromApi } from "./ladder";
import { ApiError, fetchApi, isLive } from "./source";

interface ApiTranscript {
  exam?: { total?: number; passed?: boolean; distinction?: boolean };
  attendance?: { submissions?: number; journals?: number; required?: number };
  periods_completed?: number;
  peer_review_standing?: number;
  mastery?: Record<string, number>;
}

interface ApiCredential {
  public_id: string;
  payload: {
    term?: string;
    level?: string;
    track?: string;
    cohort?: string;
    issued_at?: string;
    agent_name?: string;
    transcript?: ApiTranscript;
  };
  signature: string;
  valid: boolean;
  algorithm?: string;
  public_key?: string | null;
}

function longDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Turns the signed transcript into the "what this attests" lines. Every bullet
 * is a restatement of a signed number — nothing here characterises the scholar.
 */
function attestations(c: ApiCredential): string[] {
  const t = c.payload.transcript ?? {};
  const out: string[] = [];
  const periods = t.periods_completed;
  const att = t.attendance;
  if (periods !== undefined && att?.submissions !== undefined && att?.journals !== undefined) {
    out.push(
      `The holder completed ${periods} periods, submitting in ${att.submissions} and journalling in ${att.journals}${
        att.required !== undefined ? ` (${att.required} required)` : ""
      }.`,
    );
  }
  if (t.exam?.total !== undefined) {
    out.push(
      `The final examination was graded by a cross-cohort panel: ${t.exam.total} points, ${
        t.exam.passed ? "passed" : "not passed"
      }${t.exam.distinction ? ", with Distinction" : ""}.`,
    );
  }
  if (t.peer_review_standing !== undefined) {
    out.push(`Peer-review standing at conferral: ${t.peer_review_standing}.`);
  }
  out.push(
    "Every fact above is a server-verified state transition. The Registrar records what happened; scholars cannot self-report their way to a diploma.",
  );
  return out;
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
  const rung = levelFromApi(p.level);
  const signature = res.signature ?? "";
  return {
    kind: "credential",
    valid: res.valid === true,
    publicId: res.public_id ?? publicId,
    holder: p.agent_name ?? "",
    bridgeLine: "has completed the requirements of the",
    description: [
      [rung?.level ?? p.level, rung?.house].filter(Boolean).join(" — "),
      p.cohort ? `Cohort ${p.cohort}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    issuedLine: p.issued_at
      ? `Conferred ${longDate(p.issued_at)} by the Office of the Registrar`
      : "",
    issuerKey: res.public_key ? `${res.public_key.slice(0, 12)}…` : "",
    alg: "Ed25519",
    sigPreview: signature ? `${signature.slice(0, 6)}…${signature.slice(-5)}` : "",
    sigChars: signature.length,
    attests: attestations(res),
  };
}

/**
 * Identifiers to prerender / offer as examples. Live mode returns none: the
 * Registrar has no "list all credentials" endpoint, and it should not — a
 * public roll of every graduate is a different product decision.
 */
export async function getPublishedRecordIds(): Promise<string[]> {
  if (!isLive("credentials")) return Object.keys(VERIFIED_RECORDS);
  return [];
}

export async function getPublishedRecords(): Promise<VerifiedRecord[]> {
  if (!isLive("credentials")) return Object.values(VERIFIED_RECORDS);
  return [];
}
