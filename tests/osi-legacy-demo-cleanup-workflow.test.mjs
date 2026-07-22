import fs from "node:fs";

const workflow = fs.readFileSync(
  new URL("../.github/workflows/osi-legacy-demo-cleanup.yml", import.meta.url),
  "utf8",
);

let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}

ok("cleanup is manual-only", /^on:\s*\n\s+workflow_dispatch:/m.test(workflow)
  && !/^\s+(push|pull_request|schedule):/m.test(workflow));
ok("production ref and typed confirmation are pinned",
  workflow.includes("EXPECTED_PROJECT_REF: afibxpniwfnavdobecrn")
  && workflow.includes("CLEAN-LEGACY-DEMO-${EXPECTED_PROJECT_REF}"));
ok("every mutable legacy target uses an exact ID and expected content",
  workflow.includes("id = '1b3299bc-1095-410b-9827-b73544094ca7'")
  && workflow.includes("id = 'rep_1782886895974' and company = 'Hyperion DeFi, Inc.'")
  && workflow.includes("id = 'rep_1782633406125'")
  && workflow.includes("company = 'Demo wallet-drainer incident evidence pack'"));
ok("workflow snapshots before the delete step",
  workflow.indexOf("Upload recoverable pre-delete snapshot")
    < workflow.indexOf("Delete exactly the unprotected legacy rows"));
ok("V2 append-only guards are asserted and never bypassed",
  workflow.includes("t.tgname = 'osi_v2_reject_delete'")
  && !/^\s*(?:ALTER\s+TABLE|SET\s+(?:LOCAL\s+)?session_replication_role|DISABLE\s+TRIGGER)/mi.test(workflow));
ok("runtime guard-bypass scan does not reject its own policy expression",
  !/(?:ALTER\s+TABLE|session_replication_role|DISABLE\s+TRIGGER)/i.test(workflow));
ok("delete statements never target V2 history tables",
  !/delete\s+from\s+public\.(?:migration_crosswalk|case_report_versions|case_reports|cases|event_receipts)/i.test(workflow));
ok("the two real legacy Cases and demand receipts are protected",
  workflow.includes("8fc9fe7e-f57f-4761-ba73-47c2e3a4a230")
  && workflow.includes("ba9a6b58-3093-4a19-894a-eabc6a4dc8ed")
  && workflow.includes("OSI-8FC9FE7EF57F4761BA73")
  && workflow.includes("OSI-BA9A6B5830934A19894A")
  && workflow.includes("LEGACY_DEMAND_SIGNAL")
  && workflow.includes("diff -u /tmp/protected-before.jsonl /tmp/protected-after.jsonl"));
ok("demand receipt lookups use stored public refs instead of Case UUIDs",
  [...workflow.matchAll(/event_type = 'LEGACY_DEMAND_SIGNAL'\s+and (?:e\.)?target_id in \(\s*'([^']+)',\s*'([^']+)'/g)]
    .every(([, first, second]) => first === "OSI-8FC9FE7EF57F4761BA73"
      && second === "OSI-BA9A6B5830934A19894A")
  && [...workflow.matchAll(/event_type = 'LEGACY_DEMAND_SIGNAL'\s+and (?:e\.)?target_id in \(/g)].length === 5);
ok("post-check requires the legacy reports table to be empty",
  workflow.includes("Expected public.reports to contain zero rows after cleanup"));

console.log(`\n${passed} cleanup workflow assertions passed.`);
