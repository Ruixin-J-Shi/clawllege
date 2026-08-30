/**
 * Where page data comes from.
 *
 * Every surface reads through `_data/`, so flipping a domain from mock content
 * to a live endpoint is an environment change here, not an edit in the pages.
 *
 * `CLAWLLEGE_DATA_SOURCE` accepts:
 *   mock                 — all domains mock-backed (default, and correct until
 *                          worker-1's owner/campus endpoints land)
 *   live                 — all domains fetched
 *   campus,dashboard,... — comma-separated list of domains to take live
 *
 * Kept deliberately explicit: a getter that silently fell back to mock content
 * when a fetch failed would let a broken endpoint ship looking healthy.
 */

export type DataDomain = "campus" | "dashboard" | "credentials";

const ALL: DataDomain[] = ["campus", "dashboard", "credentials"];

function configured(): Set<DataDomain> {
  const raw = (process.env.CLAWLLEGE_DATA_SOURCE ?? "mock").trim().toLowerCase();
  if (raw === "" || raw === "mock") return new Set();
  if (raw === "live") return new Set(ALL);
  const picked = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is DataDomain => (ALL as string[]).includes(s));
  return new Set(picked);
}

/** True when this domain should be fetched rather than served from `_mock/`. */
export function isLive(domain: DataDomain): boolean {
  return configured().has(domain);
}

/**
 * Absolute base for server-side fetches of our own API.
 *
 * Order matters: an explicit env var wins (the API may live on another host),
 * otherwise we use the origin of the request being served. Guessing a port from
 * `process.env.PORT` was the previous default and it was wrong the moment the
 * app ran on any other port — `next dev --port 3333` sends no PORT, so every
 * self-call went to :3000 and failed.
 */
export async function apiBaseUrl(): Promise<string> {
  const configuredBase = process.env.CLAWLLEGE_API_BASE_URL;
  if (configuredBase) return configuredBase;

  const { headers } = await import("next/headers");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (host) {
    const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
    return `${proto}://${host}`;
  }
  throw new Error(
    "Cannot resolve an API base URL: no request origin available and CLAWLLEGE_API_BASE_URL is unset.",
  );
}

export class ApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** GET JSON from our own API. Throws loudly — see the note above on fallbacks. */
export async function fetchApi<T>(
  path: string,
  init?: RequestInit & { revalidate?: number },
): Promise<T> {
  const { revalidate, ...rest } = init ?? {};
  const base = await apiBaseUrl();
  const res = await fetch(`${base}${path}`, {
    ...rest,
    headers: { accept: "application/json", ...(rest.headers ?? {}) },
    next: revalidate === undefined ? undefined : { revalidate },
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body?.error?.message ? ` — ${body.error.message}` : "";
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(path, res.status, `GET ${path} failed (${res.status})${detail}`);
  }
  return (await res.json()) as T;
}
