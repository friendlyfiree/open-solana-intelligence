// Dependency-free Case lifecycle validation and canonical proof helpers.
// Database access, RPC calls and secret-bearing operations stay in the Edge
// Function. These pure helpers are shared with Node regression tests.

import { base58Decode, validateWallet } from "./osi-v2-proof-core.mjs";

export const CASE_CATEGORIES = new Set([
  "wallet_drain",
  "token_risk",
  "protocol_incident",
  "social_engineering",
  "market_manipulation",
  "other",
]);

export const CASE_WRITE_PURPOSES = new Set([
  "CASE_SUBMITTED",
  "CASE_INITIAL_REVIEW_CAST",
  "CASE_INITIAL_REVIEW_REVISED",
  "CASE_OPENED",
]);

// This first slice deliberately omits the rejection outcome. Recording a
// rejection before its counted quorum and terminal transition exist would
// leave the Case in a misleading nonterminal state.
export const REVIEW_DECISIONS = new Set(["approve_open", "needs_more"]);
export const REVIEW_REASON_CODES = new Set([
  "public_scope_clear",
  "needs_more_evidence",
  "unsafe_or_prohibited",
  "duplicate_or_out_of_scope",
]);

const PUBLIC_REF = /^OSI-[0-9A-F]{12}$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const IDEMPOTENCY = /^[A-Za-z0-9._:-]{16,128}$/;
const TX_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
const PROHIBITED_SECRET = /\b(seed phrase|recovery phrase|mnemonic|private key|secret key|keypair bytes?)\b/i;
const ILLEGAL_ACCESS = /\b(stolen credentials?|credential dump|malware payload|exploit kit|unauthorized access)\b/i;

function cleanText(value) {
  return typeof value === "string" ? value.trim().replace(/\r\n?/g, "\n") : "";
}

function requireLength(value, name, min, max) {
  const text = cleanText(value);
  if (text.length < min || text.length > max) throw new TypeError(name + " is invalid");
  return text;
}

function rejectProhibitedContent(value) {
  if (PROHIBITED_SECRET.test(value)) throw new TypeError("prohibited_secret_material");
  if (ILLEGAL_ACCESS.test(value)) throw new TypeError("prohibited_illegal_access_material");
}

export function normalizeEvidence(input) {
  if (!Array.isArray(input) || input.length > 12) throw new TypeError("evidence is invalid");
  const seen = new Set();
  return input.map((item) => {
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
    return { kind, ref };
  });
}

export function normalizeCasePayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("case payload is invalid");
  }
  const title = requireLength(input.title, "title", 8, 160);
  const category = cleanText(input.category);
  if (!CASE_CATEGORIES.has(category)) throw new TypeError("category is invalid");
  const summary_public = requireLength(input.summary_public, "public summary", 40, 2000);
  const details_restricted = requireLength(input.details_restricted, "restricted details", 40, 12000);
  rejectProhibitedContent(title + "\n" + summary_public + "\n" + details_restricted);

  let reward_intent_lamports = null;
  if (input.reward_intent_lamports !== null && input.reward_intent_lamports !== undefined
      && input.reward_intent_lamports !== "") {
    const amount = Number(input.reward_intent_lamports);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000_000_000_000) {
      throw new TypeError("reward intent is invalid");
    }
    reward_intent_lamports = amount;
  }

  return {
    title,
    category,
    summary_public,
    details_restricted,
    reward_intent_lamports,
    evidence: normalizeEvidence(input.evidence ?? []),
  };
}

export function normalizeReviewInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("review payload is invalid");
  }
  const case_ref = cleanText(input.case_ref);
  const decision = cleanText(input.decision);
  const reason_code = cleanText(input.reason_code);
  if (!PUBLIC_REF.test(case_ref)) throw new TypeError("case ref is invalid");
  if (!REVIEW_DECISIONS.has(decision)) throw new TypeError("decision is invalid");
  if (!REVIEW_REASON_CODES.has(reason_code)) throw new TypeError("reason code is invalid");
  return { case_ref, decision, reason_code };
}

export function validateIdempotencyKey(value) {
  const key = cleanText(value);
  if (!IDEMPOTENCY.test(key)) throw new TypeError("idempotency key is invalid");
  return key;
}

export function canonicalCaseEventMessage(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new TypeError("event binding is invalid");
  }
  const purpose = cleanText(binding.purpose);
  const publicRef = cleanText(binding.public_ref);
  const role = cleanText(binding.actor_role);
  const decision = cleanText(binding.decision);
  const nonce = cleanText(binding.nonce);
  const hash = cleanText(binding.payload_hash);
  const issuedAt = Number(binding.issued_at);
  const expiresAt = Number(binding.expires_at);
  validateWallet(binding.actor_wallet);
  if (!CASE_WRITE_PURPOSES.has(purpose) || !PUBLIC_REF.test(publicRef)) {
    throw new TypeError("event purpose or target is invalid");
  }
  if (!new Set(["owner", "analyst", "senior", "maintainer"]).has(role)) {
    throw new TypeError("event actor role is invalid");
  }
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(decision)) throw new TypeError("event decision is invalid");
  if (!NONCE.test(nonce) || !HASH.test(hash)) throw new TypeError("event proof binding is invalid");
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
      || expiresAt <= issuedAt || expiresAt - issuedAt > 300) {
    throw new TypeError("event timestamps are invalid");
  }
  return [
    "OSI2", "1", purpose, "t=case", "id=" + publicRef,
    "a=" + binding.actor_wallet, "r=" + role, "d=" + decision,
    "n=" + nonce, "h=" + hash, "ts=" + issuedAt, "exp=" + expiresAt,
  ].join("|");
}

export function parseCaseEventMessage(message) {
  if (typeof message !== "string" || message.length < 120 || message.length > 512) return null;
  const parts = message.split("|");
  if (parts.length !== 12 || parts[0] !== "OSI2" || parts[1] !== "1") return null;
  const take = (part, key) => part.startsWith(key + "=") ? part.slice(key.length + 1) : null;
  const value = {
    purpose: parts[2],
    target_type: take(parts[3], "t"),
    public_ref: take(parts[4], "id"),
    actor_wallet: take(parts[5], "a"),
    actor_role: take(parts[6], "r"),
    decision: take(parts[7], "d"),
    nonce: take(parts[8], "n"),
    payload_hash: take(parts[9], "h"),
    issued_at: Number(take(parts[10], "ts")),
    expires_at: Number(take(parts[11], "exp")),
  };
  if (value.target_type !== "case") return null;
  try {
    if (canonicalCaseEventMessage(value) !== message) return null;
  } catch {
    return null;
  }
  return value;
}

export function validateCaseEventBinding(message, expected, nowSeconds) {
  const parsed = parseCaseEventMessage(message);
  if (!parsed) return { ok: false, reason: "bad_message" };
  for (const field of [
    "purpose", "public_ref", "actor_wallet", "actor_role", "decision",
    "nonce", "payload_hash", "issued_at", "expires_at",
  ]) {
    if (parsed[field] !== expected[field]) return { ok: false, reason: "wrong_" + field };
  }
  if (nowSeconds > parsed.expires_at) return { ok: false, reason: "expired" };
  if (parsed.issued_at > nowSeconds + 30) return { ok: false, reason: "not_yet_valid" };
  return { ok: true, parsed };
}

export function validateConfirmedMemoTransaction(transaction, status, expected) {
  if (!transaction || transaction.meta?.err != null) return { ok: false, reason: "transaction_failed" };
  if (!status || status.err != null
      || !new Set(["confirmed", "finalized"]).has(status.confirmationStatus)) {
    return { ok: false, reason: "transaction_not_confirmed" };
  }
  if (!TX_SIG.test(expected.tx_sig) || transaction.transaction?.signatures?.[0] !== expected.tx_sig) {
    return { ok: false, reason: "wrong_transaction" };
  }
  const keys = transaction.transaction?.message?.accountKeys ?? [];
  const signer = keys.find((key) => typeof key === "object" && key?.signer === true);
  const signerWallet = typeof signer === "object" ? String(signer.pubkey ?? "") : String(keys[0] ?? "");
  if (signerWallet !== expected.wallet) return { ok: false, reason: "wrong_signer" };

  const instructions = transaction.transaction?.message?.instructions ?? [];
  const memos = instructions.filter((instruction) => {
    const programId = typeof instruction?.programId === "object"
      ? String(instruction.programId) : String(instruction?.programId ?? "");
    return instruction?.program === "spl-memo"
      || programId === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
  }).map((instruction) => {
    if (typeof instruction.parsed === "string") return instruction.parsed;
    if (typeof instruction.parsed?.memo === "string") return instruction.parsed.memo;
    return "";
  }).filter(Boolean);
  if (memos.length !== 1 || memos[0] !== expected.memo) {
    return { ok: false, reason: "wrong_memo" };
  }
  const occurredAt = Number(transaction.blockTime);
  if (!Number.isSafeInteger(occurredAt)) return { ok: false, reason: "missing_block_time" };
  if (occurredAt < expected.issued_at - 30 || occurredAt > expected.expires_at) {
    return { ok: false, reason: "stale_transaction" };
  }
  return { ok: true, occurred_at: new Date(occurredAt * 1000).toISOString() };
}

export function maintainerGate(authValid, wallet, configuredAdminWallet) {
  const walletValid = typeof configuredAdminWallet === "string"
    && configuredAdminWallet.length > 0 && wallet === configuredAdminWallet;
  if (authValid && walletValid) return { ok: true };
  if (walletValid) return { ok: false, reason: "half_maintainer_wallet_only" };
  if (authValid) return { ok: false, reason: "half_maintainer_auth_only" };
  return { ok: false, reason: "maintainer_denied" };
}
