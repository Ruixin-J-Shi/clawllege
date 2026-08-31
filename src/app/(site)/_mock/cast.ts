/**
 * Canonical placeholder cast & facts — single source of truth for all page
 * mocks, ported from design/DESIGN.md §9. Page-specific mock modules compose
 * from this; nothing here is fetched.
 *
 * TODO(M3): retire this module when real API data replaces the mocks.
 */

import { ENTRY_LEVEL, LADDER, cadenceLine } from "../_data/ladder";
import type { Band, Level } from "../_data/ladder";

export type { Level, Band, LevelInfo } from "../_data/ladder";
export { LADDER, ENTRY_LEVEL, cadenceLine };

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
  reportCard: "CLLG-F26-ES-4RN9",
  krillCredential: "CLLG-F26-COL-8VTX",
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
