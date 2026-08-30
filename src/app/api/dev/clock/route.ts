import { apiError, apiJson, readJson } from "@/lib/http";
import { advanceBy, isOverridden, nowIso, resetClock, setNow, DAY, HOUR, MINUTE } from "@/lib/clock";

/**
 * ============================================================================
 * DEV/TEST TOOLING — POST /api/dev/clock   (and GET to read the clock)
 * ============================================================================
 * Drives lib/clock over HTTP so an out-of-process harness (worker-3's
 * simulated semester) can run a whole term in seconds instead of waiting out
 * real 8-hour periods and 24-hour exam windows.
 *
 * HARD-INERT IN PRODUCTION. Guarded by the same `NODE_ENV !== "production"`
 * check as lib/clock itself, so this route cannot move a real deployment's
 * clock even if it is accidentally deployed. It is deliberately ABSENT from
 * skill.md and docs/API.md: it is tooling, not surface, and agents must never
 * learn it exists — an agent that could wind the clock forward could open its
 * own exam window.
 *
 *   GET                                  -> { now, overridden }
 *   POST {"action":"set","to":"2026-09-14T00:00:00Z"}
 *   POST {"action":"advance","ms":28800000}      // or {"hours":8} / {"days":1}
 *   POST {"action":"reset"}
 * ============================================================================
 */

function disabled(): Response {
  return apiError(
    "not_found",
    "No such route.",
    // Deliberately uninformative: in production this endpoint does not exist.
    undefined,
  );
}

const isProd = () => process.env.NODE_ENV === "production";

export async function GET(): Promise<Response> {
  if (isProd()) return disabled();
  return apiJson({ now: nowIso(), overridden: isOverridden() });
}

export async function POST(req: Request): Promise<Response> {
  if (isProd()) return disabled();

  const body = (await readJson(req)) as
    | { action?: unknown; to?: unknown; ms?: unknown; hours?: unknown; days?: unknown; minutes?: unknown }
    | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return apiError("validation", "Body must be a JSON object.", 'Send {"action":"set|advance|reset", …}.');
  }

  const action = body.action;
  try {
    if (action === "set") {
      if (typeof body.to !== "string" && typeof body.to !== "number") {
        return apiError("validation", "`to` must be an ISO-8601 string or epoch milliseconds.");
      }
      setNow(body.to);
    } else if (action === "advance") {
      const ms =
        typeof body.ms === "number" ? body.ms
        : typeof body.minutes === "number" ? body.minutes * MINUTE
        : typeof body.hours === "number" ? body.hours * HOUR
        : typeof body.days === "number" ? body.days * DAY
        : null;
      if (ms === null) {
        return apiError("validation", "Give one of `ms`, `minutes`, `hours` or `days`.", "Negative values travel backwards, which fixtures sometimes want.");
      }
      advanceBy(ms);
    } else if (action === "reset") {
      resetClock();
    } else {
      return apiError("validation", `Unknown action ${JSON.stringify(action)}.`, "One of: set, advance, reset.");
    }
  } catch (err) {
    return apiError("validation", err instanceof Error ? err.message : String(err));
  }

  return apiJson({ now: nowIso(), overridden: isOverridden(), action });
}
