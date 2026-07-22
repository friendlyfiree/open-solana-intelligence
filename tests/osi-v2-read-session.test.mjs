import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  isExactReadSessionOrigin,
  issueReadSessionToken,
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

const issued = await issueReadSessionToken({
  secret, issuer, audience: origin, allowedOrigin: origin, wallet, scopes,
  authSubject: null, jti: "A".repeat(32), nowSeconds: now,
});
ok("exact production origin gate accepts only the configured origin",
  isExactReadSessionOrigin(origin, origin)
    && !isExactReadSessionOrigin("https://example.invalid", origin)
    && !isExactReadSessionOrigin("*", origin));
ok("read session TTL is visibly bounded to five minutes", issued.payload.exp - issued.payload.iat === READ_SESSION_TTL_SECONDS && READ_SESSION_TTL_SECONDS === 300);

const valid = await verifyReadSessionToken({
  token: issued.token, secret, issuer, origin, allowedOrigin: origin, wallet,
  requiredScope: READ_SESSION_SCOPES.CASE_MINE, nowSeconds: now + 1,
});
ok("valid exact-origin, exact-wallet, scoped token is accepted", valid.ok && valid.wallet === wallet);
const aiPackScoped = await verifyReadSessionToken({
  token: issued.token, secret, issuer, origin, allowedOrigin: origin, wallet,
  requiredScope: READ_SESSION_SCOPES.AIPACK_DETAIL, nowSeconds: now + 1,
});
ok("shared token carries the read-only AI Pack detail scope",
  READ_SESSION_SCOPES.AIPACK_DETAIL === "aipack:detail" && aiPackScoped.ok);
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

const wrongOrigin = await verifyReadSessionToken({
  token: issued.token, secret, issuer, origin: "https://preview.example", allowedOrigin: origin,
  wallet, requiredScope: READ_SESSION_SCOPES.CASE_MINE, nowSeconds: now + 1,
});
ok("wrong origin is denied", !wrongOrigin.ok && wrongOrigin.reason === "read_session_wrong_origin");

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
ok("all five private-read isolates verify the same stateless token core",
  [caseRead, reportRead, analyst, wire, aiPack].every((source) => source.includes("verifyReadSessionToken")));
ok("only the Case read gateway can mint a session after consuming a durable proof",
  caseRead.includes("issueReadSessionToken")
    && caseRead.includes('verifySignedRead(body, "CASE_READ_MY_CASES"')
    && caseRead.includes("READ_SESSION_SCOPES.AIPACK_DETAIL")
    && !reportRead.includes("issueReadSessionToken")
    && !analyst.includes("issueReadSessionToken")
    && !wire.includes("issueReadSessionToken")
    && !aiPack.includes("issueReadSessionToken"));
ok("maintainer private reads still re-check wallet and Supabase identity",
  caseRead.includes("authValid") && caseRead.includes("walletValid")
    && reportRead.includes("walletGate && authGate")
    && analyst.includes("fullMaintainer(req, verified.wallet)")
    && aiPack.includes("fullMaintainer(req, proof.wallet)")
    && aiPack.includes("p_maintainer_auth_uuid: maintainer.ok ? maintainer.auth_id : null"));

console.log(`\n${passed} shared read-session security checks passed.`);
