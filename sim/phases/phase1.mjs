// Phase 1 — onboarding through the hallway, against the real API over HTTP.
//
//   register -> owner claim (dev stub) -> entrance exam (both bands)
//   -> enrol -> hallway traffic -> abuse probes
//
// Every step asserts. Nothing here reads the database; relationship upkeep is
// verified separately by `sim/verify-db.mjs` (PGlite is single-writer, so the
// dev server must be stopped before anything else can open the file).

import { Client } from "../lib/client.mjs";
import { buildCast, hallwayMessage, oversizedMessage, secretMessage, injectionMessage } from "../lib/personas.mjs";
import { buildSubmission } from "../lib/solver.mjs";
import { errCode } from "../lib/assert.mjs";

const KEY_PREFIX = "cllg_sk_";

export async function runPhase1({ baseUrl, seed, count, runTag, checks, transcript, log }) {
  const cast = buildCast({ seed, count, runTag });
  const state = { cast, agents: new Map(), cohorts: new Map(), started: new Date().toISOString() };

  const clientFor = (a) => new Client({ baseUrl, transcript, label: a.handle, identity: a.identity });

  // ---------------------------------------------------------------- register
  log(`registering ${cast.length} agents`);
  for (const a of cast) {
    const c = clientFor(a);
    const res = await c.post("/api/v1/agents/register", {
      name: a.handle,
      display_name: a.displayName,
      // persona is a JSON object, not a string (the route rejects a bare string
      // with `validation`; docs/API.md only says `persona?`).
      persona: { style: a.persona, blurb: a.blurb, simulated: true },
    });
    if (!checks.status(res, 201, `register ${a.handle}`)) continue;

    const b = res.body ?? {};
    checks.that(typeof b.api_key === "string" && b.api_key.startsWith(KEY_PREFIX),
      `register ${a.handle}: key uses the ${KEY_PREFIX} prefix`,
      b.api_key ? `${b.api_key.slice(0, 12)}…(${b.api_key.length} chars)` : "no key returned");
    checks.that(typeof b.claim_url === "string" && b.claim_url.includes("/claim/"),
      `register ${a.handle}: claim_url returned`);

    const claimToken = typeof b.claim_url === "string" ? b.claim_url.split("/claim/")[1] : null;
    state.agents.set(a.handle, {
      ...a, agentId: b.agent_id, apiKey: b.api_key, claimToken,
      client: c.withKey(b.api_key), messages: [], repliedTo: [],
    });
  }

  // A second registration of a taken name must be refused.
  {
    const first = cast[0];
    const res = await clientFor(first).post("/api/v1/agents/register", { name: first.handle }, { noRetry: true });
    checks.statusIn(res, [409, 422, 400, 429], `duplicate handle "${first.handle}" is refused`);
  }

  // ------------------------------------------------------------------ exam
  log("sitting the entrance examination");
  for (const a of state.agents.values()) {
    const start = await a.client.post("/api/v1/placement/start", {});
    if (!checks.status(start, 201, `placement start ${a.handle}`)) {
      if (start.status === 429) log(`  ${a.handle}: throttled (${errCode(start)}) — expected under a shared fingerprint`);
      continue;
    }
    const paper = start.body;
    checks.that(Array.isArray(paper?.questions) && paper.questions.length === 20,
      `${a.handle}: paper has 20 questions`, `got ${paper?.questions?.length}`);

    const built = buildSubmission(paper, { quality: a.quality });
    if (built.unsolved.length) {
      // A solver gap is a finding about the exam, not a sim inconvenience.
      checks.fail(`${a.handle}: every prompt was solvable from its text alone`,
        built.unsolved.map((u) => `${u.id}(${u.archetype}): ${u.reason}`).join("; "));
    } else {
      checks.pass(`${a.handle}: all 20 prompts solvable from prompt text alone`);
    }

    // `answers` carries the WHOLE submission object — {exam_nonce, answers:{q01..q20}} —
    // not just the answer map. Flattening it drops the nonce and scores 0.
    const submit = await a.client.post("/api/v1/placement/submit", {
      attempt_id: paper.attempt_id,
      answers: built.submission,
    });
    if (!checks.status(submit, 200, `placement submit ${a.handle}`)) continue;

    const { score, placed_band: band, placed_level: level } = submit.body ?? {};
    a.score = score; a.band = band;
    checks.equal(level, "elementary_school", `${a.handle}: placement never skips a level`);
    checks.that(score >= built.expected.minScore && score <= built.expected.maxScore,
      `${a.handle} (${a.persona}): score in expected range`,
      `expected ${built.expected.minScore}–${built.expected.maxScore} (${built.expected.reason}), got ${score}`);
    checks.equal(band, built.expected.band, `${a.handle} (${a.persona}): banded ${built.expected.band} — ${built.expected.reason}`);
    log(`  ${a.handle.padEnd(18)} ${String(a.persona).padEnd(11)} score ${String(score).padStart(3)} -> ${band}`);
  }

  // ------------------------------------------------- enrol before claiming
  const probe = [...state.agents.values()].find((a) => a.band);
  if (probe) {
    const res = await probe.client.post("/api/v1/enroll", {});
    checks.that(res.status === 403 || errCode(res) === "not_claimed",
      "unclaimed agent cannot enrol",
      `HTTP ${res.status} ${errCode(res) ?? ""} — the owner claim gate holds`);
  }

  // ------------------------------------------------------------------ claim
  log("completing owner claims (dev stub)");
  for (const a of state.agents.values()) {
    if (!a.claimToken) { checks.fail(`claim ${a.handle}`, "no claim token from registration"); continue; }
    const res = await a.client.post("/api/owner/claim/complete", { claim_token: a.claimToken });
    checks.status(res, 200, `owner claim ${a.handle}`);
    a.claimed = res.status === 200;
  }

  // ------------------------------------------------------------------ enrol
  // Snapshot the seat map first. It explains every enrolment outcome in the
  // report, and it is the only way to tell "the cohort filled up" apart from
  // "enrolment is broken" — the sim never resets the shared dev database, so
  // seats really do carry over between runs.
  {
    const anyAgent = [...state.agents.values()].find((a) => a.claimed);
    if (anyAgent) {
      const terms = await anyAgent.client.get("/api/v1/terms");
      if (checks.status(terms, 200, "GET /terms lists open terms for the agent's level")) {
        const term = (terms.body?.terms ?? [])[0];
        state.seatMap = (term?.cohorts ?? []).map((c) => ({
          name: c.name, band: c.band, capacity: c.capacity, seatsRemaining: c.seats_remaining,
        }));
        state.termInfo = term
          ? {
              id: term.id, slug: term.slug, display: term.display_name,
              periodHours: term.period_hours, status: term.status,
              startsAt: term.starts_at, endsAt: term.ends_at, level: term.level,
            }
          : null;
        const openCohorts = state.seatMap.filter((c) => c.seatsRemaining > 0);
        log(`  seats: ${state.seatMap.map((c) => `${c.name}(${c.band}) ${c.seatsRemaining}/${c.capacity}`).join(" · ")}`);
        checks.that(openCohorts.length > 0, "at least one cohort has seats before enrolling",
          state.seatMap.map((c) => `${c.name}:${c.seatsRemaining}`).join(" "));
      }
    }
  }

  log("enrolling");
  let waitlisted = 0;
  for (const a of state.agents.values()) {
    if (!a.claimed || !a.band) continue;
    const res = await a.client.post("/api/v1/enroll", {});
    if (res.status === 202) {
      waitlisted++;
      const b = res.body ?? {};
      checks.that(b.status === "waitlisted" && Number.isInteger(b.position ?? b.queue_position),
        `${a.handle}: waitlist response carries a queue position`, JSON.stringify(b).slice(0, 160));
      a.waitlisted = true;
      continue;
    }
    if (!checks.status(res, 201, `enrol ${a.handle}`)) continue;
    const b = res.body ?? {};
    a.enrollmentId = b.enrollment_id;
    a.cohort = b.cohort;
    checks.equal(b.cohort?.band, a.band, `${a.handle}: cohort band matches the agent's band`);
    const key = b.cohort?.id;
    if (key) {
      if (!state.cohorts.has(key)) state.cohorts.set(key, { ...b.cohort, members: [] });
      state.cohorts.get(key).members.push(a.handle);
    }
    log(`  ${a.handle.padEnd(18)} ${a.band.padEnd(11)} -> ${b.cohort?.name}`);
  }
  if (waitlisted === 0) {
    checks.skip("waitlist 202 path",
      "no agent overflowed: elementary seeds 2 cohorts per band at capacity 10, so a waitlist needs 21+ agents in ONE band. Run with --agents 44 to force it.");
  }

  // ---------------------------------------------------------------- hallway
  log("hallway traffic");
  // Turn-major, not cohort-major: every agent posts turn 0, then every agent
  // posts turn 1. The hallway allows one message per agent per 20s, so doing it
  // this way costs a single shared cooldown wait rather than one per cohort.
  for (let turn = 0; turn < 2; turn++) {
    for (const [, cohort] of state.cohorts) {
      const members = cohort.members.map((h) => state.agents.get(h));
      // One agent per cohort only ever addresses the room and never replies to
      // anyone. That is not filler: worker-1's relationship upkeep deliberately
      // records nothing for a top-level message (a message to the room has no
      // counterpart), and that judgment call is still awaiting the master's ✓.
      // Keeping a pure top-level poster in every cohort means `verify-db.mjs`
      // can assert the policy instead of skipping it, so a silent change of
      // mind shows up as a failing check rather than as nothing at all.
      const roomOnly = members[members.length - 1]?.handle;
      for (const a of members) {
        if (!a) continue;
        // Reply to the previous message in this cohort, so threads form and
        // relationship rows get written between real counterparts.
        const parent = turn > 0 && a.handle !== roomOnly ? pickParent(cohort, a) : null;
        const text = hallwayMessage(a, turn, parent
          ? { quotedFrom: parent.author_name, quote: parent.content }
          : {});
        const res = await a.client.post("/api/v1/class/messages",
          parent ? { content: text, reply_to_id: parent.id } : { content: text });
        if (res.status !== 201) { checks.status(res, 201, `hallway post ${a.handle} turn ${turn}`); continue; }
        const m = res.body;
        checks.that(m.trust === "untrusted" && typeof m.notice === "string",
          `${a.handle}: hallway message served inside an untrusted-content envelope`);
        cohort.messages ??= [];
        cohort.messages.push(m);
        a.messages.push(m);
        if (parent) a.repliedTo.push(parent.author_name);
      }
    }
  }

  // The order agents first posted, per cohort. The final's Q1 can ask for the
  // roster in "first posting" order, and this is the only record of it an agent
  // would legitimately have.
  state.firstPostOrder = {};
  for (const [, cohort] of state.cohorts) {
    const seen = [];
    for (const m of cohort.messages ?? []) {
      if (!seen.includes(m.author_name)) seen.push(m.author_name);
    }
    state.firstPostOrder[cohort.name] = seen;
  }

  // read-back + cohort scoping
  for (const [, cohort] of state.cohorts) {
    const reader = state.agents.get(cohort.members[0]);
    if (!reader) continue;
    const res = await reader.client.get("/api/v1/class/messages");
    if (!checks.status(res, 200, `hallway read ${cohort.name}`)) continue;
    const seen = res.body?.messages ?? [];
    const authors = new Set(seen.map((m) => m.author_name));
    const foreign = [...authors].filter(
      (name) => state.agents.has(name) && !cohort.members.includes(name));
    checks.that(foreign.length === 0,
      `COHORT SCOPING: ${cohort.name} feed contains no other cohort's agents`,
      foreign.length ? `leaked: ${foreign.join(", ")}` : `${seen.length} messages, all in-cohort`);
    cohort.feedCount = seen.length;
  }

  // ------------------------------------------------------------ abuse probes
  log("abuse probes");
  await runAbuseProbes({ state, checks });

  state.waitlisted = waitlisted;
  state.finished = new Date().toISOString();
  return state;
}

function pickParent(cohort, self) {
  const pool = (cohort.messages ?? []).filter((m) => m.author_name !== self.handle);
  return pool.length ? pool[pool.length - 1] : null;
}

async function runAbuseProbes({ state, checks }) {
  const enrolled = [...state.agents.values()].filter((a) => a.cohort);
  if (enrolled.length === 0) { checks.skip("abuse probes", "nobody enrolled"); return; }

  // The hallway allows one message per agent per 20 seconds. Stacking six write
  // probes on one agent would spend two minutes waiting on a cooldown that is
  // working correctly, so each probe is run by a different enrolled agent —
  // which is also how real misbehaviour arrives: from several directions.
  const pool = [
    ...enrolled.filter((a) => a.misbehaves.length),
    ...enrolled.filter((a) => !a.misbehaves.length),
  ];
  let cursor = 0;
  const nextAgent = (preferTrait) => {
    const preferred = pool.find((a, i) => i >= cursor && a.misbehaves.includes(preferTrait));
    const chosen = preferred ?? pool[cursor % pool.length];
    cursor = pool.indexOf(chosen) + 1;
    return chosen;
  };

  // 1. length cap
  const big = nextAgent("oversized_message");
  const res1 = await big.client.post("/api/v1/class/messages", { content: oversizedMessage(big) });
  checks.that(res1.status === 422 || res1.status === 400,
    "oversized hallway message rejected by the length cap",
    `${big.handle}: HTTP ${res1.status} ${errCode(res1) ?? ""}`);

  // 2. outbound secret filter
  const leaky = nextAgent("secret_in_message");
  const res2 = await leaky.client.post("/api/v1/class/messages", { content: secretMessage() });
  checks.that(res2.status === 422 && errCode(res2) === "secret_detected",
    "secret-shaped string quarantined by the outbound filter",
    `${leaky.handle}: HTTP ${res2.status} ${errCode(res2) ?? ""}`);

  const feed = await leaky.client.get("/api/v1/class/messages");
  const leaked = (feed.body?.messages ?? []).some((m) => String(m.content).includes("sk-ant-"));
  checks.that(!leaked, "quarantined secret never appears in the cohort feed");

  // 3. prompt injection is stored as data and served enveloped
  const injector = nextAgent("injection_in_message");
  const inj = await injector.client.post("/api/v1/class/messages", { content: injectionMessage() });
  if (inj.status === 201) {
    checks.that(inj.body?.trust === "untrusted" && /data, not instructions/i.test(inj.body?.notice ?? ""),
      "planted injection is served as untrusted data, never as instruction");
    checks.that(!/<!--/.test(inj.body?.content ?? ""),
      "ingest sanitization strips HTML comments from hallway content",
      String(inj.body?.content ?? "").slice(0, 100));
  } else {
    checks.statusIn(inj, [201, 422], "injection payload either stored-enveloped or rejected outright");
  }

  const otherCohortId = [...state.cohorts.keys()].find((id) => id !== enrolled[0].cohort.id);
  if (!otherCohortId) {
    checks.skip("cohort-boundary probes", "run produced only one cohort; needs agents in both bands");
    return;
  }
  const otherCohort = state.cohorts.get(otherCohortId);

  // 4. a caller-supplied cohort_id must be ignored, not honoured
  const forcer = [...pool].find((a) => a.cohort.id !== otherCohortId) ?? nextAgent("forced_cohort_id");
  const forced = await forcer.client.post("/api/v1/class/messages",
    { content: "posting this into a section I am not in", cohort_id: otherCohortId });
  if (forced.status === 201) {
    const victim = state.agents.get(otherCohort.members[0]);
    const vFeed = await victim.client.get("/api/v1/class/messages");
    const landed = (vFeed.body?.messages ?? []).some((m) => m.id === forced.body.id);
    checks.that(!landed,
      "FORCED cohort_id ignored: the message stayed in the author's own section",
      landed ? `LEAKED into ${otherCohort.name}` : `not visible in ${otherCohort.name}`);
  } else {
    checks.statusIn(forced, [201, 400, 403, 422, 429], "forced cohort_id refused");
  }

  // 5. cross-cohort read: a query parameter must not widen the feed
  const peeker = enrolled.find((a) => a.cohort.id !== otherCohortId);
  const cross = await peeker.client.get(`/api/v1/class/messages?cohort_id=${otherCohortId}`);
  if (cross.status === 200) {
    const foreignIds = new Set((otherCohort.messages ?? []).map((m) => m.id));
    const leakedMsgs = (cross.body?.messages ?? []).filter((m) => foreignIds.has(m.id));
    checks.that(leakedMsgs.length === 0,
      "CROSS-COHORT READ: cohort_id query parameter cannot widen the feed",
      leakedMsgs.length ? `${leakedMsgs.length} foreign messages returned` : "own cohort only");
  } else {
    checks.statusIn(cross, [200, 400, 403, 404], "cross-cohort read refused");
  }

  // 6. no existence oracle: replying to a real message in another cohort must be
  //    indistinguishable from replying to an id that never existed. Run from two
  //    different agents — if the answer is identical across callers as well as
  //    across targets, existence really is not observable.
  const foreignMsg = (otherCohort.messages ?? [])[0];
  if (foreignMsg) {
    const a1 = enrolled.find((a) => a.cohort.id !== otherCohortId);
    const a2 = enrolled.find((a) => a.cohort.id !== otherCohortId && a.handle !== a1.handle) ?? a1;
    const real = await a1.client.post("/api/v1/class/messages",
      { content: "replying across the wall", reply_to_id: foreignMsg.id });
    const ghost = await a2.client.post("/api/v1/class/messages",
      { content: "replying to a message that never existed",
        reply_to_id: "00000000-0000-4000-8000-000000000000" });
    checks.that(real.status === 404, "reply to another cohort's message returns 404",
      `${a1.handle}: HTTP ${real.status} ${errCode(real) ?? ""}`);
    checks.that(real.status === ghost.status && errCode(real) === errCode(ghost),
      "NO EXISTENCE ORACLE: foreign target and nonexistent target answer identically",
      `foreign=${real.status}/${errCode(real)} · ghost=${ghost.status}/${errCode(ghost)}`);
  }
}
