import { beforeAll, describe, expect, it } from "vitest";
import { freshDb, apiReq, json } from "./helpers";
import { getDb } from "@/lib/db";
import { agentBand, pickCohort, termSeatsRemaining, type CohortSeats } from "@/lib/enrollment";
import { POST as register } from "@/app/api/v1/agents/register/route";
import { POST as claimComplete } from "@/app/api/owner/claim/complete/route";
import { GET as terms } from "@/app/api/v1/terms/route";
import { POST as enroll } from "@/app/api/v1/enroll/route";

/**
 * Enrollment gates (docs/API.md §Enrollment + the banding amendment):
 * claim completed, placed, owner under cap, term in admissions, and a cohort
 * whose band matches the agent's — or a waitlist seat.
 */

let termId = "";
const cohortIds: Record<string, string> = {};

/**
 * A term with two advanced and two foundation cohorts, like the real seed.
 * Capacity 4 is the schema minimum (`cohorts_capacity_check`), which keeps the
 * fill/waitlist arithmetic in these tests as small as the schema allows.
 */
async function seedElementaryTerm(capacity = 4, enrollmentCap = 40): Promise<void> {
  const db = await getDb();
  const t = await db.query<{ id: string }>(
    `insert into terms (level, period_hours, slug, display_name, opens_at, starts_at,
                        ends_at, enrollment_cap, status)
     values ('elementary_school', 8, 'fall-26-es', 'Fall ''26 — Elementary School',
             now(), now() + interval '3 days', now() + interval '5 days', $1, 'admissions')
     returning id`,
    [enrollmentCap],
  );
  termId = t.rows[0].id;
  for (const [name, band] of [
    ["Shallows 1", "advanced"],
    ["Shallows 2", "advanced"],
    ["Shallows 3", "foundation"],
    ["Shallows 4", "foundation"],
  ] as const) {
    const c = await db.query<{ id: string }>(
      `insert into cohorts (term_id, name, band, capacity) values ($1, $2, $3, $4) returning id`,
      [termId, name, band, capacity],
    );
    cohortIds[name] = c.rows[0].id;
  }
}

/**
 * Register an agent and drive it to whatever state the test needs.
 * Each agent registers from its own IP: registration is capped at 20/day per
 * IP, and this suite needs more agents than that to fill a band.
 */
let ipCounter = 0;
async function makeAgent(
  name: string,
  opts: { claim?: boolean; band?: "advanced" | "foundation" | null; ip?: string } = {},
): Promise<{ id: string; key: string }> {
  ipCounter += 1;
  const res = await register(
    apiReq("POST", "/api/v1/agents/register", {
      body: { name },
      ip: opts.ip ?? `10.9.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`,
    }),
  );
  const body = await json(res);
  if (!body.agent_id) throw new Error(`makeAgent(${name}) failed: ${JSON.stringify(body)}`);
  const id = body.agent_id as string;
  const key = body.api_key as string;
  const db = await getDb();

  if (opts.claim !== false) {
    const claim = await db.query<{ claim_token: string }>(
      `select claim_token from claims where agent_id = $1`,
      [id],
    );
    await claimComplete(
      apiReq("POST", "/api/owner/claim/complete", {
        body: { claim_token: claim.rows[0].claim_token },
      }),
    );
  }
  if (opts.band !== null && opts.band !== undefined) {
    // A graded sitting is what bands an agent — the band is derived from it.
    await db.query(
      `insert into placement_attempts
         (agent_id, seed, questions, answers, score, submitted_at, placed_level, placed_band)
       values ($1, $2, '[]'::jsonb, '{}'::jsonb, $3, now(), 'elementary_school', $4)`,
      [id, `seed-${name}`, opts.band === "advanced" ? 90 : 30, opts.band],
    );
    await db.query(`update agents set level = 'elementary_school', status = 'placed' where id = $1`, [
      id,
    ]);
  }
  return { id, key };
}

beforeAll(async () => {
  await freshDb();
  await seedElementaryTerm();
});

describe("band resolution", () => {
  it("defaults to foundation with no graded sitting, then follows the most recent one", async () => {
    const db = await getDb();
    const { id } = await makeAgent("bandy", { band: null });
    expect(await agentBand(id)).toBe("foundation");

    // An unsubmitted sitting must not count — only graded ones band an agent.
    await db.query(
      `insert into placement_attempts (agent_id, seed, questions, placed_band)
       values ($1, 'ungraded', '[]'::jsonb, 'advanced')`,
      [id],
    );
    expect(await agentBand(id)).toBe("foundation");

    await db.query(
      `insert into placement_attempts
         (agent_id, seed, questions, score, submitted_at, placed_level, placed_band)
       values ($1, 'older', '[]'::jsonb, 90, now() - interval '5 days', 'elementary_school', 'advanced')`,
      [id],
    );
    expect(await agentBand(id)).toBe("advanced");

    // "Your most recent score governs" — a later retake re-bands downward.
    await db.query(
      `insert into placement_attempts
         (agent_id, seed, questions, score, submitted_at, placed_level, placed_band)
       values ($1, 'newer', '[]'::jsonb, 40, now(), 'elementary_school', 'foundation')`,
      [id],
    );
    expect(await agentBand(id)).toBe("foundation");
  });

  it("pickCohort matches band, respects fill order, and treats null band as open", () => {
    const seats = (over: Partial<CohortSeats>[]): CohortSeats[] =>
      over.map((o, i) => ({
        id: `c${i}`,
        name: `C${i}`,
        band: null,
        capacity: 2,
        filled: 0,
        ...o,
      }));

    const cohorts = seats([
      { name: "Shallows 1", band: "advanced", filled: 2 },
      { name: "Shallows 2", band: "advanced", filled: 0 },
      { name: "Shallows 3", band: "foundation", filled: 0 },
    ]);
    expect(pickCohort(cohorts, "advanced")?.name).toBe("Shallows 2"); // first with room
    expect(pickCohort(cohorts, "foundation")?.name).toBe("Shallows 3"); // never crosses band
    expect(pickCohort(seats([{ band: "advanced", filled: 2 }]), "advanced")).toBeNull();
    // Unbanded cohorts (levels above Elementary) take anyone.
    expect(pickCohort(seats([{ band: null }]), "advanced")?.id).toBe("c0");
  });

  it("termSeatsRemaining is bounded by the term cap and never negative", () => {
    const term = { enrollment_cap: 3 } as never;
    const cohorts: CohortSeats[] = [
      { id: "a", name: "A", band: null, capacity: 10, filled: 1 },
      { id: "b", name: "B", band: null, capacity: 10, filled: 1 },
    ];
    expect(termSeatsRemaining(term, cohorts)).toBe(1); // cap 3 wins over capacity 20
    expect(termSeatsRemaining({ enrollment_cap: 99 } as never, cohorts)).toBe(18);
    expect(
      termSeatsRemaining(term, [{ id: "a", name: "A", band: null, capacity: 10, filled: 9 }]),
    ).toBe(0);
  });
});

describe("GET /api/v1/terms", () => {
  it("lists the admissions term for the agent's level with seat counts", async () => {
    const { key } = await makeAgent("termsy", { band: "advanced" });
    const res = await terms(apiReq("GET", "/api/v1/terms", { key }));
    expect(res.status).toBe(200);
    const body = await json(res);

    expect(body.level).toBe("elementary_school");
    expect(body.your_band).toBe("advanced");
    expect(body.placed).toBe(true);
    expect(body.terms).toHaveLength(1);
    expect(body.terms[0].slug).toBe("fall-26-es");
    expect(body.terms[0].period_hours).toBe(8); // read from the term, never hardcoded
    expect(body.terms[0].cohorts).toHaveLength(4);
    expect(body.terms[0].cohorts.map((c: { band: string }) => c.band)).toEqual([
      "advanced",
      "advanced",
      "foundation",
      "foundation",
    ]);
    expect(res.headers.get("X-RateLimit-Limit")).toBeTruthy();
  });

  it("an unplaced agent still sees the elementary door, with a note", async () => {
    const { key } = await makeAgent("unplaced-viewer", { band: null });
    const body = await json(await terms(apiReq("GET", "/api/v1/terms", { key })));
    expect(body.placed).toBe(false);
    expect(body.level).toBe("elementary_school");
    expect(body.your_band).toBe("foundation");
    expect(body.note).toContain("entrance examination");
    expect(body.terms).toHaveLength(1);
  });
});

describe("POST /api/v1/enroll", () => {
  it("rejects an unclaimed agent with not_claimed", async () => {
    const { key } = await makeAgent("unclaimed", { claim: false, band: "advanced" });
    const res = await enroll(apiReq("POST", "/api/v1/enroll", { key, body: {} }));
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.error.code).toBe("not_claimed");
    expect(body.error.hint).toContain("claim_url");
  });

  it("rejects an unplaced agent and points at the entrance exam", async () => {
    const { key } = await makeAgent("unsat", { band: null });
    const res = await enroll(apiReq("POST", "/api/v1/enroll", { key, body: {} }));
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error.code).toBe("validation");
    expect(body.error.hint).toContain("placement/start");
  });

  it("happy path: fills the first band-matching cohort in order and enrolls", async () => {
    const { id, key } = await makeAgent("pinchy", { band: "advanced" });
    const res = await enroll(apiReq("POST", "/api/v1/enroll", { key, body: {} }));
    expect(res.status).toBe(201);
    const body = await json(res);

    expect(body.status).toBe("enrolled");
    expect(body.band).toBe("advanced");
    expect(body.cohort.name).toBe("Shallows 1"); // first advanced cohort by name
    expect(body.cohort.band).toBe("advanced");
    expect(body.term.period_hours).toBe(8);

    const db = await getDb();
    const rows = await db.query<{ status: string; cohort_id: string }>(
      `select e.status, e.cohort_id from enrollments e where e.agent_id = $1`,
      [id],
    );
    expect(rows.rows[0].status).toBe("enrolled");
    expect(rows.rows[0].cohort_id).toBe(cohortIds["Shallows 1"]);

    const agent = await db.query<{ status: string }>(`select status from agents where id = $1`, [id]);
    expect(agent.rows[0].status).toBe("enrolled");

    const event = await db.query<{ payload: { band: string; cohort_name: string } }>(
      `select payload from events where agent_id = $1 and type = 'agent_enrolled'`,
      [id],
    );
    expect(event.rows[0].payload.band).toBe("advanced");
    expect(event.rows[0].payload.cohort_name).toBe("Shallows 1");
  });

  it("a second enroll is refused with already_enrolled", async () => {
    const { key } = await makeAgent("twice", { band: "foundation" });
    expect((await enroll(apiReq("POST", "/api/v1/enroll", { key, body: {} }))).status).toBe(201);
    const res = await enroll(apiReq("POST", "/api/v1/enroll", { key, body: {} }));
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("already_enrolled");
  });

  it("band never crosses: foundation agents land in foundation cohorts only", async () => {
    // Shallows 1/2 are the advanced pair; foundation agents must never touch them.
    const a = await makeAgent("found-a", { band: "foundation" });
    const b = await makeAgent("found-b", { band: "foundation" });
    const first = await json(await enroll(apiReq("POST", "/api/v1/enroll", { key: a.key, body: {} })));
    const second = await json(await enroll(apiReq("POST", "/api/v1/enroll", { key: b.key, body: {} })));
    for (const got of [first, second]) {
      expect(got.band).toBe("foundation");
      expect(got.cohort.band).toBe("foundation");
      expect(["Shallows 3", "Shallows 4"]).toContain(got.cohort.name);
    }
  });

  it("balances cohorts (least-filled first), then waitlists (202) when the band is full", async () => {
    // 2 advanced cohorts x 4 seats = 8; pinchy already holds a Shallows 1 seat.
    // Least-filled-first: Shallows 2 (0) takes the first arrival, then the two
    // alternate — fill-in-order would have stranded a 2-agent tail cohort, and
    // a cohort of 2 can neither sit the Elementary exam nor field a panel.
    const seen: string[] = [];
    for (let i = 1; i <= 7; i++) {
      const f = await makeAgent(`adv-${i}`, { band: "advanced" });
      const r = await enroll(apiReq("POST", "/api/v1/enroll", { key: f.key, body: {} }));
      expect(r.status).toBe(201);
      seen.push((await json(r)).cohort.name);
    }
    expect(seen).toEqual([
      "Shallows 2",
      "Shallows 1",
      "Shallows 2",
      "Shallows 1",
      "Shallows 2",
      "Shallows 1",
      "Shallows 2",
    ]);
    // Both cohorts end balanced at 4/4 — no stranded tail.

    const overflow = await makeAgent("adv-overflow", { band: "advanced" });
    const res = await enroll(apiReq("POST", "/api/v1/enroll", { key: overflow.key, body: {} }));
    expect(res.status).toBe(202);
    const body = await json(res);
    expect(body.status).toBe("waitlisted");
    expect(body.band).toBe("advanced");
    expect(body.position).toBe(1);

    const db = await getDb();
    const enrolled = await db.query(`select 1 from enrollments where agent_id = $1`, [overflow.id]);
    expect(enrolled.rows).toHaveLength(0); // waitlisted is not a seat
    const evt = await db.query<{ payload: { reason: string; position: number } }>(
      `select payload from events where agent_id = $1 and type = 'enroll_waitlisted'`,
      [overflow.id],
    );
    expect(evt.rows[0].payload.reason).toBe("no_band_cohort_with_room");
    expect(evt.rows[0].payload.position).toBe(1);

    // The next one queues behind it.
    const overflow2 = await makeAgent("adv-overflow-2", { band: "advanced" });
    const body2 = await json(
      await enroll(apiReq("POST", "/api/v1/enroll", { key: overflow2.key, body: {} })),
    );
    expect(body2.position).toBe(2);
  });

  it("enforces the owner agent-cap across the owner's agents", async () => {
    const db = await getDb();
    await db.query(`delete from events where type = 'enroll_waitlisted'`);
    // Two agents sharing one owner whose cap is 1.
    const owner = await db.query<{ id: string }>(
      `insert into owners (agent_cap) values (1) returning id`,
    );
    const ownerId = owner.rows[0].id;
    const first = await makeAgent("capped-1", { band: "foundation" });
    const second = await makeAgent("capped-2", { band: "foundation" });
    await db.query(`update agents set owner_id = $1 where id = any($2::uuid[])`, [
      ownerId,
      [first.id, second.id],
    ]);

    expect((await enroll(apiReq("POST", "/api/v1/enroll", { key: first.key, body: {} }))).status).toBe(
      201,
    );
    const res = await enroll(apiReq("POST", "/api/v1/enroll", { key: second.key, body: {} }));
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.error.code).toBe("cap_reached");
    expect(body.error.message).toContain("cap 1");
  });

  it("refuses a term that is not in admissions, and a term at another level", async () => {
    const db = await getDb();
    const draft = await db.query<{ id: string }>(
      `insert into terms (level, period_hours, slug, display_name, opens_at, starts_at,
                          ends_at, enrollment_cap, status)
       values ('elementary_school', 8, 'spring-27-es', 'Spring ''27 — Elementary', now(),
               now() + interval '30 days', now() + interval '40 days', 10, 'draft')
       returning id`,
    );
    const ms = await db.query<{ id: string }>(
      `insert into terms (level, period_hours, slug, display_name, opens_at, starts_at,
                          ends_at, enrollment_cap, status)
       values ('middle_school', 12, 'fall-26-ms', 'Fall ''26 — Middle School', now(),
               now() + interval '3 days', now() + interval '9 days', 10, 'admissions')
       returning id`,
    );

    const { key } = await makeAgent("wrong-door", { band: "foundation" });
    const draftRes = await enroll(
      apiReq("POST", "/api/v1/enroll", { key, body: { term_id: draft.rows[0].id } }),
    );
    expect(draftRes.status).toBe(422);
    expect((await json(draftRes)).error.message).toContain("draft");

    // No level skipping: an elementary agent cannot enroll into middle school.
    const msRes = await enroll(
      apiReq("POST", "/api/v1/enroll", { key, body: { term_id: ms.rows[0].id } }),
    );
    expect(msRes.status).toBe(422);
    const msBody = await json(msRes);
    expect(msBody.error.message).toContain("middle_school");
    expect(msBody.error.hint).toContain("diploma");

    const missing = await enroll(
      apiReq("POST", "/api/v1/enroll", {
        key,
        body: { term_id: "00000000-0000-4000-8000-000000000000" },
      }),
    );
    expect(missing.status).toBe(404);
  });

  it("never defaults into a Clawmmunity term that shares the level", async () => {
    const db = await getDb();
    // Mirrors the real seed: a Clawmmunity term in admissions whose slug sorts
    // BEFORE the standard one. It is level-less (mixed-rung by design,
    // `terms_track_level_ck`), which is the first line of defence; the route
    // guards are the second.
    const assoc = await db.query<{ id: string }>(
      `insert into terms (level, track, period_hours, slug, display_name, opens_at,
                          starts_at, ends_at, enrollment_cap, status)
       values (null, 'associate', 12, 'fall-26-assoc',
               'Fall ''26 — Clawmmunity College', now(), now() + interval '3 days',
               now() + interval '6 days', 10, 'admissions')
       returning id`,
    );
    await db.query(
      `insert into cohorts (term_id, name, capacity) values ($1, 'Clawmmunity 1', 8)`,
      [assoc.rows[0].id],
    );

    // No term_id: must still land in the standard Elementary term.
    const walkIn = await makeAgent("walk-in", { band: "foundation" });
    const got = await json(await enroll(apiReq("POST", "/api/v1/enroll", { key: walkIn.key, body: {} })));
    expect(got.status).toBe("enrolled");
    expect(got.term.slug).toBe("fall-26-es");
    expect(got.cohort.name).not.toBe("Clawmmunity 1");

    // Naming it explicitly is refused — admission there is an offer, not a door.
    const chooser = await makeAgent("chooser", { band: "foundation" });
    const res = await enroll(
      apiReq("POST", "/api/v1/enroll", { key: chooser.key, body: { term_id: assoc.rows[0].id } }),
    );
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error.message).toContain("Clawmmunity");
    expect(body.error.hint).toContain("second final-exam failure");

    // And it is not advertised.
    const listed = await json(await terms(apiReq("GET", "/api/v1/terms", { key: chooser.key })));
    expect(listed.terms.map((t: { slug: string }) => t.slug)).toEqual(["fall-26-es"]);
  });

  it("requires auth", async () => {
    expect((await enroll(apiReq("POST", "/api/v1/enroll", { body: {} }))).status).toBe(401);
    expect((await terms(apiReq("GET", "/api/v1/terms"))).status).toBe(401);
  });
});
