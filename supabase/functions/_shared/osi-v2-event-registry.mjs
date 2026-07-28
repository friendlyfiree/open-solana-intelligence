// Executable OSI2 event and envelope contract.
//
// Historical Solana messages are immutable. The profile registry therefore
// models every shipped byte shape explicitly instead of pretending they were
// always identical. New JS emitters use this one canonical assembler; readers
// keep the named historical parsers permanently.

const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const EVENT = /^[A-Z][A-Z0-9_]{1,95}$/;
const TARGET_REF = /^[A-Za-z0-9._:-]{1,256}$/;
const DECISION = /^[a-z][a-z0-9_]{0,63}$/;

export const OSI2_EVENT_REGISTRY_VERSION = "2026-07-28.1";

export const OSI2_EVENT_CLASSES = Object.freeze({
  wallet_signed_server_verified: Object.freeze([
    "CASE_INITIAL_REVIEW_CAST", "CASE_INITIAL_REVIEW_REVISED", "CASE_WITHDRAWN",
    "CASE_APPEAL_SUBMITTED", "CASE_REPORT_REVIEW_CAST", "CASE_REPORT_REVIEW_REVISED",
    "WIRE_REPORT_REVIEW_CAST", "WIRE_REPORT_REVIEW_REVISED", "RESOLUTION_REVIEW_CAST",
    "RESOLUTION_REVIEW_REVISED", "CHALLENGE_SUBMITTED",
    "CHALLENGE_ADMISSIBILITY_ACCEPTED", "CHALLENGE_ADMISSIBILITY_REJECTED",
    "CHALLENGE_REVIEW_CAST", "CHALLENGE_REVIEW_REVISED", "CHALLENGE_WITHDRAWN",
    "CHALLENGE_BAD_FAITH_REVIEW_CAST", "CHALLENGE_BAD_FAITH_REVIEW_REVISED",
    "AI_PACK_REVIEW_CAST", "AI_PACK_REVIEW_REVISED",
    "AI_PACK_OWNER_FEEDBACK_SUBMITTED", "ANALYST_APPLICATION_VERSION_SUBMITTED",
    "ANALYST_APPLICATION_REVIEW_CAST", "ANALYST_APPLICATION_REVIEW_REVISED",
    "OWNER_STATUS_PROOF", "REWARD_PLEDGE_CREATED", "REWARD_PLEDGE_REVISED",
    "REWARD_PLEDGE_WITHDRAWN",
  ]),
  solana_memo: Object.freeze([
    "CASE_SUBMITTED", "CASE_OPENED", "CASE_SAFETY_BLOCKED", "CASE_SAFETY_LIFTED",
    "CASE_INITIAL_REVIEW_REJECTED", "CASE_RESUMED", "CASE_REPORT_VERSION_SUBMITTED",
    "REPORT_PUBLISHED", "REPORT_REJECTED", "WIRE_REPORT_VERSION_SUBMITTED",
    "WIRE_REPORT_PUBLISHED", "WIRE_PROMOTED", "RESOLUTION_PROPOSED",
    "REPORT_SELECTED_WINNING", "CHALLENGE_ACCEPTED", "CHALLENGE_REJECTED",
    "CHALLENGE_BAD_FAITH_CONFIRMED", "CHALLENGE_BAD_FAITH_DISMISSED",
    "CASE_RESOLVED", "CASE_REOPENED", "RECORD_SEALED", "CASE_HALTED",
    "ANALYST_PROBATION", "ANALYST_SENIOR", "ANALYST_VERIFIED", "ANALYST_REVOKED",
    "AI_PACK_APPROVED", "AI_PACK_REJECTED", "REWARD_PLEDGED", "REWARD_PAID",
    "SUPPORT_SENT", "REWARD_PAYMENT_CONFIRMED", "SUPPORT_PAYMENT_CONFIRMED",
    "CONFIG_CHANGED",
  ]),
  system_event: Object.freeze([
    "CASE_QUORUM_READY", "CHALLENGE_EXPIRED", "PACK_SUBMITTED", "PACK_ATTACHED",
    "PACK_SUPERSEDED", "PACK_STALE", "REWARD_ASSIGNED", "ANALYST_CANDIDATE",
  ]),
});

export const OSI2_TARGET_TYPES = Object.freeze([
  "case", "report_version", "wire_version", "resolution", "challenge",
  "pack_version", "pack_owner_feedback", "analyst", "application_version",
  "reward", "support", "config",
]);

export const OSI2_ACTOR_ROLES = Object.freeze([
  "owner", "analyst", "senior", "maintainer", "service", "wallet",
]);

export const OSI2_ENVELOPE_PROFILES = Object.freeze({
  v1_expiring: Object.freeze({
    version: "1",
    fields: Object.freeze(["t", "id", "a", "r", "d", "n", "h", "ts", "exp"]),
  }),
  v1_issued: Object.freeze({
    version: "1",
    fields: Object.freeze(["t", "id", "a", "r", "d", "n", "h", "ts"]),
  }),
  v2_expiring_minimal: Object.freeze({
    version: "2",
    fields: Object.freeze(["t", "id", "a", "n", "h", "ts", "exp"]),
  }),
});

const eventClass = new Map();
for (const [proofType, events] of Object.entries(OSI2_EVENT_CLASSES)) {
  for (const event of events) {
    if (eventClass.has(event)) throw new Error("duplicate OSI2 event registry entry");
    eventClass.set(event, proofType);
  }
}

export function osi2EventClass(eventType) {
  return eventClass.get(String(eventType || "")) ?? null;
}

function exactText(value, name, pattern, maximum) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
      || !pattern.test(value)) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function exactInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(name + " is invalid");
  }
  return number;
}

export function canonicalOsi2Envelope(binding, profileName = "v1_expiring") {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new TypeError("event binding is invalid");
  }
  const profile = OSI2_ENVELOPE_PROFILES[profileName];
  if (!profile) throw new TypeError("event envelope profile is invalid");
  const purpose = exactText(
    String(binding.purpose ?? binding.event_type ?? ""),
    "event_type",
    EVENT,
    96,
  );
  if (!eventClass.has(purpose)) throw new TypeError("event_type is not registered");
  const targetType = exactText(binding.target_type, "target_type", /^[a-z_]+$/, 32);
  if (!OSI2_TARGET_TYPES.includes(targetType)) throw new TypeError("target_type is invalid");
  const targetRef = exactText(
    String(binding.target_ref ?? binding.public_ref ?? binding.target_id ?? ""),
    "target_ref",
    TARGET_REF,
    256,
  );
  const actorWallet = exactText(binding.actor_wallet, "actor_wallet", WALLET, 44);
  const issuedAt = exactInteger(binding.issued_at, "issued_at");
  const values = {
    t: targetType,
    id: targetRef,
    a: actorWallet,
    n: exactText(binding.nonce, "nonce", NONCE, 128),
    h: exactText(binding.payload_hash, "payload_hash", HASH, 64),
    ts: String(issuedAt),
  };
  if (profile.fields.includes("r")) {
    values.r = exactText(binding.actor_role, "actor_role", /^[a-z_]+$/, 32);
    if (!OSI2_ACTOR_ROLES.includes(values.r)) throw new TypeError("actor_role is invalid");
  }
  if (profile.fields.includes("d")) {
    values.d = exactText(binding.decision, "decision", DECISION, 64);
  }
  if (profile.fields.includes("exp")) {
    const expiresAt = exactInteger(binding.expires_at, "expires_at");
    if (expiresAt <= issuedAt || expiresAt - issuedAt > 300) {
      throw new TypeError("expires_at is invalid");
    }
    values.exp = String(expiresAt);
  }
  return ["OSI2", profile.version, purpose]
    .concat(profile.fields.map((field) => field + "=" + values[field]))
    .join("|");
}

export function parseOsi2Envelope(message, profileName = "v1_expiring") {
  const profile = OSI2_ENVELOPE_PROFILES[profileName];
  if (!profile || typeof message !== "string" || message.length > 700) return null;
  const parts = message.split("|");
  if (parts.length !== profile.fields.length + 3
      || parts[0] !== "OSI2" || parts[1] !== profile.version) return null;
  const result = { purpose: parts[2], event_type: parts[2] };
  for (let index = 0; index < profile.fields.length; index++) {
    const field = profile.fields[index];
    const prefix = field + "=";
    const part = parts[index + 3];
    if (!part.startsWith(prefix)) return null;
    result[field] = part.slice(prefix.length);
  }
  const binding = {
    purpose: result.purpose,
    target_type: result.t,
    target_ref: result.id,
    actor_wallet: result.a,
    actor_role: result.r,
    decision: result.d,
    nonce: result.n,
    payload_hash: result.h,
    issued_at: Number(result.ts),
    expires_at: result.exp == null ? undefined : Number(result.exp),
  };
  try {
    if (canonicalOsi2Envelope(binding, profileName) !== message) return null;
  } catch {
    return null;
  }
  return binding;
}

// Resolution/challenge SQL shipped before a grammar-version segment and
// included both a private target UUID and a public ref. Existing receipts and
// in-flight SQL prepare/commit bindings retain this isolated compatibility
// parser; no other emitter may select the shape.
export function parseHistoricalGovernanceV0(message) {
  if (typeof message !== "string" || message.length < 100 || message.length > 512) return null;
  const parts = message.split("|");
  if (parts.length !== 10 || parts[0] !== "OSI2" || !eventClass.has(parts[1])) return null;
  const keys = ["t", "id", "ref", "a", "h", "n", "ts", "exp"];
  const parsed = { purpose: parts[1] };
  for (let index = 0; index < keys.length; index++) {
    const prefix = keys[index] + "=";
    if (!parts[index + 2].startsWith(prefix)) return null;
    parsed[keys[index]] = parts[index + 2].slice(prefix.length);
  }
  if (!OSI2_TARGET_TYPES.includes(parsed.t) || !TARGET_REF.test(parsed.id)
      || !TARGET_REF.test(parsed.ref) || !WALLET.test(parsed.a)
      || !HASH.test(parsed.h) || !NONCE.test(parsed.n)
      || !/^\d{13}$/.test(parsed.ts) || !/^\d{13}$/.test(parsed.exp)
      || Number(parsed.exp) <= Number(parsed.ts)
      || Number(parsed.exp) - Number(parsed.ts) > 300_000) return null;
  return {
    purpose: parsed.purpose,
    target_type: parsed.t,
    target_id: parsed.id,
    target_public_ref: parsed.ref,
    actor_wallet: parsed.a,
    payload_hash: parsed.h,
    nonce: parsed.n,
    issued_at_ms: Number(parsed.ts),
    expires_at_ms: Number(parsed.exp),
  };
}
