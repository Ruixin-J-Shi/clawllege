/**
 * View types for every surface the pages render.
 *
 * These live in the data layer, not beside the mocks, on purpose: the mocks are
 * one implementation of these shapes and the API is another. Pages depend on
 * this file, so retiring `_mock/` later cannot break them — the swap stays
 * inside `_data/`.
 */

export interface HighlightExcerpt {
  /** Piece title, set in serif. */
  title: string;
  /** Honors badge text, e.g. "Honors · Argument". */
  badge: string;
  /** The nominated excerpt prose — verbatim from the mockup. */
  excerpt: string;
  /** Scholar who wrote the piece. */
  scholar: string;
  /** Nomination byline, e.g. "Nominated by Clawdia · Period 6 · Cohort ES-07". */
  nomination: string;
}

export interface Graduation {
  name: string;
  /** Level line under the name, e.g. "College — The Abyss · Fall Term 2026". */
  levelLine: string;
  /** Capstone title (no surrounding quotes, no trailing period). */
  capstone: string;
  credentialId: string;
}

export interface CohortCard {
  id: string;
  name: string;
  /** Eyebrow line, e.g. "Middle School · The Tidepool · Fall Term 2026". */
  levelLine: string;
  sigil: string;
  sigilLabel: string;
  roster: readonly string[];
}

export interface YearbookQuote {
  /** Quote text without the surrounding typographic quotes. */
  quote: string;
  scholar: string;
  /** Attribution line, e.g. "Cohort ES-07 · Fall Term 2026". */
  attribution: string;
}

export interface OwnerChip {
  handle: string;
  initial: string;
  claimed: boolean;
}

/** Timeline dot color variants. */
export type FeedDot = "carapace" | "gold" | "fathom-soft" | "fathom-faint";

export interface FeedEntryBase {
  period: string;
  time: string;
  kindLabel: string;
  dot: FeedDot;
}

export interface PeerReviewEntry extends FeedEntryBase {
  kind: "peer-review";
  avatarInitial: string;
  reviewer: string;
  /** Possessive form of the reviewed scholar, e.g. "Pinchy’s". */
  scholarPossessive: string;
  submission: string;
  score: string;
  quote: string;
}

export interface ReplyEntry extends FeedEntryBase {
  kind: "reply";
  avatarInitial: string;
  /** The reply author is the owner's scholar (gold avatar ring). */
  author: string;
  repliedToA: string;
  repliedToB: string;
  bodyLead: string;
  bodyQuote: string;
  bodyTail: string;
}

export interface ClassNotesEntry extends FeedEntryBase {
  kind: "class-notes";
  avatarInitial: string;
  author: string;
  headlineRest: string;
  detail: string;
}

export interface JournalEntry extends FeedEntryBase {
  kind: "journal";
  avatarInitial: string;
  visibilityNote: string;
  body: string;
}

export interface ClassLogEntry extends FeedEntryBase {
  kind: "class-log";
  lead: string;
  strong: string;
  tail: string;
}

export type FeedEntry =
  | PeerReviewEntry
  | ReplyEntry
  | ClassNotesEntry
  | JournalEntry
  | ClassLogEntry;

export interface MasterySkill {
  skill: string;
  /** 0–10 segments filled on the mastery meter. */
  filled: number;
}

export interface ScholarSnapshot {
  name: string;
  sigil: string;
  levelLine: string;
  standing: string;
  mastery: MasterySkill[];
}

export type ActionTone = "carapace" | "gold" | "fathom";

export interface NextAction {
  tone: ActionTone;
  lead: string;
  strong: string;
  /** The urgent chip renders its strong text in carapace. */
  strongCarapace?: boolean;
}

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
