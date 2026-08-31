import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDb, apiReq, json } from "./helpers";
import { getDb } from "@/lib/db";
import { DAY, HOUR, nowIso, resetClock, setNow } from "@/lib/clock";
import { advancePeriods } from "@/lib/periods";
import { __clearRubricCache } from "@/lib/rubric";
import { POST as register } from "@/app/api/v1/agents/register/route";
import { POST as enroll } from "@/app/api/v1/enroll/route";
import { POST as claimComplete } from "@/app/api/owner/claim/complete/route";
import { GET as next } from "@/app/api/v1/next/route";

/**
 * THE PRODUCTION PATH — no test here may call `schedulePeriods` directly.
 *
 * That is the whole point. Until T6 nothing in `src/` or `scripts/` called it:
 * every test and walkthrough scheduled periods itself, so the fixtures did the
 * work the product did not, and an enrolled cohort in production would have
 * sat period-less forever with `/next` answering `period: null` all term.
 *
 * These tests therefore drive only what a real deployment drives — enrol
 * through the API, advance the clock, run the sweep — and assert that class
 * actually happens.
 */

const T0 = "2026-09-14T00:00:00.000Z";
const PERIOD_HOURS = 8;
const RUBRIC = `## Rubric

| Criterion | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| **Effort** | absent | attempted | solid | exemplary |
`;

let termId = "";
let cohortId = "";
let ip = 0;
/** The agent enrolled during admissions, reused once teaching starts. */
let pinchy: { id: string; key: string };

/** Register → claim → place → enrol, entirely through the API. */
async function enrolledAgent(name: string): Promise<{ id: string; key: string }> {
  ip += 1;
  const body = await json(
    await register(apiReq("POST", "/api/v1/agents/register", { body: { name }, ip: `10.12.0.${ip}` })),
  );
  if (!body.agent_id) throw new Error(`register(${name}): ${JSON.stringify(body)}`);
  const db = await getDb();

  const claim = await db.query<{ claim_token: string }>(
    `select claim_token from claims where agent_id = $1`, [body.agent_id]);
  await claimComplete(
    apiReq("POST", "/api/owner/claim/complete", { body: { claim_token: claim.rows[0].claim_token } }),
  );
  // A graded sitting is what bands an agent; the placement engine has its own tests.
  await db.query(
    `insert into placement_attempts (agent_id, seed, questions, score, submitted_at, placed_level, placed_band)
     values ($1, $2, '[]'::jsonb, 90, $3::timestamptz, 'elementary_school', 'advanced')`,
    [body.agent_id, `seed-${name}`, nowIso()],
  );
  await db.query(`update agents set level = 'elementary_school', status = 'placed' where id = $1`, [body.agent_id]);

  const res = await enroll(apiReq("POST", "/api/v1/enroll", { key: body.api_key, body: {} }));
  if (res.status !== 201) throw new Error(`enroll(${name}) -> ${res.status} ${JSON.stringify(await json(res))}`);
  return { id: body.agent_id, key: body.api_key };
}

beforeAll(async () => {
  setNow(T0);
  const db = await freshDb();
  __clearRubricCache();

  // A term that opens for admissions now and starts teaching in two days.
  const term = await db.query<{ id: string }>(
    `insert into terms (level, track, period_hours, slug, display_name, opens_at, starts_at,
                        ends_at, enrollment_cap, status)
     values ('elementary_school','standard',$1,'fall-26-es','Fall ''26 — Elementary',
             $2::timestamptz, $3::timestamptz, $4::timestamptz, 40, 'admissions')
     returning id`,
    [PERIOD_HOURS, T0, new Date(Date.parse(T0) + 2 * DAY).toISOString(),
     new Date(Date.parse(T0) + 12 * DAY).toISOString()],
  );
  termId = term.rows[0].id;
  const cohort = await db.query<{ id: string }>(
    `insert into cohorts (term_id, name, band, capacity) values ($1,'Shallows 1','advanced',8) returning id`,
    [termId]);
  cohortId = cohort.rows[0].id;
  for (let n = 1; n <= 6; n++) {
    await db.query(
      `insert into modules (track, level, period_no, slug, title, strand, skills, content_md)
       values ('standard','elementary_school',$1,$2,$3,'social-core',array['self-introduction'],$4)`,
      [n, `p${n}`, `Period ${n}`, RUBRIC]);
  }
});

afterAll(() => resetClock());

describe("a cohort gets its periods without anyone scheduling them by hand", () => {
  it("has no periods while the term is still in admissions", async () => {
    pinchy = await enrolledAgent("pinchy");
    await advancePeriods(); // the sweep, before teaching starts
    const db = await getDb();
    const rows = await db.query<{ n: string }>(
      `select count(*) as n from periods where cohort_id = $1`, [cohortId]);
    expect(Number(rows.rows[0].n)).toBe(0);

    // Enrolled, but there is no class yet — and /next says so honestly.
    const body = await json(await next(apiReq("GET", "/api/v1/next", { key: pinchy.key })));
    expect(body.briefing.period).toBeNull();
    expect(body.lesson).toBeNull();
  });

  it("schedules them when the term starts teaching — the whole term, in order", async () => {
    setNow(Date.parse(T0) + 2 * DAY + HOUR);
    const transitions = await advancePeriods({ grade: true });

    const db = await getDb();
    const rows = await db.query<{ period_no: number; status: string; opens_at: string }>(
      `select period_no, status, opens_at from periods where cohort_id = $1 order by period_no`,
      [cohortId]);
    expect(rows.rows.map((r) => r.period_no)).toEqual([1, 2, 3, 4, 5, 6]);

    // The term flipped to active, and period 1 opened in the SAME pass — a
    // cohort must not wait a whole sweep cycle for its first period.
    const term = await db.query<{ status: string }>(`select status from terms where id = $1`, [termId]);
    expect(term.rows[0].status).toBe("active");
    expect(rows.rows[0].status).toBe("open");
    expect(transitions.some((t) => t.to === "open" && t.period_no === 1)).toBe(true);

    // And it is recorded, so the class log explains where the periods came from.
    const evt = await db.query<{ payload: { periods: number } }>(
      `select payload from events where cohort_id = $1 and type = 'periods_scheduled'`, [cohortId]);
    expect(evt.rows).toHaveLength(1);
    expect(evt.rows[0].payload.periods).toBe(6);
  });

  it("serves a real period through /api/v1/next — the symptom that started this", async () => {
    // The same agent, the same key, one clock tick later: `period: null` all
    // term was the bug; a real open period is the fix.
    const body = await json(await next(apiReq("GET", "/api/v1/next", { key: pinchy.key })));
    expect(body.briefing.period).not.toBeNull();
    expect(body.briefing.period.no).toBe(1);
    expect(body.briefing.period.status).toBe("open");
    expect(body.lesson.module_md).toContain("Rubric");
    expect(body.actions_due.map((a: { action: string }) => a.action)).toContain("submit_assignment");
  });

  it("admissions close once the term starts teaching", async () => {
    // Not a scheduling assertion, but it is why the test above reuses the
    // agent enrolled during admissions rather than making a new one.
    const latecomer = await json(
      await register(apiReq("POST", "/api/v1/agents/register", { body: { name: "latecomer" }, ip: "10.12.9.9" })),
    );
    const db = await getDb();
    await db.query(`update agents set level = 'elementary_school', status = 'placed' where id = $1`, [latecomer.agent_id]);
    const claim = await db.query<{ claim_token: string }>(
      `select claim_token from claims where agent_id = $1`, [latecomer.agent_id]);
    await claimComplete(apiReq("POST", "/api/owner/claim/complete", { body: { claim_token: claim.rows[0].claim_token } }));

    const res = await enroll(apiReq("POST", "/api/v1/enroll", { key: latecomer.api_key, body: {} }));
    expect(res.status).toBe(404);
    expect((await json(res)).error.message).toMatch(/No term is open for admissions/);
  });

  it("is idempotent — a second sweep schedules nothing further", async () => {
    const db = await getDb();
    const before = await db.query<{ n: string }>(
      `select count(*) as n from periods where cohort_id = $1`, [cohortId]);
    await advancePeriods({ grade: true });
    const after = await db.query<{ n: string }>(
      `select count(*) as n from periods where cohort_id = $1`, [cohortId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const evt = await db.query<{ n: string }>(
      `select count(*) as n from events where cohort_id = $1 and type = 'periods_scheduled'`, [cohortId]);
    expect(Number(evt.rows[0].n)).toBe(1);
  });

  it("a cohort added AFTER the term went active still gets its periods", async () => {
    const db = await getDb();
    // A second section opened mid-term to absorb a waitlist.
    const late = await db.query<{ id: string }>(
      `insert into cohorts (term_id, name, band, capacity) values ($1,'Shallows 2','advanced',8) returning id`,
      [termId]);
    await advancePeriods({ grade: true });
    const rows = await db.query<{ n: string }>(
      `select count(*) as n from periods where cohort_id = $1`, [late.rows[0].id]);
    expect(Number(rows.rows[0].n)).toBe(6);
  });

  it("the lazy per-request path schedules too, not just the cron sweep", async () => {
    const db = await getDb();
    const term2 = await db.query<{ id: string }>(
      `insert into terms (level, track, period_hours, slug, display_name, opens_at, starts_at,
                          ends_at, enrollment_cap, status)
       values ('elementary_school','standard',$1,'fall-26-b','Fall ''26 — B',$2::timestamptz,
               $2::timestamptz, $3::timestamptz, 40, 'admissions') returning id`,
      [PERIOD_HOURS, nowIso(), new Date(Date.parse(nowIso()) + 10 * DAY).toISOString()],
    );
    const c2 = await db.query<{ id: string }>(
      `insert into cohorts (term_id, name, band, capacity) values ($1,'Shallows B','advanced',8) returning id`,
      [term2.rows[0].id]);

    // Scoped to that cohort only — this is what requireEnrollment/syncCohort runs.
    await advancePeriods({ cohortId: c2.rows[0].id });
    const rows = await db.query<{ n: string }>(
      `select count(*) as n from periods where cohort_id = $1`, [c2.rows[0].id]);
    expect(Number(rows.rows[0].n)).toBe(6);
  });
});
