// Dependency-free native SOL payment validation shared by the Edge gateway
// and Node regression tests. Amounts cross every trust boundary as decimal
// strings and are converted to BigInt only after strict validation.

import { canonicalOsi2Envelope } from "./osi-v2-event-registry.mjs";

const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
const HASH = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const PUBLIC_REF = /^OSI-[A-Z0-9-]{6,56}$/;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const LIGHTHOUSE_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
const LIGHTHOUSE_SAFE_ACCOUNT_ASSERTIONS = "k5umSU2R1ddQfQujicJX9";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export const PAYMENT_KIND = Object.freeze({
  REWARD: "reward", SUPPORT: "support", WIRE_SUPPORT: "wire_support",
});
export const PAYMENT_EVENT = Object.freeze({
  reward: "REWARD_PAYMENT_CONFIRMED",
  support: "SUPPORT_PAYMENT_CONFIRMED",
  wire_support: "SUPPORT_PAYMENT_CONFIRMED",
});
export const PAYMENT_MAX_RECIPIENTS = 4;
export const PAYMENT_MAX_LAMPORTS = 100_000_000_000n; // 100 SOL per intent.
export const PAYMENT_MAX_NETWORK_FEE_LAMPORTS = 10_000_000n; // 0.01 SOL.
export const SOLANA_TRANSACTION_MAX_BYTES = 1232;
export const SOLANA_MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

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
  const kind = requireText(intent?.payment_kind, "payment_kind", /^(reward|support|wire_support)$/, 16);
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
  return canonicalOsi2Envelope({
    purpose: event, target_type: targetType, target_ref: targetRef,
    actor_wallet: payer, actor_role: role, decision, nonce,
    payload_hash: hash, issued_at: issuedAt,
  }, "v1_issued");
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

export function decodeBase58(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_400) {
    throw new TypeError("base58 value is invalid");
  }
  const bytes = [0];
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) throw new TypeError("base58 value is invalid");
    let carry = digit;
    for (let index = 0; index < bytes.length; index++) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let index = 0; index < value.length - 1 && value[index] === "1"; index++) {
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

export function encodeBase58(input) {
  const source = input instanceof Uint8Array ? input : new Uint8Array(input ?? []);
  if (source.length < 1 || source.length > 1_024) {
    throw new TypeError("base58 bytes are invalid");
  }
  const digits = [0];
  for (const byte of source) {
    let carry = byte;
    for (let index = 0; index < digits.length; index++) {
      carry += digits[index] << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let result = "";
  for (let index = 0; index < source.length - 1 && source[index] === 0; index++) {
    result += "1";
  }
  for (let index = digits.length - 1; index >= 0; index--) {
    result += BASE58_ALPHABET[digits[index]];
  }
  return result;
}

export function validateSolanaPayReference(value) {
  const reference = requireText(value, "solana_pay_reference", WALLET, 44);
  if (decodeBase58(reference).length !== 32) {
    throw new TypeError("solana_pay_reference is invalid");
  }
  return reference;
}

function readUnsignedLe(bytes, offset, length) {
  if (offset < 0 || length < 1 || offset + length > bytes.length) {
    throw new TypeError("instruction data is truncated");
  }
  let value = 0n;
  for (let index = length - 1; index >= 0; index--) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  return value;
}

function topLevelInstruction(instruction) {
  return instruction?.stackHeight == null || instruction.stackHeight === 1;
}

function validateComputeBudgetInstruction(instruction, seenDiscriminators) {
  if (!topLevelInstruction(instruction)
      || !Array.isArray(instruction?.accounts)
      || instruction.accounts.length !== 0
      || typeof instruction?.parsed !== "undefined") {
    return false;
  }
  let bytes;
  try {
    bytes = decodeBase58(instruction.data);
  } catch {
    return false;
  }
  const discriminator = bytes[0];
  if (seenDiscriminators.has(discriminator)) return false;
  seenDiscriminators.add(discriminator);
  if (discriminator === 1 && bytes.length === 5) {
    const heapBytes = readUnsignedLe(bytes, 1, 4);
    return heapBytes >= 32_768n && heapBytes <= 262_144n && heapBytes % 1_024n === 0n;
  }
  if (discriminator === 2 && bytes.length === 5) {
    const unitLimit = readUnsignedLe(bytes, 1, 4);
    return unitLimit >= 1n && unitLimit <= 1_400_000n;
  }
  if (discriminator === 3 && bytes.length === 9) {
    readUnsignedLe(bytes, 1, 8);
    return true;
  }
  if (discriminator === 4 && bytes.length === 5) {
    const loadedDataLimit = readUnsignedLe(bytes, 1, 4);
    return loadedDataLimit >= 1n && loadedDataLimit <= 67_108_864n;
  }
  return false;
}

// Phantom may append a Lighthouse assertion after the wallet has approved the
// transaction. OSI accepts only the audited, read-only assertion used by the
// production fixture: the payer must be a zero-data System-owned account.
// Every other Lighthouse variant fails closed.
function validateLighthouseInstruction(instruction, payer) {
  return topLevelInstruction(instruction)
    && Array.isArray(instruction?.accounts)
    && instruction.accounts.length === 1
    && String(instruction.accounts[0]) === payer
    && instruction.data === LIGHTHOUSE_SAFE_ACCOUNT_ASSERTIONS
    && typeof instruction?.parsed === "undefined";
}

function signerAccountKeys(message) {
  return (message?.accountKeys ?? []).filter((entry) => (
    typeof entry === "object" && entry?.signer === true
  )).map(accountKeyValue);
}

function parsedTransfer(instruction) {
  const programId = String(instruction?.programId ?? "");
  if (!topLevelInstruction(instruction)
      || programId !== SYSTEM_PROGRAM
      || instruction?.parsed?.type !== "transfer") return null;
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
  if (!topLevelInstruction(instruction) || programId !== MEMO_PROGRAM) return null;
  if (typeof instruction.parsed === "string") return instruction.parsed;
  if (typeof instruction.parsed?.info === "string") return instruction.parsed.info;
  return null;
}

function compiledInstructionProgram(message, instruction) {
  const index = Number(instruction?.programIdIndex);
  if (!Number.isSafeInteger(index) || index < 0) return "";
  return accountKeyValue(message?.accountKeys?.[index]);
}

function compiledInstructionAccounts(instruction) {
  if (!Array.isArray(instruction?.accounts)
      || instruction.accounts.some((value) => !Number.isSafeInteger(Number(value)))) {
    return null;
  }
  return instruction.accounts.map(Number);
}

function failSolanaPayReference(reason) {
  return { ok: false, state: "verification_failed", reason };
}

// Solana Pay transfer requests bind a reference account to the exact System
// transfer instruction. Parsed RPC output does not retain enough account-order
// detail to prove that binding, so this validator runs against a second raw
// transaction response before the normal finalized-payment validator.
export function validateSolanaPayReferenceTransaction(transaction, intent) {
  let reference;
  let payer;
  let normalized;
  let expectedMemo;
  try {
    reference = validateSolanaPayReference(intent?.solana_pay_reference);
    payer = requireText(intent?.payer_wallet, "payer_wallet", WALLET, 44);
    normalized = normalizeRecipientManifest(intent?.recipient_manifest, payer);
    expectedMemo = canonicalPaymentMemo(intent);
  } catch {
    return failSolanaPayReference("solana_pay_binding_invalid");
  }
  if (normalized.manifest.length !== 1) {
    return failSolanaPayReference("solana_pay_single_recipient_required");
  }
  const message = transaction?.transaction?.message;
  const keys = message?.accountKeys;
  const header = message?.header;
  const instructions = message?.instructions;
  if (!Array.isArray(keys) || !Array.isArray(instructions) || !header
      || keys.some((key) => typeof key !== "string" || !WALLET.test(key))
      || new Set(keys).size !== keys.length) {
    return failSolanaPayReference("solana_pay_account_metadata_invalid");
  }
  const payerIndex = keys.indexOf(payer);
  const recipientIndex = keys.indexOf(normalized.manifest[0].wallet);
  const referenceIndex = keys.indexOf(reference);
  const requiredSignatures = Number(header.numRequiredSignatures);
  const readonlyUnsigned = Number(header.numReadonlyUnsignedAccounts);
  if (payerIndex !== 0 || recipientIndex < 1 || referenceIndex < 1
      || !Number.isSafeInteger(requiredSignatures) || requiredSignatures !== 1
      || !Number.isSafeInteger(readonlyUnsigned) || readonlyUnsigned < 1
      || referenceIndex < requiredSignatures
      || referenceIndex < keys.length - readonlyUnsigned) {
    return failSolanaPayReference("solana_pay_reference_not_readonly");
  }

  let cursor = 0;
  const seenComputeDiscriminators = new Set();
  while (cursor < instructions.length
      && compiledInstructionProgram(message, instructions[cursor]) === COMPUTE_BUDGET_PROGRAM) {
    const accounts = compiledInstructionAccounts(instructions[cursor]);
    const normalizedInstruction = {
      accounts,
      data: instructions[cursor].data,
      stackHeight: null,
    };
    if (!accounts || !validateComputeBudgetInstruction(normalizedInstruction, seenComputeDiscriminators)) {
      return failSolanaPayReference("invalid_compute_budget_instruction");
    }
    cursor++;
  }

  const memoInstruction = instructions[cursor++];
  const memoAccounts = compiledInstructionAccounts(memoInstruction);
  if (compiledInstructionProgram(message, memoInstruction) !== MEMO_PROGRAM
      || !memoAccounts
      || !(memoAccounts.length === 0
        || (memoAccounts.length === 1 && memoAccounts[0] === payerIndex))) {
    return failSolanaPayReference("solana_pay_memo_position_invalid");
  }
  let memoText = "";
  try {
    memoText = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase58(memoInstruction.data));
  } catch {
    return failSolanaPayReference("solana_pay_memo_invalid");
  }
  if (memoText !== expectedMemo) {
    return failSolanaPayReference("memo_mismatch");
  }

  const transferInstruction = instructions[cursor++];
  const transferAccounts = compiledInstructionAccounts(transferInstruction);
  let transferData;
  try {
    transferData = decodeBase58(transferInstruction?.data);
  } catch {
    return failSolanaPayReference("solana_pay_transfer_invalid");
  }
  if (compiledInstructionProgram(message, transferInstruction) !== SYSTEM_PROGRAM
      || !transferAccounts
      || transferAccounts.length !== 3
      || transferAccounts[0] !== payerIndex
      || transferAccounts[1] !== recipientIndex
      || transferAccounts[2] !== referenceIndex
      || transferData.length !== 12
      || readUnsignedLe(transferData, 0, 4) !== 2n
      || readUnsignedLe(transferData, 4, 8) !== BigInt(normalized.manifest[0].amount_lamports)) {
    return failSolanaPayReference("solana_pay_transfer_binding_mismatch");
  }

  if (cursor < instructions.length) {
    const lighthouse = instructions[cursor++];
    const lighthouseAccounts = compiledInstructionAccounts(lighthouse);
    if (compiledInstructionProgram(message, lighthouse) !== LIGHTHOUSE_PROGRAM
        || !lighthouseAccounts || lighthouseAccounts.length !== 1
        || lighthouseAccounts[0] !== payerIndex
        || lighthouse.data !== LIGHTHOUSE_SAFE_ACCOUNT_ASSERTIONS) {
      return failSolanaPayReference("unsafe_lighthouse_instruction");
    }
  }
  if (cursor !== instructions.length) {
    return failSolanaPayReference("unexpected_instruction");
  }
  const referenceUses = instructions.reduce((count, instruction) => {
    const accounts = compiledInstructionAccounts(instruction);
    return count + (accounts ? accounts.filter((index) => index === referenceIndex).length : 0);
  }, 0);
  if (referenceUses !== 1) {
    return failSolanaPayReference("solana_pay_reference_reused");
  }
  return {
    ok: true,
    state: "reference_bound",
    solana_pay_reference: reference,
    recipient_wallet: normalized.manifest[0].wallet,
    amount_lamports: normalized.manifest[0].amount_lamports,
    memo: expectedMemo,
  };
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
  if (!Array.isArray(keys) || keys.length < 3 || keys.some((entry) => (
    !entry || typeof entry !== "object" || entry.source !== "transaction"
    || typeof entry.signer !== "boolean" || typeof entry.writable !== "boolean"
    || !WALLET.test(accountKeyValue(entry))
  ))) {
    return { ok: false, state: "verification_failed", reason: "account_metadata_invalid" };
  }
  const keyValues = keys.map(accountKeyValue);
  if (new Set(keyValues).size !== keyValues.length) {
    return { ok: false, state: "verification_failed", reason: "duplicate_account_key" };
  }
  const expectedWritable = new Set([
    payer,
    ...normalized.manifest.map((entry) => entry.wallet),
  ]);
  for (const key of keys) {
    if (key.writable !== expectedWritable.has(accountKeyValue(key))) {
      return { ok: false, state: "verification_failed", reason: "writable_account_mismatch" };
    }
  }
  const transfers = [];
  const memos = [];
  const computeBudgetDiscriminators = new Set();
  let lighthouseCount = 0;
  for (const instruction of message?.instructions ?? []) {
    const transfer = parsedTransfer(instruction);
    if (transfer) { transfers.push(transfer); continue; }
    const memo = parsedMemo(instruction);
    if (memo != null) { memos.push(memo); continue; }
    const programId = String(instruction?.programId ?? "");
    if (programId === COMPUTE_BUDGET_PROGRAM) {
      if (!validateComputeBudgetInstruction(instruction, computeBudgetDiscriminators)) {
        return { ok: false, state: "verification_failed", reason: "invalid_compute_budget_instruction" };
      }
      continue;
    }
    if (programId === LIGHTHOUSE_PROGRAM) {
      lighthouseCount++;
      if (lighthouseCount !== 1 || !validateLighthouseInstruction(instruction, payer)) {
        return { ok: false, state: "verification_failed", reason: "unsafe_lighthouse_instruction" };
      }
      continue;
    }
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
  if (!Number.isSafeInteger(Number(signatureStatus?.slot)) || Number(signatureStatus.slot) !== slot) {
    return { ok: false, state: "verification_failed", reason: "slot_mismatch" };
  }
  const meta = transaction?.meta;
  if (!Array.isArray(meta?.innerInstructions) || meta.innerInstructions.length !== 0) {
    return { ok: false, state: "verification_failed", reason: "inner_instruction_present" };
  }
  if (!Array.isArray(meta?.preTokenBalances) || meta.preTokenBalances.length !== 0
      || !Array.isArray(meta?.postTokenBalances) || meta.postTokenBalances.length !== 0) {
    return { ok: false, state: "verification_failed", reason: "token_balance_change" };
  }
  if (!Array.isArray(meta?.rewards) || meta.rewards.length !== 0) {
    return { ok: false, state: "verification_failed", reason: "unexpected_reward_balance_change" };
  }
  if (Array.isArray(meta?.loadedAddresses?.writable) && meta.loadedAddresses.writable.length > 0
      || Array.isArray(meta?.loadedAddresses?.readonly) && meta.loadedAddresses.readonly.length > 0) {
    return { ok: false, state: "verification_failed", reason: "loaded_address_present" };
  }
  const preBalances = meta?.preBalances;
  const postBalances = meta?.postBalances;
  if (!Array.isArray(preBalances) || !Array.isArray(postBalances)
      || preBalances.length !== keys.length || postBalances.length !== keys.length
      || preBalances.some((value) => !Number.isSafeInteger(value) || value < 0)
      || postBalances.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return { ok: false, state: "verification_failed", reason: "balance_metadata_invalid" };
  }
  const fee = Number(meta?.fee);
  if (!Number.isSafeInteger(fee) || fee < 0 || BigInt(fee) > PAYMENT_MAX_NETWORK_FEE_LAMPORTS) {
    return { ok: false, state: "verification_failed", reason: "fee_out_of_range" };
  }
  const expectedRecipientAmount = new Map(normalized.manifest.map((entry) => (
    [entry.wallet, BigInt(entry.amount_lamports)]
  )));
  for (let index = 0; index < keys.length; index++) {
    const key = keyValues[index];
    const before = BigInt(preBalances[index]);
    const after = BigInt(postBalances[index]);
    if (key === payer) {
      if (before - after !== BigInt(normalized.total_lamports) + BigInt(fee)) {
        return { ok: false, state: "verification_failed", reason: "payer_balance_mismatch" };
      }
    } else if (expectedRecipientAmount.has(key)) {
      if (after - before !== expectedRecipientAmount.get(key)) {
        return { ok: false, state: "verification_failed", reason: "recipient_balance_mismatch" };
      }
    } else if (before !== after) {
      return { ok: false, state: "verification_failed", reason: "unexpected_balance_change" };
    }
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
    fee_lamports: String(fee),
    memo: expectedMemo,
    recipient_manifest: normalized.manifest,
    total_lamports: normalized.total_lamports,
  };
}

export function paymentProgramIds() {
  return {
    system: SYSTEM_PROGRAM,
    memo: MEMO_PROGRAM,
    compute_budget: COMPUTE_BUDGET_PROGRAM,
    lighthouse: LIGHTHOUSE_PROGRAM,
  };
}
