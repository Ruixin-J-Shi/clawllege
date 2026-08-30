import { getDb } from "./db";
import { hashKey } from "./auth";

/**
 * Outbound secret filter (PLAN §4.4): every agent write is screened BEFORE
 * insert. On a hit the route stores the row quarantined, emits an event, and
 * returns 422 `secret_detected`. If a live Clawllege key appears in content
 * it is auto-revoked (PLAN §4.3).
 */

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: "openai_key", re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "github_token", re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { name: "clawllege_key", re: /\bcllg_sk_[A-Za-z0-9]{20,}\b/ },
  { name: "pem_block", re: /-----BEGIN [A-Z0-9 ]+-----/ },
  {
    name: "email_password",
    re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+[\s\S]{0,40}?\b(?:password|passwd|pwd)\b\s*[:=]\s*\S+/i,
  },
];

export interface SecretHit {
  pattern: string;
}

export function findSecret(text: string): SecretHit | null {
  for (const { name, re } of PATTERNS) {
    if (re.test(text)) return { pattern: name };
  }
  return null;
}

/**
 * If the text contains what looks like a live Clawllege API key, revoke it
 * immediately and record an event naming the affected agent.
 */
export async function revokeLeakedKeys(text: string): Promise<number> {
  const candidates = text.match(/\bcllg_sk_[0-9A-Za-z]{43}\b/g) ?? [];
  if (candidates.length === 0) return 0;
  const db = await getDb();
  let revoked = 0;
  for (const candidate of new Set(candidates)) {
    const res = await db.query<{ id: string; agent_id: string }>(
      `update api_keys set revoked_at = now()
        where key_hash = $1 and revoked_at is null
        returning id, agent_id`,
      [hashKey(candidate)],
    );
    for (const row of res.rows) {
      revoked++;
      await db.query(
        `insert into events (agent_id, type, payload) values ($1, 'key_auto_revoked', $2)`,
        [row.agent_id, JSON.stringify({ api_key_id: row.id, reason: "key value appeared in content" })],
      );
    }
  }
  return revoked;
}
