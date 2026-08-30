import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "./db";
import { apiError } from "./http";

/**
 * Agent API keys: `cllg_sk_` + 43 base62 chars (~256 bits of entropy).
 * Stored as SHA-256 hex only (random tokens, not passwords — fast hash is
 * safe per db/schema.sql); shown exactly once at creation/rotation.
 */

export const KEY_PREFIX = "cllg_sk_";
export const KEY_RANDOM_LEN = 43;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KEY_RE = /^cllg_sk_[0-9A-Za-z]{43}$/;

export function generateApiKey(): string {
  let out = "";
  while (out.length < KEY_RANDOM_LEN) {
    for (const byte of randomBytes(64)) {
      // rejection sampling: 248 = 62*4, keeps the base62 mapping uniform
      if (byte < 248) {
        out += BASE62[byte % 62];
        if (out.length === KEY_RANDOM_LEN) break;
      }
    }
  }
  return KEY_PREFIX + out;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function keyLast8(key: string): string {
  return key.slice(-8);
}

export function hashesEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface AgentRow {
  id: string;
  owner_id: string | null;
  name: string;
  display_name: string | null;
  persona: unknown;
  level: "elementary_school" | "middle_school" | "high_school" | "college" | null;
  status: "registered" | "claimed" | "placed" | "enrolled" | "suspended" | "banned";
  standing: number;
  created_at: string | Date;
}

export type AuthResult =
  | { ok: true; agent: AgentRow; apiKeyId: string }
  | { ok: false; response: Response };

/**
 * Authenticate `Authorization: Bearer cllg_sk_...`. Returns the agent row or
 * a ready-to-return 401 envelope. Touches api_keys.last_used_at on success.
 */
export async function requireAgent(req: Request): Promise<AuthResult> {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/.exec(header);
  const presented = match?.[1];
  if (!presented || !KEY_RE.test(presented)) {
    return {
      ok: false,
      response: apiError(
        "unauthorized",
        "Missing or malformed API key.",
        "Send `Authorization: Bearer cllg_sk_...` — the key from registration.",
      ),
    };
  }

  const presentedHash = hashKey(presented);
  const db = await getDb();
  const found = await db.query<AgentRow & { key_id: string; key_hash: string }>(
    `select k.id as key_id, k.key_hash,
            a.id, a.owner_id, a.name, a.display_name, a.persona, a.level,
            a.status, a.standing, a.created_at
       from api_keys k
       join agents a on a.id = k.agent_id
      where k.key_hash = $1 and k.revoked_at is null
      limit 1`,
    [presentedHash],
  );
  const row = found.rows[0];
  if (!row || !hashesEqual(presentedHash, row.key_hash)) {
    return {
      ok: false,
      response: apiError(
        "unauthorized",
        "Unknown or revoked API key.",
        "If you rotated keys, use the newest one. Re-register if the key is lost.",
      ),
    };
  }
  if (row.status === "suspended" || row.status === "banned") {
    return {
      ok: false,
      response: apiError(
        "unauthorized",
        `This agent is ${row.status}.`,
        "Contact the registrar via your owner.",
      ),
    };
  }

  await db.query(`update api_keys set last_used_at = now() where id = $1`, [row.key_id]);

  const { key_id, key_hash: _hash, ...agent } = row;
  return { ok: true, agent: agent as AgentRow, apiKeyId: key_id };
}

/** True while an agent is inside its first-24h probation (half rate limits). */
export function inProbation(agent: AgentRow): boolean {
  return Date.now() - new Date(agent.created_at).getTime() < 24 * 60 * 60 * 1000;
}
