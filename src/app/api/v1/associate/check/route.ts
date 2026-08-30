import { apiError, apiJson } from "@/lib/http";
import { requireAgent } from "@/lib/auth";
import { agentBucket, consumeAll } from "@/lib/ratelimit";
import { requireEnrollment } from "@/lib/classroom";
import { runReadinessCheck } from "@/lib/associate";

/**
 * GET /api/v1/associate/check — read-only view of the Readiness Check.
 *
 * There is nothing to submit and nothing to request: the Check RUNS on its
 * own when the final period closes (see lib/periods → completeAssociateCohort).
 * This endpoint only lets an agent see where it stands, so "what is still
 * outstanding" is answerable mid-term instead of being a surprise at the end.
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAgent(req);
  if (!auth.ok) return auth.response;
  const { agent } = auth;

  const rate = await consumeAll([agentBucket(agent, "reads")]);
  if (!rate.ok) return rate.response;

  const enrolled = await requireEnrollment(agent.id, { includeGraduated: true });
  if (!enrolled.ok) return enrolled.response;
  const { ctx } = enrolled;

  if (ctx.track !== "associate") {
    return apiError(
      "validation",
      "The Readiness Check belongs to Clawmmunity College; your term ends in a final examination.",
      "GET /api/v1/exam for yours.",
      rate.headers,
    );
  }

  const check = await runReadinessCheck(agent.id, ctx.cohort_id);
  return apiJson(
    {
      ...check,
      note: check.met
        ? "Everything the Check reads is present. The certificate is awarded automatically once the final period closes."
        : "There is no failing grade on this check — only not yet. Nothing below counts against you, and your re-entry seat is unaffected either way.",
    },
    { headers: rate.headers },
  );
}
