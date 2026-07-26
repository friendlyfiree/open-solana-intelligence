import assert from "node:assert/strict";
import fs from "node:fs";

const migration = fs.readFileSync(
  new URL(
    "../supabase/migrations/20260726200249_wire_empty_evidence_prepare_fix.sql",
    import.meta.url,
  ),
  "utf8",
);
const gateway = fs.readFileSync(
  new URL("../supabase/functions/osi-v2-wire/index.ts", import.meta.url),
  "utf8",
);
const client = fs.readFileSync(
  new URL("../assets/js/v2-wire-integration.js", import.meta.url),
  "utf8",
);
const productionSmoke = fs.readFileSync(
  new URL("./osi-core-flow-production-smoke.mjs", import.meta.url),
  "utf8",
);
const rollout = fs.readFileSync(
  new URL(
    "../.github/workflows/osi-wire-empty-evidence-production.yml",
    import.meta.url,
  ),
  "utf8",
);

assert.match(
  migration,
  /jsonb_array_length\(p_evidence\) = 0[\s\S]*return '\[\]'::jsonb/,
);
assert.match(
  migration,
  /return osi_private\.osi_v2_report_evidence_manifest\(p_evidence\)/,
);
assert.match(
  migration,
  /jsonb_array_length\(p_evidence\) > 12/,
);
assert.doesNotMatch(migration, /update public\.osi_config/i);

assert.match(
  gateway,
  /rpcFailure\(error, false, "wire_payload_rejected"\)/,
);
assert.match(
  gateway,
  /validationError === "proof_binding_rejected" \? 409 : 400/,
);
assert.match(
  client,
  /wire_payload_rejected:'The Wire content or evidence did not pass server validation\./,
);
assert.match(
  client,
  /\['wire_payload_rejected','proof_binding_rejected'/,
);
assert.match(
  productionSmoke,
  /const wirePayload = \{[\s\S]*?evidence: \[\],[\s\S]*?"Wire empty-evidence preparation"/,
);
assert.match(rollout, /^name: OSI Wire Empty Evidence Repair Production/m);
assert.match(rollout, /^\s{2}workflow_dispatch:/m);
assert.doesNotMatch(rollout, /^\s{2}(push|pull_request|schedule):/m);
assert.match(rollout, /WIRE-EMPTY-EVIDENCE-afibxpniwfnavdobecrn/);
assert.match(rollout, /NEW_VERSION: "20260726200249"/);
assert.match(rollout, /supabase db push --linked --dry-run/);
assert.match(rollout, /supabase db push --linked --yes/);
assert.match(
  rollout,
  /supabase functions deploy osi-v2-wire[\s\S]*--no-verify-jwt --use-api/,
);
assert.match(rollout, /deno run --allow-net tests\/osi-core-flow-production-smoke\.mjs/);
assert.match(rollout, /smoke_wire_evidence_count=0/);
assert.doesNotMatch(rollout, /supabase secrets set/i);

console.log(
  "Wire empty-evidence prepare and truthful validation-error regressions passed.",
);
