// Dependency-free content-safety screening shared by the Report, Wire and AI
// Pack intake paths. It runs identically under Deno in production and Node in
// the regression suites, so the tested logic is the shipped logic.
//
// WHY THIS MODULE EXISTS
//
// The payment-card and government-identity screens were duplicated in
// osi-v2-report-core.mjs and osi-v2-wire-core.mjs, and both rejected any 13-19
// digit run that happened to satisfy the Luhn checksum. Luhn is a 1-in-10
// checksum, so roughly one in ten raw token amounts (lamports, wei, base units)
// was refused as a payment card, and a transaction hash whose hex digits
// happened to contain a Luhn-valid decimal run was refused too. Measured on the
// pre-fix validator: 9.9% of random 13-19 digit amounts and 0.45% of random EVM
// transaction hashes were falsely rejected. That is a forensics platform
// refusing the exact data it exists to collect.
//
// The fix is not a weaker screen. It is a screen that knows what it is looking
// at, in three stages:
//
//   1. Mask the technical constructs first. A URL, an 0x-prefixed hex blob, a
//      long bare hex digest and a base58 Solana address or signature cannot
//      contain a payment card or a national identity number, because a card is
//      13-19 decimal digits and these are longer, differently alphabeted, or
//      both. Digits inside them are never scanned.
//
//   2. Require a card to be card-shaped, not merely Luhn-valid. A real card
//      number carries an issuer identification number and a brand-permitted
//      length. This is how payment processors and data-loss-prevention tools
//      identify a card, and it is strictly more precise than Luhn alone: every
//      genuine card still matches, while an arbitrary numeric run almost never
//      does.
//
//   3. Treat magnitude notation as an amount. A run ending in six or more zeros
//      is a base-unit amount (1000000000000000000 lamports, 250000000000000000
//      wei); card numbers are not written that way. This is the one rule that
//      trades a vanishing amount of recall for the single most common shape of
//      legitimate on-chain data.
//
// What is NOT relaxed: a grouped card (4111 1111 1111 1111) is still caught on
// Luhn alone because separators are themselves a card signal and no on-chain
// value is written in 4-4-4-4 groups; every brand's bare form is still caught;
// and the national-identity screen still fires on a structurally valid number.

// ---------------------------------------------------------------------------
// Stage 1: technical constructs that can never contain a card or national id.
// ---------------------------------------------------------------------------

// Order matters. A URL is masked before its contents, and an 0x blob before the
// generic hex rule, so no inner fragment is scanned twice or left exposed.
const TECHNICAL_TOKEN_PATTERNS = Object.freeze([
  // Any absolute URL, including every block-explorer link. Its path routinely
  // carries an address or signature and must never be scanned for PII.
  /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,
  // EVM address, transaction hash, block hash, storage slot, raw calldata.
  /\b0x[0-9a-fA-F]{6,}\b/g,
  // Bare hex digests: sha256 payload hashes, evidence manifest hashes, memo
  // hashes, Ethereum values written without the 0x prefix.
  /\b[0-9a-fA-F]{32,}\b/g,
  // Base58: Solana wallet addresses (32-44) and transaction signatures (64-96).
  // A card is at most 19 characters, so a run this long is never a card.
  /\b[1-9A-HJ-NP-Za-km-z]{20,}\b/g,
  // ISO 8601 dates and timestamps, so a date can never read as a national id.
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
]);

// Replace each technical construct with same-length filler that contains no
// digits and no separators, so offsets, lengths and word boundaries around it
// are preserved exactly and the surrounding prose still scans normally.
export function maskTechnicalTokens(value) {
  let text = String(value ?? "");
  for (const pattern of TECHNICAL_TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, (match) => " ".repeat(match.length));
  }
  return text;
}

// ---------------------------------------------------------------------------
// Stage 2: what an actual payment card looks like.
// ---------------------------------------------------------------------------

// Issuer identification ranges and the lengths each brand actually issues.
// A genuine card always satisfies one of these rows; an arbitrary numeric run
// rarely does, which is what removes the false positives.
export const CARD_BRANDS = Object.freeze([
  { brand: "visa", prefix: /^4/, lengths: [13, 16, 19] },
  { brand: "mastercard", prefix: /^5[1-5]/, lengths: [16] },
  {
    brand: "mastercard_2series",
    prefix: /^2(?:2[2-9]\d|[3-6]\d\d|7[01]\d|720)/,
    lengths: [16],
  },
  { brand: "amex", prefix: /^3[47]/, lengths: [15] },
  { brand: "discover", prefix: /^6(?:011|5\d\d|4[4-9]\d)/, lengths: [16, 19] },
  { brand: "jcb", prefix: /^35(?:2[89]|[3-8]\d)/, lengths: [16, 17, 18, 19] },
  { brand: "diners", prefix: /^3(?:0[0-5]|095|[689])/, lengths: [14, 16, 19] },
  { brand: "unionpay", prefix: /^62/, lengths: [16, 17, 18, 19] },
]);

export function cardBrandOf(digits) {
  const value = String(digits ?? "");
  if (!/^\d+$/.test(value)) return null;
  for (const row of CARD_BRANDS) {
    if (row.prefix.test(value) && row.lengths.includes(value.length)) return row.brand;
  }
  return null;
}

export function passesLuhn(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// Stage 3: magnitude notation is an amount, not a card.
// ---------------------------------------------------------------------------

// A base-unit amount carries its scale as trailing zeros: one SOL is
// 1000000000000000000 in some notations, 1000000000 lamports in others. Six
// trailing zeros is the point where a value is unambiguously a magnitude rather
// than an account number.
export function looksLikeBaseUnitAmount(digits) {
  return /0{6,}$/.test(String(digits ?? ""));
}

// A card written in groups. Separators are themselves a card signal: no on-chain
// value, hash, amount or identifier is written in 4-4-4-4 or 4-6-5 groups, so a
// grouped run needs only the Luhn checksum to be treated as a card.
const GROUPED_CARD = /(?<![\d-])(?:\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}|\d{4}[ -]\d{6}[ -]\d{5})(?![\d-])/g;
// A bare run. Bounded so it cannot start or end inside a longer numeric token.
const BARE_DIGIT_RUN = /(?<![\d.,])\d{13,19}(?![\d.,])/g;

export function containsPaymentCard(value) {
  const text = maskTechnicalTokens(value);

  GROUPED_CARD.lastIndex = 0;
  for (let match = GROUPED_CARD.exec(text); match; match = GROUPED_CARD.exec(text)) {
    if (passesLuhn(match[0])) return true;
  }

  BARE_DIGIT_RUN.lastIndex = 0;
  for (let match = BARE_DIGIT_RUN.exec(text); match; match = BARE_DIGIT_RUN.exec(text)) {
    const digits = match[0];
    if (looksLikeBaseUnitAmount(digits)) continue;
    if (!cardBrandOf(digits)) continue;
    if (passesLuhn(digits)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// National identity numbers.
// ---------------------------------------------------------------------------

// A US Social Security number, with the structural rules the issuing authority
// actually applies: the area group is never 000, 666 or 900-999, the group is
// never 00, and the serial is never 0000. Bounded on both sides by a
// non-digit/non-hyphen so it cannot match a fragment of a longer hyphenated
// reference such as an SEC accession number.
const US_SSN = /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/;
// A space-grouped national identity number in the 3-3-2-2 shape. The
// lookaround pair allows an ordinary leading space in prose while refusing to
// match a fragment of a longer space-separated digit sequence.
const SPACED_NATIONAL_ID = /(?<!\d)(?<!\d )\d{3} \d{3} \d{2} \d{2}(?!\d)(?! \d)/;

export function containsGovernmentId(value) {
  const text = maskTechnicalTokens(value);
  return US_SSN.test(text) || SPACED_NATIONAL_ID.test(text);
}

export function containsProhibitedPersonalData(value) {
  return containsGovernmentId(value) || containsPaymentCard(value);
}
