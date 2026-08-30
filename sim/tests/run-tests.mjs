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
