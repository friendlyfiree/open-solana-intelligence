// Dependency-free validation, canonical Memo, and least-privilege projection
// helpers for native Case Report intake. Database and secret-bearing work stay
// in the Edge gateways; this module is shared with Node regression tests.

import {
  base58Decode,
  sha256HexUtf8,
  validateWallet,
} from "./osi-v2-proof-core.mjs";
import { validateConfirmedMemoTransaction } from "./osi-v2-case-write-core.mjs";
import { canonicalOsi2Envelope } from "./osi-v2-event-registry.mjs";

export const REPORT_EVENT_TYPE = "CASE_REPORT_VERSION_SUBMITTED";
export const REPORT_REVIEW_EVENT_TYPES = new Set([
  "CASE_REPORT_REVIEW_CAST",
  "CASE_REPORT_REVIEW_REVISED",
]);
export const REPORT_PUBLICATION_EVENT_TYPE = "REPORT_PUBLISHED";
export const REPORT_REVIEW_DECISIONS = new Set([
  "approve",
  "reject",
  "request_revision",
  "abstain",
]);
export const REPORT_REVISION_REASONS = new Set([
  "author_correction",
  "new_evidence",
  "clarification",
  "review_response",
]);

const VERSION_REF = /^OSI-RV-[0-9A-F]{16}$/;
const REPORT_REF = /^OSI-RPT-[0-9A-F]{12}$/;
const CASE_REF = /^OSI-[0-9A-F]{12}$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const IDEMPOTENCY = /^[A-Za-z0-9._:-]{16,128}$/;
const TX_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
const PROHIBITED_SECRET = /\b(seed phrase|recovery phrase|mnemonic|private key|secret key|keypair bytes?|access token|api key)\b/i;
const ILLEGAL_ACCESS = /\b(stolen credentials?|credential dump|malware payload|exploit kit|unauthorized access)\b/i;
const GOVERNMENT_ID = /\b(?:\d{3}-\d{2}-\d{4}|\d{3}\s\d{3}\s\d{2}\s\d{2})\b/;
const PAYMENT_CARD_CANDIDATE = /(?:^|[^\d])((?:\d[ -]?){13,19})(?!\d)/g;

function cleanText(value) {
  return typeof value === "string" ? value.trim().replace(/\r\n?/g, "\n") : "";
}

function requireLength(value, name, min, max) {
  const text = cleanText(value);
  if (text.length < min || text.length > max) throw new TypeError(name + " is invalid");
  return text;
}

function passesLuhn(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function containsPaymentCard(value) {
  PAYMENT_CARD_CANDIDATE.lastIndex = 0;
  let match;
  while ((match = PAYMENT_CARD_CANDIDATE.exec(value)) !== null) {
    if (passesLuhn(match[1])) return true;
  }
  return false;
}

function rejectUnsafeContent(value) {
  if (PROHIBITED_SECRET.test(value)) throw new TypeError("prohibited_secret_material");
  if (ILLEGAL_ACCESS.test(value)) throw new TypeError("prohibited_illegal_access_material");
  if (GOVERNMENT_ID.test(value) || containsPaymentCard(value)) {
    throw new TypeError("prohibited_personal_data");
  }
}

export async function normalizeReportEvidence(input, options = {}) {
  const minimum = options.allowEmpty === true ? 0 : 1;
  if (!Array.isArray(input)) {
    throw new TypeError("evidence is invalid");
  }
  // Browser forms may retain one or more empty placeholder rows. They are not
  // evidence and must not become fake URLs/items or make an otherwise valid
  // zero-evidence Report fail. Any non-empty row still receives the exact
  // wallet/transaction/HTTPS validation below.
  const supplied = input.filter((item) => !(
    item && typeof item === "object" && !Array.isArray(item)
    && cleanText(item.ref) === ""
  ));
  if (supplied.length < minimum || supplied.length > 12) {
    throw new TypeError("evidence is invalid");
  }
  const seen = new Set();
  const result = [];
  for (const item of supplied) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError("evidence item is invalid");
    }
    const kind = cleanText(item.kind);
    const ref = cleanText(item.ref);
    if (!ref || ref.length > 4096) throw new TypeError("evidence ref is invalid");
    if (kind === "wallet") {
      validateWallet(ref);
    } else if (kind === "onchain_tx") {
      if (!TX_SIG.test(ref) || base58Decode(ref).length !== 64) {
        throw new TypeError("transaction reference is invalid");
      }
    } else if (kind === "url") {
      let parsed;
      try { parsed = new URL(ref); } catch { throw new TypeError("evidence URL is invalid"); }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
        throw new TypeError("evidence URL is invalid");
      }
    } else {
      throw new TypeError("evidence kind is invalid");
    }
    const key = kind + "\u0000" + ref;
    if (seen.has(key)) throw new TypeError("duplicate evidence item");
    seen.add(key);
    result.push({ kind, ref, sha256: await sha256HexUtf8(ref) });
  }
  return result;
}

export async function normalizeReportPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("report payload is invalid");
  }
  const body_private = requireLength(input.body_private, "restricted narrative", 80, 100000);
  const summary = cleanText(input.content_public_safe);
  if (summary.length > 4000) throw new TypeError("public-safe summary is invalid");
  const content_public_safe = summary || null;
  const revisionReason = cleanText(input.revision_reason_code);
  if (revisionReason && !REPORT_REVISION_REASONS.has(revisionReason)) {
    throw new TypeError("revision reason is invalid");
  }
  rejectUnsafeContent(body_private + "\n" + (content_public_safe || ""));
  return {
    body_private,
    content_public_safe,
    revision_reason_code: revisionReason || null,
    evidence: await normalizeReportEvidence(input.evidence ?? [], { allowEmpty: true }),
  };
}

// D19 public-safe review authority label. Present only once enforcement is on;
// absent (null) means the credential gate is not deciding anything yet, so no
// surface should claim it did.
export function sasAuthorityDto(review) {
  const authority = review && review.sas_authority;
  if (!authority || authority.enforced !== true) return null;
  return {
    enforced: true,
    counted: authority.counted === true,
    state: String(authority.state || "unchecked"),
  };
}

export function validateReportIdempotencyKey(value) {
  const key = cleanText(value);
  if (!IDEMPOTENCY.test(key)) throw new TypeError("idempotency key is invalid");
  return key;
}

export function normalizeReportReview(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("review payload is invalid");
  }
  const version_public_ref = cleanText(input.version_public_ref);
  const decision = cleanText(input.decision);
  const reason_code = cleanText(input.reason_code);
  const public_rationale = cleanText(input.public_rationale);
  const privateNote = cleanText(input.private_note);
  if (!VERSION_REF.test(version_public_ref)) {
    throw new TypeError("version reference is invalid");
  }
  if (!REPORT_REVIEW_DECISIONS.has(decision)) {
    throw new TypeError("review decision is invalid");
  }
  if (!/^[a-z][a-z0-9_:-]{0,95}$/.test(reason_code)) {
    throw new TypeError("review reason is invalid");
  }
  if (public_rationale.length < 10 || public_rationale.length > 2000) {
    throw new TypeError("public-safe rationale is invalid");
  }
  if (privateNote.length > 4000) {
    throw new TypeError("private analyst note is invalid");
  }
  rejectUnsafeContent(public_rationale + "\n" + privateNote);
  return {
    version_public_ref,
    decision,
    reason_code,
    public_rationale,
    private_note: privateNote || null,
  };
}

export function canonicalReportGovernanceMessage(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new TypeError("Report governance binding is invalid");
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
  const reviewPurpose = REPORT_REVIEW_EVENT_TYPES.has(purpose);
  // Counted reviews are always analyst-cast. The maintainer role appears only
  // on the publication message, for the D17 bootstrap channel; the database
  // still enforces the full double gate and the live tier before committing.
  if ((!reviewPurpose && purpose !== REPORT_PUBLICATION_EVENT_TYPE)
      || !VERSION_REF.test(publicRef)
      || !(new Set(["analyst", "senior"]).has(role)
        || (!reviewPurpose && role === "maintainer"))
      || (reviewPurpose && !REPORT_REVIEW_DECISIONS.has(decision))
      || (!reviewPurpose && decision !== "publish")
      || !NONCE.test(nonce) || !HASH.test(hash)
      || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
      || expiresAt <= issuedAt || expiresAt - issuedAt > 300) {
    throw new TypeError("Report governance binding is invalid");
  }
  return canonicalOsi2Envelope({
    purpose, target_type: "report_version", target_ref: publicRef,
    actor_wallet: binding.actor_wallet, actor_role: role, decision,
    nonce, payload_hash: hash, issued_at: issuedAt, expires_at: expiresAt,
  });
}

export function parseReportGovernanceMessage(message) {
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
  if (value.target_type !== "report_version") return null;
  try {
    if (canonicalReportGovernanceMessage(value) !== message) return null;
  } catch {
    return null;
  }
  return value;
}

export function validateReportGovernanceBinding(message, expected, nowSeconds) {
  const parsed = parseReportGovernanceMessage(message);
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

export function canonicalReportMemo(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new TypeError("report event binding is invalid");
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
  if (purpose !== REPORT_EVENT_TYPE || !VERSION_REF.test(publicRef)) {
    throw new TypeError("report event purpose or target is invalid");
  }
  if (role !== "wallet" || !new Set(["submit", "revise"]).has(decision)) {
    throw new TypeError("report event actor or decision is invalid");
  }
  if (!NONCE.test(nonce) || !HASH.test(hash)) {
    throw new TypeError("report event proof binding is invalid");
  }
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
      || expiresAt <= issuedAt || expiresAt - issuedAt > 300) {
    throw new TypeError("report event timestamps are invalid");
  }
  return canonicalOsi2Envelope({
    purpose, target_type: "report_version", target_ref: publicRef,
    actor_wallet: binding.actor_wallet, actor_role: role, decision,
    nonce, payload_hash: hash, issued_at: issuedAt, expires_at: expiresAt,
  });
}

export function parseReportMemo(message) {
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
  if (value.target_type !== "report_version") return null;
  try {
    if (canonicalReportMemo(value) !== message) return null;
  } catch {
    return null;
  }
  return value;
}

export function validateReportMemoBinding(message, expected, nowSeconds) {
  const parsed = parseReportMemo(message);
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

export function validateConfirmedReportTransaction(transaction, status, expected) {
  return validateConfirmedMemoTransaction(transaction, status, expected);
}

// Honesty requirement (D17): a bootstrap-channel receipt is always rendered
// as a maintainer cold-start decision and never as an analyst quorum outcome.
export const BOOTSTRAP_CHANNEL_LABEL =
  "Maintainer bootstrap (cold-start) decision. Not an independent analyst quorum outcome.";

function safeReceipt(receipt) {
  if (!receipt) return null;
  const bootstrap = receipt.decision_channel === "maintainer_bootstrap";
  return {
    event_type: receipt.event_type,
    actor_wallet: receipt.actor_wallet,
    actor_role: receipt.actor_role,
    proof_type: receipt.proof_type,
    server_verified: receipt.server_verified === true,
    tx_sig: receipt.tx_sig,
    occurred_at: receipt.occurred_at,
    decision_channel: bootstrap ? "maintainer_bootstrap" : "standard",
    decision_channel_label: bootstrap ? BOOTSTRAP_CHANNEL_LABEL : null,
  };
}

function nullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

export function reportPublicationCapabilityDto(capability) {
  if (!capability || typeof capability !== "object") return null;
  const channel = capability.decision_channel === "maintainer_bootstrap"
    ? "maintainer_bootstrap"
    : capability.decision_channel === "standard"
    ? "standard"
    : null;
  return {
    actor_is_eligible_analyst: capability.actor_is_eligible_analyst === true,
    actor_is_full_maintainer: capability.actor_is_full_maintainer === true,
    can_cast_analyst_review: capability.can_cast_analyst_review === true,
    analyst_review_reason_code: capability.analyst_review_reason_code || null,
    can_publish_via_standard_quorum:
      capability.can_publish_via_standard_quorum === true,
    standard_publication_reason_code:
      capability.standard_publication_reason_code || null,
    can_publish_via_maintainer_bootstrap:
      capability.can_publish_via_maintainer_bootstrap === true,
    maintainer_bootstrap_reason_code:
      capability.maintainer_bootstrap_reason_code || null,
    decision_channel: channel,
    standard_quorum_ready: capability.standard_quorum_ready === true,
    approve_count: Number(capability.approve_count || 0),
    approve_weight: Number(capability.approve_weight || 0),
    reject_count: Number(capability.reject_count || 0),
    reject_weight: Number(capability.reject_weight || 0),
    required_count: Number(capability.required_count || 0),
    required_weight: Number(capability.required_weight || 0),
    sas_enforcement_enabled: capability.sas_enforcement_enabled === true,
    bootstrap: {
      enabled: capability.bootstrap_enabled === true,
      active: capability.bootstrap_active === true,
      tier: capability.bootstrap_tier || null,
      eligible_analyst_count: nullableNumber(capability.eligible_analyst_count),
      required_analyst_count:
        nullableNumber(capability.bootstrap_required_analyst_count),
      required_analyst_weight:
        nullableNumber(capability.bootstrap_required_analyst_weight),
    },
  };
}

function exactVersionDto(
  version,
  evidence,
  receipt,
  reviews = [],
  quorum = null,
  access = "author",
  publicationCapability = null,
) {
  return {
    version_ref: version.version_ref,
    version_no: version.version_no,
    lifecycle_state: version.lifecycle_state,
    body_private: version.body_private,
    content_public_safe: version.content_public_safe,
    evidence_snapshot_hash: version.evidence_snapshot_hash,
    revision_reason_code: version.revision_reason_code,
    supersedes_version_ref: version.supersedes_version_ref || null,
    submitted_at: version.created_at,
    evidence: evidence.map((item) => ({
      ordinal: item.ordinal,
      kind: item.kind,
      ref: item.ref,
      sha256: item.sha256,
    })),
    proof: safeReceipt(receipt),
    reviews: reviews.map((review) => ({
      review_public_ref: review.public_ref,
      reviewer_wallet: review.reviewer_wallet,
      reviewer_handle: review.reviewer_handle || null,
      decision: review.decision,
      weight: Number(review.weight),
      tier_snapshot: review.tier_snapshot,
      reason_code: review.reason_code,
      public_rationale: review.public_rationale,
      ...(access === "analyst" || access === "maintainer"
        ? { private_note: review.private_note || null }
        : {}),
      is_active: review.is_active === true,
      created_at: review.created_at,
      proof: safeReceipt(review.receipt),
      sas_authority: sasAuthorityDto(review),
    })),
    quorum: quorum ? {
      risk_tier: quorum.risk_tier,
      approve_count: Number(quorum.approve_count || 0),
      approve_weight: Number(quorum.approve_weight || 0),
      reject_count: Number(quorum.reject_count || 0),
      reject_weight: Number(quorum.reject_weight || 0),
      required_count: Number(quorum.required_count || 0),
      required_weight: Number(quorum.required_weight || 0),
      approve_ready: quorum.approve_ready === true,
      reject_ready: quorum.reject_ready === true,
    } : null,
    publication_capability:
      reportPublicationCapabilityDto(publicationCapability),
  };
}

export function authorizedReportDto(
  report,
  versions,
  evidenceByVersion,
  receiptByVersion,
  access,
  reviewsByVersion = new Map(),
  quorumByVersion = new Map(),
  capabilityByVersion = new Map(),
) {
  if (!report || !new Set(["author", "analyst", "maintainer"]).has(access)) {
    throw new TypeError("report access is invalid");
  }
  if (!CASE_REF.test(report.case_public_ref) || !REPORT_REF.test(report.report_public_ref)) {
    throw new TypeError("report projection reference is invalid");
  }
  const currentVersion = versions.find(
    (version) => version.version_ref === report.current_version_ref,
  );
  const currentCapability = reportPublicationCapabilityDto(
    currentVersion ? capabilityByVersion.get(currentVersion.id) : null,
  );
  return {
    case_public_ref: report.case_public_ref,
    report_public_ref: report.report_public_ref,
    author_wallet: report.author_wallet,
    status: report.status,
    current_version_ref: report.current_version_ref,
    current_version_no: report.current_version_no,
    current_published_version_ref: report.current_published_version_ref || null,
    access,
    revision_eligible: access === "author" && report.revision_eligible === true,
    // Compatibility alias for older clients. Maintainer bootstrap is never an
    // analyst review mutation; dual-role actors receive both independent
    // capabilities below instead of being flattened to one role.
    review_mutations_enabled: currentCapability
      ? currentCapability.can_cast_analyst_review
      : access === "analyst" && report.review_mutations_enabled === true,
    can_cast_analyst_review:
      currentCapability?.can_cast_analyst_review === true,
    can_publish_via_standard_quorum:
      currentCapability?.can_publish_via_standard_quorum === true,
    can_publish_via_maintainer_bootstrap:
      currentCapability?.can_publish_via_maintainer_bootstrap === true,
    publication_capability: currentCapability,
    versions: versions.map((version) => exactVersionDto(
      version,
      evidenceByVersion.get(version.id) || [],
      receiptByVersion.get(version.id) || null,
      reviewsByVersion.get(version.id) || [],
      quorumByVersion.get(version.id) || null,
      access,
      capabilityByVersion.get(version.id) || null,
    )),
  };
}

export function publicPublishedReports(reportRows) {
  if (!Array.isArray(reportRows)) return [];
  return reportRows
    .filter((report) => report.current_published_version_id != null)
    .map((report) => ({
      report_public_ref: report.public_ref,
      current_published_version_ref: report.current_published_version_ref,
      content_public_safe: report.content_public_safe,
      published_at: report.published_at,
    }));
}

export function publicReportGovernanceDto(report) {
  if (!report || !REPORT_REF.test(String(report.report_public_ref || ""))
      || !VERSION_REF.test(String(report.version_public_ref || ""))
      || report.lifecycle_state !== "published") {
    throw new TypeError("public Report projection is invalid");
  }
  const timeline = Array.isArray(report.reviews) ? report.reviews : [];
  return {
    report_public_ref: String(report.report_public_ref),
    version_public_ref: String(report.version_public_ref),
    version_no: Number(report.version_no),
    state: "published",
    content_public_safe: report.content_public_safe == null
      ? null
      : String(report.content_public_safe),
    body: String(report.body_private || ""),
    evidence: Array.isArray(report.evidence)
      ? report.evidence.filter((item) => item.is_public === true && item.moderation_state === "approved")
        .map((item) => ({
          ordinal: Number(item.ordinal),
          kind: String(item.kind),
          ref: String(item.ref),
          sha256: String(item.sha256),
        }))
      : [],
    quorum: {
      risk_tier: String(report.quorum?.risk_tier || "standard"),
      approve_count: Number(report.quorum?.approve_count || 0),
      approve_weight: Number(report.quorum?.approve_weight || 0),
      required_count: Number(report.quorum?.required_count || 0),
      required_weight: Number(report.quorum?.required_weight || 0),
      approve_ready: report.quorum?.approve_ready === true,
    },
    review_timeline: timeline.map((review) => ({
      review_public_ref: String(review.public_ref || ""),
      reviewer_wallet: String(review.reviewer_wallet || ""),
      reviewer_handle: review.reviewer_handle ? String(review.reviewer_handle) : null,
      decision: String(review.decision || ""),
      weight: Number(review.weight || 0),
      tier_snapshot: String(review.tier_snapshot || ""),
      public_rationale: String(review.public_rationale || ""),
      is_active: review.is_active === true,
      proof_type: String(review.receipt?.proof_type || ""),
      actor_role: String(review.receipt?.actor_role || ""),
      server_verified: review.receipt?.server_verified === true,
      created_at: review.created_at || null,
      sas_authority: sasAuthorityDto(review),
    })),
    publication_proof: safeReceipt(report.publication_receipt),
    published_at: report.published_at || null,
    process_notice: "Publication records a reviewed OSI process outcome. It is not proof of truth, guilt, legal certainty, recovery, custody, or guaranteed payment.",
  };
}
