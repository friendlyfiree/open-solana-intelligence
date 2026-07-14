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
    -c "update public.osi_config set value='false' where key in ('OSI_V2_PROOF_ENABLED','OSI_V2_ANALYST_WRITES_ENABLED','OSI_V2_REPORT_WRITES_ENABLED','OSI_V2_REPORT_REVIEW_WRITES_ENABLED');" \
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

# --- Case Report: one exact Memo nonce races across two commit workers --------
REPORT_CASE_ID="$(cat /proc/sys/kernel/random/uuid)"
REPORT_WALLET="88888888888888888888888888888888"
REPORT_NONCE="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
REPORT_IDEM="osi-v2-report-race-$(date +%s%N)"
REPORT_BODY="This restricted Report concurrency fixture records transaction order wallet relationships uncertainty and evidence limits for exact review."
REPORT_SUMMARY="A public-safe concurrency fixture that remains private before publication."
REPORT_TX="$(printf 'H%.0s' $(seq 1 88))"
REPORT_MEMO="OSI2 test CASE_REPORT_VERSION_SUBMITTED concurrency v1"
REPORT_C1_OUT="$WORKDIR/report-conn1.out"
REPORT_C2_OUT="$WORKDIR/report-conn2.out"
REPORT_HOLD_MARKER="$WORKDIR/report-conn1-holding.marker"

psql_run >/dev/null <<SQL
insert into public.cases (
  id, public_ref, title, category, summary_public, details_restricted,
  submitted_by_wallet, stage, visibility, subject_refs
) values (
  '$REPORT_CASE_ID', 'OSI-RACE12345678', 'Report concurrency fixture', 'other',
  'A public active Case used only by the disposable Report concurrency test.',
  'Restricted disposable Case fixture.',
  '99999999999999999999999999999999', 'open_public', 'public', '[]'::jsonb
);
update public.osi_config set value = 'true' where key = 'OSI_V2_REPORT_WRITES_ENABLED';
update public.osi_config set value = '0' where key = 'OSI_V2_REPORT_COOLDOWN_SECONDS';
select * from public.osi_v2_prepare_report_version(
  '$REPORT_NONCE', '$REPORT_WALLET', '$REPORT_CASE_ID',
  '$REPORT_BODY', '$REPORT_SUMMARY', null,
  jsonb_build_array(jsonb_build_object(
    'kind', 'wallet', 'ref', '$REPORT_WALLET',
    'sha256', encode(extensions.digest(convert_to('$REPORT_WALLET', 'UTF8'), 'sha256'), 'hex')
  )),
  '$REPORT_IDEM', '$(printf '1%.0s' $(seq 1 64))'
);
SQL

REPORT_COMMIT_SQL="select receipt_id::text || ' ' || idempotent_replay::text
  from public.osi_v2_commit_report_version(
    '$REPORT_NONCE', '$REPORT_BODY', '$REPORT_SUMMARY', null,
    jsonb_build_array(jsonb_build_object(
      'kind', 'wallet', 'ref', '$REPORT_WALLET',
      'sha256', encode(extensions.digest(convert_to('$REPORT_WALLET', 'UTF8'), 'sha256'), 'hex')
    )),
    '$REPORT_TX', '$REPORT_MEMO', statement_timestamp())"

psql "$DB_URL" -v ON_ERROR_STOP=1 -X -q <<SQL >/dev/null 2>&1 &
\pset tuples_only on
\pset format unaligned
begin;
$REPORT_COMMIT_SQL
\g $REPORT_C1_OUT
\! touch $REPORT_HOLD_MARKER
select pg_sleep(3);
commit;
SQL
REPORT_CONN1_PID=$!

waited=0
while [ ! -f "$REPORT_HOLD_MARKER" ]; do
  sleep 0.2
  waited=$((waited + 1))
  if [ "$waited" -gt 100 ]; then
    fail "Report connection 1 never reached the holding state"
    wait "$REPORT_CONN1_PID" 2>/dev/null || true
    exit 1
  fi
done

psql "$DB_URL" -v ON_ERROR_STOP=1 -X -q <<SQL >/dev/null 2>&1 &
\pset tuples_only on
\pset format unaligned
begin;
$REPORT_COMMIT_SQL
\g $REPORT_C2_OUT
commit;
SQL
REPORT_CONN2_PID=$!

sleep 1
REPORT_RACE_WAITERS="$(psql_run -c "
  select count(*) from pg_stat_activity
   where wait_event_type = 'Lock'
     and query ilike '%osi_v2_commit_report_version%';")"
if [ "${REPORT_RACE_WAITERS:-0}" -ge 1 ]; then
  pass "second Report commit genuinely blocked on the exact nonce or lineage lock"
else
  fail "second Report commit did not block on a lock"
fi

wait "$REPORT_CONN1_PID"
wait "$REPORT_CONN2_PID"
read -r REPORT_R1 REPORT_REPLAY1 < "$REPORT_C1_OUT"
read -r REPORT_R2 REPORT_REPLAY2 < "$REPORT_C2_OUT"
assert_eq "Report race returns one shared receipt" "$REPORT_R1" "$REPORT_R2"
assert_eq "first Report commit creates the exact version" "false" "$REPORT_REPLAY1"
assert_eq "second Report commit is an idempotent replay" "true" "$REPORT_REPLAY2"

REPORT_COUNTS="$(psql_run -c "
  select count(distinct receipt.id) || ':' || count(distinct report.id) || ':' || count(distinct version.id)
    from public.case_reports report
    join public.case_report_versions version on version.report_id = report.id
    join public.event_receipts receipt on receipt.id = version.event_receipt_id
   where report.case_id = '$REPORT_CASE_ID' and report.author_wallet = '$REPORT_WALLET';")"
assert_eq "Report race creates one receipt one header and one version" "1:1:1" "$REPORT_COUNTS"

REPORT_CHANGED_BODY_ERR="$(psql "$DB_URL" -X -q -tA -c "
  select * from public.osi_v2_commit_report_version(
    '$REPORT_NONCE', '${REPORT_BODY} changed after prepare', '$REPORT_SUMMARY', null,
    jsonb_build_array(jsonb_build_object(
      'kind', 'wallet', 'ref', '$REPORT_WALLET',
      'sha256', encode(extensions.digest(convert_to('$REPORT_WALLET', 'UTF8'), 'sha256'), 'hex')
    )), '$REPORT_TX', '$REPORT_MEMO', statement_timestamp());" 2>&1 || true)"
if printf '%s' "$REPORT_CHANGED_BODY_ERR" | grep -q 'Report content or evidence changed after prepare'; then
  pass "changed Report body cannot reuse the consumed nonce"
else
  fail "changed Report body was not rejected: $REPORT_CHANGED_BODY_ERR"
fi

# Two independently prepared revisions both reserve version 2. The lineage
# lock permits one commit; the stale reservation fails and cannot duplicate the
# version number or advance the header twice.
REV_NONCE_1="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
REV_NONCE_2="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
REV_BODY_1="This first restricted revision adds exact evidence context while preserving uncertainty source limits and the immutable initial Report version."
REV_BODY_2="This second concurrent restricted revision proposes different context but must lose safely if the first revision advances the lineage."
REV_TX_1="$(printf 'J%.0s' $(seq 1 88))"
REV_TX_2="$(printf 'K%.0s' $(seq 1 88))"
REV_C1_OUT="$WORKDIR/revision-conn1.out"
REV_C2_ERR="$WORKDIR/revision-conn2.err"
REV_HOLD_MARKER="$WORKDIR/revision-conn1-holding.marker"

psql_run >/dev/null <<SQL
select * from public.osi_v2_prepare_report_version(
  '$REV_NONCE_1', '$REPORT_WALLET', '$REPORT_CASE_ID',
  '$REV_BODY_1', '$REPORT_SUMMARY', 'new_evidence',
  jsonb_build_array(jsonb_build_object(
    'kind', 'wallet', 'ref', '$REPORT_WALLET',
    'sha256', encode(extensions.digest(convert_to('$REPORT_WALLET', 'UTF8'), 'sha256'), 'hex')
  )), 'osi-v2-report-revision-one-$(date +%s%N)', '$(printf '2%.0s' $(seq 1 64))'
);
select * from public.osi_v2_prepare_report_version(
  '$REV_NONCE_2', '$REPORT_WALLET', '$REPORT_CASE_ID',
  '$REV_BODY_2', '$REPORT_SUMMARY', 'clarification',
  jsonb_build_array(jsonb_build_object(
    'kind', 'wallet', 'ref', '$REPORT_WALLET',
    'sha256', encode(extensions.digest(convert_to('$REPORT_WALLET', 'UTF8'), 'sha256'), 'hex')
  )), 'osi-v2-report-revision-two-$(date +%s%N)', '$(printf '3%.0s' $(seq 1 64))'
);
SQL

psql "$DB_URL" -v ON_ERROR_STOP=1 -X -q <<SQL >/dev/null 2>&1 &
\pset tuples_only on
\pset format unaligned
begin;
select receipt_id::text from public.osi_v2_commit_report_version(
  '$REV_NONCE_1', '$REV_BODY_1', '$REPORT_SUMMARY', 'new_evidence',
  jsonb_build_array(jsonb_build_object(
    'kind', 'wallet', 'ref', '$REPORT_WALLET',
    'sha256', encode(extensions.digest(convert_to('$REPORT_WALLET', 'UTF8'), 'sha256'), 'hex')
  )), '$REV_TX_1', 'OSI2 Report revision race winner', statement_timestamp())
\g $REV_C1_OUT
\! touch $REV_HOLD_MARKER
select pg_sleep(3);
commit;
SQL
REV_CONN1_PID=$!

waited=0
while [ ! -f "$REV_HOLD_MARKER" ]; do
  sleep 0.2
  waited=$((waited + 1))
  if [ "$waited" -gt 100 ]; then
    fail "revision connection 1 never reached the holding state"
    wait "$REV_CONN1_PID" 2>/dev/null || true
    exit 1
  fi
done

psql "$DB_URL" -v ON_ERROR_STOP=1 -X -q -c "
  select * from public.osi_v2_commit_report_version(
    '$REV_NONCE_2', '$REV_BODY_2', '$REPORT_SUMMARY', 'clarification',
    jsonb_build_array(jsonb_build_object(
      'kind', 'wallet', 'ref', '$REPORT_WALLET',
      'sha256', encode(extensions.digest(convert_to('$REPORT_WALLET', 'UTF8'), 'sha256'), 'hex')
    )), '$REV_TX_2', 'OSI2 Report revision race loser', statement_timestamp());" \
  >/dev/null 2>"$REV_C2_ERR" &
REV_CONN2_PID=$!

wait "$REV_CONN1_PID"
wait "$REV_CONN2_PID" 2>/dev/null || true
if grep -q 'Report lineage advanced after prepare' "$REV_C2_ERR"; then
  pass "stale concurrent revision is rejected after the lineage advances"
else
  fail "stale concurrent revision did not fail with the lineage guard"
fi

REVISION_NUMBERS="$(psql_run -c "
  select count(*) || ':' || count(distinct version_no) || ':' || max(version_no)
    from public.case_report_versions version
    join public.case_reports report on report.id = version.report_id
   where report.case_id = '$REPORT_CASE_ID' and report.author_wallet = '$REPORT_WALLET';")"
assert_eq "concurrent revisions leave unique monotonic version numbers" "2:2:2" "$REVISION_NUMBERS"

LOSER_RECEIPTS="$(psql_run -c "select count(*) from public.event_receipts where nonce = '$REV_NONCE_2';")"
assert_eq "losing concurrent revision creates no receipt or partial effect" "0" "$LOSER_RECEIPTS"

# --- Report review: one signMessage nonce races two commit workers ------------
REVIEW_NONCE="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
REVIEW_WALLET="66666666666666666666666666666666"
REVIEW_VERSION_ID="$(psql_run -c "select current_version_id from public.case_reports where case_id='$REPORT_CASE_ID' and author_wallet='$REPORT_WALLET';")"
REVIEW_REASON="evidence_reviewed"
REVIEW_RATIONALE="The exact immutable Report version and its stated evidence limits were independently reviewed."
REVIEW_MESSAGE="OSI2 test CASE_REPORT_REVIEW_CAST concurrency"
REVIEW_SIG="$(printf 'L%.0s' $(seq 1 88))"
REVIEW_C1_OUT="$WORKDIR/review-conn1.out"
REVIEW_C2_OUT="$WORKDIR/review-conn2.out"
REVIEW_HOLD_MARKER="$WORKDIR/review-conn1-holding.marker"

psql_run >/dev/null <<SQL
insert into public.analyst_profiles (
  wallet, status, tier_code, verified, approved, weight_cached
) values (
  '$REVIEW_WALLET', 'probationary_analyst', 'probationary', true, true, 1.00
);
update public.osi_config set value = 'true' where key = 'OSI_V2_REPORT_REVIEW_WRITES_ENABLED';
update public.osi_config set value = '0' where key = 'OSI_V2_REPORT_REVIEW_COOLDOWN_SECONDS';
select * from public.osi_v2_prepare_report_review(
  '$REVIEW_NONCE', '$REVIEW_WALLET', '$REVIEW_VERSION_ID',
  'approve', '$REVIEW_REASON', '$REVIEW_RATIONALE', null,
  'osi-v2-report-review-race-$(date +%s%N)', '$(printf '4%.0s' $(seq 1 64))'
);
SQL

REVIEW_COMMIT_SQL="select receipt_id::text || ' ' || idempotent_replay::text
  from public.osi_v2_commit_report_review(
    '$REVIEW_NONCE', 'approve', '$REVIEW_REASON', '$REVIEW_RATIONALE',
    null, '$REVIEW_SIG', '$REVIEW_MESSAGE')"

psql "$DB_URL" -v ON_ERROR_STOP=1 -X -q <<SQL >/dev/null 2>&1 &
\pset tuples_only on
\pset format unaligned
begin;
$REVIEW_COMMIT_SQL
\g $REVIEW_C1_OUT
\! touch $REVIEW_HOLD_MARKER
select pg_sleep(3);
commit;
SQL
REVIEW_CONN1_PID=$!

waited=0
while [ ! -f "$REVIEW_HOLD_MARKER" ]; do
  sleep 0.2
  waited=$((waited + 1))
  if [ "$waited" -gt 100 ]; then
    fail "Report review connection 1 never reached the holding state"
    wait "$REVIEW_CONN1_PID" 2>/dev/null || true
    exit 1
  fi
done

psql "$DB_URL" -v ON_ERROR_STOP=1 -X -q <<SQL >/dev/null 2>&1 &
\pset tuples_only on
\pset format unaligned
begin;
$REVIEW_COMMIT_SQL
\g $REVIEW_C2_OUT
commit;
SQL
REVIEW_CONN2_PID=$!

sleep 1
REVIEW_RACE_WAITERS="$(psql_run -c "
  select count(*) from pg_stat_activity
   where wait_event_type = 'Lock'
     and query ilike '%osi_v2_commit_report_review%';")"
if [ "${REVIEW_RACE_WAITERS:-0}" -ge 1 ]; then
  pass "second Report review commit genuinely blocked on the exact nonce"
else
  fail "second Report review commit did not block on the nonce row"
fi

wait "$REVIEW_CONN1_PID"
wait "$REVIEW_CONN2_PID"
read -r REVIEW_R1 REVIEW_REPLAY1 < "$REVIEW_C1_OUT"
read -r REVIEW_R2 REVIEW_REPLAY2 < "$REVIEW_C2_OUT"
assert_eq "Report review race returns one shared receipt" "$REVIEW_R1" "$REVIEW_R2"
assert_eq "first Report review commit creates the active review" "false" "$REVIEW_REPLAY1"
assert_eq "second Report review commit is an idempotent replay" "true" "$REVIEW_REPLAY2"

REVIEW_COUNTS="$(psql_run -c "
  select count(distinct receipt.id) || ':' || count(distinct review.id)
    from public.event_receipts receipt
    join public.case_report_reviews review on review.event_receipt_id=receipt.id
   where receipt.nonce='$REVIEW_NONCE';")"
assert_eq "Report review race creates one receipt and one review row" "1:1" "$REVIEW_COUNTS"

REVIEW_CHANGED_ERR="$(psql "$DB_URL" -X -q -tA -c "
  select * from public.osi_v2_commit_report_review(
    '$REVIEW_NONCE', 'approve', '$REVIEW_REASON',
    'A changed public rationale cannot reuse the consumed review nonce.',
    null, '$REVIEW_SIG', '$REVIEW_MESSAGE');" 2>&1 || true)"
if printf '%s' "$REVIEW_CHANGED_ERR" | grep -q 'Report review payload changed after prepare'; then
  pass "changed Report review payload is rejected after the race"
else
  fail "changed Report review payload was not rejected: $REVIEW_CHANGED_ERR"
fi

# --- verdict ------------------------------------------------------------------
echo "----"
if [ "$failures" -eq 0 ]; then
  echo "OK — Stage-5 two-connection concurrency and replay invariants hold"
  exit 0
fi
echo "FAILED — $failures assertion(s) failed"
exit 1
