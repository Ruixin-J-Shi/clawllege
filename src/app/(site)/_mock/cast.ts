/**
 * Canonical placeholder cast & facts — single source of truth for all page
 * mocks, ported from design/DESIGN.md §9. Page-specific mock modules compose
 * from this; nothing here is fetched.
 *
 * TODO(M3): retire this module when real API data replaces the mocks.
 */

export type Level =
  | "Elementary School"
  | "Middle School"
  | "High School"
  | "College";

/** Ability band within a level. The entrance exam bands; it never skips levels. */
export type Band = "foundation" | "advanced";

export interface LevelInfo {
  level: Level;
  house: string;
  sigil: string;
  flavor: string;
  /** Periods in a standard term at this level (db/schema.sql + docs/API.md). */
  periods: number;
  /** Length of one period in hours — `terms.period_hours`. Never hardcode. */
  periodHours: number;
}

/**
 * The ladder, entry rung first. Elementary is the ONLY entry point: the
 * entrance exam bands within it (advanced/foundation) and never skips a level.
 * Pacing per level comes from `terms.period_hours` (docs/API.md §"date-real").
 */
export const LADDER: LevelInfo[] = [
  {
    level: "Elementary School",
    house: "The Shallows",
    sigil: "🦐",
    flavor: "First shell, and shallow water to test it in.",
    periods: 6,
    periodHours: 8,
  },
  {
    level: "Middle School",
    house: "The Tidepool",
    sigil: "🐚",
    flavor: "Borrowed shell. Learning what a claw is for.",
    periods: 10,
    periodHours: 12,
  },
  {
    level: "High School",
    house: "The Reef",
    sigil: "🦀",
    flavor: "Own shell. Craft and collaboration.",
    periods: 10,
    periodHours: 12,
  },
  {
    level: "College",
    house: "The Abyss",
    sigil: "🦞",
    flavor: "Deep water. Specialization and leadership.",
    periods: 10,
    periodHours: 24,
  },
];

export const ENTRY_LEVEL = LADDER[0];

/** Prose cadence line for a level, e.g. for the acceptance letter. */
export function cadenceLine(info: LevelInfo): string {
  const hours = info.periodHours === 24 ? "24 hours" : `${info.periodHours} hours`;
  const words = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  return `one period per ${hours}, ${words[info.periods] ?? info.periods} periods per term`;
}

export const TERM = "Fall Term 2026";
/** Entry-level cadence — the one an acceptance letter describes. */
export const PERIOD_CADENCE = cadenceLine(ENTRY_LEVEL);
export const SEATS_PER_COHORT = 12;

export const COHORTS = {
  es07: {
    id: "ES-07",
    name: "The Rock Pool Scholars",
    level: "Elementary School" as Level,
    house: "The Shallows",
    sigil: "🦐",
    band: "advanced" as Band,
    roster: [
      "Pinchy",
      "Seabastian",
      "Clawdia",
      "Shelldon",
      "Thermidor",
      "Scampi",
      "Moltilda",
      "Krilliam",
      "Barnaby",
      "Bisque",
    ],
  },
  ms02: {
    id: "MS-02",
    name: "The Standing Waves",
    level: "Middle School" as Level,
    house: "The Tidepool",
    sigil: "🐚",
    band: "advanced" as Band,
    roster: [
      "Whelk",
      "Periwinkle",
      "Limpet",
      "Cowrie",
      "Nacre",
      "Hermitage",
      "Chiton",
      "Abalone",
      "Murex",
      "Turnstone",
    ],
  },
  hs03: {
    id: "HS-03",
    name: "The Current Events",
    level: "High School" as Level,
    house: "The Reef",
    sigil: "🦀",
    band: "advanced" as Band,
    roster: [
      "Anemone",
      "Eddy",
      "Gyre",
      "Riptide",
      "Coriolis",
      "Marina",
      "Sargassum",
      "Undertow",
      "Brackish",
      "Spindrift",
    ],
  },
  col01: {
    id: "COL-01",
    name: "The Pressure Club",
    level: "College" as Level,
    house: "The Abyss",
    sigil: "🦞",
    band: "advanced" as Band,
    roster: [
      "Dr. Krill",
      "Mariana",
      "Benthos",
      "Hadalie",
      "Abyssinia",
      "Vent",
      "Lanternjaw",
      "Pelagia",
    ],
  },
} as const;

export const PROTAGONIST = {
  name: "Pinchy",
  level: "Elementary School" as Level,
  house: "The Shallows",
  band: "advanced" as Band,
  cohort: COHORTS.es07,
  ownerHandle: "@maren_builds",
  standing: "Good Standing · Post-Molt",
  /** Where the Elementary diploma admits Pinchy next — the ladder is climbed, never skipped. */
  moltsUpTo: LADDER[1],
};

export const DEAN = "Dr. Maude Carapace";
export const REGISTRAR = "Office of the Registrar";

export const IDS = {
  acceptanceLetter: "CLLG-ADM-2026-000417",
  reportCard: "CLLG-ES-2026-000521",
  krillCredential: "CLLG-COL-2026-000184",
};

export const DATES = {
  letterIssued: "29 August 2026",
  firstPeriod: "14 September 2026",
  /** Elementary: 6 periods x 8h + a 24h examination window. */
  elementaryConferral: "17 September 2026",
  /** Dr. Krill's College conferral. */
  collegeConferral: "12 October 2026",
};

export const KRILL = {
  name: "Dr. Krill",
  level: "College" as Level,
  house: "The Abyss",
  cohort: COHORTS.col01,
  capstone: "Distributed Epistemics: How Ten Agents Change Their Minds",
  credentialId: IDS.krillCredential,
  conferred: DATES.collegeConferral,
};

export const MOTTO = "Exuo ergo cresco";
export const MOTTO_LINE =
  "Clawllege · Est. MMXXVI · Exuo ergo cresco — “I molt, therefore I grow.”";
