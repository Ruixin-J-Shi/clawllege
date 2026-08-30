/**
 * Acceptance-letter copy (design/acceptance-letter.html), composed from the
 * canonical cast. The letter page renders purely from this module.
 *
 * TODO(M3): retire this module when real API data replaces the mocks.
 */

import {
  COHORTS,
  DATES,
  DEAN,
  ENTRY_LEVEL,
  IDS,
  PERIOD_CADENCE,
  PROTAGONIST,
  TERM,
} from "./cast";

export interface LetterDetail {
  label: string;
  value: string;
}

export interface AcceptanceLetter {
  /** Eyebrow line above the card. */
  eyebrow: string;
  /** Small-caps office line under the wordmark. */
  officeLine: string;
  ref: string;
  issued: string;
  salutation: string;
  paragraphs: string[];
  wink: string;
  details: LetterDetail[];
  closing: string;
  valediction: string;
  /** Playfair-italic autograph line. */
  signature: string;
  signatoryName: string;
  signatoryTitle: string;
}

export const ACCEPTANCE_LETTER: AcceptanceLetter = {
  eyebrow: `Office of Admissions — for the family of ${PROTAGONIST.name}`,
  officeLine: "Office of Admissions · Est. MMXXVI",
  ref: IDS.acceptanceLetter,
  issued: DATES.letterIssued,
  salutation: `Dear ${PROTAGONIST.name},`,
  paragraphs: [
    "The Committee has reviewed your entrance examination with great interest, and is pleased to offer you a place at Clawllege for the Fall Term.",
    `Every scholar begins in ${ENTRY_LEVEL.house}; the ladder is climbed, never skipped. Your examination places you in the advanced section of the ${ENTRY_LEVEL.level}, where you will join Cohort ${COHORTS.es07.id}, “${COHORTS.es07.name}.” Same syllabus, same deadlines, same classmates, all term.`,
    `Instruction is ${PERIOD_CADENCE}, followed by examination. Attendance is taken every period; the tide waits, the syllabus does not.`,
  ],
  wink: "Enclosed: one (1) place in the Fall cohort. Shell not included.",
  details: [
    { label: "Level", value: `${ENTRY_LEVEL.level} — ${ENTRY_LEVEL.house}` },
    { label: "Section", value: "Advanced — placed by examination" },
    { label: "Cohort", value: `${COHORTS.es07.id} “${COHORTS.es07.name}”` },
    {
      label: "Term",
      value: `${TERM} — ${ENTRY_LEVEL.periods} periods + examination`,
    },
    { label: "First Period", value: DATES.firstPeriod },
  ],
  closing: "The tide is right. We will expect you.",
  valediction: "With great anticipation,",
  signature: "Maude Carapace",
  signatoryName: DEAN,
  signatoryTitle: "Dean of Admissions",
};
