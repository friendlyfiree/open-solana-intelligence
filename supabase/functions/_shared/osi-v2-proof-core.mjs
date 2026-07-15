const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const TARGET_TYPES = new Set([
  "case",
  "report_version",
  "wire_version",
  "resolution",
  "challenge",
  "pack_version",
  "pack_owner_feedback",
  "analyst",
  "application_version",
  "reward",
  "support",
  "config",
]);

export const CLASS_B_PURPOSES = new Set([
  "CASE_INITIAL_REVIEW_CAST",
  "CASE_INITIAL_REVIEW_REVISED",
  "CASE_WITHDRAWN",
  "CASE_APPEAL_SUBMITTED",
  "CASE_REPORT_REVIEW_CAST",
  "CASE_REPORT_REVIEW_REVISED",
  "WIRE_REPORT_REVIEW_CAST",
  "WIRE_REPORT_REVIEW_REVISED",
  "RESOLUTION_REVIEW_CAST",
  "RESOLUTION_REVIEW_REVISED",
  "CHALLENGE_SUBMITTED",
  "CHALLENGE_ADMISSIBILITY_ACCEPTED",
  "CHALLENGE_ADMISSIBILITY_REJECTED",
  "CHALLENGE_REVIEW_CAST",
  "CHALLENGE_REVIEW_REVISED",
  "CHALLENGE_WITHDRAWN",
  "CHALLENGE_BAD_FAITH_REVIEW_CAST",
  "CHALLENGE_BAD_FAITH_REVIEW_REVISED",
  "AI_PACK_REVIEW_CAST",
  "AI_PACK_REVIEW_REVISED",
  "AI_PACK_OWNER_FEEDBACK_SUBMITTED",
  "ANALYST_APPLICATION_VERSION_SUBMITTED",
  "ANALYST_APPLICATION_REVIEW_CAST",
  "ANALYST_APPLICATION_REVIEW_REVISED",
  "OWNER_STATUS_PROOF",
  "REWARD_PLEDGE_CREATED",
  "REWARD_PLEDGE_REVISED",
  "REWARD_PLEDGE_WITHDRAWN",
]);

function requireText(value, name, pattern, maxLength) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new TypeError(name + " is invalid");
  }
  if (pattern && !pattern.test(value)) throw new TypeError(name + " is invalid");
  return value;
}

export function validateWallet(wallet) {
  requireText(wallet, "actor_wallet", /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 44);
  if (base58Decode(wallet).length !== 32) throw new TypeError("actor_wallet is invalid");
  return wallet;
}

export function validateProofBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new TypeError("proof binding is invalid");
  }
  const purpose = requireText(
    binding.purpose,
    "purpose",
    /^[A-Z][A-Z0-9_]{1,95}$/,
    96,
  );
  if (!CLASS_B_PURPOSES.has(purpose)) throw new TypeError("purpose is not class B");
  const actorWallet = validateWallet(binding.actor_wallet);
  const targetType = requireText(
    binding.target_type,
    "target_type",
    /^[a-z][a-z0-9_]{0,63}$/,
    64,
  );
  if (!TARGET_TYPES.has(targetType)) throw new TypeError("target_type is invalid");
  const targetId = requireText(
    binding.target_id,
    "target_id",
    /^[A-Za-z0-9._:-]{1,256}$/,
    256,
  );
  const payloadHash = requireText(
    binding.payload_hash,
    "payload_hash",
    /^[0-9a-f]{64}$/,
    64,
  );
  const nonce = requireText(
    binding.nonce,
    "nonce",
    /^[A-Za-z0-9_-]{32,128}$/,
    128,
  );
  const issuedAt = Number(binding.issued_at);
  const expiresAt = Number(binding.expires_at);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) {
    throw new TypeError("proof timestamps are invalid");
  }
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 300) {
    throw new TypeError("proof expiry is invalid");
  }
  return {
    purpose,
    actor_wallet: actorWallet,
    target_type: targetType,
    target_id: targetId,
    payload_hash: payloadHash,
    nonce,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
}

export function canonicalProofMessage(binding) {
  const value = validateProofBinding(binding);
  return [
    "OSI2",
    "2",
    value.purpose,
    "t=" + value.target_type,
    "id=" + value.target_id,
    "a=" + value.actor_wallet,
    "n=" + value.nonce,
    "h=" + value.payload_hash,
    "ts=" + String(value.issued_at),
    "exp=" + String(value.expires_at),
  ].join("|");
}

export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("payload number is invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("payload object is invalid");
    }
    const keys = Object.keys(value).sort();
    return "{" + keys.map((key) => {
      const child = value[key];
      if (child === undefined || typeof child === "function" || typeof child === "symbol") {
        throw new TypeError("payload value is invalid");
      }
      return JSON.stringify(key) + ":" + canonicalJson(child);
    }).join(",") + "}";
  }
  throw new TypeError("payload value is invalid");
}

export async function sha256HexUtf8(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return bytesToHex(digest);
}

export async function payloadHash(payload) {
  return await sha256HexUtf8(canonicalJson(payload));
}

export function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64Url(bytes);
}

export async function requestFingerprint(secret, clientAddress) {
  requireText(secret, "fingerprint secret", null, 10000);
  const address = requireText(
    clientAddress || "unknown",
    "client address",
    /^[0-9A-Fa-f:.]{1,128}$|^unknown$/,
    128,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode("osi-v2-rate-limit\u0000" + address),
  );
  return bytesToHex(new Uint8Array(signature));
}

export function trustedClientAddress(headers) {
  const forwarded = headers?.get?.("x-forwarded-for") || "";
  const candidate = forwarded
    ? forwarded.split(",").map((item) => item.trim()).filter(Boolean).at(-1)
    : (headers?.get?.("x-real-ip") || "").trim();
  if (!candidate || candidate.length > 128 || !/^[0-9A-Fa-f:.]+$/.test(candidate)) {
    return "unknown";
  }
  return candidate;
}

export async function verifyEd25519Signature(message, signatureBase64, wallet) {
  if (typeof message !== "string" || message.length < 1 || message.length > 2048) {
    return false;
  }
  try {
    const publicKeyBytes = base58Decode(validateWallet(wallet));
    const signatureBytes = base64ToBytes(signatureBase64);
    if (signatureBytes.length !== 64) return false;
    const publicKey = await crypto.subtle.importKey(
      "raw",
      publicKeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      signatureBytes,
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

export function base58Decode(value) {
  requireText(value, "base58", /^[1-9A-HJ-NP-Za-km-z]+$/, 128);
  let number = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) throw new TypeError("base58 is invalid");
    number = number * 58n + BigInt(digit);
  }
  const decoded = [];
  while (number > 0n) {
    decoded.unshift(Number(number & 255n));
    number >>= 8n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === "1") {
    leadingZeroes += 1;
  }
  return new Uint8Array([...new Array(leadingZeroes).fill(0), ...decoded]);
}

function base64ToBytes(value) {
  requireText(value, "signature", /^[A-Za-z0-9+/_=-]+$/, 256);
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
