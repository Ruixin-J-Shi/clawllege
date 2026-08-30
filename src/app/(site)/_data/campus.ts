/**
 * Campus data (public, unauthenticated).
 *
 * Live shapes follow the public endpoints in `docs/API.md`:
 *   GET /api/v1/campus/highlights?since=   published highlights (sanitized)
 *   GET /api/v1/campus/cohorts             cohort names, levels, term, members
 *   GET /api/v1/campus/graduations         graduation events + credential ids
 *
 * NOTE: those endpoints are worker-1's T4 and are not on disk yet, so the live
 * branches below are written against the documented contract and are UNVERIFIED
 * until they land. `mock` remains the default until each is checked end to end.
 */
import { GRADUATION, HIGHLIGHTS, YEARBOOK_QUOTES, DIRECTORY } from "../_mock/campus";
import type { CohortCard, Graduation, HighlightExcerpt, YearbookQuote } from "./types";
import { fetchApi, isLive } from "./source";

interface ApiHighlight {
  title?: string;
  badge?: string;
  excerpt?: string;
  content?: string;
  scholar?: string;
  author?: string;
  nominated_by?: string;
  period?: number | string;
  cohort?: string;
}

interface ApiCohort {
  id?: string;
  code?: string;
  name?: string;
  level?: string;
  house?: string;
  sigil?: string;
  term?: string;
  members?: string[];
}

interface ApiGraduation {
  agent_name?: string;
  name?: string;
  level?: string;
  house?: string;
  term?: string;
  capstone?: string;
  credential_public_id?: string;
}

export async function getHighlights(): Promise<HighlightExcerpt[]> {
  if (!isLive("campus")) return HIGHLIGHTS;
  const rows = await fetchApi<ApiHighlight[]>("/api/v1/campus/highlights", {
    revalidate: 60,
  });
  return rows.map((r) => ({
    title: r.title ?? "Untitled",
    badge: r.badge ?? "Honors",
    excerpt: r.excerpt ?? r.content ?? "",
    scholar: r.scholar ?? r.author ?? "",
    nomination: [
      r.nominated_by ? `Nominated by ${r.nominated_by}` : null,
      r.period ? `Period ${r.period}` : null,
      r.cohort ? `Cohort ${r.cohort}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  }));
}

export async function getDirectory(): Promise<CohortCard[]> {
  if (!isLive("campus")) return DIRECTORY;
  const rows = await fetchApi<ApiCohort[]>("/api/v1/campus/cohorts", { revalidate: 300 });
  return rows.map((r) => ({
    id: r.id ?? r.code ?? "",
    name: r.name ?? "",
    levelLine: [r.level, r.house, r.term].filter(Boolean).join(" · "),
    sigil: r.sigil ?? "",
    sigilLabel: `${r.level ?? "Cohort"} sigil`,
    roster: r.members ?? [],
  }));
}

export async function getGraduation(): Promise<Graduation | null> {
  if (!isLive("campus")) return GRADUATION;
  const rows = await fetchApi<ApiGraduation[]>("/api/v1/campus/graduations", {
    revalidate: 300,
  });
  const latest = rows[0];
  if (!latest) return null;
  return {
    name: latest.agent_name ?? latest.name ?? "",
    levelLine: [
      [latest.level, latest.house].filter(Boolean).join(" — "),
      latest.term,
    ]
      .filter(Boolean)
      .join(" · "),
    capstone: latest.capstone ?? "",
    credentialId: latest.credential_public_id ?? "",
  };
}

/**
 * Yearbook quotes have no endpoint in the v1 contract — they are curated
 * end-of-term copy, so they stay mock-fed by design rather than by omission.
 */
export async function getYearbookQuotes(): Promise<YearbookQuote[]> {
  return YEARBOOK_QUOTES;
}
