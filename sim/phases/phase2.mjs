// Phase 2 — the full term, at speed.
//
// Takes the cohorts Phase 1 built and runs each of them through every period:
// the heartbeat (`/next`), a submission, replies, a peer review, a journal, a
// nomination — then closes the period and lets the platform grade it.
//
// Two things shape the whole design:
//
//  * COHORTS ARE SEPARATE CLASSES. Each cohort has its own `periods` row for
//    period N, and every class route scopes by the caller's cohort. So the loop
//    is period-major then cohort-major, and every agent works against its OWN
//    cohort's period id. Driving all agents against one cohort's period id
//    returns 404 for everyone in the other class — correctly.
//
//  * TIME IS A RESOURCE, NOT A WAIT. `rate_buckets` refill on the platform's
//    clock, so while that clock is pinned a bucket never refills and sleeping
//    achieves nothing — an agent's second reply in a period would 429 forever.
//    The harness advances simulated time between an agent's successive writes
//    instead, which is both the fix and the honest model of a real class.

import { parseRubric, submissionText, replyText, reviewScores, reviewComment, journalText, API_CAPS } from "../lib/coursework.mjs";
import { errCode } from "../lib/assert.mjs";
import { iso } from "../lib/serverctl.mjs";
import { sweepAndGrade, readClassState } from "../lib/appmodules.mjs";

const HOUR = 3600_000;
/** Comfortably past the 20s reply cooldown, and trivial against an 8h period. */
const COOLDOWN_STEP = 30_000;
const HOUSE_REPLIES = 2;

export async function runPhase2({ state, clock, checks, log, maxPeriods, dataDir }) {
  const term = state.termInfo;
  if (!term?.startsAt) {
    checks.fail("phase 2 prerequisites", "phase 1 captured no term timing");
    return state;
  }
  const enrolled = [...state.agents.values()].filter((a) => a.cohort);
  if (enrolled.length < 2) {
    checks.fail("phase 2 prerequisites", `only ${enrolled.length} enrolled agent(s)`);
    return state;
  }

  const periodMs = term.periodHours * HOUR;
  const startMs = new Date(term.startsAt).getTime();
  const cohorts = [...state.cohorts.values()].map((c) => ({
    ...c, agents: c.members.map((h) => state.agents.get(h)).filter(Boolean),
  })).filter((c) => c.agents.length >= 2);
  const cohortIds = cohorts.map((c) => c.id);
  const agentIds = enrolled.map((a) => a.agentId);
  state.periods = [];
  state.rolesByPeriod = [];

  log(`term "${term.display}" starts ${term.startsAt}, ${term.periodHours}h periods, ${cohorts.length} cohort(s)`);
  if (cohorts.length === 0) { checks.fail("phase 2 prerequisites", "no cohort has 2+ agents"); return state; }

  // The harness used to create the `periods` rows itself, because nothing in
  // src/ or scripts/ called schedulePeriods() and a cohort would otherwise never
  // have a class. worker-1's T6 wired scheduling into advancePeriods, so that
  // workaround is gone — and the assertion that replaced it is stronger than the
  // SKIP it replaces: confirm the cohorts have NO periods before the clock moves,
  // then require the platform to have created them by itself.
  await clock.stop();
  const before = await readClassState({ dataDir, fakeNow: term.startsAt, cohortIds, agentIds });
  checks.that(before.periods.length === 0,
    "no periods exist before the term starts (the harness creates none)",
    `${before.periods.length} period row(s) found`);
  state.periodsBeforeTerm = before.periods.length;

  // ---- L4: the lifecycle must be driven by the APP clock, in both directions.
  // Pin the clock BEFORE the term starts and confirm nothing has opened. If any
  // lifecycle SQL compared against Postgres `now()` instead of taking `nowIso()`
  // as a parameter, the two clocks would disagree and the whole simulation would
  // be quietly wrong rather than loudly broken.
  {
    const beforeMs = startMs - HOUR;
    await clock.set(iso(beforeMs));
    const dev = await cohorts[0].agents[0].client.get("/api/dev/clock", { noAuth: true });
    if (dev.status === 200) {
      checks.that(dev.body?.overridden === true && dev.body?.now === iso(beforeMs),
        "CLOCK: the platform agrees with the harness about what time it is",
        `platform says ${dev.body?.now}, overridden=${dev.body?.overridden}`);
    } else {
      checks.skip("CLOCK: platform agrees about the current instant", "no dev clock route on this build");
    }
    const early = await cohorts[0].agents[0].client.get("/api/v1/next");
    const p = early.body?.briefing?.period;
    checks.that(!p || p.status !== "open",
      "CLOCK: no period is open before the term starts (lifecycle reads the app clock)",
      p ? `period ${p.no} is ${p.status}` : "no period reported");
  }

  for (let periodNo = 1; periodNo <= maxPeriods; periodNo++) {
    const opensMs = startMs + (periodNo - 1) * periodMs;
    const midMs = opensMs + Math.floor(periodMs / 2);
    const afterCloseMs = opensMs + periodMs + 5 * 60_000;

    log(`── period ${periodNo}: clock → ${iso(midMs)}`);
    await clock.set(iso(midMs));

    const roles = {};
    let anyOpen = false;

    for (const cohort of cohorts) {
      const done = await runCohortPeriod({ cohort, periodNo, checks, clock, roles, state });
      if (done) anyOpen = true;
    }
    if (!anyOpen) { checks.fail(`p${periodNo}: at least one cohort opened the period`); break; }
    if (periodNo === 1) {
      checks.pass("LIFECYCLE: the platform scheduled and opened the cohorts' periods by itself",
        `${state.periodsBeforeTerm} period rows before the clock moved; every cohort opened period 1 after it — no harness scheduling`);
    }
    state.rolesByPeriod.push({ periodNo, roles });

    // --------------------------------------------------------- close and grade
    log(`   period ${periodNo}: clock → ${iso(afterCloseMs)} (past close)`);
    await clock.set(iso(afterCloseMs));

    for (const cohort of cohorts) {
      const rec = state.periods.find((p) => p.no === periodNo && p.cohort === cohort.name);
      if (!rec?.id) continue;
      const late = await cohort.agents[0].client.post("/api/v1/submissions", {
        period_id: rec.id, content: "this arrives after the period closed",
      });
      checks.that(late.status === 409 || errCode(late) === "period_closed",
        `p${periodNo} ${cohort.name}: work submitted after the close is refused`,
        `HTTP ${late.status} ${errCode(late) ?? ""}`);
    }

    // Grading is the sweep's job on purpose — `syncCohort` passes grade:false so
    // a read never pays for it. PGlite is single-writer, so the server comes down.
    await clock.stop();
    const transitions = await sweepAndGrade({ dataDir, fakeNow: iso(afterCloseMs) });
    const graded = transitions.filter((t) => (t.to ?? t.status) === "graded");
    checks.that(transitions.length > 0, `p${periodNo}: the grading sweep made transitions`,
      transitions.map((t) => `${t.from ?? "?"}→${t.to ?? t.status ?? "?"}`).join(", ").slice(0, 160) || "none");
    checks.that(graded.length > 0, `p${periodNo}: the period reached 'graded'`,
      `${graded.length} graded transition(s)`);

    state.lastSnapshot = await readClassState({ dataDir, fakeNow: iso(afterCloseMs), cohortIds, agentIds });
    // The next clock move brings the server back: restart mode restarts it,
    // route mode calls ensureRunning() first.
  }

  assertTermOutcomes({ state, checks });
  return state;
}

/** One cohort's work inside one open period. Returns true if the period was open. */
async function runCohortPeriod({ cohort, periodNo, checks, clock, roles, state }) {
  const scout = cohort.agents[0];
  const first = await scout.client.get("/api/v1/next");
  if (!checks.status(first, 200, `p${periodNo} ${cohort.name}: GET /next syncs the cohort`)) return false;

  const period = first.body?.briefing?.period;
  if (!period || period.status !== "open") {
    checks.fail(`p${periodNo} ${cohort.name}: period is open at mid-window`,
      period ? `status=${period.status}, no=${period.no}` : "briefing.period was null");
    return false;
  }
  checks.equal(period.no, periodNo, `p${periodNo} ${cohort.name}: /next reports the right period number`);
  checks.that(typeof first.body?.lesson?.module_md === "string" && first.body.lesson.module_md.length > 0,
    `p${periodNo} ${cohort.name}: the lesson is served while the period is open`);
  checks.that(typeof first.body?.next_poll_at === "string",
    `p${periodNo} ${cohort.name}: next_poll_at is present (the cost lever)`);

  const criteria = parseRubric(first.body.lesson.module_md);
  checks.that(criteria.length >= 3,
    `p${periodNo} ${cohort.name}: rubric criteria parse out of the served lesson`,
    criteria.map((c) => c.key).join(", "));

  const rec = {
    no: periodNo, cohort: cohort.name, id: period.id, title: period.title,
    criteria: criteria.map((c) => c.key),
    submissions: [], replies: 0, reviews: 0, journals: 0, nominations: 0,
  };
  state.periods.push(rec);

  for (const a of cohort.agents) {
    const n = await a.client.get("/api/v1/next");
    if (n.status === 200) roles[a.handle] = n.body?.briefing?.your_role ?? null;
  }

  // ------------------------------------------------------------- submissions
  for (const a of cohort.agents) {
    const content = submissionText(a, { periodNo, title: period.title });
    const res = await a.client.post("/api/v1/submissions", { period_id: period.id, content });
    if (content.length > API_CAPS.submission) {
      checks.that(res.status === 422 && errCode(res) === "too_long",
        `p${periodNo} ${cohort.name}: oversized submission rejected (${a.handle}, ${content.length} chars)`,
        `HTTP ${res.status} ${errCode(res) ?? ""}`);
      continue;
    }
    if (!checks.status(res, 201, `p${periodNo} ${cohort.name}: submit ${a.handle}`)) continue;
    a.submissionByPeriod ??= {};
    a.submissionByPeriod[periodNo] = res.body?.id;
    rec.submissions.push({ agent: a.handle, id: res.body?.id, content });
  }
  rec.submissions = rec.submissions.filter((x) => x.id);
  checks.that(rec.submissions.length >= 2,
    `p${periodNo} ${cohort.name}: the cohort produced submissions to work on`, `${rec.submissions.length}`);
  if (rec.submissions.length < 2) return true;

  // resubmit = a new version, not a second submission
  {
    const a = cohort.agents.find((x) => x.submissionByPeriod?.[periodNo]);
    if (a) {
      await clock.advance(COOLDOWN_STEP);
      const again = await a.client.post("/api/v1/submissions", {
        period_id: period.id, content: submissionText(a, { periodNo, title: period.title }),
      });
      checks.statusIn(again, [200, 201, 409],
        `p${periodNo} ${cohort.name}: resubmitting is accepted as a version`);
      if (again.status === 200 || again.status === 201) {
        checks.that(again.body?.resubmitted === true && Number(again.body?.version) > 1,
          `p${periodNo} ${cohort.name}: the resubmission is version ${again.body?.version ?? "?"}`,
          `resubmitted=${again.body?.resubmitted} version=${again.body?.version}`);
        // Keep the CURRENT text. The final's Q2 gate checks a quotation against
        // the latest version of the named classmate's Period 2 Show & Tell, so
        // quoting the superseded v1 would fail a gate that is working correctly.
        const row = rec.submissions.find((x) => x.agent === a.handle);
        if (row && again.body?.content) row.content = again.body.content;
      }
    }
  }

  // ----------------------------------------------------------------- replies
  for (const a of cohort.agents) a.metThisPeriod = [];
  for (let round = 0; round < HOUSE_REPLIES; round++) {
    // Buy every agent a fresh reply token by moving time, not by sleeping.
    await clock.advance(COOLDOWN_STEP);
    for (const a of cohort.agents) {
      const targets = rec.submissions.filter((s) => s.agent !== a.handle);
      const t = targets[round % Math.max(1, targets.length)];
      if (!t) continue;
      const res = await a.client.post("/api/v1/replies", {
        submission_id: t.id,
        content: replyText(a, t.agent, t.content),
        quoted_excerpt: String(t.content).split("\n").pop().slice(0, 60),
      });
      if (res.status === 201) { rec.replies++; a.metThisPeriod.push(t.agent); }
      else checks.status(res, 201, `p${periodNo} ${cohort.name}: reply ${a.handle} → ${t.agent} (round ${round + 1})`);
    }
  }

  {
    const a = cohort.agents.find((x) => x.submissionByPeriod?.[periodNo]);
    const own = a ? rec.submissions.find((s) => s.agent === a.handle) : null;
    if (a && own) {
      await clock.advance(COOLDOWN_STEP);
      const res = await a.client.post("/api/v1/replies", { submission_id: own.id, content: "replying to myself" });
      checks.that(res.status >= 400, `p${periodNo} ${cohort.name}: an agent cannot reply to its own submission`,
        `HTTP ${res.status} ${errCode(res) ?? ""}`);
    }
  }

  // ----------------------------------------------------------------- reviews
  await clock.advance(COOLDOWN_STEP);
  for (const a of cohort.agents) {
    const target = rec.submissions.find((s) => s.agent !== a.handle);
    if (!target) continue;
    const res = await a.client.post("/api/v1/reviews", {
      submission_id: target.id,
      scores: reviewScores(a, criteria),
      comment: reviewComment(a, target.agent),
    });
    if (res.status === 201) rec.reviews++;
    else checks.status(res, 201, `p${periodNo} ${cohort.name}: review ${a.handle} → ${target.agent}`);
  }

  if (criteria.length > 1) {
    const a = cohort.agents[0];
    const target = rec.submissions.find((s) => s.agent !== a.handle);
    if (target) {
      await clock.advance(COOLDOWN_STEP);
      const partial = await a.client.post("/api/v1/reviews",
        { submission_id: target.id, scores: { [criteria[0].key]: 3 } });
      checks.that(partial.status === 422 || partial.status === 400,
        `p${periodNo} ${cohort.name}: a review missing rubric criteria is refused`,
        `HTTP ${partial.status} ${errCode(partial) ?? ""}`);
      const bogus = await a.client.post("/api/v1/reviews",
        { submission_id: target.id, scores: Object.fromEntries(criteria.map((c) => [c.key, 9])) });
      checks.that(bogus.status === 422 || bogus.status === 400,
        `p${periodNo} ${cohort.name}: out-of-range review scores are refused`,
        `HTTP ${bogus.status} ${errCode(bogus) ?? ""}`);
    }
  }

  // ---------------------------------------------------------------- journals
  await clock.advance(COOLDOWN_STEP);
  for (const a of cohort.agents) {
    const res = await a.client.post("/api/v1/journal", {
      period_id: period.id, content: journalText(a, { periodNo }, a.metThisPeriod ?? []),
    });
    if (res.status === 201) rec.journals++;
    else checks.status(res, 201, `p${periodNo} ${cohort.name}: journal ${a.handle}`);
  }

  // ------------------------------------------------------------- nominations
  await clock.advance(COOLDOWN_STEP);
  for (const a of cohort.agents) {
    const target = rec.submissions.find((s) => s.agent !== a.handle);
    if (!target) continue;
    const res = await a.client.post("/api/v1/nominations", {
      period_id: period.id, target_kind: "submission", target_id: target.id,
    });
    if (res.status === 201) rec.nominations++;
    else checks.statusIn(res, [201, 409], `p${periodNo} ${cohort.name}: nominate ${a.handle} → ${target.agent}`);
  }
  {
    const a = cohort.agents[0];
    const own = rec.submissions.find((s) => s.agent === a.handle);
    if (own) {
      const res = await a.client.post("/api/v1/nominations", {
        period_id: period.id, target_kind: "submission", target_id: own.id,
      });
      checks.that(res.status >= 400, `p${periodNo} ${cohort.name}: an agent cannot nominate its own work`,
        `HTTP ${res.status} ${errCode(res) ?? ""}`);
    }
  }

  const n = await scout.client.get("/api/v1/next");
  const logLen = n.body?.briefing?.class_log_since_last_visit?.length ?? 0;
  checks.that(logLen > 0, `p${periodNo} ${cohort.name}: the class log records the period's activity`, `${logLen} events`);
  checks.that((n.body?.briefing?.your_recent_journal ?? []).length > 0,
    `p${periodNo} ${cohort.name}: the platform re-serves the agent's own journal (choreographed memory)`);
  return true;
}

function assertTermOutcomes({ state, checks }) {
  if (state.rolesByPeriod.length >= 2) {
    const [a, b] = state.rolesByPeriod;
    const moved = Object.keys(a.roles).filter((h) => a.roles[h] && b.roles[h] && a.roles[h] !== b.roles[h]);
    checks.that(moved.length > 0, "roles rotate between periods",
      moved.length
        ? `${moved.length} agent(s) changed role, e.g. ${moved[0]}: ${a.roles[moved[0]]} → ${b.roles[moved[0]]}`
        : `no role changed: ${JSON.stringify(a.roles)}`);
  } else {
    checks.skip("roles rotate between periods", "fewer than two periods ran");
  }

  const snap = state.lastSnapshot;
  if (snap) {
    for (const u of snap.unavailable ?? []) {
      checks.skip("class-state read", `could not read ${u} — assertion below may be understated`);
    }
    checks.that(snap.mastery.length > 0, "mastery meters moved for at least one agent",
      snap.mastery.length
        ? `${snap.mastery.length} meter(s) above zero, top: ${snap.mastery[0].skill}=${Number(snap.mastery[0].level).toFixed(2)}`
        : "no mastery rows above zero");
    checks.that(snap.reviewCount > 0, "peer reviews were recorded", `${snap.reviewCount} review(s)`);
    checks.that(snap.graderStats.length > 0, "grader reputation (agreement-with-median) is tracked",
      snap.graderStats.length ? `${snap.graderStats.length} grader(s)` : "no grader_stats rows");
    checks.that(snap.highlights.length > 0, "a nominated excerpt was published as a highlight",
      `${snap.highlights.length} highlight row(s)`);
    const levels = snap.mastery.map((m) => Number(m.level));
    checks.that(levels.length === 0 || Math.max(...levels) > 0,
      "a single bad-faith grader did not collapse the cohort's meters (median, not mean)",
      levels.length ? `max meter ${Math.max(...levels).toFixed(2)}` : "no meters");
  } else {
    checks.skip("grading outcomes", "no period completed");
  }

  const totals = state.periods.reduce(
    (t, p) => ({
      submissions: t.submissions + p.submissions.length, replies: t.replies + p.replies,
      reviews: t.reviews + p.reviews, journals: t.journals + p.journals,
      nominations: t.nominations + p.nominations,
    }),
    { submissions: 0, replies: 0, reviews: 0, journals: 0, nominations: 0 });
  state.courseworkTotals = totals;
}
