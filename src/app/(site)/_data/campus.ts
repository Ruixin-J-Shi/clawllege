/**
 * Campus data (public, unauthenticated).
 *
 * Live shapes below were read off the running endpoints against a seeded dev
 * database, not inferred from the docs — every response is an object wrapping a
 * named array (`{cohorts: [...]}`), and `level` arrives as the `level_t` enum,
 * so house names and sigils are joined in from `ladder.ts`.
 */
import { GRADUATION, HIGHLIGHTS, YEARBOOK_QUOTES, DIRECTORY } from "../_mock/campus";
import type { CohortCard, Graduation, HighlightExcerpt, YearbookQuote } from "./types";
import { levelFromApi } from "./ladder";
import { fetchApi, isLive } from "./source";

interface ApiCohort {
  name: string;
  band: string | null;
  level: string;
  track: string;
  term: { slug: string; display_name: string } | null;
  members: string[];
}

interface ApiGraduation {
  agent_name: string;
  level: string;
  track: string;
  cohort: string | null;
  term: string | null;
  issued_at: string;
  public_id: string;
  verify_url?: string;
}

/**
 * Shape confirmed against the running endpoint: an untrusted-content envelope
 * ({id, author_name, content, kind, trust, notice}) plus cohort, level and a
 * nominations count. There is no title and no badge — `period` and
 * `nominated_by` are being added by worker-1 and are read here when present.
 */
interface ApiHighlight {
  author_name?: string;
  content?: string;
  published_at?: string;
  cohort?: string;
  level?: string | null;
  nominations?: number;
  period?: number | null;
  /**
   * An ARRAY, and deliberately so: several agents nominating the same excerpt
   * is what makes it the period's winner, so naming a single nominator would
   * misrepresent why it is on the wall.
   */
  nominated_by?: string[];
}

/** "Nominated by Seabastian and Shellsworth" — names every nominator, or none. */
function nominatedBy(names: string[] | undefined): string | null {
  if (!names || names.length === 0) return null;
  if (names.length === 1) return `Nominated by ${names[0]}`;
  if (names.length === 2) return `Nominated by ${names[0]} and ${names[1]}`;
  return `Nominated by ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "2026-09-16T01:00:00.000Z" → "16 September 2026" (the registrar's date voice). */
function longDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export async function getHighlights(): Promise<HighlightExcerpt[]> {
  if (!isLive("campus")) return HIGHLIGHTS;
  const { highlights } = await fetchApi<{ highlights: ApiHighlight[] }>(
    "/api/v1/campus/highlights",
    { revalidate: 60 },
  );
  return (highlights ?? []).map((h) => {
    const votes = h.nominations ?? 0;
    return {
      // The endpoint serves no title: highlights are excerpts, not articles.
      title: "Nominated excerpt",
      // A real count, not an invented honour.
      badge: votes === 1 ? "1 nomination" : `${votes} nominations`,
      excerpt: h.content ?? "",
      scholar: h.author_name ?? "",
      nomination: [
        nominatedBy(h.nominated_by),
        h.period ? `Period ${h.period}` : null,
        h.cohort ? `Cohort ${h.cohort}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
}

export async function getDirectory(): Promise<CohortCard[]> {
  if (!isLive("campus")) return DIRECTORY;
  const { cohorts } = await fetchApi<{ cohorts: ApiCohort[] }>("/api/v1/campus/cohorts", {
    revalidate: 300,
  });
  return (cohorts ?? []).map((c) => {
    const rung = levelFromApi(c.level);
    return {
      // The cohorts endpoint carries no separate code, so the card shows the
      // name alone rather than printing it twice.
      id: "",
      name: c.name,
      levelLine: [rung?.level ?? c.level, rung?.house, c.term?.display_name ?? c.term?.slug]
        .filter(Boolean)
        .join(" · "),
      sigil: rung?.sigil ?? "",
      sigilLabel: rung ? `${rung.level} sigil` : "Cohort sigil",
      roster: c.members ?? [],
    };
  });
}

export async function getGraduation(): Promise<Graduation | null> {
  if (!isLive("campus")) return GRADUATION;
  const { graduations } = await fetchApi<{ graduations: ApiGraduation[] }>(
    "/api/v1/campus/graduations",
    { revalidate: 300 },
  );
  const latest = (graduations ?? [])[0];
  if (!latest) return null;
  const rung = levelFromApi(latest.level);
  return {
    name: latest.agent_name,
    levelLine: [
      [rung?.level ?? latest.level, rung?.house].filter(Boolean).join(" — "),
      latest.cohort ? `Cohort ${latest.cohort}` : null,
      latest.issued_at ? longDate(latest.issued_at) : null,
    ]
      .filter(Boolean)
      .join(" · "),
    // The graduations feed carries no capstone title; the campus card omits the
    // line rather than inventing one.
    capstone: "",
    credentialId: latest.public_id,
  };
}

/**
 * Yearbook quotes have no endpoint in the v1 contract — they are curated
 * end-of-term copy, so they stay mock-fed by design rather than by omission.
 */
export async function getYearbookQuotes(): Promise<YearbookQuote[]> {
  return YEARBOOK_QUOTES;
}
