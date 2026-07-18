import assert from "node:assert/strict";
import fs from "node:fs";
import {
  PAYMENT_MAX_RECIPIENTS,
  PAYMENT_KIND,
  SOLANA_TRANSACTION_MAX_BYTES,
  canonicalPaymentMemo,
  estimatePaymentTransactionBytes,
  formatLamportsAsSol,
  isSolanaMainnetGenesis,
  normalizePaymentTargetRef,
  normalizeRecipientManifest,
  parseSolToLamports,
  recipientManifestHash,
  validateFinalizedPaymentTransaction,
} from "../supabase/functions/_shared/osi-v2-payment-core.mjs";

const edge = fs.readFileSync(new URL("../supabase/functions/osi-v2-payment/index.ts", import.meta.url), "utf8");
const phase2 = fs.readFileSync(new URL("../supabase/migrations/20260718130000_osi_v2_wire_phase2.sql", import.meta.url), "utf8");

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
    meta: { err: null, fee: 5000 },
    transaction: {
      signatures: [txSig],
      message: {
        accountKeys: [
          { pubkey: payer, signer: true, writable: true },
          { pubkey: author, signer: false, writable: true },
          { pubkey: reviewer, signer: false, writable: true },
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
  assert.equal(isSolanaMainnetGenesis("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), true);
  assert.equal(isSolanaMainnetGenesis("EtWTRABZaYq6iMfeYKouRu166VU2xqa1"), false);
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
ok("finalized exact transfer manifest verifies", () => {
  const result = validateFinalizedPaymentTransaction(
    transaction(), { err: null, confirmationStatus: "finalized" }, intent, txSig,
  );
  assert.equal(result.ok, true);
  assert.equal(result.total_lamports, "150000000");
  assert.equal(result.finality, "finalized");
});
ok("confirmed but not finalized is awaiting and not paid", () => {
  const result = validateFinalizedPaymentTransaction(
    transaction(), { err: null, confirmationStatus: "confirmed" }, intent, txSig,
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
    tx, { err: null, confirmationStatus: "finalized" }, intent, txSig,
  ).reason, "wrong_fee_payer");
});
ok("extra signer is rejected", () => {
  const tx = transaction(); tx.transaction.message.accountKeys[1].signer = true;
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized" }, intent, txSig,
  ).reason, "unexpected_signer");
});
ok("wrong amount is rejected", () => {
  const tx = transaction(); tx.transaction.message.instructions[0].parsed.info.lamports = 100000001;
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized" }, intent, txSig,
  ).reason, "transfer_manifest_mismatch");
});
ok("wrong recipient is rejected", () => {
  const tx = transaction(); tx.transaction.message.instructions[0].parsed.info.destination = reviewer;
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized" }, intent, txSig,
  ).reason, "transfer_manifest_mismatch");
});
ok("missing Memo is rejected", () => {
  const tx = transaction(); tx.transaction.message.instructions.pop();
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized" }, intent, txSig,
  ).reason, "memo_mismatch");
});
ok("changed Memo payload is rejected", () => {
  const tx = transaction(); tx.transaction.message.instructions[2].parsed += "x";
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized" }, intent, txSig,
  ).reason, "memo_mismatch");
});
ok("extra SOL transfer instruction is rejected", () => {
  const tx = transaction(); tx.transaction.message.instructions.unshift({
    program: "system", programId: "11111111111111111111111111111111",
    parsed: { type: "transfer", info: { source: payer, destination: author, lamports: 1 } },
  });
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized" }, intent, txSig,
  ).reason, "transfer_count_mismatch");
});
ok("unexpected program instruction is rejected", () => {
  const tx = transaction(); tx.transaction.message.instructions.unshift({ program: "stake", parsed: {} });
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized" }, intent, txSig,
  ).reason, "unexpected_instruction");
});
ok("spoofed System label with a different program id is rejected", () => {
  const tx = transaction();
  tx.transaction.message.instructions[0] = {
    ...tx.transaction.message.instructions[0], program: "system", programId: author,
  };
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized" }, intent, txSig,
  ).reason, "unexpected_instruction");
});
ok("spoofed Memo label with a different program id is rejected", () => {
  const tx = transaction();
  tx.transaction.message.instructions[2] = {
    ...tx.transaction.message.instructions[2], program: "spl-memo", programId: author,
  };
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized" }, intent, txSig,
  ).reason, "unexpected_instruction");
});
ok("stale block time is rejected", () => {
  const tx = transaction({ blockTime: intent.expires_at + 121 });
  assert.equal(validateFinalizedPaymentTransaction(
    tx, { err: null, confirmationStatus: "finalized" }, intent, txSig,
  ).reason, "transaction_not_fresh");
});
ok("signature mismatch is rejected", () => {
  assert.equal(validateFinalizedPaymentTransaction(
    transaction(), { err: null, confirmationStatus: "finalized" }, intent, "3".repeat(64),
  ).reason, "signature_mismatch");
});
ok("Edge RPC path verifies the canonical mainnet genesis before any payment result", () => {
  assert.ok(edge.includes('method: "getGenesisHash"'));
  assert.ok(edge.includes("isSolanaMainnetGenesis"));
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
});
ok("Wire support uses the server-derived specialized intent before shared finality commit", () => {
  assert.ok(edge.includes('admin.rpc("osi_v2_prepare_wire_support"'));
  assert.ok(edge.includes('"osi_v2_record_wire_support_submission"'));
  assert.ok(edge.includes('admin.rpc("osi_v2_commit_payment"'));
});
ok("confirmed support rows require exact server-verified finalized mainnet receipts", () => {
  assert.ok(phase2.includes("receipt.event_version is distinct from 'OSI2'"));
  assert.ok(phase2.includes("receipt.proof_type is distinct from 'solana_memo'"));
  assert.ok(phase2.includes("receipt.server_verified is distinct from true"));
  assert.ok(phase2.includes("receipt.verification_metadata->>'finality' is distinct from 'finalized'"));
});

if (!process.exitCode) console.log(`OK (${passed} assertions passed)`);
