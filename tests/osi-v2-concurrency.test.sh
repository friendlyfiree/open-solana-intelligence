#!/usr/bin/env bash
#
# OSI V2 Stage-5 nonce concurrency and replay integration test.
#
# This is a REAL two-connection race against a disposable local PostgreSQL
# database. It is not a textual or single-connection simulation.
#
#   Connection 1 opens a transaction, consumes one signed nonce, and holds the
#   transaction open (row lock on the nonce still held).
#   Connection 2 races the exact same nonce/signature and blocks on that lock.
#   After connection 1 commits, connection 2 unblocks and must observe the
#   original receipt as an idempotent replay, never a second effect.
#
# Asserted invariants (Stage-5 / AGENTS.md section 8):
#   * exactly one event_receipts row exists for the nonce;
#   * both connections return the same receipt id;
#   * connection 1 is the original effect (idempotent_replay = false);
#   * connection 2 is an idempotent replay (idempotent_replay = true);
#   * the second connection genuinely waited on connection 1's lock;
#   * changed receipt/signature data cannot create another effect;
#   * the native receipt is wallet-signed and server-verified, never on-chain.
#
# The database is disposable. In CI it is started, reset from zero, and stopped
# by the workflow. This script enables the proof flag only inside that throwaway
# database to exercise the path, then restores the fail-closed default.
#
# Connection target (default = Supabase local database):
#   OSI_TEST_DATABASE_URL, else postgresql://postgres:postgres@127.0.0.1:54322/postgres

set -euo pipefail

DB_URL="${OSI_TEST_DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
HOLD_SECONDS="${OSI_CONCURRENCY_HOLD_SECONDS:-6}"

WORKDIR="$(mktemp -d)"
C1_OUT="$WORKDIR/conn1.out"
C2_OUT="$WORKDIR/conn2.out"
HOLD_MARKER="$WORKDIR/conn1_holding.marker"

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }
assert_eq() { # name expected actual
  if [ "$2" = "$3" ]; then pass "$1 ($3)"; else fail "$1 — expected [$2] got [$3]"; fi
}

psql_run() { psql "$DB_URL" -v ON_ERROR_STOP=1 -X -q -tA "$@"; }

cleanup() {
  # Restore the fail-closed default. The disposable database is discarded by CI;
  # this keeps the flag correct for anything that reuses the same local database.
  psql "$DB_URL" -X -q -tA \
    -c "update public.osi_config set value='false' where key in ('OSI_V2_PROOF_ENABLED','OSI_V2_ANALYST_WRITES_ENABLED');" \
    >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# --- deterministic, format-valid test values ----------------------------------
NONCE="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"   # 43 url-safe chars
WALLET="11111111111111111111111111111112"                                  # 32-char base58
TARGET_ID="$(cat /proc/sys/kernel/random/uuid)"
PAYLOAD_HASH="$(printf 'a%.0s' $(seq 1 64))"                                # 64 lowercase hex
FINGERPRINT="$(printf 'c%.0s' $(seq 1 64))"                                # 64 lowercase hex
IDEM="osi-v2-concurrency-$(date +%s%N)"                                     # matches idem check
SIG_OK="$(printf 'A%.0s' $(seq 1 88))"                                      # 88 chars (len 64-256)
SIG_CHANGED="$(printf 'B%.0s' $(seq 1 88))"                                 # different signature

echo "OSI V2 Stage-5 concurrency test"
echo "  database : ${DB_URL%%\?*}"
echo "  nonce    : $NONCE"

# --- arrange: enable proof (throwaway DB only) and issue one bound nonce -------
psql_run >/dev/null <<SQL
update public.osi_config set value = 'true' where key = 'OSI_V2_PROOF_ENABLED';
select public.osi_v2_issue_nonce(
  '$NONCE', 'CHALLENGE_SUBMITTED', '$WALLET', 'challenge',
  '$TARGET_ID', '$PAYLOAD_HASH', '$IDEM', '$FINGERPRINT'
);
SQL

# --- connection 1: consume, then HOLD the open transaction --------------------
psql "$DB_URL" -v ON_ERROR_STOP=1 -X -q <<SQL >/dev/null 2>&1 &
\pset tuples_only on
\pset format unaligned
begin;
select receipt_id::text || ' ' || idempotent_replay::text
  from osi_private.osi_v2_consume_signed_nonce(
    '$NONCE', '$SIG_OK', 'wallet', null, null::numeric, null, null)
\g $C1_OUT
\! touch $HOLD_MARKER
select pg_sleep($HOLD_SECONDS);
commit;
SQL
CONN1_PID=$!

# wait until connection 1 has actually consumed and is holding the transaction
waited=0
while [ ! -f "$HOLD_MARKER" ]; do
  sleep 0.2
  waited=$((waited + 1))
  if [ "$waited" -gt 150 ]; then
    fail "connection 1 never reached the holding state"
    wait "$CONN1_PID" 2>/dev/null || true
    exit 1
  fi
done

# --- connection 2: race the exact same nonce/signature (must block on lock) ----
psql "$DB_URL" -v ON_ERROR_STOP=1 -X -q <<SQL >/dev/null 2>&1 &
\pset tuples_only on
\pset format unaligned
begin;
select receipt_id::text || ' ' || idempotent_replay::text
  from osi_private.osi_v2_consume_signed_nonce(
    '$NONCE', '$SIG_OK', 'wallet', null, null::numeric, null, null)
\g $C2_OUT
commit;
SQL
CONN2_PID=$!

# prove the race: connection 2 must be waiting on a lock while connection 1 holds
sleep 1
RACE_WAITERS="$(psql_run -c "
  select count(*) from pg_stat_activity
   where wait_event_type = 'Lock'
     and query ilike '%osi_v2_consume_signed_nonce%';")"
if [ "${RACE_WAITERS:-0}" -ge 1 ]; then
  pass "second connection genuinely blocked on the first connection's lock"
else
  fail "second connection did not block on a lock (RACE_WAITERS=$RACE_WAITERS)"
fi

# let both connections finish (connection 1 commits after its hold)
wait "$CONN1_PID"
wait "$CONN2_PID"

# --- collect results ----------------------------------------------------------
read -r R1 REPLAY1 < "$C1_OUT"
read -r R2 REPLAY2 < "$C2_OUT"
echo "  conn1    : receipt=$R1 replay=$REPLAY1"
echo "  conn2    : receipt=$R2 replay=$REPLAY2"

RECEIPT_COUNT="$(psql_run -c "select count(*) from public.event_receipts where nonce = '$NONCE';")"

# --- assertions ---------------------------------------------------------------
assert_eq "exactly one event_receipts row exists" "1" "$RECEIPT_COUNT"
assert_eq "both connections return the same receipt id" "$R1" "$R2"
assert_eq "connection 1 is the original effect" "false" "$REPLAY1"
assert_eq "connection 2 is an idempotent replay" "true" "$REPLAY2"

if [ -n "$R1" ] && [ "$R1" = "$R2" ] && [ "$R1" != "" ]; then
  pass "receipt id is a real uuid shared by both calls"
else
  fail "receipt id was not shared"
fi

# native signMessage receipt is verified but never labeled on-chain
HONESTY="$(psql_run -c "
  select (server_verified is true
          and proof_type = 'wallet_signed_server_verified'
          and tx_sig is null)::text
    from public.event_receipts where nonce = '$NONCE';")"
assert_eq "receipt is wallet-signed, server-verified, never on-chain" "true" "$HONESTY"

# --- changed receipt/signature cannot create another effect -------------------
CHANGED_SIG_ERR="$(psql "$DB_URL" -X -q -tA -c "
  select * from osi_private.osi_v2_consume_signed_nonce(
    '$NONCE', '$SIG_CHANGED', 'wallet', null, null::numeric, null, null);" 2>&1 || true)"
if printf '%s' "$CHANGED_SIG_ERR" | grep -q 'Consumed nonce cannot be replayed with changed receipt data'; then
  pass "changed signature is rejected (no new effect)"
else
  fail "changed signature was not rejected: $CHANGED_SIG_ERR"
fi

CHANGED_REF_ERR="$(psql "$DB_URL" -X -q -tA -c "
  select * from osi_private.osi_v2_consume_signed_nonce(
    '$NONCE', '$SIG_OK', 'wallet', null, null::numeric, null, 'OSI-CHANGED1');" 2>&1 || true)"
if printf '%s' "$CHANGED_REF_ERR" | grep -q 'Consumed nonce cannot be replayed with changed receipt data'; then
  pass "changed receipt public_ref is rejected (no new effect)"
else
  fail "changed public_ref was not rejected: $CHANGED_REF_ERR"
fi

RECEIPT_COUNT_AFTER="$(psql_run -c "select count(*) from public.event_receipts where nonce = '$NONCE';")"
assert_eq "still exactly one receipt after replay attempts" "1" "$RECEIPT_COUNT_AFTER"

# --- durable read nonce: two app instances race the same wallet proof ---------
# This catches the old failure mode where each Edge Function instance kept its
# own in-memory replay cache and accepted the same signed challenge once.
READ_NONCE="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
READ_C1_OUT="$WORKDIR/read-conn1.out"
READ_C2_OUT="$WORKDIR/read-conn2.out"
READ_HOLD_MARKER="$WORKDIR/read-conn1-holding.marker"

psql_run >/dev/null <<SQL
select public.osi_v2_issue_read_nonce(
  '$READ_NONCE', 'CASE_READ_AUTHORIZED_CASE', '$WALLET', 'case',
  'OSI-READRACE01', '$(printf 'd%.0s' $(seq 1 64))'
);
SQL

psql "$DB_URL" -v ON_ERROR_STOP=1 -X -q <<SQL >/dev/null 2>&1 &
\pset tuples_only on
\pset format unaligned
begin;
select public.osi_v2_consume_read_nonce(
  '$READ_NONCE', 'CASE_READ_AUTHORIZED_CASE', '$WALLET', 'case', 'OSI-READRACE01')
\g $READ_C1_OUT
\! touch $READ_HOLD_MARKER
select pg_sleep(3);
commit;
SQL
READ_CONN1_PID=$!

waited=0
while [ ! -f "$READ_HOLD_MARKER" ]; do
  sleep 0.2
  waited=$((waited + 1))
  if [ "$waited" -gt 100 ]; then
    fail "read connection 1 never reached the holding state"
    wait "$READ_CONN1_PID" 2>/dev/null || true
    exit 1
  fi
done

psql "$DB_URL" -v ON_ERROR_STOP=1 -X -q <<SQL >/dev/null 2>&1 &
\pset tuples_only on
\pset format unaligned
begin;
select public.osi_v2_consume_read_nonce(
  '$READ_NONCE', 'CASE_READ_AUTHORIZED_CASE', '$WALLET', 'case', 'OSI-READRACE01')
\g $READ_C2_OUT
commit;
SQL
READ_CONN2_PID=$!

sleep 1
READ_RACE_WAITERS="$(psql_run -c "
  select count(*) from pg_stat_activity
   where wait_event_type = 'Lock'
     and query ilike '%osi_v2_consume_read_nonce%';")"
if [ "${READ_RACE_WAITERS:-0}" -ge 1 ]; then
  pass "second read verifier genuinely blocked on the durable nonce row"
else
  fail "second read verifier did not block on the durable nonce row"
fi

wait "$READ_CONN1_PID"
wait "$READ_CONN2_PID"
READ_RESULT_1="$(tr -d '[:space:]' < "$READ_C1_OUT")"
READ_RESULT_2="$(tr -d '[:space:]' < "$READ_C2_OUT")"
assert_eq "first app instance consumes the read proof" "t" "$READ_RESULT_1"
assert_eq "second app instance rejects the same read proof" "f" "$READ_RESULT_2"

READ_CHANGED_TARGET="$(psql_run -c "
  select public.osi_v2_consume_read_nonce(
    '$READ_NONCE', 'CASE_READ_AUTHORIZED_CASE', '$WALLET', 'case', 'OSI-CHANGED01');")"
assert_eq "changed read target cannot reuse the proof" "f" "$READ_CHANGED_TARGET"

READ_RECEIPTS="$(psql_run -c "select count(*) from public.event_receipts where nonce = '$READ_NONCE';")"
assert_eq "read authorization does not fabricate a Proof Log receipt" "0" "$READ_RECEIPTS"

# --- analyst application: two commits race one exact immutable version --------
APP_NONCE="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
APP_WALLET="77777777777777777777777777777777"
APP_HASH="$(printf 'e%.0s' $(seq 1 64))"
APP_FINGERPRINT="$(printf 'f%.0s' $(seq 1 64))"
APP_IDEM="osi-v2-analyst-race-$(date +%s%N)"
APP_SIG="$(printf 'C%.0s' $(seq 1 88))"
APP_C1_OUT="$WORKDIR/app-conn1.out"
APP_C2_OUT="$WORKDIR/app-conn2.out"
APP_HOLD_MARKER="$WORKDIR/app-conn1-holding.marker"

psql_run >/dev/null <<SQL
update public.osi_config set value = 'true' where key = 'OSI_V2_ANALYST_WRITES_ENABLED';
select public.osi_v2_issue_analyst_nonce(
  '$APP_NONCE', 'ANALYST_APPLICATION_VERSION_SUBMITTED', '$APP_WALLET',
  'wallet', null, '$APP_HASH', '$APP_IDEM', '$APP_FINGERPRINT'
);
SQL

APP_COMMIT_SQL="select receipt_id::text || ' ' || idempotent_replay::text
  from public.osi_v2_commit_analyst_application(
    '$APP_NONCE', '$APP_HASH', '$APP_SIG', 'race_analyst', 'Race Analyst',
    'Public profile used only by the disposable two-connection concurrency test.',
    '[\"osint\"]'::jsonb, '[]'::jsonb,
    '{\"motivation\":\"Concurrency proof payload.\",\"experience\":\"Disposable database test.\"}'::jsonb,
    null, null, null)"

psql "$DB_URL" -v ON_ERROR_STOP=1 -X -q <<SQL >/dev/null 2>&1 &
\pset tuples_only on
\pset format unaligned
begin;
$APP_COMMIT_SQL
\g $APP_C1_OUT
\! touch $APP_HOLD_MARKER
select pg_sleep(3);
commit;
SQL
APP_CONN1_PID=$!

waited=0
while [ ! -f "$APP_HOLD_MARKER" ]; do
  sleep 0.2
  waited=$((waited + 1))
  if [ "$waited" -gt 100 ]; then
    fail "analyst connection 1 never reached the holding state"
    wait "$APP_CONN1_PID" 2>/dev/null || true
    exit 1
  fi
done

psql "$DB_URL" -v ON_ERROR_STOP=1 -X -q <<SQL >/dev/null 2>&1 &
\pset tuples_only on
\pset format unaligned
begin;
$APP_COMMIT_SQL
\g $APP_C2_OUT
commit;
SQL
APP_CONN2_PID=$!

sleep 1
APP_RACE_WAITERS="$(psql_run -c "
  select count(*) from pg_stat_activity
   where wait_event_type = 'Lock'
     and query ilike '%osi_v2_commit_analyst_application%';")"
if [ "${APP_RACE_WAITERS:-0}" -ge 1 ]; then
  pass "second analyst commit genuinely blocked on the nonce row"
else
  fail "second analyst commit did not block on the nonce row"
fi

wait "$APP_CONN1_PID"
wait "$APP_CONN2_PID"
read -r APP_R1 APP_REPLAY1 < "$APP_C1_OUT"
read -r APP_R2 APP_REPLAY2 < "$APP_C2_OUT"
assert_eq "analyst race returns one shared receipt" "$APP_R1" "$APP_R2"
assert_eq "first analyst commit creates the version" "false" "$APP_REPLAY1"
assert_eq "second analyst commit is an idempotent replay" "true" "$APP_REPLAY2"

APP_RECEIPTS="$(psql_run -c "select count(*) from public.event_receipts where nonce = '$APP_NONCE';")"
APP_VERSIONS="$(psql_run -c "
  select count(*) from public.analyst_application_versions
   where created_by_wallet = '$APP_WALLET';")"
assert_eq "analyst race creates exactly one receipt" "1" "$APP_RECEIPTS"
assert_eq "analyst race creates exactly one immutable version" "1" "$APP_VERSIONS"

APP_CHANGED_HASH_ERR="$(psql "$DB_URL" -X -q -tA -c "
  select * from public.osi_v2_commit_analyst_application(
    '$APP_NONCE', '$(printf '0%.0s' $(seq 1 64))', '$APP_SIG',
    'race_analyst', 'Race Analyst',
    'Public profile used only by the disposable two-connection concurrency test.',
    '[\"osint\"]'::jsonb, '[]'::jsonb, '{}'::jsonb,
    null, null, null);" 2>&1 || true)"
if printf '%s' "$APP_CHANGED_HASH_ERR" | grep -q 'Application nonce binding is invalid'; then
  pass "changed analyst payload hash is rejected after the race"
else
  fail "changed analyst payload hash was not rejected: $APP_CHANGED_HASH_ERR"
fi

# --- verdict ------------------------------------------------------------------
echo "----"
if [ "$failures" -eq 0 ]; then
  echo "OK — Stage-5 two-connection concurrency and replay invariants hold"
  exit 0
fi
echo "FAILED — $failures assertion(s) failed"
exit 1
