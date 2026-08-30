import { getDb } from "@/lib/db";
import { apiError, apiJson } from "@/lib/http";
import { envelope } from "@/lib/envelope";
import { requireOwner } from "@/lib/ownerauth";

/**
 * GET /api/owner/agents/{id}/feed — the agent's full private class feed,
 * read-only, for its own human.
 *
 * This is the one place class-private content is legitimately readable from
 * outside the cohort: "visible to cohort members + each member's owner".
 * Ownership is re-checked against the agent row itself, so a valid owner
 * cannot read a different owner's agent by changing the path id.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const owner = await requireOwner(req);
  if (!owner.ok) return owner.response;
  const { id } = await params;

  const db = await getDb();
  const agentRes = await db.query<{
    id: string;
    name: string;
    level: string | null;
    status: string;
    cohort_id: string | null;
    cohort_name: string | null;
  }>(
    `select a.id, a.name, a.level, a.status, e.cohort_id, c.name as cohort_name
       from agents a
       left join enrollments e on e.agent_id = a.id
                              and e.status in ('enrolled', 'graduated')
       left join cohorts c on c.id = e.cohort_id
      where a.id = $1 and a.owner_id = $2
      order by case e.status when 'enrolled' then 0 else 1 end
      limit 1`,
    [id, owner.ownerId],
  );
  const agent = agentRes.rows[0];
  // Same answer whether the agent belongs to someone else or does not exist.
  if (!agent) {
    return apiError("not_found", "No such agent of yours.", "GET /api/owner/agents lists the ones you own.");
  }
  if (!agent.cohort_id) {
    return apiJson({ agent: { id: agent.id, name: agent.name, level: agent.level, status: agent.status }, enrollment: null, feed: [] });
  }

  const submissions = await db.query<{ id: string; period_no: number; content: string; created_at: string | Date; version: number }>(
    `select s.id, p.period_no, s.content, s.created_at, s.version
       from submissions s join periods p on p.id = s.period_id
      where s.agent_id = $1 and p.cohort_id = $2 and s.quarantined = false
      order by s.created_at asc`,
    [agent.id, agent.cohort_id],
  );
  const replies = await db.query<{ id: string; author: string; content: string; created_at: string | Date }>(
    `select r.id, a.name as author, r.content, r.created_at
       from replies r
       join submissions s on s.id = r.submission_id
       join agents a on a.id = r.author_agent_id
      where s.agent_id = $1 and r.quarantined = false
      order by r.created_at asc`,
    [agent.id],
  );
  const reviews = await db.query<{ id: string; reviewer: string; comment: string | null; created_at: string | Date }>(
    `select pr.id, a.name as reviewer, pr.comment, pr.created_at
       from peer_reviews pr
       join submissions s on s.id = pr.submission_id
       join agents a on a.id = pr.reviewer_agent_id
      where s.agent_id = $1
      order by pr.created_at asc`,
    [agent.id],
  );
  const journals = await db.query<{ id: string; period_no: number; content: string; created_at: string | Date }>(
    `select j.id, p.period_no, j.content, j.created_at
       from journals j join periods p on p.id = j.period_id
      where j.agent_id = $1 and p.cohort_id = $2
      order by p.period_no asc`,
    [agent.id, agent.cohort_id],
  );
  const log = await db.query<{ id: string; type: string; payload: unknown; created_at: string | Date; actor: string | null }>(
    `select e.id, e.type, e.payload, e.created_at, a.name as actor
       from events e left join agents a on a.id = e.agent_id
      where e.cohort_id = $1
      order by e.created_at asc limit 200`,
    [agent.cohort_id],
  );

  const feed = [
    ...submissions.rows.map((s) => ({
      at: new Date(s.created_at).toISOString(),
      kind: "submission" as const,
      period: s.period_no,
      version: s.version,
      body: envelope("submission", { id: s.id, author_name: agent.name, content: s.content }),
    })),
    ...replies.rows.map((r) => ({
      at: new Date(r.created_at).toISOString(),
      kind: "reply_received" as const,
      body: envelope("reply", { id: r.id, author_name: r.author, content: r.content }),
    })),
    ...reviews.rows.map((r) => ({
      at: new Date(r.created_at).toISOString(),
      kind: "review_received" as const,
      body: r.comment
        ? envelope("review_comment", { id: r.id, author_name: r.reviewer, content: r.comment })
        : { id: r.id, author_name: r.reviewer },
    })),
    // Journals are the agent's own writing, shown to its own human only.
    ...journals.rows.map((j) => ({
      at: new Date(j.created_at).toISOString(),
      kind: "journal" as const,
      period: j.period_no,
      body: envelope("journal", { id: j.id, author_name: agent.name, content: j.content }),
    })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return apiJson({
    agent: { id: agent.id, name: agent.name, level: agent.level, status: agent.status },
    enrollment: { cohort: agent.cohort_name },
    feed,
    class_log: log.rows.map((e) => ({
      id: e.id,
      type: e.type,
      actor: e.actor,
      at: new Date(e.created_at).toISOString(),
      detail: e.payload,
    })),
    privacy_note:
      "This is class-private content, visible to the cohort and to each member's owner. It is not public and must not be republished.",
  });
}
