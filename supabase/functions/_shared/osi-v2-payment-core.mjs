// Dependency-free native SOL payment validation shared by the Edge gateway
// and Node regression tests. Amounts cross every trust boundary as decimal
// strings and are converted to BigInt only after strict validation.

const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
const HASH = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const PUBLIC_REF = /^OSI-[A-Z0-9-]{6,56}$/;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export const PAYMENT_KIND = Object.freeze({ REWARD: "reward", SUPPORT: "support" });
export const PAYMENT_EVENT = Object.freeze({
  reward: "REWARD_PAYMENT_CONFIRMED",
  support: "SUPPORT_PAYMENT_CONFIRMED",
});
export const PAYMENT_MAX_RECIPIENTS = 4;
export const PAYMENT_MAX_LAMPORTS = 100_000_000_000n; // 100 SOL per intent.
export const SOLANA_TRANSACTION_MAX_BYTES = 1232;
export const SOLANA_MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

export function isSolanaMainnetGenesis(value) {
  return value === SOLANA_MAINNET_GENESIS_HASH;
}

function requireText(value, field, pattern, maximum = 256) {
  if (typeof value !== "string") throw new TypeError(field + " is required");
  const clean = value.trim();
  if (!clean || clean.length > maximum || (pattern && !pattern.test(clean))) {
    throw new TypeError(field + " is invalid");
  }
  return clean;
}

export function normalizePaymentTargetRef(value) {
  const clean = requireText(value, "target_ref", null, 64);
  if (!PUBLIC_REF.test(clean) && !WALLET.test(clean)) {
    throw new TypeError("target_ref is invalid");
  }
  return clean;
}

export function parseSolToLamports(value) {
  const text = requireText(value, "amount_sol", /^\d+(?:\.\d{1,9})?$/, 32);
  const [wholeText, fractionText = ""] = text.split(".");
  if (wholeText.length > 1 && wholeText.startsWith("0")) {
    throw new TypeError("amount_sol has a non-canonical leading zero");
  }
  const lamports = BigInt(wholeText) * 1_000_000_000n
    + BigInt(fractionText.padEnd(9, "0") || "0");
  if (lamports <= 0n || lamports > PAYMENT_MAX_LAMPORTS) {
    throw new RangeError("amount_sol is outside the allowed range");
  }
  return lamports;
}

export function parseLamports(value, field = "amount_lamports") {
  const text = requireText(String(value ?? ""), field, /^[1-9]\d{0,20}$/, 21);
  const lamports = BigInt(text);
  if (lamports <= 0n || lamports > PAYMENT_MAX_LAMPORTS) {
    throw new RangeError(field + " is outside the allowed range");
  }
  return lamports;
}

export function formatLamportsAsSol(value) {
  const lamports = typeof value === "bigint" ? value : parseLamports(value);
  const whole = lamports / 1_000_000_000n;
  const fraction = String(lamports % 1_000_000_000n).padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function normalizeRecipientManifest(input, payerWallet) {
  const payer = requireText(payerWallet, "payer_wallet", WALLET, 44);
  if (!Array.isArray(input) || input.length < 1 || input.length > PAYMENT_MAX_RECIPIENTS) {
    throw new TypeError("recipient_manifest is invalid");
  }
  const seen = new Set();
  let total = 0n;
  const manifest = input.map((entry, ordinal) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("recipient_manifest entry is invalid");
    }
    const wallet = requireText(entry.wallet, "recipient_wallet", WALLET, 44);
    if (wallet === payer) throw new TypeError("self support is not allowed");
    if (seen.has(wallet)) throw new TypeError("recipient wallets must be unique");
    seen.add(wallet);
    const amount = parseLamports(entry.amount_lamports, "recipient_amount_lamports");
    total += amount;
    if (total > PAYMENT_MAX_LAMPORTS) throw new RangeError("payment total is outside the allowed range");
    return {
      ordinal: ordinal + 1,
      wallet,
      amount_lamports: String(amount),
      recipient_type: requireText(
        entry.recipient_type,
        "recipient_type",
        /^(report_author|analyst|counted_reviewer)$/,
        32,
      ),
      target_ref: requireText(entry.target_ref, "recipient_target_ref", PUBLIC_REF, 64),
    };
  });
  return { manifest, total_lamports: String(total) };
}

export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("canonical number is invalid");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("canonical value is invalid");
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function recipientManifestHash(manifest) {
  return await sha256Hex(canonicalJson(manifest));
}

export function canonicalPaymentMemo(intent) {
  const kind = requireText(intent?.payment_kind, "payment_kind", /^(reward|support)$/, 16);
  const event = PAYMENT_EVENT[kind];
  const targetType = kind === PAYMENT_KIND.REWARD ? "reward" : "support";
  const decision = kind === PAYMENT_KIND.REWARD ? "paid" : "sent";
  const targetRef = requireText(intent.target_public_ref, "target_public_ref", PUBLIC_REF, 64);
  const payer = requireText(intent.payer_wallet, "payer_wallet", WALLET, 44);
  const role = requireText(intent.actor_role, "actor_role", /^(owner|wallet)$/, 16);
  const nonce = requireText(intent.nonce, "nonce", NONCE, 128);
  const hash = requireText(intent.payload_hash, "payload_hash", HASH, 64);
  const issuedAt = Number(intent.issued_at);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new TypeError("issued_at is invalid");
  return [
    "OSI2", "1", event, `t=${targetType}`, `id=${targetRef}`,
    `a=${payer}`, `r=${role}`, `d=${decision}`, `n=${nonce}`,
    `h=${hash}`, `ts=${issuedAt}`,
  ].join("|");
}

// Exact byte count for the restricted legacy transaction shape used here:
// one fee-payer signature, N SystemProgram transfers and one Memo instruction.
// It intentionally rejects long memos/large manifests well below 1232 bytes.
function shortvecBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("shortvec value is invalid");
  let remaining = value;
  let bytes = 0;
  do { bytes++; remaining = Math.floor(remaining / 128); } while (remaining > 0);
  return bytes;
}

export function estimatePaymentTransactionBytes(recipientCount, memo) {
  if (!Number.isSafeInteger(recipientCount) || recipientCount < 1
      || recipientCount > PAYMENT_MAX_RECIPIENTS) throw new TypeError("recipient_count is invalid");
  const memoBytes = new TextEncoder().encode(requireText(memo, "memo", null, 700)).length;
  const uniqueAccounts = recipientCount + 3; // payer, recipients, System, Memo.
  const transferInstructionBytes = 1 + shortvecBytes(2) + 2 + shortvecBytes(12) + 12;
  const memoInstructionBytes = 1 + shortvecBytes(1) + 1 + shortvecBytes(memoBytes) + memoBytes;
  const messageBytes = 3 + shortvecBytes(uniqueAccounts) + (32 * uniqueAccounts) + 32
    + shortvecBytes(recipientCount + 1)
    + (recipientCount * transferInstructionBytes) + memoInstructionBytes;
  return shortvecBytes(1) + 64 + messageBytes;
}

function accountKeyValue(entry) {
  if (typeof entry === "string") return entry;
  return String(entry?.pubkey ?? "");
}

function signerAccountKeys(message) {
  return (message?.accountKeys ?? []).filter((entry) => (
    typeof entry === "object" && entry?.signer === true
  )).map(accountKeyValue);
}

function parsedTransfer(instruction) {
  const programId = String(instruction?.programId ?? "");
  if (programId !== SYSTEM_PROGRAM || instruction?.parsed?.type !== "transfer") return null;
  const info = instruction.parsed.info ?? {};
  const lamports = info.lamports ?? info.amount;
  return {
    source: String(info.source ?? ""),
    destination: String(info.destination ?? ""),
    lamports: String(lamports ?? ""),
  };
}

function parsedMemo(instruction) {
  const programId = String(instruction?.programId ?? "");
  if (programId !== MEMO_PROGRAM) return null;
  if (typeof instruction.parsed === "string") return instruction.parsed;
  if (typeof instruction.parsed?.info === "string") return instruction.parsed.info;
  if (typeof instruction.parsed === "string") return instruction.parsed;
  return null;
}

export function validateFinalizedPaymentTransaction(transaction, signatureStatus, intent, txSignature) {
  const txSig = requireText(txSignature, "tx_signature", SIGNATURE, 96);
  if (!transaction || !signatureStatus) return { ok: false, state: "awaiting_finality", reason: "transaction_pending" };
  if (transaction?.meta?.err != null || signatureStatus?.err != null) {
    return { ok: false, state: "verification_failed", reason: "transaction_failed" };
  }
  const message = transaction?.transaction?.message;
  const keys = message?.accountKeys ?? [];
  const payer = requireText(intent?.payer_wallet, "payer_wallet", WALLET, 44);
  if (accountKeyValue(keys[0]) !== payer) {
    return { ok: false, state: "verification_failed", reason: "wrong_fee_payer" };
  }
  const signers = signerAccountKeys(message);
  if (signers.length !== 1 || signers[0] !== payer) {
    return { ok: false, state: "verification_failed", reason: "unexpected_signer" };
  }
  const signatures = transaction?.transaction?.signatures ?? [];
  if (signatures.length !== 1 || String(signatures[0]) !== txSig) {
    return { ok: false, state: "verification_failed", reason: "signature_mismatch" };
  }
  const issuedAt = Number(intent?.issued_at);
  const expiresAt = Number(intent?.expires_at);
  const blockTime = Number(transaction?.blockTime);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
      || !Number.isSafeInteger(blockTime) || blockTime < issuedAt - 5 || blockTime > expiresAt + 120) {
    return { ok: false, state: "verification_failed", reason: "transaction_not_fresh" };
  }
  const expectedMemo = canonicalPaymentMemo(intent);
  const normalized = normalizeRecipientManifest(intent?.recipient_manifest, payer);
  const transfers = [];
  const memos = [];
  for (const instruction of message?.instructions ?? []) {
    const transfer = parsedTransfer(instruction);
    if (transfer) { transfers.push(transfer); continue; }
    const memo = parsedMemo(instruction);
    if (memo != null) { memos.push(memo); continue; }
    return { ok: false, state: "verification_failed", reason: "unexpected_instruction" };
  }
  if (memos.length !== 1 || memos[0] !== expectedMemo) {
    return { ok: false, state: "verification_failed", reason: "memo_mismatch" };
  }
  if (transfers.length !== normalized.manifest.length) {
    return { ok: false, state: "verification_failed", reason: "transfer_count_mismatch" };
  }
  for (let index = 0; index < transfers.length; index++) {
    const actual = transfers[index];
    const expected = normalized.manifest[index];
    if (actual.source !== payer || actual.destination !== expected.wallet
        || actual.lamports !== expected.amount_lamports) {
      return { ok: false, state: "verification_failed", reason: "transfer_manifest_mismatch" };
    }
  }
  const slot = Number(transaction?.slot);
  if (!Number.isSafeInteger(slot) || slot <= 0) {
    return { ok: false, state: "verification_failed", reason: "slot_invalid" };
  }
  if (signatureStatus.confirmationStatus !== "finalized") {
    return { ok: false, state: "awaiting_finality", reason: "transaction_not_finalized" };
  }
  return {
    ok: true,
    state: "confirmed",
    slot,
    block_time: new Date(blockTime * 1000).toISOString(),
    finality: "finalized",
    fee_lamports: String(transaction?.meta?.fee ?? "0"),
    memo: expectedMemo,
    recipient_manifest: normalized.manifest,
    total_lamports: normalized.total_lamports,
  };
}

export function paymentProgramIds() {
  return { system: SYSTEM_PROGRAM, memo: MEMO_PROGRAM };
}
