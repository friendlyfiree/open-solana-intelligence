import { canonicalOsi2Envelope } from "./osi-v2-event-registry.mjs";

const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const APP_REF = /^OSI-APP-[0-9A-F]{12}$/;
const ANALYST_REF = /^OSI-ANL-[0-9A-F]{12}$/;

export const EXPERTISE = new Set([
  "blockchain_forensics",
  "scam_analysis",
  "exploit_research",
  "data_analysis",
  "osint",
  "protocol_research",
]);

function text(value, name, min, max) {
  const result = typeof value === "string" ? value.trim() : "";
  if (result.length < min || result.length > max) throw new TypeError(name + " is invalid");
  return result;
}

function optionalText(value, name) {
  if (value == null) return "";
  if (typeof value !== "string") throw new TypeError(name + " is invalid");
  return value.trim();
}

function safeHttpsUrl(value) {
  const input = text(value, "url", 8, 300);
  let url;
  try { url = new URL(input); } catch { throw new TypeError("url is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new TypeError("url is invalid");
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local")
      || /^(?:10|127|169\.254|192\.168)\./.test(hostname)
      || /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)
      || hostname === "0.0.0.0" || hostname === "[::1]") {
    throw new TypeError("url is invalid");
  }
  url.hash = "";
  return url.toString();
}

function cleanArray(value, name, maximum) {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(name + " is invalid");
  return value;
}

function secretMaterial(value) {
  const input = String(value ?? "").toLowerCase();
  return /(seed phrase|recovery phrase|private key|secret key|mnemonic|-----begin [a-z ]*private key-----)/.test(input);
}

/**
 * @param {any} value
 * @param {{sha256:string,mime:string}|null} avatar
 */
export function normalizeApplicationPayload(value, avatar = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("application is invalid");
  }
  const suppliedHandle = optionalText(value.handle, "handle");
  const handle = suppliedHandle ? suppliedHandle.toLowerCase() : null;
  if (handle && !/^[a-z0-9_]{2,32}$/.test(handle)) {
    throw new TypeError("handle is invalid");
  }
  const suppliedXHandle = optionalText(value.x_handle, "x_handle")
    .replace(/^@/, "")
    .toLowerCase();
  const xHandle = suppliedXHandle || null;
  if (xHandle && !/^[a-z0-9_]{2,15}$/.test(xHandle)) {
    throw new TypeError("x_handle is invalid");
  }
  const suppliedDisplayName = optionalText(value.display_name, "display_name");
  const displayName = suppliedDisplayName
    ? text(suppliedDisplayName, "display_name", 2, 80)
    : handle || (xHandle ? "@" + xHandle : null);
  const bio = text(value.bio, "bio", 10, 600);
  const expertise = [...new Set(cleanArray(value.expertise ?? [], "expertise", 6).map((item) => text(item, "expertise", 2, 32)))].sort();
  if (expertise.some((item) => !EXPERTISE.has(item))) {
    throw new TypeError("expertise is invalid");
  }
  const rawLinks = cleanArray(value.links ?? [], "links", Number.MAX_SAFE_INTEGER)
    .filter((item) => !(
      item && typeof item === "object" && !Array.isArray(item)
      && String(item.label ?? "").trim() === ""
      && String(item.url ?? "").trim() === ""
    ));
  if (rawLinks.length > 4) throw new TypeError("links is invalid");
  const suppliedLinks = rawLinks.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("link is invalid");
    const label = text(item.label, "link label", 1, 40);
    if (!/^[A-Za-z0-9 ._/-]+$/.test(label)) throw new TypeError("link label is invalid");
    return { label, url: safeHttpsUrl(item.url) };
  });
  const xUrl = xHandle ? "https://x.com/" + xHandle : null;
  const links = [
    ...(xUrl ? [{ label: "X / Twitter", url: xUrl }] : []),
    ...suppliedLinks.filter((item) => !xUrl || item.url !== xUrl),
  ];
  const motivation = typeof value.motivation === "string" ? value.motivation.trim() : "";
  if (motivation.length > 3000) throw new TypeError("motivation is invalid");
  const experience = typeof value.experience === "string" ? value.experience.trim() : "";
  if (experience.length > 3000) throw new TypeError("experience is invalid");
  if (value.safety_acknowledged !== true) throw new TypeError("safety acknowledgement is required");
  const proofUrls = cleanArray(
    value.proof_urls ?? [],
    "proof_urls",
    Number.MAX_SAFE_INTEGER,
  ).filter((url) => String(url ?? "").trim() !== "");
  if (proofUrls.length > 5) throw new TypeError("proof_urls is invalid");
  const normalizedProofUrls = proofUrls.map(safeHttpsUrl);
  if (secretMaterial([bio, motivation, experience, ...normalizedProofUrls].join("\n"))) {
    throw new TypeError("prohibited_secret_material");
  }
  const avatarBinding = avatar ? { sha256: avatar.sha256, mime: avatar.mime } : null;
  if (avatarBinding && (!HASH.test(avatarBinding.sha256)
      || !["image/png", "image/jpeg"].includes(avatarBinding.mime))) {
    throw new TypeError("avatar is invalid");
  }
  return {
    profile: {
      handle,
      display_name: displayName,
      bio,
      expertise,
      links,
      avatar: avatarBinding,
    },
    application: {
      x_handle: xHandle,
      motivation: motivation || null,
      experience: experience || null,
      proof_urls: normalizedProofUrls,
      safety_acknowledged: true,
    },
  };
}

export function normalizeApplicationReview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("review is invalid");
  }
  const applicationVersionId = text(value.application_version_id, "application_version_id", 36, 36);
  if (!UUID.test(applicationVersionId)) throw new TypeError("application_version_id is invalid");
  const versionRef = text(value.version_ref, "version_ref", 20, 20);
  if (!APP_REF.test(versionRef)) throw new TypeError("version_ref is invalid");
  const decision = text(value.decision, "decision", 6, 24);
  if (!["approve", "reject", "request_revision"].includes(decision)) {
    throw new TypeError("decision is invalid");
  }
  const reasonCode = text(value.reason_code, "reason_code", 2, 96);
  if (!/^[a-z][a-z0-9_:-]{0,95}$/.test(reasonCode)) throw new TypeError("reason_code is invalid");
  return {
    application_version_id: applicationVersionId,
    version_ref: versionRef,
    decision,
    reason_code: reasonCode,
  };
}

export function analystProbationPayload(wallet, applicationVersionId, versionRef) {
  if (!WALLET.test(String(wallet)) || !UUID.test(String(applicationVersionId)) || !APP_REF.test(String(versionRef))) {
    throw new TypeError("probation target is invalid");
  }
  return {
    analyst_wallet: wallet,
    application_version_id: applicationVersionId,
    application_version_ref: versionRef,
    status: "probationary_analyst",
    tier_code: "probationary",
    weight: "0.50",
  };
}

export function canonicalAnalystEventMessage(binding) {
  if (!binding || typeof binding !== "object") throw new TypeError("binding is invalid");
  const purpose = text(binding.purpose, "purpose", 2, 96);
  const targetType = text(binding.target_type, "target_type", 2, 32);
  const targetRef = text(binding.target_ref, "target_ref", 1, 24);
  const actorWallet = text(binding.actor_wallet, "actor_wallet", 32, 44);
  const actorRole = text(binding.actor_role, "actor_role", 4, 16);
  const decision = text(binding.decision, "decision", 2, 24);
  const nonce = text(binding.nonce, "nonce", 32, 128);
  const hash = text(binding.payload_hash, "payload_hash", 64, 64);
  const issuedAt = Number(binding.issued_at);
  if (!/^[A-Z][A-Z0-9_]{1,95}$/.test(purpose)
      || !["application_version", "analyst"].includes(targetType)
      || !(APP_REF.test(targetRef) || ANALYST_REF.test(targetRef))
      || !WALLET.test(actorWallet)
      || !["wallet", "maintainer"].includes(actorRole)
      || !/^[a-z][a-z0-9_]{1,23}$/.test(decision)
      || !NONCE.test(nonce) || !HASH.test(hash) || !Number.isSafeInteger(issuedAt)) {
    throw new TypeError("binding is invalid");
  }
  return canonicalOsi2Envelope({
    purpose, target_type: targetType, target_ref: targetRef,
    actor_wallet: actorWallet, actor_role: actorRole, decision,
    nonce, payload_hash: hash, issued_at: issuedAt,
  }, "v1_issued");
}

export function exactAnalystEventMessage(message, expected, nowSeconds) {
  let canonical;
  try { canonical = canonicalAnalystEventMessage(expected); } catch { return false; }
  const expiresAt = Number(expected.expires_at);
  return message === canonical
    && Number.isSafeInteger(expiresAt)
    && nowSeconds <= expiresAt
    && expiresAt > Number(expected.issued_at)
    && expiresAt - Number(expected.issued_at) <= 300;
}

export function inspectProfileImage(bytes, mime) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 24 || bytes.length > 524288) {
    throw new TypeError("avatar size is invalid");
  }
  let width = 0;
  let height = 0;
  if (mime === "image/png") {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    const last = bytes.length - 12;
    if (bytes.length < 45
        || !signature.every((byte, index) => bytes[index] === byte)
        || bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13
        || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR"
        || bytes[last] !== 0 || bytes[last + 1] !== 0 || bytes[last + 2] !== 0 || bytes[last + 3] !== 0
        || String.fromCharCode(...bytes.slice(last + 4, last + 8)) !== "IEND") {
      throw new TypeError("avatar bytes are invalid");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (mime === "image/jpeg") {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8
        || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
      throw new TypeError("avatar bytes are invalid");
    }
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = (bytes[offset + 5] << 8) | bytes[offset + 6];
        width = (bytes[offset + 7] << 8) | bytes[offset + 8];
        break;
      }
      const size = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (size < 2) throw new TypeError("avatar bytes are invalid");
      offset += size + 2;
    }
  } else {
    throw new TypeError("avatar mime is invalid");
  }
  if (width < 64 || height < 64 || width > 1024 || height > 1024) {
    throw new TypeError("avatar dimensions are invalid");
  }
  return { width, height, mime, size: bytes.length };
}

// A public contribution is an attributable public act the analyst performed
// themselves. The `analyst_contributions` table is the authoritative record of
// those, but nothing writes to it yet, so a real analyst with a full proof
// history was published as "0 contributions" next to their own receipts. Where
// the table is silent, derive the list from the analyst's own server-verified
// receipts instead of asserting zero.
//
// Only the analyst's own work counts. Operator decisions (opening a Case,
// publishing a Report, changing config, activating an analyst) are the
// maintainer's acts even when a maintainer also holds an analyst profile;
// money is not a contribution; and withdrawing or applying is not either.
export const ANALYST_CONTRIBUTION_KINDS = Object.freeze({
  CASE_SUBMITTED: "case_submitted",
  CASE_INITIAL_REVIEW_CAST: "case_initial_review",
  CASE_INITIAL_REVIEW_REVISED: "case_initial_review",
  CASE_REPORT_VERSION_SUBMITTED: "case_report_version",
  CASE_REPORT_REVIEW_CAST: "case_report_review",
  CASE_REPORT_REVIEW_REVISED: "case_report_review",
  WIRE_REPORT_VERSION_SUBMITTED: "wire_report_version",
  WIRE_REPORT_REVIEW_CAST: "wire_report_review",
  WIRE_REPORT_REVIEW_REVISED: "wire_report_review",
  RESOLUTION_PROPOSED: "resolution_proposed",
  RESOLUTION_REVIEW_CAST: "resolution_review",
  RESOLUTION_REVIEW_REVISED: "resolution_review",
  CHALLENGE_SUBMITTED: "challenge_submitted",
  CHALLENGE_REVIEW_CAST: "challenge_review",
  CHALLENGE_REVIEW_REVISED: "challenge_review",
  CHALLENGE_ADMISSIBILITY_ACCEPTED: "challenge_admissibility_review",
  CHALLENGE_ADMISSIBILITY_REJECTED: "challenge_admissibility_review",
  CHALLENGE_BAD_FAITH_REVIEW_CAST: "challenge_bad_faith_review",
  CHALLENGE_BAD_FAITH_REVIEW_REVISED: "challenge_bad_faith_review",
  AI_PACK_REVIEW_CAST: "ai_pack_review",
  AI_PACK_REVIEW_REVISED: "ai_pack_review",
  ANALYST_APPLICATION_REVIEW_CAST: "analyst_application_review",
  ANALYST_APPLICATION_REVIEW_REVISED: "analyst_application_review",
});

/**
 * @param {string} wallet the analyst whose contributions are being listed
 * @param {Array<Record<string, any>>} receipts server-verified receipts
 * @returns {Array<{kind:string,subject_type:string,subject_id:string,created_at:any,derived:true}>}
 */
export function deriveAnalystContributions(wallet, receipts = []) {
  const owner = String(wallet ?? "");
  if (!owner) return [];
  // A cast review and its later revision are two signed acts on one subject,
  // not two contributions. Keep the most recent act per subject so the count
  // reads as "distinct public work", never inflated by revisions.
  const bySubject = new Map();
  for (const row of receipts) {
    if (!row || String(row.actor_wallet ?? "") !== owner) continue;
    if (row.server_verified === false) continue;
    const kind = ANALYST_CONTRIBUTION_KINDS[String(row.event_type ?? "")];
    if (!kind) continue;
    const subjectType = String(row.target_type ?? "");
    const subjectId = String(row.public_ref ?? "");
    // Without a public reference there is nothing a reader could look up, so
    // publishing the row would be a claim they cannot check.
    if (!subjectType || !subjectId) continue;
    const key = kind + "|" + subjectType + "|" + subjectId;
    const at = row.occurred_at ?? null;
    const existing = bySubject.get(key);
    if (existing && String(existing.created_at ?? "") >= String(at ?? "")) continue;
    bySubject.set(key, { kind, subject_type: subjectType, subject_id: subjectId, created_at: at, derived: true });
  }
  return [...bySubject.values()].sort((left, right) =>
    String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")));
}

export function publicAnalystDto(profile, contributions = [], receipts = []) {
  const stored = contributions.map((row) => ({
    kind: String(row.kind ?? ""),
    subject_type: String(row.subject_type ?? ""),
    subject_id: String(row.subject_id ?? ""),
    created_at: row.created_at ?? null,
  }));
  return {
    wallet: String(profile.wallet ?? ""),
    handle: String(profile.handle ?? ""),
    display_name: String(profile.display_name ?? ""),
    bio: String(profile.bio ?? ""),
    avatar_url: profile.avatar_url ? String(profile.avatar_url) : null,
    expertise: Array.isArray(profile.expertise_public) ? profile.expertise_public : [],
    links: Array.isArray(profile.links_public) ? profile.links_public : [],
    status: String(profile.status ?? ""),
    tier_code: String(profile.tier_code ?? ""),
    weight: Number(profile.weight_cached ?? 0),
    contributions: stored.length
      ? stored
      : deriveAnalystContributions(String(profile.wallet ?? ""), receipts),
    proof_history: receipts.map((row) => {
      const result = {
        event_type: String(row.event_type ?? ""),
        actor_wallet: String(row.actor_wallet ?? ""),
        actor_role: String(row.actor_role ?? ""),
        decision: row.decision == null ? null : String(row.decision),
        proof_type: String(row.proof_type ?? ""),
        tx_sig: row.proof_type === "solana_memo" ? String(row.tx_sig ?? "") : null,
        occurred_at: row.occurred_at ?? null,
      };
      if (row.event_type === "SUPPORT_PAYMENT_CONFIRMED"
          && row.proof_type === "solana_memo"
          && /^[1-9][0-9]*$/.test(String(row.recipient_amount_lamports ?? ""))) {
        result.memo = String(row.memo_ref ?? "");
        result.payment_proof = {
          recipient_amount_lamports: String(row.recipient_amount_lamports),
          total_lamports: String(row.payment_total_lamports ?? ""),
          target_public_ref: String(row.payment_target_public_ref ?? ""),
          finality: String(row.payment_finality ?? ""),
          slot: String(row.payment_slot ?? ""),
          block_time: row.payment_block_time ?? null,
          server_verified: true,
        };
      }
      return result;
    }),
  };
}
