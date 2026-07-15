// OSI V2 read-slice core: pure, dependency-free logic shared by the
// osi-v2-case-read Edge Function and the node regression tests.
//
// Everything here is deterministic and side-effect free: challenge message
// construction/parsing, authorization decisions, exact proof labels and
// minimized DTO builders. Crypto (HMAC, Ed25519) and database access stay in
// the Edge Function; signature verification reuses osi-v2-proof-core.mjs.
//
// Read authorization uses its own durable osi_read_nonces infrastructure table
// because a read proof must not create a governance receipt. The Edge Function
// mints an HMAC-authenticated, exact-target-bound challenge with a hard <=120s
// expiry, verifies Ed25519 first, then atomically consumes the database nonce.
// This makes cross-instance replay a hard denial without mutating domain data.

export const READ_CHALLENGE_VERSION = "1";
export const READ_CHALLENGE_PREFIX = "OSI2-READ";
export const READ_CHALLENGE_MAX_TTL_SECONDS = 120;

export const READ_PURPOSES = new Set([
  "CASE_READ_MY_CASES",
  "CASE_READ_AUTHORIZED_CASE",
  "CASE_READ_REVIEW_QUEUE",
  "CASE_READ_MAINTAINER_OVERVIEW",
  "ANALYST_READ_MY_WORKSPACE",
  "ANALYST_READ_MAINTAINER_QUEUE",
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

// actor: { kind: 'anonymous' | 'owner' | 'report_author' | 'analyst' | 'maintainer', wallet?: string }
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
    version_ref: version.version_ref == null ? null : String(version.version_ref),
    version_no: version.version_no ?? null,
    lifecycle_state: String(version.lifecycle_state ?? ""),
    published_at: isoOrNull(version.published_at),
  };
}

function publicReceiptDto(receipt) {
  const txSig = proofLabel(receipt) === PROOF_LABELS.solana_memo
    ? String(receipt.tx_sig ?? "") : "";
  const dto = {
    label: proofLabel(receipt),
    event_type: String(receipt.event_type ?? ""),
    public_ref: receipt.public_ref == null ? null : String(receipt.public_ref),
    actor_wallet: String(receipt.actor_wallet ?? ""),
    actor_role: String(receipt.actor_role ?? ""),
    decision: receipt.decision == null ? null : String(receipt.decision),
    weight: receipt.weight == null ? null : Number(receipt.weight),
    occurred_at: isoOrNull(receipt.occurred_at),
  };
  if (txSig) {
    dto.tx_sig = txSig;
    dto.solscan_url = "https://solscan.io/tx/" + txSig;
  }
  if (new Set(["REWARD_PAYMENT_CONFIRMED", "SUPPORT_PAYMENT_CONFIRMED"])
    .has(String(receipt.event_type ?? ""))) {
    const metadata = receipt.verification_metadata && typeof receipt.verification_metadata === "object"
      ? receipt.verification_metadata : {};
    dto.payment_proof = {
      cluster: metadata.cluster === "mainnet-beta" ? "mainnet-beta" : null,
      finality: metadata.finality === "finalized" ? "finalized" : null,
      slot: metadata.slot == null ? null : String(metadata.slot),
      block_time: isoOrNull(metadata.block_time),
      payer_wallet: String(metadata.payer_wallet ?? ""),
      recipient_manifest: Array.isArray(metadata.recipient_manifest)
        ? metadata.recipient_manifest.map((entry) => ({
          wallet: String(entry?.wallet ?? ""),
          amount_lamports: String(entry?.amount_lamports ?? ""),
          recipient_type: String(entry?.recipient_type ?? ""),
          target_ref: String(entry?.target_ref ?? ""),
        })) : [],
      total_lamports: String(metadata.total_lamports ?? ""),
      target_public_ref: String(metadata.target_public_ref ?? ""),
      memo_verified: metadata.memo_verified === true,
      transfers_verified: metadata.system_program_transfers_verified === true,
    };
    dto.memo = receipt.memo_ref == null ? null : String(receipt.memo_ref);
    if (dto.payment_proof.cluster === "mainnet-beta"
        && dto.payment_proof.finality === "finalized"
        && dto.payment_proof.memo_verified
        && dto.payment_proof.transfers_verified
        && txSig) {
      dto.label = "SOL transfer verified on Solana";
    }
  }
  return dto;
}

function moneyDto(money = {}, includePending = false) {
  const pledge = money.pledge ?? null;
  const payments = (money.payments ?? []).filter((row) => (
    row.state === "confirmed" || includePending
  ));
  const supports = (money.supports ?? []).filter((row) => (
    row.state === "confirmed" || includePending
  ));
  const confirmed = (money.payments ?? []).filter((row) => row.state === "confirmed")
    .reduce((sum, row) => sum + BigInt(String(row.amount_lamports ?? 0)), 0n);
  const latestPayment = (money.payments ?? []).slice().sort((left, right) => (
    new Date(left.created_at ?? 0).getTime() - new Date(right.created_at ?? 0).getTime()
  )).at(-1) ?? null;
  const amount = pledge ? BigInt(String(pledge.amount_lamports ?? 0)) : 0n;
  const outstanding = amount > confirmed ? amount - confirmed : 0n;
  let status = "none";
  if (pledge) {
    if (pledge.state === "cancelled") status = "withdrawn";
    else if (outstanding === 0n && amount > 0n && pledge.state === "paid") status = "fulfilled";
    else if ((money.payments ?? []).some((row) => row.state === "submitted")) status = "awaiting_finality";
    else if (latestPayment?.state === "failed") status = "verification_failed";
    else if (confirmed > 0n && outstanding > 0n) status = "partially_fulfilled";
    else if (pledge.state === "assigned" && confirmed === 0n) status = "payment_ready";
    else status = "pledged";
  }
  return {
    reward: pledge ? {
      amount_lamports: amount.toString(),
      state: String(pledge.state ?? ""),
      revision_no: Number(pledge.revision_no ?? 1),
      sealed_amount_lamports: pledge.sealed_amount_lamports == null
        ? null : String(pledge.sealed_amount_lamports),
      confirmed_lamports: confirmed.toString(),
      outstanding_lamports: outstanding.toString(),
      status,
      winning_report_version_ref: money.winning_report_version_ref == null
        ? null : String(money.winning_report_version_ref),
      winning_report_author_wallet: money.winning_report_author_wallet == null
        ? null : String(money.winning_report_author_wallet),
      updated_at: isoOrNull(pledge.updated_at),
      payments: payments.map((row) => ({
        amount_lamports: String(row.amount_lamports ?? ""),
        to_wallet: String(row.to_wallet ?? ""),
        state: String(row.state ?? ""),
        tx_sig: row.tx_sig == null ? null : String(row.tx_sig),
        solscan_url: row.tx_sig == null ? null : "https://solscan.io/tx/" + String(row.tx_sig),
        finality: row.finality == null ? null : String(row.finality),
        confirmed_at: isoOrNull(row.confirmed_at),
      })),
    } : null,
    support_options: (money.support_options ?? []).map((row) => ({
      target_type: String(row.target_type ?? ""),
      target_ref: String(row.target_ref ?? ""),
      wallet: String(row.wallet ?? ""),
      label: String(row.label ?? ""),
    })),
    confirmed_support: supports.map((row) => ({
      support_type: String(row.support_type ?? ""),
      amount_lamports: String(row.amount_lamports ?? ""),
      from_wallet: String(row.from_wallet ?? ""),
      recipient_manifest: Array.isArray(row.recipient_manifest) ? row.recipient_manifest.map((entry) => ({
        wallet: String(entry?.wallet ?? ""),
        amount_lamports: String(entry?.amount_lamports ?? ""),
        recipient_type: String(entry?.recipient_type ?? ""),
        target_ref: String(entry?.target_ref ?? ""),
      })) : [],
      state: String(row.state ?? ""),
      tx_sig: row.tx_sig == null ? null : String(row.tx_sig),
      solscan_url: row.tx_sig == null ? null : "https://solscan.io/tx/" + String(row.tx_sig),
      confirmed_at: isoOrNull(row.confirmed_at),
    })),
    notice: "Rewards and support are voluntary direct wallet-to-wallet SOL transfers. OSI never takes custody, escrow, or commission, and payment does not affect ranking, review weight, governance, truth, or guilt.",
  };
}

function publicEvidenceDto(evidence) {
  return {
    kind: String(evidence.kind ?? ""),
    ref: String(evidence.ref ?? ""),
    sha256: String(evidence.sha256 ?? ""),
  };
}

function reviewDto(review, includeReason) {
  const dto = {
    reviewer_wallet: String(review.reviewer_wallet ?? ""),
    decision: String(review.decision ?? ""),
    reviewer_role: String(review.reviewer_role ?? ""),
    weight: Number(review.weight ?? 0),
    is_active: review.is_active === true,
    created_at: isoOrNull(review.created_at),
    proof_label: proofLabel(review.receipt ?? {}),
  };
  if (includeReason) dto.reason_code = review.reason_code == null ? null : String(review.reason_code);
  return dto;
}

function governanceReviewDto(review, includeRestricted) {
  const dto = {
    public_ref: String(review.public_ref ?? ""),
    phase: String(review.phase ?? ""),
    target_version_ref: review.candidate_version_ref == null
      ? null : String(review.candidate_version_ref),
    reviewer_wallet: String(review.reviewer_wallet ?? ""),
    decision: String(review.decision ?? ""),
    weight: Number(review.weight ?? 0),
    tier_snapshot: String(review.tier_snapshot ?? ""),
    public_rationale: String(review.public_rationale ?? ""),
    is_active: review.is_active === true,
    created_at: isoOrNull(review.created_at),
    proof_label: proofLabel(review.receipt ?? {}),
    actor_role: String(review.receipt?.actor_role ?? ""),
  };
  if (includeRestricted) dto.private_note = review.private_note == null
    ? null : String(review.private_note);
  return dto;
}

function governanceDto(governance = {}, includeRestricted = false) {
  const resolution = governance.resolution;
  const resolutionDto = resolution ? {
    public_ref: String(resolution.public_ref ?? ""),
    state: String(resolution.state ?? ""),
    winning_report_version_ref: resolution.winning_report_version_ref == null
      ? null : String(resolution.winning_report_version_ref),
    challenge_window_opens_at: isoOrNull(resolution.challenge_window_opens_at),
    challenge_window_closes_at: isoOrNull(resolution.challenge_window_ends_at),
    reopened_at: isoOrNull(resolution.reopened_at),
    sealed_at: isoOrNull(resolution.sealed_at),
    selection_quorum: resolution.selection_quorum ?? null,
    seal_quorum: resolution.seal_quorum ?? null,
    final_proof: resolution.final_receipt ? publicReceiptDto(resolution.final_receipt) : null,
    seal_proof: resolution.seal_receipt ? publicReceiptDto(resolution.seal_receipt) : null,
    reviews: (governance.resolution_reviews ?? []).map((review) => (
      governanceReviewDto(review, includeRestricted)
    )),
  } : null;
  return {
    resolution: resolutionDto,
    challenges: (governance.challenges ?? []).map((challenge) => {
      const dto = {
        public_ref: String(challenge.public_ref ?? ""),
        challenger_wallet: String(challenge.challenger_wallet ?? ""),
        public_safe_summary: String(challenge.public_safe_summary ?? ""),
        state: String(challenge.state ?? ""),
        blocking: new Set(["open", "under_review"]).has(String(challenge.state ?? "")),
        admissibility_deadline_at: isoOrNull(challenge.admissibility_ttl_at),
        review_deadline_at: isoOrNull(challenge.review_deadline_at),
        terminal_at: isoOrNull(challenge.terminal_at),
        outcome_quorum: challenge.outcome_quorum ?? null,
        submission_proof: challenge.submitted_receipt
          ? publicReceiptDto(challenge.submitted_receipt) : null,
        opening_proof: challenge.opened_receipt
          ? publicReceiptDto(challenge.opened_receipt) : null,
        outcome_proof: challenge.resolved_receipt
          ? publicReceiptDto(challenge.resolved_receipt) : null,
        reviews: (challenge.reviews ?? []).map((review) => (
          governanceReviewDto(review, includeRestricted)
        )),
      };
      if (includeRestricted) {
        dto.reason_code = String(challenge.reason_code ?? "");
        dto.restricted_detail = challenge.restricted_detail == null
          ? null : String(challenge.restricted_detail);
      }
      return dto;
    }),
    process_notice: "Primary Report selection and process sealing record reviewed, challengeable outcomes. They do not determine truth, guilt, legal certainty, recovery, custody, or payment.",
  };
}

// The ONLY fields an anonymous caller may ever see for a genuinely public
// Case. Receipt actor wallets and validated Memo transaction signatures are
// public provenance; internal UUIDs, private bodies, payload hashes, raw memo
// text, nonces, signatures, and restricted reason codes remain excluded.
export function publicCaseDto(
  caseRow,
  reports = [],
  versionsByReport = {},
  receipts = [],
  evidence = [],
  reviews = [],
  governance = {},
  money = {},
) {
  const publishedVersionIds = new Set(
    reports.map((report) => report.current_published_version_id)
      .filter((value) => value != null)
      .map(String),
  );
  return {
    public_ref: String(caseRow.public_ref ?? ""),
    title: String(caseRow.title ?? ""),
    summary: String(caseRow.summary_public ?? ""),
    category: String(caseRow.category ?? ""),
    stage: String(caseRow.stage ?? ""),
    visibility: String(caseRow.visibility ?? ""),
    risk_tier: String(caseRow.risk_tier ?? ""),
    created_at: isoOrNull(caseRow.created_at),
    sealed_at: isoOrNull(caseRow.sealed_at),
    evidence: evidence
      .filter((item) => item.is_public === true && item.moderation_state === "approved")
      .map(publicEvidenceDto),
    reviews: reviews.filter((review) => review.is_active === true)
      .map((review) => reviewDto(review, false)),
    reports: reports.filter((report) => report.current_published_version_id != null)
      .map((report) => ({
      public_ref: String(report.public_ref ?? ""),
      status: String(report.status ?? ""),
      current_version: publicVersionDto(
        (versionsByReport[report.id] ?? []).find(
          (version) => version.id === report.current_published_version_id,
        ) ?? null,
      ),
      content_public_safe: String(
        (versionsByReport[report.id] ?? []).find(
          (version) => version.id === report.current_published_version_id,
        )?.content_public_safe ?? "",
      ),
      published: true,
    })),
    governance: governanceDto(governance, false),
    money: moneyDto(money, false),
    proof_log: receipts.filter((receipt) => (
      receipt.target_type !== "report_version"
      || publishedVersionIds.has(String(receipt.target_id))
    )).map(publicReceiptDto),
  };
}

function authorizedVersionDto(version, actor) {
  const dto = {
    version_ref: version.version_ref == null ? null : String(version.version_ref),
    version_no: version.version_no ?? null,
    lifecycle_state: String(version.lifecycle_state ?? ""),
    created_by_wallet: String(version.created_by_wallet ?? ""),
    created_at: isoOrNull(version.created_at),
    published_at: isoOrNull(version.published_at),
    evidence_snapshot_hash: String(version.evidence_snapshot_hash ?? ""),
    body_length: typeof version.body_private === "string" ? version.body_private.length : 0,
    has_public_content: version.content_public_safe != null,
  };
  // Restricted bodies are returned only to the author, an eligible analyst,
  // or a full maintainer using the dedicated detail path. Overview DTOs can
  // explicitly suppress them even for maintainers.
  if (actor.suppress_private_body !== true
      && ((actor.kind === "analyst" || actor.kind === "maintainer")
      || (typeof actor.wallet === "string" && actor.wallet
        && version.created_by_wallet === actor.wallet))) {
    dto.body_private = String(version.body_private ?? "");
    dto.content_public_safe = version.content_public_safe == null
      ? null : String(version.content_public_safe);
  }
  return dto;
}

function authorizedReceiptDto(receipt, includeReason) {
  const dto = publicReceiptDto(receipt);
  dto.target_type = String(receipt.target_type ?? "");
  dto.memo = receipt.memo_ref ? String(receipt.memo_ref) : null;
  dto.server_verified = receipt.server_verified === true;
  if (includeReason) dto.reason_code = receipt.reason_code == null ? null : String(receipt.reason_code);
  return dto;
}

// Fields an authorized actor (proven owner, exact Report author, verified
// analyst on an in-scope Case, or full maintainer) may see. Still minimized:
// no migration metadata, no service internals; the private body only for its
// own author unless analyst/maintainer review scope applies.
export function authorizedCaseDto(
  caseRow,
  reports = [],
  versionsByReport = {},
  receipts = [],
  actor = {},
  evidence = [],
  reviews = [],
  governance = {},
  money = {},
) {
  const includeRestrictedReviewFields = actor.kind === "analyst" || actor.kind === "maintainer";
  const visibleReports = reports.filter((report) => (
    includeRestrictedReviewFields
    || report.author_wallet === actor.wallet
    || report.current_published_version_id != null
  ));
  const visibleReportVersionIds = new Set();
  for (const report of visibleReports) {
    if (includeRestrictedReviewFields || report.author_wallet === actor.wallet) {
      for (const version of versionsByReport[report.id] ?? []) {
        visibleReportVersionIds.add(String(version.id));
      }
    } else if (report.current_published_version_id != null) {
      visibleReportVersionIds.add(String(report.current_published_version_id));
    }
  }
  return {
    public_ref: String(caseRow.public_ref ?? ""),
    title: String(caseRow.title ?? ""),
    summary: String(caseRow.summary_public ?? ""),
    ...(actor.kind === "report_author" ? {} : {
      details_restricted: String(caseRow.details_restricted ?? ""),
    }),
    category: String(caseRow.category ?? ""),
    stage: String(caseRow.stage ?? ""),
    visibility: String(caseRow.visibility ?? ""),
    risk_tier: String(caseRow.risk_tier ?? ""),
    ...(actor.kind === "report_author" ? {} : {
      submitted_by_wallet: String(caseRow.submitted_by_wallet ?? ""),
    }),
    created_at: isoOrNull(caseRow.created_at),
    updated_at: isoOrNull(caseRow.updated_at),
    sealed_at: isoOrNull(caseRow.sealed_at),
    ...(actor.kind === "report_author" ? {} : {
      reward_intent_lamports: caseRow.reward_intent_lamports == null
        ? null : Number(caseRow.reward_intent_lamports),
    }),
    evidence: evidence.map(publicEvidenceDto),
    reviews: reviews.map((review) => reviewDto(review, includeRestrictedReviewFields)),
    reports: visibleReports.map((report) => ({
      public_ref: String(report.public_ref ?? ""),
      author_wallet: includeRestrictedReviewFields || report.author_wallet === actor.wallet
        ? String(report.author_wallet ?? "") : undefined,
      status: String(report.status ?? ""),
      created_at: isoOrNull(report.created_at),
      published: report.current_published_version_id != null,
      versions: (versionsByReport[report.id] ?? [])
        .filter((version) => includeRestrictedReviewFields
          || report.author_wallet === actor.wallet
          || version.id === report.current_published_version_id)
        .slice()
        .sort((left, right) => (left.version_no ?? 0) - (right.version_no ?? 0))
        .map((version) => authorizedVersionDto(version, actor)),
    })),
    governance: governanceDto(governance, includeRestrictedReviewFields),
    money: moneyDto(money, true),
    proof_log: receipts.filter((receipt) => (
      receipt.target_type !== "report_version"
      || visibleReportVersionIds.has(String(receipt.target_id))
    )).map((receipt) => authorizedReceiptDto(receipt, includeRestrictedReviewFields)),
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
    governanceByCase = {},
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
      OSI_V2_CASE_WRITES_ENABLED: String(flags.OSI_V2_CASE_WRITES_ENABLED ?? ""),
      OSI_V2_RESOLUTION_LIFECYCLE_WRITES_ENABLED:
        String(flags.OSI_V2_RESOLUTION_LIFECYCLE_WRITES_ENABLED ?? ""),
    },
    cases: cases.map((caseRow) => authorizedCaseDto(
      caseRow,
      reportsByCase[caseRow.id] ?? [],
      versionsByReport,
      receiptsByCaseTarget[caseRow.public_ref] ?? [],
      { kind: "maintainer", suppress_private_body: true },
      [],
      [],
      governanceByCase[caseRow.id] ?? {},
    )),
  };
}

// Key names that must NEVER appear anywhere in a public (anonymous) response.
export const PUBLIC_FORBIDDEN_KEYS = Object.freeze([
  "id",
  "submitted_by_wallet",
  "author_wallet",
  "created_by_wallet",
  "anchor_wallet",
  "details_restricted",
  "body_private",
  "content_owner_safe",
  "content_analyst_restricted",
  "evidence_snapshot_hash",
  "payload_hash",
  "memo_ref",
  "nonce",
  "signature",
  "reason_code",
  "private_note",
  "restricted_detail",
  "evidence_hash",
  "selection_quorum_hash",
  "seal_quorum_hash",
  "outcome_quorum_hash",
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
