import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
let passed = 0;
function ok(name, condition) {
  assert.equal(Boolean(condition), true, name);
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

const browserFiles = ["index.html", "legacy.html"]
  .concat(fs.readdirSync(path.join(root, "assets/js")).filter((name) => name.endsWith(".js")).map((name) => `assets/js/${name}`));
const browserSource = browserFiles.map((name) => read(name)).join("\n");
ok("browser bundle contains no keyed URL credential", !/[?&](?:api[_-]?key|access[_-]?token|secret)=[^\s"'&]+/i.test(browserSource));
ok("browser RPC fallback contains no private provider constant", !/HELIUS_RPC|helius-rpc\.com/i.test(read("assets/js/44-prooflog-deck.js")));
ok("legacy browser reads use explicit projections", !/select=\*/.test(browserSource));

const intakeEdge = read("supabase/functions/osi-analyst-intake/index.ts");
const intakeUi = read("assets/js/22-analyst-intake.js");
const legacySafety = read("assets/js/20-safety-consensus.js");
const vouchStart = legacySafety.indexOf("async function vouch");
const vouchFunction = legacySafety.slice(vouchStart, legacySafety.indexOf("\n}\n", vouchStart) + 3);
ok("legacy intake verifies an origin-bound review read session", /verifyReadSessionToken/.test(intakeEdge) && /READ_SESSION_SCOPES\.CASE_REVIEW/.test(intakeEdge));
ok("legacy intake fails closed with the shared read-session flag", /OSI_V2_READ_SESSION_ENABLED/.test(intakeEdge) && /=== "true"/.test(intakeEdge));
ok("legacy intake rechecks the V2 analyst roster", /from\("analyst_profiles"\)/.test(intakeEdge) && /weight_cached/.test(intakeEdge));
ok("legacy maintainer access requires configured auth UUID and admin wallet", /OSI_MAINTAINER_AUTH_UUID/.test(intakeEdge) && /admin_wallet/.test(intakeEdge) && /auth\.getUser/.test(intakeEdge));
ok("legacy review mutation is server-disabled", /legacy_review_writes_disabled/.test(intakeEdge) && !/from\("vouches"\)/.test(intakeEdge) && !/\.update\(/.test(intakeEdge));
ok("legacy intake UI uses the durable read session", /osiV2ReadSession\(\['case:review'\]/.test(intakeUi) && !/Math\.random|signMessage/.test(intakeUi));
ok("legacy review UI cannot submit a transaction or vote", /Legacy review voting is disabled/.test(vouchFunction) && !/withOnchainVote/.test(vouchFunction));
ok("legacy page loads read-session support after Supabase core", read("legacy.html").indexOf("52-read-session.js") > read("legacy.html").indexOf("50-core-supabase.js"));

const aiEdge = read("supabase/functions/osi-ai-pack/index.ts");
const aiUi = read("assets/js/80-ai-pack.js");
ok("AI Pack generation is fail-closed and makes no provider call", /native_ai_pack_generation_disabled/.test(aiEdge) && !/ANTHROPIC_API_KEY|api\.anthropic\.com/.test(aiEdge));
ok("restricted AI Pack reads require a report-review session", /verifyReadSessionToken/.test(aiEdge) && /READ_SESSION_SCOPES\.REPORT_REVIEW/.test(aiEdge));
ok("AI Pack public metadata is an explicit content-free projection", /select\("case_ref,pack_type,status,created_at"\)/.test(aiEdge));
ok("legacy AI Pack UI has no direct content query or mutation", /osiV2ReadSession\(\['report:review'\]/.test(aiUi) && !/supaGet\(|supaPatch\(|mode:'generate'/.test(aiUi));

const sasIssuer = read("supabase/functions/_shared/osi-v2-sas-issuer.ts");
ok("submitted SAS transaction keeps authoritative cache pending", /p_state: "pending_verification"/.test(sasIssuer) && /decision\.action \+ "_submitted"/.test(sasIssuer));
ok("submitted SAS transaction is not cached as verified or revoked", !/p_state: decision\.action === "issue" \? "verified" : "revoked"/.test(sasIssuer));

process.stdout.write(`Security hardening tests: ${passed} passed\n`);
