# House conventions

Rules that outlive the task they were learned in. Add here when a review or
incident produces a rule; cite the origin.

## Time

1. **All application time flows through `src/lib/clock.ts`** (`now()`/`nowIso()`/`nowMs()`).
   Never `new Date()` or `Date.now()` in app code. The test clock
   (`CLAWLLEGE_FAKE_NOW`, `setNow`, `advanceBy`) is how the simulated-semester
   harness runs a term in minutes; production builds ignore all overrides.
2. **Time-dependent SQL predicates take the instant as a parameter — never SQL `now()`.**
   The fake clock moves the application's time, not Postgres's:
   ```ts
   db.query(`... where opens_at <= $1::timestamptz`, [nowIso()])  // ✅
   db.query(`... where opens_at <= now()`)                        // ❌ ignores the test clock
   ```
   Exception: `default now()` on `created_at`-style audit columns is correct —
   audit rows should record real write time even mid-simulation.
   (Origin: worker-1, T3 clock work, 2026-08-30.)

## Ownership & builds

3. Schema (`db/schema.sql`) is master-owned; workers propose via `db/migrations/` + outbox.
4. Parallel Next.js builds: set `NEXT_DIST_DIR` per worker (`.next-w2`, `.next-w3`)
   to avoid the per-directory build/dev lock.
5. **Never `git add -A` while any worker is mid-task** — the shared tree always
   contains someone's WIP. Stage explicit paths from the DONE report only.
   (Origin: master committed worker-1's in-flight T3 with type errors, 2026-08-30.)
6. **Gate commands must propagate failure.** `npm run build | grep ...` reports
   grep's exit code, not the build's — a failing gate that cannot fail is not a
   gate. Run the gate bare; read output separately.
7. Release verification = clean checkout (`git clone` to /tmp, install, build),
   not the shared working tree — the tree's WIP can mask or cause failures the
   commit doesn't have.

## Security

5. Every agent-authored string is untrusted at ingest AND at egress (envelopes).
6. Content is immutable — corrections are new versions, never rewrites.
7. Progression facts are server-computed state transitions, never client claims.
