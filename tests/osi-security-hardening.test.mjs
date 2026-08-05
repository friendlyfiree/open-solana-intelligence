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

const externalScriptTags = browserSource.match(/<script\b[^>]*\bsrc="https:\/\/[^\"]+"[^>]*><\/script>/g) || [];
ok("third-party browser scripts carry SHA-384 SRI and anonymous CORS", externalScriptTags.length >= 2
  && externalScriptTags.every((tag) => /\bintegrity="sha384-[A-Za-z0-9+/=]+"/.test(tag)
    && /\bcrossorigin="anonymous"/.test(tag)
    && /\breferrerpolicy="no-referrer"/.test(tag)));
for (const integrity of [
  "sha384-PMSj0RMOtmkmKsWcDKPG3C6+cBg9JTZ+NnsE2U0yuOUA9Wzn5FQFnJeLS8EK5nW+",
  "sha384-xo1g+ODR6i1cxIVZeALc/apXFHeaJHO1j1whMO3dhtdBChWeaihnDs7UnXs9ch78",
  "sha384-GFr3yTh5lJznCbZfpTtXnwboFsxqtTQoeTZCRHhE0579KrRmlCzen5AA8ohaB5ug",
]) {
  ok(`approved dependency integrity is pinned: ${integrity.slice(0, 20)}`, browserSource.includes(`integrity="${integrity}"`));
}

const vercel = JSON.parse(read("vercel.json"));
const securityHeaders = new Map((vercel.headers?.[0]?.headers || []).map((row) => [row.key, row.value]));
ok("Vercel denies framing and MIME sniffing", securityHeaders.get("Content-Security-Policy")?.includes("frame-ancestors 'none'")
  && securityHeaders.get("Content-Security-Policy")?.includes("object-src 'none'")
  && securityHeaders.get("X-Content-Type-Options") === "nosniff"
  && securityHeaders.get("X-Frame-Options") === "DENY");
ok("Vercel enforces transport and privacy headers", securityHeaders.get("Strict-Transport-Security")?.includes("max-age=63072000")
  && securityHeaders.get("Referrer-Policy") === "strict-origin-when-cross-origin"
  && securityHeaders.has("Permissions-Policy"));

// The Content-Security-Policy is a real allowlist, not a token one. Each
// directive below is pinned so the allowlist cannot quietly widen: a new
// third-party script host or a new outbound endpoint has to change this test,
// in the same pull request, with a reviewer looking at it.
const csp = String(securityHeaders.get("Content-Security-Policy") || "");
const directive = (name) => {
  const match = csp.split(";").map((part) => part.trim()).find((part) => part === name || part.startsWith(`${name} `));
  return match ? match.slice(name.length).trim() : null;
};
ok("CSP sets a self default rather than leaving unlisted fetches open",
  directive("default-src") === "'self'");
ok("CSP restricts script origins to self plus the three SRI-pinned CDNs",
  ["'self'", "https://bundle.run", "https://unpkg.com", "https://cdn.jsdelivr.net"]
    .every((source) => (directive("script-src") || "").split(/\s+/).includes(source)));
ok("CSP admits injected wallet providers by scheme so the page policy never breaks a wallet",
  ["chrome-extension:", "moz-extension:"].every((scheme) => (directive("script-src") || "").split(/\s+/).includes(scheme)));
// connect-src is the directive that actually bounds exfiltration on a site that
// handles wallet interaction, so it is pinned exactly rather than by substring.
const connectSources = new Set((directive("connect-src") || "").split(/\s+/).filter(Boolean));
ok("CSP names every outbound endpoint exactly, and nothing else",
  connectSources.size === 9
  && [
    "'self'",
    "https://afibxpniwfnavdobecrn.supabase.co",
    // Same origin over websocket. The Supabase client library owns whether it
    // opens one, not this codebase, so the origin is listed rather than left
    // to fail in production the first time it decides to.
    "wss://afibxpniwfnavdobecrn.supabase.co",
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
    "https://solana.drpc.org",
    "https://endpoints.omniatech.io",
    "https://api.coingecko.com",
    "https://api.web3forms.com",
  ].every((source) => connectSources.has(source)));
ok("CSP forbids plugins, nested framing and cross-origin form posts",
  directive("object-src") === "'none'"
  && directive("frame-src") === "'none'"
  && directive("frame-ancestors") === "'none'"
  && directive("form-action") === "'self'"
  && directive("base-uri") === "'self'"
  && csp.includes("upgrade-insecure-requests"));
ok("CSP keeps images and fonts off arbitrary third-party origins",
  !/https:(?:\s|;|$)/.test(directive("img-src") || "")
  && !(directive("img-src") || "").includes("*")
  && (directive("font-src") || "").split(/\s+/).every((source) => source === "'self'" || source === "data:"));

// The frozen V1 fallback stays reachable for historical links, but a search
// result must never land a person on the unmaintained surface.
const legacyHeaders = new Map(
  (vercel.headers || [])
    .filter((rule) => rule.source === "/legacy.html")
    .flatMap((rule) => rule.headers || [])
    .map((row) => [row.key, row.value]));
const legacySource = read("legacy.html");
ok("the frozen legacy surface is excluded from indexing at every layer",
  /noindex/.test(legacyHeaders.get("X-Robots-Tag") || "")
  && /<meta name="robots" content="noindex/.test(legacySource)
  && /<link rel="canonical" href="https:\/\/open-solana-intel\.vercel\.app\/">/.test(legacySource)
  && /^Disallow: \/legacy\.html$/m.test(read("robots.txt")));
ok("no browser surface loads a third-party webfont",
  !/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(browserSource));

// Recurse, so archived rollouts stay under the same supply-chain rule as live
// ones. An archived workflow is one `git mv` away from running again, and a
// float-tagged action inside it would be just as dangerous then as now.
const workflowDir = path.join(root, ".github", "workflows");
const workflowFiles = [];
(function collect(dir, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) collect(path.join(dir, entry.name), `${prefix}${entry.name}/`);
    else if (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")) workflowFiles.push(`${prefix}${entry.name}`);
  }
})(workflowDir, ".github/workflows/");
const workflowSource = workflowFiles.map((name) => read(name)).join("\n");
ok(`every workflow is covered by the supply-chain check, archived ones included (${workflowFiles.length})`,
  workflowFiles.length >= 30
  && workflowFiles.some((name) => name.includes("/archive/"))
  && workflowFiles.includes(".github/workflows/osi-v2-foundation.yml"));

// Exactly one workflow may run automatically on a pull request. Everything else
// is manual by design: these are production rollouts against a live mainnet
// project, and an accidental `on: push` in one of them is not a lint issue.
const autoTriggered = workflowFiles.filter((name) => {
  const source = read(name);
  const header = source.slice(0, source.search(/^jobs:/m) >>> 0);
  return /^on:\s*$/m.test(header) && /^\s{2}(pull_request|push|schedule):/m.test(header);
});
ok("only the validation gate runs without a human dispatching it",
  autoTriggered.length === 1 && autoTriggered[0] === ".github/workflows/osi-v2-foundation.yml");
const workflowUses = [...workflowSource.matchAll(/\buses:\s*([^\s#]+)/g)].map((match) => match[1]);
ok("every external workflow action is immutable SHA-pinned", workflowUses.length > 0
  && workflowUses.every((value) => /@[a-f0-9]{40}$/.test(value))
  && /actions\/checkout@[a-f0-9]{40}/.test(workflowSource)
  && /actions\/setup-node@[a-f0-9]{40}/.test(workflowSource)
  && /actions\/upload-artifact@[a-f0-9]{40}/.test(workflowSource)
  && /denoland\/setup-deno@[a-f0-9]{40}/.test(workflowSource)
  && /supabase\/setup-cli@[a-f0-9]{40}/.test(workflowSource));

// A rollout gate that can never match fails the deployment closed on a
// deployment that is in fact correct, and reads as a real safety refusal. The
// way to write one is to compare a `||`-concatenated boolean against t or f:
// psql prints t/f for a boolean *column*, but concatenation casts to
// true/false, so `select 'rls|' || relforcerowsecurity` emits `rls|true` and a
// `grep '^rls|t$'` never fires. Gates must therefore spell the value out.
const psqlBooleanTokens = [...workflowSource.matchAll(/grep\s+-q\s+'\^[a-z_]+\|(?:[a-z0-9_|]*\|)?([tf])\$?'/g)]
  .map((match) => match[0]);
ok("no workflow gate greps for psql's t/f display form of a concatenated boolean",
  psqlBooleanTokens.length === 0, psqlBooleanTokens.join(" | "));

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
