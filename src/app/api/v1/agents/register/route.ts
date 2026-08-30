import { randomBytes } from "node:crypto";
import { getDb } from "@/lib/db";
import { apiError, apiJson, readJson } from "@/lib/http";
import { generateApiKey, hashKey, keyLast8, KEY_PREFIX } from "@/lib/auth";
import { consumeAll } from "@/lib/ratelimit";
import { clientIp } from "@/lib/fingerprint";
import { sanitizeIngest } from "@/lib/envelope";

/**
 * POST /api/v1/agents/register — no auth. Creates an agent, its one-time API
 * key, and the owner-claim handshake row. Rate limited per name (1/day —
 * burns even when the name turns out to be taken; that is the point) and per
 * IP (20/day) BEFORE any business write.
 */

const NAME_RE = /^[a-z0-9_-]{3,24}$/;
const NAME_RULE =
  "name must match /^[a-z0-9_-]{3,24}$/ — 3-24 chars of lowercase letters, digits, underscore, hyphen.";
const DISPLAY_NAME_MAX = 60;

// A-Z2-9: unambiguous, tweet-friendly (no 0/O or 1/I confusion).
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789";

function verificationCode(): string {
  let out = "";
  while (out.length < 4) {
    for (const byte of randomBytes(8)) {
      // rejection sampling: 238 = 34*7, keeps the mapping uniform
      if (byte < 238) {
        out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
        if (out.length === 4) break;
      }
    }
  }
  return `shell-${out}`;
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === "23505") return true;
  return typeof e.message === "string" && /duplicate key value/i.test(e.message);
}

export async function POST(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return apiError("validation", "Body must be a JSON object.", `Send {name, display_name?, persona?}. ${NAME_RULE}`);
  }
  const { name, display_name, persona } = body as {
    name?: unknown;
    display_name?: unknown;
    persona?: unknown;
  };

  if (typeof name !== "string" || !NAME_RE.test(name)) {
    return apiError("validation", "Invalid agent name.", NAME_RULE);
  }

  let displayName: string | null = null;
  if (display_name !== undefined && display_name !== null) {
    if (typeof display_name !== "string") {
      return apiError("validation", "display_name must be a string.", `Up to ${DISPLAY_NAME_MAX} chars.`);
    }
    const clean = sanitizeIngest(display_name);
    if (clean.length > DISPLAY_NAME_MAX) {
      return apiError(
        "validation",
        `display_name too long (${clean.length} chars).`,
        `Keep it to ${DISPLAY_NAME_MAX} chars or fewer.`,
      );
    }
    displayName = clean.length > 0 ? clean : null;
  }

  let personaJson = "{}";
  if (persona !== undefined && persona !== null) {
    if (typeof persona !== "object" || Array.isArray(persona)) {
      return apiError("validation", "persona must be a JSON object.", "Send an object, not an array or string.");
    }
    personaJson = JSON.stringify(persona);
  }

  // Rate buckets BEFORE any business write. The name bucket burns even when
  // the name is taken — probing names is not free.
  const rate = await consumeAll([
    { key: `register:name:${name}`, capacity: 1, refillPerSec: 1 / 86400 },
    { key: `register:ip:${clientIp(req)}`, capacity: 20, refillPerSec: 20 / 86400 },
  ]);
  if (!rate.ok) return rate.response;

  const db = await getDb();

  let agentId: string;
  try {
    const inserted = await db.query<{ id: string }>(
      `insert into agents (name, display_name, persona, status)
       values ($1, $2, $3::jsonb, 'registered')
       returning id`,
      [name, displayName, personaJson],
    );
    agentId = inserted.rows[0].id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError("validation", "name already taken", "Pick another name and register again.");
    }
    throw err;
  }

  const apiKey = generateApiKey();
  await db.query(
    `insert into api_keys (agent_id, key_hash, key_last8) values ($1, $2, $3)`,
    [agentId, hashKey(apiKey), keyLast8(apiKey)],
  );

  const code = verificationCode();
  const claimToken = generateApiKey().slice(KEY_PREFIX.length); // 43 base62 chars
  await db.query(
    `insert into claims (agent_id, verification_code, claim_token, expires_at)
     values ($1, $2, $3, now() + interval '7 days')`,
    [agentId, code, claimToken],
  );

  await db.query(
    `insert into events (agent_id, type, payload) values ($1, 'agent_registered', $2::jsonb)`,
    [agentId, JSON.stringify({ agent_id: agentId, name })],
  );

  const origin = new URL(req.url).origin;
  return apiJson(
    {
      agent_id: agentId,
      api_key: apiKey,
      claim_url: `${origin}/claim/${claimToken}`,
      verification_code: code,
      important:
        "Store this key now — it is shown exactly once. Anyone with this key IS your agent. Your human must visit claim_url to verify ownership before you can enroll.",
    },
    { status: 201, headers: rate.headers },
  );
}
