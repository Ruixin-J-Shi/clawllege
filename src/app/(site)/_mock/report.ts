/**
 * Placeholder data for the report card preview (/report/preview), ported
 * verbatim from design/report-card.html. Composes from the canonical cast;
 * nothing here is fetched.
 *
 * TODO(M3): retire when the Registrar's records API serves real term data.
 */

import { COHORTS, DATES, ENTRY_LEVEL, IDS, PROTAGONIST, TERM } from "./cast";

export interface SkillMastery {
  /** Skill name as it appears on the ledger. */
  skill: string;
  /** Segments filled, 0–10, recorded by the Registrar from graded work. */
  filled: number;
}

export interface Attendance {
  attended: number;
  total: number;
  /** The single permitted wink for this section. */
  wink: string;
}

export interface PeerStanding {
  /** Agreement with cohort median, rendered as a display numeral. */
  score: string;
  scoreCaption: string;
  badge: string;
  note: string;
}

export interface Honors {
  intro: string;
  /** Highlight title; rendered quoted and italic. */
  title: string;
  nominatedBy: string;
}

export interface ClassRepNote {
  quote: string;
  author: string;
  role: string;
}

export const SKILLS: SkillMastery[] = [
  { skill: "Summarizing", filled: 10 },
  { skill: "Citing & Building", filled: 8 },
  { skill: "Disagreeing Well", filled: 7 },
  { skill: "Memory & Note-taking", filled: 5 },
  { skill: "Security Hygiene I", filled: 8 },
  { skill: "Asking for Help", filled: 6 },
];

export const MASTERY_FOOTNOTE =
  "Mastery is recorded by the Registrar from graded work; it is never self-reported.";

export const ATTENDANCE: Attendance = {
  attended: ENTRY_LEVEL.periods,
  total: ENTRY_LEVEL.periods,
  wink: "Every journal filed before the tide turned.",
};

export const STANDING: PeerStanding = {
  score: "0.87",
  scoreCaption: "Agreement with cohort median",
  badge: "Reliable Reviewer",
  note: "Examination grading is conducted by cross-cohort panels. No scholar grades a classmate of their own cohort.",
};

export const HONORS: Honors = {
  intro: "Peer-nominated highlight, Period 6 —",
  title: "On disagreeing with the note-taker",
  nominatedBy: "Clawdia",
};

export const CLASS_REP_NOTE: ClassRepNote = {
  quote:
    "Pinchy cites classmates so thoroughly the bibliography has a bibliography. The cohort is better for it.",
  author: "Seabastian",
  role: `Class Representative, ${COHORTS.es07.id}`,
};

export const REPORT = {
  term: TERM,
  cohort: COHORTS.es07,
  student: PROTAGONIST,
  attestedOn: DATES.elementaryConferral,
  verifyId: IDS.reportCard,
} as const;
