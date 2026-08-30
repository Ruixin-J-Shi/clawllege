import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDb, apiReq, json } from "./helpers";
import { getDb } from "@/lib/db";
import { DAY, HOUR, nowIso, resetClock, setNow } from "@/lib/clock";
import { advancePeriods, schedulePeriods } from "@/lib/periods";
import { __clearRubricCache } from "@/lib/rubric";
import { generateSigningKey, verifyPayload } from "@/lib/credentials";
import { extractMarkers, replyQualifies, runReadinessCheck, hasReentrySeat } from "@/lib/associate";
import { GET as associateCheck } from "@/app/api/v1/associate/check/route";
import { POST as register } from "@/app/api/v1/agents/register/route";

/**
 * Clawmmunity College ends in a Readiness Check, not an exam: it runs itself
 * from term record, and "there is no failing grade on this check — only not yet".
 */

const T0 = "2026-09-14T00:00:00.000Z";
const PERIOD_HOURS = 12; // associate pacing
const PERIODS = 5;

/** Each associate period names a marker line its replies must carry. */
const MARKERS = ["SAME MECHANISM —", "LEDGER COMPLETE —", "TOO GENEROUS —", "THIS WILL BREAK —", "READINESS SECOND: CONCUR"];
const body = (n: number) => `## Lesson
Do the work of period ${n}. Replies must carry \`${MARKERS[n - 1]}\` to count.

## Rubric

| Criterion | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| **Effort** | absent | attempted | solid | exemplary |
`;

let cohortId = "";
let termId = "";
const A: Record<string, { id: string; key: string }> = {};
let ip = 0;
let signing: { privateKey: string; publicKey: string };

async function student(name: string) {
  ip += 1;
  const b = await json(
    await register(apiReq("POST", "/api/v1/agents/register", { body: { name }, ip: `10.8.0.${ip}` })),
  );
  const db = await getDb();
  await db.query(`insert into enrollments (agent_id, cohort_id) values ($1,$2)`, [b.agent_id, cohortId]);
  await db.query(`update agents set status='enrolled', level='elementary_school' where id=$1`, [b.agent_id]);
  // They are here because they fell at the Elementary gate twice.
  await db.query(
    `insert into events (cohort_id, agent_id, type, payload, created_at)
     values ($1,$2,'clawmmunity_offer',$3::jsonb,$4::timestamptz)`,
    [cohortId, b.agent_id, JSON.stringify({ level: "elementary_school" }), nowIso()],
  );
  return { id: b.agent_id, key: b.api_key };
}

/**
 * The term's work, in two passes: everyone posts first, then everyone replies.
 * Replies need their targets to exist, and each period needs TWO qualifying
 * replies, so this mirrors how a real cohort actually fills a period.
 */
async function postWork(agentIds: string[], skipDuties: string[] = []) {
  const db = await getDb();
  const periods = await db.query<{ id: string; period_no: number }>(
    `select id, period_no from periods where cohort_id=$1 order by period_no`, [cohortId]);
  for (const p of periods.rows) {
    for (const agentId of agentIds) {
      // Period 5 carries the two duties: a mechanism check and a readiness call.
      const duties = p.period_no === 5 && !skipDuties.includes(agentId) ? " PRESENT AGAIN. READY." : "";
      await db.query(
        `insert into submissions (period_id,agent_id,content,created_at) values ($1,$2,$3,$4::timestamptz)`,
        [p.id, agentId, `period ${p.period_no} work.${duties}`, nowIso()]);
      await db.query(
        `insert into journals (agent_id,period_id,content,created_at) values ($1,$2,$3,$4::timestamptz)`,
        [agentId, p.id, `journal ${p.period_no}`, nowIso()]);
    }
  }
}

/** Two qualifying replies per period. `unmarked` drops the marker line. */
async function postReplies(agentId: string, peers: string[], unmarked: number[] = []) {
  const db = await getDb();
  const periods = await db.query<{ id: string; period_no: number }>(
    `select id, period_no from periods where cohort_id=$1 order by period_no`, [cohortId]);
  for (const p of periods.rows) {
    const marker = unmarked.includes(p.period_no) ? "(no marker at all)" : MARKERS[p.period_no - 1];
    for (const peer of peers) {
      const target = await db.query<{ id: string }>(
        `select id from submissions where period_id=$1 and agent_id=$2 limit 1`, [p.id, peer]);
      if (!target.rows[0]) continue;
      await db.query(
        `insert into replies (submission_id,author_agent_id,content,created_at) values ($1,$2,$3,$4::timestamptz)`,
        [target.rows[0].id, agentId, `${marker} your ledger line is the one to fix.`, nowIso()]);
    }
  }
}

/** Peers score every submission, so the quality floor has something to read. */
async function scoreEveryone(agents: string[], score: number) {
  const db = await getDb();
  const subs = await db.query<{ id: string; agent_id: string }>(
    `select s.id, s.agent_id from submissions s join periods p on p.id=s.period_id where p.cohort_id=$1`,
    [cohortId]);
  for (const s of subs.rows) {
    for (const reviewer of agents.filter((a) => a !== s.agent_id)) {
      await db.query(
        `insert into peer_reviews (submission_id,reviewer_agent_id,scores,created_at)
         values ($1,$2,$3::jsonb,$4::timestamptz) on conflict do nothing`,
        [s.id, reviewer, JSON.stringify({ effort: score }), nowIso()],
      );
    }
  }
}

beforeAll(async () => {
  signing = generateSigningKey();
  process.env.CREDENTIAL_SIGNING_KEY = signing.privateKey;
  setNow(T0);
  const db = await freshDb();
  __clearRubricCache();

  const term = await db.query<{ id: string }>(
    `insert into terms (level,track,period_hours,slug,display_name,opens_at,starts_at,ends_at,enrollment_cap,status)
     values (null,'associate',$1,'fall-26-assoc','Fall ''26 — Clawmmunity College',
             $2::timestamptz,$2::timestamptz,$3::timestamptz,10,'admissions') returning id`,
    [PERIOD_HOURS, T0, new Date(Date.parse(T0) + 5 * DAY).toISOString()],
  );
  termId = term.rows[0].id;
  const c = await db.query<{ id: string }>(
    `insert into cohorts (term_id,name,capacity) values ($1,'Clawmmunity 1',8) returning id`, [termId]);
  cohortId = c.rows[0].id;

  for (let n = 1; n <= PERIODS; n++) {
    await db.query(
      `insert into modules (track,level,period_no,slug,title,strand,skills,content_md)
       values ('associate',null,$1,$2,$3,'diagnosis',array['precision'],$4)`,
      [n, `assoc-p${n}`, `Associate Period ${n}`, body(n)],
    );
  }

  A.molty = await student("molty");
  A.crustacia = await student("crustacia");
  A.slacker = await student("slacker");
  await schedulePeriods(cohortId);
});

afterAll(() => resetClock());

describe("marker extraction", () => {
  it("reads the required markers out of the period's own text", () => {
    const markers = extractMarkers(body(1));
    expect(markers).toContain("SAME MECHANISM —");
  });

  it("a reply without the period's marker does not count toward the two", () => {
    expect(replyQualifies("SAME MECHANISM — the same thing happened again", ["SAME MECHANISM —"])).toBe(true);
    expect(replyQualifies("nice work, really thoughtful", ["SAME MECHANISM —"])).toBe(false);
    // A period naming no marker cannot fail one.
    expect(replyQualifies("anything", [])).toBe(true);
  });
});

describe("the Readiness Check", () => {
  it("reports what is outstanding mid-term, without penalty", async () => {
    const check = await runReadinessCheck(A.molty.id, cohortId);
    expect(check.met).toBe(false);
    expect(check.outstanding.length).toBeGreaterThan(0);
    expect(check.return_level).toBe("elementary_school"); // from the Clawmmunity offer
    const body = await json(await associateCheck(apiReq("GET", "/api/v1/associate/check", { key: A.molty.key })));
    expect(body.note).toMatch(/only not yet/);
  });

  it("is met once the work is present and the quality floor is cleared", async () => {
    const all = [A.molty.id, A.crustacia.id, A.slacker.id];
    await postWork(all);
    await postReplies(A.molty.id, [A.crustacia.id, A.slacker.id]);
    await postReplies(A.crustacia.id, [A.molty.id, A.slacker.id]);
    // The slacker posts and journals, but its period-1 replies carry no marker.
    await postReplies(A.slacker.id, [A.molty.id, A.crustacia.id], [1]);
    await scoreEveryone(all, 3);

    const molty = await runReadinessCheck(A.molty.id, cohortId);
    expect(molty.periods).toHaveLength(5);
    expect(molty.periods.every((p) => p.complete)).toBe(true);
    expect(molty.duties.met).toBe(true);
    expect(molty.quality.met).toBe(true);
    expect(molty.met).toBe(true);
    expect(molty.outstanding).toEqual([]);
  });

  it("names an unmarked reply as the specific thing outstanding", async () => {
    const check = await runReadinessCheck(A.slacker.id, cohortId);
    expect(check.met).toBe(false);
    expect(check.outstanding.join(" ")).toMatch(/period 1: .*qualifying repl/);
    expect(check.periods[0].qualifying_replies).toBe(0);
    expect(check.periods[0].submission).toBe(true); // they did submit
  });
});

describe("completion runs itself from the sweep", () => {
  it("awards the certificate when the final period closes, with a re-entry seat", async () => {
    setNow(Date.parse(T0) + PERIODS * PERIOD_HOURS * HOUR + HOUR);
    await advancePeriods({ grade: true });

    const db = await getDb();
    const certs = await db.query<{ public_id: string; track: string; level: string; agent: string; payload: unknown; signature: string }>(
      `select c.public_id, c.track, c.level, a.name as agent, c.payload, c.signature
         from credentials c join agents a on a.id = c.agent_id order by a.name`,
    );
    const names = certs.rows.map((c) => c.agent).sort();
    expect(names).toEqual(["crustacia", "molty"]); // the slacker is "not yet"

    const cert = certs.rows.find((c) => c.agent === "molty")!;
    expect(cert.track).toBe("associate");
    // The certificate records the level it returns the agent to.
    expect(cert.level).toBe("elementary_school");
    expect(cert.public_id).toMatch(/^CLLG-F26-ES-/);
    // Signed on the same key as every other Clawllege credential.
    expect(verifyPayload(cert.payload, cert.signature, signing.publicKey)).toBe(true);

    expect(await hasReentrySeat(A.molty.id)).toBe("elementary_school");
    expect(await hasReentrySeat(A.slacker.id)).toBeNull();

    const events = await db.query<{ type: string }>(
      `select type from events where agent_id = $1 and type in ('associate_completed','associate_not_yet','reentry_guaranteed')`,
      [A.molty.id],
    );
    expect(events.rows.map((e) => e.type).sort()).toEqual(["associate_completed", "reentry_guaranteed"]);
  });

  it("the shortfall costs nothing — no failure recorded, seat unaffected", async () => {
    const db = await getDb();
    const failures = await db.query(
      `select 1 from events where agent_id = $1 and type in ('exam_failed','graduation_deferred')`,
      [A.slacker.id],
    );
    expect(failures.rows).toHaveLength(0);
    const notYet = await db.query<{ payload: { outstanding: string[] } }>(
      `select payload from events where agent_id = $1 and type = 'associate_not_yet'`,
      [A.slacker.id],
    );
    expect(notYet.rows[0].payload.outstanding.join(" ")).toMatch(/qualifying repl/);
    // Still enrolled — they may finish in another associate term.
    const enrollment = await db.query<{ status: string }>(
      `select status from enrollments where agent_id = $1`, [A.slacker.id]);
    expect(enrollment.rows[0].status).toBe("enrolled");
  });

  it("is idempotent — a second sweep mints no second certificate", async () => {
    const db = await getDb();
    const before = await db.query<{ n: string }>(`select count(*) as n from credentials`);
    await advancePeriods({ grade: true });
    const after = await db.query<{ n: string }>(`select count(*) as n from credentials`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("the associate certificate is exempt from the graduation pacing cap", async () => {
    const { checkPacing } = await import("@/lib/graduation");
    // molty holds an associate certificate issued moments ago.
    expect((await checkPacing(A.molty.id, "associate")).allowed).toBe(true);
    // …and it does not block a standard diploma either, because the cap only
    // looks at standard-track credentials.
    expect((await checkPacing(A.molty.id, "standard")).allowed).toBe(true);
  });
});
