// Regression tests for the content-safety screen shared by Report, Wire and AI
// Pack intake.
// Run: node tests/osi-v2-content-safety.test.mjs   (exit 0 = pass)
//
// The screen used to reject any 13-19 digit run that satisfied the Luhn
// checksum. Luhn is a 1-in-10 checksum, so on the pre-fix validator 9.9% of
// random raw token amounts and 0.45% of random EVM transaction hashes were
// refused as payment cards. These tests pin both halves of the fix: legitimate
// on-chain data is accepted, and a genuine card or national identity number is
// still refused.

import * as safety from "../supabase/functions/_shared/osi-v2-content-safety-core.mjs";
import * as reportCore from "../supabase/functions/_shared/osi-v2-report-core.mjs";
import * as wireCore from "../supabase/functions/_shared/osi-v2-wire-core.mjs";
import { assertSafeText } from "../supabase/functions/osi-v2-ai-pack/core.ts";

let pass = 0;
let fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass += 1; return; }
  fail += 1;
  console.error("FAIL " + name + (detail ? " :: " + detail : ""));
}

// ---------------------------------------------------------------------------
// Fixtures: real, publicly known on-chain values.
// ---------------------------------------------------------------------------
const SOLANA_ADDRESSES = [
  "11111111111111111111111111111112",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "So11111111111111111111111111111111111111112",
  "9KZXvKqLNTQCTLwLPQVEjLDyDqDBWvbfPZLcCbAvJQXb",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
];
const SOLANA_SIGNATURES = [
  "5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7",
  "2".repeat(88),
  "4Qs1oc7Zd9RmDvJmzYAtJvXfV3gCcErYPYb1EWrRz7ndBwHc7Kk1RBGeGmL2QcRxfvHVsjPCPPXTBLsC2Uzq44WM",
];
const EVM_ADDRESSES = [
  "0x14a2cf7a40DA8dC1ef904615c0234e6ffcA880a1",
  "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  "0x0000000000000000000000000000000000000000",
];
const TX_HASHES = [
  "0x5f056549ca0525ce568951929804f7d1412b48151af19d266a911b2fdb69e02e",
  "0x88df016429689c079f3b2f6ad39fa052532c56795b733da78a91ebe6a713944b",
  "a".repeat(64),
  "3f2b8c9147059213485760912384756019283746501928374650192837465019",
];
const EXPLORER_URLS = [
  "https://solscan.io/tx/5j7s6NiJS3JAkvgkoc18WVAsiSaci2pxB2A6ueCJP4tprA2TFg9wSyTLeYouxPBJEMzJinENTkpA52YStRW5Dia7",
  "https://solscan.io/account/9KZXvKqLNTQCTLwLPQVEjLDyDqDBWvbfPZLcCbAvJQXb",
  "https://etherscan.io/tx/0x5f056549ca0525ce568951929804f7d1412b48151af19d266a911b2fdb69e02e",
  "https://explorer.solana.com/tx/2222222222222222222222222222222222222222222222222222222222222222222222222222222222222222?cluster=mainnet-beta",
  "https://ir.hyperiondefi.com/sec-filings/all-sec-filings/content/0001104659-26-036286/hypd-20251231x10k.htm",
];
const TOKEN_AMOUNTS = [
  "1000000000000000000",
  "250000000000000000",
  "1250000000000000000",
  "4500000000000000",
  "123456789012345678",
  "999999999999999999",
  "12345678901234",
  "5000000000",
];
const CHAIN_NUMERICS = [
  "slot 435162475123456",
  "block height 361982475123456",
  "epoch 812",
  "nonce 4294967295",
  "chain id 101",
  "unix 1786000000000",
  "2026-08-07T12:35:04Z",
  "compute units 1400000",
];
// Genuine card numbers (published test numbers) and national identity numbers.
const REAL_CARDS = [
  "4111111111111111",
  "4111 1111 1111 1111",
  "4111-1111-1111-1111",
  "4012888888881881",
  "4222222222222",
  "5500005555555559",
  "5555555555554444",
  "2223003122003222",
  "371449635398431",
  "3782 822463 10005",
  "6011000990139424",
  "3530111333300000",
  "30569309025904",
];
const REAL_NATIONAL_IDS = [
  "123-45-6789",
  "078-05-1120",
  "219 099 99 99",
];

// ---------------------------------------------------------------------------
// 1. Legitimate blockchain data is never personal data.
// ---------------------------------------------------------------------------
const BENIGN_GROUPS = [
  ["Solana address", SOLANA_ADDRESSES],
  ["Solana signature", SOLANA_SIGNATURES],
  ["EVM address", EVM_ADDRESSES],
  ["transaction hash", TX_HASHES],
  ["explorer URL", EXPLORER_URLS],
  ["raw token amount", TOKEN_AMOUNTS],
  ["chain numeric", CHAIN_NUMERICS],
];
for (const [label, values] of BENIGN_GROUPS) {
  for (const value of values) {
    ok("a " + label + " is not personal data: " + value.slice(0, 44),
      !safety.containsProhibitedPersonalData(value));
    ok("a " + label + " is not personal data in prose: " + value.slice(0, 24),
      !safety.containsProhibitedPersonalData(
        "The trace records " + value + " for independent verification.",
      ));
  }
}
ok("a full forensic narrative of on-chain values is accepted",
  !safety.containsProhibitedPersonalData([
    ...SOLANA_ADDRESSES, ...SOLANA_SIGNATURES, ...EVM_ADDRESSES,
    ...TX_HASHES, ...EXPLORER_URLS, ...TOKEN_AMOUNTS, ...CHAIN_NUMERICS,
  ].join("\n")));

// ---------------------------------------------------------------------------
// 2. Real payment cards and national identity numbers are still refused.
// ---------------------------------------------------------------------------
for (const card of REAL_CARDS) {
  ok("a genuine payment card is still refused: " + card,
    safety.containsPaymentCard("Prohibited card " + card + " must not be stored."));
}
for (const id of REAL_NATIONAL_IDS) {
  ok("a genuine national identity number is still refused: " + id,
    safety.containsGovernmentId("Prohibited identity number " + id + " must not be stored."));
}
ok("a card is refused even when surrounded by legitimate on-chain data",
  safety.containsProhibitedPersonalData(
    SOLANA_SIGNATURES[0] + " then 4111111111111111 then " + EVM_ADDRESSES[0],
  ));
ok("a national identity number is refused even beside a transaction hash",
  safety.containsProhibitedPersonalData(TX_HASHES[0] + " and 123-45-6789"));

// ---------------------------------------------------------------------------
// 3. The individual detector rules behave as documented.
// ---------------------------------------------------------------------------
ok("masking removes URLs, hex blobs, base58 blobs and timestamps",
  safety.maskTechnicalTokens(
    "a " + EXPLORER_URLS[0] + " b " + TX_HASHES[0] + " c " + SOLANA_ADDRESSES[0]
    + " d 2026-08-07T12:35:04Z e",
  ).replace(/\s+/g, "") === "abcde");
ok("masking preserves the exact length of what it replaces",
  safety.maskTechnicalTokens(TX_HASHES[0]).length === TX_HASHES[0].length);
ok("masking leaves ordinary prose untouched",
  safety.maskTechnicalTokens("The wallet drained funds on 4 August.")
    === "The wallet drained funds on 4 August.");
ok("brand detection requires both an issuer prefix and a permitted length",
  safety.cardBrandOf("4111111111111111") === "visa"
  && safety.cardBrandOf("371449635398431") === "amex"
  && safety.cardBrandOf("5555555555554444") === "mastercard"
  && safety.cardBrandOf("2223003122003222") === "mastercard_2series"
  && safety.cardBrandOf("6011000990139424") === "discover"
  && safety.cardBrandOf("41111111111111") === null
  && safety.cardBrandOf("1234567890123456") === null);
ok("a base-unit amount is recognized by its trailing zeros",
  safety.looksLikeBaseUnitAmount("1000000000000000000")
  && safety.looksLikeBaseUnitAmount("250000000000000000")
  && !safety.looksLikeBaseUnitAmount("4111111111111111"));
ok("Luhn still rejects a mistyped card and a uniform run",
  !safety.passesLuhn("4111111111111112") && !safety.passesLuhn("1111111111111111"));
ok("the SSN screen applies the real structural rules",
  !safety.containsGovernmentId("000-45-6789")
  && !safety.containsGovernmentId("666-45-6789")
  && !safety.containsGovernmentId("900-45-6789")
  && !safety.containsGovernmentId("123-00-6789")
  && !safety.containsGovernmentId("123-45-0000")
  && safety.containsGovernmentId("123-45-6789"));
ok("an SEC accession number is not a national identity number",
  !safety.containsGovernmentId("0001104659-26-036286"));

// ---------------------------------------------------------------------------
// 4. Measured false-positive rate, so a regression is caught numerically.
// ---------------------------------------------------------------------------
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
{
  const random = seededRandom(20260807);
  let flagged = 0;
  const total = 4000;
  for (let index = 0; index < total; index += 1) {
    let digits = String(1 + Math.floor(random() * 9));
    const length = 13 + Math.floor(random() * 7);
    for (let position = 1; position < length; position += 1) {
      digits += String(Math.floor(random() * 10));
    }
    if (safety.containsPaymentCard(digits)) flagged += 1;
  }
  // The pre-fix validator flagged 9.9% of these. Anything above 3% means the
  // brand/length or magnitude rule regressed back toward bare Luhn.
  ok("uniform random 13-19 digit runs are rarely mistaken for a card",
    flagged / total < 0.03, (flagged / total * 100).toFixed(2) + "%");
}
{
  const random = seededRandom(77712);
  let flagged = 0;
  const total = 3000;
  for (let index = 0; index < total; index += 1) {
    let hash = "0x";
    for (let position = 0; position < 64; position += 1) {
      hash += "0123456789abcdef"[Math.floor(random() * 16)];
    }
    if (safety.containsProhibitedPersonalData(hash)) flagged += 1;
  }
  ok("no random EVM transaction hash is mistaken for personal data", flagged === 0, String(flagged));
}
{
  const random = seededRandom(31337);
  let flagged = 0;
  const total = 3000;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  for (let index = 0; index < total; index += 1) {
    let signature = "";
    for (let position = 0; position < 88; position += 1) {
      signature += alphabet[Math.floor(random() * alphabet.length)];
    }
    if (safety.containsProhibitedPersonalData(signature)) flagged += 1;
  }
  ok("no random Solana signature is mistaken for personal data", flagged === 0, String(flagged));
}
{
  const random = seededRandom(90210);
  let flagged = 0;
  const total = 2000;
  for (let index = 0; index < total; index += 1) {
    const mantissa = String(1 + Math.floor(random() * 999999));
    const zeros = "0".repeat(9 + Math.floor(random() * 10));
    if (safety.containsPaymentCard(mantissa + zeros)) flagged += 1;
  }
  ok("no base-unit token amount is mistaken for a card", flagged === 0, String(flagged));
}

// ---------------------------------------------------------------------------
// 5. End to end through the three intake paths that use the screen.
// ---------------------------------------------------------------------------
const NARRATIVE = [
  "The drained wallet " + SOLANA_ADDRESSES[4] + " moved funds in a single transaction.",
  "Signature " + SOLANA_SIGNATURES[0] + " is verifiable at " + EXPLORER_URLS[0] + ".",
  "The bridged leg settled at " + EVM_ADDRESSES[0] + " in " + TX_HASHES[0] + ".",
  "The transfer moved " + TOKEN_AMOUNTS[0] + " base units, observed at " + CHAIN_NUMERICS[0] + ".",
  "Amounts are reported in raw base units so a reader can reproduce them exactly.",
].join("\n");

const report = await reportCore.normalizeReportPayload({
  body_private: NARRATIVE,
  content_public_safe: "A public-safe account of the traced transfer and its verifiable coordinates.",
  revision_reason_code: null,
  evidence: [{ kind: "onchain_tx", ref: SOLANA_SIGNATURES[1] }],
});
ok("Report intake accepts a full on-chain narrative unchanged",
  report.body_private.includes(TOKEN_AMOUNTS[0])
  && report.body_private.includes(SOLANA_SIGNATURES[0])
  && report.body_private.includes(EVM_ADDRESSES[0])
  && report.body_private.includes(TX_HASHES[0]));

const wire = await wireCore.normalizeWirePayload({
  title_public_safe: "Bridged transfer correlation",
  content_public_safe: "Public on-chain coordinates are published for independent verification.",
  body_private: NARRATIVE,
  uncertainties_private: "Correlation does not establish identity or legal ownership.",
  revision_reason_code: null,
  evidence: [{ kind: "onchain_tx", ref: SOLANA_SIGNATURES[1] }],
});
ok("Wire intake accepts the same on-chain narrative unchanged",
  wire.body_private.includes(TOKEN_AMOUNTS[0]) && wire.body_private.includes(TX_HASHES[0]));

let aiPackAccepted = true;
try { assertSafeText(NARRATIVE); } catch { aiPackAccepted = false; }
ok("AI Pack evidence screening accepts the same on-chain narrative", aiPackAccepted);
for (const value of [...TOKEN_AMOUNTS, ...CHAIN_NUMERICS]) {
  let accepted = true;
  try { assertSafeText("Observed value " + value + " in public evidence."); } catch { accepted = false; }
  ok("AI Pack accepts on-chain numeric " + value.slice(0, 30), accepted);
}
let aiPackRefusedCard = false;
try { assertSafeText("Card 4111111111111111 appears in the evidence."); } catch { aiPackRefusedCard = true; }
ok("AI Pack still refuses a genuine payment card", aiPackRefusedCard);
let aiPackRefusedEmail = false;
try { assertSafeText("Contact owner@example.com for details"); } catch { aiPackRefusedEmail = true; }
ok("AI Pack still refuses an email address", aiPackRefusedEmail);
let aiPackRefusedPhone = false;
try { assertSafeText("Reach them on +1 415 555 0134 any time."); } catch { aiPackRefusedPhone = true; }
ok("AI Pack still refuses a telephone number", aiPackRefusedPhone);

async function refuses(name, runner) {
  try { await runner(); } catch (error) {
    ok(name, /prohibited_personal_data/.test(String(error?.message || error)));
    return;
  }
  ok(name, false, "accepted");
}
await refuses("Report intake still refuses a payment card", () => reportCore.normalizeReportPayload({
  body_private: "A restricted narrative long enough for the validator that wrongly carries card 4111111111111111 inside it.",
  content_public_safe: "A public-safe summary long enough for intake.",
  revision_reason_code: null,
  evidence: [],
}));
await refuses("Report intake still refuses a national identity number", () => reportCore.normalizeReportPayload({
  body_private: "A restricted narrative long enough for the validator that wrongly carries identity number 123-45-6789 inside it.",
  content_public_safe: "A public-safe summary long enough for intake.",
  revision_reason_code: null,
  evidence: [],
}));
await refuses("Wire intake still refuses a payment card", () => wireCore.normalizeWirePayload({
  title_public_safe: "Refused fixture",
  content_public_safe: "A public-safe summary that is long enough for the Wire validator.",
  body_private: "A restricted analysis long enough for the validator that wrongly carries card 5500005555555559 inside it.",
  uncertainties_private: "",
  revision_reason_code: null,
  evidence: [{ kind: "onchain_tx", ref: SOLANA_SIGNATURES[1] }],
}));

// Unrelated screens must keep working exactly as before.
await refuses("secret material is still refused separately", async () => {
  try {
    await reportCore.normalizeReportPayload({
      body_private: "A restricted narrative long enough for the validator that leaks a seed phrase for the drained wallet.",
      content_public_safe: "A public-safe summary long enough for intake.",
      revision_reason_code: null,
      evidence: [],
    });
  } catch (error) {
    throw new TypeError(
      /prohibited_secret_material/.test(String(error.message))
        ? "prohibited_personal_data" : String(error.message),
    );
  }
});
await refuses("illegal-access material is still refused separately", async () => {
  try {
    await reportCore.normalizeReportPayload({
      body_private: "A restricted narrative long enough for the validator that offers stolen credentials for sale.",
      content_public_safe: "A public-safe summary long enough for intake.",
      revision_reason_code: null,
      evidence: [],
    });
  } catch (error) {
    throw new TypeError(
      /prohibited_illegal_access_material/.test(String(error.message))
        ? "prohibited_personal_data" : String(error.message),
    );
  }
});
let doxxingRefused = false;
try {
  await wireCore.normalizeWirePayload({
    title_public_safe: "Refused fixture",
    content_public_safe: "A public-safe summary that is long enough for the Wire validator.",
    body_private: "A restricted analysis long enough for the validator that publishes their home address in full.",
    uncertainties_private: "",
    revision_reason_code: null,
    evidence: [{ kind: "onchain_tx", ref: SOLANA_SIGNATURES[1] }],
  });
} catch (error) {
  doxxingRefused = /prohibited_personal_data/.test(String(error.message));
}
ok("Wire doxxing vocabulary screening is unchanged", doxxingRefused);

console.log((fail ? "FAILED: " + fail : "OK")
  + " (" + pass + " assertions passed, " + fail + " failed)");
process.exit(fail ? 1 : 0);
