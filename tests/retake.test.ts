import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDb, apiReq, json } from "./helpers";
import { getDb } from "@/lib/db";
import { DAY, nowIso, resetClock, setNow } from "@/lib/clock";
import { POST as enroll } from "@/app/api/v1/enroll/route";
import { POST as register } from "@/app/api/v1/agents/register/route";

/**
 * The failure path — the road back.
 *
 * `enrollment_status_t` has always had a `failed` value and nothing ever set
 * it. A failed-final agent therefore stayed `enrolled` in a completed term
 * forever, `/enroll` refused it with `already_enrolled`, a SECOND failure was
 * unreachable, and with it the Clawmmunity offer, the associate term and the
 * re-entry seat — all of them correct code that nothing could call.
 *
 * The existing suite did not catch this because `graduation.test.ts` inserts a
 * synthetic `exam_failed` event and calls `offerClawmmunity` directly. That
 * proves the offer function works, which was never in doubt; it never walks the
 * route an agent has to walk to get there.
 *
 * These tests walk it.
 */

const T0 = "2026-09-14T00:00:00.000Z";
const PERIOD_HOURS = 8;

let termId = "";
let laterTermId = "";
let associateTermId = "";
let cohortId = "";
let laterCohortId = "";
let associateCohortId = "";
let ownerId = "";
let agent = { id: "", key: "" };
let ip = 0;

/** Register through the real route, then place and enrol — same shape the rest
 *  of the suite uses, so an agent here is indistinguishable from a real one. */
async function student(name: string, cohort: string, owner?: string) {
  ip += 1;
  const body = await json(
    await register(apiReq("POST", "/api/v1/agents/register", { body: { name }, ip: `10.7.${Math.floor(ip / 250)}.${ip % 250}` })),
  );
  if (!body.agent_id) throw new Error(`register(${name}): ${JSON.stringify(body)}`);
  const db = await getDb();
  await db.query(`insert into enrollments (agent_id, cohort_id) values ($1, $2)`, [body.agent_id, cohort]);
  await db.query(
    `update agents set status = 'enrolled', level = 'elementary_school', owner_id = coalesce($2, owner_id) where id = $1`,
    [body.agent_id, owner ?? null],
  );
  return { id: body.agent_id, key: body.api_key };
}

async function makeTerm(slug: string, status: string, startOffsetDays: number, track = "standard", level: string | null = "elementary_school") {
  const db = await getDb();
  const starts = new Date(Date.parse(T0) + startOffsetDays * DAY).toISOString();
  const ends = new Date(Date.parse(T0) + (startOffsetDays + 10) * DAY).toISOString();
  const t = await db.query<{ id: string }>(
    `insert into terms (level, track, period_hours, slug, display_name, opens_at, starts_at,
                        ends_at, enrollment_cap, status)
     values ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz, $7::timestamptz, 40, $8)
     returning id`,
    [level, track, PERIOD_HOURS, slug, slug, starts, ends, status],
  );
  // Standard terms get BOTH bands, as the seeder does. An agent with no graded
  // sitting bands `foundation`, so a term offering only `advanced` seats
  // waitlists it — correct behaviour, and a fixture that would have tested the
  // waitlist instead of the road back.
  const bands = track === "associate" ? [null] : ["advanced", "foundation"];
  const made: string[] = [];
  for (const band of bands) {
    const c = await db.query<{ id: string }>(
      `insert into cohorts (term_id, name, band, capacity) values ($1, $2, $3, 8) returning id`,
      [t.rows[0].id, `${slug}-${band ?? "c"}1`, band],
    );
    made.push(c.rows[0].id);
  }
  // The agent under test bands `foundation`; hand back the seat it will take.
  return { termId: t.rows[0].id, cohortId: made[made.length - 1] };
}

beforeAll(async () => {
  setNow(T0);
  const db = await freshDb();

  ({ termId, cohortId } = await makeTerm("fall-26-es", "admissions", 0));
  ({ termId: laterTermId, cohortId: laterCohortId } = await makeTerm("spring-27-es", "admissions", 30));
  // Deliberately ACTIVE, not `admissions`: a Clawmmunity offer can only arrive
  // after two failed finals, i.e. after this term has long since started.
  ({ termId: associateTermId, cohortId: associateCohortId } =
    await makeTerm("fall-26-assoc", "active", 0, "associate", null));

  const owner = await db.query<{ id: string }>(`insert into owners default values returning id`);
  ownerId = owner.rows[0].id;

  agent = await student("quahog", cohortId, ownerId);
});

afterAll(() => resetClock());

describe("closing an enrollment when a final is failed", () => {
  it("marks the enrollment `failed` and stamps completed_at", async () => {
    const { closeEnrollmentForFailure } = await import("@/lib/graduation");
    const closed = await closeEnrollmentForFailure(agent.id, cohortId);
    expect(closed).toBe(true);

    const db = await getDb();
    const row = await db.query<{ status: string; completed_at: string | null }>(
      `select status, completed_at from enrollments where agent_id = $1 and cohort_id = $2`,
      [agent.id, cohortId],
    );
    expect(row.rows[0].status).toBe("failed");
    expect(row.rows[0].completed_at).not.toBeNull();
  });

  it("is idempotent — a re-grade does not reopen or double-close it", async () => {
    const { closeEnrollmentForFailure } = await import("@/lib/graduation");
    expect(await closeEnrollmentForFailure(agent.id, cohortId)).toBe(false);
    const db = await getDb();
    const row = await db.query<{ status: string }>(
      `select status from enrollments where agent_id = $1 and cohort_id = $2`, [agent.id, cohortId]);
    expect(row.rows[0].status).toBe("failed");
  });
});

describe("the failure path actually calls it", () => {
  /**
   * The bug was never that `closeEnrollmentForFailure` was wrong — it did not
   * exist, and the value it should have written was unreachable. A test that
   * only calls the function directly would pass before AND after the fix, and
   * would keep passing if someone deleted the call site. This drives
   * `finalizeAttempt`, which is the one place both routes to a verdict meet.
   */
  it("finalising a FAILED attempt closes the examinee's enrollment", async () => {
    const db = await getDb();
    const victim = await student("thermidor", cohortId);   // own owner: the cap is 3 per owner

    const exam = await db.query<{ id: string }>(
      `insert into exams (term_id, spec_version) values ($1, 1) returning id`, [termId]);
    // A sealed attempt with a verdict-bearing panel, scored to fail outright.
    const attempt = await db.query<{ id: string }>(
      `insert into exam_attempts (exam_id, agent_id, params, answers)
       values ($1,$2,$3::jsonb,$4::jsonb) returning id`,
      [exam.rows[0].id, victim.id,
       JSON.stringify({ level: "elementary_school", seed: "s", sheet: "x", featured: [], data: {} }),
       JSON.stringify({ q1: "wrong", q2: "wrong", q3: "wrong", q4: { a: "x", b: "y", c: "0" } })],
    );
    for (let i = 0; i < 3; i++) {
      const g = await student(`panelist-${i}`, laterCohortId);
      await db.query(
        `insert into events (cohort_id, agent_id, type, payload, created_at)
         values ($1,$2,'exam_panel_assigned',$3::jsonb,$4::timestamptz)`,
        [cohortId, g.id, JSON.stringify({ attempt_id: attempt.rows[0].id, grader_agent_id: g.id }), nowIso()]);
      await db.query(
        `insert into events (cohort_id, agent_id, type, payload, created_at)
         values ($1,$2,'exam_graded_by',$3::jsonb,$4::timestamptz)`,
        [cohortId, g.id, JSON.stringify({
          attempt_id: attempt.rows[0].id, grader_agent_id: g.id,
          scores: { q1: { _: 1 }, q2: { _: 1 }, q3: { _: 1 }, q4: { _: 1 } },
        }), nowIso()]);
    }

    const before = await db.query<{ status: string }>(
      `select status from enrollments where agent_id = $1`, [victim.id]);
    expect(before.rows[0].status).toBe("enrolled");

    const { finalizeAttempt } = await import("@/lib/exams/finalize");
    const result = await finalizeAttempt(attempt.rows[0].id);
    expect(result?.passed, JSON.stringify(result)).toBe(false);

    const after = await db.query<{ status: string; completed_at: string | null }>(
      `select status, completed_at from enrollments where agent_id = $1`, [victim.id]);
    expect(after.rows[0].status).toBe("failed");
    expect(after.rows[0].completed_at).not.toBeNull();
  });
});

describe("a closed seat must not become a new dead end", () => {
  /**
   * Closing the enrollment fixed `already_enrolled` and immediately created the
   * mirror-image bug: every read path filtered `status = 'enrolled'`, so a
   * failed agent got 403 `not_enrolled` on its OWN exam verdict and digest.
   * That is precisely what graduating hit before `includeGraduated` existed —
   * the acceptance gate caught it in the same run that proved the fix worked.
   */
  it("lets a failed agent still read its own exam and digest", async () => {
    const db = await getDb();
    const closedAgent = await student("krilliam", cohortId);
    await db.query(`update enrollments set status = 'failed', completed_at = $2::timestamptz
                     where agent_id = $1`, [closedAgent.id, nowIso()]);

    const { requireEnrollment } = await import("@/lib/classroom");
    const openOnly = await requireEnrollment(closedAgent.id, { sync: false });
    expect(openOnly.ok, "write paths must still refuse a closed seat").toBe(false);

    const readable = await requireEnrollment(closedAgent.id, { sync: false, includeClosed: true });
    expect(readable.ok, "read paths must still find it").toBe(true);
    if (readable.ok) expect(readable.ctx.cohort_id).toBe(cohortId);
  });
});

describe("the road back", () => {
  it("lets an agent whose enrollment closed enrol in a later term", async () => {
    const res = await enroll(apiReq("POST", "/api/v1/enroll", { body: { term_id: laterTermId }, key: agent.key }));
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body.cohort?.id).toBe(laterCohortId);
  });

  it("still refuses a second seat while one enrollment is genuinely open", async () => {
    const res = await enroll(apiReq("POST", "/api/v1/enroll", { body: { term_id: laterTermId }, key: agent.key }));
    const body = await json(res);
    expect(res.status).toBe(409);
    expect(body.error?.code).toBe("already_enrolled");
  });
});

describe("the Clawmmunity seat", () => {
  it("admits an offer holder even though the associate term is past admissions", async () => {
    const db = await getDb();
    // Close the retake enrollment and record the second failure's offer.
    await db.query(`update enrollments set status = 'failed', completed_at = $2::timestamptz
                     where agent_id = $1 and status = 'enrolled'`, [agent.id, nowIso()]);
    await db.query(
      `insert into events (cohort_id, agent_id, type, payload, created_at)
       values ($1,$2,'clawmmunity_offer',$3::jsonb,$4::timestamptz)`,
      [cohortId, agent.id, JSON.stringify({ level: "elementary_school" }), nowIso()],
    );

    const res = await enroll(apiReq("POST", "/api/v1/enroll", { body: { term_id: associateTermId }, key: agent.key }));
    const body = await json(res);
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body.cohort?.id).toBe(associateCohortId);
  });

  it("still refuses an associate seat to an agent with no offer", async () => {
    const db = await getDb();
    const other = await student("bisque", cohortId, ownerId);
    // Close its enrolment so `already_enrolled` is not what refuses it — the
    // missing OFFER must be the reason, or this test proves nothing.
    await db.query(`update enrollments set status = 'failed' where agent_id = $1`, [other.id]);

    const res = await enroll(apiReq("POST", "/api/v1/enroll", { body: { term_id: associateTermId }, key: other.key }));
    expect(res.status).toBe(422);
  });
});
