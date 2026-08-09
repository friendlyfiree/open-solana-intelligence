// Shared, stateless authorization for short-lived READ-ONLY wallet sessions.
// The token is an HMAC-authenticated capability. It never authorizes a write,
// creates a receipt, or replaces a Stage-5 nonce, signature, or Memo proof.

export const READ_SESSION_VERSION = 1;
// A signed session may roll forward for up to one working day, but only in
// bounded 30-minute bearer-token windows. Renewal never extends abs_exp.
export const READ_SESSION_IDLE_TTL_SECONDS = 30 * 60;
export const READ_SESSION_ABSOLUTE_TTL_SECONDS = 8 * 60 * 60;
export const READ_SESSION_TTL_SECONDS = READ_SESSION_IDLE_TTL_SECONDS;
export const READ_SESSION_CLOCK_SKEW_SECONDS = 15;

export const READ_SESSION_SCOPES = Object.freeze({
  CASE_MINE: "case:mine",
  CASE_DETAIL: "case:detail",
  CASE_REVIEW: "case:review",
  CASE_MAINTAINER: "case:maintainer",
  REPORT_MINE: "report:mine",
  REPORT_REVIEW: "report:review",
  WIRE_MINE: "wire:mine",
  WIRE_QUEUE: "wire:queue",
  AIPACK_DETAIL: "aipack:detail",
  PROFILE_SELF: "profile:self",
  ANALYST_WORKSPACE: "analyst:workspace",
  ANALYST_MAINTAINER: "analyst:maintainer",
});

const ALLOWED_SCOPES = new Set(Object.values(READ_SESSION_SCOPES));
const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const JTI_PATTERN = /^[A-Za-z0-9_-]{24,128}$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * @typedef {Record<string, unknown> & {
 *   v: number,
 *   iss: string,
 *   aud: string,
 *   sub: string,
 *   iat: number,
 *   exp: number,
 *   sid_iat: number,
 *   abs_exp: number,
 *   jti: string,
 *   scp: string[],
 *   auth_sub: string | null,
 * }} VerifiedReadSessionPayload
 *
 * @typedef {{
 *   ok: true,
 *   wallet: string,
 *   scopes: string[],
 *   payload: VerifiedReadSessionPayload,
 * } | {
 *   ok: false,
 *   status: number,
 *   reason: string,
 * }} ReadSessionVerificationResult
 */

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("bad_token_encoding");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (toBase64Url(bytes) !== value) throw new TypeError("bad_token_encoding");
  return bytes;
}

export function normalizeReadSessionOrigin(value) {
  try {
    const url = new URL(String(value || ""));
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return "";
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function isExactReadSessionOrigin(requestOrigin, allowedOrigin) {
  const request = normalizeReadSessionOrigin(requestOrigin);
  const allowed = normalizeReadSessionOrigin(allowedOrigin);
  return Boolean(request && allowed && request === allowed);
}

export function readSessionIssuer(supabaseUrl) {
  try {
    return new URL(supabaseUrl).origin + "/functions/v1/osi-v2-case-read";
  } catch {
    return "";
  }
}

export function isReadSessionFeatureEnabled(value) {
  return value === "true";
}

// Issuance is strict: a scope this build does not recognise is never minted.
function normalizedScopes(scopes) {
  if (!Array.isArray(scopes)) throw new TypeError("bad_scopes");
  const result = [...new Set(scopes.map((scope) => String(scope)))].sort();
  if (!result.length || result.some((scope) => !ALLOWED_SCOPES.has(scope))) {
    throw new TypeError("bad_scopes");
  }
  return result;
}

// Verification is deliberately tolerant of a scope it does not know, and that
// asymmetry is the point. This list is shared by nine independently deployed
// isolates, so a newly added scope reaches the issuer minutes to hours before
// it reaches every verifier. A verifier that rejected the whole token over one
// unfamiliar entry would refuse every lane it serves for the length of that
// window, to a wallet holding a perfectly valid session. That is not a
// hypothetical: adding `profile:self` took the Review Queue's report, analyst
// and wire lanes down exactly this way, reported as a tampered token.
//
// Nothing is loosened in the authorization decision. The required scope must
// still be one this build recognises and must still be present in the token,
// so a token carrying only unrecognised scopes is refused as wrong_scope. A
// malformed `scp` — absent, not an array, or empty — is still tampering,
// because issuance cannot produce it.
function recognizedScopes(scopes) {
  if (!Array.isArray(scopes) || !scopes.length) throw new TypeError("bad_scopes");
  return [...new Set(scopes.map((scope) => String(scope)))]
    .filter((scope) => ALLOWED_SCOPES.has(scope))
    .sort();
}

async function hmac(secret, input) {
  if (typeof secret !== "string" || secret.length < 32) throw new TypeError("bad_secret");
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret + "\u0000osi-v2-read-session-v1"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(input)));
}

function timingSafeEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

export async function issueReadSessionToken(input) {
  const issuer = String(input.issuer || "");
  const audience = normalizeReadSessionOrigin(input.audience);
  const allowedOrigin = normalizeReadSessionOrigin(input.allowedOrigin);
  const wallet = String(input.wallet || "");
  const now = Number.isSafeInteger(input.nowSeconds) ? input.nowSeconds : Math.floor(Date.now() / 1000);
  const jti = String(input.jti || "");
  if (!issuer || !audience || !allowedOrigin || audience !== allowedOrigin) throw new TypeError("wrong_origin");
  if (!WALLET_PATTERN.test(wallet)) throw new TypeError("bad_wallet");
  if (!JTI_PATTERN.test(jti)) throw new TypeError("bad_jti");
  const scopes = normalizedScopes(input.scopes);
  const sessionStartedAt = Number.isSafeInteger(input.sessionStartedAt)
    ? input.sessionStartedAt : now;
  const absoluteExpiresAt = Number.isSafeInteger(input.absoluteExpiresAt)
    ? input.absoluteExpiresAt : sessionStartedAt + READ_SESSION_ABSOLUTE_TTL_SECONDS;
  if (sessionStartedAt > now + READ_SESSION_CLOCK_SKEW_SECONDS
      || absoluteExpiresAt <= now
      || absoluteExpiresAt - sessionStartedAt > READ_SESSION_ABSOLUTE_TTL_SECONDS) {
    throw new TypeError("bad_session_lifetime");
  }
  const authSubject = input.authSubject == null ? null : String(input.authSubject);
  if (authSubject !== null && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(authSubject)) {
    throw new TypeError("bad_auth_subject");
  }
  const payload = {
    v: READ_SESSION_VERSION,
    iss: issuer,
    aud: audience,
    sub: wallet,
    iat: now,
    exp: Math.min(now + READ_SESSION_IDLE_TTL_SECONDS, absoluteExpiresAt),
    sid_iat: sessionStartedAt,
    abs_exp: absoluteExpiresAt,
    jti,
    scp: scopes,
    auth_sub: authSubject,
  };
  const encodedPayload = toBase64Url(textEncoder.encode(JSON.stringify(payload)));
  const signingInput = "osi2r." + encodedPayload;
  const signature = toBase64Url(await hmac(input.secret, signingInput));
  return { token: signingInput + "." + signature, payload };
}

/**
 * @returns {Promise<ReadSessionVerificationResult>}
 */
export async function verifyReadSessionToken(input) {
  const token = String(input.token || "");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "osi2r") {
    return { ok: false, status: 401, reason: "read_session_required" };
  }
  let payload;
  let suppliedSignature;
  try {
    payload = JSON.parse(textDecoder.decode(fromBase64Url(parts[1])));
    suppliedSignature = fromBase64Url(parts[2]);
  } catch {
    return { ok: false, status: 403, reason: "read_session_tampered" };
  }
  const expectedSignature = await hmac(input.secret, parts[0] + "." + parts[1]);
  if (!timingSafeEqual(expectedSignature, suppliedSignature)) {
    return { ok: false, status: 403, reason: "read_session_tampered" };
  }
  const now = Number.isSafeInteger(input.nowSeconds) ? input.nowSeconds : Math.floor(Date.now() / 1000);
  const expectedOrigin = normalizeReadSessionOrigin(input.origin);
  const allowedOrigin = normalizeReadSessionOrigin(input.allowedOrigin);
  const expectedWallet = String(input.wallet || "");
  const requiredScope = String(input.requiredScope || "");
  if (!payload || payload.v !== READ_SESSION_VERSION || payload.iss !== input.issuer) {
    return { ok: false, status: 403, reason: "read_session_tampered" };
  }
  if (!expectedOrigin || !allowedOrigin || expectedOrigin !== allowedOrigin || payload.aud !== expectedOrigin) {
    return { ok: false, status: 403, reason: "read_session_wrong_origin" };
  }
  if (!WALLET_PATTERN.test(expectedWallet) || payload.sub !== expectedWallet) {
    return { ok: false, status: 403, reason: "read_session_wrong_wallet" };
  }
  const sessionStartedAt = Number.isSafeInteger(payload.sid_iat) ? payload.sid_iat : payload.iat;
  const absoluteExpiresAt = Number.isSafeInteger(payload.abs_exp)
    ? payload.abs_exp : sessionStartedAt + READ_SESSION_ABSOLUTE_TTL_SECONDS;
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
      || !Number.isSafeInteger(sessionStartedAt) || !Number.isSafeInteger(absoluteExpiresAt)
      || sessionStartedAt > payload.iat
      || absoluteExpiresAt <= sessionStartedAt
      || absoluteExpiresAt - sessionStartedAt > READ_SESSION_ABSOLUTE_TTL_SECONDS
      || payload.exp <= payload.iat
      || payload.exp - payload.iat > READ_SESSION_IDLE_TTL_SECONDS
      || payload.exp > absoluteExpiresAt
      || payload.iat > now + READ_SESSION_CLOCK_SKEW_SECONDS) {
    return { ok: false, status: 403, reason: "read_session_tampered" };
  }
  if (payload.exp <= now || absoluteExpiresAt <= now) {
    return { ok: false, status: 401, reason: "read_session_expired" };
  }
  if (!JTI_PATTERN.test(String(payload.jti || ""))) {
    return { ok: false, status: 403, reason: "read_session_tampered" };
  }
  let scopes;
  try { scopes = recognizedScopes(payload.scp); }
  catch { return { ok: false, status: 403, reason: "read_session_tampered" }; }
  if (!ALLOWED_SCOPES.has(requiredScope) || !scopes.includes(requiredScope)) {
    return { ok: false, status: 403, reason: "read_session_wrong_scope" };
  }
  if (payload.auth_sub !== null
      && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(payload.auth_sub || ""))) {
    return { ok: false, status: 403, reason: "read_session_tampered" };
  }
  return { ok: true, wallet: expectedWallet, scopes, payload: {
    ...payload,
    sid_iat: sessionStartedAt,
    abs_exp: absoluteExpiresAt,
  } };
}
