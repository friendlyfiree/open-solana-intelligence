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

// ---------------------------------------------------------------------------
// The card itself.
// ---------------------------------------------------------------------------
const css = read("assets/css/v2-activation.css");
const edge = read("supabase/functions/osi-v2-analyst/index.ts");

// Every class the card emits must actually be styled. An unstyled class is not
// a crash and not a test failure anywhere else; it is just a card that renders
// as unformatted prose, which is exactly how this one shipped.
// The maintainer surface now renders as a peer of the analyst roster: the same
// row grid, the same profile modal, marked MAINTAINER rather than given its own
// layout language. That means it emits reused roster classes as well as its own
// few, so the check widens to every class either surface emits. This is a
// stronger invariant than the previous maintainer-prefixed-only version: a
// reused class that lost its rule would now fail here too.
const maintainerSurface = withoutComments(analyst).slice(
  withoutComments(analyst).indexOf("function maintainerRow("),
);
const emitted = new Set(
  [...maintainerSurface.matchAll(/class="((?:osi|lb)-[a-z0-9 -]+)"/g)]
    .flatMap((m) => m[1].split(/\s+/))
    .filter((name) => /^(?:osi|lb)-[a-z0-9-]+$/.test(name)),
);
ok("the maintainer surface emits styled classes at all", emitted.size >= 6, String(emitted.size));
const allCss = ["assets/css/v2-activation.css", "assets/css/v2-shell.css", "assets/css/30-views.css",
  "assets/css/50-late-components.css", "assets/css/70-intelligence-redesign.css",
  "assets/css/60-final-polish.css", "assets/css/20-sections.css"]
  .map((file) => { try { return read(file); } catch { return ""; } }).join("\n");
const unstyled = [...emitted].filter((name) => !new RegExp("\\." + name + "[^a-z0-9-]").test(allCss));
ok("every class the maintainer surface emits has a style rule", unstyled.length === 0, unstyled.join(", "));
// The badge that marks the maintainer apart must itself be styled, or the one
// distinction this surface exists to draw renders as plain text.
ok("the maintainer badge has its own rule", /\.osi-status\.maintainer\{/.test(css));
// Opening the maintainer must go through the same modal an analyst row opens.
ok("the maintainer row opens the shared public profile modal",
  /data-maintainer-wallet/.test(analyst)
  && /openPublicProfile\(row\.dataset\.maintainerWallet\)/.test(analyst)
  && /function renderProfileModal\(body,profile,options\)/.test(analyst)
  && /renderProfileModal\(body,maintainerModalProfile\(maintainer\),\{maintainer:true\}\)/.test(analyst)
  && /renderProfileModal\(body,profile,\{maintainer:false\}\)/.test(analyst));
// The governance separation is the substance of the distinction and must
// survive the move into the shared modal.
ok("the shared modal still states that the maintainer holds no analyst standing",
  /t\('Analyst standing'\)[\s\S]{0,120}t\('None'\)/.test(analyst)
  && /t\('Review weight'\)[\s\S]{0,120}t\('None'\)/.test(analyst)
  && /t\('Quorum vote'\)[\s\S]{0,120}t\('None'\)/.test(analyst));

// The page's CSP only permits images from this project's storage, so an
// off-site avatar is accepted by the server and then blocked by the browser.
// Going through the shared helper means an unowned URL degrades to the
// generated identicon instead of rendering an empty frame.
ok("the portrait goes through the shared avatar helper, not a raw img tag",
  /avatar\(\{avatar_url:profile\.avatar_url,wallet:profile\.wallet,display_name:name\},38\)/.test(analyst)
  && !/<img class="osi-maintainer-avatar"/.test(analyst));
ok("the editor takes an uploaded file rather than a remote image URL",
  /type="file" accept="image\/png,image\/jpeg" data-mp-avatar-file/.test(analyst)
  && !/type="url" data-mp-avatar[^-]/.test(analyst));

// readMaintainerEditor became async to read the file. A dropped await posts a
// Promise as the profile and the save fails in a way the UI cannot explain.
ok("the submit handler awaits the editor read",
  /profile:await readMaintainerEditor\(form\)/.test(analyst));
ok("clearing the image clears both the stored URL and any pending file",
  /data-mp-avatar-clear/.test(analyst)
  && /\[data-mp-avatar\]'\);if\(stored\)stored\.value='';/.test(analyst));

// The uploaded object is content-addressed into the bucket this deployment
// owns, and it must win over whatever URL the form carried.
ok("the server uploads the maintainer image through the owned bucket",
  /image = await imageBinding\(body\.profile\)/.test(edge)
  && /avatarUrl = await uploadAvatar\(wallet, image\)/.test(edge)
  && /p_avatar_url: avatarUrl/.test(edge));
ok("the submitted avatar object never reaches the normalizer",
  /delete submitted\.avatar;/.test(edge));

// The maintainer row inherits the roster grid rather than defining a second
// layout. That is what makes it line up with the table below it at every
// breakpoint, including the narrow one where the roster drops columns.
ok("the maintainer row reuses the analyst roster grid at every breakpoint",
  /#analysts \.osi-analyst-head,#analysts \.osi-analyst-row\{display:grid/.test(css)
  && /@media[^{]*\{[\s\S]*?#analysts \.osi-analyst-row\{grid-template-columns:minmax\(0,1fr\) auto 70px/.test(css)
  && /class="osi-analyst-row osi-analyst-row-maintainer"/.test(analyst));
// The role footer says what the maintainer does; the modal facts row says what
// they do not hold. Neither repeats the other.
ok("the surface says what the role does and the modal says what it does not hold",
  /schema migrations, function rollouts and configuration/.test(analyst)
  && /osi-profile-role-note/.test(analyst)
  && /\.osi-profile-role-note\{/.test(css));

process.stdout.write(`Maintainer editor reachability: ${passed} passed\n`);
