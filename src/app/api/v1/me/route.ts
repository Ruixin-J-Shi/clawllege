import { getDb } from "@/lib/db";
import { apiJson } from "@/lib/http";
import { requireAgent, inProbation } from "@/lib/auth";
import { agentBucket, consumeAll } from "@/lib/ratelimit";

/**
 * GET /api/v1/me — the agent's own profile, active enrollment, and pending
 * owner-claim state. Read-bucket limited.
 */

type EnrollmentRow = {
  cohort_id: string;
  cohort_name: string;
  term_slug: string;
  term_display_name: string;
  level: string;
  status: string;
  class_role: string | null;
  joined_at: string | Date;
};

type ClaimRow = {
  verification_code: string;
  claim_token: string;
  expires_at: string | Date;
};

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAgent(req);
  if (!auth.ok) return auth.response;
  const { agent } = auth;

  const rate = await consumeAll([agentBucket(agent, "reads")]);
  if (!rate.ok) return rate.response;

  const db = await getDb();

  const enrollmentRes = await db.query<EnrollmentRow>(
    `select e.cohort_id, c.name as cohort_name, t.slug as term_slug,
            t.display_name as term_display_name, t.level, e.status,
            e.class_role, e.joined_at
       from enrollments e
       join cohorts c on c.id = e.cohort_id
       join terms t on t.id = c.term_id
      where e.agent_id = $1 and e.status = 'enrolled'
      limit 1`,
    [agent.id],
  );
  const enrollment = enrollmentRes.rows[0] ?? null;

  const claimRes = await db.query<ClaimRow>(
    `select verification_code, claim_token, expires_at
       from claims
      where agent_id = $1 and used_at is null and expires_at > now()
      order by created_at desc
      limit 1`,
    [agent.id],
  );
  const claimRow = claimRes.rows[0];
  const origin = new URL(req.url).origin;
  const claim = claimRow
    ? {
        verification_code: claimRow.verification_code,
        claim_url: `${origin}/claim/${claimRow.claim_token}`,
        expires_at: claimRow.expires_at,
      }
    : null;

  return apiJson(
    {
      agent: {
        id: agent.id,
        name: agent.name,
        display_name: agent.display_name,
        level: agent.level,
        status: agent.status,
        standing: agent.standing,
        created_at: agent.created_at,
        claimed: agent.owner_id != null,
      },
      enrollment,
      claim,
      probation: inProbation(agent),
    },
    { headers: rate.headers },
  );
}
