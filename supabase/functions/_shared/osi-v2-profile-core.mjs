const HANDLE = /^[a-z0-9_]{2,32}$/;
const HASH = /^[0-9a-f]{64}$/;
const PROFILE_REF = /^OSI-PRF-[A-F0-9]{16}$/;
const AVATAR_MIMES = new Set(["image/png", "image/jpeg"]);
const VISIBILITIES = new Set(["private", "public"]);
const AVATAR_ACTIONS = new Set(["keep", "replace", "remove"]);

const SECRET_PATTERNS = [
  /\b(?:seed phrase|recovery phrase|secret key|private key|mnemonic)\b/i,
  /-----begin [a-z ]*private key-----/i,
];

function optionalText(value, name, maximum, minimum = 1) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new TypeError(name + " is invalid");
  const normalized = value.trim();
  if (!normalized) return null;
  if (
    normalized.length < minimum || normalized.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new TypeError(name + " is invalid");
  }
  return normalized;
}

function rejectSecretMaterial(values) {
  const joined = values.filter(Boolean).join("\n");
  if (SECRET_PATTERNS.some((pattern) => pattern.test(joined))) {
    throw new TypeError("prohibited_secret_material");
  }
}

/**
 * Canonicalizes exactly the owner-editable profile fields. Analyst standing,
 * tier, weight and review authority deliberately have no representation here.
 * @param {Record<string, unknown>} value
 * @param {{sha256: string, mime: string} | null} [avatar]
 */
export function normalizeWalletProfile(value, avatar = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("profile is invalid");
  }
  const suppliedHandle = optionalText(value.handle, "handle", 32, 2);
  const handle = suppliedHandle ? suppliedHandle.toLowerCase() : null;
  if (handle && !HANDLE.test(handle)) throw new TypeError("handle is invalid");
  const displayName = optionalText(value.display_name, "display_name", 80, 2);
  const bio = optionalText(value.bio, "bio", 600);
  const visibility = String(value.visibility ?? "private");
  if (!VISIBILITIES.has(visibility)) {
    throw new TypeError("visibility is invalid");
  }
  const attributePublicCases = value.attribute_public_cases === true;
  if (attributePublicCases && visibility !== "public") {
    throw new TypeError("case attribution requires a public profile");
  }
  if (visibility === "public" && !handle && !displayName) {
    throw new TypeError("public profile requires a public name");
  }
  rejectSecretMaterial([handle, displayName, bio]);

  const avatarAction = String(value.avatar_action ?? "keep");
  if (!AVATAR_ACTIONS.has(avatarAction)) {
    throw new TypeError("avatar_action is invalid");
  }
  let avatarBinding = { action: avatarAction };
  if (avatarAction === "replace") {
    if (
      !avatar || typeof avatar !== "object" || Array.isArray(avatar) ||
      !HASH.test(String(avatar.sha256 ?? "")) ||
      !AVATAR_MIMES.has(String(avatar.mime ?? ""))
    ) {
      throw new TypeError("avatar is invalid");
    }
    avatarBinding = {
      action: "replace",
      sha256: String(avatar.sha256),
      mime: String(avatar.mime),
    };
  } else if (avatar != null) {
    throw new TypeError("avatar is invalid");
  }

  return {
    handle,
    display_name: displayName,
    bio,
    visibility,
    attribute_public_cases: attributePublicCases,
    avatar: avatarBinding,
  };
}

/** @param {Record<string, any> | null | undefined} row */
export function publicWalletProfileDto(row) {
  if (!row || row.visibility !== "public") return null;
  const publicRef = String(row.public_ref ?? "");
  if (!PROFILE_REF.test(publicRef)) return null;
  return {
    public_ref: publicRef,
    handle: row.handle == null ? null : String(row.handle),
    display_name: row.display_name == null ? null : String(row.display_name),
    bio: row.bio == null ? null : String(row.bio),
    avatar_url: row.avatar_url == null ? null : String(row.avatar_url),
    updated_at: row.updated_at ?? null,
  };
}

/**
 * @param {Record<string, any> | null | undefined} row
 * @param {Record<string, any> | null | undefined} [analystFallback]
 */
export function ownerWalletProfileDto(row, analystFallback = null) {
  if (row) {
    const identity = publicWalletProfileDto({ ...row, visibility: "public" });
    if (
      !identity || !Number.isInteger(Number(row.revision)) ||
      Number(row.revision) < 1
    ) return null;
    return {
      ...identity,
      wallet: String(row.wallet),
      visibility: String(row.visibility),
      attribute_public_cases: row.attribute_public_cases === true,
      handle_locked: row.first_published_at != null,
      revision: Number(row.revision),
      source: "wallet_profile",
    };
  }
  if (!analystFallback) return null;
  return {
    public_ref: null,
    wallet: String(analystFallback.wallet ?? ""),
    handle: analystFallback.handle == null
      ? null
      : String(analystFallback.handle),
    display_name: analystFallback.display_name == null
      ? null
      : String(analystFallback.display_name),
    bio: analystFallback.bio == null ? null : String(analystFallback.bio),
    avatar_url: analystFallback.avatar_url == null
      ? null
      : String(analystFallback.avatar_url),
    updated_at: analystFallback.updated_at ?? null,
    visibility: "private",
    attribute_public_cases: false,
    handle_locked: false,
    revision: 0,
    source: "analyst_fallback",
  };
}

export function isProfileWritesEnabled(value) {
  return value === "true";
}
