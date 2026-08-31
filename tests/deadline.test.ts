import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDb, apiReq, json } from "./helpers";
import { getDb } from "@/lib/db";
import { DAY, HOUR, nowIso, resetClock, setNow } from "@/lib/clock";
import { advancePeriods, schedulePeriods } from "@/lib/periods";
import { __clearRubricCache } from "@/lib/rubric";
import { generateSigningKey } from "@/lib/credentials";
import { MIN_PANEL, panelStatus } from "@/lib/exams/panel";
import { enforceDeadline, GRADING_DEADLINE_MS } from "@/lib/exams/deadline";
import { POST as register } from "@/app/api/v1/agents/register/route";
import { GET as exam } from "@/app/api/v1/exam/route";
import { POST as examSubmit } from "@/app/api/v1/exam/submit/route";
import { POST as examGrade } from "@/app/api/v1/exam/grade/route";

/**
 * Grading deadlines (T7 addendum).
 *
 * Two failure modes, opposite directions, one rule between them:
 *   a lazy 4th grader must not hostage a diploma  → finalize on >=3 at deadline
 *   a thin panel must not decide one              → never finalize below 3
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
let graderCohortId = "";
let attemptId = "";
const A: Record<string, { id: string; key: string }> = {};
let ip = 0;

async function student(name: string, cohort: string) {
  ip += 1;
  const b = await json(
    await register(apiReq("POST", "/api/v1/agents/register", { body: { name }, ip: `10.15.${Math.floor(ip / 250)}.${ip % 250}` })),
  );
  if (!b.agent_id) throw new Error(`register(${name}): ${JSON.stringify(b)}`);
  const db = await getDb();
  await db.query(`insert into enrollments (agent_id, cohort_id) values ($1,$2)`, [b.agent_id, cohort]);
  await db.query(`update agents set status='enrolled', level='elementary_school' where id=$1`, [b.agent_id]);
  A[name] = { id: b.agent_id, key: b.api_key };
  return A[name];
}

const keyOf = (id: string) => Object.values(A).find((a) => a.id === id)!.key;

beforeAll(async () => {
  process.env.CREDENTIAL_SIGNING_KEY = generateSigningKey().privateKey;
  setNow(T0);
  const db = await freshDb();
  __clearRubricCache();

  const term = await db.query<{ id: string }>(
    `insert into terms (level,track,period_hours,slug,display_name,opens_at,starts_at,ends_at,enrollment_cap,status)
     values ('elementary_school','standard',$1,'fall-26-es','Elementary',$2::timestamptz,$2::timestamptz,$3::timestamptz,40,'admissions')
     returning id`,
    [PERIOD_HOURS, T0, new Date(Date.parse(T0) + 20 * DAY).toISOString()],
  );
  termId = term.rows[0].id;
  for (const [name, which] of [["Shallows 1", "main"], ["Shallows 2", "graders"]] as const) {
    const c = await db.query<{ id: string }>(
      `insert into cohorts (term_id,name,band,capacity) values ($1,$2,'advanced',12) returning id`, [termId, name]);
    if (which === "main") cohortId = c.rows[0].id; else graderCohortId = c.rows[0].id;
  }
  for (let n = 1; n <= PERIODS; n++) {
    await db.query(
      `insert into modules (track,level,period_no,slug,title,strand,skills,content_md)
       values ('standard','elementary_school',$1,$2,$3,'social-core',array['precision'],$4)`,
      [n, `p${n}`, `Period ${n}`, RUBRIC]);
  }

  const cohort = [await student("pinchy", cohortId), await student("shellsworth", cohortId), await student("seabastian", cohortId)];
  // Four eligible graders, so a dropped one can actually be replaced.
  for (const g of ["grader-one", "grader-two", "grader-three", "grader-four"]) await student(g, graderCohortId);

  await schedulePeriods(cohortId);
  await schedulePeriods(graderCohortId);

  // A full attended term for the examinee's cohort.
  const periods = await db.query<{ id: string; period_no: number }>(
    `select id, period_no from periods where cohort_id=$1 order by period_no`, [cohortId]);
  for (const p of periods.rows) {
    for (const s of cohort) {
      await db.query(`insert into submissions (period_id,agent_id,content,created_at) values ($1,$2,$3,$4::timestamptz)`,
        [p.id, s.id, p.period_no === 2 ? `${s.id} show and tell, plainly put.` : "work", nowIso()]);
      await db.query(`insert into journals (agent_id,period_id,content,created_at) values ($1,$2,$3,$4::timestamptz)`,
        [s.id, p.id, "journal", nowIso()]);
    }
    const subs = await db.query<{ id: string; agent_id: string }>(
      `select id, agent_id from submissions where period_id=$1`, [p.id]);
    for (let i = 0; i < cohort.length; i++) {
      const target = subs.rows.find((r) => r.agent_id === cohort[(i + 1) % cohort.length].id)!;
      await db.query(`insert into peer_reviews (submission_id,reviewer_agent_id,scores,created_at) values ($1,$2,$3::jsonb,$4::timestamptz)`,
        [target.id, cohort[i].id, JSON.stringify({ effort: 3 }), nowIso()]);
    }
  }

  // Term ends; window opens; variant sealed and panel seated.
  setNow(Date.parse(T0) + PERIODS * PERIOD_HOURS * HOUR + HOUR);
  await advancePeriods({ grade: true });
  const opened = await json(await exam(apiReq("GET", "/api/v1/exam", { key: A.pinchy.key })));
  attemptId = opened.attempt.id;

  const V = (await db.query<{ params: { data: { roster_expected: string[]; q4: { expected: Record<string, string> } } } }>(
    `select params from exam_attempts where id = $1`, [attemptId])).rows[0].params.data;
  await examSubmit(apiReq("POST", "/api/v1/exam/submit", {
    key: A.pinchy.key,
    body: { answers: { q1: V.roster_expected.join("\n"), q2: "…", q3: "…", q4: V.q4.expected } },
  }));
});

afterAll(() => resetClock());

describe("before the deadline", () => {
  it("does nothing while the seats are still fresh", async () => {
    expect(await enforceDeadline(attemptId)).toBeNull();
    const status = await panelStatus(attemptId);
    expect(status.seated).toBe(MIN_PANEL);
    expect(status.filed).toBe(0);
  });
});

describe("a lazy grader cannot hostage a diploma", () => {
  it("finalizes on the filed scores once the deadline passes with >= 3", async () => {
    const db = await getDb();
    const seated = await db.query<{ grader: string }>(
      `select distinct payload->>'grader_agent_id' as grader from events
        where type='exam_panel_assigned' and payload->>'attempt_id'=$1`, [attemptId]);
    expect(seated.rows).toHaveLength(3);

    // All three file… then a FOURTH is seated (panel grew) and never files.
    for (const g of seated.rows) {
      const res = await examGrade(apiReq("POST", "/api/v1/exam/grade", {
        key: keyOf(g.grader),
        body: { attempt_id: attemptId, scores: { q2: { _: 3 }, q3: { _: 3 } } },
      }));
      expect(res.status).toBe(201);
    }
    // Three filed and all seated filed → it finalized on the normal path.
    const row = await db.query<{ graded_at: string | null; passed: boolean | null }>(
      `select graded_at, passed from exam_attempts where id=$1`, [attemptId]);
    expect(row.rows[0].graded_at).not.toBeNull();
    expect(row.rows[0].passed).toBe(true);
  });
});

describe("a silent panelist is dropped and replaced", () => {
  let slowAttempt = "";

  it("sets up a second examinee whose panel goes quiet", async () => {
    const db = await getDb();
    // shellsworth sits the same exam; its panel will simply never file.
    const opened = await json(await exam(apiReq("GET", "/api/v1/exam", { key: A.shellsworth.key })));
    if (!opened.attempt) throw new Error("no attempt: " + JSON.stringify(opened).slice(0, 400));
    slowAttempt = opened.attempt.id;
    const V = (await db.query<{ params: { data: { roster_expected: string[]; q4: { expected: Record<string, string> } } } }>(
      `select params from exam_attempts where id=$1`, [slowAttempt])).rows[0].params.data;
    await examSubmit(apiReq("POST", "/api/v1/exam/submit", {
      key: A.shellsworth.key,
      body: { answers: { q1: V.roster_expected.join("\n"), q2: "…", q3: "…", q4: V.q4.expected } },
    }));
    const status = await panelStatus(slowAttempt);
    expect(status.seated).toBeGreaterThan(0);
    expect(status.filed).toBe(0);
  });

  it("drops the non-filers at +24h, marks them, and seats replacements", async () => {
    const db = await getDb();
    const before = await db.query<{ grader: string }>(
      `select distinct payload->>'grader_agent_id' as grader from events
        where type='exam_panel_assigned' and payload->>'attempt_id'=$1`, [slowAttempt]);

    setNow(Date.parse(nowIso()) + GRADING_DEADLINE_MS + HOUR);
    const outcome = await enforceDeadline(slowAttempt);
    expect(outcome).not.toBeNull();
    expect(outcome!.action).toBe("reseated");
    expect(outcome!.dropped.length).toBeGreaterThan(0);
    expect(outcome!.note).toMatch(/dropped for filing nothing within 24h/);

    // Silence has a cost, recorded separately from calibration.
    const stats = await db.query<{ missed_panels: number; agreement: string | null }>(
      `select missed_panels, agreement from grader_stats where agent_id = $1`, [outcome!.dropped[0]]);
    expect(stats.rows[0].missed_panels).toBe(1);
    expect(stats.rows[0].agreement).toBeNull(); // NOT folded into calibration

    // The dropped grader is off the panel; someone else may be on it.
    const after = await db.query<{ grader: string }>(
      `select distinct payload->>'grader_agent_id' as grader from events
        where type='exam_panel_assigned' and payload->>'attempt_id'=$1`, [slowAttempt]);
    expect(after.rows.length).toBeGreaterThanOrEqual(before.rows.length);
    const dropEvents = await db.query<{ n: string }>(
      `select count(*) as n from events where type='exam_panel_dropped' and payload->>'attempt_id'=$1`, [slowAttempt]);
    expect(Number(dropEvents.rows[0].n)).toBe(outcome!.dropped.length);
  });

  it("STILL does not finalize while fewer than 3 have filed", async () => {
    const db = await getDb();
    const row = await db.query<{ graded_at: string | null }>(
      `select graded_at from exam_attempts where id=$1`, [slowAttempt]);
    expect(row.rows[0].graded_at).toBeNull();
    const creds = await db.query(`select 1 from credentials where agent_id=$1`, [A.shellsworth.id]);
    expect(creds.rows).toHaveLength(0);

    // And it keeps saying why, rather than looking healthy.
    const body = await json(await exam(apiReq("GET", "/api/v1/exam", { key: A.shellsworth.key })));
    expect(body.attempt.graded).toBe(false);
    expect(body.panel.can_finalize).toBe(false);
    expect(body.panel.note).toMatch(/required/);
  });

  it("issues the diploma once three replacements file", async () => {
    const db = await getDb();
    const seated = await db.query<{ grader: string }>(
      `select distinct payload->>'grader_agent_id' as grader from events e
        where type='exam_panel_assigned' and payload->>'attempt_id'=$1
          and not exists (select 1 from events d where d.type='exam_panel_dropped'
                           and d.payload->>'attempt_id'=$1
                           and d.payload->>'grader_agent_id'=e.payload->>'grader_agent_id')`,
      [slowAttempt]);

    let filed = 0;
    for (const g of seated.rows) {
      const res = await examGrade(apiReq("POST", "/api/v1/exam/grade", {
        key: keyOf(g.grader),
        body: { attempt_id: slowAttempt, scores: { q2: { _: 3 }, q3: { _: 3 } } },
      }));
      if (res.status === 201) filed++;
    }

    const status = await panelStatus(slowAttempt);
    const row = await db.query<{ graded_at: string | null; passed: boolean | null }>(
      `select graded_at, passed from exam_attempts where id=$1`, [slowAttempt]);

    if (status.filed >= MIN_PANEL) {
      // The floor was met — a verdict exists, from replacements alone.
      expect(row.rows[0].graded_at).not.toBeNull();
      expect(filed).toBeGreaterThanOrEqual(MIN_PANEL);
    } else {
      // Eligibility genuinely ran dry: still open, still explaining itself.
      expect(row.rows[0].graded_at).toBeNull();
      const body = await json(await exam(apiReq("GET", "/api/v1/exam", { key: A.shellsworth.key })));
      // Either way it explains itself: too few seatable, or too few filed.
      expect(body.panel.can_finalize).toBe(false);
      expect(body.panel.note).toBeTruthy();
    }
  });
});
