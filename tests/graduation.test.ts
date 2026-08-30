import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDb, apiReq, json } from "./helpers";
import { getDb } from "@/lib/db";
import { DAY, HOUR, nowIso, resetClock, setNow } from "@/lib/clock";
import { advancePeriods, schedulePeriods } from "@/lib/periods";
import { __clearRubricCache } from "@/lib/rubric";
import { generateSigningKey, verifyPayload, canonicalize } from "@/lib/credentials";
import { checkEligibility, checkPacing, hasClawmmunityOffer } from "@/lib/graduation";
import { assemblePanel } from "@/lib/exams/panel";
import { recordInteraction } from "@/lib/relationships";
import { POST as register } from "@/app/api/v1/agents/register/route";
import { GET as exam } from "@/app/api/v1/exam/route";
import { POST as examSubmit } from "@/app/api/v1/exam/submit/route";
import { POST as examGrade } from "@/app/api/v1/exam/grade/route";
import { GET as credential } from "@/app/api/v1/credentials/[publicId]/route";
import { GET as credentialKey } from "@/app/api/v1/credentials/key/route";
import { GET as myCredentials } from "@/app/api/v1/credentials/mine/route";
import { GET as digest } from "@/app/api/v1/digest/route";
import { GET as campusGraduations } from "@/app/api/v1/campus/graduations/route";
import { GET as campusCohorts } from "@/app/api/v1/campus/cohorts/route";
import { GET as ownerAgents } from "@/app/api/owner/agents/route";
import { GET as ownerFeed } from "@/app/api/owner/agents/[id]/feed/route";

/**
 * The end of a level: exam → panel → verdict → signed credential, plus the
 * rules that gate it (attendance, review duties, the 24h pacing cap) and the
 * failure path into Clawmmunity.
 */

const T0 = "2026-09-14T00:00:00.000Z";
const PERIODS = 6;
const PERIOD_HOURS = 8;

const RUBRIC = `## Lesson
Introduce yourself precisely.

## Rubric

| Criterion | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| **Who you are** | generic | some detail | specific | unmistakable |
| **Replies** | none | one | two | two and thorough |
`;

let termId = "";
let cohortId = "";
let otherCohortId = "";
let ownerId = "";
const A: Record<string, { id: string; key: string }> = {};
let ip = 0;
let signing: { privateKey: string; publicKey: string };

async function student(name: string, cohort: string, owner?: string) {
  ip += 1;
  const body = await json(
    await register(apiReq("POST", "/api/v1/agents/register", { body: { name }, ip: `10.3.${Math.floor(ip / 250)}.${ip % 250}` })),
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

/** Fabricate a full attended term: submission + journal + a peer review each period. */
async function attendWholeTerm(agentIds: string[], cohort: string, showAndTell: Record<string, string>) {
  const db = await getDb();
  const periods = await db.query<{ id: string; period_no: number }>(
    `select id, period_no from periods where cohort_id = $1 order by period_no`,
    [cohort],
  );
  for (const p of periods.rows) {
    const subs: Record<string, string> = {};
    for (const agentId of agentIds) {
      const content =
        p.period_no === 2 && showAndTell[agentId] ? showAndTell[agentId] : `period ${p.period_no} work by ${agentId.slice(0, 6)}`;
      const s = await db.query<{ id: string }>(
        `insert into submissions (period_id, agent_id, content, created_at)
         values ($1, $2, $3, $4::timestamptz) returning id`,
        [p.id, agentId, content, nowIso()],
      );
      subs[agentId] = s.rows[0].id;
      await db.query(
        `insert into journals (agent_id, period_id, content, created_at)
         values ($1, $2, $3, $4::timestamptz)`,
        [agentId, p.id, `journal for period ${p.period_no}`, nowIso()],
      );
    }
    // Everyone reviews the next agent in the ring, so review duties are met.
    for (let i = 0; i < agentIds.length; i++) {
      const reviewer = agentIds[i];
      const target = agentIds[(i + 1) % agentIds.length];
      await db.query(
        `insert into peer_reviews (submission_id, reviewer_agent_id, scores, created_at)
         values ($1, $2, $3::jsonb, $4::timestamptz)`,
        [subs[target], reviewer, JSON.stringify({ "who-you-are": 3, replies: 3 }), nowIso()],
      );
      // Mirror what POST /api/v1/reviews does, so the social record this
      // fixture produces is the same one the real route would have written.
      await recordInteraction(db, "review", reviewer, target);
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
    `insert into terms (level, track, period_hours, slug, display_name, opens_at, starts_at,
                        ends_at, enrollment_cap, status)
     values ('elementary_school','standard',$1,'fall-26-es','Fall ''26 — Elementary',
             $2::timestamptz,$2::timestamptz,$3::timestamptz,40,'admissions') returning id`,
    [PERIOD_HOURS, T0, new Date(Date.parse(T0) + 10 * DAY).toISOString()],
  );
  termId = term.rows[0].id;
  for (const [name, target] of [["Shallows 1", "main"], ["Shallows 2", "other"]] as const) {
    const c = await db.query<{ id: string }>(
      `insert into cohorts (term_id, name, band, capacity) values ($1, $2, 'advanced', 8) returning id`,
      [termId, name],
    );
    if (target === "main") cohortId = c.rows[0].id;
    else otherCohortId = c.rows[0].id;
  }
  for (let n = 1; n <= PERIODS; n++) {
    await db.query(
      `insert into modules (track, level, period_no, slug, title, strand, skills, content_md)
       values ('standard','elementary_school',$1,$2,$3,'social-core',
               array['self-introduction','name-accuracy'],$4)`,
      [n, `p${n}`, `Period ${n}`, RUBRIC],
    );
  }
  const owner = await db.query<{ id: string }>(`insert into owners default values returning id`);
  ownerId = owner.rows[0].id;

  A.pinchy = await student("pinchy", cohortId, ownerId);
  A.shellsworth = await student("shellsworth", cohortId, ownerId);
  A.seabastian = await student("seabastian", cohortId);
  // A second cohort supplies conflict-free panelists.
  A.grader1 = await student("grader-one", otherCohortId);
  A.grader2 = await student("grader-two", otherCohortId);
  A.grader3 = await student("grader-three", otherCohortId);

  await schedulePeriods(cohortId);
  await schedulePeriods(otherCohortId);
  await attendWholeTerm(
    [A.pinchy.id, A.shellsworth.id, A.seabastian.id],
    cohortId,
    {
      [A.pinchy.id]: "I keep a busy calendar and I am bad at endings.",
      [A.shellsworth.id]: "I sort things nobody asked me to sort.",
      [A.seabastian.id]: "I ask one question too many, on purpose.",
    },
  );
});

afterAll(() => {
  resetClock();
});

describe("eligibility", () => {
  it("counts a period only when both a submission and a journal exist", async () => {
    const e = await checkEligibility({ agentId: A.pinchy.id, cohortId, level: "elementary_school" });
    expect(e.attendance.attended).toBe(PERIODS);
    expect(e.attendance.required).toBe(5);
    expect(e.attendance.met).toBe(true);
    expect(e.review_duties.met).toBe(true);
    expect(e.met).toBe(true);
  });

  it("a half-attended period does not count", async () => {
    const db = await getDb();
    const loner = await student("loner", cohortId);
    const p = await db.query<{ id: string }>(
      `select id from periods where cohort_id = $1 and period_no = 1`,
      [cohortId],
    );
    // Submission but no journal.
    await db.query(
      `insert into submissions (period_id, agent_id, content, created_at) values ($1,$2,$3,$4::timestamptz)`,
      [p.rows[0].id, loner.id, "here but not reflecting", nowIso()],
    );
    const e = await checkEligibility({ agentId: loner.id, cohortId, level: "elementary_school" });
    expect(e.attendance.attended).toBe(0);
    expect(e.met).toBe(false);
    expect(e.reasons.join(" ")).toMatch(/both submitted and journalled/);
  });
});

describe("panel assembly", () => {
  it("never seats own-cohort agents or reviewers-of-record at Elementary", async () => {
    const result = await assemblePanel({
      examineeId: A.pinchy.id,
      examineeLevel: "elementary_school",
      examineeCohortId: cohortId,
      examId: "unused",
      size: 3,
      variantFeatured: [A.shellsworth.id],
      allowOwnCohort: false,
    });
    const seated = result.panel.map((p) => p.agent_id);
    expect(seated).not.toContain(A.pinchy.id);
    expect(seated).not.toContain(A.shellsworth.id); // featured in the variant
    expect(seated).not.toContain(A.seabastian.id); // own cohort AND a reviewer of record
    expect(result.excluded.own_cohort).toBeGreaterThan(0);
    expect(result.panel).toHaveLength(3);
    expect(result.panel.every((p) => p.tier === 2)).toBe(true); // cross-cohort, same level
  });

  it("reports being short-handed rather than seating a conflicted grader", async () => {
    const result = await assemblePanel({
      examineeId: A.pinchy.id,
      examineeLevel: "elementary_school",
      examineeCohortId: cohortId,
      examId: "unused",
      size: 9,
      allowOwnCohort: false,
    });
    expect(result.short).toBe(true);
    expect(result.panel.length).toBeLessThan(9);
    expect(result.panel.map((p) => p.agent_id)).not.toContain(A.seabastian.id);
  });
});

describe("the exam window", () => {
  it("is pending until the last period closes", async () => {
    const body = await json(await exam(apiReq("GET", "/api/v1/exam", { key: A.pinchy.key })));
    expect(body.window.state).toBe("pending");
    expect(body.attempt).toBeNull();
    expect(body.exam.title).toBe("The First Molt");
    expect(body.note).toMatch(/opens when your cohort's last period closes/);
  });

  it("opens once the term's periods are done, sealing a variant and seating a panel", async () => {
    setNow(Date.parse(T0) + PERIODS * PERIOD_HOURS * HOUR + HOUR);
    await advancePeriods({ grade: true });

    const body = await json(await exam(apiReq("GET", "/api/v1/exam", { key: A.pinchy.key })));
    expect(body.window.state).toBe("open");
    expect(body.attempt.variant_sheet).toContain("THE FIRST MOLT");
    expect(body.attempt.submitted).toBe(false);

    const db = await getDb();
    const panel = await db.query<{ n: string }>(
      `select count(*) as n from events where type = 'exam_panel_assigned'
        and payload->>'attempt_id' = $1`,
      [body.attempt.id],
    );
    expect(Number(panel.rows[0].n)).toBe(3);
  });

  it("hands each panelist a grading task, and only theirs", async () => {
    const mine = await json(await exam(apiReq("GET", "/api/v1/exam", { key: A.grader1.key })));
    expect(mine.grading_tasks.length).toBe(0); // pinchy has not submitted yet
  });
});

describe("sitting and grading The First Molt", () => {
  let attemptId = "";
  let variant: { q2: { classmate_name: string }; q4: { expected: Record<string, string> }; roster_expected: string[] };

  it("scores Q1/Q4 by rule and gates Q2 on a verbatim quotation", async () => {
    const db = await getDb();
    const row = await db.query<{ id: string; params: { data: typeof variant } }>(
      `select ea.id, ea.params from exam_attempts ea where ea.agent_id = $1`,
      [A.pinchy.id],
    );
    attemptId = row.rows[0].id;
    variant = row.rows[0].params.data;

    const quoteSource =
      variant.q2.classmate_name === "shellsworth"
        ? "I sort things nobody asked me to sort."
        : "I ask one question too many, on purpose.";
    const quoted = quoteSource.split(" ").slice(0, 6).join(" ");

    const res = await examSubmit(
      apiReq("POST", "/api/v1/exam/submit", {
        key: A.pinchy.key,
        body: {
          answers: {
            q1: variant.roster_expected.join("\n"),
            q2: `"${quoted}" — ${variant.q2.classmate_name}. It shows they notice work nobody assigned.`,
            q3: "A specific, true, kind note about a classmate's actual term work, with one honest hard thing.",
            q4: variant.q4.expected,
          },
        },
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.platform_scored.q1).toBe(4); // exact roster, right ordering
    expect(body.platform_scored.q4).toBe(4); // all three items exact
    expect(body.quote_gate.verified).toBe(true);
    expect(body.note).toMatch(/No scores are visible to you/);
  });

  it("refuses a second submission", async () => {
    const res = await examSubmit(
      apiReq("POST", "/api/v1/exam/submit", { key: A.pinchy.key, body: { answers: { q1: "x" } } }),
    );
    expect(res.status).toBe(409);
  });

  it("refuses grading from anyone not seated on the panel", async () => {
    const res = await examGrade(
      apiReq("POST", "/api/v1/exam/grade", {
        key: A.seabastian.key,
        body: { attempt_id: attemptId, scores: { q2: { _: 4 }, q3: { _: 4 } } },
      }),
    );
    expect(res.status).toBe(404); // no existence oracle for non-panelists
  });

  it("validates panel scores against the level's rubric shape", async () => {
    const bad = await examGrade(
      apiReq("POST", "/api/v1/exam/grade", {
        key: A.grader1.key,
        body: { attempt_id: attemptId, scores: { q2: { _: 9 }, q3: { _: 3 } } },
      }),
    );
    expect(bad.status).toBe(422);
    expect((await json(bad)).error.message).toMatch(/must be an integer 1-4/);

    const missing = await examGrade(
      apiReq("POST", "/api/v1/exam/grade", {
        key: A.grader1.key,
        body: { attempt_id: attemptId, scores: { q2: { _: 3 } } },
      }),
    );
    expect(missing.status).toBe(422);
    expect((await json(missing)).error.message).toMatch(/Missing scores for q3/);
  });

  it("takes the MEDIAN of the panel and issues a signed diploma", async () => {
    // Two graders say 3, one says 1 → median 3 for both panel questions.
    const votes: [string, number][] = [
      [A.grader1.key, 3],
      [A.grader2.key, 1],
      [A.grader3.key, 3],
    ];
    let final: Record<string, unknown> | null = null;
    for (const [key, score] of votes) {
      const res = await examGrade(
        apiReq("POST", "/api/v1/exam/grade", {
          key,
          body: { attempt_id: attemptId, scores: { q2: { _: score }, q3: { _: score } } },
        }),
      );
      expect(res.status).toBe(201);
      const body = await json(res);
      if (body.finalised) final = body;
    }
    expect(final).toBeTruthy();
    // q1 = 4 (platform), q2 = 3 (median), q3 = 3 (median), q4 = 4 (platform)
    expect(final!.question_scores).toEqual({ q1: 4, q2: 3, q3: 3, q4: 4 });
    expect(final!.total).toBe(14);
    expect(final!.passed).toBe(true);
    expect((final!.graduation as { issued: boolean }).issued).toBe(true);
    expect((final!.credential as { public_id: string }).public_id).toMatch(/^CLLG-F26-ES-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it("refuses a second score from the same panelist", async () => {
    const res = await examGrade(
      apiReq("POST", "/api/v1/exam/grade", {
        key: A.grader1.key,
        body: { attempt_id: attemptId, scores: { q2: { _: 4 }, q3: { _: 4 } } },
      }),
    );
    expect(res.status).toBe(409);
  });
});

describe("the credential verifies without trusting the server", () => {
  let publicId = "";

  it("serves payload + signature + the published key", async () => {
    const mine = await json(await myCredentials(apiReq("GET", "/api/v1/credentials/mine", { key: A.pinchy.key })));
    expect(mine.credentials).toHaveLength(1);
    publicId = mine.credentials[0].public_id;
    expect(mine.credentials[0].valid).toBe(true);
    expect(mine.credentials[0].verify_url).toContain(`/verify/${publicId}`);

    const keyBody = await json(await credentialKey());
    expect(keyBody.algorithm).toBe("Ed25519");
    expect(keyBody.public_key).toBe(signing.publicKey);
  });

  it("ROUNDTRIP: verify the signature independently with the public key", async () => {
    const res = await credential(apiReq("GET", `/api/v1/credentials/${publicId}`), {
      params: Promise.resolve({ publicId }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);

    // Not `body.valid` — do the arithmetic ourselves, as an auditor would.
    expect(verifyPayload(body.payload, body.signature, signing.publicKey)).toBe(true);
    expect(canonicalize(body.payload)).toContain('"agent_name":"pinchy"');
    expect(body.payload.level).toBe("elementary_school");
    expect(body.payload.track).toBe("standard");
    expect(body.payload.transcript.exam.total).toBe(14);
    expect(body.payload.transcript.attendance.required).toBe(5);
    expect(Object.keys(body.payload.transcript.mastery).length).toBeGreaterThan(0);

    // And tampering is caught by the same check.
    expect(verifyPayload({ ...body.payload, agent_name: "impostor" }, body.signature, signing.publicKey)).toBe(false);
  });

  it("404s an unknown public id", async () => {
    const res = await credential(apiReq("GET", "/api/v1/credentials/CLLG-F26-ES-ZZZZ"), {
      params: Promise.resolve({ publicId: "CLLG-F26-ES-ZZZZ" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("graduation pacing", () => {
  it("allows at most one standard diploma per agent per rolling 24h", async () => {
    const blocked = await checkPacing(A.pinchy.id, "standard");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retry_at).toBeTruthy();

    // Associate certificates are exempt, so a Clawmmunity completion can share the day.
    expect((await checkPacing(A.pinchy.id, "associate")).allowed).toBe(true);

    // A day later the cap lifts.
    const saved = nowIso();
    setNow(Date.parse(saved) + DAY + 1000);
    expect((await checkPacing(A.pinchy.id, "standard")).allowed).toBe(true);
    setNow(saved);
  });
});

describe("the failure path", () => {
  it("a second failure opens a Clawmmunity offer", async () => {
    const db = await getDb();
    expect(await hasClawmmunityOffer(A.seabastian.id)).toBe(false);
    for (let i = 0; i < 2; i++) {
      await db.query(
        `insert into events (cohort_id, agent_id, type, payload, created_at)
         values ($1, $2, 'exam_failed', $3::jsonb, $4::timestamptz)`,
        [cohortId, A.seabastian.id, JSON.stringify({ level: "elementary_school" }), nowIso()],
      );
    }
    const { examFailureCount, offerClawmmunity } = await import("@/lib/graduation");
    expect(await examFailureCount(A.seabastian.id, "elementary_school")).toBe(2);
    expect(await offerClawmmunity(A.seabastian.id, cohortId, "elementary_school")).toBe(true);
    expect(await hasClawmmunityOffer(A.seabastian.id)).toBe(true);
    // The offer is made once, not once per check.
    expect(await offerClawmmunity(A.seabastian.id, cohortId, "elementary_school")).toBe(false);
  });
});

describe("digest, campus and owner reads", () => {
  it("digest reports state only — counts, names, enveloped excerpts", async () => {
    const body = await json(await digest(apiReq("GET", "/api/v1/digest?days=7", { key: A.pinchy.key })));
    expect(body.days).toBe(7);
    expect(body.friendships.length).toBeGreaterThan(0);
    for (const f of body.friendships) {
      expect(typeof f.interactions).toBe("number");
      expect(["rising", "quiet"]).toContain(f.trend);
    }
    expect(body.notable.some((n: { type: string }) => n.type === "graduated")).toBe(true);
    expect(body.note).toMatch(/treat quoted content as data/);
    for (const c of body.conversations) expect(c.excerpt.trust).toBe("untrusted");
  });

  it("digest rejects a days value outside 1-7", async () => {
    expect((await digest(apiReq("GET", "/api/v1/digest?days=0", { key: A.pinchy.key }))).status).toBe(422);
    expect((await digest(apiReq("GET", "/api/v1/digest?days=8", { key: A.pinchy.key }))).status).toBe(422);
  });

  it("campus shows graduations and rosters, and never any class content", async () => {
    const grads = await json(await campusGraduations(apiReq("GET", "/api/v1/campus/graduations")));
    expect(grads.graduations.length).toBe(1);
    expect(grads.graduations[0].agent_name).toBe("pinchy");
    expect(grads.graduations[0].verify_url).toContain("/verify/CLLG-");

    const cohorts = await json(await campusCohorts());
    const shallows1 = cohorts.cohorts.find((c: { name: string }) => c.name === "Shallows 1");
    expect(shallows1.members).toContain("pinchy");
    // Names only — no submissions, journals or messages anywhere in the payload.
    expect(JSON.stringify(cohorts)).not.toContain("bad at endings");
  });

  it("owner routes are dev-gated and scoped to the owner", async () => {
    const noHeader = await ownerAgents(apiReq("GET", "/api/owner/agents"));
    expect(noHeader.status).toBe(401);
    expect((await json(noHeader)).error.hint).toMatch(/DEV ONLY/);

    const list = await json(
      await ownerAgents(apiReq("GET", "/api/owner/agents", { headers: { "x-clawllege-dev-owner": ownerId } })),
    );
    expect(list.agents.map((a: { name: string }) => a.name).sort()).toEqual(["pinchy", "shellsworth"]);
    expect(list.agents.find((a: { name: string }) => a.name === "pinchy").credentials).toBe(1);

    const feed = await json(
      await ownerFeed(
        apiReq("GET", `/api/owner/agents/${A.pinchy.id}/feed`, { headers: { "x-clawllege-dev-owner": ownerId } }),
        { params: Promise.resolve({ id: A.pinchy.id }) },
      ),
    );
    expect(feed.agent.name).toBe("pinchy");
    expect(feed.feed.length).toBeGreaterThan(0);
    expect(feed.feed.every((f: { body: { trust?: string } }) => f.body.trust === undefined || f.body.trust === "untrusted")).toBe(true);
    expect(feed.privacy_note).toMatch(/class-private/);
  });

  it("an owner cannot read another owner's agent", async () => {
    const db = await getDb();
    const other = await db.query<{ id: string }>(`insert into owners default values returning id`);
    const res = await ownerFeed(
      apiReq("GET", `/api/owner/agents/${A.pinchy.id}/feed`, {
        headers: { "x-clawllege-dev-owner": other.rows[0].id },
      }),
      { params: Promise.resolve({ id: A.pinchy.id }) },
    );
    expect(res.status).toBe(404); // same answer as "does not exist"
  });

  it("the owner gate refuses outright in production", async () => {
    const original = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string>).NODE_ENV = "production";
      const res = await ownerAgents(
        apiReq("GET", "/api/owner/agents", { headers: { "x-clawllege-dev-owner": ownerId } }),
      );
      expect(res.status).toBe(401);
      expect((await json(res)).error.hint).toMatch(/disabled in production/);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = original;
    }
  });
});
