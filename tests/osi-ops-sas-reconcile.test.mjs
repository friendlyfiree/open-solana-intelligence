// Static and core checks for the SAS reconcile control in the native
// Operations Center. The browser suite (tests/browser/issue-26.spec.js,
// "SAS reconcile") drives the real DOM; this file pins the decision core and
// the source-level guarantees a reviewer would otherwise have to read for.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const require = createRequire(import.meta.url);
const surface = require("../assets/js/88-functional-surface.js");
const script = read("assets/js/88-functional-surface.js");
const i18n = read("assets/js/03-i18n.js");
const css = read("assets/css/70-intelligence-redesign.css");
const analystFunction = read("supabase/functions/osi-v2-analyst/index.ts");
const issuer = read("supabase/functions/_shared/osi-v2-sas-issuer.ts");
const sasCore = read("supabase/functions/_shared/osi-v2-sas-core.mjs");

let passed = 0;
function ok(name, value) {
  if (!value) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}

// Turkish keys, parsed the same way the i18n tooling reads them.
const turkishBlock = i18n.slice(i18n.indexOf("  var turkish = {"), i18n.indexOf("  var translations = {"));
const turkish = new Set([...turkishBlock.matchAll(/^    '((?:[^'\\]|\\.)*)'\s*:/gm)].map((m) => m[1].replace(/\\'/g, "'")));
const hasTurkish = (text) => turkish.has(text);

const sas = surface.sas;
ok("the core exports the SAS reconcile helpers", sas && typeof sas.outcome === "function" && typeof sas.error === "function");

// --- Signature and wallet validation -------------------------------------
const SIG = "5".repeat(88);
ok("a base58 signature of plausible length is accepted", sas.isTransactionSignature(SIG) && sas.isTransactionSignature("4".repeat(64)));
ok("short, long, non-base58 and markup signatures are rejected",
  !sas.isTransactionSignature("5".repeat(63))
    && !sas.isTransactionSignature("5".repeat(89))
    && !sas.isTransactionSignature("0".repeat(88))
    && !sas.isTransactionSignature("O".repeat(88))
    && !sas.isTransactionSignature('5555"><img src=x onerror=alert(1)>')
    && !sas.isTransactionSignature(null)
    && !sas.isTransactionSignature(12345));
ok("wallet validation accepts base58 addresses and rejects anything else",
  sas.isWalletAddress("11111111111111111111111111111116")
    && !sas.isWalletAddress("1111")
    && !sas.isWalletAddress("11111111111111111111111111111116\" onclick=\"x")
    && !sas.isWalletAddress(undefined));

// --- Every action code the server can return -----------------------------
// Action codes come from maybeReconcileSasCredential (issuer) and the
// reconcileIssuance / reconcileLiveAction decisions (core).
const serverActions = new Set([...issuer.matchAll(/action: "([a-z_]+)"/g), ...sasCore.matchAll(/action: "([a-z_]+)"/g)].map((m) => m[1]));
const handled = ["satisfied", "issue", "revoke", "repair_required", "defer", "noop_unconfigured", "noop", "error"];
const internal = new Set(["submit_issue", "submit_revoke"]);
ok("every server action code is mapped (submit_* are internal and never returned)",
  [...serverActions].every((action) => handled.includes(action) || internal.has(action))
    && issuer.includes("action: decision.action") && issuer.includes('action: "error"'));

const outcomes = [
  [{ action: "satisfied", reason: "already_verified" }, "neutral", "The live SAS credential already matches this analyst status. No Solana transaction was sent."],
  [{ action: "satisfied", reason: "already_absent" }, "neutral", "No live SAS credential exists, and none is expected for this analyst status. No Solana transaction was sent."],
  [{ action: "satisfied", reason: "other" }, "neutral", "The live SAS state already matches the server-derived analyst status. No Solana transaction was sent."],
  [{ action: "issue", reason: "analyst_tier", tx_sig: SIG, submitted_on_chain: true }, "pending", "The server submitted a transaction to issue this wallet's SAS credential."],
  [{ action: "revoke", reason: "not_analyst_tier", tx_sig: SIG, submitted_on_chain: true }, "pending", "The server submitted a transaction to close this wallet's SAS credential."],
  [{ action: "issue", reason: "analyst_tier", tx_sig: null }, "warning", "The server tried to issue this wallet's SAS credential, but the transaction could not be submitted. The ledger records the failure."],
  [{ action: "revoke", reason: "not_analyst_tier", tx_sig: null }, "warning", "The server tried to close this wallet's SAS credential, but the transaction could not be submitted. The ledger records the failure."],
  [{ action: "repair_required", reason: "issuer_mismatch" }, "warning", "The live SAS account does not match what OSI expects, so the server left it unchanged. No Solana transaction was sent."],
  [{ action: "defer", reason: "rpc_unavailable" }, "warning", "The live SAS state could not be read because the trusted Solana RPC is unavailable. No Solana transaction was sent."],
  [{ action: "defer", reason: "issuer_secret_absent" }, "warning", "A change is needed, but the issuer key is not available on the server. No Solana transaction was sent."],
  [{ action: "defer", reason: "other" }, "warning", "The server postponed this change. No Solana transaction was sent."],
  [{ action: "noop_unconfigured", reason: "issuance_disabled" }, "neutral", "SAS credential issuance is off, so the server made no live check. No Solana transaction was sent."],
  [{ action: "noop_unconfigured", reason: "not_configured" }, "neutral", "SAS is not fully configured on the server, so it made no live check. No Solana transaction was sent."],
  [{ action: "noop", reason: "no_desired_transition" }, "neutral", "No change is needed for this wallet. No Solana transaction was sent."],
  [{ action: "error", reason: "exception" }, "error", "The check stopped on the server with an error. The ledger records it."],
  [{ action: "brand_new_code" }, "warning", "The server returned a result this page does not recognize ({action}). Treat the live state as unknown."],
];
for (const [input, tone, message] of outcomes) {
  const view = sas.outcome(input);
  ok(`${input.action}/${input.reason || "none"} reads as one plain sentence with tone ${tone}`,
    view.tone === tone && view.message === message && hasTurkish(message));
}
ok("an unknown action is named, humanised and stripped of markup",
  sas.outcome({ action: "<b>odd</b>" }).variables.action === "boddb");

const submitted = sas.outcome({ action: "issue", tx_sig: SIG, submitted_on_chain: true, next_step: sas.nextSteps[0] });
ok("a submitted transaction is pending, keeps its validated signature and the server next step",
  submitted.submitted && submitted.txSig === SIG && !submitted.txSigMalformed && submitted.nextStep === sas.nextSteps[0] && submitted.nextStepFromServer);
const malformed = sas.outcome({ action: "issue", tx_sig: 'x"><script>', submitted_on_chain: true });
ok("a malformed signature is still reported as submitted but never becomes a link target",
  malformed.submitted && malformed.txSig === "" && malformed.txSigMalformed);
const failedSend = sas.outcome({ action: "issue", tx_sig: null, submitted_on_chain: false, next_step: "No additional on-chain write is required." });
ok("a failed submission replaces the server's generic no-write next step with a re-check",
  failedSend.nextStep === "Run this check again to read the live state before any repair." && failedSend.nextStepFromServer === false);
ok("a server error replaces the generic no-write next step too",
  sas.outcome({ action: "error", next_step: "No additional on-chain write is required." }).nextStep
    === "Run this check again to read the live state before any repair.");
ok("no outcome message claims confirmation, verification or anchoring",
  outcomes.every(([input]) => !/confirmed|verified on|anchored|Memo/i.test(sas.outcome(input).message)));
ok("repair reasons cover every live-state mismatch the core can report",
  ["credential_mismatch", "schema_mismatch", "issuer_mismatch", "wrong_program", "decode_error", "expired", "not_configured"]
    .every((reason) => sasCore.includes(`reason: "${reason}"`) && hasTurkish(sas.repairReasons[reason]))
    && hasTurkish(sas.repairReasons.unexpected_attestation_state));
ok("an attestation is shown only when it is a valid base58 address",
  sas.outcome({ action: "satisfied", attestation: "11111111111111111111111111111119" }).attestation === "11111111111111111111111111111119"
    && sas.outcome({ action: "satisfied", attestation: "javascript:alert(1)" }).attestation === "");

// --- The exact next_step sentences the server returns --------------------
const serverSteps = [...analystFunction.slice(analystFunction.indexOf("async function reconcileSas")).matchAll(/"([A-Z][^"]+\.)"/g)].map((m) => m[1]);
ok("the client knows every next_step sentence reconcileSas returns",
  serverSteps.length === 4 && serverSteps.every((step) => sas.nextSteps.includes(step)));
ok("every server next_step sentence has an exact-match Turkish key", sas.nextSteps.every(hasTurkish));

// --- Errors ---------------------------------------------------------------
const gateReasons = [...read("supabase/functions/_shared/osi-v2-case-write-core.mjs").matchAll(/reason: "((?:half_)?maintainer_[a-z_]+)"/g)].map((m) => m[1]);
ok("every maintainer gate refusal the server can return has its own sentence",
  gateReasons.length === 3 && gateReasons.every((reason) => !sas.error(reason).message.includes("{reason}") && sas.error(reason).refresh === false));
for (const code of ["half_maintainer_wallet_only", "half_maintainer_auth_only", "maintainer_denied", "maintainer_access_required",
  "analyst_profile_not_found", "bad_wallet", "wallet_mismatch", "not_configured", "bad_op", "Failed to fetch", "http_503", "", "teapot_error"]) {
  const failure = sas.error(code);
  ok(`error ${code || "(empty)"} maps to a translated plain sentence`, typeof failure.message === "string" && hasTurkish(failure.message));
}
ok("a lost response says the server may still have acted and re-reads the ledger",
  /may still have acted/.test(sas.error("Failed to fetch").message) && sas.error("Failed to fetch").refresh === true);
ok("an unknown error is shown humanised and without markup",
  sas.error("weird_<b>code</b>").variables.reason === "weird bcodeb");

// --- Source guarantees ----------------------------------------------------
const dom = script.slice(script.indexOf("// SAS Authority Operations shows"), script.indexOf("  var lastRender=null;"));
ok("the old read-only comment and read-only note are gone",
  !script.includes("SAS status is read-only here") && !script.includes("opsText('Read-only. The server derives"));
ok("the request body is exactly op, maintainer wallet and analyst wallet",
  dom.includes("{op:'reconcile_sas',wallet:access.wallet,analyst_wallet:wallet}"));
ok("both maintainer gates are re-read before the confirmation opens and before the request",
  /function openSasConfirm[\s\S]*?var access=maintainerAccess\(\);\s*if\(!access\.allowed\)/.test(dom)
    && /async function runSasReconcile[\s\S]*?var access=maintainerAccess\(\);\s*if\(!access\.allowed\|\|/.test(dom)
    && dom.includes("window.resolveMaintainerAccess()"));
ok("a response that arrives after access ends is discarded and the panel is cleared",
  /if\(!after\.allowed\|\|after\.wallet!==access\.wallet\)\{forgetSasRuns\(\);clearNativeOperations/.test(dom));
ok("results are kept per wallet and cleared when access ends or private data is cleared",
  dom.includes("sasRuns[wallet]") && /RegisterPrivateCache\('operations',function\(\)\{forgetSasRuns\(\);/.test(script)
    && /if\(!access\.allowed\)\{forgetSasRuns\(\);clearNativeOperations/.test(script));
ok("the confirmation is inline with no browser dialog",
  !/window\.confirm|\bconfirm\(|alert\(/.test(dom) && dom.includes("role','group'") && dom.includes("event.key!=='Escape'"));
ok("the running state disables the control, marks the row busy and names the wait",
  dom.includes("line.setAttribute('aria-busy','true')") && dom.includes("run.phase==='running'")
    && dom.includes("opsText('Checking live SAS state...')"));
ok("the result region is a status region inside the row",
  dom.includes("status.setAttribute('role','status')") && dom.includes("osi-sas-panel"));
ok("the Solscan link is built only from a validated signature and opens safely",
  dom.includes("if(view.txSig)") && dom.includes("'https://solscan.io/tx/'+encodeURIComponent(view.txSig)")
    && dom.includes("link.rel='noopener noreferrer'"));
ok("rendering uses text nodes only, with no HTML string injection or inline handlers",
  !/innerHTML|insertAdjacentHTML|outerHTML|onclick=|setAttribute\('on/.test(dom));
ok("rows never use the public data-sas-wallet badge hook",
  !/'data-sas-wallet'/.test(dom) && dom.includes("'data-ops-sas-wallet'"));
ok("the panel re-reads sas_operations_status after a result",
  /async function refreshSasStatus[\s\S]*?op:'sas_operations_status'/.test(dom) && dom.includes("if(refresh)await refreshSasStatus(generation);"));

// --- Every visible sentence in the control is translated ------------------
const literals = [...dom.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"))
  .filter((text) => /^[A-Z(]/.test(text) && /\s/.test(text));
const missing = literals.filter((text) => !hasTurkish(text));
ok(`every English sentence in the SAS control has a Turkish key (${literals.length} checked)`, literals.length > 25 && missing.length === 0);
if (missing.length) console.log(missing);
const visible = literals.concat(outcomes.map((row) => row[2]), sas.nextSteps, Object.values(sas.repairReasons));
ok("no visible SAS control text uses an em dash", visible.every((text) => !text.includes("—")));
ok("Turkish keys exist for the new labels and buttons",
  ["Reconcile with live SAS", "Confirm", "Cancel", "View on Solscan", "Transaction submitted. Not yet confirmed on Solana.", "Next step: {step}", "Last check: {time}"].every(hasTurkish));

// --- Styles stay in one append-only block ---------------------------------
const blockStart = css.indexOf("/* === Item-6 sas pass === */");
ok("SAS reconcile styles live in one delimited block at the end of the redesign stylesheet",
  blockStart > 0 && css.indexOf("/* === end Item-6 sas pass === */") > blockStart
    && css.slice(blockStart).includes(".osi-sas-confirm") && css.slice(blockStart).includes("prefers-reduced-motion"));
ok("a submitted transaction is never styled with verified green",
  !/osi-sas[^{]*\{[^}]*var\(--verified\)/.test(css.slice(blockStart)));

console.log(`\n${passed} SAS reconcile checks passed.`);
