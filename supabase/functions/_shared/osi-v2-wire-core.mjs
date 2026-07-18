// Dependency-free validation, canonical Memo, and least-privilege projection
// helpers for native Wire Report intake. Secret-bearing work remains in the
// Edge gateway; this module is shared with Node regression tests.

import {
  normalizeReportEvidence,
  validateReportIdempotencyKey,
} from "./osi-v2-report-core.mjs";
import { validateWallet } from "./osi-v2-proof-core.mjs";
import { validateConfirmedMemoTransaction } from "./osi-v2-case-write-core.mjs";

export const WIRE_EVENT_TYPE = "WIRE_REPORT_VERSION_SUBMITTED";
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
const PROHIBITED_SECRET = /\b(seed phrase|recovery phrase|mnemonic|private key|secret key|keypair bytes?|access token|api key)\b/i;
const ILLEGAL_ACCESS = /\b(stolen credentials?|credential dump|malware payload|exploit kit|unauthorized access)\b/i;
const DOXXING = /\b(doxx(?:ing|ed)?|home address|private phone number|private messages?)\b/i;
const PROHIBITED_PERSONAL_DATA = /\b(?:\d{3}-\d{2}-\d{4}|\d{3}\s\d{3}\s\d{2}\s\d{2}|(?:\d[ -]*?){13,19})\b/;

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
  if (PROHIBITED_PERSONAL_DATA.test(value)) throw new TypeError("prohibited_personal_data");
}

export async function normalizeWirePayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("wire payload is invalid");
  }
  const title_public_safe = requireLength(input.title_public_safe, "Wire title", 8, 160);
  const content_public_safe = requireLength(input.content_public_safe, "Wire summary", 40, 4000);
  const body_private = requireLength(input.body_private, "Wire analysis", 80, 100000);
  const uncertainties_private = requireLength(
    input.uncertainties_private,
    "Wire uncertainties",
    20,
    4000,
  );
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
    evidence: await normalizeReportEvidence(input.evidence),
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
  return [
    "OSI2", "1", purpose, "t=wire_version", "id=" + publicRef,
    "a=" + binding.actor_wallet, "r=" + role, "d=" + decision,
    "n=" + nonce, "h=" + hash, "ts=" + issuedAt, "exp=" + expiresAt,
  ].join("|");
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
