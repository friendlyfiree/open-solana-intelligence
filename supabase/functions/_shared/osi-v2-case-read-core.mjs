// OSI V2 read-slice core: pure, dependency-free logic shared by the
// osi-v2-case-read Edge Function and the node regression tests.
//
// Everything here is deterministic and side-effect free: challenge message
// construction/parsing, authorization decisions, exact proof labels and
// minimized DTO builders. Crypto (HMAC, Ed25519) and database access stay in
// the Edge Function; signature verification reuses osi-v2-proof-core.mjs.
//
// Design note (recorded decision): the Stage-5 SQL nonce infrastructure is NOT
// reused for read authorization because osi_v2_issue_nonce fails closed while
// OSI_V2_PROOF_ENABLED=false (which must remain false in this slice) and
// osi_v2_consume_signed_nonce inserts an event_receipts row — a V2 domain
// write, which this read-only slice must never perform. Instead the Edge
// Function mints an HMAC-authenticated, single-purpose, exact-target-bound
// challenge with a hard <=120s expiry, verifies the wallet's Ed25519 signature
// over the full challenge server-side, and suppresses replays best-effort
// in-instance. No database write of any kind occurs.

export const READ_CHALLENGE_VERSION = "1";
export const READ_CHALLENGE_PREFIX = "OSI2-READ";
export const READ_CHALLENGE_MAX_TTL_SECONDS = 120;

export const READ_PURPOSES = new Set([
  "CASE_READ_MY_CASES",
  "CASE_READ_AUTHORIZED_CASE",
  "CASE_READ_MAINTAINER_OVERVIEW",
]);

// Exact, honest proof labels. A receipt may claim the verified/on-chain labels
// only when its stored fields genuinely prove them; anything else — including
// every legacy import — is labeled "Legacy / not server-verified".
export const PROOF_LABELS = Object.freeze({
  solana_memo: "Memo-anchored on Solana",
  wallet_signed_server_verified: "Wallet-signed & server-verified",
  system_event: "System event",
  legacy_imported: "Legacy / not server-verified",
});

export function proofLabel(receipt) {
  const proofType = String(receipt?.proof_type ?? "");
  const serverVerified = receipt?.server_verified === true;
  const txSig = String(receipt?.tx_sig ?? "");
  if (proofType === "solana_memo" && serverVerified && /^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(txSig)) {
    return PROOF_LABELS.solana_memo;
  }
  if (proofType === "wallet_signed_server_verified" && serverVerified) {
    return PROOF_LABELS.wallet_signed_server_verified;
  }
  if (proofType === "system_event" && serverVerified) {
    return PROOF_LABELS.system_event;
  }
  return PROOF_LABELS.legacy_imported;
}

// Stages in which a Case is allowed to be publicly visible (must mirror
// cases_public_visibility_stage_check in the additive schema).
export const PUBLIC_CASE_STAGES = new Set([
  "open_public",
  "in_review",
  "ready_for_finalization",
  "resolution_proposed",
  "in_challenge_window",
  "resolved",
  "sealed",
  "archived",
  "reopened",
  "halted",
]);

// Stages a verified analyst may read under the server-derived analyst model:
// everything that has entered governance review or is public. Drafts,
// withdrawn, initially-rejected and safety-blocked Cases stay out of analyst
// scope in this read slice.
export const ANALYST_READ_STAGES = new Set([
  "submitted",
  "initial_review",
  ...PUBLIC_CASE_STAGES,
]);

export function isCasePublic(caseRow) {
  return caseRow?.visibility === "public" && PUBLIC_CASE_STAGES.has(String(caseRow?.stage ?? ""));
}

// actor: { kind: 'anonymous' | 'owner' | 'analyst' | 'maintainer', wallet?: string }
// The caller is responsible for having PROVEN the actor claim (signature,
// analyst lookup, maintainer double-gate) before asking this question.
export function canActorReadCase(actor, caseRow) {
  if (!caseRow) return false;
  if (isCasePublic(caseRow)) return true;
  const kind = actor?.kind;
  if (kind === "maintainer") return true;
  if (kind === "owner") {
    return typeof actor.wallet === "string"
      && actor.wallet.length >= 32
      && caseRow.submitted_by_wallet === actor.wallet;
  }
  if (kind === "analyst") {
    return ANALYST_READ_STAGES.has(String(caseRow.stage ?? ""));
  }
  return false;
}

const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const TARGET_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const HMAC_PATTERN = /^[0-9a-f]{64}$/;

// Canonical challenge prefix (the part the HMAC covers).
export function challengeSigningInput(fields) {
  return [
    READ_CHALLENGE_PREFIX,
    READ_CHALLENGE_VERSION,
    fields.purpose,
    "t=" + fields.target_type,
    "id=" + fields.target_id,
    "a=" + fields.wallet,
    "n=" + fields.nonce,
    "ts=" + String(fields.issued_at),
    "exp=" + String(fields.expires_at),
  ].join("|");
}

export function buildChallenge(fields, hmacHex) {
  if (!HMAC_PATTERN.test(String(hmacHex))) throw new TypeError("challenge hmac is invalid");
  return challengeSigningInput(fields) + "|m=" + hmacHex;
}

// Parse a full challenge string back into fields. Returns null on any shape
// violation; never throws on untrusted input.
export function parseChallenge(challenge) {
  if (typeof challenge !== "string" || challenge.length < 40 || challenge.length > 1024) return null;
  const parts = challenge.split("|");
  if (parts.length !== 10) return null;
  const [prefix, version, purpose, t, id, a, n, ts, exp, m] = parts;
  const take = (piece, key) => piece.startsWith(key + "=") ? piece.slice(key.length + 1) : null;
  const fields = {
    purpose,
    target_type: take(t, "t"),
    target_id: take(id, "id"),
    wallet: take(a, "a"),
    nonce: take(n, "n"),
    issued_at: Number(take(ts, "ts")),
    expires_at: Number(take(exp, "exp")),
    hmac: take(m, "m"),
  };
  if (prefix !== READ_CHALLENGE_PREFIX || version !== READ_CHALLENGE_VERSION) return null;
  if (!READ_PURPOSES.has(fields.purpose)) return null;
  if (!TARGET_TYPE_PATTERN.test(fields.target_type ?? "")) return null;
  if (!TARGET_ID_PATTERN.test(fields.target_id ?? "")) return null;
  if (!WALLET_PATTERN.test(fields.wallet ?? "")) return null;
  if (!NONCE_PATTERN.test(fields.nonce ?? "")) return null;
  if (!Number.isSafeInteger(fields.issued_at) || !Number.isSafeInteger(fields.expires_at)) return null;
  if (!HMAC_PATTERN.test(fields.hmac ?? "")) return null;
  return fields;
}

// Validate parsed challenge fields against the expected binding. The caller
// separately recomputes and compares the HMAC and verifies the Ed25519
// signature over the FULL challenge string.
export function validateChallengeBinding(fields, expected, nowSeconds) {
  if (!fields) return { ok: false, reason: "bad_challenge" };
  if (fields.purpose !== expected.purpose) return { ok: false, reason: "wrong_purpose" };
  if (fields.target_type !== expected.target_type) return { ok: false, reason: "wrong_target" };
  if (fields.target_id !== expected.target_id) return { ok: false, reason: "wrong_target" };
  if (fields.wallet !== expected.wallet) return { ok: false, reason: "wallet_mismatch" };
  const ttl = fields.expires_at - fields.issued_at;
  if (ttl <= 0 || ttl > READ_CHALLENGE_MAX_TTL_SECONDS) return { ok: false, reason: "bad_expiry" };
  if (nowSeconds > fields.expires_at) return { ok: false, reason: "expired" };
  if (nowSeconds + READ_CHALLENGE_MAX_TTL_SECONDS < fields.issued_at) {
    return { ok: false, reason: "not_yet_valid" };
  }
  return { ok: true };
}

function isoOrNull(value) {
  if (typeof value !== "string" || !value) return null;
  return value;
}

function publicVersionDto(version) {
  if (!version) return null;
  return {
    version_no: version.version_no ?? null,
    lifecycle_state: String(version.lifecycle_state ?? ""),
    published_at: isoOrNull(version.published_at),
  };
}

function publicReceiptDto(receipt) {
  return {
    label: proofLabel(receipt),
    event_type: String(receipt.event_type ?? ""),
    occurred_at: isoOrNull(receipt.occurred_at),
  };
}

// The ONLY fields an anonymous caller may ever see for a genuinely public
// Case. No uuid, no wallets, no bodies, no hashes, no memo text, no tx data.
export function publicCaseDto(caseRow, reports = [], versionsByReport = {}, receipts = []) {
  return {
    public_ref: String(caseRow.public_ref ?? ""),
    title: String(caseRow.title ?? ""),
    summary: String(caseRow.summary_public ?? ""),
    stage: String(caseRow.stage ?? ""),
    visibility: String(caseRow.visibility ?? ""),
    created_at: isoOrNull(caseRow.created_at),
    sealed_at: isoOrNull(caseRow.sealed_at),
    reports: reports.map((report) => ({
      status: String(report.status ?? ""),
      current_version: publicVersionDto(
        (versionsByReport[report.id] ?? []).find((v) => v.id === report.current_version_id) ?? null,
      ),
      published: report.current_published_version_id != null,
    })),
    proof_log: receipts.map(publicReceiptDto),
  };
}

function authorizedVersionDto(version, actorWallet) {
  const dto = {
    version_no: version.version_no ?? null,
    lifecycle_state: String(version.lifecycle_state ?? ""),
    created_by_wallet: String(version.created_by_wallet ?? ""),
    created_at: isoOrNull(version.created_at),
    published_at: isoOrNull(version.published_at),
    evidence_snapshot_hash: String(version.evidence_snapshot_hash ?? ""),
    body_length: typeof version.body_private === "string" ? version.body_private.length : 0,
    has_public_content: version.content_public_safe != null,
  };
  // The raw private body is returned ONLY to the wallet that wrote it.
  if (typeof actorWallet === "string" && actorWallet && version.created_by_wallet === actorWallet) {
    dto.body_private = String(version.body_private ?? "");
  }
  return dto;
}

function authorizedReceiptDto(receipt) {
  return {
    label: proofLabel(receipt),
    event_type: String(receipt.event_type ?? ""),
    target_type: String(receipt.target_type ?? ""),
    occurred_at: isoOrNull(receipt.occurred_at),
    tx_sig: receipt.tx_sig ? String(receipt.tx_sig) : null,
    memo: receipt.memo_ref ? String(receipt.memo_ref) : null,
    server_verified: receipt.server_verified === true,
  };
}

// Fields an authorized actor (proven owner, verified analyst on an in-scope
// Case, or full maintainer) may see. Still minimized: no migration metadata,
// no service internals; the private body only for its own author.
export function authorizedCaseDto(caseRow, reports = [], versionsByReport = {}, receipts = [], actor = {}) {
  return {
    public_ref: String(caseRow.public_ref ?? ""),
    title: String(caseRow.title ?? ""),
    summary: String(caseRow.summary_public ?? ""),
    category: String(caseRow.category ?? ""),
    stage: String(caseRow.stage ?? ""),
    visibility: String(caseRow.visibility ?? ""),
    risk_tier: String(caseRow.risk_tier ?? ""),
    submitted_by_wallet: String(caseRow.submitted_by_wallet ?? ""),
    created_at: isoOrNull(caseRow.created_at),
    updated_at: isoOrNull(caseRow.updated_at),
    sealed_at: isoOrNull(caseRow.sealed_at),
    reports: reports.map((report) => ({
      author_wallet: String(report.author_wallet ?? ""),
      status: String(report.status ?? ""),
      created_at: isoOrNull(report.created_at),
      published: report.current_published_version_id != null,
      versions: (versionsByReport[report.id] ?? [])
        .slice()
        .sort((left, right) => (left.version_no ?? 0) - (right.version_no ?? 0))
        .map((version) => authorizedVersionDto(version, actor.wallet)),
    })),
    proof_log: receipts.map(authorizedReceiptDto),
  };
}

// Maintainer overview: aggregate counts plus per-case metadata rows. Never a
// private body, never migration crosswalk/queue row contents (counts only).
export function maintainerOverviewDto(input) {
  const {
    cases = [],
    reportsByCase = {},
    versionsByReport = {},
    receiptsByCaseTarget = {},
    receiptTotals = {},
    crosswalkCount = 0,
    manualQueueCount = 0,
    flags = {},
  } = input;
  return {
    totals: {
      cases: cases.length,
      cases_by_stage: cases.reduce((acc, c) => {
        const key = String(c.stage ?? "unknown");
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
      cases_by_visibility: cases.reduce((acc, c) => {
        const key = String(c.visibility ?? "unknown");
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
      receipts_by_label: receiptTotals,
      migration_crosswalk_rows: crosswalkCount,
      migration_manual_queue_rows: manualQueueCount,
    },
    flags: {
      OSI_V2_WRITES_ENABLED: String(flags.OSI_V2_WRITES_ENABLED ?? ""),
      OSI_V2_PROOF_ENABLED: String(flags.OSI_V2_PROOF_ENABLED ?? ""),
    },
    cases: cases.map((caseRow) => authorizedCaseDto(
      caseRow,
      reportsByCase[caseRow.id] ?? [],
      versionsByReport,
      receiptsByCaseTarget[caseRow.public_ref] ?? [],
      { kind: "maintainer" },
    )),
  };
}

// Key names that must NEVER appear anywhere in a public (anonymous) response.
export const PUBLIC_FORBIDDEN_KEYS = Object.freeze([
  "id",
  "submitted_by_wallet",
  "author_wallet",
  "created_by_wallet",
  "actor_wallet",
  "anchor_wallet",
  "body_private",
  "content_owner_safe",
  "content_analyst_restricted",
  "evidence_snapshot_hash",
  "payload_hash",
  "memo_ref",
  "memo",
  "tx_sig",
  "nonce",
  "signature",
  "legacy_id",
  "legacy_table",
  "v2_id",
]);

export function collectForbiddenKeys(value, forbidden = PUBLIC_FORBIDDEN_KEYS, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectForbiddenKeys(item, forbidden, found);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.includes(key)) found.add(key);
      collectForbiddenKeys(child, forbidden, found);
    }
  }
  return found;
}
