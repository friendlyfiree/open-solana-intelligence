// Dependency-free regression test for the Case graph loader's request shape.
// Run: node tests/osi-v2-case-graph-waves.test.mjs   (exit 0 = pass)
//
// loadCaseGraph is the read path behind the Field Office, Public Records, the
// Proof Log and every Case drawer. It used to fetch its relations one at a
// time, fifteen awaited round trips deep, and that serial chain, not the
// queries themselves, is what made the first public read take seconds.
//
// This test pins the two properties that matter and are easy to lose again:
//
//   1. every relation the projection needs is still read exactly once, so a
//      regrouping can never silently drop evidence, reviews, receipts,
//      governance or money from a DTO;
//   2. the loader stays grouped into a small number of awaited stages, so a
//      later edit cannot quietly reintroduce the serial chain.
//
// It reads the source rather than executing it: the function is Deno-only
// (remote imports plus Deno.env), and the repository has no build step.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = readFileSync(
  join(root, "supabase/functions/osi-v2-case-read/index.ts"),
  "utf8",
);

let pass = 0;
let fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass += 1; return; }
  fail += 1;
  console.error("FAIL " + name + (detail ? " :: " + detail : ""));
}

const start = source.indexOf("async function loadCaseGraph(");
ok("loadCaseGraph is present", start !== -1);
const end = source.indexOf("\nasync function listPublicCases(", start);
ok("loadCaseGraph end is locatable", end > start);
const graph = source.slice(start, end);

// 1. Every relation the DTOs depend on is still read.
const REQUIRED_RELATIONS = [
  "case_reports",
  "case_report_versions",
  "case_report_reviews",
  "case_initial_reviews",
  "case_evidence_links",
  "evidence_items",
  "case_resolutions",
  "resolution_reviews",
  "challenges_v2",
  "challenge_reviews",
  "reward_pledges",
  "reward_payments",
  "support_events",
  "event_receipts",
  "analyst_profiles",
  "osi_config",
];
for (const relation of REQUIRED_RELATIONS) {
  ok(
    "graph still reads " + relation,
    graph.includes('admin.from("' + relation + '")'),
    "relation missing from loadCaseGraph",
  );
}

// 2. The three review families keep their SAS authority label. A weight shown
//    without it would not say why a vote counted or did not.
for (const kind of ["resolution", "challenge", "case_initial"]) {
  ok(
    "review authority is attached for " + kind,
    graph.includes('attachReviewAuthority(admin, "' + kind + '"'),
    "missing attachReviewAuthority",
  );
}

// 3. The loader stays grouped. Each `await` inside loadCaseGraph is one more
//    serial round trip before any surface can render.
const awaits = graph.match(/\bawait\b/g) ?? [];
ok(
  "loadCaseGraph keeps its reads grouped into few stages",
  awaits.length <= 6,
  awaits.length + " awaited stages; regroup independent relations instead",
);
ok(
  "loadCaseGraph fetches in parallel waves",
  (graph.match(/await Promise\.all\(\[/g) ?? []).length >= 3,
  "expected the dependency waves to use Promise.all",
);

// 4. An empty dependency list must never widen a query into an unfiltered
//    read. Each conditional wave member keeps its explicit empty result.
ok(
  "empty dependency lists resolve empty instead of querying",
  (graph.match(/Promise\.resolve\(\{ data: \[\] \}\)/g) ?? []).length >= 6,
  "a wave member lost its empty-list guard",
);

console.log(
  (fail === 0 ? "OK" : "FAILED") + " (" + pass + " assertions passed, " + fail + " failed)",
);
process.exit(fail === 0 ? 0 : 1);
