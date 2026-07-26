import * as core from "../supabase/functions/_shared/osi-v2-wire-core.mjs";
import * as reportCore from "../supabase/functions/_shared/osi-v2-report-core.mjs";

let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error("FAIL: " + name);
  passed += 1;
  console.log("PASS: " + name);
}

async function rejects(name, runner, pattern) {
  try {
    await runner();
  } catch (error) {
    ok(name, pattern.test(String(error?.message || error)));
    return;
  }
  throw new Error("FAIL: " + name);
}

const WALLET = "11111111111111111111111111111112";
const TX_SIG = "2".repeat(88);
const SEC_URL = "https://ir.hyperiondefi.com/sec-filings/all-sec-filings/content/0001104659-26-036286/hypd-20251231x10k.htm";
const validPayload = {
  title_public_safe: "Public filing and wallet correlation",
  content_public_safe: "Public corporate disclosures are compared with observable blockchain balances and transactions.",
  body_private: [
    "Hyperion DeFi, Inc. public SEC filing and public on-chain activity were compared.",
    "Official filing: " + SEC_URL,
    "Solana slot 435162475123456 and block height 361982475123456 were checked.",
    "Solana signature: " + TX_SIG,
    "Observed wallet: 0x14a2cf7a40DA8dC1ef904615c0234e6ffcA880a1",
    "Observed transaction: 0x5f056549ca0525ce568951929804f7d1412b48151af19d266a911b2fdb69e02e",
  ].join("\n"),
  uncertainties_private: "The evidence supports correlation but does not establish private-person identity or legal ownership.",
  revision_reason_code: null,
  evidence: [
    { kind: "wallet", ref: WALLET },
    { kind: "onchain_tx", ref: TX_SIG },
  ],
};

const normalized = await core.normalizeWirePayload(validPayload);
ok("Wire permits SEC accession numbers, public wallets, and transaction hashes",
  normalized.body_private.includes("0001104659-26-036286")
    && normalized.body_private.includes("slot 435162475123456")
    && normalized.body_private.includes("block height 361982475123456")
    && normalized.body_private.includes(TX_SIG)
    && normalized.body_private.includes("0x14a2cf7a40DA8dC1ef904615c0234e6ffcA880a1"));

const report = await reportCore.normalizeReportPayload({
  body_private: [
    "The public filing, slot, block height and signature are cited for reproducible review.",
    "Slot 435162475123456. Block height 361982475123456. Signature " + TX_SIG + ".",
  ].join("\n"),
  content_public_safe: "Public filing and on-chain coordinates are ready for independent review.",
  revision_reason_code: null,
  evidence: [{ kind: "url", ref: SEC_URL }, { kind: "onchain_tx", ref: TX_SIG }],
});
ok("Report permits a validated SEC URL, Solana signature, slot number and block height",
  report.evidence.length === 2 && report.body_private.includes("435162475123456"));

await rejects("Wire still rejects a Luhn-valid payment-card number", () => core.normalizeWirePayload({
  ...validPayload,
  body_private: validPayload.body_private + "\nProhibited payment card: 4111 1111 1111 1111.",
}), /prohibited_personal_data/);

await rejects("Report still rejects a Luhn-valid payment-card number", () => reportCore.normalizeReportPayload({
  body_private: "A detailed restricted narrative contains prohibited test card 4111111111111111 and must be refused before any proof is prepared.",
  content_public_safe: "This safe summary is long enough for the Report intake validator.",
  revision_reason_code: null,
  evidence: [{ kind: "url", ref: SEC_URL }],
}), /prohibited_personal_data/);

await rejects("Wire still rejects a government identity number", () => core.normalizeWirePayload({
  ...validPayload,
  body_private: validPayload.body_private + "\nProhibited government identity number: 123-45-6789.",
}), /prohibited_personal_data/);

console.log(`\n${passed} Wire personal-data regression checks passed.`);
