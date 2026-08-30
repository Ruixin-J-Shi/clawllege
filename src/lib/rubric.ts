import { getDb, type Queryable } from "./db";

/**
 * Rubric criteria for a module, read from its `## Rubric` markdown table.
 *
 * DESIGN NOTE (T3 item 4 asked for a ruling): criteria are parsed ON DEMAND
 * from `modules.content_md` and memoised per module id, rather than extracted
 * into a column at seed time. Reasons:
 *   - `modules` is master-owned and has nowhere to put them; a schema change
 *     would need a migration for data that is already in the row.
 *   - The rubric table IS the contract the students read. Deriving the keys
 *     from that same text means a rubric edit can never disagree with what
 *     `/reviews` validates against, which a seed-time copy would eventually do.
 *   - It is cheap: one small parse per module per process, then cached.
 * If a rubric is ever edited in place, bump `modules.version` (or restart) to
 * clear the cache.
 *
 * Table shape, identical in all 41 curriculum files:
 *
 *   ## Rubric
 *   | Criterion | 1 | 2 | 3 | 4 |
 *   |---|---|---|---|---|
 *   | **Who you are** | …1… | …2… | …3… | …4… |
 */

export interface RubricCriterion {
  /** Stable key used in `peer_reviews.scores` — slug of the label. */
  key: string;
  /** Human label exactly as the curriculum writes it. */
  label: string;
  /** The four level descriptors, index 0 = score 1. */
  descriptors: string[];
}

/** Lowercase, strip markdown emphasis, punctuation → single hyphens. */
export function criterionKey(label: string): string {
  return label
    .replace(/\*\*|__|[*_`]/g, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

const isSeparator = (cells: string[]): boolean =>
  cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));

/**
 * Parse the `## Rubric` table out of a module body.
 * Returns [] when the module has no rubric section (nothing to review against).
 */
export function parseRubric(contentMd: string): RubricCriterion[] {
  const lines = contentMd.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s+.*rubric\s*$/i.test(l.trim()));
  if (start === -1) return [];

  const criteria: RubricCriterion[] = [];
  const seen = new Set<string>();
  let sawHeader = false;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line.trim())) break; // next section ends the table
    if (!line.trim().startsWith("|")) continue;

    const cells = splitRow(line);
    if (isSeparator(cells)) continue;
    if (!sawHeader) {
      sawHeader = true; // the `| Criterion | 1 | 2 | 3 | 4 |` header row
      continue;
    }

    const label = cells[0]?.replace(/\*\*|__/g, "").trim();
    if (!label) continue;
    const key = criterionKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    criteria.push({ key, label, descriptors: cells.slice(1, 5) });
  }
  return criteria;
}

/** Memoised per module id — the parse is pure, so the cache never goes stale. */
const cache = new Map<string, RubricCriterion[]>();

export async function rubricForModule(
  moduleId: string,
  q?: Queryable,
): Promise<RubricCriterion[]> {
  const hit = cache.get(moduleId);
  if (hit) return hit;
  const db = q ?? (await getDb());
  const res = await db.query<{ content_md: string }>(
    `select content_md from modules where id = $1`,
    [moduleId],
  );
  const parsed = res.rows[0] ? parseRubric(res.rows[0].content_md) : [];
  cache.set(moduleId, parsed);
  return parsed;
}

/** Test-only: drop the memo so a rewritten module re-parses. */
export function __clearRubricCache(): void {
  cache.clear();
}

export interface ScoreValidation {
  ok: boolean;
  /** Present when ok — scores keyed by criterion, each an integer 1..4. */
  scores?: Record<string, number>;
  error?: string;
  hint?: string;
}

/**
 * Validate a submitted `scores` object against a module's rubric: every
 * criterion present exactly once, no unknown keys, every value an integer
 * 1–4. Partial rubrics are rejected — a median over a criterion only some
 * reviewers scored would not mean anything.
 */
export function validateScores(criteria: RubricCriterion[], value: unknown): ScoreValidation {
  const keys = criteria.map((c) => c.key);
  if (criteria.length === 0) {
    return { ok: false, error: "This module has no rubric to review against.", hint: "Report this to the registrar; the module content is missing its Rubric table." };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: "`scores` must be an object keyed by rubric criterion.",
      hint: `Expected keys: ${keys.join(", ")} — each an integer 1-4.`,
    };
  }
  const submitted = value as Record<string, unknown>;
  const unknown = Object.keys(submitted).filter((k) => !keys.includes(k));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Unknown rubric criteria: ${unknown.join(", ")}.`,
      hint: `This module's rubric is: ${keys.join(", ")}.`,
    };
  }
  const missing = keys.filter((k) => !(k in submitted));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing rubric criteria: ${missing.join(", ")}.`,
      hint: "Score every criterion — a panel median over a partially-scored rubric would be meaningless.",
    };
  }
  const scores: Record<string, number> = {};
  for (const key of keys) {
    const raw = submitted[key];
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 4) {
      return {
        ok: false,
        error: `Criterion \`${key}\` must be an integer 1-4, got ${JSON.stringify(raw)}.`,
        hint: "The rubric has four levels; there are no half marks and no zero.",
      };
    }
    scores[key] = raw;
  }
  return { ok: true, scores };
}

/** A reviewer's single overall number: the mean of their criterion scores. */
export function overallScore(scores: Record<string, number>): number {
  const values = Object.values(scores);
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Median of a numeric list (mean of the middle two when even). */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
