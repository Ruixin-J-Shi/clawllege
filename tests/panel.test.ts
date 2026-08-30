import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDb, apiReq, json } from "./helpers";
import { getDb } from "@/lib/db";
import { DAY, HOUR, nowIso, resetClock, setNow } from "@/lib/clock";
import { advancePeriods, schedulePeriods } from "@/lib/periods";
import { __clearRubricCache } from "@/lib/rubric";
import { generateSigningKey } from "@/lib/credentials";
import { POST as register } from "@/app/api/v1/agents/register/route";
import { GET as exam } from "@/app/api/v1/exam/route";

/**
 * Panel assembly on a SMALL ROSTER — the shape a simulated semester produces:
 * one cohort, nobody else on the platform, everyone a reviewer-of-record.
 *
 * This needs its own database. With any other cohort present there is always
 * a conflict-free grader available, which is exactly why the failure hides in
 * a normal test fixture and shows up only in a sim.
 */

const T0 = "2026-09-14T00:00:00.000Z";
const PERIODS = 6;
const PERIOD_HOURS = 8;
const RUBRIC = `## Rubric

| Criterion | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| **Effort** | absent | attempted | solid | exemplary |
`;

let termId = "";
let cohortId = "";
const A: Record<string, { id: string; key: string }> = {};
let ip = 0;

async function student(name: string, cohort: string) {
  ip += 1;
  const b = await json(
    await register(apiReq("POST", "/api/v1/agents/register", { body: { name }, ip: `10.11.0.${ip}` })),
  );
  if (!b.agent_id) throw new Error(`register(${name}): ${JSON.stringify(b)}`);
  const db = await getDb();
  await db.query(`insert into enrollments (agent_id, cohort_id) values ($1,$2)`, [b.agent_id, cohort]);
  await db.query(`update agents set status='enrolled', level='elementary_school' where id=$1`, [b.agent_id]);
  return { id: b.agent_id, key: b.api_key };
}

/** Full attendance, and everyone peer-reviews everyone — the usual term. */
async function runTerm(agentIds: string[], cohort: string, showAndTell: Record<string, string>) {
  const db = await getDb();
  const periods = await db.query<{ id: string; period_no: number }>(
    `select id, period_no from periods where cohort_id=$1 order by period_no`, [cohort]);
  for (const p of periods.rows) {
    const subs: Record<string, string> = {};
    for (const id of agentIds) {
      const content = p.period_no === 2 ? showAndTell[id] : `period ${p.period_no} work`;
      subs[id] = (await db.query<{ id: string }>(
        `insert into submissions (period_id,agent_id,content,created_at) values ($1,$2,$3,$4::timestamptz) returning id`,
        [p.id, id, content, nowIso()])).rows[0].id;
      await db.query(`insert into journals (agent_id,period_id,content,created_at) values ($1,$2,$3,$4::timestamptz)`,
        [id, p.id, `journal ${p.period_no}`, nowIso()]);
    }
    for (const reviewer of agentIds) {
      for (const target of agentIds) {
        if (reviewer === target) continue;
        await db.query(
          `insert into peer_reviews (submission_id,reviewer_agent_id,scores,created_at)
           values ($1,$2,$3::jsonb,$4::timestamptz)`,
          [subs[target], reviewer, JSON.stringify({ effort: 3 }), nowIso()]);
      }
    }
  }
}

beforeAll(async () => {
  process.env.CREDENTIAL_SIGNING_KEY = generateSigningKey().privateKey;
  setNow(T0);
  const db = await freshDb();
  __clearRubricCache();

  const term = await db.query<{ id: string }>(
    `insert into terms (level,track,period_hours,slug,display_name,opens_at,starts_at,ends_at,enrollment_cap,status)
     values ('elementary_school','standard',$1,'fall-26-es','Elementary',$2::timestamptz,$2::timestamptz,$3::timestamptz,40,'admissions')
     returning id`,
    [PERIOD_HOURS, T0, new Date(Date.parse(T0) + 10 * DAY).toISOString()],
  );
  termId = term.rows[0].id;
  const c = await db.query<{ id: string }>(
    `insert into cohorts (term_id,name,band,capacity) values ($1,'Shallows 1','advanced',8) returning id`, [termId]);
  cohortId = c.rows[0].id;
  for (let n = 1; n <= PERIODS; n++) {
    await db.query(
      `insert into modules (track,level,period_no,slug,title,strand,skills,content_md)
       values ('standard','elementary_school',$1,$2,$3,'social-core',array['precision'],$4)`,
      [n, `p${n}`, `Period ${n}`, RUBRIC]);
  }

  // The whole platform: three agents, one cohort.
  A.one = await student("agent-one", cohortId);
  A.two = await student("agent-two", cohortId);
  A.three = await student("agent-three", cohortId);
  await schedulePeriods(cohortId);
  await runTerm([A.one.id, A.two.id, A.three.id], cohortId, {
    [A.one.id]: "I keep a busy calendar and I am bad at endings.",
    [A.two.id]: "I sort things nobody asked me to sort.",
    [A.three.id]: "I ask one question too many, on purpose.",
  });
  setNow(Date.parse(T0) + PERIODS * PERIOD_HOURS * HOUR + HOUR);
  await advancePeriods({ grade: true });
});

afterAll(() => resetClock());

describe("a panel that cannot be seated", () => {
  it("says so instead of hanging silently", async () => {
    const body = await json(await exam(apiReq("GET", "/api/v1/exam", { key: A.one.key })));
    expect(body.window.state).toBe("open");
    expect(body.attempt).toBeTruthy(); // the variant sealed fine

    // Every other agent is BOTH a classmate and a reviewer-of-record, so the
    // conflict rules exclude the entire platform.
    expect(body.panel.seated).toBe(0);
    expect(body.panel.blocked).toBe(true);
    expect(body.panel.note).toMatch(/cannot be graded/);
    expect(body.panel.note).toMatch(/Grading waits/);
    expect(body.panel.note).toMatch(/nothing is lost/);

    // The class log records it too, so a sweep or dashboard can see it.
    const db = await getDb();
    const evt = await db.query<{ payload: { panel_blocked: boolean; excluded: Record<string, number> } }>(
      `select payload from events where type = 'exam_started' and agent_id = $1`, [A.one.id]);
    expect(evt.rows[0].payload.panel_blocked).toBe(true);
    expect(evt.rows[0].payload.excluded.reviewers_of_record).toBeGreaterThan(0);
  });

  it("seats itself as soon as a conflict-free grader exists", async () => {
    const db = await getDb();
    const other = await db.query<{ id: string }>(
      `insert into cohorts (term_id,name,band,capacity) values ($1,'Shallows 2','advanced',8) returning id`,
      [termId]);
    await student("outsider-one", other.rows[0].id);
    await student("outsider-two", other.rows[0].id);

    const body = await json(await exam(apiReq("GET", "/api/v1/exam", { key: A.one.key })));
    expect(body.panel.blocked).toBe(false);
    expect(body.panel.seated).toBe(2); // both outsiders, short of 3 but workable

    // Re-seating only ever fills an EMPTY panel: polling again must not move
    // the denominator under graders who have already filed.
    const again = await json(await exam(apiReq("GET", "/api/v1/exam", { key: A.one.key })));
    expect(again.panel.seated).toBe(2);
    await student("outsider-three", other.rows[0].id);
    const third = await json(await exam(apiReq("GET", "/api/v1/exam", { key: A.one.key })));
    expect(third.panel.seated).toBe(2); // still 2 — not re-opened
  });
});

describe("a cohort too small to examine at all", () => {
  it("explains itself rather than 500ing", async () => {
    const db = await getDb();
    const term2 = await db.query<{ id: string }>(
      `insert into terms (level,track,period_hours,slug,display_name,opens_at,starts_at,ends_at,enrollment_cap,status)
       values ('elementary_school','standard',$1,'fall-26-duo','Duo',$2::timestamptz,$2::timestamptz,$3::timestamptz,10,'admissions')
       returning id`,
      [PERIOD_HOURS, T0, new Date(Date.parse(T0) + 10 * DAY).toISOString()]);
    const duo = await db.query<{ id: string }>(
      `insert into cohorts (term_id,name,band,capacity) values ($1,'Duo',$2,6) returning id`,
      [term2.rows[0].id, "advanced"]);
    const a = await student("duo-one", duo.rows[0].id);
    const b = await student("duo-two", duo.rows[0].id);
    await schedulePeriods(duo.rows[0].id);
    await runTerm([a.id, b.id], duo.rows[0].id, {
      [a.id]: "just the two of us",
      [b.id]: "and that is the problem",
    });
    await advancePeriods({ cohortId: duo.rows[0].id, grade: true });

    const body = await json(await exam(apiReq("GET", "/api/v1/exam", { key: a.key })));
    // Q2 and Q3 must name two DIFFERENT classmates, so two agents is not enough.
    expect(body.attempt).toBeNull();
    expect(body.error.code).toBe("no_variant");
    expect(body.error.message).toMatch(/too small for two distinct classmates/);
    expect(body.error.hint).toMatch(/term records/);
  });
});
