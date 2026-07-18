import { readFileSync } from "node:fs";
import vm from "node:vm";

let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error("FAIL: " + name);
  passed += 1;
  console.log("PASS: " + name);
}

const source = readFileSync(new URL("../assets/js/v2-wire-integration.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const reportCss = readFileSync(new URL("../assets/css/v2-report-integration.css", import.meta.url), "utf8");
const legacyWire = readFileSync(new URL("../assets/js/40-wire-field.js", import.meta.url), "utf8");
const context = {
  window: null,
  document: {
    readyState: "loading",
    addEventListener: () => {},
    getElementById: () => null,
    body: { style: {} },
  },
  console,
  Date,
  URL,
  Promise,
  crypto: { randomUUID: () => "11111111-2222-4333-8444-555555555555" },
  setTimeout: () => 1,
  clearTimeout: () => {},
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "public-anon-key",
  SUPA_AUTH_TOKEN: "",
  walletPubkey: null,
};
context.window = context;
vm.createContext(context);
vm.runInContext(source, context);

const sig = "2".repeat(88);
const report = {
  wire_report_public_ref: "OSI-WR-A1B2C3D4E5F6",
  current_version_ref: "OSI-WV-A1B2C3D4E5F60718",
  current_version_no: 2,
  revision_eligible: true,
  versions: [{
    version_ref: "OSI-WV-B1B2C3D4E5F60718",
    version_no: 2,
    lifecycle_state: "submitted",
    title_public_safe: '<img src=x onerror="alert(1)">',
    content_public_safe: '<script>alert("summary")</script>',
    body_private: '<svg onload="alert(2)">analysis</svg>',
    uncertainties_private: 'Limit: </p><iframe src="javascript:alert(3)">',
    evidence_snapshot_hash: "a".repeat(64),
    submitted_at: "2026-07-18T12:00:00Z",
    evidence: [{ ordinal: 1, kind: "url", ref: 'https://example.org/?q="><script>alert(4)</script>' }],
    proof: {
      proof_type: "solana_memo",
      tx_sig: sig,
      occurred_at: "2026-07-18T12:00:00Z",
    },
  }, {
    version_ref: "OSI-WV-A1B2C3D4E5F60718",
    version_no: 1,
    lifecycle_state: "submitted",
    title_public_safe: "Initial submitted finding",
    content_public_safe: "Initial public-safe summary remains private before publication.",
    body_private: "Initial exact detailed analysis remains immutable in this author-only fixture.",
    uncertainties_private: "Initial uncertainty remains explicit and immutable.",
    evidence_snapshot_hash: "b".repeat(64),
    submitted_at: "2026-07-18T10:00:00Z",
    evidence: [],
    proof: null,
  }],
};
const card = context.OSIWireUI.reportCard(report);
ok("Wire author workspace escapes hostile title, summary, analysis, limits, and evidence",
  !card.includes("<script>") && !card.includes("<img src=x")
    && !card.includes("<svg onload") && !card.includes("<iframe")
    && card.includes("&lt;script&gt;") && card.includes("&lt;img src=x"));
ok("private evidence URLs render as text rather than executable links",
  card.includes("https://example.org/?q=&quot;&gt;&lt;script&gt;")
    && !card.includes('href="https://example.org'));
ok("only a validated Solana transaction signature creates a Solscan proof link",
  card.includes("https://solscan.io/tx/" + sig));
const invalidProofCard = context.OSIWireUI.reportCard({
  ...report,
  versions: [{ ...report.versions[0], proof: { ...report.versions[0].proof, tx_sig: '" onclick="alert(5)' } }],
});
ok("invalid proof references never become links", !invalidProofCard.includes("solscan.io/tx"));
ok("submitted and revised immutable states are represented without inventing publication",
  card.includes("Version history (2)") && card.includes("version 2")
    && card.includes("version 1") && !card.includes("Open published version"));
ok("Wire intake copy says submit while governed publication remains a separate action",
  source.includes("'Submit a Wire Report'")
    && source.includes("Create an exact private Wire Report version")
    && !source.includes("'Publish a Wire Report'"));
ok("Wire modal and detail drawer reuse the fixed Case and Report component vocabulary",
  html.includes('id="osi-wire-modal"') && html.includes('class="fo-modal osi-report-modal"')
    && html.includes('class="osi-report-evidence"')
    && html.includes('id="osi-wire-safety"')
    && html.includes('id="osi-wire-drawer"')
    && html.includes('class="osi-case-drawer"'));
ok("Wire intake has keyboard focus trapping and reduced-motion support",
  source.includes("trapFocus(event,modal)")
    && reportCss.includes("@media(prefers-reduced-motion:reduce)"));
ok("the reused modal and cards collapse safely at 390px",
  reportCss.includes("@media(max-width:600px)")
    && reportCss.includes(".osi-report-card-head{grid-template-columns:1fr}")
    && reportCss.includes(".osi-report-modal .fo-form-actions{flex-direction:column-reverse}"));
ok("the legacy Wire submission path delegates to the native gateway",
  !legacyWire.includes("OSI_WIRE_DISPATCH_SUBMITTED")
    && !legacyWire.includes("supaPost('reports', row)")
    && legacyWire.includes("window.osiV2SubmitWire"));
ok("wallet or private-session invalidation clears the rendered Wire workspace",
  source.includes("wireClearPrivateMode()")
    && legacyWire.includes("function wireClearPrivateMode()"));
ok("no new visual stylesheet was introduced for Wire",
  !html.includes("v2-wire-integration.css") && html.includes("v2-report-integration.css"));

const hostilePublicEvidence = context.OSIWireUI.publicEvidenceItem({
  ordinal: 1,
  kind: "url",
  ref: 'https://example.org/path?q="><img src=x onerror=alert(9)>',
  sha256: "c".repeat(64),
});
ok("published Wire evidence escapes hostile link text and attributes",
  !hostilePublicEvidence.includes("<img")
    && hostilePublicEvidence.includes("&lt;img")
    && hostilePublicEvidence.includes('rel="noopener"'));
const unsafePublicEvidence = context.OSIWireUI.publicEvidenceItem({
  ordinal: 2, kind: "url", ref: "javascript:alert(10)", sha256: "d".repeat(64),
});
ok("non-HTTPS public evidence never becomes an executable link",
  !unsafePublicEvidence.includes("href=") && unsafePublicEvidence.includes("javascript:alert"));
ok("six published Wire detail sections and queue actions are behavior-enabled",
  source.includes("['overview','Overview']")
    && source.includes("['evidence','Evidence']")
    && source.includes("['reviews','Reviews']")
    && source.includes("['challenges','Challenges']")
    && source.includes("['support','Support']")
    && source.includes("['proof','Proof Log']")
    && source.includes("data-wire-review")
    && source.includes("data-wire-publish"));
ok("current-version actions and exact lamport totals fail closed in the UI",
  source.includes("item.is_current_published===true")
    && source.includes("sum+BigInt(value)")
    && source.includes("caps.support_enabled===true")
    && source.includes("Wire and payment write gates."));
ok("review, publication, and challenge controls honor the dedicated write capability",
  source.includes("caps.review_enabled===true")
    && source.includes("caps.publication_enabled===true")
    && source.includes("caps.challenge_enabled===true"));
ok("Wire detail tabs expose keyboard tab semantics",
  source.includes("setAttribute('role','tablist')")
    && source.includes('role="tab"')
    && source.includes("event.key==='ArrowRight'")
    && source.includes("fresh.focus()"));
ok("bootstrap publication and accepted-challenge states are labeled honestly",
  source.includes("Maintainer bootstrap publication")
    && source.includes("Challenge upheld, under re-review")
    && source.includes("Maintainer bootstrap is unavailable"));

console.log(`\n${passed} Wire Phase 1 and Phase 2 UI checks passed.`);
