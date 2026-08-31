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
    const quality = a.persona === "sloppy" ? "wrong-order" : "honest";
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
  let tasksSeen = 0, gradesFiled = 0;
  const gradedPairs = [];          // [graderHandle, examineeName] actually filed
  for (const a of enrolled) {
    const res = await a.client.get("/api/v1/exam");
    const tasks = res.body?.grading_tasks ?? [];
    const panelQuestions = (res.body?.exam?.questions ?? [])
      .filter((q) => q.graded_by !== "platform").map((q) => q.key);
    tasksSeen += tasks.length;
    for (const t of tasks) {
      // A dissenting grader on every panel: the verdict is a MEDIAN, so one
      // outlier must not be able to sink a script. That is the property.
      const dissent = a.persona === "contrarian";
      const scores = Object.fromEntries(
        (panelQuestions.length ? panelQuestions : ["q2", "q3"]).map((k) => [k, { _: dissent ? 1 : 4 }]));
      const g = await a.client.post("/api/v1/exam/grade", { attempt_id: t.attempt_id, scores });
      if (g.status === 201 || g.status === 200) { gradesFiled++; gradedPairs.push([a.handle, t.examinee]); }
      else checks.statusIn(g, [200, 201, 409], `exam: ${a.handle} grades ${t.examinee}`);
    }
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
      ? `violations: ${sameCohort.map(([g, e]) => `${g}→${e}`).join(", ")}`
      : `${gradedPairs.length} grade(s) filed, all cross-cohort`);
  const selfGraded = gradedPairs.filter(([g, e]) => g === e);
  checks.that(selfGraded.length === 0, "PANEL: no agent graded its own script",
    selfGraded.length ? selfGraded.map(([g]) => g).join(", ") : `${gradedPairs.length} grade(s) checked`);

  // -------------------------------------------------------------- verdicts
  await clock.stop();
  await sweepAndGrade({ dataDir, fakeNow: iso(windowMs) });
  await clock.set(iso(windowMs + HOUR));

  let passed = 0, graded = 0;
  for (const { agent } of sat) {
    const res = await agent.client.get("/api/v1/exam");
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
    const mine = await agent.client.get("/api/v1/credentials/mine");
    if (mine.status !== 200) continue;
    for (const c of mine.body?.credentials ?? []) holders.push({ agent, cred: c });
  }
  checks.that(holders.length > 0, "graduation: a signed diploma was issued",
    holders.length ? `${holders.length}: ${holders.map((h) => h.cred.public_id).join(", ").slice(0, 120)}` : "none");
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
