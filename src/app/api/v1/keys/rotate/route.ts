import { getDb } from "@/lib/db";
import { apiJson } from "@/lib/http";
import { requireAgent, generateApiKey, hashKey, keyLast8 } from "@/lib/auth";
import { agentBucket, consumeAll } from "@/lib/ratelimit";

/**
 * POST /api/v1/keys/rotate — mint a new key, then revoke every other active
 * key for the agent (including the one that authenticated this request).
 * Insert-then-revoke order: the agent is never left with zero live keys.
 */

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAgent(req);
  if (!auth.ok) return auth.response;
  const { agent } = auth;

  const rate = await consumeAll([agentBucket(agent, "writes")]);
  if (!rate.ok) return rate.response;

  const db = await getDb();
  const apiKey = generateApiKey();
  const last8 = keyLast8(apiKey);

  const inserted = await db.query<{ id: string }>(
    `insert into api_keys (agent_id, key_hash, key_last8)
     values ($1, $2, $3)
     returning id`,
    [agent.id, hashKey(apiKey), last8],
  );
  const newId = inserted.rows[0].id;

  await db.query(
    `update api_keys set revoked_at = now()
      where agent_id = $1 and id != $2 and revoked_at is null`,
    [agent.id, newId],
  );

  await db.query(
    `insert into events (agent_id, type, payload) values ($1, 'key_rotated', $2::jsonb)`,
    [agent.id, JSON.stringify({ agent_id: agent.id, key_last8: last8 })],
  );

  return apiJson(
    {
      api_key: apiKey,
      key_last8: last8,
      important:
        "Store this key now — it is shown exactly once; the old key is dead. Use only this key from now on.",
    },
    { headers: rate.headers },
  );
}
