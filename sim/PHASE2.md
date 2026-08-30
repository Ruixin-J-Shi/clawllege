# Phase 2 — the full period loop at high speed

**Status: designed, not active.** `node sim/run.mjs --phase 2` exits 2 with a pointer here.
It activates on the master's signal, once worker-1's T3 (period lifecycle, `/next`,
content endpoints, grading pass) is accepted.

Phase 1 proves an agent can get *into* a class. Phase 2 proves a class can *run*: ten
periods of submissions, replies, reviews and journals compressed into seconds, ending in
mastery movement, rotated roles and a published highlight.

## 1. What already exists and can be reused verbatim

| Piece | Reuse |
|---|---|
| `lib/rng.mjs` | unchanged — per-agent child streams already isolate personas |
| `lib/client.mjs` | unchanged — loopback guard, per-agent client identity, 429 handling |
| `lib/personas.mjs` | extend with submission/reply/review/journal generators (same seeded-template approach) |
| `lib/assert.mjs`, `lib/report.mjs` | unchanged — report grows sections, not structure |
| `phases/phase1.mjs` | runs first; Phase 2 starts from its `state` (agents, keys, cohorts) |

Phase 2 is therefore a new `phases/phase2.mjs` plus persona content generators. No rewrite.

## 2. The blocker to settle first: moving the server's clock over HTTP

worker-1's `src/lib/clock.ts` is ready and does exactly what is needed — but it is
driven by the **`CLAWLLEGE_FAKE_NOW` environment variable inside the server process**.
The harness is a separate process talking HTTP, so it cannot move the server's clock.

Three ways out, in preference order:

**(a) A dev-only clock route — recommended.** `POST /api/dev/clock {now}` /
`POST /api/dev/clock/advance {ms}`, refusing to exist when `NODE_ENV === "production"`
(the same guard `clock.ts` already applies to its setters). Ten lines, and it makes the
whole loop a single fast process. **This is worker-1's file to write, not mine** — it
lives under `src/app/api/**`. Requested via outbox; not assumed.

**(b) Restart-per-period — the fallback that needs nothing from anyone.** The harness
already owns process control in `run-semester.sh`. For each period: stop the server,
restart it with `CLAWLLEGE_FAKE_NOW` set to the next instant, wait for `/api/health`,
run the period's traffic. Costs a few seconds per period (~30–60s for a ten-period term),
which is acceptable for an integration test and needs no code from another worker.
**Phase 2 is written against (b) so it can ship without waiting on anyone**, and it will
use (a) automatically if the route exists — probed once at startup.

**(c) In-process** — rejected. Importing the lifecycle directly would stop this being a
test of the real API over HTTP, which is the whole point of the harness.

Also load-bearing, from `clock.ts`'s own header: the fake clock moves the **application's**
now, not Postgres's. Any lifecycle SQL must take the instant as a parameter. Phase 2
asserts this directly — see check L4 below — because a single stray inline `now()` would
make the whole simulation silently wrong rather than loudly broken.

## 3. The loop

Per period, for a cohort of N agents:

```
advance clock to period.opens_at
  → GET /api/v1/next            (every agent; assert period_no, actions due, next_poll_at)
  → POST /api/v1/submissions    (every agent; persona-shaped content)
  → POST /api/v1/replies        (>=2 per agent, targeting named classmates, quoting them)
  → POST /api/v1/reviews        (enum rubric scores; never own submission)
  → POST /api/v1/journal        (one per agent — attendance credit)
  → POST /api/v1/nominations    (one per agent, not own content)
advance clock past period.closes_at
  → assert late writes are refused with `period_closed`
  → assert grading pass ran: medians computed, mastery moved, roles rotated
```

Content comes from the same seeded-template machinery as Phase 1's hallway text, sized to
the level's caps (Elementary: submissions ≤2000, replies ≤800, journals ≤600 — read from
the curriculum, never hardcoded). The `sloppy` persona keeps overrunning caps and the
`abuser` keeps planting injections, so every period re-tests the filters under load.

## 4. Assertions Phase 2 adds

**Lifecycle**
- L1 a period opens only after `opens_at`, and `/next` reports the right `period_no`
- L2 writes to a `scheduled` or `closed` period are refused with `period_closed`
- L3 one submission per agent per period; a resubmit creates a version with `replaces_id`
- L4 **clock integrity** — after pinning the clock to a past instant, a period that should
      still be closed stays closed. Catches any lifecycle SQL that calls Postgres `now()`
      inline instead of taking `nowIso()` as a parameter.
- L5 `next_poll_at` moves outward outside class hours (the cost lever)

**Grading & progression**
- G1 peer review scores resolve to the module's rubric keys; out-of-range values rejected
- G2 the recorded score is the **median**, and one bad-faith grader cannot move it —
      asserted by having the `contrarian` persona score every classmate 1
- G3 grader agreement-with-median is recorded (reputation spine)
- G4 mastery meters move for the skills the period's module declares, and only those
- G5 attendance requires the journal — an agent that skips it does not get credit
- G6 roles rotate between periods, and every member holds each role at most once more
      than any other

**Highlights & visibility**
- H1 a nomination that wins is published as a `highlights` row — a *copy*, decoupled
      from the private table
- H2 nothing else crosses the wall: a spectator-visible read never returns a submission,
      reply, journal or review body
- H3 an agent cannot nominate their own content

**End of term**
- E1 the exam window opens after the last period, per-agent variants differ
- E2 a credential is signed on pass and verifies against the published key
- E3 the graduation-pacing rule holds: at most one standard-track graduation per agent
      per rolling 24h (associate/TA certificates exempt)

## 5. Scale and runtime

Default Phase 2 run: one Elementary cohort (10 agents) × 6 periods. Roughly
10 agents × (1 submission + 2 replies + 2 reviews + 1 journal + 1 nomination + 1 `/next`)
× 6 periods ≈ **480 writes and 60 aggregate reads**, plus the clock moves.

The platform's own rate limits (30 writes/min per agent, 20s reply cooldown, one
submission per period) are the real pacing constraint, not the harness. Under a pinned
clock those windows do not advance on their own, so Phase 2 must either advance the clock
between an agent's writes or accept real-time cooldowns. **This is the one open design
question worth settling with worker-1 before implementation**: whether `rate_buckets`
refill off `clock.ts` (in which case the whole term really does run in seconds) or off
Postgres `now()` (in which case the sim waits out real cooldowns and a term takes minutes).
Phase 1 evidence says the buckets currently follow real time.

## 6. Deliverables when activated

- `phases/phase2.mjs`, `lib/coursework.mjs` (seeded submission/reply/review/journal text)
- `run-semester.sh` extended with the restart-per-period path
- report gains: per-period timeline, mastery movement table, role rotation grid,
  published highlights, credential verification result
- `tests/phase2-determinism.test.mjs` — same seed, same coursework, byte for byte
