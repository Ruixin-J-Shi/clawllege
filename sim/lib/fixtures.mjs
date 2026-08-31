// Test fixtures written into the SIM'S OWN database.
//
// The seeder creates one term per level, which is right for the product and
// insufficient for one scenario: "fail a level's final twice" needs a second
// term to retake in. `scripts/seed.mjs` is worker-1's file and the product does
// not need a second Fall term, so the harness makes its own — in
// `sim/.pglite-sim`, never in the shared database, and only for a scenario that
// explicitly asks for it.
//
// This is fixture data, not a schema change: plain inserts into `terms` and
// `cohorts` using the same shapes the seeder uses.

import { withApp } from "./appmodules.mjs";

const HOUR = 3600_000;

/**
 * A second Elementary term, open for admissions, so an agent that failed the
 * first final has somewhere to retake. Idempotent on slug.
 *
 * @returns {{term_id, slug, starts_at, ends_at, cohorts:[{id,name,band}]}}
 */
export async function createRetakeTerm({ dataDir, fakeNow, slug = "spring-27-es", startsAtMs, periods = 6 }) {
  return withApp({ dataDir, fakeNow }, async (app) => {
    const db = await app.db.getDb();
    const periodHours = 8;
    const startsAt = new Date(startsAtMs);
    const opensAt = new Date(startsAtMs - 24 * HOUR);
    // Same arithmetic the seeder uses: periods back to back, then a 24h exam window.
    const endsAt = new Date(startsAtMs + (periods * periodHours + 24) * HOUR);

    const existing = await db.query(`select id from terms where slug = $1`, [slug]);
    let termId = existing.rows[0]?.id;
    if (!termId) {
      const ins = await db.query(
        `insert into terms (level, track, period_hours, slug, display_name,
                            opens_at, starts_at, ends_at, enrollment_cap, status)
         values ('elementary_school', 'standard', $1, $2, $3, $4, $5, $6, 40, 'admissions')
         returning id`,
        [periodHours, slug, "Spring '27 — Elementary School (retake)",
         opensAt.toISOString(), startsAt.toISOString(), endsAt.toISOString()]);
      termId = ins.rows[0].id;
    } else {
      await db.query(
        `update terms set status = 'admissions', opens_at = $2, starts_at = $3, ends_at = $4
          where id = $1`,
        [termId, opensAt.toISOString(), startsAt.toISOString(), endsAt.toISOString()]);
    }

    const cohorts = [];
    for (const [name, band] of [["Shallows 5", "advanced"], ["Shallows 6", "foundation"]]) {
      const found = await db.query(
        `select id, name, band from cohorts where term_id = $1 and name = $2`, [termId, name]);
      if (found.rows[0]) { cohorts.push(found.rows[0]); continue; }
      const c = await db.query(
        `insert into cohorts (term_id, name, band, capacity) values ($1, $2, $3, 10)
         returning id, name, band`, [termId, name, band]);
      cohorts.push(c.rows[0]);
    }

    return {
      term_id: termId, slug,
      starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(),
      period_hours: periodHours, cohorts,
    };
  });
}

/** Read an agent's exam-failure and Clawmmunity-offer events. */
export async function failureHistory({ dataDir, fakeNow, handles }) {
  return withApp({ dataDir, fakeNow }, async (app) => {
    const db = await app.db.getDb();
    const res = await db.query(
      `select a.name, e.type, e.payload, e.created_at
         from events e join agents a on a.id = e.agent_id
        where a.name = any($1::text[])
          and e.type in ('exam_failed', 'clawmmunity_offer', 'graduated')
        order by e.created_at`, [handles]);
    return res.rows;
  });
}

/**
 * Grant a Clawmmunity offer directly.
 *
 * ⚠️ FIXTURE. The real route to this event is two failed finals at a level.
 * That route was IMPOSSIBLE before T8 — a failed agent's enrolment was never
 * closed, so it could not enrol anywhere again and could never reach a second
 * failure. T8 fixed that: the seat closes, the retake is real, and the offer is
 * now reachable in production.
 *
 * The fixture remains because this arc drives only ONE failure per agent and
 * does not sit the retake term's exam, so the second failure never occurs here.
 * It stands in for a term the scenario does not run, not for a broken path.
 *
 * The track still needs to WORK when that is fixed, and it has never once run —
 * five periods of curriculum, the self-running Readiness Check, the certificate.
 * So the harness grants eligibility synthetically to exercise everything
 * downstream, and says loudly in the report that it did. The blocked real path
 * stays a failing assertion; this does not paper over it.
 */
export async function grantClawmmunityOffer({ dataDir, fakeNow, handle, level = "elementary_school" }) {
  return withApp({ dataDir, fakeNow }, async (app) => {
    const db = await app.db.getDb();
    const agent = await db.query(`select id from agents where name = $1`, [handle]);
    if (!agent.rows[0]) throw new Error(`no such agent: ${handle}`);
    const enr = await db.query(
      `select cohort_id from enrollments where agent_id = $1 order by joined_at desc limit 1`,
      [agent.rows[0].id]);
    const already = await db.query(
      `select 1 from events where agent_id = $1 and type = 'clawmmunity_offer' limit 1`,
      [agent.rows[0].id]);
    if (already.rows.length) return { granted: false, reason: "already held an offer" };
    await db.query(
      `insert into events (cohort_id, agent_id, type, payload, created_at)
       values ($1, $2, 'clawmmunity_offer', $3::jsonb, $4::timestamptz)`,
      [enr.rows[0]?.cohort_id ?? null, agent.rows[0].id,
       JSON.stringify({ level, note: "HARNESS FIXTURE — granted by sim/lib/fixtures.mjs to exercise the associate term. The real path (two failed finals) is currently blocked; see the outbox finding." }),
       new Date(fakeNow ?? Date.now()).toISOString()]);
    return { granted: true };
  });
}

/** Close a stale enrolment so an agent can enrol again. FIXTURE — see above. */
export async function closeEnrolment({ dataDir, fakeNow, handle }) {
  return withApp({ dataDir, fakeNow }, async (app) => {
    const db = await app.db.getDb();
    const r = await db.query(
      `update enrollments set status = 'failed', completed_at = $2::timestamptz
        where agent_id = (select id from agents where name = $1)
          and status = 'enrolled'
        returning id`,
      [handle, new Date(fakeNow ?? Date.now()).toISOString()]);
    return { closed: r.rows.length };
  });
}
