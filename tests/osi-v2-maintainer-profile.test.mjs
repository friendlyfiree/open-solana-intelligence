// The maintainer profile exists to say one thing clearly: the person who
// operates OSI is not an analyst. These checks hold that line at the boundary
// where it is cheapest to break it, which is the field validation and the
// public projection, and they hold the input rules that keep a profile field
// from becoming an execution surface.

import assert from "node:assert/strict";
import {
  MAINTAINER_PROFILE_LIMITS,
  normalizeExpertise,
  normalizeLinks,
  normalizeMaintainerProfile,
  publicMaintainerProfile,
} from "../supabase/functions/_shared/osi-v2-maintainer-profile-core.mjs";

let passed = 0;
function ok(name, condition) {
  assert.equal(Boolean(condition), true, name);
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}
function refuses(name, run, code) {
  let thrown = null;
  try { run(); } catch (error) { thrown = error; }
  ok(name, thrown !== null && (!code || thrown.code === code || thrown.message === code));
}

const WALLET = "42VqbY8JghJuf4TcyzaQ9nzQ446W9L3zYTUL3no6XU4y";

// A profile carries no standing, and the payload says so rather than leaving
// the interface to remember. Anything consuming this endpoint inherits the
// disclaimer.
{
  const projected = publicMaintainerProfile({
    wallet: WALLET, display_name: "Aksusarya", bio: "On-chain intelligence.",
    avatar_url: "https://example.org/a.png", proof_of_work_url: "https://example.org/pow",
    expertise_public: ["osint"], links_public: [{ label: "X", url: "https://x.com/a" }],
    updated_at: "2026-08-05T00:00:00Z",
  });
  ok("the public projection states that the maintainer is not an analyst",
    projected.is_analyst === false && projected.review_weight === 0
    && /no review weight/i.test(projected.governance_notice));
  ok("the projection carries no status, tier or weight field that could imply standing",
    !("status" in projected) && !("tier_code" in projected) && !("weight_cached" in projected));
}

// An unwritten profile is an honest absence, not an invented operator.
ok("no row projects to null rather than an empty card", publicMaintainerProfile(null) === null);
ok("a row without a usable wallet projects to null", publicMaintainerProfile({ wallet: "nope" }) === null);

// Links and avatars are rendered into anchors and images. A scheme other than
// https is the ordinary way that becomes an execution surface.
for (const hostile of [
  "javascript:alert(1)",
  "data:text/html;base64,PHNjcmlwdD4=",
  "http://example.org/x",
  "https://example.org/ onmouseover=alert(1)",
]) {
  refuses(`an avatar URL of ${hostile.slice(0, 28)} is refused`,
    () => normalizeMaintainerProfile({ wallet: WALLET, avatar_url: hostile }));
  refuses(`a link URL of ${hostile.slice(0, 28)} is refused`,
    () => normalizeMaintainerProfile({ wallet: WALLET, links_public: [{ label: "x", url: hostile }] }));
}
{
  const projected = publicMaintainerProfile({
    wallet: WALLET,
    avatar_url: "javascript:alert(1)",
    links_public: [{ label: "bad", url: "javascript:alert(1)" }, { label: "good", url: "https://x.com/a" }],
  });
  ok("the projection drops a non-https avatar even if one reached storage", projected.avatar_url === null);
  ok("the projection drops a non-https link and keeps the rest",
    projected.links_public.length === 1 && projected.links_public[0].url === "https://x.com/a");
}

// Bounded input, so a profile cannot become an unbounded page.
refuses("an over-long display name is refused",
  () => normalizeMaintainerProfile({ wallet: WALLET, display_name: "x".repeat(MAINTAINER_PROFILE_LIMITS.DISPLAY_NAME + 1) }));
refuses("an over-long bio is refused",
  () => normalizeMaintainerProfile({ wallet: WALLET, bio: "x".repeat(MAINTAINER_PROFILE_LIMITS.BIO + 1) }));
refuses("too many expertise tags are refused",
  () => normalizeExpertise(Array.from({ length: MAINTAINER_PROFILE_LIMITS.EXPERTISE_ITEMS + 1 }, (_, i) => `tag${i}`)));
refuses("too many links are refused",
  () => normalizeLinks(Array.from({ length: MAINTAINER_PROFILE_LIMITS.LINKS + 1 }, (_, i) => ({ label: `l${i}`, url: `https://example.org/${i}` }))));
refuses("an expertise tag with markup is refused", () => normalizeExpertise(["<script>"]));
refuses("a wallet that is not base58 is refused",
  () => normalizeMaintainerProfile({ wallet: "not-a-wallet" }), "bad_wallet");

// Normalization is total: a partial payload clears what it omits rather than
// silently keeping older text, so a field can actually be emptied.
{
  const normalized = normalizeMaintainerProfile({ wallet: WALLET, display_name: "  Aksusarya  " });
  ok("omitted fields normalize to null and empty lists rather than staying undefined",
    normalized.display_name === "Aksusarya" && normalized.bio === null && normalized.avatar_url === null
    && normalized.proof_of_work_url === null
    && Array.isArray(normalized.expertise_public) && normalized.expertise_public.length === 0
    && Array.isArray(normalized.links_public) && normalized.links_public.length === 0);
  ok("a blank string clears the field instead of storing whitespace",
    normalizeMaintainerProfile({ wallet: WALLET, bio: "   " }).bio === null);
}
{
  const tags = normalizeExpertise(["OSINT", "osint", " fund_flow ", ""]);
  ok("expertise tags are lowercased, de-duplicated, trimmed and ordered",
    tags.length === 2 && tags[0] === "fund_flow" && tags[1] === "osint");
  const links = normalizeLinks([
    { label: "X", url: "https://x.com/a" },
    { label: "again", url: "https://x.com/a" },
    { url: "https://github.com/a" },
  ]);
  ok("duplicate links collapse and a missing label becomes empty rather than undefined",
    links.length === 2 && links[0].label === "X" && links[1].label === "");
}

// The record must stay out of anything that counts analysts. The bootstrap
// ladder reads analyst_profiles by status, so the guarantee is that this record
// lives elsewhere and carries no status at all.
{
  const normalized = normalizeMaintainerProfile({ wallet: WALLET, display_name: "Aksusarya" });
  ok("a normalized profile carries no status, tier, weight or approval flag",
    !("status" in normalized) && !("tier_code" in normalized)
    && !("weight_cached" in normalized) && !("approved" in normalized) && !("verified" in normalized));
}

process.stdout.write(`Maintainer profile core: ${passed} passed\n`);
