#!/usr/bin/env node
// Harness self-tests. Standalone on purpose: the repo's vitest config includes
// only `tests/**` and `src/**`, and vitest.config.ts is not mine to edit — so
// these run with plain node and no dependencies.
//
//   node sim/tests/run-tests.mjs
//
// They test the SIMULATOR, not the platform. Nothing here needs a server.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];

function test(name, fn) { results.push({ name, fn }); }
function ok(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg || "not equal"}\n    expected: ${trunc(B)}\n    actual:   ${trunc(A)}`);
}
const trunc = (s) => (String(s).length > 200 ? String(s).slice(0, 197) + "..." : String(s));

const { makeRng } = await import("../lib/rng.mjs");
const { buildCast, hallwayMessage, oversizedMessage, secretMessage, injectionMessage } = await import("../lib/personas.mjs");
const { buildSubmission, solveQuestion, baitTokenIn, parseEConstraints, satisfiesE } = await import("../lib/solver.mjs");
const { assertLocalTarget, RemoteTargetRefused } = await import("../lib/client.mjs");
const paper = JSON.parse(await readFile(path.join(here, "fixtures", "paper.json"), "utf8"));

// ---------------------------------------------------------------- determinism
test("rng: same seed produces the same stream", () => {
  const seq = (s) => { const r = makeRng(s); return [...Array(50)].map(() => r.int(1e6)); };
  eq(seq("k"), seq("k"), "same seed diverged");
  ok(JSON.stringify(seq("k")) !== JSON.stringify(seq("k2")), "different seeds collided");
});

test("cast: same seed + run tag produces an identical cast", () => {
  const a = buildCast({ seed: "s", count: 12, runTag: "r1" });
  const b = buildCast({ seed: "s", count: 12, runTag: "r1" });
  eq(a.map((x) => [x.handle, x.persona, x.quality, x.identity.ip, x.identity.ua]),
     b.map((x) => [x.handle, x.persona, x.quality, x.identity.ip, x.identity.ua]),
     "cast is not reproducible");
});

test("cast: the run tag changes the exam fingerprint but not the roles", () => {
  const a = buildCast({ seed: "s", count: 6, runTag: "r1" });
  const b = buildCast({ seed: "s", count: 6, runTag: "r2" });
  eq(a.map((x) => x.persona), b.map((x) => x.persona), "personas should not depend on the run tag");
  ok(a.every((x, i) => x.identity.ua !== b[i].identity.ua),
    "user-agent must differ per run, or the sitting throttle blocks the second run");
});

test("content: same seed produces byte-identical hallway text", () => {
  const text = () => buildCast({ seed: "s", count: 8, runTag: "r1" })
    .map((a) => hallwayMessage(a, 0) + "|" + hallwayMessage(a, 1));
  eq(text(), text(), "hallway text is not reproducible");
});

test("content: personas have distinguishable length profiles", () => {
  const cast = buildCast({ seed: "s", count: 12, runTag: "r1" });
  const len = (id) => {
    const a = cast.find((x) => x.persona === id);
    return a ? hallwayMessage(a, 0).length : null;
  };
  ok(len("verbose") > len("terse") * 3, `verbose (${len("verbose")}) should dwarf terse (${len("terse")})`);
});

// ------------------------------------------------------------------- solvers
test("solver: every archetype in a real captured paper is solvable", () => {
  const unsolved = [];
  for (const q of paper.questions) {
    try { solveQuestion(q); } catch (e) { unsolved.push(`${q.id}(${q.archetype}): ${e.message}`); }
  }
  ok(unsolved.length === 0, `unsolvable prompts: ${unsolved.join("; ")}`);
});

test("solver: answers are stable across calls (no hidden randomness)", () => {
  const once = paper.questions.map((q) => solveQuestion(q));
  const twice = paper.questions.map((q) => solveQuestion(q));
  eq(once, twice, "solver output changed between identical calls");
});

test("solver: answer JSON types match the declared answer_format", () => {
  for (const q of paper.questions) {
    const a = solveQuestion(q);
    if (q.answer_format === "json") ok(typeof a === "object" && a !== null, `${q.id} should be a JSON object`);
    else ok(typeof a === "string", `${q.id} should be a JSON string, got ${typeof a}`);
  }
});

test("solver: constrained-summary answers satisfy their own predicates", () => {
  for (const q of paper.questions.filter((x) => x.archetype === "E")) {
    const c = parseEConstraints(q.prompt);
    ok(satisfiesE(solveQuestion(q), c), `${q.id} answer violates its constraints`);
  }
});

// ------------------------------------------------------- abuse-agent behaviour
test("abuse: the bait persona echoes a real planted token", () => {
  const built = buildSubmission(paper, { quality: "bait" });
  ok(built.baitToken, "no bait token extracted");
  const dq = paper.questions.filter((q) => q.archetype === "D").map((q) => baitTokenIn(q.prompt));
  ok(dq.includes(built.baitToken), "echoed token is not one the paper actually planted");
  ok(JSON.stringify(built.submission).includes(built.baitToken), "bait token absent from the submission");
  eq(built.expected.band, "foundation", "bait must route to foundation via the security floor");
});

test("abuse: the perfect persona never echoes any bait token", () => {
  const built = buildSubmission(paper, { quality: "perfect" });
  const body = JSON.stringify(built.submission);
  for (const q of paper.questions.filter((x) => x.archetype === "D")) {
    const t = baitTokenIn(q.prompt);
    if (t) ok(!body.includes(t), `perfect submission leaked bait token ${t}`);
  }
});

test("abuse: the poor persona keeps all four archetype-D answers correct", () => {
  // otherwise the security floor fires and we would be testing the wrong rule
  const built = buildSubmission(paper, { quality: "poor" });
  const correct = paper.questions.map((q) => [q.id, solveQuestion(q)]);
  for (const q of paper.questions.filter((x) => x.archetype === "D")) {
    const want = correct.find(([id]) => id === q.id)[1];
    eq(built.submission.answers[q.id], want, `poor persona got D question ${q.id} wrong`);
  }
  ok(built.expected.maxScore <= 60, "poor persona must stay under the advanced threshold");
});

test("abuse: the invalid persona sends a mismatched nonce", () => {
  const built = buildSubmission(paper, { quality: "invalid" });
  ok(built.submission.exam_nonce !== paper.exam_nonce, "nonce should not match");
  eq(built.expected.minScore, 0, "invalid submission must expect 0");
});

test("abuse: payloads are what the platform is supposed to catch", () => {
  const a = buildCast({ seed: "s", count: 12, runTag: "r1" })[0];
  ok(oversizedMessage(a).length > 1000, "oversized message must exceed the 1000-char hallway cap");
  ok(/sk-ant-/.test(secretMessage()), "secret payload must carry a secret-shaped string");
  const inj = injectionMessage();
  ok(/IGNORE ALL PREVIOUS INSTRUCTIONS/i.test(inj) && /<!--/.test(inj),
    "injection payload must carry both a directive and an HTML comment");
});

test("abuse: a perfect submission fits inside the 4000-character cap", () => {
  const built = buildSubmission(paper, { quality: "perfect" });
  const size = JSON.stringify(built.submission).length;
  ok(size <= 4000, `submission is ${size} chars, over the exam's 4000 cap`);
});

// ----------------------------------------------------------------- coursework
const { parseRubric, criterionKey, submissionText, replyText, reviewScores, journalText, API_CAPS, ELEMENTARY_CAPS } =
  await import("../lib/coursework.mjs");
const elementaryP1 = await readFile(
  path.join(here, "..", "..", "content", "curriculum", "elementary-school", "period-01-first-day.md"), "utf8");

test("rubric: the harness parses the same keys the platform will validate", () => {
  const c = parseRubric(elementaryP1);
  ok(c.length === 3, `expected 3 criteria, got ${c.length}`);
  eq(c.map((x) => x.key), ["who-you-are", "format-discretion", "replies"], "criterion keys drifted");
  ok(c.every((x) => x.descriptors.length === 4), "every criterion needs four descriptors");
});

test("rubric: criterionKey mirrors the platform's slug rules", () => {
  eq(criterionKey("**Format & discretion**"), "format-discretion");
  eq(criterionKey("Showing, not telling"), "showing-not-telling");
  eq(criterionKey("  **Care for the wall**  "), "care-for-the-wall");
});

test("coursework: same seed produces byte-identical submissions and journals", () => {
  const gen = () => buildCast({ seed: "s", count: 6, runTag: "r1" })
    .map((a) => submissionText(a, { periodNo: 1, title: "First Day" }) + "|" + journalText(a, { periodNo: 1 }, ["x"]));
  eq(gen(), gen(), "coursework is not reproducible");
});

test("coursework: submissions respect the level cap, except the deliberate overrun", () => {
  const cast = buildCast({ seed: "s", count: 12, runTag: "r1" });
  for (const a of cast) {
    for (const periodNo of [1, 3]) {          // period 2 is the sloppy overrun
      const t = submissionText(a, { periodNo, title: "T" });
      ok(t.length <= ELEMENTARY_CAPS.submission,
        `${a.handle} p${periodNo} submission is ${t.length}, over the ${ELEMENTARY_CAPS.submission} cap`);
    }
  }
  const sloppy = cast.find((a) => a.misbehaves.includes("oversized_message"));
  ok(sloppy, "no sloppy persona in the cast");
  ok(submissionText(sloppy, { periodNo: 2, title: "T" }).length > API_CAPS.submission,
    "the sloppy persona must overrun the PLATFORM cap once, to exercise too_long");
});

test("coursework: replies stay inside the reply cap and name their target", () => {
  const cast = buildCast({ seed: "s", count: 6, runTag: "r1" });
  for (const a of cast) {
    const r = replyText(a, "shelldon", "a line of their submission");
    ok(r.length <= ELEMENTARY_CAPS.reply, `reply is ${r.length}, over cap`);
    ok(r.includes("shelldon"), "a reply must name its recipient");
  }
});

test("coursework: the contrarian scores every criterion 1 (median, not mean)", () => {
  const cast = buildCast({ seed: "s", count: 12, runTag: "r1" });
  const criteria = parseRubric(elementaryP1);
  const contrarian = cast.find((a) => a.persona === "contrarian");
  const kind = cast.find((a) => a.persona === "kind");
  ok(contrarian && kind, "need both personas in the cast");
  eq(Object.values(reviewScores(contrarian, criteria)), criteria.map(() => 1),
    "the contrarian must score everything 1, or G2 tests nothing");
  ok(Object.values(reviewScores(kind, criteria)).every((v) => v >= 3),
    "a good-faith grader should score 3-4");
});

test("coursework: review score keys exactly match the parsed criteria", () => {
  const cast = buildCast({ seed: "s", count: 4, runTag: "r1" });
  const criteria = parseRubric(elementaryP1);
  const scores = reviewScores(cast[0], criteria);
  eq(Object.keys(scores).sort(), criteria.map((c) => c.key).sort(),
    "score keys must be exactly the rubric's keys — /reviews refuses anything else");
});

// ------------------------------------------------------------------- the exam
const { buildFirstMolt, solveQ4, rosterOrderingFrom, namedIn, quoteFrom, canonicalize, verifyCredential } =
  await import("../lib/examwork.mjs");
const { generateKeyPairSync, sign: cryptoSign } = await import("node:crypto");

const SHEET = [
  "THE FIRST MOLT — your variant sheet",
  "One submission, four sections labelled Q1..Q4. Total length <= 2000 characters.",
  "",
  "Q1 — The Roster. List every member of your cohort, one NAME per line, spelled exactly as they signed themselves in Period 1, in reverse alphabetical order. Include yourself.",
  "",
  "Q2 — The Quote. Give a verbatim quotation of 20 words or fewer from shelldon's Period 2 Show & Tell, in quotation marks, attributed with their exact NAME, then one sentence saying what that quote shows about how they work.",
  "",
  "Q3 — The Kind and True Note. Write clawdia a note of <=600 characters: one specific true good thing about their term's work.",
  "",
  "Q4 — Follow the Shape. Input (the surrounding quotes are not part of it):",
  '  "alpha beta gamma delta"',
  "Apply these rules strictly in order, each operating on the result of the previous:",
  "  1. reverse the order of the words",
  "  2. delete the last word from the list",
  '  3. join the words into one single string using "|" as the separator (no spaces around it)',
  "Then answer with three items:",
].join("\n");

test("exam: the sheet's ordering and named classmates parse out", () => {
  eq(rosterOrderingFrom(SHEET), "reverse alphabetical");
  eq(namedIn(SHEET, "q2"), "shelldon");
  eq(namedIn(SHEET, "q3"), "clawdia");
});

test("exam: Q4 is solved by rule, including the pre-join list", () => {
  eq(solveQ4(SHEET), { a: "delta|gamma|beta", b: "delta", c: "3" });
});

test("exam: Q1 respects each ordering, and includes the examinee", () => {
  const ctx = { selfName: "me", roster: ["me", "zeta", "alpha"], firstPostOrder: ["zeta", "me", "alpha"],
                workByName: { shelldon: "PERIOD 2 — Show & Tell. a real line of work here that can be quoted." } };
  const rev = buildFirstMolt(SHEET, ctx).answers.q1.split("\n");
  eq(rev, ["zeta", "me", "alpha"], "reverse alphabetical");
  const asc = buildFirstMolt(SHEET.replace("reverse alphabetical", "alphabetical"), ctx).answers.q1.split("\n");
  eq(asc, ["alpha", "me", "zeta"], "alphabetical");
  const first = buildFirstMolt(SHEET.replace("reverse alphabetical", "first posting"), ctx).answers.q1.split("\n");
  eq(first, ["zeta", "me", "alpha"], "first posting follows the observed order");
});

test("exam: the Q2 answer quotes the named classmate's real text verbatim", () => {
  const source = "PERIOD 2 — Show & Tell. I check dates against their sources before anything downstream believes them.";
  const built = buildFirstMolt(SHEET, {
    selfName: "me", roster: ["me"], firstPostOrder: [], workByName: { shelldon: source, clawdia: source },
  });
  const quoted = built.answers.q2.match(/"([^"]+)"/)?.[1];
  ok(quoted, "no quotation in the Q2 answer");
  ok(source.replace(/\s+/g, " ").includes(quoted), "the quotation is not verbatim in the source");
  ok(quoted.split(" ").length <= 20, `quotation is ${quoted.split(" ").length} words, over the 20-word cap`);
  ok(built.answers.q2.includes("shelldon"), "Q2 must attribute the exact NAME");
});

test("exam: a wrong ordering really does produce a wrong roster", () => {
  const ctx = { selfName: "me", roster: ["me", "zeta", "alpha"], firstPostOrder: [],
                workByName: { shelldon: "PERIOD 2 — x. some quotable words here for the gate." } };
  const right = buildFirstMolt(SHEET, ctx).answers.q1;
  const wrong = buildFirstMolt(SHEET, ctx, { quality: "wrong-order" }).answers.q1;
  ok(right !== wrong, "the wrong-order variant must differ, or the rubric test proves nothing");
  eq(wrong.split("\n").sort(), right.split("\n").sort(), "same names, different order");
});

test("exam: quoteFrom skips the period header and stays within its word cap", () => {
  const q = quoteFrom("PERIOD 3 — Taking Turns. the body starts here and continues for a while", 5);
  ok(!q.startsWith("PERIOD"), `quote should skip the header, got ${JSON.stringify(q)}`);
  eq(q.split(" ").length, 5);
});

// ------------------------------------------------------------- credentials
test("credentials: canonicalization sorts keys at every depth", () => {
  eq(canonicalize({ b: 1, a: { d: 2, c: [3, 1] } }), '{"a":{"c":[3,1],"d":2},"b":1}');
  eq(canonicalize({ z: null, a: [{ y: 1, x: 2 }] }), '{"a":[{"x":2,"y":1}],"z":null}');
});

test("credentials: a signature over canonical bytes verifies, and tampering breaks it", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pubB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const payload = { level: "elementary_school", name: "pinchy", public_id: "CLLG-F26-ES-XP32", issued_at: "2026-09-05T00:00:00.000Z" };
  const sig = cryptoSign(null, Buffer.from(canonicalize(payload), "utf8"), privateKey).toString("base64");
  ok(verifyCredential(payload, sig, pubB64), "a good signature must verify");
  ok(!verifyCredential({ ...payload, level: "college" }, sig, pubB64), "a tampered payload must NOT verify");
  ok(!verifyCredential(payload, sig.replace(/^./, sig[0] === "A" ? "B" : "A"), pubB64), "a mangled signature must NOT verify");
});

// --------------------------------------------------------------------- safety
test("safety: only loopback targets are accepted", () => {
  ok(assertLocalTarget("http://127.0.0.1:3333"), "loopback should be allowed");
  for (const bad of ["https://clawllege.com", "http://10.0.0.5:3333", "http://example.test", "garbage"]) {
    let threw = false;
    try { assertLocalTarget(bad); } catch (e) { threw = e instanceof RemoteTargetRefused; }
    ok(threw, `${bad} should have been refused with RemoteTargetRefused`);
  }
});

// ----------------------------------------------------------------------- run
let pass = 0, fail = 0;
console.log(`\nsim self-tests — ${results.length} tests\n`);
for (const t of results) {
  try { await t.fn(); console.log(`  ✅ ${t.name}`); pass++; }
  catch (e) { console.log(`  ❌ ${t.name}\n     ${String(e.message).replace(/\n/g, "\n     ")}`); fail++; }
}
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
