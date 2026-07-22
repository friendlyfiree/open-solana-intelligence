import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const require = createRequire(import.meta.url);
const surface = require("../assets/js/88-functional-surface.js");
const index = read("index.html");
const legacy = read("legacy.html");
const script = read("assets/js/88-functional-surface.js");
const aiPack = read("assets/js/v2-ai-pack-integration.js");
const home = index.slice(index.indexOf('<section class="osi-home osi-home-hero"'), index.indexOf('<section class="sec" id="records-hero"'));
const platformMenuStart = index.indexOf('id="platform-menu"');
const platformMenu = index.slice(platformMenuStart, index.indexOf('<button class="osi-nav-link"', platformMenuStart));
const walletMenu = index.slice(index.indexOf('id="wbMenu"'), index.indexOf('</header>'));
let passed = 0;
function ok(name, value) {
  if (!value) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}

const expected = ["case", "report", "wire", "analyst", "review", "governance", "money", "proof", "operations"];
ok("action catalog covers every accepted live product family",
  JSON.stringify(Object.keys(surface.catalog)) === JSON.stringify(expected));
ok("every action contract names its real read, capability, or prepare endpoint",
  expected.every((id) => typeof surface.catalog[id].endpoint === "string" && surface.catalog[id].endpoint.includes(":")));

const calls = [];
const env = {
  openCase: () => calls.push(["case"]),
  openMyReports: () => calls.push(["report"]),
  openMyWireReports: () => calls.push(["wire"]),
  openAnalystApplications: () => calls.push(["analyst"]),
  openReviewQueue: () => calls.push(["review"]),
  openFieldStage: (stage) => calls.push(["field", stage]),
  navigate: (view) => calls.push(["navigate", view]),
  openOperations: () => calls.push(["operations"]),
};
expected.forEach((id) => surface.run(id, env));
ok("fixture actions route to the exact implemented UI transitions", JSON.stringify(calls) === JSON.stringify([
  ["case"], ["report"], ["wire"], ["analyst"], ["review"], ["field", "resolution_selection"],
  ["field", "sealed"], ["navigate", "prooflog"], ["operations"],
]));

const cards = [...index.matchAll(/data-action-contract="([^"]+)" data-endpoint="([^"]+)"/g)];
ok("all nine action contracts are registered exactly once", cards.length === 9 && new Set(cards.map((row) => row[1])).size === 9);
ok("endpoint labels match the executable contract",
  cards.every((row) => surface.catalog[row[1]] && surface.catalog[row[1]].endpoint === row[2]));
ok("Home explains the product without duplicating action contracts", !home.includes("data-action-contract="));
ok("Platform menu owns exactly the five public and governance contracts",
  (platformMenu.match(/data-action-contract=/g) || []).length === 5
    && ["case", "review", "governance", "money", "proof"].every((id) => platformMenu.includes(`data-action-contract="${id}"`)));
ok("wallet menu owns exactly the four private and maintainer contracts",
  (walletMenu.match(/data-action-contract=/g) || []).length === 4
    && ["report", "wire", "analyst", "operations"].every((id) => walletMenu.includes(`data-action-contract="${id}"`)));
ok("Operations is present only on the hidden maintainer menu item",
  /id="maintainerAccessMenu"[^>]*style="display:none"[^>]*data-action-contract="operations"/.test(walletMenu)
    && (index.match(/data-action-contract="operations"/g) || []).length === 1);
ok("functional surface never performs a direct browser database mutation", !/supa(?:Post|Patch|Delete)|\.from\(/.test(script));
ok("Operations uses the native double-gated overview instead of a visible legacy mutation console",
  index.includes('id="osi-native-ops-overview"')
    && index.includes('id="admConsole" hidden')
    && !index.includes('id="adm-edit-modal"'));
ok("Wire intake is a real flag-gated native action with no legacy submit control",
  index.includes('id="osi-wire-intake-action"')
    && index.includes('onclick="osiV2OpenWireForm()"')
    && index.includes('assets/js/v2-wire-integration.js')
    && !index.includes('id="wire-subject-in"')
    && !script.includes("window.submitIntel=function()"));
ok("native AI Pack is a real Case-drawer surface while the legacy generator stays retired",
  index.includes("assets/js/v2-ai-pack-integration.js")
    && index.indexOf("assets/js/v2-ai-pack-integration.js") < index.indexOf("assets/js/v2-case-integration.js")
    && aiPack.includes("op:'capabilities'")
    && aiPack.includes("case_ref:ref")
    && aiPack.includes("ai_pack_writes_enabled")
    && aiPack.includes("can_generate")
    && !index.includes("assets/js/80-ai-pack.js")
    && !index.includes("escGenerate()"));
ok("production root loads no sample-data, briefing, or legacy private-read bundle",
  !index.includes("assets/js/02-data-stubs.js")
    && !index.includes("assets/js/12-demo-briefing.js")
    && !index.includes("assets/js/22-analyst-intake.js"));
ok("legacy keeps its archived runtime dependencies",
  legacy.includes("assets/js/02-data-stubs.js")
    && legacy.includes("assets/js/12-demo-briefing.js")
    && legacy.includes("assets/js/22-analyst-intake.js")
    && legacy.includes("assets/js/80-ai-pack.js"));
ok("retired preview file is absent and permanently redirected to root",
  !existsSync(join(root, "v2-preview.html"))
    && read("vercel.json").includes('"source": "/v2-preview.html"')
    && read("vercel.json").includes('"permanent": true'));
ok("premature SAS and planned durable-record claims are absent", !/\bSAS\b|durable record fields|>Planned</i.test(index));

console.log(`\n${passed} functional surface and retirement checks passed.`);
