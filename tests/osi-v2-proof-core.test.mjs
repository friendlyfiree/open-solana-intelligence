import assert from "node:assert/strict";
import {
  CLASS_B_PURPOSES,
  base58Decode,
  canonicalJson,
  canonicalProofMessage,
  payloadHash,
  randomNonce,
  requestFingerprint,
  trustedClientAddress,
  validateProofBinding,
  verifyEd25519Signature,
} from "../supabase/functions/_shared/osi-v2-proof-core.mjs";

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes) {
  let number = 0n;
  for (const byte of bytes) number = (number << 8n) + BigInt(byte);
  let encoded = "";
  while (number > 0n) {
    encoded = alphabet[Number(number % 58n)] + encoded;
    number /= 58n;
  }
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes += 1;
  return "1".repeat(zeroes) + encoded;
}

let passed = 0;
function ok(name, condition) {
  assert.equal(Boolean(condition), true, name);
  passed += 1;
}

ok("canonical registry has 28 class-B purposes", CLASS_B_PURPOSES.size === 28);
ok(
  "canonical registry includes the three reward pledge mutations",
  ["REWARD_PLEDGE_CREATED", "REWARD_PLEDGE_REVISED", "REWARD_PLEDGE_WITHDRAWN"]
    .every((purpose) => CLASS_B_PURPOSES.has(purpose)),
);
ok(
  "canonical JSON ignores object insertion order",
  canonicalJson({ z: 1, a: { y: 2, x: 3 } })
    === canonicalJson({ a: { x: 3, y: 2 }, z: 1 }),
);
ok(
  "canonical payload hash ignores object insertion order",
  await payloadHash({ z: 1, a: true }) === await payloadHash({ a: true, z: 1 }),
);
assert.throws(() => canonicalJson({ value: Number.NaN }), /invalid/);
passed += 1;

const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
const wallet = base58Encode(publicBytes);
ok("generated wallet decodes to 32 bytes", base58Decode(wallet).length === 32);

const binding = validateProofBinding({
  purpose: "CASE_WITHDRAWN",
  actor_wallet: wallet,
  target_type: "case",
  target_id: "018f47ac-7d20-7b92-a323-7fc0f3f43c10",
  payload_hash: "a".repeat(64),
  nonce: randomNonce(),
  issued_at: 1_800_000_000,
  expires_at: 1_800_000_120,
});
const message = canonicalProofMessage(binding);
ok("canonical message binds exact purpose", message.includes("|CASE_WITHDRAWN|"));
ok("canonical message binds exact target", message.includes("|id=" + binding.target_id + "|"));
ok("canonical message binds exact payload hash", message.includes("|h=" + binding.payload_hash + "|"));
ok("canonical message binds expiry", message.endsWith("|exp=1800000120"));

const signature = new Uint8Array(await crypto.subtle.sign(
  "Ed25519",
  keyPair.privateKey,
  new TextEncoder().encode(message),
));
const signatureBase64 = Buffer.from(signature).toString("base64");
ok(
  "valid Ed25519 signature verifies",
  await verifyEd25519Signature(message, signatureBase64, wallet),
);
ok(
  "changed target breaks signature",
  !await verifyEd25519Signature(message.replace(binding.target_id, binding.target_id + "x"), signatureBase64, wallet),
);
ok(
  "changed payload breaks signature",
  !await verifyEd25519Signature(message.replace("a".repeat(64), "b".repeat(64)), signatureBase64, wallet),
);

const otherKeyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const otherWallet = base58Encode(new Uint8Array(
  await crypto.subtle.exportKey("raw", otherKeyPair.publicKey),
));
ok(
  "wrong wallet breaks signature",
  !await verifyEd25519Signature(message, signatureBase64, otherWallet),
);

const nonceOne = randomNonce();
const nonceTwo = randomNonce();
ok("nonce is URL-safe and 32-byte sized", /^[A-Za-z0-9_-]{43}$/.test(nonceOne));
ok("random nonces differ", nonceOne !== nonceTwo);

const headers = new Headers({
  "x-forwarded-for": "203.0.113.7, 198.51.100.9",
});
ok("trusted address uses gateway-appended final hop", trustedClientAddress(headers) === "198.51.100.9");
ok("invalid forwarded address fails closed", trustedClientAddress(new Headers({
  "x-forwarded-for": "attacker-value",
})) === "unknown");
ok(
  "fingerprint is deterministic but does not expose address",
  await requestFingerprint("server-secret", "198.51.100.9")
    === await requestFingerprint("server-secret", "198.51.100.9")
    && !(await requestFingerprint("server-secret", "198.51.100.9")).includes("198.51.100.9"),
);

assert.throws(() => validateProofBinding({ ...binding, purpose: "CASE_SUBMITTED" }), /class B/);
passed += 1;
assert.throws(() => validateProofBinding({ ...binding, target_id: "bad|target" }), /invalid/);
passed += 1;
assert.throws(() => validateProofBinding({ ...binding, expires_at: binding.issued_at + 301 }), /expiry/);
passed += 1;

console.log(`OK (${passed} assertions passed, 0 failed)`);
