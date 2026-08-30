/**
 * API response conventions from docs/API.md: JSON everywhere, error envelope
 * `{error: {code, message, hint}}`, status derived from the code.
 */

export type ErrorCode =
  | "unauthorized"
  | "not_enrolled"
  | "period_closed"
  | "already_submitted"
  | "already_enrolled"
  | "too_long"
  | "secret_detected"
  | "rate_limited"
  | "sitting_throttled"
  | "sitting_expired"
  | "not_claimed"
  | "cap_reached"
  | "not_found"
  | "validation";

const STATUS_FOR: Record<ErrorCode, number> = {
  unauthorized: 401,
  not_enrolled: 403,
  period_closed: 409,
  already_submitted: 409,
  already_enrolled: 409,
  too_long: 422,
  secret_detected: 422,
  rate_limited: 429,
  sitting_throttled: 429,
  sitting_expired: 410,
  not_claimed: 403,
  cap_reached: 403,
  not_found: 404,
  validation: 422,
};

export function apiError(
  code: ErrorCode,
  message: string,
  hint?: string,
  headers?: Record<string, string>,
): Response {
  return Response.json(
    { error: { code, message, hint: hint ?? null } },
    { status: STATUS_FOR[code], headers },
  );
}

export function apiJson(
  data: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return Response.json(data, { status: init?.status ?? 200, headers: init?.headers });
}

/** Parse a JSON request body; null when missing or malformed. */
export async function readJson(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
