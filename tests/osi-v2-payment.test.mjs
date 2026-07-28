import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  PAYMENT_MAX_NETWORK_FEE_LAMPORTS,
  PAYMENT_MAX_RECIPIENTS,
  PAYMENT_KIND,
  SOLANA_TRANSACTION_MAX_BYTES,
  canonicalPaymentMemo,
  decodeBase58,
  encodeBase58,
  estimatePaymentTransactionBytes,
  formatLamportsAsSol,
  isSolanaMainnetGenesis,
  normalizePaymentTargetRef,
  normalizeRecipientManifest,
  parseSolToLamports,
  recipientManifestHash,
  validateFinalizedPaymentTransaction,
  validateSolanaPayReference,
  validateSolanaPayReferenceTransaction,
} from "../supabase/functions/_shared/osi-v2-payment-core.mjs";

const edge = fs.readFileSync(new URL("../supabase/functions/osi-v2-payment/index.ts", import.meta.url), "utf8");
const phase2 = fs.readFileSync(new URL("../supabase/migrations/20260718130000_osi_v2_wire_phase2.sql", import.meta.url), "utf8");
const launchMigration = fs.readFileSync(new URL("../supabase/migrations/20260728170000_osi_v2_solana_pay_and_maintainer_ai_pack.sql", import.meta.url), "utf8");
const mainnetFixture = JSON.parse(fs.readFileSync(
  new URL("./fixtures/osi-v2-mainnet-support-payment.json", import.meta.url),
  "utf8",
));
const solanaPayBrowserSource = fs.readFileSync(
  new URL("../assets/js/73-solana-pay.js", import.meta.url),
  "utf8",
);

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; }
  catch (error) { console.error("FAIL", name, error.message); process.exitCode = 1; }
}

const payer = "11111111111111111111111111111112";
const author = "11111111111111111111111111111113";
const reviewer = "11111111111111111111111111111114";
const txSig = "2".repeat(64);
const manifest = [
  { wallet: author, amount_lamports: "100000000", recipient_type: "report_author", target_ref: "OSI-RV-1234567890ABCDEF" },
  { wallet: reviewer, amount_lamports: "50000000", recipient_type: "counted_reviewer", target_ref: "OSI-RV-1234567890ABCDEF" },
];
const intent = {
  payment_kind: "support",
  target_public_ref: "OSI-RV-1234567890ABCDEF",
  payer_wallet: payer,
  actor_role: "wallet",
  nonce: "n".repeat(32),
  payload_hash: "a".repeat(64),
  issued_at: 1_800_000_000,
  expires_at: 1_800_000_180,
  recipient_manifest: manifest,
};
const memo = canonicalPaymentMemo(intent);
const solanaPayReference = encodeBase58(new Uint8Array(32).fill(7));

function unsignedLe(value, length) {
  let remaining = BigInt(value);
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = Number(remaining & 255n);
    remaining >>= 8n;
  }
  return bytes;
}

const solanaPayIntent = {
  ...intent,
  recipient_manifest: [manifest[0]],
  solana_pay_reference: solanaPayReference,
};
const solanaPayMemo = canonicalPaymentMemo(solanaPayIntent);

function rawSolanaPayTransaction() {
  const transferData = new Uint8Array(12);
  transferData.set(unsignedLe(2, 4), 0);
  transferData.set(unsignedLe(100000000, 8), 4);
  return {
    transaction: {
      message: {
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 3,
        },
        accountKeys: [
          payer,
          author,
          "11111111111111111111111111111111",
          "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
          solanaPayReference,
        ],
        instructions: [
          { programIdIndex: 3, accounts: [], data: encodeBase58(new TextEncoder().encode(solanaPayMemo)) },
          { programIdIndex: 2, accounts: [0, 1, 4], data: encodeBase58(transferData) },
        ],
      },
    },
  };
}

function transaction(overrides = {}) {
  const instructions = [
    {
      program: "system", programId: "11111111111111111111111111111111",
      parsed: { type: "transfer", info: { source: payer, destination: author, lamports: 100000000 } },
    },
    {
      program: "system", programId: "11111111111111111111111111111111",
      parsed: { type: "transfer", info: { source: payer, destination: reviewer, lamports: 50000000 } },
    },
    { program: "spl-memo", programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", parsed: memo },
  ];
  return {
    slot: 55,
    blockTime: 1_800_000_100,
    meta: {
      err: null,
      fee: 5000,
      innerInstructions: [],
      preBalances: [200000000, 0, 0, 1, 1],
      postBalances: [49995000, 100000000, 50000000, 1, 1],
      preTokenBalances: [],
      postTokenBalances: [],
      rewards: [],
    },
    transaction: {
      signatures: [txSig],
      message: {
        accountKeys: [
          { pubkey: payer, signer: true, source: "transaction", writable: true },
          { pubkey: author, signer: false, source: "transaction", writable: true },
          { pubkey: reviewer, signer: false, source: "transaction", writable: true },
          { pubkey: "11111111111111111111111111111111", signer: false, source: "transaction", writable: false },
          { pubkey: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", signer: false, source: "transaction", writable: false },
        ],
        instructions,
      },
    },
    ...overrides,
  };
}

ok("exact 9-decimal SOL converts without float math", () => {
  assert.equal(parseSolToLamports("1.000000001"), 1_000_000_001n);
  assert.equal(parseSolToLamports("0.000000001"), 1n);
  assert.equal(formatLamportsAsSol("1000000001"), "1.000000001");
});
ok("only the canonical Solana mainnet genesis is accepted", () => {
  assert.equal(isSolanaMainnetGenesis("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"), true);
  assert.equal(isSolanaMainnetGenesis("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), false);
  assert.equal(isSolanaMainnetGenesis("EtWTRABZaYq6iMfeYKouRu166VU2xqa1"), false);
});
ok("Solana Pay references round-trip as exact random 32-byte values", () => {
  assert.equal(validateSolanaPayReference(solanaPayReference), solanaPayReference);
  assert.deepEqual(decodeBase58(solanaPayReference), new Uint8Array(32).fill(7));
  assert.throws(() => validateSolanaPayReference("1".repeat(31)));
});
ok("official Solana Pay URL encodes and parses the exact server intent", () => {
  const window = {};
  vm.runInNewContext(solanaPayBrowserSource, {
    window,
    URLSearchParams,
  });
  const prepared = {
    network: "mainnet-beta",
    nonce: "n".repeat(32),
    target_public_ref: "OSI-RV-1234567890ABCDEF",
    memo: "OSI2|SUPPORT_PAYMENT_CONFIRMED|note=space & exact",
    recipient_manifest: [{
      wallet: author,
      amount_sol: "0.100000000",
    }],
    solana_pay: {
      enabled: true,
      reference: solanaPayReference,
      expires_at: "2030-01-01T00:00:00Z",
    },
  };
  const url = window.osiSolanaPay.buildUrl(prepared);
  const parsed = new URL(url.replace(/^solana:/, "https://solana.invalid/"));
  assert.equal(parsed.pathname, `/${author}`);
  assert.equal(parsed.searchParams.get("amount"), "0.100000000");
  assert.equal(parsed.searchParams.get("reference"), solanaPayReference);
  assert.equal(parsed.searchParams.get("memo"), prepared.memo);
  assert.equal(parsed.searchParams.get("label"), "Open Solana Intelligence");
  assert.match(parsed.searchParams.get("message"), /OSI-RV-1234567890ABCDEF/);
});
ok("Solana Pay URL builder rejects non-mainnet, multi-recipient and altered reference inputs", () => {
  const window = {};
  vm.runInNewContext(solanaPayBrowserSource, { window, URLSearchParams });
  const prepared = {
    network: "mainnet-beta",
    nonce: "n".repeat(32),
    target_public_ref: "OSI-RV-1234567890ABCDEF",
    memo: solanaPayMemo,
    recipient_manifest: [{ wallet: author, amount_sol: "0.1" }],
    solana_pay: { enabled: true, reference: solanaPayReference },
  };
  assert.throws(() => window.osiSolanaPay.buildUrl({ ...prepared, network: "devnet" }));
  assert.throws(() => window.osiSolanaPay.buildUrl({
    ...prepared,
    recipient_manifest: [...prepared.recipient_manifest, { wallet: reviewer, amount_sol: "0.1" }],
  }));
  assert.throws(() => window.osiSolanaPay.buildUrl({
    ...prepared,
    solana_pay: { enabled: true, reference: "1".repeat(31) },
  }));
});
ok("payment target normalization accepts OSI refs and analyst wallets", () => {
  assert.equal(normalizePaymentTargetRef("OSI-CASE-123456"), "OSI-CASE-123456");
  assert.equal(normalizePaymentTargetRef(author), author);
});
ok("payment target normalization accepts an exact Wire version reference", () => {
  assert.equal(normalizePaymentTargetRef("OSI-WV-1234567890ABCDEF"), "OSI-WV-1234567890ABCDEF");
  assert.equal(PAYMENT_KIND.WIRE_SUPPORT, "wire_support");
});
ok("payment target normalization rejects mixed or arbitrary targets", () => {
  assert.throws(() => normalizePaymentTargetRef("OSI-private/ref"));
  assert.throws(() => normalizePaymentTargetRef("not-a-target"));
});
for (const bad of ["1e-3", "1.0000000001", "0", "-1", "+1", ".1", "01", "100.000000001"]) {
  ok(`reject decimal ${bad}`, () => assert.throws(() => parseSolToLamports(bad)));
}
ok("bounded server manifest preserves exact order and total", () => {
  const value = normalizeRecipientManifest(manifest, payer);
  assert.equal(value.total_lamports, "150000000");
  assert.deepEqual(value.manifest.map((row) => row.ordinal), [1, 2]);
});
ok("self-support is rejected", () => assert.throws(() => normalizeRecipientManifest([
  { ...manifest[0], wallet: payer },
], payer)));
ok("duplicate recipients are rejected", () => assert.throws(() => normalizeRecipientManifest([
  manifest[0], { ...manifest[1], wallet: author },
], payer)));
ok("recipient count is bounded", () => assert.throws(() => normalizeRecipientManifest(
  Array.from({ length: PAYMENT_MAX_RECIPIENTS + 1 }, (_, index) => ({
    ...manifest[0], wallet: `111111111111111111111111111111${20 + index}`,
  })), payer,
)));
ok("four-recipient transaction estimate stays below 1232 bytes", () => {
  assert.ok(estimatePaymentTransactionBytes(4, memo) < SOLANA_TRANSACTION_MAX_BYTES);
});
ok("byte estimator matches pinned web3.js legacy serialization fixtures", () => {
  assert.equal(estimatePaymentTransactionBytes(2, memo), 537);
  assert.equal(estimatePaymentTransactionBytes(4, memo), 635);
});
ok("five-recipient estimate is rejected by the bounded policy", () => {
  assert.throws(() => estimatePaymentTransactionBytes(5, memo));
});
const baseManifestHash = await recipientManifestHash(manifest);
const changedManifestHash = await recipientManifestHash([
  { ...manifest[0], amount_lamports: "100000001" }, manifest[1],
]);
ok("manifest hash changes with a recipient amount", () => {
  assert.notEqual(baseManifestHash, changedManifestHash);
});
ok("canonical payment Memo binds purpose target actor nonce and payload", () => {
  assert.match(memo, /^OSI2\|1\|SUPPORT_PAYMENT_CONFIRMED\|t=support\|/);
  assert.ok(memo.includes(`a=${payer}`));
  assert.ok(memo.includes(`n=${"n".repeat(32)}`));
  assert.ok(memo.includes(`h=${"a".repeat(64)}`));
});
ok("exact single-recipient Solana Pay reference, Memo, transfer and amount bind", () => {
  const result = validateSolanaPayReferenceTransaction(
    rawSolanaPayTransaction(), solanaPayIntent,
  );
  assert.equal(result.ok, true);
  assert.equal(result.solana_pay_reference, solanaPayReference);
  assert.equal(result.amount_lamports, "100000000");
});
ok("Solana Pay requires one exact recipient", () => {
  assert.equal(validateSolanaPayReferenceTransaction(
    rawSolanaPayTransaction(), { ...solanaPayIntent, recipient_manifest: manifest },
  ).reason, "solana_pay_single_recipient_required");
});
ok("Solana Pay rejects a writable reference", () => {
  const tx = rawSolanaPayTransaction();
  tx.transaction.message.header.numReadonlyUnsignedAccounts = 0;
  assert.equal(validateSolanaPayReferenceTransaction(
    tx, solanaPayIntent,
  ).reason, "solana_pay_reference_not_readonly");
});
ok("Solana Pay rejects wrong reference, amount and Memo order", () => {
  const wrongReference = rawSolanaPayTransaction();
  wrongReference.transaction.message.instructions[1].accounts[2] = 3;
  assert.equal(validateSolanaPayReferenceTransaction(
    wrongReference, solanaPayIntent,
  ).reason, "solana_pay_transfer_binding_mismatch");

  const wrongAmount = rawSolanaPayTransaction();
  const bytes = decodeBase58(wrongAmount.transaction.message.instructions[1].data);
  bytes[4]++;
  wrongAmount.transaction.message.instructions[1].data = encodeBase58(bytes);
  assert.equal(validateSolanaPayReferenceTransaction(
    wrongAmount, solanaPayIntent,
  ).reason, "solana_pay_transfer_binding_mismatch");

  const wrongOrder = rawSolanaPayTransaction();
  wrongOrder.transaction.message.instructions.reverse();
  assert.equal(validateSolanaPayReferenceTransaction(
    wrongOrder, solanaPayIntent,
  ).reason, "solana_pay_memo_position_invalid");
});
ok("Solana Pay rejects extra instructions and reference reuse", () => {
  const extra = rawSolanaPayTransaction();
  extra.transaction.message.instructions.push({
    programIdIndex: 2, accounts: [0, 1], data: extra.transaction.message.instructions[1].data,
  });
  assert.equal(validateSolanaPayReferenceTransaction(
    extra, solanaPayIntent,
  ).reason, "unsafe_lighthouse_instruction");

  const reused = rawSolanaPayTransaction();
  reused.transaction.message.instructions[0].accounts = [4];
  assert.equal(validateSolanaPayReferenceTransaction(
    reused, solanaPayIntent,
  ).ok, false);
});
ok("finalized exact transfer manifest verifies", () => {
  const result = validateFinalizedPaymentTransaction(
    transaction(), { err: null, confirmationStatus: "finalized", slot: 55 }, intent, txSig,
  );
  assert.equal(result.ok, true);
  assert.equal(result.total_lamports, "150000000");
  assert.equal(result.finality, "finalized");
});
ok("confirmed but not finalized is awaiting and not paid", () => {
  const result = validateFinalizedPaymentTransaction(
    transaction(), { err: null, confirmationStatus: "confirmed", slot: 55 }, intent, txSig,
  );
  assert.deepEqual({ ok: result.ok, state: result.state }, { ok: false, state: "awaiting_finality" });
});
ok("failed transaction is rejected", () => {
  const tx = transaction(); tx.meta.err = { InstructionError: [0, "Custom"] };
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "finalized" }, intent, txSig,
  ).reason, "transaction_failed");
});
ok("wrong fee payer is rejected", () => {
  const tx = transaction(); tx.transaction.message.accountKeys[0].pubkey = author;
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized", slot: 55 }, intent, txSig,
  ).reason, "wrong_fee_payer");
});
ok("extra signer is rejected", () => {
  const tx = transaction(); tx.transaction.message.accountKeys[1].signer = true;
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized", slot: 55 }, intent, txSig,
  ).reason, "unexpected_signer");
});
ok("wrong amount is rejected", () => {
  const tx = transaction(); tx.transaction.message.instructions[0].parsed.info.lamports = 100000001;
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized", slot: 55 }, intent, txSig,
  ).reason, "transfer_manifest_mismatch");
});
ok("wrong recipient is rejected", () => {
  const tx = transaction(); tx.transaction.message.instructions[0].parsed.info.destination = reviewer;
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized", slot: 55 }, intent, txSig,
  ).reason, "transfer_manifest_mismatch");
});
ok("missing Memo is rejected", () => {
  const tx = transaction(); tx.transaction.message.instructions.pop();
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized", slot: 55 }, intent, txSig,
  ).reason, "memo_mismatch");
});
ok("changed Memo payload is rejected", () => {
  const tx = transaction(); tx.transaction.message.instructions[2].parsed += "x";
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized", slot: 55 }, intent, txSig,
  ).reason, "memo_mismatch");
});
ok("extra SOL transfer instruction is rejected", () => {
  const tx = transaction(); tx.transaction.message.instructions.unshift({
    program: "system", programId: "11111111111111111111111111111111",
    parsed: { type: "transfer", info: { source: payer, destination: author, lamports: 1 } },
  });
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized", slot: 55 }, intent, txSig,
  ).reason, "transfer_count_mismatch");
});
ok("non-top-level transfer or Memo metadata is rejected", () => {
  const transferTx = transaction();
  transferTx.transaction.message.instructions[0].stackHeight = 2;
  assert.equal(validateFinalizedPaymentTransaction(
    transferTx, { err: null, confirmationStatus: "finalized", slot: 55 }, intent, txSig,
  ).reason, "unexpected_instruction");
  const memoTx = transaction();
  memoTx.transaction.message.instructions[2].stackHeight = 2;
  assert.equal(validateFinalizedPaymentTransaction(
    memoTx, { err: null, confirmationStatus: "finalized", slot: 55 }, intent, txSig,
  ).reason, "unexpected_instruction");
});
ok("unexpected program instruction is rejected", () => {
  const tx = transaction(); tx.transaction.message.instructions.unshift({ program: "stake", parsed: {} });
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized", slot: 55 }, intent, txSig,
  ).reason, "unexpected_instruction");
});
ok("spoofed System label with a different program id is rejected", () => {
  const tx = transaction();
  tx.transaction.message.instructions[0] = {
    ...tx.transaction.message.instructions[0], program: "system", programId: author,
  };
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized", slot: 55 }, intent, txSig,
  ).reason, "unexpected_instruction");
});
ok("spoofed Memo label with a different program id is rejected", () => {
  const tx = transaction();
  tx.transaction.message.instructions[2] = {
    ...tx.transaction.message.instructions[2], program: "spl-memo", programId: author,
  };
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized", slot: 55 }, intent, txSig,
  ).reason, "unexpected_instruction");
});
ok("stale block time is rejected", () => {
  const tx = transaction({ blockTime: intent.expires_at + 121 });
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized", slot: 55 }, intent, txSig,
  ).reason, "transaction_not_fresh");
});
ok("signature mismatch is rejected", () => {
  assert.equal(validateFinalizedPaymentTransaction(
    transaction(), { err: null, confirmationStatus: "finalized", slot: 55 }, intent, "3".repeat(64),
  ).reason, "signature_mismatch");
});
ok("immutable mainnet support fixture verifies without sending a new transaction", () => {
  assert.equal(mainnetFixture.fixture_version, 1);
  assert.equal(mainnetFixture.network, "solana-mainnet-beta");
  const result = validateFinalizedPaymentTransaction(
    mainnetFixture.transaction,
    mainnetFixture.signature_status,
    mainnetFixture.intent,
    mainnetFixture.tx_signature,
  );
  assert.equal(result.ok, true);
  assert.equal(result.fee_lamports, "80000");
  assert.equal(result.total_lamports, "1000000");
});
ok("network fee is bounded and included in the exact payer delta", () => {
  const tx = transaction();
  tx.meta.fee = Number(PAYMENT_MAX_NETWORK_FEE_LAMPORTS) + 1;
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized", slot: 55 }, intent, txSig,
  ).reason, "fee_out_of_range");
});
ok("unexpected writable account is rejected", () => {
  const tx = structuredClone(mainnetFixture.transaction);
  tx.transaction.message.accountKeys[2].writable = true;
  assert.equal(validateFinalizedPaymentTransaction(
    tx, mainnetFixture.signature_status, mainnetFixture.intent, mainnetFixture.tx_signature,
  ).reason, "writable_account_mismatch");
});
ok("recipient balance deviation is rejected even when instruction parsing matches", () => {
  const tx = structuredClone(mainnetFixture.transaction);
  tx.meta.postBalances[1]++;
  assert.equal(validateFinalizedPaymentTransaction(
    tx, mainnetFixture.signature_status, mainnetFixture.intent, mainnetFixture.tx_signature,
  ).reason, "recipient_balance_mismatch");
});
ok("payer balance deviation is rejected even when transfers match", () => {
  const tx = structuredClone(mainnetFixture.transaction);
  tx.meta.postBalances[0]++;
  assert.equal(validateFinalizedPaymentTransaction(
    tx, mainnetFixture.signature_status, mainnetFixture.intent, mainnetFixture.tx_signature,
  ).reason, "payer_balance_mismatch");
});
ok("token balance changes and CPI are rejected", () => {
  const tokenTx = structuredClone(mainnetFixture.transaction);
  tokenTx.meta.postTokenBalances.push({ mint: author });
  assert.equal(validateFinalizedPaymentTransaction(
    tokenTx, mainnetFixture.signature_status, mainnetFixture.intent, mainnetFixture.tx_signature,
  ).reason, "token_balance_change");
  const cpiTx = structuredClone(mainnetFixture.transaction);
  cpiTx.meta.innerInstructions.push({ index: 2, instructions: [] });
  assert.equal(validateFinalizedPaymentTransaction(
    cpiTx, mainnetFixture.signature_status, mainnetFixture.intent, mainnetFixture.tx_signature,
  ).reason, "inner_instruction_present");
});
ok("only bounded Compute Budget encodings are allowed", () => {
  const tx = structuredClone(mainnetFixture.transaction);
  tx.transaction.message.instructions[0].data = "11111";
  assert.equal(validateFinalizedPaymentTransaction(
    tx, mainnetFixture.signature_status, mainnetFixture.intent, mainnetFixture.tx_signature,
  ).reason, "invalid_compute_budget_instruction");
});
ok("only the exact read-only Lighthouse assertion is allowed", () => {
  const tx = structuredClone(mainnetFixture.transaction);
  tx.transaction.message.instructions.at(-1).data = "k5umSU2R1ddQfQujicJX8";
  assert.equal(validateFinalizedPaymentTransaction(
    tx, mainnetFixture.signature_status, mainnetFixture.intent, mainnetFixture.tx_signature,
  ).reason, "unsafe_lighthouse_instruction");
});
ok("status slot must bind to the exact finalized transaction", () => {
  assert.equal(validateFinalizedPaymentTransaction(
    mainnetFixture.transaction,
    { ...mainnetFixture.signature_status, slot: mainnetFixture.signature_status.slot + 1 },
    mainnetFixture.intent,
    mainnetFixture.tx_signature,
  ).reason, "slot_mismatch");
});
ok("Edge RPC path verifies the canonical mainnet genesis before any payment result", () => {
  assert.ok(edge.includes('method: "getGenesisHash"'));
  assert.ok(edge.includes("isSolanaMainnetGenesis"));
});
ok("Solana Pay polling uses one bound reference and the same finalized commit path", () => {
  assert.ok(edge.includes('method: "getSignaturesForAddress"'));
  assert.ok(edge.includes('validateSolanaPayReferenceTransaction'));
  assert.ok(edge.includes('}, false, "solana_pay")'));
  assert.ok(edge.includes('paymentMethod !== "solana_pay"'));
  assert.ok(edge.includes('solana_pay_reference_verified: paymentMethod === "solana_pay"'));
});
ok("Solana Pay database binding is service-only, single-recipient and replay-safe", () => {
  assert.ok(launchMigration.includes("osi_v2_bind_payment_reference"));
  assert.ok(launchMigration.includes("jsonb_array_length(bound.binding_context->'recipient_manifest') <> 1"));
  assert.ok(launchMigration.includes("osi_nonces_solana_pay_reference_unique"));
  assert.ok(launchMigration.includes("from public, anon, authenticated"));
  assert.ok(launchMigration.includes("to service_role"));
});
ok("definitive parser failures persist an unpaid server-derived failure state", () => {
  assert.ok(edge.includes('admin.rpc("osi_v2_record_payment_failure"'));
  assert.ok(edge.includes('state: "verification_failed"'));
  assert.ok(edge.includes("paid: false"));
});
ok("wallet-only or auth-only maintainer state grants no payment bypass", () => {
  assert.ok(!edge.includes("maintainer_access"));
  assert.ok(!edge.includes("fullMaintainer"));
  assert.ok(edge.includes('actor_role: issued.actor_role'));
});
ok("Wire support prepare and commit both require the payment and Wire gates", () => {
  assert.ok(edge.includes("Promise.all([\n    writesEnabled(), wireWritesEnabled(),"));
  assert.ok(edge.includes('error: "wire_and_payment_writes_required"'));
  assert.ok(edge.includes('binding_context?.payment_kind === "wire_support"'));
  assert.ok(edge.includes('error: "wire_writes_disabled"'));
  assert.ok(edge.includes('const recoveryEligible = bound.binding_context?.payment_kind !== "wire_support"'));
  assert.ok(edge.includes('error: "wire_payment_recovery_not_supported"'));
});
ok("Wire support uses the server-derived specialized intent before shared finality commit", () => {
  assert.ok(edge.includes('admin.rpc("osi_v2_prepare_wire_support"'));
  assert.ok(edge.includes('"osi_v2_record_wire_support_submission"'));
  assert.ok(edge.includes('const commitRpc = recovery ? "osi_v2_recover_payment" : "osi_v2_commit_payment"'));
  assert.ok(edge.includes('Date.now() > Date.parse(String(bound.expires_at)) + 120_000'));
});
ok("confirmed support rows require exact server-verified finalized mainnet receipts", () => {
  assert.ok(phase2.includes("receipt.event_version is distinct from 'OSI2'"));
  assert.ok(phase2.includes("receipt.proof_type is distinct from 'solana_memo'"));
  assert.ok(phase2.includes("receipt.server_verified is distinct from true"));
  assert.ok(phase2.includes("receipt.verification_metadata->>'finality' is distinct from 'finalized'"));
});

if (!process.exitCode) console.log(`OK (${passed} assertions passed)`);
