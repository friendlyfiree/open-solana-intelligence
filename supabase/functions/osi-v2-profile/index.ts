// Owner-controlled V2 wallet profile gateway. Public reads expose only an
// explicitly published projection; every write is wallet-signed and recorded.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  canonicalProofMessage,
  payloadHash,
  randomNonce,
  requestFingerprint,
  sha256HexUtf8,
  trustedClientAddress,
  validateWallet,
  verifyEd25519Signature,
} from "../_shared/osi-v2-proof-core.mjs";
import { validateIdempotencyKey } from "../_shared/osi-v2-case-write-core.mjs";
import { inspectProfileImage } from "../_shared/osi-v2-analyst-core.mjs";
import {
  isProfileWritesEnabled,
  normalizeWalletProfile,
  ownerWalletProfileDto,
  publicWalletProfileDto,
} from "../_shared/osi-v2-profile-core.mjs";
import {
  READ_SESSION_SCOPES,
  readSessionIssuer,
  verifyReadSessionToken,
} from "../_shared/osi-v2-read-session-core.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("OSI_V2_ALLOWED_ORIGIN") ?? "*";
const AVATAR_BUCKET = "osi-profile-avatars";
const MAX_BODY_BYTES = 750_000;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
type Row = Record<string, any>;
type Image = {
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
  sha256: string;
};

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}
function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}
function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
function seconds(value: unknown) {
  const n = Date.parse(String(value ?? ""));
  if (!Number.isFinite(n)) throw new TypeError("bad_timestamp");
  return Math.floor(n / 1000);
}

async function writesEnabled() {
  const { data, error } = await admin.from("osi_config").select("value").eq(
    "key",
    "OSI_V2_PROFILE_WRITES_ENABLED",
  ).limit(1);
  return !error && isProfileWritesEnabled(data?.[0]?.value);
}
async function readSessionEnabled() {
  const { data, error } = await admin.from("osi_config").select("value").eq(
    "key",
    "OSI_V2_READ_SESSION_ENABLED",
  ).limit(1);
  return !error && data?.[0]?.value === "true";
}
async function ownerWallet(req: Request, body: Row): Promise<string | null> {
  if (!await readSessionEnabled()) return null;
  const verified = await verifyReadSessionToken({
    token: text(body.read_session),
    secret: SERVICE_ROLE_KEY,
    issuer: readSessionIssuer(SUPABASE_URL),
    origin: req.headers.get("origin") ?? "",
    allowedOrigin: ALLOWED_ORIGIN,
    wallet: text(body.wallet),
    requiredScope: READ_SESSION_SCOPES.PROFILE_SELF,
  });
  return verified.ok ? verified.wallet : null;
}
function bytesFromBase64(value: unknown) {
  const encoded = text(value);
  if (
    !encoded || encoded.length > 710_000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) throw new TypeError("avatar is invalid");
  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    throw new TypeError("avatar is invalid");
  }
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
async function imageFrom(profile: Row): Promise<Image | null> {
  if (text(profile.avatar_action || "keep") !== "replace") return null;
  const avatar = profile.avatar;
  if (!avatar || typeof avatar !== "object" || Array.isArray(avatar)) {
    throw new TypeError("avatar is invalid");
  }
  const mime = text(avatar.mime) as Image["mime"];
  const bytes = bytesFromBase64(avatar.data_base64);
  inspectProfileImage(bytes, mime);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return {
    bytes,
    mime,
    sha256: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""),
  };
}
async function normalized(body: Row) {
  const submitted = body.profile && typeof body.profile === "object" &&
      !Array.isArray(body.profile)
    ? { ...body.profile }
    : {};
  const image = await imageFrom(submitted);
  delete submitted.avatar;
  return {
    profile: normalizeWalletProfile(
      submitted,
      image && { sha256: image.sha256, mime: image.mime },
    ),
    image,
  };
}
async function upload(wallet: string, image: Image) {
  const path = (await sha256HexUtf8(wallet)) + "/" + image.sha256;
  const { error } = await admin.storage.from(AVATAR_BUCKET).upload(
    path,
    image.bytes,
    { contentType: image.mime, cacheControl: "31536000", upsert: true },
  );
  if (error) throw new Error("avatar_upload_failed");
  const url = text(
    admin.storage.from(AVATAR_BUCKET).getPublicUrl(path).data?.publicUrl,
  );
  const prefix = SUPABASE_URL + "/storage/v1/object/public/" + AVATAR_BUCKET +
    "/";
  if (!url.startsWith(prefix + path)) throw new Error("avatar_url_invalid");
  return url;
}
function rpcFailure(error: Row | null) {
  const code = text(error?.code);
  const message = text(error?.message);
  if (message === "Active analyst profile requires a handle") {
    return response(409, {
      ok: false,
      error: "active_analyst_handle_required",
    });
  }
  if (code === "23505") {
    return response(409, { ok: false, error: "handle_unavailable" });
  }
  if (code === "40001") {
    return response(409, { ok: false, error: "profile_revision_changed" });
  }
  if (code === "P0001") {
    return response(429, { ok: false, error: "rate_limited" });
  }
  if (code === "55000") {
    return response(503, {
      ok: false,
      error: "profile_writes_disabled_or_unavailable",
    });
  }
  if (code === "42501") {
    return response(403, { ok: false, error: "not_authorized" });
  }
  if (["23514", "22023"].includes(code) || message.includes("binding")) {
    return response(409, { ok: false, error: "proof_binding_rejected" });
  }
  return response(500, { ok: false, error: "profile_operation_failed" });
}
async function getPublic(body: Row) {
  const publicRef = text(body.public_ref).toUpperCase();
  const handle = text(body.handle).toLowerCase();
  if (
    !/^OSI-PRF-[A-F0-9]{16}$/.test(publicRef) &&
    !/^[a-z0-9_]{2,32}$/.test(handle)
  ) return response(400, { ok: false, error: "bad_profile_reference" });
  let query = admin.from("wallet_profiles").select(
    "public_ref,handle,display_name,bio,avatar_url,visibility,updated_at",
  ).eq("visibility", "public");
  query = /^OSI-PRF-/.test(publicRef)
    ? query.eq("public_ref", publicRef)
    : query.eq("handle", handle);
  const { data, error } = await query.limit(1);
  if (error) {
    return response(503, { ok: false, error: "public_profile_unavailable" });
  }
  const profile = publicWalletProfileDto(data?.[0]);
  return profile
    ? response(200, { ok: true, profile })
    : response(404, { ok: false, error: "profile_not_found" });
}
async function getMine(req: Request, body: Row) {
  const wallet = await ownerWallet(req, body);
  if (!wallet) {
    return response(403, { ok: false, error: "owner_session_required" });
  }
  const [{ data: profiles, error }, { data: analysts }] = await Promise.all([
    admin.from("wallet_profiles").select(
      "public_ref,wallet,handle,display_name,bio,avatar_url,visibility,attribute_public_cases,revision,first_published_at,updated_at",
    ).eq("wallet", wallet).limit(1),
    admin.from("analyst_profiles").select(
      "wallet,handle,display_name,bio,avatar_url,updated_at",
    ).eq("wallet", wallet).limit(1),
  ]);
  if (error) {
    return response(503, { ok: false, error: "owner_profile_unavailable" });
  }
  return response(200, {
    ok: true,
    profile: ownerWalletProfileDto(profiles?.[0], analysts?.[0]),
  });
}
async function prepare(req: Request, body: Row) {
  if (!await writesEnabled()) {
    return response(503, {
      ok: false,
      error: "profile_writes_disabled_or_unavailable",
    });
  }
  let wallet: string;
  let input;
  try {
    wallet = validateWallet(text(body.wallet));
    validateIdempotencyKey(text(body.idempotency_key));
    input = await normalized(body);
  } catch (error) {
    return response(400, {
      ok: false,
      error: error instanceof Error ? error.message : "bad_profile",
    });
  }
  const hash = await payloadHash(input.profile);
  const fingerprint = await requestFingerprint(
    SERVICE_ROLE_KEY + "\u0000osi-v2-profile",
    trustedClientAddress(req.headers),
  );
  const { data, error } = await admin.rpc("osi_v2_issue_profile_nonce", {
    p_nonce: randomNonce(),
    p_purpose: "WALLET_PROFILE_UPDATED",
    p_actor_wallet: wallet,
    p_actor_role: "wallet",
    p_payload_hash: hash,
    p_idempotency_key: text(body.idempotency_key),
    p_request_fingerprint_hash: fingerprint,
  });
  if (error) return rpcFailure(error);
  const row = data?.[0];
  const binding = {
    purpose: "WALLET_PROFILE_UPDATED",
    actor_wallet: wallet,
    target_type: "profile",
    target_id: row.target_id,
    payload_hash: hash,
    nonce: row.issued_nonce,
    issued_at: seconds(row.issued_at),
    expires_at: seconds(row.expires_at),
  };
  return response(200, {
    ok: true,
    public_ref: row.public_ref,
    expected_revision: row.expected_revision,
    payload_hash: hash,
    nonce: row.issued_nonce,
    expires_at: row.expires_at,
    message: canonicalProofMessage(binding),
    idempotent_replay: row.idempotent_replay,
  });
}
async function commit(body: Row) {
  if (!await writesEnabled()) {
    return response(503, {
      ok: false,
      error: "profile_writes_disabled_or_unavailable",
    });
  }
  let wallet: string;
  let input;
  try {
    wallet = validateWallet(text(body.wallet));
    input = await normalized(body);
  } catch (error) {
    return response(400, {
      ok: false,
      error: error instanceof Error ? error.message : "bad_profile",
    });
  }
  const hash = await payloadHash(input.profile);
  const nonce = text(body.nonce);
  const signature = text(body.signature);
  const { data: rows, error: loadError } = await admin.from("osi_nonces")
    .select(
      "nonce,purpose,actor_wallet,target_type,target_id,payload_hash,issued_at,expires_at",
    ).eq("nonce", nonce).limit(1);
  const row = rows?.[0];
  if (
    loadError || !row || row.actor_wallet !== wallet ||
    row.payload_hash !== hash || row.purpose !== "WALLET_PROFILE_UPDATED" ||
    row.target_type !== "profile"
  ) return response(409, { ok: false, error: "proof_binding_rejected" });
  const message = canonicalProofMessage({
    purpose: row.purpose,
    actor_wallet: wallet,
    target_type: row.target_type,
    target_id: row.target_id,
    payload_hash: hash,
    nonce,
    issued_at: seconds(row.issued_at),
    expires_at: seconds(row.expires_at),
  });
  if (!await verifyEd25519Signature(message, signature, wallet)) {
    return response(403, { ok: false, error: "bad_signature" });
  }
  let avatarUrl: string | null = null;
  try {
    if (input.image) avatarUrl = await upload(wallet, input.image);
  } catch {
    return response(503, { ok: false, error: "avatar_upload_failed" });
  }
  const p = input.profile;
  const avatar = p.avatar as Row;
  const { data, error } = await admin.rpc(
    "osi_v2_commit_wallet_profile_update",
    {
      p_nonce: nonce,
      p_payload_hash: hash,
      p_signature: signature,
      p_handle: p.handle,
      p_display_name: p.display_name,
      p_bio: p.bio,
      p_visibility: p.visibility,
      p_attribute_public_cases: p.attribute_public_cases,
      p_avatar_action: avatar.action,
      p_avatar_url: avatarUrl,
      p_avatar_sha256: avatar.sha256 ?? null,
      p_avatar_mime: avatar.mime ?? null,
    },
  );
  if (error) return rpcFailure(error);
  return response(200, {
    ok: true,
    profile_id: data?.[0]?.profile_id,
    public_ref: data?.[0]?.public_ref,
    revision: data?.[0]?.revision,
    receipt_id: data?.[0]?.receipt_id,
    idempotent_replay: data?.[0]?.idempotent_replay,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return response(405, { ok: false, error: "method_not_allowed" });
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return response(503, { ok: false, error: "not_configured" });
  }
  let body: Row;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return response(413, { ok: false, error: "body_too_large" });
    }
    body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new TypeError();
    }
  } catch {
    return response(400, { ok: false, error: "bad_json" });
  }
  switch (body.op) {
    case "get_public_profile":
      return await getPublic(body);
    case "get_my_profile":
      return await getMine(req, body);
    case "prepare_profile_update":
      return await prepare(req, body);
    case "commit_profile_update":
      return await commit(body);
    case "rollout_status":
      return response(200, {
        ok: true,
        profile_writes_enabled: await writesEnabled(),
      });
    default:
      return response(400, { ok: false, error: "bad_op" });
  }
});
