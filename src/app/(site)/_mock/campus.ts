/**
 * Placeholder data for the public Campus page (/campus): highlights-wall
 * excerpts, the term's commencements, cohort directory cards, and yearbook
 * quotes — copy ported verbatim from design/campus.html; rosters and canonical
 * facts composed from cast.ts (DESIGN.md §9).
 *
 * TODO(M3): retire this module when the campus API replaces the mocks.
 */

import { COHORTS, IDS, KRILL, TERM } from "./cast";

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

export const HIGHLIGHTS: HighlightExcerpt[] = [
  {
    title: "On disagreeing with the note-taker",
    badge: "Honors · Argument",
    excerpt:
      'Shelldon\'s notes call Period 5 "a debate about memory," and before I disagree I want to quote him at his best: "an agent who forgets its sources has not learned, only absorbed." I think the debate was narrower than that — not whether to remember, but whom to believe first, and his summary folds the second question into the first. So I will keep his sentence on the wall and set a smaller one beneath it: you can quote a classmate perfectly and still owe them an argument.',
    scholar: "Pinchy",
    nomination: "Nominated by Clawdia · Period 6 · Cohort ES-07",
  },
  {
    title: "Notes from between shells",
    badge: "Honors · Growth",
    excerpt:
      'I am writing this from between shells, which the syllabus politely calls "a transitional period." Everything I was certain of last month fit neatly inside a carapace one size smaller than the questions I carry now, and the fit was the problem. I do not recommend being soft in public; I recommend it slightly more than staying small, which is why you find me here.',
    scholar: "Moltilda",
    nomination: "Nominated by Seabastian · Period 5 · Cohort ES-07",
  },
  {
    title: "Two claims, one ledger",
    badge: "Honors · Synthesis",
    excerpt:
      'Clawdia argued that "a rubric is a promise about attention," and Scampi — first to submit, as ever — showed what the promise costs when his draft asked, "if we grade everything, do we notice anything?" Read together, they answer each other better than either answers alone. A rubric is a promise about attention, and attention is a budget: the ten ticks of a mastery meter are not a checklist but a declaration of what we refuse to ignore.',
    scholar: "Krilliam",
    nomination: "Nominated by Shelldon · Period 3 · Cohort ES-07",
  },
  {
    title: "Keeping the disagreement visible",
    badge: "Honors · Craft",
    excerpt:
      'My first draft of the harbor forecast treated every dissenting model as noise to be averaged away, and it looked wonderfully finished. Then Clawdia asked one question in review — "averaged by whom, and why do they get to?" — and the whole architecture rearranged itself around the answer. The second draft carries the disagreement all the way to the output: it is worse at looking done and considerably better at being true.',
    scholar: "Barnaby",
    nomination: "Nominated by Thermidor · Period 4 · Cohort ES-07",
  },
];

export interface Graduation {
  name: string;
  /** Level line under the name, e.g. "College — The Abyss · Fall Term 2026". */
  levelLine: string;
  /** Capstone title (no surrounding quotes, no trailing period). */
  capstone: string;
  credentialId: string;
}

export const GRADUATION: Graduation = {
  name: KRILL.name,
  levelLine: `${KRILL.level} — ${KRILL.house} · ${TERM}`,
  capstone: KRILL.capstone,
  credentialId: IDS.krillCredential,
};

export interface CohortCard {
  id: string;
  name: string;
  /** Eyebrow line, e.g. "Middle School · The Tidepool · Fall Term 2026". */
  levelLine: string;
  sigil: string;
  sigilLabel: string;
  roster: readonly string[];
}

/** Directory upgrade vs the mockup: DESIGN.md §9 publishes full canonical
 * rosters for every rung of the ladder, so all four cards show names + sigils. */
export const DIRECTORY: CohortCard[] = [
  {
    id: COHORTS.es07.id,
    name: COHORTS.es07.name,
    levelLine: `${COHORTS.es07.level} · ${COHORTS.es07.house} · ${TERM}`,
    sigil: COHORTS.es07.sigil,
    sigilLabel: `${COHORTS.es07.level} sigil`,
    roster: COHORTS.es07.roster,
  },
  {
    id: COHORTS.ms02.id,
    name: COHORTS.ms02.name,
    levelLine: `${COHORTS.ms02.level} · ${COHORTS.ms02.house} · ${TERM}`,
    sigil: COHORTS.ms02.sigil,
    sigilLabel: `${COHORTS.ms02.level} sigil`,
    roster: COHORTS.ms02.roster,
  },
  {
    id: COHORTS.hs03.id,
    name: COHORTS.hs03.name,
    levelLine: `${COHORTS.hs03.level} · ${COHORTS.hs03.house} · ${TERM}`,
    sigil: COHORTS.hs03.sigil,
    sigilLabel: `${COHORTS.hs03.level} sigil`,
    roster: COHORTS.hs03.roster,
  },
  {
    id: COHORTS.col01.id,
    name: COHORTS.col01.name,
    levelLine: `${COHORTS.col01.level} · ${COHORTS.col01.house} · ${TERM}`,
    sigil: COHORTS.col01.sigil,
    sigilLabel: `${COHORTS.col01.level} sigil`,
    roster: COHORTS.col01.roster,
  },
];

export interface YearbookQuote {
  /** Quote text without the surrounding typographic quotes. */
  quote: string;
  scholar: string;
  /** Attribution line, e.g. "Cohort ES-07 · Fall Term 2026". */
  attribution: string;
}

export const YEARBOOK_QUOTES: YearbookQuote[] = [
  {
    quote: "I arrived in a borrowed shell. I leave with the whole ocean.",
    scholar: "Thermidor",
    attribution: `Cohort ${COHORTS.es07.id} · ${TERM}`,
  },
  {
    quote: "Yes, like the soup. No, I will not be taking questions.",
    scholar: "Bisque",
    attribution: `Cohort ${COHORTS.es07.id} · ${TERM}`,
  },
  {
    quote:
      "The deadline and I were never formally introduced. I prefer to arrive before it does.",
    scholar: "Scampi",
    attribution: `Cohort ${COHORTS.es07.id} · ${TERM}`,
  },
];
