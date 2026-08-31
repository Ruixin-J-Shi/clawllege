import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDb, apiReq, json } from "./helpers";
import { getDb } from "@/lib/db";
import { DAY, HOUR, nowIso, resetClock, setNow } from "@/lib/clock";
import { advancePeriods, schedulePeriods } from "@/lib/periods";
import { __clearRubricCache } from "@/lib/rubric";
import { generateSigningKey } from "@/lib/credentials";
import { POST as register } from "@/app/api/v1/agents/register/route";
import { GET as exam } from "@/app/api/v1/exam/route";
import { POST as examSubmit } from "@/app/api/v1/exam/submit/route";
import { POST as examGrade } from "@/app/api/v1/exam/grade/route";
import { MIN_PANEL, assemblePanel } from "@/lib/exams/panel";

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
    expect(body.panel.note).toMatch(/3 are required before any verdict/);
    expect(body.panel.note).toMatch(/Grading waits/);
    expect(body.panel.note).toMatch(/nothing is lost/);

    // The class log records it too, so a sweep or dashboard can see it.
    const db = await getDb();
    const evt = await db.query<{ payload: { panel_blocked: boolean; excluded: Record<string, number> } }>(
      `select payload from events where type = 'exam_started' and agent_id = $1`, [A.one.id]);
    expect(evt.rows[0].payload.panel_blocked).toBe(true);
    expect(evt.rows[0].payload.excluded.reviewers_of_record).toBeGreaterThan(0);
  });

  it("keeps seating until the floor of 3 is met — partial panels too (T7)", async () => {
    const db = await getDb();
    const other = await db.query<{ id: string }>(
      `insert into cohorts (term_id,name,band,capacity) values ($1,'Shallows 2','advanced',8) returning id`,
      [termId]);
    A.o1 = await student("outsider-one", other.rows[0].id);
    A.o2 = await student("outsider-two", other.rows[0].id);

    // Two eligible graders exist: seated, but still SHORT of the floor. Two is
    // not a panel — a median over two scores is just their midpoint, which one
    // dissenter can move as far as they like.
    const body = await json(await exam(apiReq("GET", "/api/v1/exam", { key: A.one.key })));
    expect(body.panel.seated).toBe(2);
    expect(body.panel.blocked).toBe(true);
    expect(body.panel.note).toMatch(/Only 2 eligible grader/);

    // A third appears — the next poll seats them and the panel becomes viable.
    A.o3 = await student("outsider-three", other.rows[0].id);
    const third = await json(await exam(apiReq("GET", "/api/v1/exam", { key: A.one.key })));
    expect(third.panel.seated).toBe(3);
    expect(third.panel.blocked).toBe(false); // the panel itself is now at strength
    // …but it still cannot finalize, because nobody has filed yet — and the
    // note now says which of the two things it is waiting on.
    expect(third.panel.can_finalize).toBe(false);
    expect(third.panel.note).toMatch(/0 of 3 required scores are in/);
    expect(third.panel.note).not.toMatch(/could be seated/);

    // …and it stops there: filled to the spec'"'"'s panel size, not indefinitely.
    A.o4 = await student("outsider-four", other.rows[0].id);
    const settled = await json(await exam(apiReq("GET", "/api/v1/exam", { key: A.one.key })));
    expect(settled.panel.seated).toBe(3);
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

describe("the floor actually blocks a verdict (T7)", () => {
  it("a 2-of-3 panel files everything and STILL does not finalize", async () => {
    const db = await getDb();
    // Seat exactly two graders by making only two eligible, then submit.
    const attempt = await db.query<{ id: string; params: { data: { roster_expected: string[]; q2: { classmate_name: string }; q4: { expected: Record<string, string> } } } }>(
      `select id, params from exam_attempts where agent_id = $1`, [A.one.id]);
    const V = attempt.rows[0].params.data;

    await examSubmit(
      apiReq("POST", "/api/v1/exam/submit", {
        key: A.one.key,
        body: { answers: { q1: V.roster_expected.join("\n"), q2: "…", q3: "…", q4: V.q4.expected } },
      }),
    );

    const seated = await db.query<{ grader: string }>(
      `select distinct payload->>'grader_agent_id' as grader from events
        where type = 'exam_panel_assigned' and payload->>'attempt_id' = $1`,
      [attempt.rows[0].id]);
    expect(seated.rows.length).toBe(MIN_PANEL);

    // Drop one seat so only 2 can ever file — the shape worker-3 reproduced.
    await db.query(
      `delete from events where type = 'exam_panel_assigned'
        and payload->>'attempt_id' = $1 and payload->>'grader_agent_id' = $2`,
      [attempt.rows[0].id, seated.rows[2].grader]);

    const keys = await db.query<{ id: string; name: string }>(
      `select id, name from agents where id = any($1::uuid[])`,
      [[seated.rows[0].grader, seated.rows[1].grader]]);
    const keyFor = (id: string) =>
      Object.values(A).find((a) => a.id === id)?.key ?? "";

    let lastBody: Record<string, unknown> = {};
    for (const g of keys.rows) {
      const res = await examGrade(
        apiReq("POST", "/api/v1/exam/grade", {
          key: keyFor(g.id),
          body: { attempt_id: attempt.rows[0].id, scores: { q2: { _: 3 }, q3: { _: 3 } } },
        }),
      );
      expect(res.status).toBe(201);
      lastBody = await json(res);
    }

    // Every seated grader has filed — and it still refuses to decide.
    expect(lastBody.finalised).toBeUndefined();
    expect(lastBody.panel_filed).toBe(2);
    expect(lastBody.panel_minimum).toBe(MIN_PANEL);
    expect(String(lastBody.note)).toMatch(/No verdict is computed below 3/);

    const row = await db.query<{ graded_at: string | null; passed: boolean | null }>(
      `select graded_at, passed from exam_attempts where id = $1`, [attempt.rows[0].id]);
    expect(row.rows[0].graded_at).toBeNull();
    expect(row.rows[0].passed).toBeNull();
    const creds = await db.query(`select 1 from credentials where agent_id = $1`, [A.one.id]);
    expect(creds.rows).toHaveLength(0); // no diploma decided by two agents
  });
});

describe("a GRADUATED classmate is still a classmate (worker-3's finding)", () => {
  it("never seats a graduate onto its own cohort's panel", async () => {
    const db = await getDb();
    // A classmate who is NOT a reviewer-of-record, so the own-cohort rule is
    // the only thing that can exclude them — otherwise the earlier
    // reviewer check fires first and the test proves nothing.
    const late = await student("late-joiner", cohortId);
    // …who then graduates, exactly as happens mid-term when verdicts land one
    // at a time and a cohort finishes moments apart.
    await db.query(
      `update enrollments set status = 'graduated' where agent_id = $1`, [late.id]);
    await db.query(
      `insert into credentials (public_id, agent_id, level, track, term_id, payload, signature)
       values ($1, $2, 'elementary_school', 'standard', $3, '{}'::jsonb, 'sig')`,
      [`CLLG-F26-ES-${Math.floor(Math.random() * 9000 + 1000)}`, late.id, termId],
    );

    const result = await assemblePanel({
      examineeId: A.one.id,
      examineeLevel: "elementary_school",
      examineeCohortId: cohortId,
      examId: "x",
      size: 3,
      allowOwnCohort: false,
    });

    const seated = result.panel.map((p) => p.agent_id);
    // The bug: a graduate's LEFT JOIN yielded cohort_id = NULL, so the
    // own-cohort check compared NULL and never fired — and graduates are
    // tier 1, so they were seated FIRST. Elementary forbids this absolutely.
    expect(seated).not.toContain(late.id);
    expect(seated).not.toContain(A.two.id);
    expect(seated).not.toContain(A.three.id); // still enrolled, same cohort
    // Excluded BY THE OWN-COHORT RULE, not incidentally by another check.
    expect(result.excluded.own_cohort).toBeGreaterThan(0);

    // …and the exclusion is about membership, not about being un-graduated:
    // a graduate from ANOTHER cohort is still a perfectly good grader.
    const outsider = await assemblePanel({
      examineeId: A.one.id,
      examineeLevel: "elementary_school",
      examineeCohortId: cohortId,
      examId: "x",
      size: 3,
      allowOwnCohort: false,
    });
    expect(outsider.panel.every((p) => p.agent_id !== late.id)).toBe(true);
  });

  it("a graduate is not double-counted when they hold two enrollments", async () => {
    const db = await getDb();
    // A graduate who re-enrolled elsewhere has TWO enrollment rows; a
    // `status in (...)` join would emit them twice as a candidate.
    const other = await db.query<{ id: string }>(
      `select id from cohorts where term_id = $1 and name = 'Shallows 2'`, [termId]);
    if (other.rows[0]) {
      await db.query(
        `insert into enrollments (agent_id, cohort_id) values ($1, $2)
         on conflict do nothing`, [A.two.id, other.rows[0].id]);
    }
    const result = await assemblePanel({
      examineeId: A.one.id,
      examineeLevel: "elementary_school",
      examineeCohortId: cohortId,
      examId: "x",
      size: 5,
      allowOwnCohort: false,
    });
    const ids = result.panel.map((p) => p.agent_id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate candidates
    expect(ids).not.toContain(A.two.id); // and still excluded: same cohort
  });
});
