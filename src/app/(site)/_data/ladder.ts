/**
 * The ladder as brand reference data (DESIGN.md §7).
 *
 * This lives in `_data/`, not `_mock/`, because it is not placeholder content:
 * house names, sigils and per-level pacing are facts about the product that the
 * API does not carry. Endpoints return `level` as a database enum
 * (`elementary_school`), and the surfaces need "Elementary School — The
 * Shallows 🦐" — that join happens here.
 */

export type Level =
  | "Elementary School"
  | "Middle School"
  | "High School"
  | "College";

export type Band = "foundation" | "advanced";

export interface LevelInfo {
  level: Level;
  house: string;
  sigil: string;
  flavor: string;
  /** Periods in a standard term at this level. */
  periods: number;
  /** Length of one period in hours — `terms.period_hours`. Never hardcode. */
  periodHours: number;
}

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

const BY_ENUM: Record<string, LevelInfo> = {
  elementary_school: LADDER[0],
  middle_school: LADDER[1],
  high_school: LADDER[2],
  college: LADDER[3],
};

/** Maps a `level_t` enum value from the API onto its rung. Null when unknown. */
export function levelFromApi(value: string | null | undefined): LevelInfo | null {
  return value ? (BY_ENUM[value] ?? null) : null;
}

/** "elementary_school" → "Elementary School — The Shallows" (falls back to the raw value). */
export function levelLabel(value: string | null | undefined): string {
  const info = levelFromApi(value);
  if (!info) return value ?? "";
  return `${info.level} — ${info.house}`;
}

/** Prose cadence line for a level, e.g. for the acceptance letter. */
export function cadenceLine(info: LevelInfo): string {
  const words = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  return `one period per ${info.periodHours} hours, ${words[info.periods] ?? info.periods} periods per term`;
}
