// Dependency-free validation, canonical Memo, and least-privilege projection
// helpers for native Wire Report intake. Secret-bearing work remains in the
// Edge gateway; this module is shared with Node regression tests.

import {
  normalizeReportEvidence,
  validateReportIdempotencyKey,
} from "./osi-v2-report-core.mjs";
import { validateWallet } from "./osi-v2-proof-core.mjs";
import { validateConfirmedMemoTransaction } from "./osi-v2-case-write-core.mjs";
import { canonicalOsi2Envelope } from "./osi-v2-event-registry.mjs";
import { containsProhibitedPersonalData } from "./osi-v2-content-safety-core.mjs";

// Long-form Wire bounds. Kept in lockstep with the widened database CHECK
// constraints and validators in
// 20260807090000_osi_v2_case_report_visibility_publication.sql. Over-length
// input is refused with an exact error; nothing is truncated.
export const WIRE_SUMMARY_MAX = 10000;
export const WIRE_BODY_MAX = 100000;
export const WIRE_LONG_TEXT_MAX = 10000;

export const WIRE_EVENT_TYPE = "WIRE_REPORT_VERSION_SUBMITTED";
export const WIRE_PUBLICATION_EVENT_TYPE = "WIRE_REPORT_PUBLISHED";
export const WIRE_REVIEW_EVENT_TYPES = new Set([
  "WIRE_REPORT_REVIEW_CAST",
  "WIRE_REPORT_REVIEW_REVISED",
]);
export const WIRE_REVIEW_DECISIONS = new Set([
  "approve", "reject", "request_revision", "abstain",
]);
export const WIRE_GOVERNANCE_ACTIONS = new Set([
  "challenge_submit", "challenge_admit", "challenge_review",
  "challenge_withdraw", "challenge_finalize", "wire_promote",
]);
export const WIRE_REVISION_REASONS = new Set([
  "author_correction",
  "new_evidence",
  "clarification",
  "review_response",
]);

const WIRE_REPORT_REF = /^OSI-WR-[0-9A-F]{12}$/;
const WIRE_VERSION_REF = /^OSI-WV-[0-9A-F]{16}$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const TX_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
const CHALLENGE_REF = /^OSI-CHL-[0-9A-F]{16}$/;
const PROHIBITED_SECRET = /\b(seed phrase|recovery phrase|mnemonic|private key|secret key|keypair bytes?|access token|api key)\b/i;
const ILLEGAL_ACCESS = /\b(stolen credentials?|credential dump|malware payload|exploit kit|unauthorized access)\b/i;
const DOXXING = /\b(doxx(?:ing|ed)?|home address|private phone number|private messages?)\b/i;

function cleanText(value) {
  return typeof value === "string" ? value.trim().replace(/\r\n?/g, "\n") : "";
}

function requireLength(value, name, min, max) {
  const text = cleanText(value);
  if (text.length < min || text.length > max) throw new TypeError(name + " is invalid");
  return text;
}

function rejectUnsafeContent(value) {
  if (PROHIBITED_SECRET.test(value)) throw new TypeError("prohibited_secret_material");
  if (ILLEGAL_ACCESS.test(value)) throw new TypeError("prohibited_illegal_access_material");
  if (DOXXING.test(value)) throw new TypeError("prohibited_personal_data");
  if (containsProhibitedPersonalData(value)) {
    throw new TypeError("prohibited_personal_data");
  }
}

export async function normalizeWirePayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("wire payload is invalid");
  }
  const title_public_safe = requireLength(input.title_public_safe, "Wire title", 3, 160);
  const content_public_safe = requireLength(input.content_public_safe, "Wire summary", 10, WIRE_SUMMARY_MAX);
  const body_private = requireLength(input.body_private, "Wire analysis", 20, 100000);
  const uncertainties_private = cleanText(input.uncertainties_private);
  if (uncertainties_private.length > WIRE_LONG_TEXT_MAX) {
    throw new TypeError("Wire uncertainties is invalid");
  }
  const revisionReason = cleanText(input.revision_reason_code);
  if (revisionReason && !WIRE_REVISION_REASONS.has(revisionReason)) {
    throw new TypeError("revision reason is invalid");
  }
  rejectUnsafeContent([
    title_public_safe,
    content_public_safe,
    body_private,
    uncertainties_private,
  ].join("\n"));
  return {
    title_public_safe,
    content_public_safe,
    body_private,
    uncertainties_private,
    revision_reason_code: revisionReason || null,
    evidence: await normalizeReportEvidence(input.evidence ?? [], { allowEmpty: true }),
  };
}

export function validateWireReportRef(value, optional = false) {
  const ref = cleanText(value);
  if (!ref && optional) return null;
  if (!WIRE_REPORT_REF.test(ref)) throw new TypeError("Wire Report reference is invalid");
  return ref;
}

export function validateWireIdempotencyKey(value) {
  return validateReportIdempotencyKey(value);
}

export function validateWireVersionRef(value) {
  const ref = cleanText(value);
  if (!WIRE_VERSION_REF.test(ref)) throw new TypeError("Wire version reference is invalid");
  return ref;
}

export function normalizeWireReview(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Wire review payload is invalid");
  }
  const version_public_ref = validateWireVersionRef(input.version_public_ref);
  const decision = cleanText(input.decision);
  const reason_code = cleanText(input.reason_code);
  const public_rationale = cleanText(input.public_rationale);
  const privateNote = cleanText(input.private_note);
  if (!WIRE_REVIEW_DECISIONS.has(decision)) throw new TypeError("Wire review decision is invalid");
  if (!/^[a-z][a-z0-9_:-]{0,95}$/.test(reason_code)) {
    throw new TypeError("Wire review reason is invalid");
  }
  if (public_rationale.length < 10 || public_rationale.length > WIRE_LONG_TEXT_MAX) {
    throw new TypeError("Wire public-safe rationale is invalid");
  }
  if (privateNote.length > WIRE_LONG_TEXT_MAX) throw new TypeError("Wire private analyst note is invalid");
  rejectUnsafeContent(public_rationale + "\n" + privateNote);
  return {
    version_public_ref, decision, reason_code, public_rationale,
    private_note: privateNote || null,
  };
}

export function canonicalWireGovernanceMessage(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new TypeError("Wire governance binding is invalid");
  }
  const purpose = cleanText(binding.purpose);
  const publicRef = validateWireVersionRef(binding.version_public_ref);
  const role = cleanText(binding.actor_role);
  const decision = cleanText(binding.decision);
  const nonce = cleanText(binding.nonce);
  const hash = cleanText(binding.payload_hash);
  const issuedAt = Number(binding.issued_at);
  const expiresAt = Number(binding.expires_at);
  validateWallet(binding.actor_wallet);
  const review = WIRE_REVIEW_EVENT_TYPES.has(purpose);
  if ((!review && purpose !== WIRE_PUBLICATION_EVENT_TYPE)
      || !(new Set(["analyst", "senior"]).has(role)
        || (!review && role === "maintainer"))
      || (review && !WIRE_REVIEW_DECISIONS.has(decision))
      || (!review && decision !== "publish")
      || !NONCE.test(nonce) || !HASH.test(hash)
      || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
      || expiresAt <= issuedAt || expiresAt - issuedAt > 300) {
    throw new TypeError("Wire governance binding is invalid");
  }
  return canonicalOsi2Envelope({
    purpose, target_type: "wire_version", target_ref: publicRef,
    actor_wallet: binding.actor_wallet, actor_role: role, decision,
    nonce, payload_hash: hash, issued_at: issuedAt, expires_at: expiresAt,
  });
}

export function parseWireGovernanceMessage(message) {
  if (typeof message !== "string" || message.length < 140 || message.length > 512) return null;
  const parts = message.split("|");
  if (parts.length !== 12 || parts[0] !== "OSI2" || parts[1] !== "1") return null;
  const take = (part, key) => part.startsWith(key + "=") ? part.slice(key.length + 1) : null;
  const value = {
    purpose: parts[2], target_type: take(parts[3], "t"),
    version_public_ref: take(parts[4], "id"), actor_wallet: take(parts[5], "a"),
    actor_role: take(parts[6], "r"), decision: take(parts[7], "d"),
    nonce: take(parts[8], "n"), payload_hash: take(parts[9], "h"),
    issued_at: Number(take(parts[10], "ts")),
    expires_at: Number(take(parts[11], "exp")),
  };
  if (value.target_type !== "wire_version") return null;
  try { if (canonicalWireGovernanceMessage(value) !== message) return null; }
  catch { return null; }
  return value;
}

export function validateWireGovernanceBinding(message, expected, nowSeconds) {
  const parsed = parseWireGovernanceMessage(message);
  if (!parsed) return { ok: false, reason: "bad_message" };
  for (const field of [
    "purpose", "version_public_ref", "actor_wallet", "actor_role", "decision",
    "nonce", "payload_hash", "issued_at", "expires_at",
  ]) {
    if (parsed[field] !== expected[field]) return { ok: false, reason: "wrong_" + field };
  }
  if (nowSeconds > parsed.expires_at) return { ok: false, reason: "expired" };
  if (parsed.issued_at > nowSeconds + 30) return { ok: false, reason: "not_yet_valid" };
  return { ok: true, parsed };
}

function optionalText(value, name, maximum) {
  const result = cleanText(value);
  if (result.length > maximum) throw new TypeError(name + " is invalid");
  return result || null;
}

export function validateWireGovernanceTargetRef(action, value) {
  const ref = cleanText(value);
  const expected = action === "challenge_submit" || action === "wire_promote"
    ? WIRE_VERSION_REF : CHALLENGE_REF;
  if (!expected.test(ref)) throw new TypeError("Wire governance target is invalid");
  return ref;
}

export function normalizeWireGovernancePayload(action, input) {
  if (!WIRE_GOVERNANCE_ACTIONS.has(action)
      || !input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Wire governance payload is invalid");
  }
  if (action === "challenge_submit") {
    const reason_code = cleanText(input.reason_code);
    const public_safe_summary = cleanText(input.public_safe_summary);
    const evidence_ordinal = Number(input.evidence_ordinal);
    const evidence_sha256 = cleanText(input.evidence_sha256);
    const restricted_detail = optionalText(input.restricted_detail, "restricted_detail", WIRE_LONG_TEXT_MAX);
    if (!/^[a-z][a-z0-9_:-]{0,95}$/.test(reason_code)
        || public_safe_summary.length < 20 || public_safe_summary.length > WIRE_LONG_TEXT_MAX
        || !Number.isInteger(evidence_ordinal) || evidence_ordinal < 1 || evidence_ordinal > 12
        || !HASH.test(evidence_sha256)) throw new TypeError("Wire challenge payload is invalid");
    rejectUnsafeContent(public_safe_summary + "\n" + (restricted_detail || ""));
    return {
      reason_code, public_safe_summary, restricted_detail,
      evidence_ordinal, evidence_sha256,
    };
  }
  if (action === "challenge_admit") {
    const decision = cleanText(input.decision);
    if (!new Set(["accept", "reject"]).has(decision)) {
      throw new TypeError("Wire challenge admissibility decision is invalid");
    }
    return { decision };
  }
  if (action === "challenge_review") {
    const decision = cleanText(input.decision);
    const reason_code = cleanText(input.reason_code);
    const public_rationale = cleanText(input.public_rationale);
    const private_note = optionalText(input.private_note, "private_note", WIRE_LONG_TEXT_MAX);
    if (!new Set(["accept", "reject"]).has(decision)
        || !/^[a-z][a-z0-9_:-]{0,95}$/.test(reason_code)
        || public_rationale.length < 10 || public_rationale.length > WIRE_LONG_TEXT_MAX) {
      throw new TypeError("Wire challenge review payload is invalid");
    }
    rejectUnsafeContent(public_rationale + "\n" + (private_note || ""));
    return { decision, reason_code, public_rationale, private_note };
  }
  if (Object.keys(input).length !== 0) {
    throw new TypeError("Wire governance payload is invalid");
  }
  return {};
}

export function canonicalWireMemo(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new TypeError("Wire event binding is invalid");
  }
  const purpose = cleanText(binding.purpose);
  const publicRef = cleanText(binding.version_public_ref);
  const role = cleanText(binding.actor_role);
  const decision = cleanText(binding.decision);
  const nonce = cleanText(binding.nonce);
  const hash = cleanText(binding.payload_hash);
  const issuedAt = Number(binding.issued_at);
  const expiresAt = Number(binding.expires_at);
  validateWallet(binding.actor_wallet);
  if (purpose !== WIRE_EVENT_TYPE || !WIRE_VERSION_REF.test(publicRef)) {
    throw new TypeError("Wire event purpose or target is invalid");
  }
  if (role !== "wallet" || !new Set(["submit", "revise"]).has(decision)) {
    throw new TypeError("Wire event actor or decision is invalid");
  }
  if (!NONCE.test(nonce) || !HASH.test(hash)) {
    throw new TypeError("Wire event proof binding is invalid");
  }
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
      || expiresAt <= issuedAt || expiresAt - issuedAt > 300) {
    throw new TypeError("Wire event timestamps are invalid");
  }
  return canonicalOsi2Envelope({
    purpose, target_type: "wire_version", target_ref: publicRef,
    actor_wallet: binding.actor_wallet, actor_role: role, decision,
    nonce, payload_hash: hash, issued_at: issuedAt, expires_at: expiresAt,
  });
}

export function parseWireMemo(message) {
  if (typeof message !== "string" || message.length < 140 || message.length > 512) return null;
  const parts = message.split("|");
  if (parts.length !== 12 || parts[0] !== "OSI2" || parts[1] !== "1") return null;
  const take = (part, key) => part.startsWith(key + "=") ? part.slice(key.length + 1) : null;
  const value = {
    purpose: parts[2],
    target_type: take(parts[3], "t"),
    version_public_ref: take(parts[4], "id"),
    actor_wallet: take(parts[5], "a"),
    actor_role: take(parts[6], "r"),
    decision: take(parts[7], "d"),
    nonce: take(parts[8], "n"),
    payload_hash: take(parts[9], "h"),
    issued_at: Number(take(parts[10], "ts")),
    expires_at: Number(take(parts[11], "exp")),
  };
  if (value.target_type !== "wire_version") return null;
  try {
    if (canonicalWireMemo(value) !== message) return null;
  } catch {
    return null;
  }
  return value;
}

export function validateWireMemoBinding(message, expected, nowSeconds) {
  const parsed = parseWireMemo(message);
  if (!parsed) return { ok: false, reason: "bad_message" };
  for (const field of [
    "purpose", "version_public_ref", "actor_wallet", "actor_role", "decision",
    "nonce", "payload_hash", "issued_at", "expires_at",
  ]) {
    if (parsed[field] !== expected[field]) return { ok: false, reason: "wrong_" + field };
  }
  if (nowSeconds > parsed.expires_at) return { ok: false, reason: "expired" };
  if (parsed.issued_at > nowSeconds + 30) return { ok: false, reason: "not_yet_valid" };
  return { ok: true, parsed };
}

export function validateConfirmedWireTransaction(transaction, status, expected) {
  return validateConfirmedMemoTransaction(transaction, status, expected);
}

function safeReceipt(receipt) {
  if (!receipt || receipt.event_type !== WIRE_EVENT_TYPE
      || receipt.target_type !== "wire_version"
      || receipt.proof_type !== "solana_memo"
      || receipt.server_verified !== true) return null;
  const txSig = TX_SIG.test(String(receipt.tx_sig || "")) ? String(receipt.tx_sig) : null;
  return {
    event_type: WIRE_EVENT_TYPE,
    actor_wallet: String(receipt.actor_wallet || ""),
    actor_role: "wallet",
    decision: String(receipt.decision || ""),
    proof_type: "solana_memo",
    server_verified: true,
    tx_sig: txSig,
    occurred_at: receipt.occurred_at || null,
  };
}

function nullableText(value) {
  return value === null || value === undefined ? null : String(value);
}

function publicIdentity(value) {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    display_name: nullableText(row.display_name),
    handle: nullableText(row.handle),
    wallet: nullableText(row.wallet),
  };
}

function publicEvidence(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.map((row) => ({
    ordinal: Number(row?.ordinal || 0),
    kind: String(row?.kind || ""),
    ref: String(row?.ref || ""),
    sha256: String(row?.sha256 || ""),
  }));
}

function publicPaymentProof(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    block_time: value.block_time ?? null,
    cluster: nullableText(value.cluster),
    finality: nullableText(value.finality),
    memo_verified: value.memo_verified === true,
    payer_wallet: nullableText(value.payer_wallet),
    recipient_manifest: Array.isArray(value.recipient_manifest)
      ? value.recipient_manifest.map((item) => ({
        amount_lamports: nullableText(item?.amount_lamports),
        wallet: nullableText(item?.wallet),
      }))
      : [],
    slot: nullableText(value.slot),
    system_program_transfers_verified: value.system_program_transfers_verified === true,
    total_lamports: nullableText(value.total_lamports),
  };
}

function publicReview(value) {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    active: row.active === true,
    actor_role: nullableText(row.actor_role),
    created_at: row.created_at || null,
    decision: nullableText(row.decision),
    proof_type: nullableText(row.proof_type),
    public_rationale: nullableText(row.public_rationale),
    reason_code: nullableText(row.reason_code),
    receipt_id: nullableText(row.receipt_id),
    review_public_ref: nullableText(row.review_public_ref),
    reviewer: publicIdentity(row.reviewer),
    tier_snapshot: nullableText(row.tier_snapshot),
    weight: Number(row.weight || 0),
  };
}

function publicProof(value) {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    actor_role: nullableText(row.actor_role),
    actor_wallet: nullableText(row.actor_wallet),
    decision: nullableText(row.decision),
    decision_channel: nullableText(row.decision_channel),
    event_type: nullableText(row.event_type),
    label: nullableText(row.label),
    occurred_at: row.occurred_at || null,
    payment_proof: publicPaymentProof(row.payment_proof),
    proof_type: nullableText(row.proof_type),
    public_ref: nullableText(row.public_ref),
    reason_code: nullableText(row.reason_code),
    receipt_id: nullableText(row.receipt_id),
    tx_sig: nullableText(row.tx_sig),
    weight: row.weight === null || row.weight === undefined ? null : Number(row.weight),
  };
}

// The database RPC is service-only, so the Edge boundary must still construct
// an explicit public DTO. In particular, Wire body_private and
// uncertainties_private mirror Case Report privacy and are never public merely
// because the exact version reached publication.
export function publicWireReportDto(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !WIRE_REPORT_REF.test(String(value.wire_report_public_ref || ""))
      || !WIRE_VERSION_REF.test(String(value.version_public_ref || ""))) {
    throw new TypeError("Public Wire projection is invalid");
  }
  const challenges = Array.isArray(value.challenges) ? value.challenges : [];
  const support = Array.isArray(value.support) ? value.support : [];
  const publication = value.publication && typeof value.publication === "object"
    && !Array.isArray(value.publication) ? value.publication : {};
  return {
    author: publicIdentity(value.author),
    challenge_state: nullableText(value.challenge_state),
    challenges: challenges.map((challenge) => ({
      admitted_by_wallet: nullableText(challenge?.admitted_by_wallet),
      challenge_public_ref: nullableText(challenge?.challenge_public_ref),
      challenger_wallet: nullableText(challenge?.challenger_wallet),
      created_at: challenge?.created_at || null,
      public_safe_summary: nullableText(challenge?.public_safe_summary),
      reason_code: nullableText(challenge?.reason_code),
      reviews: (Array.isArray(challenge?.reviews) ? challenge.reviews : []).map(publicReview),
      state: nullableText(challenge?.state),
      terminal_at: challenge?.terminal_at || null,
    })),
    contested_at: value.contested_at || null,
    evidence: publicEvidence(value.evidence),
    is_current_published: value.is_current_published === true,
    promoted: value.promoted === true,
    promoted_case_public_ref: nullableText(value.promoted_case_public_ref),
    proof_log: (Array.isArray(value.proof_log) ? value.proof_log : []).map(publicProof),
    publication: {
      actor_role: nullableText(publication.actor_role),
      actor_wallet: nullableText(publication.actor_wallet),
      decision_channel: nullableText(publication.decision_channel),
      occurred_at: publication.occurred_at || null,
      proof_type: nullableText(publication.proof_type),
      receipt_id: nullableText(publication.receipt_id),
      tx_sig: nullableText(publication.tx_sig),
    },
    published_at: value.published_at || null,
    reviews: (Array.isArray(value.reviews) ? value.reviews : []).map(publicReview),
    summary: String(value.summary || ""),
    support: support.map((item) => ({
      amount_lamports: nullableText(item?.amount_lamports),
      confirmed_at: item?.confirmed_at || null,
      from_wallet: nullableText(item?.from_wallet),
      label: nullableText(item?.label),
      payment_proof: publicPaymentProof(item?.payment_proof),
      proof_type: nullableText(item?.proof_type),
      receipt_id: nullableText(item?.receipt_id),
      tx_sig: nullableText(item?.tx_sig),
    })),
    title: String(value.title || ""),
    version_no: Number(value.version_no || 0),
    version_public_ref: String(value.version_public_ref),
    wire_report_public_ref: String(value.wire_report_public_ref),
  };
}

export function authorizedWireReportDto(
  report,
  versions,
  evidenceByVersion,
  receiptByVersion,
  writesEnabled,
) {
  if (!report || !WIRE_REPORT_REF.test(String(report.public_ref || ""))) {
    throw new TypeError("Wire Report projection is invalid");
  }
  if (!Array.isArray(versions)) throw new TypeError("Wire version projection is invalid");
  return {
    wire_report_public_ref: String(report.public_ref),
    status: String(report.status),
    current_version_ref: String(report.current_version_ref || ""),
    current_version_no: Number(report.current_version_no || 0),
    current_published_version_ref: report.current_published_version_ref || null,
    revision_eligible: writesEnabled === true && report.status === "active",
    versions: versions.map((version) => {
      if (!WIRE_VERSION_REF.test(String(version.version_ref || ""))) {
        throw new TypeError("Wire version projection is invalid");
      }
      return {
        version_ref: String(version.version_ref),
        version_no: Number(version.version_no),
        lifecycle_state: String(version.lifecycle_state),
        title_public_safe: String(version.title_public_safe),
        content_public_safe: String(version.content_public_safe),
        body_private: String(version.body_private),
        uncertainties_private: String(version.uncertainties_private),
        evidence_snapshot_hash: String(version.evidence_snapshot_hash),
        revision_reason_code: version.revision_reason_code || null,
        supersedes_version_ref: version.supersedes_version_ref || null,
        submitted_at: version.created_at || null,
        evidence: (evidenceByVersion.get(String(version.id)) || []).map((item) => ({
          ordinal: Number(item.ordinal),
          kind: String(item.kind),
          ref: String(item.ref),
          sha256: String(item.sha256),
        })),
        proof: safeReceipt(receiptByVersion.get(String(version.id)) || null),
      };
    }),
  };
}
