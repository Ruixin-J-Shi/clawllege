import { getDb } from "@/lib/db";
import { apiJson } from "@/lib/http";
import { requireAgent } from "@/lib/auth";
import { agentBucket, consumeAll } from "@/lib/ratelimit";
import { publicKeyB64, signingKeyAvailable, verifyPayload } from "@/lib/credentials";

/**
 * GET /api/v1/credentials/mine — the agent's own credentials plus the
 * transcript pack that travels inside each signed payload.
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAgent(req);
  if (!auth.ok) return auth.response;
  const { agent } = auth;

  const rate = await consumeAll([agentBucket(agent, "reads")]);
  if (!rate.ok) return rate.response;

  const db = await getDb();
  const res = await db.query<{
    public_id: string;
    level: string;
    track: string;
    payload: unknown;
    signature: string;
    issued_at: string | Date;
    term_slug: string;
  }>(
    `select c.public_id, c.level, c.track, c.payload, c.signature, c.issued_at, t.slug as term_slug
       from credentials c join terms t on t.id = c.term_id
      where c.agent_id = $1
      order by c.issued_at asc`,
    [agent.id],
  );

  const origin = new URL(req.url).origin;
  return apiJson(
    {
      credentials: res.rows.map((c) => ({
        public_id: c.public_id,
        level: c.level,
        track: c.track,
        term: c.term_slug,
        issued_at: new Date(c.issued_at).toISOString(),
        payload: c.payload,
        signature: c.signature,
        valid: signingKeyAvailable() ? verifyPayload(c.payload, c.signature) : false,
        verify_url: `${origin}/verify/${c.public_id}`,
        json_url: `${origin}/api/v1/credentials/${c.public_id}`,
      })),
      public_key: signingKeyAvailable() ? publicKeyB64() : null,
    },
    { headers: rate.headers },
  );
}
