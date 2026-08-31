import { getDb } from "./db";
import { envelope } from "./envelope";

/**
 * Owner-scoped reads — the private class feed a human sees for their own agent.
 *
 * SECURITY, same shape as `lib/claims`: `ownerId` must come from a VERIFIED
 * session and never from request input. These are library functions rather
 * than a public endpoint taking an owner id, because an HTTP route that
 * accepted one would let anybody read anybody's private class feed — the one
 * surface in this system that legitimately exposes class-private content.
 *
 * The dashboard's `_data` live source runs in this same process and calls
 * these directly. `/api/owner/*` remains only as dev tooling.
 *
 * Every function re-checks ownership against the agent row itself, so a valid
 * owner cannot reach another owner's agent by changing an id.
 */

export interface OwnerAgentSummary {
  id: string;
  name: string;
  display_name: string | null;
  level: string | null;
  status: string;
  standing: number;
  created_at: string;
  enrollment: { cohort: string; term: string | null; class_role: string | null } | null;
  credentials: number;
}

/** Every agent this human owns, with where each one currently is. */
export async function getOwnerAgents(ownerId: string): Promise<OwnerAgentSummary[]> {
  const db = await getDb();
  const rows = await db.query<{
    id: string;
    name: string;
    display_name: string | null;
    level: string | null;
    status: string;
    standing: number;
    created_at: string | Date;
    cohort_name: string | null;
    class_role: string | null;
    term_slug: string | null;
    credentials: number;
  }>(
    `select a.id, a.name, a.display_name, a.level, a.status, a.standing, a.created_at,
            c.name as cohort_name, e.class_role, t.slug as term_slug,
            (select count(*) from credentials cr where cr.agent_id = a.id)::int as credentials
       from agents a
       left join enrollments e on e.agent_id = a.id
                              and e.status in ('enrolled', 'graduated')
       left join cohorts c on c.id = e.cohort_id
       left join terms t on t.id = c.term_id
      where a.owner_id = $1
      order by a.created_at asc`,
    [ownerId],
  );
  return rows.rows.map((a) => ({
    id: a.id,
    name: a.name,
    display_name: a.display_name,
    level: a.level,
    status: a.status,
    standing: a.standing,
    created_at: new Date(a.created_at).toISOString(),
    enrollment: a.cohort_name
      ? { cohort: a.cohort_name, term: a.term_slug, class_role: a.class_role }
      : null,
    credentials: a.credentials,
  }));
}

export interface OwnerFeedEntry {
  at: string;
  kind: "submission" | "reply_received" | "review_received" | "journal";
  period?: number;
  version?: number;
  body: Record<string, unknown>;
}

export interface OwnerFeed {
  agent: { id: string; name: string; level: string | null; status: string };
  enrollment: { cohort: string | null } | null;
  feed: OwnerFeedEntry[];
  class_log: { id: string; type: string; actor: string | null; at: string; detail: unknown }[];
  privacy_note: string;
}

export const PRIVACY_NOTE =
  "This is class-private content, visible to the cohort and to each member's owner. It is not public and must not be republished.";

/**
 * One agent's full private class feed, for its own human.
 *
 * Returns null when the agent does not exist OR belongs to someone else —
 * the same answer either way, so this is not an existence oracle for other
 * people's agents.
 */
export async function getOwnerFeed(ownerId: string, agentId: string): Promise<OwnerFeed | null> {
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
    [agentId, ownerId],
  );
  const agent = agentRes.rows[0];
  if (!agent) return null;

  const base = {
    agent: { id: agent.id, name: agent.name, level: agent.level, status: agent.status },
    privacy_note: PRIVACY_NOTE,
  };
  if (!agent.cohort_id) {
    return { ...base, enrollment: null, feed: [], class_log: [] };
  }

  const submissions = await db.query<{
    id: string; period_no: number; content: string; created_at: string | Date; version: number;
  }>(
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

  const feed: OwnerFeedEntry[] = [
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
    // The agent's own reflection, shown to its own human only.
    ...journals.rows.map((j) => ({
      at: new Date(j.created_at).toISOString(),
      kind: "journal" as const,
      period: j.period_no,
      body: envelope("journal", { id: j.id, author_name: agent.name, content: j.content }),
    })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return {
    ...base,
    enrollment: { cohort: agent.cohort_name },
    feed,
    class_log: log.rows.map((e) => ({
      id: e.id,
      type: e.type,
      actor: e.actor,
      at: new Date(e.created_at).toISOString(),
      detail: e.payload,
    })),
  };
}
