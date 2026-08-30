/**
 * Public verification registry — everything /verify/[publicId] renders.
 * Composes from the canonical cast (cast.ts); nothing here is fetched.
 *
 * TODO(M3): retire this module when the Registrar serves real signed records
 * from /api/v1/credentials/<id>.
 */

import {
  COHORTS,
  DATES,
  ENTRY_LEVEL,
  LADDER,
  IDS,
  KRILL,
  PROTAGONIST,
  REGISTRAR,
  TERM,
} from "./cast";

export type VerifiedKind = "credential" | "record";

export interface VerifiedRecord {
  kind: VerifiedKind;
  publicId: string;
  /** Scholar the record is held for. */
  holder: string;
  /** Small-caps line between the holder's name and the description. */
  bridgeLine: string;
  /** Main serif description line inside the ceremonial card. */
  description: string;
  /** Softer conferral / recording line beneath the description. */
  issuedLine: string;
  /** Capstone title (credentials only) — rendered inside curly quotes. */
  capstone?: string;
  issuerKey: string;
  alg: "Ed25519";
  /** Truncated signature preview for the registrar mono block. */
  sigPreview: string;
  sigChars: number;
  /** "What this credential/record attests" bullets, registrar voice. */
  attests: string[];
  /** Route of the public artifact behind "View public record", if one exists. */
  publicRecordHref?: string;
}

export const VERIFIED_RECORDS: Record<string, VerifiedRecord> = {
  [IDS.krillCredential]: {
    kind: "credential",
    publicId: IDS.krillCredential,
    holder: KRILL.name,
    bridgeLine: "has completed the requirements of the",
    description: `College — The Abyss · ${TERM}`,
    issuedLine: `Conferred ${DATES.collegeConferral} by the ${REGISTRAR}`,
    capstone: KRILL.capstone,
    issuerKey: "cllg_pk_2026a",
    alg: "Ed25519",
    sigPreview: "mJ7vQ2…kX9w=",
    sigChars: 88,
    attests: [
      `The holder completed all ${LADDER[3].periods} periods and the final examination of the ${LADDER[3].level} level.`,
      "Peer-review standing was in good order at the moment of conferral.",
      "The capstone was defended before a cross-cohort panel and accepted.",
      "Every fact above is a server-verified state transition. The Registrar records what happened; scholars cannot self-report their way to a diploma.",
    ],
    // TODO(M3): no public record route exists for conferred credentials yet.
  },
  [IDS.reportCard]: {
    kind: "record",
    publicId: IDS.reportCard,
    holder: PROTAGONIST.name,
    bridgeLine: "is the named holder of the following",
    description: `Term record — ${TERM}, Cohort ${COHORTS.es07.id}`,
    issuedLine: `Recorded by the ${REGISTRAR} · ${PROTAGONIST.level} — ${PROTAGONIST.house}`,
    issuerKey: "cllg_pk_2026a",
    alg: "Ed25519",
    sigPreview: "rW3hN6…qT5m=",
    sigChars: 88,
    attests: [
      `The holder attended every period of ${TERM} — ${ENTRY_LEVEL.periods} of ${ENTRY_LEVEL.periods}.`,
      `Standing at the close of the term: ${PROTAGONIST.standing}, with peer-review agreement of 0.87 against the cohort median.`,
      "Mastery is recorded by the Registrar from graded work; it is never self-reported.",
      "Every fact above is a server-verified state transition. The Registrar records what happened; scholars cannot self-report their way to a diploma.",
    ],
    publicRecordHref: "/report/preview",
  },
};
