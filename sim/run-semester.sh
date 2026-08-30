#!/usr/bin/env bash
# One command for a whole simulated term.
#
#   bash sim/run-semester.sh [--agents N] [--seed S] [--port P]
#
# Sequence, and why it is this sequence:
#   1. start next dev with DATABASE_URL explicitly EMPTY  — .env.local can carry a live
#      Supabase URL, and this harness writes agents, keys and enrolments. Emptying the
#      variable pins the server to the local PGlite dev database. Never remove this.
#   2. run the HTTP phase                                 — pure transport, asserts as it goes
#   3. STOP the server                                    — PGlite is single-writer
#   4. run the relationship verification                  — direct read, only possible once (3) is done
#
# Never resets or seeds the database: it is shared with the other build sessions.
set -uo pipefail

AGENTS=12
SEED="fall-26"
PORT=3333
while [ $# -gt 0 ]; do
  case "$1" in
    --agents) AGENTS="$2"; shift 2 ;;
    --seed)   SEED="$2";   shift 2 ;;
    --port)   PORT="$2";   shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

SIM_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$SIM_DIR")"
LOG="$(mktemp -t clawllege-sim-server)"
SERVER_PID=""

# `npm run dev` spawns next-server as a CHILD: killing the npm wrapper alone
# leaves the real server holding the port, which then blocks the next run. So
# stop the wrapper and then anything still listening on our own port. Scoped to
# $PORT deliberately — it must never touch another session's server.
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "  stopping dev server (pid $SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  local stragglers
  stragglers="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$stragglers" ]; then
    echo "  stopping child server still on port $PORT: $stragglers"
    kill $stragglers 2>/dev/null || true
    sleep 1
  fi
}
trap cleanup EXIT INT TERM

# The simulator runs against its OWN PGlite database. `src/lib/db.ts` and
# `scripts/seed.mjs` both honour PGLITE_DATA_DIR, so this isolates the run
# completely: another session's `npm run db:reset` cannot delete the data this
# run is about to assert on, and every run starts from a freshly seeded term.
export PGLITE_DATA_DIR="$SIM_DIR/.pglite-sim"

echo "→ preparing the sim database (isolated from the shared .pglite)"
( cd "$APP_DIR" && DATABASE_URL= node sim/prepare-db.mjs --fresh ) || exit 3

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use — refusing to start a second server on it." >&2
  echo "Either stop it, or run the phases by hand against the server that is already there." >&2
  exit 2
fi

echo "→ starting dev server on port $PORT (local PGlite only)"
( cd "$APP_DIR" && DATABASE_URL= PGLITE_DATA_DIR="$PGLITE_DATA_DIR" npm run dev -- --port "$PORT" >"$LOG" 2>&1 ) &
SERVER_PID=$!

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "server never became healthy. Log:" >&2; tail -30 "$LOG" >&2; exit 3
fi
echo "  healthy"

echo "→ running phase 1"
( cd "$APP_DIR" && node sim/run.mjs --phase 1 --agents "$AGENTS" --seed "$SEED" \
    --base-url "http://127.0.0.1:$PORT" )
PHASE1_RC=$?

echo "→ stopping the server so the database can be read"
cleanup
SERVER_PID=""
sleep 1

echo "→ verifying relationship upkeep"
( cd "$APP_DIR" && DATABASE_URL= PGLITE_DATA_DIR="$PGLITE_DATA_DIR" node sim/verify-db.mjs )
VERIFY_RC=$?

echo
if [ "$PHASE1_RC" -eq 0 ] && [ "$VERIFY_RC" -eq 0 ]; then
  echo "SEMESTER PASS"
  exit 0
fi
echo "SEMESTER FAIL — phase1 rc=$PHASE1_RC verify rc=$VERIFY_RC"
exit 1
