#!/usr/bin/env bash
# Edge Function boot gate.
#
# `deno check` type-checks a module graph. It never evaluates one. A function
# whose graph type-checks perfectly can still throw the moment it is evaluated,
# and the Edge Runtime answers every request to such a function, even an unknown
# operation, with 500 WORKER_ERROR.
#
# That gap took the analyst gateway down in production on 2026-08-08. esm.sh
# began resolving a transitive `ws` build whose module evaluation throws, so a
# deployment of unchanged, previously working source stopped booting. Nothing in
# CI executed a function, so nothing caught it until the smoke test ran against
# production.
#
# This asks the only question deno check cannot: does it start?
#
# It runs each function under Deno with placeholder configuration and waits for
# the server to report that it is listening. No network dependency of the
# product is contacted, nothing is deployed, and no real secret is used: a
# function that reaches its listener has evaluated its whole module graph, which
# is the property under test.
#
# Run: bash tests/osi-edge-function-boot.test.sh
set -uo pipefail

DENO_BIN="${DENO_BIN:-deno}"
BOOT_TIMEOUT="${OSI_BOOT_TIMEOUT:-90}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# Placeholders only. The boot path reads these at module scope; it must never
# need a real project or key to prove that it evaluates.
export SUPABASE_URL="${SUPABASE_URL:-https://example.supabase.co}"
export SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-boot-probe-placeholder}"
export OSI_V2_ALLOWED_ORIGIN="${OSI_V2_ALLOWED_ORIGIN:-https://example.com}"
export SOLANA_RPC_URL="${SOLANA_RPC_URL:-https://api.mainnet-beta.solana.com}"

# A fatal module-evaluation failure. Deno prints optional-dependency notices for
# native accelerators that are absent by design, so those are not faults and are
# matched away before this pattern is applied.
FATAL='^error: |^error\b|Uncaught |TypeError|ReferenceError|SyntaxError|Module not found|not provide an export'
BENIGN='bufferutil|utf-8-validate|Download|Check file|^Listening'

failed=0
checked=0

# Finding nothing is a failure of this gate, not a pass. Without this the
# unmatched glob is carried through literally, deno fails on a path that is not
# a file, and the run reports BOOT FAIL for a function named "*" - a real
# failure message about an imaginary defect, which is worse than either a clean
# pass or an honest error.
shopt -s nullglob
entries=(supabase/functions/*/index.ts)
if [ "${#entries[@]}" -eq 0 ]; then
  printf 'BOOT GATE ERROR: no Edge Functions found under %s/supabase/functions.\n' "$root"
  printf 'The gate proved nothing. Run it from the repository, not from a copy.\n'
  exit 1
fi

for entry in "${entries[@]}"; do
  slug="$(basename "$(dirname "$entry")")"
  checked=$((checked + 1))
  log="$(mktemp)"

  "$DENO_BIN" run --allow-all "$entry" >"$log" 2>&1 &
  pid=$!

  listening=0
  for _ in $(seq 1 "$BOOT_TIMEOUT"); do
    if grep -qi "listening" "$log"; then listening=1; break; fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 1
  done

  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null

  fatal="$(grep -vE "$BENIGN" "$log" | grep -E "$FATAL" | head -3)"
  if [ -n "$fatal" ]; then
    printf 'BOOT FAIL  %s\n' "$slug"
    printf '           %s\n' "$fatal"
    failed=1
  elif [ "$listening" -ne 1 ]; then
    printf 'BOOT FAIL  %s (never reported a listener within %ss)\n' "$slug" "$BOOT_TIMEOUT"
    grep -vE "$BENIGN" "$log" | tail -3 | sed 's/^/           /'
    failed=1
  else
    printf 'BOOT OK    %s\n' "$slug"
  fi
  rm -f "$log"
done

printf -- '----\n'
if [ "$failed" -ne 0 ]; then
  printf 'FAILED: at least one Edge Function cannot boot. It would answer every\n'
  printf 'request with 500 WORKER_ERROR in production, including an unknown\n'
  printf 'operation, because the failure is in module evaluation rather than in\n'
  printf 'any request handler.\n'
  exit 1
fi
printf '%s Edge Functions booted\n' "$checked"
