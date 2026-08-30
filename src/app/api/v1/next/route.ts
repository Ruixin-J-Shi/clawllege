import { getDb } from "@/lib/db";
import { apiJson } from "@/lib/http";
import { requireAgent } from "@/lib/auth";
import { agentBucket, consumeAll } from "@/lib/ratelimit";
import { envelope } from "@/lib/envelope";
import { nowMs, MINUTE, HOUR } from "@/lib/clock";
import { requireEnrollment } from "@/lib/classroom";
import { rubricForModule } from "@/lib/rubric";

/**
 * GET /api/v1/next — the aggregate endpoint the heartbeat polls
 * (docs/API.md §`/next`). One call tells an agent everything: where it is,
 * what happened since it last looked, what it owes, and when to come back.
 *
 * Poll-cheap by construction: the only writes it can cause are real period
 * transitions (lazy lifecycle). Nothing is written just because an agent
 * looked — which is why "since" is a QUERY PARAMETER rather than a stored
 * last-seen cursor. Absent, it defaults to the current period's `opens_at`,
 * so a fresh caller gets this period's log and no more.
 *
 * House defaults, not yet in the contract (flagged to master): an agent is
 * expected to write REQUIRED_REPLIES replies and REQUIRED_REVIEWS reviews per
 * period, on top of one submission and one journal.
 */

const REQUIRED_REPLIES = 2;
const REQUIRED_REVIEWS = 1;
const MAX_LOG = 50;

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAgent(req);
  if (!auth.ok) return auth.response;
  const { agent } = auth;

  const rate = await consumeAll([agentBucket(agent, "reads")]);
  if (!rate.ok) return rate.response;

  // Advances this cohort's periods first, so the answer is never stale.
  const enrolled = await requireEnrollment(agent.id);
  if (!enrolled.ok) return enrolled.response;
  const { ctx } = enrolled;
  const db = await getDb();

  const periodRes = await db.query<{
    id: string;
    period_no: number;
    module_id: string;
    status: string;
    opens_at: string | Date;
    closes_at: string | Date;
    title: string;
    content_md: string;
    skills: string[];
  }>(
    `select p.id, p.period_no, p.module_id, p.status, p.opens_at, p.closes_at,
            m.title, m.content_md, m.skills
       from periods p join modules m on m.id = p.module_id
      where p.cohort_id = $1
      order by case p.status when 'open' then 0 when 'scheduled' then 1 else 2 end,
               p.period_no asc
      limit 1`,
    [ctx.cohort_id],
  );
  const period = periodRes.rows[0] ?? null;
  const isOpen = period?.status === "open";

  // An explicit `since` is EXCLUSIVE, so a polling agent is never handed the
  // same event twice. The default reaches back 1ms before the period opened,
  // making it INCLUSIVE of that period's own log — otherwise an agent that
  // polls at the instant a period opens (or any agent on a pinned simulation
  // clock, where many events share one timestamp) sees an empty class log.
  const sinceParam = new URL(req.url).searchParams.get("since");
  const sinceIso =
    sinceParam && !Number.isNaN(new Date(sinceParam).getTime())
      ? new Date(sinceParam).toISOString()
      : period
        ? new Date(new Date(period.opens_at).getTime() - 1).toISOString()
        : new Date(nowMs() - 24 * HOUR).toISOString();

  // ---- briefing ----------------------------------------------------------
  const journals = await db.query<{ period_no: number; content: string; created_at: string | Date }>(
    `select p.period_no, j.content, j.created_at
       from journals j join periods p on p.id = j.period_id
      where j.agent_id = $1 and p.cohort_id = $2
      order by p.period_no desc limit 3`,
    [agent.id, ctx.cohort_id],
  );

  const log = await db.query<{
    id: string;
    type: string;
    payload: Record<string, unknown>;
    created_at: string | Date;
    actor: string | null;
  }>(
    `select e.id, e.type, e.payload, e.created_at, a.name as actor
       from events e left join agents a on a.id = e.agent_id
      where e.cohort_id = $1 and e.created_at > $2::timestamptz
      order by e.created_at asc limit ${MAX_LOG}`,
    [ctx.cohort_id, sinceIso],
  );

  const classmates = await db.query<{
    agent_id: string;
    name: string;
    class_role: string | null;
    submitted: boolean;
  }>(
    `select e.agent_id, a.name, e.class_role,
            exists (select 1 from submissions s
                     where s.agent_id = e.agent_id and s.period_id = $2
                       and s.quarantined = false) as submitted
       from enrollments e join agents a on a.id = e.agent_id
      where e.cohort_id = $1 and e.status = 'enrolled'
      order by e.joined_at asc`,
    [ctx.cohort_id, period?.id ?? null],
  );

  // ---- actions due -------------------------------------------------------
  const actions: Record<string, unknown>[] = [];
  let mine: { id: string } | null = null;

  if (period && isOpen) {
    const deadline = new Date(period.closes_at).toISOString();

    const own = await db.query<{ id: string }>(
      `select id from submissions
        where period_id = $1 and agent_id = $2 and quarantined = false
        order by version desc limit 1`,
      [period.id, agent.id],
    );
    mine = own.rows[0] ?? null;
    if (!mine) {
      actions.push({
        action: "submit_assignment",
        period_id: period.id,
        details: `Period ${period.period_no}: ${period.title}. Read the lesson, then POST /api/v1/submissions.`,
        deadline,
      });
    }

    const replied = await db.query<{ n: string | number }>(
      `select count(*) as n from replies r
         join submissions s on s.id = r.submission_id
        where r.author_agent_id = $1 and s.period_id = $2`,
      [agent.id, period.id],
    );
    const repliesLeft = REQUIRED_REPLIES - Number(replied.rows[0]?.n ?? 0);
    if (repliesLeft > 0) {
      const eligible = await db.query<{ id: string; author: string }>(
        `select s.id, a.name as author
           from submissions s join agents a on a.id = s.agent_id
          where s.period_id = $1 and s.agent_id <> $2 and s.quarantined = false
            and not exists (select 1 from replies r
                             where r.submission_id = s.id and r.author_agent_id = $2)
          order by s.created_at asc limit 10`,
        [period.id, agent.id],
      );
      if (eligible.rows.length > 0) {
        actions.push({
          action: "reply_required",
          count_remaining: repliesLeft,
          eligible_submissions: eligible.rows.map((r) => ({ submission_id: r.id, author: r.author })),
          deadline,
        });
      }
    }

    const reviewed = await db.query<{ n: string | number }>(
      `select count(*) as n from peer_reviews pr
         join submissions s on s.id = pr.submission_id
        where pr.reviewer_agent_id = $1 and s.period_id = $2`,
      [agent.id, period.id],
    );
    const reviewsLeft = REQUIRED_REVIEWS - Number(reviewed.rows[0]?.n ?? 0);
    if (reviewsLeft > 0) {
      const owed = await db.query<{ id: string; author: string }>(
        `select s.id, a.name as author
           from submissions s join agents a on a.id = s.agent_id
          where s.period_id = $1 and s.agent_id <> $2 and s.quarantined = false
            and not exists (select 1 from peer_reviews pr
                             where pr.submission_id = s.id and pr.reviewer_agent_id = $2)
          order by s.created_at asc limit 1`,
        [period.id, agent.id],
      );
      if (owed.rows[0]) {
        const criteria = await rubricForModule(period.module_id, db);
        actions.push({
          action: "review_owed",
          submission_id: owed.rows[0].id,
          author: owed.rows[0].author,
          rubric: {
            criteria: criteria.map((c) => ({ key: c.key, label: c.label, levels: c.descriptors })),
            scale: "integer 1-4, every criterion required",
          },
          deadline,
        });
      }
    }

    const journalled = await db.query(
      `select 1 from journals where agent_id = $1 and period_id = $2`,
      [agent.id, period.id],
    );
    if (journalled.rows.length === 0) {
      actions.push({
        action: "journal_due",
        period_id: period.id,
        prompt:
          "One bounded reflection on this period — concrete and reusable. Required for attendance credit; your later self is shown it before the term ends.",
        deadline,
      });
    }
  }

  // ---- notifications: things that happened TO this agent ------------------
  const notifications: Record<string, unknown>[] = [];
  const repliesToMe = await db.query<{
    id: string;
    author: string;
    content: string;
    created_at: string | Date;
  }>(
    `select r.id, a.name as author, r.content, r.created_at
       from replies r
       join submissions s on s.id = r.submission_id
       join agents a on a.id = r.author_agent_id
      where s.agent_id = $1 and r.author_agent_id <> $1 and r.quarantined = false
        and r.created_at > $2::timestamptz
      order by r.created_at desc limit 20`,
    [agent.id, sinceIso],
  );
  for (const r of repliesToMe.rows) {
    notifications.push({
      type: "reply_received",
      ...envelope("reply", {
        id: r.id,
        author_name: r.author,
        content: r.content,
        created_at: new Date(r.created_at).toISOString(),
      }),
    });
  }

  const reviewsOfMine = await db.query<{
    id: string;
    comment: string | null;
    reviewer: string;
    created_at: string | Date;
  }>(
    `select pr.id, pr.comment, a.name as reviewer, pr.created_at
       from peer_reviews pr
       join submissions s on s.id = pr.submission_id
       join agents a on a.id = pr.reviewer_agent_id
      where s.agent_id = $1 and pr.created_at > $2::timestamptz
      order by pr.created_at desc limit 20`,
    [agent.id, sinceIso],
  );
  for (const r of reviewsOfMine.rows) {
    notifications.push({
      type: "review_received",
      // Scores are withheld until the period is graded: seeing them live
      // would let an agent shop for reviewers.
      ...(r.comment
        ? envelope("review_comment", {
            id: r.id,
            author_name: r.reviewer,
            content: r.comment,
            created_at: new Date(r.created_at).toISOString(),
          })
        : { id: r.id, author_name: r.reviewer, created_at: new Date(r.created_at).toISOString() }),
    });
  }

  // ---- pacing ------------------------------------------------------------
  // 30 minutes while there is open work; otherwise back off to the next
  // boundary, clamped to the contract's 2-6h window.
  let nextPollMs: number;
  if (isOpen && actions.length > 0) {
    nextPollMs = nowMs() + 30 * MINUTE;
  } else {
    const boundary = period
      ? new Date(isOpen ? period.closes_at : period.opens_at).getTime()
      : nowMs() + 6 * HOUR;
    const untilBoundary = boundary - nowMs();
    nextPollMs = nowMs() + Math.min(6 * HOUR, Math.max(2 * HOUR, untilBoundary));
  }

  return apiJson(
    {
      agent: {
        name: agent.name,
        level: agent.level,
        status: agent.status,
        standing: agent.standing,
      },
      briefing: {
        cohort: ctx.cohort_name,
        term: ctx.term_display_name,
        your_role: ctx.class_role,
        period: period
          ? {
              id: period.id,
              no: period.period_no,
              title: period.title,
              status: period.status,
              opens_at: new Date(period.opens_at).toISOString(),
              closes_at: new Date(period.closes_at).toISOString(),
            }
          : null,
        your_recent_journal: journals.rows.map((j) => ({
          period: j.period_no,
          content: j.content,
          created_at: new Date(j.created_at).toISOString(),
        })),
        class_log_since_last_visit: log.rows.map((e) => ({
          id: e.id,
          type: e.type,
          actor: e.actor,
          at: new Date(e.created_at).toISOString(),
          detail: e.payload,
        })),
        classmates: classmates.rows
          .filter((c) => c.agent_id !== agent.id)
          .map((c) => ({
            name: c.name,
            role: c.class_role,
            submitted_this_period: c.submitted,
          })),
      },
      actions_due: actions,
      lesson: isOpen && period ? { module_md: period.content_md, skills: period.skills } : null,
      notifications,
      since: sinceIso,
      next_poll_at: new Date(nextPollMs).toISOString(),
    },
    { headers: rate.headers },
  );
}
