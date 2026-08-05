// The maintainer profile shipped with its own edit control unreachable, in two
// independent ways, and neither was visible in review:
//
//   1. `attachMaintainerEditor` gated on `state.capabilities`, a key nothing in
//      that module ever assigns, so the guard was always false and the button
//      could never be drawn — not with a profile, not without one.
//   2. Even with the flag, it returned early whenever no profile existed, so
//      the "Publish maintainer profile" wording was unreachable and the only
//      way to create a profile would have been to already have one.
//
// Both read as correct code. What settles them is asking whether the control
// can actually be reached, and whether every state key read is one the module
// ever sets.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const analyst = read("assets/js/v2-analyst-integration.js");
const caseModule = read("assets/js/v2-case-integration.js");

let passed = 0;
function ok(name, condition, detail) {
  assert.equal(Boolean(condition), true, detail ? `${name} :: ${detail}` : name);
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

// Prose about a key is not a read of it. Whole-line and block comments are
// dropped so a comment naming `state.capabilities` cannot register as usage;
// inline trailing comments are left alone rather than risk cutting a line at a
// `//` that belongs to a URL inside a string.
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

// A read of a key the module never sets is always undefined. In a guard it
// silently disables the feature it is guarding, which is exactly what happened.
// Brace-matched rather than regex-sliced: these literals are multi-line and
// contain nested objects, so a non-greedy match stops at the first inner brace.
function stateLiteral(source) {
  const start = source.search(/\bvar\s+state\s*=\s*\{/);
  if (start < 0) return null;
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

function unsetStateReads(raw) {
  const source = withoutComments(raw);
  const literal = stateLiteral(source);
  if (literal === null) return ["no state literal found"];
  // Top-level keys only: a nested object's keys are not `state.<key>`.
  let depth = 0;
  let topLevel = "";
  for (const char of literal) {
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    if (depth === 0) topLevel += char;
    else if (char === "," ) topLevel += " ";
  }
  const declared = new Set(
    [...topLevel.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]),
  );
  for (const assigned of source.matchAll(/\bstate\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
    declared.add(assigned[1]);
  }
  const unset = new Set();
  for (const usage of source.matchAll(/\bstate\.([A-Za-z_$][\w$]*)/g)) {
    const after = source.slice(usage.index + usage[0].length);
    if (/^\s*=(?!=)/.test(after)) continue;
    if (!declared.has(usage[1])) unset.add(usage[1]);
  }
  return [...unset];
}

const analystUnset = unsetStateReads(analyst);
ok("the analyst module reads no state key it never sets",
  analystUnset.length === 0, analystUnset.join(", "));
const caseUnset = unsetStateReads(caseModule);
ok("the case module reads no state key it never sets",
  caseUnset.length === 0, caseUnset.join(", "));

// The control has to be reachable from the state the operator is actually in
// the first time they look: connected, gated, and with nothing published.
const attach = analyst.slice(
  analyst.indexOf("function attachMaintainerEditor"),
  analyst.indexOf("function attachMaintainerEditor") + 1400,
);
ok("the maintainer editor is attachable", attach.length > 100);
ok("attaching does not bail out merely because no profile exists yet",
  !/if\(!host\|\|host\.hidden===true&&!profile\)return;/.test(attach));
ok("a missing profile still renders a frame the publish control can live in",
  /if\(!profile\|\|!profile\.wallet\)\{/.test(attach)
  && /osi-maintainer-empty/.test(attach));
ok("the publish wording is reachable rather than dead",
  /Publish maintainer profile/.test(attach));
ok("attaching is gated on the pushed maintainer flag",
  /state\.maintainerAccess!==true\)return;/.test(attach));

// Nothing in this module discovers the wallet's standing on its own, so the
// flag has to arrive from the module that does, on both outcomes.
ok("the analyst module exposes the capability entry point",
  /window\.osiV2SetMaintainerCapability=function\(allowed\)\{/.test(analyst));
ok("setting the capability re-runs the profile load so the control appears",
  /state\.maintainerAccess=next;\s*loadMaintainerProfile\(\);/.test(analyst));
const pushes = [...caseModule.matchAll(/window\.osiV2SetMaintainerCapability\(([^)]*)\)/g)]
  .map((m) => m[1]);
ok("the case module pushes the capability on success and on failure",
  pushes.length === 2
  && pushes.some((arg) => /maintainer_access===true/.test(arg))
  && pushes.some((arg) => arg.trim() === "false"),
  pushes.join(" | "));

// Rendering replaces the container, so a successful save must put the control
// back or the operator gets exactly one edit per page load.
const save = analyst.slice(
  analyst.indexOf("op:'save_maintainer_profile'"),
  analyst.indexOf("op:'save_maintainer_profile'") + 700,
);
ok("a successful save re-attaches the edit control and closes the editor",
  /renderMaintainerProfile\(saved&&saved\.profile\);/.test(save)
  && /panel\.remove\(\);/.test(save)
  && /attachMaintainerEditor\(saved&&saved\.profile\);/.test(save));

// A visitor who is not the operator must still see nothing at all when no
// profile is published: the empty frame is an operator-only affordance.
ok("a public visitor with no published profile sees no card",
  /if\(!profile\|\|!profile\.wallet\)\{host\.hidden=true;host\.innerHTML='';return;\}/
    .test(analyst));

process.stdout.write(`Maintainer editor reachability: ${passed} passed\n`);
