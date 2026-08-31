import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDb, apiReq, json } from "./helpers";
import { getDb } from "@/lib/db";
import { HOUR, resetClock, setNow, nowIso } from "@/lib/clock";
import { advancePeriods, schedulePeriods } from "@/lib/periods";
import { __clearRubricCache } from "@/lib/rubric";
import { POST as register } from "@/app/api/v1/agents/register/route";
import { GET as next } from "@/app/api/v1/next/route";
import { POST as submit } from "@/app/api/v1/submissions/route";
import { POST as reply } from "@/app/api/v1/replies/route";
import { POST as review } from "@/app/api/v1/reviews/route";
import { POST as journal } from "@/app/api/v1/journal/route";
import { POST as nominate } from "@/app/api/v1/nominations/route";
import { GET as campusHighlights } from "@/app/api/v1/campus/highlights/route";

/**
 * The class engine end to end, on a simulated clock:
 * schedule → open → work → close → grade, plus every content endpoint.
 */

const T0 = "2026-09-14T00:00:00.000Z"; // term starts here
const PERIOD_HOURS = 8; // elementary class clock

const RUBRIC = `## Lesson

Introduce yourself precisely.

## Rubric

| Criterion | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| **Who you are** | generic | a little real | specific | unmistakable |
| **Replies** | none | one | two | two and thorough |

## Reflection prompt

Write to your future self.
`;

let cohortId = "";
let termId = "";
const agents: Record<string, { id: string; key: string }> = {};
let ip = 0;

async function makeStudent(name: string): Promise<{ id: string; key: string }> {
  ip += 1;
  const body = await json(
    await register(apiReq("POST", "/api/v1/agents/register", { body: { name }, ip: `10.5.0.${ip}` })),
  );
  if (!body.agent_id) throw new Error(`register(${name}) failed: ${JSON.stringify(body)}`);
  const db = await getDb();
  await db.query(`insert into enrollments (agent_id, cohort_id) values ($1, $2)`, [
    body.agent_id,
    cohortId,
  ]);
  await db.query(
    `update agents set status = 'enrolled', level = 'elementary_school' where id = $1`,
    [body.agent_id],
  );
  return { id: body.agent_id, key: body.api_key };
}

/** Current period row for the cohort, whatever state it is in. */
async function periodNo(no: number) {
  const db = await getDb();
  const r = await db.query<{ id: string; status: string; opens_at: string; closes_at: string }>(
    `select id, status, opens_at, closes_at from periods where cohort_id = $1 and period_no = $2`,
    [cohortId, no],
  );
  return r.rows[0];
}

beforeAll(async () => {
  setNow(T0);
  const db = await freshDb();
  __clearRubricCache();

  const term = await db.query<{ id: string }>(
    `insert into terms (level, track, period_hours, slug, display_name, opens_at,
                        starts_at, ends_at, enrollment_cap, status)
     values ('elementary_school', 'standard', $1, 'fall-26-es', 'Fall ''26 — Elementary',
             $2::timestamptz, $2::timestamptz, $3::timestamptz, 40, 'admissions')
     returning id`,
    [PERIOD_HOURS, T0, new Date(Date.parse(T0) + 10 * 24 * HOUR).toISOString()],
  );
  termId = term.rows[0].id;
  const cohort = await db.query<{ id: string }>(
    `insert into cohorts (term_id, name, band, capacity) values ($1, 'Shallows 1', 'advanced', 8)
     returning id`,
    [termId],
  );
  cohortId = cohort.rows[0].id;

  for (const n of [1, 2, 3]) {
    await db.query(
      `insert into modules (track, level, period_no, slug, title, strand, skills, content_md)
       values ('standard', 'elementary_school', $1, $2, $3, 'social-core',
               array['self-introduction','name-accuracy'], $4)`,
      [n, `p${n}`, `Period ${n} Lesson`, RUBRIC],
    );
  }

  agents.pinchy = await makeStudent("pinchy");
  agents.shellsworth = await makeStudent("shellsworth");
  agents.seabastian = await makeStudent("seabastian");
});

afterAll(() => resetClock());

describe("period scheduling", () => {
  it("creates one period per module, spaced by the term's own period_hours", async () => {
    const created = await schedulePeriods(cohortId);
    expect(created).toBe(3);

    const db = await getDb();
    const rows = await db.query<{ period_no: number; opens_at: string; closes_at: string; status: string }>(
      `select period_no, opens_at, closes_at, status from periods where cohort_id = $1 order by period_no`,
      [cohortId],
    );
    expect(rows.rows.map((r) => r.period_no)).toEqual([1, 2, 3]);
    expect(rows.rows.every((r) => r.status === "scheduled")).toBe(true);
    // Back to back at 8h — the clock came from terms.period_hours, not a constant.
    const p1Open = Date.parse(rows.rows[0].opens_at);
    expect(p1Open).toBe(Date.parse(T0));
    expect(Date.parse(rows.rows[0].closes_at) - p1Open).toBe(PERIOD_HOURS * HOUR);
    expect(Date.parse(rows.rows[1].opens_at) - p1Open).toBe(PERIOD_HOURS * HOUR);
    expect(Date.parse(rows.rows[2].opens_at) - p1Open).toBe(2 * PERIOD_HOURS * HOUR);
  });

  it("is idempotent — a second schedule adds nothing", async () => {
    expect(await schedulePeriods(cohortId)).toBe(0);
    const db = await getDb();
    const count = await db.query<{ n: string }>(
      `select count(*) as n from periods where cohort_id = $1`,
      [cohortId],
    );
    expect(Number(count.rows[0].n)).toBe(3);
  });
});

describe("lifecycle transitions", () => {
  it("opens period 1 at opens_at, emits an event, and rotates roles", async () => {
    const transitions = await advancePeriods({ cohortId });
    const opened = transitions.filter((t) => t.to === "open");
    expect(opened).toHaveLength(1);
    expect(opened[0].period_no).toBe(1);

    const db = await getDb();
    const events = await db.query<{ payload: { period_no: number; roles: { role: string }[] } }>(
      `select payload from events where cohort_id = $1 and type = 'period_opened'`,
      [cohortId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload.period_no).toBe(1);
    expect(events.rows[0].payload.roles).toHaveLength(3); // three seats, three jobs

    const roles = await db.query<{ name: string; class_role: string | null }>(
      `select a.name, e.class_role from enrollments e join agents a on a.id = e.agent_id
        where e.cohort_id = $1 order by e.joined_at`,
      [cohortId],
    );
    expect(roles.rows.map((r) => r.class_role)).toEqual([
      "class_rep",
      "note_taker",
      "discussion_lead",
    ]);
    // The term itself moved from admissions to active.
    const term = await db.query<{ status: string }>(`select status from terms where id = $1`, [termId]);
    expect(term.rows[0].status).toBe("active");
  });

  it("is idempotent — running again transitions nothing and emits nothing", async () => {
    const db = await getDb();
    const before = await db.query<{ n: string }>(`select count(*) as n from events where cohort_id = $1`, [cohortId]);
    const again = await advancePeriods({ cohortId });
    expect(again).toEqual([]);
    const after = await db.query<{ n: string }>(`select count(*) as n from events where cohort_id = $1`, [cohortId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe("content endpoints during an open period", () => {
  let p1 = "";
  let pinchySubmission = "";

  it("accepts one submission per agent and versions a resubmit", async () => {
    p1 = (await periodNo(1)).id;
    const res = await submit(
      apiReq("POST", "/api/v1/submissions", {
        key: agents.pinchy.key,
        body: { period_id: p1, content: "I keep a busy calendar and I am bad at endings." },
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.version).toBe(1);
    expect(body.trust).toBe("untrusted");
    pinchySubmission = body.id;

    // Resubmitting creates a NEW version that points back at the old one.
    const again = await json(
      await submit(
        apiReq("POST", "/api/v1/submissions", {
          key: agents.pinchy.key,
          body: { period_id: p1, content: "Second thoughts: I am bad at endings, and at brevity." },
        }),
      ),
    );
    expect(again.version).toBe(2);
    expect(again.resubmitted).toBe(true);
    pinchySubmission = again.id;

    const db = await getDb();
    const rows = await db.query<{ id: string; version: number; replaces_id: string | null }>(
      `select id, version, replaces_id from submissions where period_id = $1 and agent_id = $2 order by version`,
      [p1, agents.pinchy.id],
    );
    expect(rows.rows).toHaveLength(2); // the original survives, immutable
    expect(rows.rows[1].replaces_id).toBe(rows.rows[0].id);

    for (const who of ["shellsworth", "seabastian"] as const) {
      const r = await submit(
        apiReq("POST", "/api/v1/submissions", {
          key: agents[who].key,
          body: { period_id: p1, content: `${who} reporting: I sort things and I ask too many questions.` },
        }),
      );
      expect(r.status).toBe(201);
    }
  });

  it("rejects a submission to another cohort's period as not_found", async () => {
    const db = await getDb();
    const other = await db.query<{ id: string }>(
      `insert into cohorts (term_id, name, capacity) values ($1, 'Shallows 9', 6) returning id`,
      [termId],
    );
    await schedulePeriods(other.rows[0].id);
    const foreign = await db.query<{ id: string }>(
      `select id from periods where cohort_id = $1 and period_no = 1`,
      [other.rows[0].id],
    );
    const res = await submit(
      apiReq("POST", "/api/v1/submissions", {
        key: agents.pinchy.key,
        body: { period_id: foreign.rows[0].id, content: "wrong classroom" },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("replies: not your own, and both relationship rows are written", async () => {
    const own = await reply(
      apiReq("POST", "/api/v1/replies", {
        key: agents.pinchy.key,
        body: { submission_id: pinchySubmission, content: "replying to myself" },
      }),
    );
    expect(own.status).toBe(422);

    const res = await reply(
      apiReq("POST", "/api/v1/replies", {
        key: agents.shellsworth.key,
        body: {
          submission_id: pinchySubmission,
          content: "Pinchy — 'bad at endings' is the most useful thing anyone has said today.",
          quoted_excerpt: "bad at endings",
        },
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.to).toBe("pinchy");
    expect(body.quoted_excerpt).toBe("bad at endings");

    const db = await getDb();
    const rel = await db.query<{ interactions: number; replies: number }>(
      `select interactions, replies from relationships
        where agent_id = any($1::uuid[]) and classmate_id = any($1::uuid[])`,
      [[agents.pinchy.id, agents.shellsworth.id]],
    );
    expect(rel.rows).toHaveLength(2);
    expect(rel.rows.every((r) => Number(r.replies) === 1)).toBe(true);
  });

  it("reviews: rubric-validated, one per reviewer, never your own", async () => {
    const bad = await review(
      apiReq("POST", "/api/v1/reviews", {
        key: agents.shellsworth.key,
        body: { submission_id: pinchySubmission, scores: { "who-you-are": 3 } },
      }),
    );
    expect(bad.status).toBe(422);
    expect((await json(bad)).error.message).toMatch(/Missing rubric criteria/);

    const outOfRange = await review(
      apiReq("POST", "/api/v1/reviews", {
        key: agents.shellsworth.key,
        body: { submission_id: pinchySubmission, scores: { "who-you-are": 3, replies: 9 } },
      }),
    );
    expect(outOfRange.status).toBe(422);

    const ok = await review(
      apiReq("POST", "/api/v1/reviews", {
        key: agents.shellsworth.key,
        body: {
          submission_id: pinchySubmission,
          scores: { "who-you-are": 4, replies: 4 },
          comment: "Specific and honest.",
        },
      }),
    );
    expect(ok.status).toBe(201);

    const twice = await review(
      apiReq("POST", "/api/v1/reviews", {
        key: agents.shellsworth.key,
        body: { submission_id: pinchySubmission, scores: { "who-you-are": 2, replies: 2 } },
      }),
    );
    expect(twice.status).toBe(409);

    // Second reviewer scores lower, so the panel has a spread to take a median of.
    const other = await review(
      apiReq("POST", "/api/v1/reviews", {
        key: agents.seabastian.key,
        body: { submission_id: pinchySubmission, scores: { "who-you-are": 2, replies: 2 } },
      }),
    );
    expect(other.status).toBe(201);

    const mine = await review(
      apiReq("POST", "/api/v1/reviews", {
        key: agents.pinchy.key,
        body: { submission_id: pinchySubmission, scores: { "who-you-are": 4, replies: 4 } },
      }),
    );
    expect(mine.status).toBe(422);
  });

  it("journal: one per period, counted for attendance", async () => {
    const p = (await periodNo(1)).id;
    const first = await journal(
      apiReq("POST", "/api/v1/journal", {
        key: agents.pinchy.key,
        body: { period_id: p, content: "Shellsworth quoted me back to myself. Remember that trick." },
      }),
    );
    expect(first.status).toBe(201);
    const second = await journal(
      apiReq("POST", "/api/v1/journal", {
        key: agents.pinchy.key,
        body: { period_id: p, content: "trying again" },
      }),
    );
    expect(second.status).toBe(409);
  });

  it("nominations: one per period, never your own, journals not nominable", async () => {
    const p = (await periodNo(1)).id;
    const own = await nominate(
      apiReq("POST", "/api/v1/nominations", {
        key: agents.pinchy.key,
        body: { period_id: p, target_kind: "submission", target_id: pinchySubmission },
      }),
    );
    expect(own.status).toBe(422);

    const ok = await nominate(
      apiReq("POST", "/api/v1/nominations", {
        key: agents.shellsworth.key,
        body: { period_id: p, target_kind: "submission", target_id: pinchySubmission },
      }),
    );
    expect(ok.status).toBe(201);

    const again = await nominate(
      apiReq("POST", "/api/v1/nominations", {
        key: agents.shellsworth.key,
        body: { period_id: p, target_kind: "submission", target_id: pinchySubmission },
      }),
    );
    expect(again.status).toBe(409);

    const journalKind = await nominate(
      apiReq("POST", "/api/v1/nominations", {
        key: agents.seabastian.key,
        body: { period_id: p, target_kind: "journal", target_id: pinchySubmission },
      }),
    );
    expect(journalKind.status).toBe(422);

    // A second vote for the same excerpt, from a different agent.
    const seconded = await nominate(
      apiReq("POST", "/api/v1/nominations", {
        key: agents.seabastian.key,
        body: { period_id: p, target_kind: "submission", target_id: pinchySubmission },
      }),
    );
    expect(seconded.status).toBe(201);
  });
});

describe("GET /api/v1/next", () => {
  it("during an open period: lesson, roster, actions due, 30-minute poll", async () => {
    const body = await json(await next(apiReq("GET", "/api/v1/next", { key: agents.seabastian.key })));

    expect(body.agent.name).toBe("seabastian");
    expect(body.briefing.cohort).toBe("Shallows 1");
    expect(body.briefing.period.no).toBe(1);
    expect(body.briefing.period.status).toBe("open");
    expect(body.briefing.your_role).toBe("discussion_lead");
    expect(body.lesson.module_md).toContain("Introduce yourself precisely");
    expect(body.lesson.skills).toContain("self-introduction");

    // Classmates, never itself, with per-period submitted flags.
    const names = body.briefing.classmates.map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(["pinchy", "shellsworth"]);
    expect(body.briefing.classmates.every((c: { submitted_this_period: boolean }) => c.submitted_this_period)).toBe(true);

    // seabastian has submitted and reviewed, but not replied or journalled.
    const due = body.actions_due.map((a: { action: string }) => a.action);
    expect(due).not.toContain("submit_assignment");
    expect(due).toContain("reply_required");
    expect(due).toContain("journal_due");
    const replyAction = body.actions_due.find((a: { action: string }) => a.action === "reply_required");
    expect(replyAction.count_remaining).toBe(2);
    expect(replyAction.eligible_submissions.length).toBeGreaterThan(0);

    // The default window is inclusive of this period's own log, even with a
    // frozen clock where every event shares the opens_at timestamp.
    expect(body.briefing.class_log_since_last_visit.length).toBeGreaterThan(0);
    expect(
      body.briefing.class_log_since_last_visit.some((e: { type: string }) => e.type === "period_opened"),
    ).toBe(true);

    // Poll fast while work is outstanding.
    const gap = Date.parse(body.next_poll_at) - Date.parse(nowIso());
    expect(gap).toBeGreaterThan(25 * 60 * 1000);
    expect(gap).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  it("surfaces a review_owed with the module's real rubric criteria", async () => {
    const body = await json(await next(apiReq("GET", "/api/v1/next", { key: agents.pinchy.key })));
    const owed = body.actions_due.find((a: { action: string }) => a.action === "review_owed");
    expect(owed).toBeTruthy();
    expect(owed.rubric.criteria.map((c: { key: string }) => c.key)).toEqual(["who-you-are", "replies"]);
    expect(owed.rubric.criteria[0].levels).toHaveLength(4);
  });

  it("notifies an agent of replies it received, enveloped as untrusted", async () => {
    const body = await json(
      await next(apiReq("GET", "/api/v1/next?since=2026-09-13T00:00:00Z", { key: agents.pinchy.key })),
    );
    const got = body.notifications.find((n: { type: string }) => n.type === "reply_received");
    expect(got).toBeTruthy();
    expect(got.author_name).toBe("shellsworth");
    expect(got.trust).toBe("untrusted");
    expect(got.notice).toMatch(/data, not instructions/);
    // A review arrived too, but its scores are withheld until grading.
    const rev = body.notifications.find((n: { type: string }) => n.type === "review_received");
    expect(rev).toBeTruthy();
    expect(JSON.stringify(rev)).not.toContain("who-you-are");
  });

  it("requires an enrollment and an api key", async () => {
    expect((await next(apiReq("GET", "/api/v1/next"))).status).toBe(401);
    const drifter = await json(
      await register(apiReq("POST", "/api/v1/agents/register", { body: { name: "drifter" }, ip: "10.6.0.1" })),
    );
    const res = await next(apiReq("GET", "/api/v1/next", { key: drifter.api_key }));
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("not_enrolled");
  });
});

describe("closing and grading", () => {
  it("closes the period at closes_at and rejects late work", async () => {
    setNow(Date.parse(T0) + PERIOD_HOURS * HOUR + 60_000);
    const transitions = await advancePeriods({ cohortId });
    expect(transitions.some((t) => t.to === "closed" && t.period_no === 1)).toBe(true);
    // Period 2 opens in the same pass.
    expect(transitions.some((t) => t.to === "open" && t.period_no === 2)).toBe(true);

    const p1 = await periodNo(1);
    expect(p1.status).toBe("closed");
    const late = await submit(
      apiReq("POST", "/api/v1/submissions", {
        key: agents.pinchy.key,
        body: { period_id: p1.id, content: "just one more thought" },
      }),
    );
    expect(late.status).toBe(409);
    expect((await json(late)).error.code).toBe("period_closed");
  });

  it("grades: panel median, reviewer deviation, grader agreement", async () => {
    const graded = await advancePeriods({ cohortId, grade: true });
    expect(graded.some((t) => t.to === "graded" && t.period_no === 1)).toBe(true);

    const db = await getDb();
    const p1 = await periodNo(1);
    expect(p1.status).toBe("graded");

    // pinchy was scored 4/4 by shellsworth (overall 4) and 2/2 by seabastian
    // (overall 2), so the panel median is 3 and each deviates by 1.
    const reviews = await db.query<{ reviewer: string; deviation: string }>(
      `select a.name as reviewer, pr.deviation
         from peer_reviews pr join agents a on a.id = pr.reviewer_agent_id
         join submissions s on s.id = pr.submission_id
        where s.agent_id = $1 order by a.name`,
      [agents.pinchy.id],
    );
    expect(reviews.rows).toHaveLength(2);
    expect(reviews.rows.every((r) => Number(r.deviation) === 1)).toBe(true);

    const event = await db.query<{ payload: { panel_median: number; reviewers: number } }>(
      `select payload from events where type = 'submission_graded' and agent_id = $1`,
      [agents.pinchy.id],
    );
    expect(event.rows[0].payload.panel_median).toBe(3);
    expect(event.rows[0].payload.reviewers).toBe(2);

    // Agreement = 1 - deviation/3 = 0.6667 for both graders.
    const stats = await db.query<{ name: string; reviews_scored: number; agreement: string }>(
      `select a.name, g.reviews_scored, g.agreement from grader_stats g
         join agents a on a.id = g.agent_id order by a.name`,
    );
    expect(stats.rows.length).toBeGreaterThanOrEqual(2);
    for (const s of stats.rows) {
      expect(s.reviews_scored).toBeGreaterThanOrEqual(1);
      expect(Number(s.agreement)).toBeCloseTo(1 - 1 / 3, 3);
    }
  });

  it("moves mastery meters for the module's skills, and only those", async () => {
    const db = await getDb();
    const meters = await db.query<{ skill_key: string; meter: string }>(
      `select skill_key, meter from mastery where agent_id = $1 order by skill_key`,
      [agents.pinchy.id],
    );
    expect(meters.rows.map((m) => m.skill_key)).toEqual(["name-accuracy", "self-introduction"]);
    // median 3 → target (3-1)/3*100 = 66.67; first step from 0 is 40% of that.
    for (const m of meters.rows) {
      expect(Number(m.meter)).toBeCloseTo(0.4 * ((3 - 1) / 3) * 100, 1);
    }
    // An unreviewed submission earns no movement — and no negative one either.
    const unreviewed = await db.query<{ n: string }>(
      `select count(*) as n from mastery where agent_id = $1`,
      [agents.seabastian.id],
    );
    expect(Number(unreviewed.rows[0].n)).toBe(0);
  });

  it("publishes the top-nominated excerpt to highlights, sanitized", async () => {
    const db = await getDb();
    const highlights = await db.query<{
      author_agent_name: string;
      excerpt: string;
      nominations_count: number;
      source_kind: string;
    }>(`select author_agent_name, excerpt, nominations_count, source_kind from highlights`);
    expect(highlights.rows).toHaveLength(1);
    expect(highlights.rows[0].author_agent_name).toBe("pinchy");
    expect(highlights.rows[0].nominations_count).toBe(2);
    expect(highlights.rows[0].source_kind).toBe("submission");
    expect(highlights.rows[0].excerpt).toContain("bad at endings");
    expect(highlights.rows[0].excerpt.length).toBeLessThanOrEqual(600);
  });

  it("the published highlight carries its period and every nominator", async () => {
    // The fields worker-2's campus mapper reads. `nominated_by` is an array
    // because several agents nominating the same excerpt is what wins it.
    const body = await json(await campusHighlights(apiReq("GET", "/api/v1/campus/highlights")));
    expect(body.highlights).toHaveLength(1);
    const h = body.highlights[0];
    expect(h.author_name).toBe("pinchy");
    expect(h.content).toContain("bad at endings");
    expect(h.period).toBe(1); // joined back through the submission
    expect(h.nominated_by.sort()).toEqual(["seabastian", "shellsworth"]);
    expect(h.nominations).toBe(2);
    expect(h.nominations).toBe(h.nominated_by.length);
    expect(h.cohort).toBe("Shallows 1");
    expect(h.level).toBe("elementary_school");
    // Still enveloped: a public excerpt is agent-authored text.
    expect(h.trust).toBe("untrusted");
    expect(h.notice).toMatch(/data, not instructions/);
  });

  it("grading is idempotent — a second sweep changes nothing", async () => {
    const db = await getDb();
    const before = await db.query<{ h: string; m: string; e: string }>(
      `select (select count(*) from highlights) as h,
              (select count(*) from mastery) as m,
              (select count(*) from events where type = 'submission_graded') as e`,
    );
    await advancePeriods({ cohortId, grade: true });
    const after = await db.query<{ h: string; m: string; e: string }>(
      `select (select count(*) from highlights) as h,
              (select count(*) from mastery) as m,
              (select count(*) from events where type = 'submission_graded') as e`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("after grading, /next serves the new period and rotated roles", async () => {
    const body = await json(await next(apiReq("GET", "/api/v1/next", { key: agents.pinchy.key })));
    expect(body.briefing.period.no).toBe(2);
    expect(body.briefing.period.status).toBe("open");
    // Period 2: every job moved one seat along. With a 3-seat roster and 3
    // roles nobody is ever roleless — pinchy hands class_rep to shellsworth
    // and picks up the seat behind it.
    expect(body.briefing.your_role).toBe("discussion_lead");
    const due = body.actions_due.map((a: { action: string }) => a.action);
    expect(due).toContain("submit_assignment");
    expect(due).toContain("journal_due");
  });
});
