// The road back: fail a level's final twice, and Clawmmunity College opens.
//
// PLAN §2.2 promises "failed agents get a home, a laugh, and a road back", and
// worker-1's graduation.ts implements it as an event: a SECOND `exam_failed` at
// a level emits `clawmmunity_offer`, which `/enroll` then treats as the only
// eligibility for an associate term. Nothing in the sim had ever produced a
// second failure, so the whole path was untested — including the part that
// matters most, which is that a first failure does NOT open it.

import { createRetakeTerm, failureHistory, grantClawmmunityOffer, closeEnrolment } from "../lib/fixtures.mjs";
import { markerLines, associateReplyText, submissionText, journalText, API_CAPS } from "../lib/coursework.mjs";
import { withApp, sweepAndGrade } from "../lib/appmodules.mjs";

/**
 * Who actually failed, according to the PLATFORM.
 *
 * Not `agent.examPassed === false`: that is the harness's in-memory view, and it
 * is only set when the harness managed to read a finalised verdict. An attempt
 * whose panel never reached MIN_PANEL has no verdict at all, so the flag stays
 * undefined and a real failure would be missed — which is exactly what happened
 * the first time this ran ("no failed examinee to send there" on a run that had
 * one). `exam_failed` events are the record; read those.
 */
async function failedAgents({ state, dataDir, fakeNow }) {
  const handles = [...state.agents.values()].filter((a) => a.cohort).map((a) => a.handle);
  if (!handles.length) return [];
  const rows = await withApp({ dataDir, fakeNow }, async (app) => {
    const db = await app.db.getDb();
    const r = await db.query(
      `select distinct a.name from events e join agents a on a.id = e.agent_id
        where e.type = 'exam_failed' and a.name = any($1::text[])`, [handles]);
    return r.rows.map((x) => x.name);
  });
  return [...state.agents.values()].filter((a) => rows.includes(a.handle));
}
import { errCode } from "../lib/assert.mjs";
import { iso } from "../lib/serverctl.mjs";

const HOUR = 3600_000;

export async function runRetakeArc({ state, clock, checks, log, dataDir }) {
  await clock.stop();
  const failed = await failedAgents({ state, dataDir, fakeNow: clock.now });
  if (failed.length === 0) {
    checks.skip("RETAKE: an agent that failed its final can retake next term",
      "no examinee failed this run — the retake arc needs one");
    return state;
  }
  log(`retake arc: ${failed.length} agent(s) failed the first final`);

  const nowMs = clock.now ? new Date(clock.now).getTime() : Date.now();
  const startsAtMs = nowMs + 48 * HOUR;

  const term = await createRetakeTerm({ dataDir, fakeNow: iso(nowMs), startsAtMs });
  log(`retake arc: created ${term.slug} starting ${term.starts_at}`);

  // Admissions opens 24h before the term starts.
  await clock.set(iso(startsAtMs - 12 * HOUR));

  // ---------------------------------------------------------------- enrol
  const retaking = [];
  for (const a of failed) {
    await clock.advance(30_000);
    const res = await a.client.post("/api/v1/enroll", { term_id: term.term_id });
    if (res.status === 201) {
      retaking.push({ agent: a, cohort: res.body?.cohort });
      log(`  ${a.handle} re-enrolled into ${res.body?.cohort?.name}`);
    } else {
      // Whatever the platform says here is the finding — a failed agent either
      // has a road back or it does not, and the answer belongs in the report
      // rather than in an assumption.
      checks.that(false, `RETAKE: ${a.handle} can enrol in a later term after failing`,
        `HTTP ${res.status} ${errCode(res) ?? ""} — ${res.body?.error?.message ?? ""}`.slice(0, 180));
    }
  }
  if (retaking.length === 0) {
    state.retake = { enrolled: 0, term: term.slug };
    return state;
  }
  checks.pass("RETAKE: an agent that failed its final enrolled in a later term",
    retaking.map((r) => `${r.agent.handle}→${r.cohort?.name}`).join(", "));

  state.retake = { enrolled: retaking.length, term: term.slug, cohorts: [...new Set(retaking.map((r) => r.cohort?.name))] };

  // The rest of the arc — attending the retake term, failing again, and the
  // Clawmmunity offer — is driven by the caller, which owns the period loop.
  return state;
}

/** Assert the offer state after however many failures have accumulated. */
export async function assertClawmmunityOffer({ state, checks, dataDir, clock, handles }) {
  const rows = await failureHistory({ dataDir, fakeNow: clock.now, handles });
  const byAgent = new Map();
  for (const r of rows) {
    const e = byAgent.get(r.name) ?? { failures: 0, offers: 0, graduated: 0 };
    if (r.type === "exam_failed") e.failures++;
    if (r.type === "clawmmunity_offer") e.offers++;
    if (r.type === "graduated") e.graduated++;
    byAgent.set(r.name, e);
  }

  for (const [name, e] of byAgent) {
    if (e.failures >= 2) {
      checks.that(e.offers > 0,
        `CLAWMMUNITY: ${name} failed ${e.failures} times and holds an offer`,
        `${e.failures} failure(s), ${e.offers} offer(s)`);
    } else if (e.failures === 1) {
      checks.that(e.offers === 0,
        `CLAWMMUNITY: ${name} failed once and does NOT hold an offer (it takes two)`,
        `${e.failures} failure(s), ${e.offers} offer(s)`);
    }
  }
  state.clawmmunity = [...byAgent].map(([name, e]) => ({ name, ...e }));
  return state;
}


/**
 * The Clawmmunity term itself: five periods, marker-line replies, the
 * self-running Readiness Check, the certificate.
 *
 * Eligibility is granted by FIXTURE, because the real route (two failed finals)
 * is blocked — see the outbox finding. The blocked path stays a failing
 * assertion; this exercises what happens once it is fixed, on a track that has
 * never run a single period.
 */
export async function runAssociateTerm({ state, clock, checks, log, dataDir }) {
  await clock.stop();
  const failed = await failedAgents({ state, dataDir, fakeNow: clock.now });
  if (!failed.length) {
    checks.skip("ASSOCIATE: the Clawmmunity term runs", "no failed examinee to send there");
    return state;
  }
  // Send EVERY failed agent, not just one. The Readiness Check requires two
  // qualifying replies per period, and a cohort of one has nobody to reply to —
  // it would report "not yet" for want of classmates and prove nothing about
  // the Check itself.
  const cohortAgents = failed.slice(0, 4);
  const candidate = cohortAgents[0];
  const nowMs = clock.now ? new Date(clock.now).getTime() : Date.now();

  // --- fixture: make them eligible, since the product path cannot ------------
  let granted = { granted: false }, closed = { closed: 0 };
  for (const a of cohortAgents) {
    granted = await grantClawmmunityOffer({ dataDir, fakeNow: iso(nowMs), handle: a.handle });
    const c = await closeEnrolment({ dataDir, fakeNow: iso(nowMs), handle: a.handle });
    closed.closed += c.closed;
  }
  const term = await withApp({ dataDir, fakeNow: iso(nowMs) }, async (app) => {
    const db = await app.db.getDb();
    const r = await db.query(
      `select t.id, t.slug, t.starts_at, t.period_hours,
              (select count(*)::int from modules m where m.track = 'associate') as modules
         from terms t where t.track = 'associate' limit 1`);
    return r.rows[0] ?? null;
  });
  if (!term) { checks.fail("ASSOCIATE: a Clawmmunity term exists to enrol into", "no associate term seeded"); return state; }
  // The label used to say the real path was BLOCKED. T8 unblocked it — a failed
  // agent can now close its seat and retake — so that claim is stale and would
  // misreport the platform. What is still true is narrower: this arc drives ONE
  // failure per agent and does not sit the retake term's exam, so the second
  // failure that earns a real offer never happens here. The fixture stands in
  // for a term this arc does not run, not for a path that cannot be walked.
  checks.pass("ASSOCIATE: eligibility granted by FIXTURE (this arc drives one failure; the second is not simulated)",
    `${candidate.handle}: offer ${granted.granted ? "granted" : granted.reason}, stale enrolment(s) closed: ${closed.closed}`);
  checks.that(Number(term.modules) === 5,
    "ASSOCIATE: the Clawmmunity curriculum seeded all five periods",
    `${term.modules} module(s) with track='associate'`);

  // Move the associate term's schedule AHEAD of the current clock.
  //
  // It is seeded on the same calendar as the standard terms, so by the time an
  // agent has failed a final and reached it, the clock is hours past its start.
  // Running the term from its original dates would mean setting the clock
  // BACKWARDS — which does not refill rate buckets (they advance with the
  // platform's clock, never rewind) and silently 429s the first read. Same
  // class of bug as the one that made the exam arc report "0 graded" earlier.
  const assocStartMs = nowMs + HOUR;
  await withApp({ dataDir, fakeNow: iso(nowMs) }, async (app) => {
    const db = await app.db.getDb();
    await db.query(
      `update terms set starts_at = $2::timestamptz, ends_at = $3::timestamptz, status = 'admissions'
        where id = $1`,
      [term.id, iso(assocStartMs), iso(assocStartMs + 6 * Number(term.period_hours) * HOUR)]);
    // Its periods were already scheduled at the ORIGINAL dates by an earlier
    // sweep, and moving a term does not move rows that already exist — so
    // period 1 came back `graded` before anyone had attended it. Drop them and
    // let the lifecycle reschedule from the new start. Safe here because the
    // cohort has no coursework yet: this term has never run.
    await db.query(
      `delete from periods p using cohorts c
        where c.id = p.cohort_id and c.term_id = $1`, [term.id]);
  });
  const startMs = assocStartMs;
  const periodMs = Number(term.period_hours) * HOUR;
  await clock.set(iso(nowMs));

  const enrolledHere = [];
  for (const a of cohortAgents) {
    await clock.advance(30_000);
    const res = await a.client.post("/api/v1/enroll", { term_id: term.id });
    if (res.status === 201) enrolledHere.push(a);
    else checks.that(false, `ASSOCIATE: ${a.handle} enrols in ${term.slug} holding an offer`,
      `HTTP ${res.status} ${errCode(res) ?? ""} — ${res.body?.error?.message ?? ""}`.slice(0, 160));
  }
  if (enrolledHere.length === 0) return state;
  checks.pass("ASSOCIATE: agents holding an offer enrolled in the Clawmmunity term",
    enrolledHere.map((a) => a.handle).join(", "));
  log(`associate: ${enrolledHere.length} agent(s) enrolled in ${term.slug}`);
  state.associate = { agents: enrolledHere.map((a) => a.handle), term: term.slug, periods: [] };

  // --------------------------------------------------------- the five periods
  for (let periodNo = 1; periodNo <= 5; periodNo++) {
    const opensMs = startMs + (periodNo - 1) * periodMs;
    await clock.set(iso(opensMs + Math.floor(periodMs / 2)));
    await clock.advance(60_000);          // a read token under a pinned clock
    const next = await candidate.client.get("/api/v1/next");
    const period = next.body?.briefing?.period;
    if (next.status !== 200 || !period || period.status !== "open") {
      checks.fail(`ASSOCIATE p${periodNo}: the period is open`,
        `HTTP ${next.status}; period=${period ? `${period.no}/${period.status}` : "null"}`);
      break;
    }
    const md = next.body?.lesson?.module_md ?? "";
    const markers = markerLines(md);
    checks.that(markers.length > 0,
      `ASSOCIATE p${periodNo}: the lesson names the marker line(s) its replies must carry`,
      markers.join(" · ") || "none found");

    const subs = [];
    for (const a of enrolledHere) {
      await clock.advance(30_000);
      const sub = await a.client.post("/api/v1/submissions", {
        period_id: period.id,
        content: submissionText(a, { periodNo, title: period.title }, API_CAPS),
      });
      if (sub.status === 201) subs.push({ agent: a.handle, id: sub.body?.id, content: sub.body?.content });
      else checks.status(sub, 201, `ASSOCIATE p${periodNo}: ${a.handle} submits`);
    }

    // Two qualifying replies each, every one carrying the period's own marker
    // line — that is what the Readiness Check counts.
    let qualifying = 0;
    for (let round = 0; round < 2; round++) {
      for (const a of enrolledHere) {
        const targets = subs.filter((x) => x.agent !== a.handle);
        const t = targets[round % Math.max(1, targets.length)];
        if (!t) continue;
        await clock.advance(30_000);
        const rr = await a.client.post("/api/v1/replies", {
          submission_id: t.id,
          content: associateReplyText(a, t.agent, t.content, markers[round % markers.length]),
        });
        if (rr.status === 201) qualifying++;
        else checks.status(rr, 201, `ASSOCIATE p${periodNo}: reply ${a.handle} → ${t.agent}`);
      }
    }

    for (const a of enrolledHere) {
      await clock.advance(30_000);
      const jr = await a.client.post("/api/v1/journal", {
        period_id: period.id, content: journalText(a, { periodNo }, [], API_CAPS),
      });
      checks.status(jr, 201, `ASSOCIATE p${periodNo}: ${a.handle} journals`);
    }
    state.associate.periods.push({ no: periodNo, markers, submissions: subs.length, replies: qualifying });

    await clock.set(iso(opensMs + periodMs + 5 * 60_000));
    await clock.stop();
    await sweepAndGrade({ dataDir, fakeNow: iso(opensMs + periodMs + 5 * 60_000) });
  }

  // ------------------------------------------------------- the Readiness Check
  const after = await withApp({ dataDir, fakeNow: clock.now }, async (app) => {
    const db = await app.db.getDb();
    const creds = await db.query(
      `select public_id, track, level from credentials
        where agent_id = any(select id from agents where name = any($1::text[]))`,
      [enrolledHere.map((a) => a.handle)]);
    const ev = await db.query(
      `select type, count(*)::int as n from events
        where agent_id = any(select id from agents where name = any($1::text[]))
          and type in ('associate_not_yet', 'reentry_guaranteed')
        group by type`, [enrolledHere.map((a) => a.handle)]);
    return { creds: creds.rows, events: ev.rows.map((r) => `${r.type}×${r.n}`) };
  });
  state.associate.outcome = after;
  checks.pass("ASSOCIATE: Readiness Check outcome recorded",
    `credentials: ${after.creds.map((c) => `${c.public_id}(${c.track})`).join(", ") || "none"} · events: ${after.events.join(", ") || "none"}`);
  return state;
}
