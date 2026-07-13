// Dependency-free analyst activation core and gateway contract tests.
// Run: node tests/osi-v2-analyst-core.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../supabase/functions/_shared/osi-v2-analyst-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const edge = fs.readFileSync(path.join(root, "supabase/functions/osi-v2-analyst/index.ts"), "utf8");
const sql = fs.readFileSync(path.join(root, "supabase/migrations/20260713184533_osi_v2_analyst_activation.sql"), "utf8");
const wallet = "11111111111111111111111111111111";
const versionId = "018f0e80-0000-4000-8000-000000000001";
const versionRef = "OSI-APP-018F0E800000";

let count = 0;
function ok(condition, message) {
  count += 1;
  if (!condition) throw new Error("not ok " + count + " - " + message);
  console.log("ok " + count + " - " + message);
}
function rejects(fn, message) {
  let rejected = false;
  try { fn(); } catch { rejected = true; }
  ok(rejected, message);
}

const application = core.normalizeApplicationPayload({
  handle: "Chain_Sleuth",
  display_name: "Chain Sleuth",
  bio: "Independent Solana transaction researcher.",
  expertise: ["osint", "blockchain_forensics", "osint"],
  links: [{ label: "Research", url: "https://example.com/work#section" }],
  motivation: "I want to review public incident evidence with careful attribution and a challengeable record.",
  experience: "I have traced Solana transaction flows and published reproducible research with cited transaction references.",
  proof_urls: ["https://example.com/proof"],
}, { sha256: "a".repeat(64), mime: "image/png" });

ok(application.profile.handle === "chain_sleuth", "handle is normalized for case-insensitive uniqueness");
ok(application.profile.expertise.join(",") === "blockchain_forensics,osint", "expertise is canonical and deduplicated");
ok(application.profile.links[0].url === "https://example.com/work", "public link fragments are removed");
rejects(() => core.normalizeApplicationPayload({
  handle: "x", display_name: "X", bio: "short", expertise: [], links: [],
  motivation: "short", experience: "short", proof_urls: [],
}), "invalid public profile and application fields are rejected");
rejects(() => core.normalizeApplicationPayload({
  handle: "valid_handle", display_name: "Valid Name", bio: "A sufficiently long public biography.",
  expertise: ["osint"], links: [{ label: "local", url: "https://127.0.0.1/a" }],
  motivation: "A sufficiently long motivation that explains a responsible public evidence review practice in detail.",
  experience: "A sufficiently long experience statement for this focused security test.", proof_urls: [],
}), "private and local tracking link targets are rejected");
rejects(() => core.normalizeApplicationPayload({
  handle: "valid_handle", display_name: "Valid Name", bio: "A sufficiently long public biography.",
  expertise: ["osint"], links: [],
  motivation: "This text is long enough but includes a seed phrase which must never be accepted by this application flow.",
  experience: "A sufficiently long experience statement for this focused security test.", proof_urls: [],
}), "secret material is rejected");

const binding = {
  purpose: "ANALYST_APPLICATION_VERSION_SUBMITTED",
  target_type: "application_version",
  target_ref: versionRef,
  actor_wallet: wallet,
  actor_role: "wallet",
  decision: "submit",
  nonce: "n".repeat(43),
  payload_hash: "b".repeat(64),
  issued_at: 1_700_000_000,
  expires_at: 1_700_000_120,
};
const message = core.canonicalAnalystEventMessage(binding);
ok(message.includes("|t=application_version|id=" + versionRef + "|a=" + wallet + "|"), "message binds exact public version ref and actor");
ok(core.exactAnalystEventMessage(message, binding, 1_700_000_060), "exact fresh message is accepted");
ok(!core.exactAnalystEventMessage(message.replace("d=submit", "d=revise"), binding, 1_700_000_060), "different decision is rejected");
ok(!core.exactAnalystEventMessage(message, binding, 1_700_000_121), "expired message is rejected");

const probation = core.analystProbationPayload(wallet, versionId, versionRef);
ok(probation.status === "probationary_analyst" && probation.tier_code === "probationary" && probation.weight === "0.50", "probation outcome is exact and server-derived");

const png = new Uint8Array(45);
png.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82], 0);
new DataView(png.buffer).setUint32(16, 64);
new DataView(png.buffer).setUint32(20, 64);
png.set([0,0,0,0,73,69,78,68,0,0,0,0], png.length - 12);
ok(core.inspectProfileImage(png, "image/png").width === 64, "bounded PNG with exact magic and terminal IEND is accepted");
rejects(() => core.inspectProfileImage(new TextEncoder().encode("<svg onload=alert(1)></svg>"), "image/png"), "SVG and executable markup are rejected");
rejects(() => core.inspectProfileImage(new Uint8Array([...png, 1]), "image/png"), "content appended after the image terminator is rejected");

const dto = core.publicAnalystDto({
  wallet, handle: "chain_sleuth", display_name: "Chain Sleuth", bio: "Public bio",
  avatar_url: null, expertise_public: ["osint"], links_public: [],
  status: "probationary_analyst", tier_code: "probationary", weight_cached: 0.5,
}, [], [{
  event_type: "ANALYST_PROBATION", actor_wallet: wallet, actor_role: "maintainer",
  decision: "probation", proof_type: "solana_memo", tx_sig: "1".repeat(64),
  occurred_at: "2026-07-13T00:00:00Z", payload_hash: "secret", nonce: "secret", signature: "secret",
}]);
ok(!("payload_hash" in dto.proof_history[0]) && !("nonce" in dto.proof_history[0]) && !("signature" in dto.proof_history[0]), "public DTO excludes private proof material");

ok(edge.includes("authenticatedMaintainerId") && edge.includes("configuredAdminWallet") && edge.includes("fullMaintainer"), "every maintainer operation has a double-gate primitive");
ok((edge.match(/await fullMaintainer\(req, wallet\)/g) ?? []).length >= 5, "maintainer reads and writes independently revalidate both gates");
ok(edge.includes("target.application.applicant_wallet === wallet") && sql.includes("application_row.applicant_wallet = bound_nonce.actor_wallet"), "self-review is denied in Edge and database layers");
ok(edge.includes("inspectProfileImage") && edge.includes('sha256HexUtf8(wallet)) + \"/\" + image.sha256'), "avatar bytes and immutable owner/content path are enforced");
ok(sql.includes("OSI_V2_ANALYST_WRITES_ENABLED', 'true'"), "reviewed analyst slice is enabled by its exact migration");
ok(edge.includes("data?.[0]?.value === \"true\""), "missing or malformed analyst rollout state still fails closed");
ok(sql.includes("weight_cached = 0.50") && sql.includes("tier_code = 'probationary'"), "database derives exact probationary weight and tier");
ok(sql.includes("force row level security") || fs.readFileSync(path.join(root, "supabase/migrations/20260711092856_osi_v2_default_deny.sql"), "utf8").includes("analyst_application_reviews"), "analyst tables remain under forced default-deny RLS");
ok(!edge.includes("select(\"*\")"), "gateway avoids select-star projections");

console.log("1.." + count);
