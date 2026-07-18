// Dependency-free validation for Resolution, Challenge and Case seal writes.
// The database creates the canonical proof text; this module validates that
// exact binding before the Edge gateway verifies Ed25519 or a mainnet Memo.

const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CASE_REF = /^OSI-[0-9A-F]{12}$/;
const RESOLUTION_REF = /^OSI-RES-[0-9A-F]{16}$/;
const CHALLENGE_REF = /^OSI-CHL-[0-9A-F]{16}$/;
const VERSION_REF = /^OSI-RV-[0-9A-F]{16}$/;
const WIRE_VERSION_REF = /^OSI-WV-[0-9A-F]{16}$/;
const TARGET_ID = /^[0-9a-f-]{36}$/i;
const IDEMPOTENCY = /^[A-Za-z0-9._:-]{16,128}$/;

export const GOVERNANCE_ACTIONS = new Set([
  "resolution_review", "resolution_finalize", "challenge_submit",
  "challenge_admit", "challenge_review", "challenge_withdraw",
  "challenge_finalize", "seal_finalize",
]);

export const GOVERNANCE_MEMO_EVENTS = new Set([
  "REPORT_SELECTED_WINNING", "CHALLENGE_ACCEPTED",
  "CHALLENGE_REJECTED", "RECORD_SEALED", "WIRE_PROMOTED",
]);

const SIGNED_EVENTS = new Set([
  "RESOLUTION_REVIEW_CAST", "RESOLUTION_REVIEW_REVISED",
  "CHALLENGE_SUBMITTED", "CHALLENGE_ADMISSIBILITY_ACCEPTED",
  "CHALLENGE_ADMISSIBILITY_REJECTED", "CHALLENGE_REVIEW_CAST",
  "CHALLENGE_REVIEW_REVISED", "CHALLENGE_WITHDRAWN",
]);

function text(value, field, minimum, maximum, pattern = null) {
  if (typeof value !== "string") throw new TypeError(field + " is required");
  const clean = value.trim();
  if (clean.length < minimum || clean.length > maximum || (pattern && !pattern.test(clean))) {
    throw new TypeError(field + " is invalid");
  }
  return clean;
}

function optionalText(value, field, maximum) {
  if (value == null || value === "") return null;
  return text(value, field, 1, maximum);
}

export function validateGovernanceTargetRef(action, value) {
  const ref = text(value, "target_ref", 10, 64);
  if (action === "resolution_finalize") {
    // Normally the resolution ref. The D17 bootstrap cold start may name the
    // Case ref instead, because with no eligible analysts no selection review
    // could have created the resolution parent yet.
    if (!RESOLUTION_REF.test(ref) && !CASE_REF.test(ref)) {
      throw new TypeError("target_ref is invalid");
    }
    return ref;
  }
  const expected = action === "resolution_review"
    ? CASE_REF
    : action.startsWith("challenge_") && action !== "challenge_submit"
      ? CHALLENGE_REF
      : RESOLUTION_REF;
  if (!expected.test(ref)) throw new TypeError("target_ref is invalid");
  return ref;
}

export function validateGovernanceIdempotencyKey(value) {
  return text(value, "idempotency_key", 16, 128, IDEMPOTENCY);
}

export function normalizeGovernancePayload(action, input) {
  if (!GOVERNANCE_ACTIONS.has(action) || !input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("governance payload is invalid");
  }
  if (action === "resolution_review") {
    const phase = text(input.phase, "phase", 4, 16);
    const decision = text(input.decision, "decision", 6, 16);
    if (!new Set(["selection", "seal"]).has(phase)
        || !new Set(["select", "object", "abstain"]).has(decision)
        || (phase === "seal" && decision === "object")) {
      throw new TypeError("resolution review phase or decision is invalid");
    }
    return {
      phase,
      report_version_ref: text(input.report_version_ref, "report_version_ref", 23, 23, VERSION_REF),
      decision,
      reason_code: text(input.reason_code, "reason_code", 1, 96, /^[a-z][a-z0-9_:-]{0,95}$/),
      public_rationale: text(input.public_rationale, "public_rationale", 10, 2000),
      private_note: optionalText(input.private_note, "private_note", 4000),
    };
  }
  if (action === "challenge_submit") {
    return {
      reason_code: text(input.reason_code, "reason_code", 1, 96, /^[a-z][a-z0-9_:-]{0,95}$/),
      public_safe_summary: text(input.public_safe_summary, "public_safe_summary", 20, 2000),
      restricted_detail: optionalText(input.restricted_detail, "restricted_detail", 8000),
      evidence_item_id: text(input.evidence_item_id, "evidence_item_id", 36, 36, UUID),
    };
  }
  if (action === "challenge_admit") {
    const decision = text(input.decision, "decision", 6, 6);
    const route = text(input.route, "route", 7, 10);
    if (!new Set(["accept", "reject"]).has(decision)
        || !new Set(["analyst", "maintainer"]).has(route)) {
      throw new TypeError("challenge admissibility payload is invalid");
    }
    return { decision, route };
  }
  if (action === "challenge_review") {
    const decision = text(input.decision, "decision", 6, 6);
    if (!new Set(["accept", "reject"]).has(decision)) {
      throw new TypeError("challenge decision is invalid");
    }
    return {
      decision,
      reason_code: text(input.reason_code, "reason_code", 1, 96, /^[a-z][a-z0-9_:-]{0,95}$/),
      public_rationale: text(input.public_rationale, "public_rationale", 10, 2000),
      private_note: optionalText(input.private_note, "private_note", 4000),
    };
  }
  if (action === "resolution_finalize") {
    // Normal finalize carries an empty payload and is unchanged. Only the
    // explicit D17 bootstrap request names one exact published version; the
    // database decides whether that channel may be used at all.
    if (input.report_version_ref == null || input.report_version_ref === "") return {};
    return {
      report_version_ref: text(input.report_version_ref, "report_version_ref", 23, 23, VERSION_REF),
    };
  }
  return {};
}

export function parseGovernanceProofText(value) {
  if (typeof value !== "string" || value.length < 150 || value.length > 512) return null;
  const parts = value.split("|");
  if (parts.length !== 10 || parts[0] !== "OSI2") return null;
  const take = (part, prefix) => part.startsWith(prefix + "=") ? part.slice(prefix.length + 1) : null;
  const parsed = {
    purpose: parts[1], target_type: take(parts[2], "t"), target_id: take(parts[3], "id"),
    target_public_ref: take(parts[4], "ref"), actor_wallet: take(parts[5], "a"),
    payload_hash: take(parts[6], "h"), nonce: take(parts[7], "n"),
    issued_at_ms: Number(take(parts[8], "ts")), expires_at_ms: Number(take(parts[9], "exp")),
  };
  if (!new Set(["resolution", "challenge", "wire_version"]).has(parsed.target_type)
      || !TARGET_ID.test(parsed.target_id ?? "")
      || !(RESOLUTION_REF.test(parsed.target_public_ref ?? "")
        || CHALLENGE_REF.test(parsed.target_public_ref ?? "")
        || /^OSI-[RC]RV-[0-9A-F]{16}$/.test(parsed.target_public_ref ?? "")
        || WIRE_VERSION_REF.test(parsed.target_public_ref ?? ""))
      || !WALLET.test(parsed.actor_wallet ?? "") || !HASH.test(parsed.payload_hash ?? "")
      || !NONCE.test(parsed.nonce ?? "")
      || !Number.isSafeInteger(parsed.issued_at_ms) || !Number.isSafeInteger(parsed.expires_at_ms)
      || parsed.expires_at_ms <= parsed.issued_at_ms
      || parsed.expires_at_ms - parsed.issued_at_ms > 300_000
      || (!GOVERNANCE_MEMO_EVENTS.has(parsed.purpose) && !SIGNED_EVENTS.has(parsed.purpose))) return null;
  return parsed;
}

export function validateGovernanceProofText(value, expected, nowMs) {
  const parsed = parseGovernanceProofText(value);
  if (!parsed) return { ok: false, reason: "bad_proof_text" };
  const fields = [
    "purpose", "target_type", "target_id", "target_public_ref",
    "actor_wallet", "payload_hash", "nonce",
  ];
  for (const field of fields) {
    if (parsed[field] !== expected[field]) return { ok: false, reason: "wrong_" + field };
  }
  if (nowMs > parsed.expires_at_ms) return { ok: false, reason: "expired" };
  if (parsed.issued_at_ms > nowMs + 30_000) return { ok: false, reason: "not_yet_valid" };
  return { ok: true, parsed };
}

export function governanceProofLabel(eventType) {
  return GOVERNANCE_MEMO_EVENTS.has(eventType)
    ? "Memo-anchored on Solana"
    : "Wallet-signed & server-verified";
}
