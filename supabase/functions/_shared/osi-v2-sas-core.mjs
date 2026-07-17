// OSI V2 — SAS (Solana Attestation Service) verification core.
//
// Pure, dependency-free decision logic for the OSI_VERIFIED_ANALYST credential.
// The on-chain fetch (PDA derivation + getAccountInfo) lives in the Edge glue;
// everything that decides a wallet's canonical credential state lives here so it
// can be unit-tested without a network, a wallet, or the SAS SDK.
//
// Canonical field order and types come from the sas-lib Attestation account
// type (discriminator, nonce, credential, schema, data, signer, expiry,
// tokenAccount). SAS on chain is always the authoritative source; any recorded
// state is a cache/index only.

export const SAS_PROGRAM_ID = "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG";

// Fixed SAS PDA seed prefixes (sas-lib utils: ATTESTATION_SEED / CREDENTIAL_SEED
// / SCHEMA_SEED). The attestation account for a subject is derived from
// [ "attestation", credential, schema, nonce ], where OSI uses the subject
// wallet itself as the nonce so the account is deterministically re-derivable.
export const ATTESTATION_SEED = "attestation";

// Number of leading discriminator bytes in the Attestation account. sas-lib types
// the discriminator as a single numeric (u8) field. Isolated as a constant so a
// single manual on-chain confirmation can adjust it if ever needed.
export const ATTESTATION_DISCRIMINATOR_BYTES = 1;

// Canonical verification states shared with the shadow/enforcement schema.
export const SAS_STATE = Object.freeze({
  UNCHECKED: "unchecked",
  PENDING: "pending_verification",
  VERIFIED: "verified",
  INVALID: "invalid",
  REVOKED: "revoked",
  EXPIRED: "expired",
});

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_MAP = (() => {
  const map = new Map();
  for (let i = 0; i < BASE58_ALPHABET.length; i += 1) map.set(BASE58_ALPHABET[i], i);
  return map;
})();

export function isPubkey(value) {
  return typeof value === "string" && BASE58_RE.test(value);
}

export function validateWallet(wallet) {
  if (!isPubkey(wallet)) throw new TypeError("invalid wallet address");
  return wallet;
}

// Decode a base58 string into raw bytes (used to compare account address slices
// and to build PDA seeds). Bitcoin/Solana alphabet, no checksum.
export function base58Decode(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("base58Decode: empty input");
  }
  const bytes = [];
  for (const ch of value) {
    const digit = BASE58_MAP.get(ch);
    if (digit === undefined) throw new TypeError("base58Decode: bad character");
    let carry = digit;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry = Math.floor(carry / 256);
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry = Math.floor(carry / 256);
    }
  }
  for (let k = 0; k < value.length && value[k] === "1"; k += 1) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

// Build the ordered PDA seeds for a subject wallet's OSI attestation account.
// Returns an array of Uint8Array seeds for findProgramAddress in the Edge glue.
export function buildAttestationSeeds({ credential, schema, wallet }) {
  const credentialBytes = base58Decode(validatePubkeyArg(credential, "credential"));
  const schemaBytes = base58Decode(validatePubkeyArg(schema, "schema"));
  const walletBytes = base58Decode(validateWallet(wallet));
  return [utf8Bytes(ATTESTATION_SEED), credentialBytes, schemaBytes, walletBytes];
}

function validatePubkeyArg(value, label) {
  if (!isPubkey(value)) throw new TypeError(`invalid ${label} pubkey`);
  return value;
}

function readU32LE(bytes, offset) {
  if (offset + 4 > bytes.length) throw new RangeError("truncated u32");
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function readI64LE(bytes, offset) {
  if (offset + 8 > bytes.length) throw new RangeError("truncated i64");
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[offset + i]);
  // two's complement for signed 64-bit
  if (value >= 1n << 63n) value -= 1n << 64n;
  return value;
}

// Decode the raw Attestation account bytes into the fields OSI verification needs.
// Layout: [discriminator][nonce 32][credential 32][schema 32][data u32-len+bytes]
//         [signer 32][expiry i64][tokenAccount 32].
export function decodeAttestationAccount(data) {
  const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data || []);
  let offset = ATTESTATION_DISCRIMINATOR_BYTES;
  const take = (n) => {
    if (offset + n > bytes.length) throw new RangeError("truncated attestation account");
    const slice = bytes.slice(offset, offset + n);
    offset += n;
    return slice;
  };
  const nonce = take(32);
  const credential = take(32);
  const schema = take(32);
  const dataLen = readU32LE(bytes, offset);
  offset += 4;
  offset += dataLen;
  const signer = take(32);
  const expiry = readI64LE(bytes, offset);
  offset += 8;
  const tokenAccount = take(32);
  return { nonce, credential, schema, dataLen, signer, expiry, tokenAccount };
}

// Decide the canonical status of a fetched attestation account. `account` is the
// normalized Edge fetch result: { found, ownerProgram, data (Uint8Array) }.
// `expected` is { programId, credential, schema, issuer }. `nowSeconds` is unix.
export function evaluateAttestation(account, expected, nowSeconds) {
  const exp = expected || {};
  if (!isPubkey(exp.credential) || !isPubkey(exp.schema) || !isPubkey(exp.issuer)) {
    return { state: SAS_STATE.INVALID, valid: false, reason: "not_configured", expiry: null };
  }
  if (!account || account.found !== true) {
    return { state: SAS_STATE.INVALID, valid: false, reason: "absent", expiry: null };
  }
  const programId = exp.programId || SAS_PROGRAM_ID;
  if (account.ownerProgram && account.ownerProgram !== programId) {
    return { state: SAS_STATE.INVALID, valid: false, reason: "wrong_program", expiry: null };
  }
  let decoded;
  try {
    decoded = decodeAttestationAccount(account.data);
  } catch {
    return { state: SAS_STATE.INVALID, valid: false, reason: "decode_error", expiry: null };
  }
  if (!bytesEqual(decoded.credential, base58Decode(exp.credential))) {
    return { state: SAS_STATE.INVALID, valid: false, reason: "credential_mismatch", expiry: null };
  }
  if (!bytesEqual(decoded.schema, base58Decode(exp.schema))) {
    return { state: SAS_STATE.INVALID, valid: false, reason: "schema_mismatch", expiry: null };
  }
  if (!bytesEqual(decoded.signer, base58Decode(exp.issuer))) {
    return { state: SAS_STATE.INVALID, valid: false, reason: "issuer_mismatch", expiry: null };
  }
  const expiry = Number(decoded.expiry);
  if (expiry > 0 && Number.isFinite(nowSeconds) && expiry <= nowSeconds) {
    return { state: SAS_STATE.EXPIRED, valid: false, reason: "expired", expiry };
  }
  return { state: SAS_STATE.VERIFIED, valid: true, reason: "valid", expiry: expiry > 0 ? expiry : null };
}

// Map a live evaluation (or an RPC failure) to the state recorded for a review
// snapshot / wallet cache. An RPC/timeout failure is fail-open for the review
// (still recorded) but fail-closed for counting: pending_verification.
export function shadowStateFor({ status, rpcFailed }) {
  if (rpcFailed) return SAS_STATE.PENDING;
  return status && status.state ? status.state : SAS_STATE.PENDING;
}

// Public verifier response DTO. `source` is "live" or "cache". No secrets/PII.
export function publicVerifierResponse({ wallet, status, expected, source, checkedAt }) {
  const exp = expected || {};
  return {
    ok: true,
    wallet,
    valid: status.valid === true,
    state: status.state,
    reason: status.reason,
    expiry: status.expiry ?? null,
    credential: exp.credential ?? null,
    schema: exp.schema ?? null,
    issuer: exp.issuer ?? null,
    program_id: exp.programId ?? SAS_PROGRAM_ID,
    source: source || "live",
    checked_at: checkedAt ?? null,
    notice:
      "SAS on chain is authoritative. OSI review authority is derived from a live " +
      "OSI_VERIFIED_ANALYST attestation under OSI's exact credential, schema, and issuer.",
  };
}

// Analyst tiers that must hold a live OSI_VERIFIED_ANALYST credential.
export const ANALYST_TIERS = new Set([
  "probationary_analyst",
  "verified_analyst",
  "senior_analyst",
]);

// Compact integer tier/status codes written into the attestation data. No PII,
// no free text: only the review-authority tier. 0 none, 1 probationary,
// 2 verified, 3 senior.
export function tierStatusCode(status) {
  switch (status) {
    case "probationary_analyst":
      return 1;
    case "verified_analyst":
      return 2;
    case "senior_analyst":
      return 3;
    default:
      return 0;
  }
}

// Decide the on-chain credential action for a server-derived tier transition.
// Purely additive: issuance never changes an existing counted outcome, so it is
// safe once Step 0 pubkeys exist; absent config is a logged no-op (never throws).
export function reconcileIssuance({ settings, status }) {
  if (!settings || settings.issuanceEnabled !== true || settings.configured !== true) {
    return {
      action: "noop_unconfigured",
      reason: settings && settings.configured ? "issuance_disabled" : "not_configured",
    };
  }
  if (ANALYST_TIERS.has(status)) {
    const code = tierStatusCode(status);
    return { action: "issue", tierCode: code, statusCode: code, reason: "analyst_tier" };
  }
  return { action: "revoke", tierCode: 0, statusCode: 0, reason: "not_analyst_tier" };
}

// Map a governance action name / review path to the snapshot review_kind.
export function reviewKindForGovernanceAction(action) {
  if (action === "resolution_review") return "resolution";
  if (action === "challenge_review") return "challenge";
  return null;
}

// A response for when the feature is not yet configured (Step 0 not run).
export function notConfiguredResponse(wallet) {
  return {
    ok: true,
    wallet: wallet ?? null,
    valid: false,
    state: SAS_STATE.INVALID,
    reason: "not_configured",
    expiry: null,
    credential: null,
    schema: null,
    issuer: null,
    program_id: SAS_PROGRAM_ID,
    source: "config",
    checked_at: null,
    notice: "OSI has not yet published its SAS credential and schema.",
  };
}
