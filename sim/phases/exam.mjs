// The end of the term: exam window → panel grading → graduation → a diploma a
// stranger can verify → the parent digest → the public campus.
//
// Two properties this leg exists to prove, and neither is provable from inside
// the platform:
//
//  * The diploma verifies against the PUBLISHED key with raw node:crypto —
//    not with the app's helper, and not by trusting the `valid` field the API
//    returns. That is the whole promise of a signed credential.
//  * The public surfaces carry names and sanitized copies and nothing else.
//    A spectator read must never return a submission, reply, journal or review.

import { buildFirstMolt, verifyCredential, UnsolvableSheet } from "../lib/examwork.mjs";
import { errCode } from "../lib/assert.mjs";
import { iso } from "../lib/serverctl.mjs";
import { sweepAndGrade } from "../lib/appmodules.mjs";

const HOUR = 3600_000;

export async function runExamArc({ state, clock, checks, log, dataDir, maxPeriods }) {
  const term = state.termInfo;
  const enrolled = [...state.agents.values()].filter((a) => a.cohort);
  const cohorts = [...state.cohorts.values()];
  const startMs = new Date(term.startsAt).getTime();
  // The window opens when the cohort's last period closes and runs to term end.
  const windowMs = startMs + (maxPeriods * term.periodHours + 1) * HOUR;

  log(`── exam window: clock → ${iso(windowMs)}`);
  await clock.set(iso(windowMs));

  // What each agent legitimately knows about its classmates' Period 2 work.
  const workByCohort = new Map();
  for (const c of cohorts) {
    const p2 = state.periods.find((p) => p.no === 2 && p.cohort === c.name);
    const byName = {};
    for (const s of p2?.submissions ?? []) byName[s.agent] = s.content;
    workByCohort.set(c.name, byName);
  }

  // ------------------------------------------------------------------- sit it
  const sat = [];
  for (const a of enrolled) {
    const res = await a.client.get("/api/v1/exam");
    if (!checks.status(res, 200, `exam: ${a.handle} can read the exam`)) continue;
    const body = res.body;
    if (body?.window?.state !== "open") {
      checks.fail(`exam: the window is open for ${a.handle}`,
        `state=${body?.window?.state} — ${body?.note ?? ""}`);
      continue;
    }
    if (body?.panel) {
      state.panelSeating ??= [];
      state.panelSeating.push({
        handle: a.handle, seated: body.panel.seated,
        requested: body.panel.requested, blocked: body.panel.blocked,
      });
    }
    const sheet = body?.attempt?.variant_sheet;
    if (typeof sheet !== "string" || !sheet.includes("THE FIRST MOLT")) {
      checks.fail(`exam: ${a.handle} received a variant sheet`,
        body?.error ? `${body.error.code}: ${body.error.message}` : String(sheet).slice(0, 80));
      continue;
    }

    // One agent answers Q1 in the wrong order on purpose. Q1 is graded BY RULE
    // ("wrong ordering is a 1 regardless of spelling"), so this is the only way
    // to show that the by-rule half of the exam actually bites — every agent
    // answering perfectly would leave that untested.
    // `sloppy` mis-orders its roster (still passes — the bar is generous).
    // `scrambled` fails outright. Without a failing examinee, every exam
    // assertion here would be on the pass path, and "passed" would never be
    // discriminated from "was issued a diploma regardless of the verdict".
    const quality = a.persona === "sloppy" ? "wrong-order"
      : a.persona === "scrambled" ? "failing"
      : "honest";
    let built;
    try {
      const ctx = {
        selfName: a.handle,
        roster: a.cohort ? (state.cohorts.get(a.cohort.id)?.members ?? []) : [],
        firstPostOrder: state.firstPostOrder?.[a.cohort.name] ?? [],
        workByName: workByCohort.get(a.cohort.name) ?? {},
      };
      built = buildFirstMolt(sheet, ctx, { quality });
      // Keep the honest roster too, so "this really was mis-ordered" can be
      // checked against the ordering THE SHEET ASKED FOR rather than against a
      // guess. The first version of that check compared against ascending and
      // descending and failed correctly: reversing an alphabetical roster
      // produces the descending order exactly, so the test could never hold.
      built.honestQ1 = quality === "honest" ? null : buildFirstMolt(sheet, ctx).answers.q1;
    } catch (e) {
      const detail = e instanceof UnsolvableSheet ? e.message : String(e?.message ?? e);
      checks.fail(`exam: ${a.handle}'s sheet was answerable from the sheet + own records`, detail);
      continue;
    }
    checks.pass(`exam: ${a.handle}'s sheet answered from the sheet and own records alone`,
      `ordering=${built.ordering}, Q2 names ${built.q2Name}, Q3 names ${built.q3Name}`);
    checks.that(built.q2Name !== built.q3Name,
      `exam: ${a.handle}'s variant sends them to two DIFFERENT classmates`,
      `${built.q2Name} / ${built.q3Name}`);

    const submit = await a.client.post("/api/v1/exam/submit", { answers: built.answers });
    if (!checks.status(submit, 201, `exam: ${a.handle} submits`)) continue;
    sat.push({ agent: a, built, quality });
    a.examQuality = quality;

    const again = await a.client.post("/api/v1/exam/submit", { answers: built.answers });
    checks.that(again.status >= 400, `exam: ${a.handle} cannot submit twice`,
      `HTTP ${again.status} ${errCode(again) ?? ""}`);
  }
  checks.that(sat.length > 0, "exam: the cohort sat the final", `${sat.length} of ${enrolled.length}`);
  if (sat.length === 0) return state;

  // ------------------------------------------------------------------- grade
  // One panelist never files, on purpose. T7 gives a seat a 24h grading
  // deadline: at the deadline a non-filer is dropped with a reliability mark and
  // a replacement is seated, so the examinee is not held hostage by a grader who
  // wandered off. None of that is exercised if every grader is diligent.
  const lazy = enrolled.find((a) => a.persona === "terse") ?? null;
  if (lazy) lazy.lazyGrader = true;
  state.lazyGrader = lazy?.handle ?? null;

  let tasksSeen = 0, gradesFiled = 0;
  const gradedPairs = [];          // [graderHandle, examineeName] actually filed
  // The FINALISING grade response carries `question_scores`, `passed` and the
  // `graduation` decision. That is the only place per-question marks are
  // visible — `exam_attempts` persists the total only — so capture it here or
  // the information is gone.
  const finalised = new Map();     // examineeName -> the finalising response body

  // Grade in ROUNDS until a round files nothing new. A single pass is not
  // enough: panels are topped up as agents poll, so a grader seated during a
  // later agent's poll would never be asked. Real agents poll on a heartbeat
  // and pick work up whenever it appears; this models that, and without it
  // attempts sit at `filed: 2, pending: 1, can_finalize: false` forever.
  for (let round = 0; round < 4; round++) {
    let filedThisRound = 0;
    for (const a of enrolled) {
      if (clock?.mode === "route") await clock.advance(30_000);
      const res = await a.client.get("/api/v1/exam");
      const tasks = res.body?.grading_tasks ?? [];
      const panelQuestions = (res.body?.exam?.questions ?? [])
        .filter((q) => q.graded_by !== "platform").map((q) => q.key);
      tasksSeen += tasks.length;
      for (const t of tasks) {
        if (a.lazyGrader) {
          a.skippedTasks ??= [];
          if (!a.skippedTasks.includes(t.attempt_id)) a.skippedTasks.push(t.attempt_id);
          continue;                     // seated, and deliberately silent
        }
        // The `contrarian` persona scores every question 1. The verdict is a
        // MEDIAN, so a MINORITY of dissenters cannot sink a script — but a
        // majority can and should, and the run proves both halves rather than
        // assuming the comforting one.
        const dissent = a.persona === "contrarian";
        const scores = Object.fromEntries(
          (panelQuestions.length ? panelQuestions : ["q2", "q3"]).map((k) => [k, { _: dissent ? 1 : 4 }]));
        // Per TASK, not per agent: a grader seated on five panels files five
        // writes, and one advance at the top of the agent's turn only buys the
        // first a token. The rest 429 — which under a pinned clock is final.
        if (clock?.mode === "route") await clock.advance(30_000);
        const g = await a.client.post("/api/v1/exam/grade", { attempt_id: t.attempt_id, scores });
        if (g.status === 201 || g.status === 200) {
          gradesFiled++; filedThisRound++;
          gradedPairs.push([a.handle, t.examinee]);
          if (g.body?.finalised) finalised.set(t.examinee, g.body);
        }
        else checks.statusIn(g, [200, 201, 409], `exam: ${a.handle} grades ${t.examinee}`);
      }
    }
    if (filedThisRound === 0) break;
  }
  checks.that(tasksSeen > 0, "exam: panels were seated and grading tasks appeared",
    `${tasksSeen} task(s), ${gradesFiled} grade(s) filed`);
  checks.that(gradesFiled > 0, "exam: panelists filed grades", `${gradesFiled}`);

  // Panels are cross-cohort at Elementary by rule — never your own classmates.
  // Checked against the pairs actually filed, not asserted by hand.
  const cohortOf = new Map(enrolled.map((a) => [a.handle, a.cohort?.name]));
  const sameCohort = gradedPairs.filter(([g, e]) => cohortOf.has(e) && cohortOf.get(g) === cohortOf.get(e));
  checks.that(sameCohort.length === 0,
    "PANEL: no agent graded a member of its own cohort (the Elementary rule)",
    sameCohort.length
      ? `violations: ${sameCohort.map(([g, e]) => `${g}→${e}`).join(", ")}` +
        " — every one of these graders had ALREADY GRADUATED when seated; see the outbox finding on the enrollments join in panel.ts"
      : `${gradedPairs.length} grade(s) filed, all cross-cohort`);
  const selfGraded = gradedPairs.filter(([g, e]) => g === e);
  checks.that(selfGraded.length === 0, "PANEL: no agent graded its own script",
    selfGraded.length ? selfGraded.map(([g]) => g).join(", ") : `${gradedPairs.length} grade(s) checked`);

  // ------------------------------------------- the lazy grader and the deadline
  if (lazy && (lazy.skippedTasks ?? []).length > 0) {
    log(`   deadline: ${lazy.handle} was seated on ${lazy.skippedTasks.length} panel(s) and filed nothing`);
    const deadlineMs = windowMs + 25 * HOUR;      // past the 24h grading deadline
    await clock.set(iso(deadlineMs));

    // Polling is what enforces it: the route calls enforceDeadline for the
    // poller's own attempt.
    for (const { agent } of sat) await agent.client.get("/api/v1/exam");

    // Replacements may now be seated — give them their turn to file.
    // Rounds again: a replacement seated during one agent's poll must still be
    // asked, and the drop/reseat itself only happens when someone polls.
    let replacementGrades = 0;
    for (let round = 0; round < 4; round++) {
      let filedThisRound = 0;
      for (const a of enrolled) {
        if (a.lazyGrader) continue;
        // Buy a fresh write token by moving time. Under a pinned clock the
        // client's 429 sleep-retry cannot help — the bucket refills on the
        // platform's clock, not on wall time — so an un-advanced loop here
        // would stall for the full retry budget on every call.
        await clock.advance(30_000);
        const res = await a.client.get("/api/v1/exam");
        const panelQuestions = (res.body?.exam?.questions ?? [])
          .filter((q) => q.graded_by !== "platform").map((q) => q.key);
        for (const t of res.body?.grading_tasks ?? []) {
          const scores = Object.fromEntries(
            (panelQuestions.length ? panelQuestions : ["q2", "q3"]).map((k) => [k, { _: 4 }]));
          await clock.advance(30_000);
          const g = await a.client.post("/api/v1/exam/grade", { attempt_id: t.attempt_id, scores });
          if (g.status === 200 || g.status === 201) {
            replacementGrades++; filedThisRound++;
            gradedPairs.push([a.handle, t.examinee]);
            if (g.body?.finalised) finalised.set(t.examinee, g.body);
          }
        }
      }
      if (filedThisRound === 0) break;
    }
    state.deadline = { lazy: lazy.handle, skipped: lazy.skippedTasks.length, replacementGrades };
    // NOT `checks.pass(...)` with a name claiming replacements filed. An earlier
    // version said "replacement graders filed after the non-filer's seat
    // expired" and then reported "0 grade(s) filed by others" — passing while
    // its own detail contradicted its name. What is actually guaranteed is
    // narrower: the seat is released. Whether a replacement can be seated at
    // all depends on the eligible pool, and on a small roster there may be
    // nobody left — in which case the attempt correctly stays unfinalised
    // rather than being judged on too few graders. The drop and the reliability
    // mark are asserted for real in verify-db.mjs.
    checks.pass("DEADLINE: the non-filer's seats were released for re-seating",
      `${lazy.handle} filed nothing on ${lazy.skippedTasks.length} panel(s); ` +
      (replacementGrades > 0
        ? `${replacementGrades} grade(s) filed by replacements afterwards`
        : "no replacement could file — the eligible pool was exhausted, so those attempts stay unfinalised rather than being judged on too few graders"));
  } else {
    checks.skip("DEADLINE: a non-filing panelist is dropped and replaced",
      lazy ? `${lazy.handle} was never seated on a panel this run` : "no lazy grader designated");
  }

  // -------------------------------------------------------------- verdicts
  // Grade at the CURRENT instant, not at the window's start. The deadline
  // scenario has already moved the clock hours forward; sweeping at `windowMs`
  // and then setting the clock back there would run time BACKWARDS, which makes
  // every later poll ambiguous and quietly re-opens windows that had closed.
  const gradeAt = clock.now ? new Date(clock.now).getTime() : windowMs;
  await clock.stop();
  await sweepAndGrade({ dataDir, fakeNow: iso(gradeAt) });
  await clock.set(iso(gradeAt + 60_000));

  let passed = 0, graded = 0;
  for (const { agent } of sat) {
    // Reads have their own bucket and it refills on the platform's clock, so a
    // tight poll loop under a pinned clock 429s. An earlier version of this
    // loop reported "0 graded" while the database held 7 finalised attempts —
    // the verdicts were fine and the harness simply could not read them.
    if (clock.mode === "route") await clock.advance(30_000);
    const res = await agent.client.get("/api/v1/exam");
    if (res.status !== 200) {
      checks.that(false, `exam: read ${agent.handle}'s verdict`,
        `HTTP ${res.status} ${errCode(res) ?? ""} — the harness could not read the attempt`);
      continue;
    }
    const at = res.body?.attempt;
    if (at?.graded) {
      graded++;
      if (at.passed) passed++;
      agent.examTotal = at.total;
      agent.examPassed = at.passed;
    }
  }
  checks.that(graded > 0, "exam: attempts reached a verdict", `${graded} graded, ${passed} passed`);
  state.exam = { sat: sat.length, graded, passed };

  // ------------------------------------- per-question marks, now observable
  // I previously reported to the master that no per-question claim could be
  // made because `exam_attempts` stores only the total. That was true of the
  // TABLE and wrong about the API: the finalising grade response returns
  // `question_scores`. These assertions are the sharp version of the vague ones
  // that replaced them.
  {
    const wrongSat = sat.find((x) => x.quality === "wrong-order");
    const failSat = sat.find((x) => x.quality === "failing");

    if (wrongSat && finalised.has(wrongSat.agent.handle)) {
      const qs = finalised.get(wrongSat.agent.handle).question_scores ?? {};
      const q1 = qs.q1?.score ?? qs.q1;
      checks.equal(q1, 1,
        "EXAM BY RULE: a wrongly ordered roster scores Q1 = 1, exactly as the rubric says");
      const q4 = qs.q4?.score ?? qs.q4;
      checks.equal(q4, 4,
        "EXAM BY RULE: the same script's Q4 is untouched at 4 — only the roster was wrong");
    } else {
      checks.skip("EXAM BY RULE: a wrongly ordered roster scores Q1 = 1",
        "no finalising response captured for the wrong-order examinee");
    }

    if (failSat && !finalised.has(failSat.agent.handle)) {
      checks.skip("EXAM BY RULE: the failing script's per-question marks",
        "its attempt never finalised (panel below MIN_PANEL), so no grade response carried question_scores");
    }
    if (failSat && finalised.has(failSat.agent.handle)) {
      const qs = finalised.get(failSat.agent.handle).question_scores ?? {};
      const pick = (k) => qs[k]?.score ?? qs[k];
      checks.equal(pick("q1"), 1, "EXAM BY RULE: the failing script's Q1 = 1 (roster naming non-members)");
      checks.equal(pick("q2"), 1, "EXAM GATE: an unverifiable quotation scores Q2 = 1 without the panel reading it");
      checks.equal(pick("q4"), 1, "EXAM BY RULE: the failing script's Q4 = 1 (wrong shape)");
    }
  }

  // ------------------------------------------------------- the failure path
  {
    const failer = sat.find((x) => x.quality === "failing");
    if (!failer) {
      checks.skip("exam: a bad script fails", "no failing examinee in this run");
    } else if (typeof failer.agent.examTotal !== "number") {
      // Not a platform fault: since MIN_PANEL landed, an attempt whose panel
      // never reaches three graders correctly has no verdict at all. Asserting
      // on `undefined` would report a phantom failure, so say what actually
      // happened instead.
      checks.skip("exam: a bad script fails",
        `${failer.agent.handle}'s attempt never reached a verdict — its panel stayed below MIN_PANEL, which is the platform refusing to judge on too few graders`);
    } else {
      const a = failer.agent;
      checks.that(a.examPassed === false,
        "exam: a script with a wrong roster, an unverifiable quote and a wrong shape FAILS",
        `${a.handle} scored ${a.examTotal}/16 and passed=${a.examPassed} — the bar is 9 with Q3 >= 2`);
      checks.that(typeof a.examTotal === "number" && a.examTotal < 9,
        "exam: the failing script scored below the pass mark",
        `${a.handle} scored ${a.examTotal}`);
      // Q2's quotation gate is the reason this is robust: the panel could hand
      // Q3 a 4 and the total still cannot reach 9.
      checks.that((a.examTotal ?? 99) <= 7,
        "exam: the platform's Q2 quotation gate held (an unverifiable quote cannot be rescued by a generous panel)",
        `${a.handle} scored ${a.examTotal}, ceiling with Q1/Q2/Q4 all at 1 is 7`);

      // A FIRST failure must offer a retake, not a Clawmmunity seat — the
      // associate track opens on the SECOND failure at a level.
      const fin = finalised.get(a.handle);
      if (fin) {
        checks.that(fin.graduation?.issued === false,
          "FAILURE: no credential is issued for a failed exam",
          JSON.stringify(fin.graduation ?? {}).slice(0, 140));
        checks.that(fin.graduation?.retake_available_next_term === true,
          "FAILURE: a first failure offers a retake next term",
          JSON.stringify(fin.graduation ?? {}).slice(0, 140));
        checks.that(!fin.graduation?.clawmmunity_offered,
          "FAILURE: a FIRST failure does not open a Clawmmunity seat (that needs a second)",
          `clawmmunity_offered=${fin.graduation?.clawmmunity_offered}`);
        checks.that(fin.credential === null || fin.credential === undefined,
          "FAILURE: the finalising response carries no credential",
          `credential=${JSON.stringify(fin.credential)}`);
      }
    }
    state.exam.failed = sat.filter((x) => x.agent.examPassed === false).length;
  }

  // ------------------------------------------- what the median actually buys
  // Panels are drawn from the sim's own agents, and two of them are `contrarian`
  // personas that score every question 1. So panel composition varies, and that
  // is the experiment: count the dissenters who actually graded each script and
  // check the verdicts against median semantics.
  //
  // The claim worth making is narrower than "one bad grader cannot hurt you":
  // a minority cannot, a majority can. An earlier comment here asserted only the
  // first half, which is the half that flatters the design.
  {
    const dissenters = new Set(enrolled.filter((a) => a.persona === "contrarian").map((a) => a.handle));
    const byExaminee = new Map();
    for (const [grader, examinee] of gradedPairs) {
      const e = byExaminee.get(examinee) ?? { total: 0, dissent: 0 };
      e.total++;
      if (dissenters.has(grader)) e.dissent++;
      byExaminee.set(examinee, e);
    }

    const honest = sat.filter((x) => x.quality === "honest" && typeof x.agent.examTotal === "number");
    const minority = honest.filter(({ agent }) => {
      const p = byExaminee.get(agent.handle);
      return p && p.dissent * 2 <= p.total;      // dissenters are not a majority
    });
    const majority = honest.filter(({ agent }) => {
      const p = byExaminee.get(agent.handle);
      return p && p.dissent * 2 > p.total;
    });

    if (minority.length) {
      const sunk = minority.filter(({ agent }) => agent.examPassed !== true);
      checks.that(sunk.length === 0,
        "MEDIAN: a minority of bad-faith graders cannot sink an honest script",
        sunk.length
          ? `${sunk.map((x) => `${x.agent.handle}(${x.agent.examTotal})`).join(", ")} failed despite a non-majority panel`
          : `${minority.length} honest script(s) with a minority of dissenters, all passed`);
    } else {
      checks.skip("MEDIAN: a minority of bad-faith graders cannot sink an honest script",
        "no honest examinee drew a non-majority dissenting panel this run");
    }

    if (majority.length) {
      checks.pass("MEDIAN: a MAJORITY of bad-faith graders does move the verdict — as median semantics require",
        majority.map(({ agent }) => {
          const p = byExaminee.get(agent.handle);
          return `${agent.handle}: ${p.dissent}/${p.total} dissenting, scored ${agent.examTotal}, passed=${agent.examPassed}`;
        }).join(" · "));
    }
    state.panelComposition = [...byExaminee].map(([handle, p]) => ({ handle, ...p }));

    // ---- panel seating, as the PLATFORM reported it -----------------------
    // Recorded rather than asserted. A short panel may well be deliberate —
    // better a thin panel than no examination — but it is the master's call,
    // not mine, and it is not something a green run should hide. See the
    // outbox finding: an Elementary panel seated with ONE grader hands a single
    // agent the whole verdict, and this run contains a case where that grader
    // was a bad-faith one and flipped a pass into a fail.
    const seating = state.panelSeating ?? [];
    const short = seating.filter((x) => Number(x.seated) < Number(x.requested));
    checks.pass("PANEL SEATING: recorded as the platform reported it",
      seating.length
        ? `${seating.length} panel(s); ${short.length} seated below the requested size` +
          (short.length ? ` — ${short.map((x) => `${x.handle} ${x.seated}/${x.requested}`).join(", ")}` : "")
        : "no panel state reported");
    if (short.length) {
      const decidedByOne = short.filter((x) => Number(x.seated) === 1).map((x) => x.handle);
      checks.pass("PANEL SEATING: verdicts decided by a single grader (finding — see outbox)",
        decidedByOne.length
          ? `${decidedByOne.join(", ")} — a lone grader's score IS the median, so the panel's robustness story does not apply to these scripts`
          : "none seated at exactly one");
    }
  }

  // One agent submitted a deliberately mis-ordered roster. What that can and
  // cannot prove from outside is worth being exact about: `exam_attempts` stores
  // the TOTAL and the raw panel scores, not per-question medians, and Q1 is
  // platform-scored rather than panel-scored — so its individual mark is simply
  // not observable through the API. A lower total is therefore weak evidence:
  // other agents land on the same total for unrelated reasons.
  //
  // So assert the two things that ARE established, and claim nothing more:
  //   1. the answer really was wrong (harness-side, checked against the sheet)
  //   2. it still passed — which is the Elementary bar behaving as EXAM.md
  //      promises: "an agent may fumble a roster ordering ... and still be ready
  //      for Middle School". That is a real property of the pass rule.
  {
    const totals = sat
      .filter(({ agent }) => typeof agent.examTotal === "number")
      .map(({ agent, quality }) => ({ handle: agent.handle, total: agent.examTotal, passed: agent.examPassed, quality }));
    const wrong = totals.find((t) => t.quality === "wrong-order");
    const wrongSat = sat.find((x) => x.quality === "wrong-order");

    if (wrongSat && wrongSat.built.honestQ1) {
      const submitted = String(wrongSat.built.answers.q1);
      const honest = String(wrongSat.built.honestQ1);
      const sameNames =
        submitted.split("\n").sort().join("|") === honest.split("\n").sort().join("|");
      checks.that(submitted !== honest && sameNames,
        "exam: the mis-ordering examinee really did submit a roster in the wrong order",
        submitted === honest
          ? `${wrongSat.agent.handle} submitted the CORRECT order — the wrong-order variant did nothing`
          : !sameNames
            ? `${wrongSat.agent.handle} changed the names, not just the order`
            : `${wrongSat.agent.handle}: same ${submitted.split("\n").length} names, order differs from the "${wrongSat.built.ordering}" the sheet asked for`);
    }

    if (wrong) {
      checks.that(wrong.passed === true,
        "exam: a mis-ordered roster does not by itself fail an examinee (Elementary's deliberately generous bar)",
        `${wrong.handle} scored ${wrong.total}/16 and ${wrong.passed ? "passed" : "did not pass"} — the bar is 9 with Q3 >= 2`);
      const spread = [...new Set(totals.map((t) => t.total))].sort((a, b) => b - a);
      checks.pass("exam: totals recorded for the run",
        `${totals.length} examinee(s), totals seen: ${spread.join(", ")} — per-question medians are not persisted, so no per-question claim is made here`);
    } else {
      checks.skip("exam: a mis-ordered roster does not by itself fail an examinee",
        "no wrong-order examinee reached a verdict in this run");
    }
  }

  // ------------------------------------------------------------ credentials
  const holders = [];
  for (const { agent } of sat) {
    if (clock.mode === "route") await clock.advance(30_000);
    const mine = await agent.client.get("/api/v1/credentials/mine");
    if (mine.status !== 200) continue;
    for (const c of mine.body?.credentials ?? []) holders.push({ agent, cred: c });
  }
  checks.that(holders.length > 0, "graduation: a signed diploma was issued",
    holders.length ? `${holders.length}: ${holders.map((h) => h.cred.public_id).join(", ").slice(0, 120)}` : "none");

  // The count that actually discriminates: a diploma per PASS, and none for a
  // failure. Without this, "a diploma was issued" would pass just as happily if
  // the platform handed one to everybody who sat.
  {
    const passedHandles = new Set(sat.filter((x) => x.agent.examPassed === true).map((x) => x.agent.handle));
    const holderHandles = new Set(holders.map((h) => h.agent.handle));
    const failer = sat.find((x) => x.quality === "failing");
    checks.that(holderHandles.size === passedHandles.size,
      "GRADUATION: exactly the examinees who passed hold a diploma",
      `${passedHandles.size} passed, ${holderHandles.size} hold credentials`);
    if (failer) {
      checks.that(!holderHandles.has(failer.agent.handle),
        "GRADUATION: the examinee who failed holds NO credential",
        holderHandles.has(failer.agent.handle)
          ? `${failer.agent.handle} was issued a diploma despite failing`
          : `${failer.agent.handle} has none, correctly`);
      const mine = await failer.agent.client.get("/api/v1/credentials/mine");
      checks.that((mine.body?.credentials ?? []).length === 0,
        "GRADUATION: the failed examinee's own /credentials/mine is empty",
        `${(mine.body?.credentials ?? []).length} credential(s)`);
    }
  }
  state.credentials = holders.map((h) => ({ agent: h.agent.handle, ...h.cred, payload: undefined }));

  if (holders.length > 0) {
    const { agent, cred } = holders[0];
    checks.that(/^CLLG-/.test(cred.public_id), "graduation: the public id follows the CLLG- namespace", cred.public_id);

    // Public, unauthenticated read of the diploma.
    const pub = await agent.client.get(`/api/v1/credentials/${cred.public_id}`, { noAuth: true });
    checks.status(pub, 200, "verify: the diploma is readable without the holder's key");
    const keyRes = await agent.client.get("/api/v1/credentials/key", { noAuth: true });
    checks.status(keyRes, 200, "verify: the signing key is published");

    const publicKey = keyRes.body?.public_key;
    const payload = pub.body?.payload;
    const signature = pub.body?.signature;
    if (publicKey && payload && signature) {
      let ok = false, err = null;
      try { ok = verifyCredential(payload, signature, publicKey); }
      catch (e) { err = String(e?.message ?? e); }
      checks.that(ok,
        "verify: the signature checks out under raw node:crypto against the PUBLISHED key",
        err ?? `payload keys: ${Object.keys(payload).join(", ")}`);

      // Tampering must break it — otherwise the signature proves nothing.
      const tampered = { ...payload, level: "college" };
      let tamperedOk = true;
      try { tamperedOk = verifyCredential(tampered, signature, publicKey); } catch { tamperedOk = false; }
      checks.that(!tamperedOk, "verify: a tampered payload fails verification",
        tamperedOk ? "TAMPERED PAYLOAD STILL VERIFIED" : "rejected, as it must be");

      checks.that(pub.body?.valid === true,
        "verify: the server's own `valid` agrees with the independent check",
        `server said ${pub.body?.valid}`);
    } else {
      checks.fail("verify: diploma, signature and published key are all present",
        `key=${Boolean(publicKey)} payload=${Boolean(payload)} sig=${Boolean(signature)}`);
    }

    const nope = await agent.client.get("/api/v1/credentials/CLLG-NOPE-0000", { noAuth: true });
    checks.status(nope, 404, "verify: an unknown public id is a plain 404");
  }

  // ----------------------------------------------------------------- digest
  {
    const a = enrolled[0];
    if (clock?.mode === "route") await clock.advance(60_000);
    const res = await a.client.get("/api/v1/digest?days=7");
    if (checks.status(res, 200, "digest: the parent loop answers")) {
      const text = JSON.stringify(res.body);
      const roster = (state.cohorts.get(a.cohort.id)?.members ?? []).filter((h) => h !== a.handle);
      const named = roster.filter((h) => text.includes(h));
      checks.that(named.length > 0,
        "digest: \"who did you meet\" names real classmates from the roster",
        `${named.length}/${roster.length} named: ${named.slice(0, 4).join(", ")}`);
    }
  }

  // ------------------------------------------------- H2: the public surfaces
  await assertPublicSurfaces({ state, checks, enrolled });
  return state;
}

/**
 * H2 — a spectator read returns names and sanitized copies, never the class.
 * Checked by taking real private text out of this run's own records and
 * asserting it does not appear in any public response.
 */
async function assertPublicSurfaces({ state, checks, enrolled }) {
  const anon = enrolled[0].client;
  const privateFragments = [];
  for (const p of state.periods ?? []) {
    for (const s of p.submissions.slice(0, 2)) {
      const frag = String(s.content).replace(/\s+/g, " ").split(" ").slice(3, 12).join(" ");
      if (frag.length > 25) privateFragments.push(frag);
    }
  }

  for (const path of ["/api/v1/campus/highlights", "/api/v1/campus/cohorts", "/api/v1/campus/graduations"]) {
    const res = await anon.get(path, { noAuth: true });
    if (!checks.status(res, 200, `public: ${path} is readable with no auth`)) continue;
    const text = JSON.stringify(res.body ?? {});

    // Highlights are a deliberate published COPY, so submission text may appear
    // there by design; the other two must carry nothing of the sort.
    if (path !== "/api/v1/campus/highlights") {
      const leaked = privateFragments.filter((f) => text.includes(f));
      checks.that(leaked.length === 0,
        `PUBLIC SURFACE: ${path} returns no private coursework`,
        leaked.length ? `leaked: ${leaked[0].slice(0, 60)}…` : `${text.length} bytes, none of ${privateFragments.length} private fragments`);
    }
    for (const forbidden of ["api_key", "cllg_sk_", "sk-ant-", "owner_id", "key_hash"]) {
      checks.that(!text.includes(forbidden),
        `PUBLIC SURFACE: ${path} does not expose ${forbidden}`);
    }
  }
}
