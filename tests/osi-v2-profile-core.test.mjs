import assert from "node:assert/strict";
import fs from "node:fs";
import * as core from "../supabase/functions/_shared/osi-v2-profile-core.mjs";

let passed = 0;
function ok(name, condition) { assert.equal(Boolean(condition), true, name); passed++; }
function rejects(name, fn) { assert.throws(fn, undefined, name); passed++; }

const wallet = "11111111111111111111111111111111";
const normalized = core.normalizeWalletProfile({
  handle: "Chain_Sleuth", display_name: "Chain Sleuth", bio: "Public-source Solana researcher.",
  visibility: "public", attribute_public_cases: true, avatar_action: "replace",
}, { sha256: "a".repeat(64), mime: "image/png" });
ok("identity fields canonicalize without authority fields", normalized.handle === "chain_sleuth"
  && normalized.visibility === "public" && normalized.attribute_public_cases
  && !Object.hasOwn(normalized, "status") && !Object.hasOwn(normalized, "weight"));
rejects("private profiles cannot consent to public Case attribution", () => core.normalizeWalletProfile({
  handle: "owner", visibility: "private", attribute_public_cases: true,
}));
rejects("public profiles require a public name", () => core.normalizeWalletProfile({ visibility: "public" }));
rejects("secret-shaped biography is rejected", () => core.normalizeWalletProfile({
  display_name: "Owner", bio: "seed phrase alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu", visibility: "public",
}));
ok("ordinary long prose is not mistaken for a recovery phrase", core.normalizeWalletProfile({
  display_name: "Owner", visibility: "public",
  bio: "independent researcher documenting public solana activity with careful citations and reproducible methods for readers",
}).bio?.startsWith("independent researcher"));
rejects("unbound avatar bytes are rejected", () => core.normalizeWalletProfile({
  handle: "owner", visibility: "private", avatar_action: "replace",
}));
ok("flag parsing fails closed", core.isProfileWritesEnabled("true") && !core.isProfileWritesEnabled(true) && !core.isProfileWritesEnabled("TRUE"));

const row = { public_ref: "OSI-PRF-0123456789ABCDEF", wallet, handle: "owner", display_name: "Owner",
  bio: null, avatar_url: null, visibility: "private", attribute_public_cases: false, revision: 2,
  first_published_at: "2026-08-07T00:00:00Z", updated_at: "2026-08-08T00:00:00Z" };
ok("private row never has a public DTO", core.publicWalletProfileDto(row) === null);
ok("public profile DTO omits the controlling wallet from the network response",
  !Object.hasOwn(core.publicWalletProfileDto({ ...row, visibility: "public" }), "wallet"));
ok("owner DTO retains private visibility and revision", core.ownerWalletProfileDto(row)?.visibility === "private"
  && core.ownerWalletProfileDto(row)?.revision === 2
  && core.ownerWalletProfileDto(row)?.wallet === wallet
  && core.ownerWalletProfileDto(row)?.handle_locked === true
  && !Object.hasOwn(core.ownerWalletProfileDto(row), "first_published_at"));
ok("analyst fallback stays private and cannot attribute Cases", core.ownerWalletProfileDto(null, {
  wallet, handle: "analyst", display_name: "Analyst", bio: null, avatar_url: null, updated_at: null,
})?.source === "analyst_fallback" && core.ownerWalletProfileDto(null, { wallet })?.attribute_public_cases === false
  && core.ownerWalletProfileDto(null, { wallet })?.handle_locked === false);

const edge = fs.readFileSync(new URL("../supabase/functions/osi-v2-profile/index.ts", import.meta.url), "utf8");
const migration = fs.readFileSync(new URL("../supabase/migrations/20260808163737_osi_v2_wallet_profiles.sql", import.meta.url), "utf8");
ok("gateway verifies exact wallet proof before commit", edge.includes("canonicalProofMessage")
  && edge.includes("verifyEd25519Signature") && edge.includes('row.target_type !== "profile"'));
ok("owner read uses an origin-bound wallet read session", edge.includes("verifyReadSessionToken")
  && edge.includes("READ_SESSION_SCOPES.PROFILE_SELF")
  && !edge.includes("READ_SESSION_SCOPES.ANALYST_WORKSPACE"));
ok("owner query fetches publication state only to derive the handle lock",
  edge.includes("revision,first_published_at,updated_at") && edge.includes("ownerWalletProfileDto"));
ok("public read is least privilege and visibility-bound", /select\(\s*"public_ref,handle,display_name,bio,avatar_url,visibility,updated_at",?\s*\)/.test(edge)
  && edge.includes('.eq("visibility", "public")'));
ok("avatar upload is validated and content-addressed", edge.includes("inspectProfileImage")
  && edge.includes('sha256HexUtf8(wallet)) + "/" + image.sha256'));
ok("migration is fail-closed and service-only", migration.includes("'OSI_V2_PROFILE_WRITES_ENABLED', 'false'")
  && migration.includes("force row level security")
  && migration.includes("revoke all on table public.wallet_profiles from public, anon, authenticated"));
ok("migration refuses to adopt an unknown avatar bucket or partial profile config",
  migration.includes("insert into storage.buckets")
    && !/insert into storage\.buckets[\s\S]*on conflict/i.test(migration)
    && !/OSI_V2_PROFILE_AVATAR_ORIGIN[\s\S]*on conflict/i.test(migration));
ok("database avatar binding uses the exact owned project origin and content path",
  migration.includes("'OSI_V2_PROFILE_AVATAR_ORIGIN', 'https://afibxpniwfnavdobecrn.supabase.co'")
  && migration.includes("osi_v2_profile_avatar_url_valid(wallet, avatar_url, avatar_sha256)"));
ok("profile revision and receipt commit atomically", migration.includes("expected:=bound.profile_target_revision")
  && migration.includes("WALLET_PROFILE_UPDATED") && migration.includes("consumed_by_receipt_id=new_receipt"));
ok("first publication timestamp is write-once and public-transition-only",
  migration.includes("Published profile first_published_at is immutable")
  && migration.includes("First publication requires a public transition")
  && migration.includes("before insert or update on public.wallet_profiles"));
ok("analyst mirror excludes authority fields", /update public\.analyst_profiles set\s+handle=p_handle, display_name=p_display_name, bio=p_bio,[\s\S]*?avatar_url=/.test(migration)
  && !/update public\.analyst_profiles set[^;]*(status|tier_code|weight_cached|verified|approved)=/s.test(migration));
ok("active analyst canonical handles cannot be cleared by the identity mirror",
  migration.includes("Active analyst profile requires a handle")
  && edge.includes("active_analyst_handle_required"));
ok("cross-table handle guard exists on both identity tables", migration.includes("wallet_profiles_handle_guard")
  && migration.includes("analyst_profiles_wallet_handle_guard"));

console.log(`passed ${passed}`);
