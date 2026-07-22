import fs from "node:fs";

const workflow = fs.readFileSync(
  new URL("../.github/workflows/osi-prelaunch-clean-slate.yml", import.meta.url),
  "utf8",
);

let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}

ok("workflow is manual-only", /^on:\s*\n\s+workflow_dispatch:/m.test(workflow)
  && !/^\s+(?:push|pull_request|schedule):/m.test(workflow));
ok("production ref, main, and typed phrase are pinned",
  workflow.includes("EXPECTED_PROJECT_REF: afibxpniwfnavdobecrn")
  && workflow.includes("CLEAN-SLATE-${EXPECTED_PROJECT_REF}")
  && workflow.includes('"refs/heads/main"'));
ok("full target snapshot is uploaded before mutation",
  workflow.indexOf("Upload recoverable pre-mutation snapshot")
    < workflow.indexOf("Delete exact V1 rows and archive exact Cases in one transaction"));
ok("V1 target counts and stable content identities are asserted",
  workflow.includes("V1 bounty target set changed")
  && workflow.includes("V1 bounty boost target set changed")
  && workflow.includes("V1 request vote target set changed")
  && workflow.includes("V1 on-chain event target set changed")
  && workflow.includes("Expected exactly two V1 analyst rows to purge"));
ok("children are deleted before parents",
  workflow.indexOf("delete from public.bounty_boosts")
    < workflow.indexOf("delete from public.bounties")
  && workflow.indexOf("delete from public.request_votes")
    < workflow.indexOf("delete from public.requests"));
ok("three exact Cases are archived without deleting V2 history",
  workflow.includes("update public.cases set archived_at = clock_timestamp()")
  && workflow.includes("75d786cf-e633-4a16-9d9f-c06c4eb1f0d9")
  && workflow.includes("8fc9fe7e-f57f-4761-ba73-47c2e3a4a230")
  && workflow.includes("ba9a6b58-3093-4a19-894a-eabc6a4dc8ed")
  && !/delete\s+from\s+public\.(?:cases|case_reports|case_report_versions|event_receipts|migration_crosswalk)/i.test(workflow));
ok("append-only guards are asserted and never bypassed",
  workflow.includes("osi_v2_reject_delete")
  && !/^\s*(?:SET\s+(?:LOCAL\s+)?session_replication_role|DISABLE\s+TRIGGER)/mi.test(workflow));
ok("service infrastructure is never mutated",
  !/(?:delete\s+from|update|insert\s+into)\s+public\.(?:osi_config|osi_v2_sas_\w+|osi_nonces|osi_read_nonces|migration_crosswalk|migration_manual_queue)/i.test(workflow));
ok("SAS/bootstrap config and immutable V2 rows are byte-compared",
  workflow.includes("where key ilike '%SAS%' or key ilike '%BOOTSTRAP%'")
  && workflow.includes("diff -u /tmp/protected-before.jsonl /tmp/protected-after.jsonl"));
ok("anonymous live smoke covers all four clean-slate surfaces",
  workflow.includes("list_public_cases")
  && workflow.includes("list_public_profiles")
  && workflow.includes("list_public_wire_reports")
  && workflow.includes("No public V2 Cases yet")
  && workflow.includes("No activated analysts yet")
  && workflow.includes("No public records have been sealed yet")
  && workflow.includes("No proof events found yet"));

console.log(`\n${passed} pre-launch clean-slate workflow assertions passed.`);
