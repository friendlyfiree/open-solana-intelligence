// A rollout gate is only as good as its ability to read the output it is
// gating on. Two gates in this workflow shipped with patterns that could never
// match the real thing: one grepped for psql's t/f column display in a string
// that concatenation renders as true/false, and one anchored a migration count
// to the start of a line that the Supabase CLI prints as a bullet list. Both
// failed closed, which is the right direction, but a gate that cannot pass is
// an outage wearing the costume of a safety property.
//
// The defect in both cases is the same: the pattern was never run against real
// output. So these tests extract the gate's own shell expression straight out
// of the workflow and run it against a captured sample, rather than restating
// what the pattern ought to be.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(
  path.join(root, ".github/workflows/osi-v2-maintainer-profile-production.yml"),
  "utf8",
);
const realDryRun = readFileSync(
  path.join(root, "tests/fixtures/supabase-db-push-dry-run.txt"),
  "utf8",
);

let passed = 0;
function ok(name, condition, detail) {
  assert.equal(Boolean(condition), true, detail ? `${name} :: ${detail}` : name);
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

const scratch = mkdtempSync(path.join(tmpdir(), "osi-gate-"));

// The counting expression exactly as the workflow runs it.
const countMatch = workflow.match(/count="\$\(([^\n]*?)\)"\n/);
ok("the pending-migration counter is extractable from the workflow", countMatch !== null);
const countExpression = countMatch[1];

function countFor(text) {
  const file = path.join(scratch, `dry-run-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(file, text);
  const script = countExpression.replaceAll("/tmp/dry-run.txt", file);
  return execFileSync("bash", ["-o", "pipefail", "-c", `printf '%s' "$(${script})"`], {
    encoding: "utf8",
  }).trim();
}

// The case that actually broke the rollout: real CLI output, one pending
// migration, printed as a bullet list.
ok("real dry-run output with one pending migration counts as 1",
  countFor(realDryRun) === "1", countFor(realDryRun));

// The gate exists to refuse a rollout carrying more than its own slice.
ok("two pending migrations count as 2", countFor(
  "Would push these migrations:\n"
  + " • 20260805090000_osi_v2_maintainer_profile.sql\n"
  + " • 20260806120000_some_other_slice.sql\n") === "2");
ok("no pending migration counts as 0",
  countFor("Remote database is up to date.\n") === "0");
// The same name echoed twice is still one migration, so the count is of
// distinct migrations rather than of matching lines.
ok("a repeated filename still counts as one migration", countFor(
  "Would push these migrations:\n"
  + " • 20260805090000_osi_v2_maintainer_profile.sql\n"
  + "Applying 20260805090000_osi_v2_maintainer_profile.sql\n") === "1");
// Bullet, plain and indented renderings all have to count, because the exact
// prefix is the CLI's choice and it has already changed once.
ok("the count does not depend on the CLI's bullet or indentation", countFor(
  "20260805090000_osi_v2_maintainer_profile.sql\n") === "1"
  && countFor("\t- 20260805090000_osi_v2_maintainer_profile.sql\n") === "1");

// The default-deny gate reads a boolean out of pg_class. psql prints t/f for a
// boolean column but `||` renders it true/false, so the gate must both cast
// explicitly and compare against the spelled-out value.
const rlsQueries = [...workflow.matchAll(/select 'rls\|'[^\n;]*/g)].map((m) => m[0]);
ok("both RLS gates are present", rlsQueries.length === 2, String(rlsQueries.length));
ok("each RLS gate casts its boolean explicitly rather than relying on display form",
  rlsQueries.every((query) => /\)::text/.test(query) && !/\|\|\s*relrowsecurity\s*\|\|/.test(query)),
  rlsQueries.join(" ## "));
const rlsGreps = [...workflow.matchAll(/grep -q '\^rls\|[^']*'/g)].map((m) => m[0]);
ok("each RLS check greps for the concatenated form true, never the display form t",
  rlsGreps.length === 2 && rlsGreps.every((line) => /\^rls\|true\$/.test(line)),
  rlsGreps.join(" ## "));

process.stdout.write(`Rollout gate parsing: ${passed} passed\n`);
