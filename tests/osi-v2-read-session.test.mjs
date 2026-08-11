import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  isExactReadSessionOrigin,
  issueReadSessionToken,
  READ_SESSION_ABSOLUTE_TTL_SECONDS,
  READ_SESSION_IDLE_TTL_SECONDS,
  READ_SESSION_SCOPES,
  READ_SESSION_TTL_SECONDS,
  readSessionIssuer,
  verifyReadSessionToken,
} from "../supabase/functions/_shared/osi-v2-read-session-core.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, "binary").toString("base64");
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, "base64").toString("binary");

let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}

const secret = "read-session-test-secret-which-is-longer-than-thirty-two-bytes";
const wallet = "11111111111111111111111111111111";
const otherWallet = "22222222222222222222222222222222";
const origin = "https://open-solana-intel.vercel.app";
const issuer = readSessionIssuer("https://afibxpniwfnavdobecrn.supabase.co");
const now = 1_784_110_000;
const scopes = Object.values(READ_SESSION_SCOPES);
const ALL_SCOPE_VALUES = scopes.slice();

const issued = await issueReadSessionToken({
  secret, issuer, audience: origin, allowedOrigin: origin, wallet, scopes,
  authSubject: null, jti: "A".repeat(32), nowSeconds: now,
});
ok("exact production origin gate accepts only the configured origin",
  isExactReadSessionOrigin(origin, origin)
    && !isExactReadSessionOrigin("https://example.invalid", origin)
    && !isExactReadSessionOrigin("*", origin));
ok("working session uses a bounded 30-minute inactivity window and eight-hour absolute lifetime",
  issued.payload.exp - issued.payload.iat === READ_SESSION_TTL_SECONDS
    && READ_SESSION_IDLE_TTL_SECONDS === 1800
    && READ_SESSION_ABSOLUTE_TTL_SECONDS === 28800
    && issued.payload.abs_exp - issued.payload.sid_iat === READ_SESSION_ABSOLUTE_TTL_SECONDS);

const valid = await verifyReadSessionToken({
  token: issued.token, secret, issuer, origin, allowedOrigin: origin, wallet,
  requiredScope: READ_SESSION_SCOPES.CASE_MINE, nowSeconds: now + 1,
});
ok("valid exact-origin, exact-wallet, scoped token is accepted", valid.ok && valid.wallet === wallet);
ok("verification result exposes scopes only on success",
  valid.ok && Array.isArray(valid.scopes) && valid.scopes.includes(READ_SESSION_SCOPES.CASE_MINE));
const aiPackScoped = await verifyReadSessionToken({
  token: issued.token, secret, issuer, origin, allowedOrigin: origin, wallet,
  requiredScope: READ_SESSION_SCOPES.AIPACK_DETAIL, nowSeconds: now + 1,
});
ok("shared token carries the read-only AI Pack detail scope",
  READ_SESSION_SCOPES.AIPACK_DETAIL === "aipack:detail" && aiPackScoped.ok);
const profileScoped = await verifyReadSessionToken({
  token: issued.token, secret, issuer, origin, allowedOrigin: origin, wallet,
  requiredScope: READ_SESSION_SCOPES.PROFILE_SELF, nowSeconds: now + 1,
});
ok("ordinary wallet session carries the dedicated owner-profile scope",
  READ_SESSION_SCOPES.PROFILE_SELF === "profile:self" && profileScoped.ok);
const challengeScoped = await verifyReadSessionToken({
  token: issued.token, secret, issuer, origin, allowedOrigin: origin, wallet,
  requiredScope: READ_SESSION_SCOPES.CHALLENGE_MINE, nowSeconds: now + 1,
});
ok("ordinary wallet session carries a dedicated own-challenge scope",
  READ_SESSION_SCOPES.CHALLENGE_MINE === "challenge:mine" && challengeScoped.ok);
const wrongProfileWallet = await verifyReadSessionToken({
  token: issued.token, secret, issuer, origin, allowedOrigin: origin, wallet: otherWallet,
  requiredScope: READ_SESSION_SCOPES.PROFILE_SELF, nowSeconds: now + 1,
});
ok("owner-profile scope remains bound to the exact wallet",
  !wrongProfileWallet.ok && wrongProfileWallet.reason === "read_session_wrong_wallet");
const withoutAiPack = await issueReadSessionToken({
  secret, issuer, audience: origin, allowedOrigin: origin, wallet,
  scopes: [READ_SESSION_SCOPES.CASE_DETAIL],
  authSubject: null, jti: "C".repeat(32), nowSeconds: now,
});
const missingAiPackScope = await verifyReadSessionToken({
  token: withoutAiPack.token, secret, issuer, origin, allowedOrigin: origin, wallet,
  requiredScope: READ_SESSION_SCOPES.AIPACK_DETAIL, nowSeconds: now + 1,
});
ok("a valid token without AI Pack scope is denied",
  !missingAiPackScope.ok && missingAiPackScope.reason === "read_session_wrong_scope");

// ── Deploy skew ─────────────────────────────────────────────────────────────
// The scope list is shared by nine isolates that deploy separately, so a new
// scope always reaches the issuer before it reaches every verifier. Adding
// `profile:self` proved what that costs: the older isolates rejected the whole
// token over the one entry they did not recognise, and the Review Queue's
// report, analyst and wire lanes answered "tampered" to wallets holding a
// perfectly valid session. These checks pin the skew window shut.
//
// The newer deploy is simulated by importing a copy of this very core whose
// scope list carries one extra entry — the same shape the live issuer had.
const corePath = new URL("../supabase/functions/_shared/osi-v2-read-session-core.mjs", import.meta.url);
const coreSource = readFileSync(corePath, "utf8");
const asModule = (source) =>
  import("data:text/javascript;base64," + Buffer.from(source, "utf8").toString("base64"));

const futureSource = coreSource.replace(
  "export const READ_SESSION_SCOPES = Object.freeze({",
  'export const READ_SESSION_SCOPES = Object.freeze({\n  FUTURE_SURFACE: "future:surface",',
);
ok("the simulated newer deploy genuinely knows a scope this build does not",
  futureSource !== coreSource && !ALL_SCOPE_VALUES.includes("future:surface"));
const future = await asModule(futureSource);

const skewedToken = await future.issueReadSessionToken({
  secret, issuer, audience: origin, allowedOrigin: origin, wallet,
  scopes: [...scopes, "future:surface"],
  authSubject: null, jti: "F".repeat(32), nowSeconds: now,
});
const skewedLanes = await Promise.all([
  READ_SESSION_SCOPES.REPORT_REVIEW,
  READ_SESSION_SCOPES.ANALYST_MAINTAINER,
  READ_SESSION_SCOPES.WIRE_QUEUE,
  READ_SESSION_SCOPES.CASE_REVIEW,
].map((requiredScope) => verifyReadSessionToken({
  token: skewedToken.token, secret, issuer, origin, allowedOrigin: origin, wallet,
  requiredScope, nowSeconds: now + 1,
})));
ok("a scope added by a newer deploy does not take down the lanes an older one already serves",
  skewedLanes.every((result) => result.ok));
ok("an unrecognised scope is dropped rather than trusted",
  skewedLanes.every((result) => result.ok && !result.scopes.includes("future:surface")));

const onlyUnknown = await future.issueReadSessionToken({
  secret, issuer, audience: origin, allowedOrigin: origin, wallet,
  scopes: ["future:surface"], authSubject: null, jti: "G".repeat(32), nowSeconds: now,
});
const nothingRecognised = await verifyReadSessionToken({
  token: onlyUnknown.token, secret, issuer, origin, allowedOrigin: origin, wallet,
  requiredScope: READ_SESSION_SCOPES.CASE_MINE, nowSeconds: now + 1,
});
ok("a token this build recognises nothing in is still refused, as a scope miss",
  !nothingRecognised.ok && nothingRecognised.status === 403
    && nothingRecognised.reason === "read_session_wrong_scope");

await (async () => {
  let rejected = false;
  try {
    await issueReadSessionToken({
      secret, issuer, audience: origin, allowedOrigin: origin, wallet,
      scopes: [READ_SESSION_SCOPES.CASE_MINE, "future:surface"],
      authSubject: null, jti: "H".repeat(32), nowSeconds: now,
    });
  } catch { rejected = true; }
  ok("tolerating an unknown scope on verification never loosens what may be minted", rejected);
})();

// Issuance cannot produce a missing, non-array or empty scope list, so a token
// carrying one is malformed rather than merely unfamiliar, and stays tampering.
const looseSource = coreSource.replace(
  /function normalizedScopes\(scopes\) \{[\s\S]*?\n\}/,
  "function normalizedScopes(scopes) { return scopes; }",
);
ok("the malformed-scope fixture really does bypass the issuer's own check", looseSource !== coreSource);
const loose = await asModule(looseSource);
const malformed = await Promise.all([[], "case:mine", null].map(async (scp, index) => {
  const token = await loose.issueReadSessionToken({
    secret, issuer, audience: origin, allowedOrigin: origin, wallet, scopes: scp,
    authSubject: null, jti: String.fromCharCode(74 + index).repeat(32), nowSeconds: now,
  });
  return verifyReadSessionToken({
    token: token.token, secret, issuer, origin, allowedOrigin: origin, wallet,
    requiredScope: READ_SESSION_SCOPES.CASE_MINE, nowSeconds: now + 1,
  });
}));
ok("an absent, empty or non-array scope list is still refused as tampering",
  malformed.every((result) => !result.ok && result.reason === "read_session_tampered"));

const wrongOrigin = await verifyReadSessionToken({
  token: issued.token, secret, issuer, origin: "https://preview.example", allowedOrigin: origin,
  wallet, requiredScope: READ_SESSION_SCOPES.CASE_MINE, nowSeconds: now + 1,
});
ok("wrong origin is denied", !wrongOrigin.ok && wrongOrigin.reason === "read_session_wrong_origin");
ok("verification failure always carries an HTTP status",
  !wrongOrigin.ok && Number.isInteger(wrongOrigin.status));

const wrongWallet = await verifyReadSessionToken({
  token: issued.token, secret, issuer, origin, allowedOrigin: origin, wallet: otherWallet,
  requiredScope: READ_SESSION_SCOPES.CASE_MINE, nowSeconds: now + 1,
});
ok("wrong wallet is denied", !wrongWallet.ok && wrongWallet.reason === "read_session_wrong_wallet");

const wrongScope = await verifyReadSessionToken({
  token: issued.token, secret, issuer, origin, allowedOrigin: origin, wallet,
  requiredScope: "case:write", nowSeconds: now + 1,
});
ok("read token cannot authorize a write scope", !wrongScope.ok && wrongScope.reason === "read_session_wrong_scope");

const tampered = issued.token.slice(0, -1) + (issued.token.endsWith("A") ? "B" : "A");
const tamperedResult = await verifyReadSessionToken({
  token: tampered, secret, issuer, origin, allowedOrigin: origin, wallet,
  requiredScope: READ_SESSION_SCOPES.CASE_MINE, nowSeconds: now + 1,
});
ok("tampered token is denied", !tamperedResult.ok && tamperedResult.reason === "read_session_tampered");

const expired = await verifyReadSessionToken({
  token: issued.token, secret, issuer, origin, allowedOrigin: origin, wallet,
  requiredScope: READ_SESSION_SCOPES.CASE_MINE, nowSeconds: issued.payload.exp,
});
ok("expired token is denied", !expired.ok && expired.reason === "read_session_expired");

const renewed = await issueReadSessionToken({
  secret, issuer, audience: origin, allowedOrigin: origin, wallet, scopes,
  authSubject: null, jti: "R".repeat(32), nowSeconds: now + 1200,
  sessionStartedAt: issued.payload.sid_iat,
  absoluteExpiresAt: issued.payload.abs_exp,
});
ok("silent renewal keeps the original signed-session boundary while rotating the bearer window",
  renewed.payload.iat === now + 1200
    && renewed.payload.exp === now + 3000
    && renewed.payload.sid_iat === issued.payload.sid_iat
    && renewed.payload.abs_exp === issued.payload.abs_exp
    && renewed.payload.jti !== issued.payload.jti);
const finalWindow = await issueReadSessionToken({
  secret, issuer, audience: origin, allowedOrigin: origin, wallet, scopes,
  authSubject: null, jti: "Z".repeat(32), nowSeconds: issued.payload.abs_exp - 60,
  sessionStartedAt: issued.payload.sid_iat,
  absoluteExpiresAt: issued.payload.abs_exp,
});
ok("renewal can never extend the eight-hour absolute deadline",
  finalWindow.payload.exp === issued.payload.abs_exp);

await (async () => {
  let rejected = false;
  try {
    await issueReadSessionToken({
      secret, issuer, audience: origin, allowedOrigin: origin, wallet,
      scopes: ["case:write"], jti: "B".repeat(32), nowSeconds: now,
    });
  } catch { rejected = true; }
  ok("issuer rejects every non-read scope", rejected);
})();

const caseRead = readFileSync(new URL("../supabase/functions/osi-v2-case-read/index.ts", import.meta.url), "utf8");
const reportRead = readFileSync(new URL("../supabase/functions/osi-v2-report-read/index.ts", import.meta.url), "utf8");
const analyst = readFileSync(new URL("../supabase/functions/osi-v2-analyst/index.ts", import.meta.url), "utf8");
const wire = readFileSync(new URL("../supabase/functions/osi-v2-wire/index.ts", import.meta.url), "utf8");
const aiPack = readFileSync(new URL("../supabase/functions/osi-v2-ai-pack/index.ts", import.meta.url), "utf8");
const profile = readFileSync(new URL("../supabase/functions/osi-v2-profile/index.ts", import.meta.url), "utf8");
ok("all six private-read isolates verify the same stateless token core",
  [caseRead, reportRead, analyst, wire, aiPack, profile].every((source) => source.includes("verifyReadSessionToken")));
ok("only the Case read gateway can mint a session after consuming a durable proof",
  caseRead.includes("issueReadSessionToken")
    && caseRead.includes('verifySignedRead(body, "CASE_READ_MY_CASES"')
    && caseRead.includes("READ_SESSION_SCOPES.AIPACK_DETAIL")
    && caseRead.includes("READ_SESSION_SCOPES.PROFILE_SELF")
    && !reportRead.includes("issueReadSessionToken")
    && !analyst.includes("issueReadSessionToken")
    && !wire.includes("issueReadSessionToken")
    && !aiPack.includes("issueReadSessionToken")
    && !profile.includes("issueReadSessionToken"));
ok("silent renewal requires a still-valid scoped token and cannot add authority",
  caseRead.includes("renewReadSession")
    && caseRead.includes("verifyReadSessionToken")
    && caseRead.includes("verified.scopes.filter")
    && caseRead.includes("can never add a scope"));
ok("maintainer private reads still re-check wallet and Supabase identity",
  caseRead.includes("authValid") && caseRead.includes("walletValid")
    && reportRead.includes("walletGate && authGate")
    && analyst.includes("fullMaintainer(req, verified.wallet)")
    && aiPack.includes("fullMaintainer(req, proof.wallet)")
    && aiPack.includes("p_maintainer_auth_uuid: maintainer.ok ? maintainer.auth_id : null"));

console.log(`\n${passed} shared read-session security checks passed.`);
