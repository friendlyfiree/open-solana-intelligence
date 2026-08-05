// Maintainer profile: validation and the public projection.
//
// The person who operates OSI is not an analyst. They hold no review weight,
// cast no governance vote, and are counted in no quorum. Until now they were
// also invisible, because the only public identity the product had was an
// analyst profile, and the honest way to close that gap is a separate record
// that says what it is rather than an analyst row that says something untrue.
//
// Dependency-free on purpose: this runs unchanged under Deno in production and
// under Node in the test suite, so the rules the tests exercise are the rules
// production enforces.

export const MAINTAINER_PROFILE_LIMITS = Object.freeze({
  DISPLAY_NAME: 80,
  BIO: 1000,
  EXPERTISE_ITEMS: 8,
  EXPERTISE_LENGTH: 40,
  LINKS: 6,
  LINK_LABEL: 40,
  LINK_URL: 300,
  URL: 300,
});

const EXPERTISE_PATTERN = /^[a-z0-9](?:[a-z0-9_]{0,38}[a-z0-9])?$/;
const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function optionalText(value, limit, code) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail(code);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > limit) fail(code);
  return trimmed;
}

// Only https, and only a shape a browser will treat as a normal link. A
// javascript: or data: URL rendered into an anchor is the classic way a
// profile field becomes an execution surface.
function optionalHttpsUrl(value, code) {
  const text = optionalText(value, MAINTAINER_PROFILE_LIMITS.URL, code);
  if (text === null) return null;
  if (!/^https:\/\/[^\s<>"']+$/.test(text)) fail(code);
  return text;
}

export function normalizeExpertise(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) fail("bad_expertise");
  const seen = [];
  for (const entry of value) {
    if (typeof entry !== "string") fail("bad_expertise");
    const slug = entry.trim().toLowerCase();
    if (!slug) continue;
    if (slug.length > MAINTAINER_PROFILE_LIMITS.EXPERTISE_LENGTH) fail("bad_expertise");
    if (!EXPERTISE_PATTERN.test(slug)) fail("bad_expertise");
    if (!seen.includes(slug)) seen.push(slug);
  }
  if (seen.length > MAINTAINER_PROFILE_LIMITS.EXPERTISE_ITEMS) fail("bad_expertise");
  return seen.sort();
}

export function normalizeLinks(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) fail("bad_links");
  const links = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("bad_links");
    const url = optionalHttpsUrl(entry.url, "bad_links");
    if (!url) continue;
    const label = optionalText(entry.label, MAINTAINER_PROFILE_LIMITS.LINK_LABEL, "bad_links");
    if (url.length > MAINTAINER_PROFILE_LIMITS.LINK_URL) fail("bad_links");
    if (links.some((existing) => existing.url === url)) continue;
    links.push({ label: label ?? "", url });
  }
  if (links.length > MAINTAINER_PROFILE_LIMITS.LINKS) fail("bad_links");
  return links;
}

// The exact shape the write RPC accepts. Anything absent becomes null or an
// empty list rather than being left to the caller's imagination, so clearing a
// field is expressible and a partial payload cannot silently keep stale text.
export function normalizeMaintainerProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("bad_profile");
  const wallet = typeof input.wallet === "string" ? input.wallet.trim() : "";
  if (!WALLET_PATTERN.test(wallet)) fail("bad_wallet");
  return {
    wallet,
    display_name: optionalText(input.display_name, MAINTAINER_PROFILE_LIMITS.DISPLAY_NAME, "bad_display_name"),
    bio: optionalText(input.bio, MAINTAINER_PROFILE_LIMITS.BIO, "bad_bio"),
    avatar_url: optionalHttpsUrl(input.avatar_url, "bad_avatar_url"),
    proof_of_work_url: optionalHttpsUrl(input.proof_of_work_url, "bad_proof_of_work_url"),
    expertise_public: normalizeExpertise(input.expertise_public),
    links_public: normalizeLinks(input.links_public),
  };
}

// What anyone may read. Every field here is content the maintainer typed about
// themselves. The record carries no status, no tier and no weight, because
// there is none to carry: presenting an empty weight would invite the reading
// that a filled one could exist.
export function publicMaintainerProfile(row) {
  if (!row || typeof row !== "object") return null;
  const wallet = typeof row.wallet === "string" ? row.wallet.trim() : "";
  if (!WALLET_PATTERN.test(wallet)) return null;
  return {
    wallet,
    display_name: typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : null,
    bio: typeof row.bio === "string" && row.bio.trim() ? row.bio.trim() : null,
    avatar_url: typeof row.avatar_url === "string" && /^https:\/\//.test(row.avatar_url) ? row.avatar_url : null,
    proof_of_work_url: typeof row.proof_of_work_url === "string" && /^https:\/\//.test(row.proof_of_work_url)
      ? row.proof_of_work_url
      : null,
    expertise_public: Array.isArray(row.expertise_public) ? row.expertise_public.filter((v) => typeof v === "string") : [],
    links_public: Array.isArray(row.links_public)
      ? row.links_public
        .filter((link) => link && typeof link === "object" && typeof link.url === "string" && /^https:\/\//.test(link.url))
        .map((link) => ({ label: typeof link.label === "string" ? link.label : "", url: link.url }))
      : [],
    updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
    // Stated in the payload rather than left to the interface, so any consumer
    // of this endpoint carries the same disclaimer the product does.
    is_analyst: false,
    review_weight: 0,
    governance_notice:
      "Operates the deployment. Holds no analyst standing, no review weight, and no vote in any quorum.",
  };
}
