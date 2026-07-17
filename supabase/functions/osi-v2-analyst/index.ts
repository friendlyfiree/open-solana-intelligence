// Native V2 analyst gateway. Public reads expose approved profiles only.
// Private reads use durable wallet challenges. Every mutation uses an exact
// Stage-5 nonce and immutable receipt; maintainer operations independently
// revalidate the configured wallet and Supabase auth UUID.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  payloadHash,
  randomNonce,
  requestFingerprint,
  sha256HexUtf8,
  trustedClientAddress,
  validateWallet,
  verifyEd25519Signature,
} from "../_shared/osi-v2-proof-core.mjs";
import {
  buildChallenge,
  challengeSigningInput,
  parseChallenge,
  validateChallengeBinding,
} from "../_shared/osi-v2-case-read-core.mjs";
import {
  analystProbationPayload,
  canonicalAnalystEventMessage,
  exactAnalystEventMessage,
  inspectProfileImage,
  normalizeApplicationPayload,
  normalizeApplicationReview,
  publicAnalystDto,
} from "../_shared/osi-v2-analyst-core.mjs";
import {
  maintainerGate,
  validateConfirmedMemoTransaction,
  validateIdempotencyKey,
} from "../_shared/osi-v2-case-write-core.mjs";
import {
  READ_SESSION_SCOPES,
  readSessionIssuer,
  verifyReadSessionToken,
} from "../_shared/osi-v2-read-session-core.mjs";
import { maybeReconcileSasCredential } from "../_shared/osi-v2-sas-onchain.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("OSI_V2_ALLOWED_ORIGIN") ?? "*";
const SOLANA_RPC_URL = Deno.env.get("SOLANA_RPC_URL") ?? "https://api.mainnet-beta.solana.com";
const MAINTAINER_AUTH_UUID = Deno.env.get("OSI_MAINTAINER_AUTH_UUID") ?? "";
const MAX_BODY_BYTES = 850_000;
const AVATAR_BUCKET = "osi-analyst-avatars";
const PUBLIC_PROFILE_STATUSES = ["probationary_analyst", "verified_analyst", "senior_analyst"];

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Row = Record<string, any>;
type ImageBinding = { bytes: Uint8Array; mime: "image/png" | "image/jpeg"; sha256: string };
type ReadVerification =
  | { ok: true; wallet: string }
  | { ok: false; status: number; reason: string };

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "3600",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

function safeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function isoSeconds(value: unknown): number {
  const milliseconds = Date.parse(String(value ?? ""));
  if (!Number.isFinite(milliseconds)) throw new TypeError("invalid database timestamp");
  return Math.floor(milliseconds / 1000);
}

function applicationRef(id: string): string {
  return "OSI-APP-" + id.replaceAll("-", "").slice(0, 12).toUpperCase();
}

async function analystRef(wallet: string): Promise<string> {
  return "OSI-ANL-" + (await sha256HexUtf8(wallet)).slice(0, 12).toUpperCase();
}

function rpcFailure(error: Row | null): Response {
  const code = safeText(error?.code);
  if (code === "42501") return jsonResponse(403, { ok: false, error: "not_authorized" });
  if (["23514", "22023", "23505"].includes(code)) {
    return jsonResponse(409, { ok: false, error: code === "23505" ? "handle_unavailable" : "proof_binding_rejected" });
  }
  if (code === "40001") return jsonResponse(409, { ok: false, error: "concurrent_retry" });
  if (code === "P0001") return jsonResponse(429, { ok: false, error: "rate_limited" });
  if (code === "55000") return jsonResponse(503, { ok: false, error: "analyst_writes_disabled_or_unavailable" });
  return jsonResponse(500, { ok: false, error: "analyst_operation_failed" });
}

async function analystWritesEnabled(): Promise<boolean> {
  const { data, error } = await admin.from("osi_config").select("value")
    .eq("key", "OSI_V2_ANALYST_WRITES_ENABLED").limit(1);
  return !error && data?.[0]?.value === "true";
}

async function readSessionEnabled(): Promise<boolean> {
  const { data, error } = await admin.from("osi_config").select("value")
    .eq("key", "OSI_V2_READ_SESSION_ENABLED").limit(1);
  return !error && data?.[0]?.value === "true";
}

async function configuredAdminWallet(): Promise<string> {
  const { data } = await admin.from("osi_config").select("value")
    .eq("key", "admin_wallet").limit(1);
  const wallet = safeText(data?.[0]?.value);
  try { return validateWallet(wallet); } catch { return ""; }
}

async function authenticatedMaintainerId(req: Request): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(MAINTAINER_AUTH_UUID)) return "";
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return "";
  try {
    const { data, error } = await admin.auth.getUser(token);
    return !error && data?.user?.id === MAINTAINER_AUTH_UUID ? data.user.id : "";
  } catch { return ""; }
}

async function fullMaintainer(req: Request, wallet: string) {
  const [adminWallet, authId] = await Promise.all([
    configuredAdminWallet(),
    authenticatedMaintainerId(req),
  ]);
  const gate = maintainerGate(!!authId, wallet, adminWallet);
  return { ...gate, auth_id: gate.ok ? authId : "" };
}

async function fingerprint(req: Request): Promise<string> {
  return await requestFingerprint(
    SERVICE_ROLE_KEY + "\u0000osi-v2-analyst",
    trustedClientAddress(req.headers),
  );
}

function bytesFromBase64(value: unknown): Uint8Array {
  const input = safeText(value);
  if (!input || input.length > 750_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input)) {
    throw new TypeError("avatar data is invalid");
  }
  let binary: string;
  try { binary = atob(input); } catch { throw new TypeError("avatar data is invalid"); }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", owned));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function imageBinding(application: unknown): Promise<ImageBinding | null> {
  const avatar = (application && typeof application === "object" && !Array.isArray(application))
    ? (application as Row).avatar : null;
  if (avatar == null) return null;
  if (!avatar || typeof avatar !== "object" || Array.isArray(avatar)) {
    throw new TypeError("avatar is invalid");
  }
  const mime = safeText((avatar as Row).mime) as "image/png" | "image/jpeg";
  const bytes = bytesFromBase64((avatar as Row).data_base64);
  inspectProfileImage(bytes, mime);
  return { bytes, mime, sha256: await sha256Bytes(bytes) };
}

async function normalizedApplication(body: Row) {
  const image = await imageBinding(body.application);
  const input = { ...(body.application as Row) };
  delete input.avatar;
  return { payload: normalizeApplicationPayload(input, image), image };
}

async function uploadAvatar(wallet: string, image: ImageBinding | null): Promise<string | null> {
  if (!image) return null;
  // The object key is immutable and content-addressed. A failed database
  // commit can leave an unreferenced object, but can never replace the avatar
  // referenced by the last committed profile version.
  const path = (await sha256HexUtf8(wallet)) + "/" + image.sha256;
  const { error } = await admin.storage.from(AVATAR_BUCKET).upload(path, image.bytes, {
    contentType: image.mime,
    cacheControl: "3600",
    upsert: true,
  });
  if (error) throw new Error("avatar_upload_failed");
  const { data } = admin.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  const url = safeText(data?.publicUrl);
  if (!url.startsWith(SUPABASE_URL + "/storage/v1/object/public/" + AVATAR_BUCKET + "/")) {
    throw new Error("avatar_url_invalid");
  }
  return url;
}

async function issueAnalystNonce(args: Row) {
  return await admin.rpc("osi_v2_issue_analyst_nonce", args);
}

async function loadBoundNonce(nonce: string) {
  const { data, error } = await admin.from("osi_nonces")
    .select("nonce,purpose,actor_wallet,target_type,target_id,payload_hash,issued_at,expires_at,consumed_at")
    .eq("nonce", nonce).limit(1);
  return { row: data?.[0] ?? null, error };
}

function bindingFromNonce(row: Row, targetRef: string, role: string, decision: string) {
  return {
    purpose: String(row.purpose),
    target_type: String(row.target_type),
    target_ref: targetRef,
    actor_wallet: String(row.actor_wallet),
    actor_role: role,
    decision,
    nonce: String(row.nonce),
    payload_hash: String(row.payload_hash),
    issued_at: isoSeconds(row.issued_at),
    expires_at: isoSeconds(row.expires_at),
  };
}

async function verifyMemoTransaction(
  txSig: string,
  wallet: string,
  memo: string,
  issuedAt: number,
  expiresAt: number,
) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(txSig)) {
    return { ok: false, reason: "bad_transaction_signature" };
  }
  let response: Response;
  try {
    response = await fetch(SOLANA_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "getTransaction", params: [txSig, {
          commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0,
        }] },
        { jsonrpc: "2.0", id: 2, method: "getSignatureStatuses", params: [[txSig], {
          searchTransactionHistory: true,
        }] },
      ]),
    });
  } catch { return { ok: false, reason: "rpc_unavailable" }; }
  if (!response.ok) return { ok: false, reason: "rpc_unavailable" };
  let results: any[];
  try { results = await response.json() as any[]; } catch { return { ok: false, reason: "rpc_invalid_response" }; }
  const transaction = results.find((item) => item.id === 1)?.result;
  const status = results.find((item) => item.id === 2)?.result?.value?.[0];
  return validateConfirmedMemoTransaction(transaction, status, {
    tx_sig: txSig, wallet, memo, issued_at: issuedAt, expires_at: expiresAt,
  });
}

async function prepareApplication(req: Request, body: Row): Promise<Response> {
  if (!await analystWritesEnabled()) return jsonResponse(503, { ok: false, error: "analyst_writes_disabled" });
  const wallet = safeText(body.wallet);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  let normalized: Awaited<ReturnType<typeof normalizedApplication>>;
  let idempotencyKey: string;
  try {
    normalized = await normalizedApplication(body);
    idempotencyKey = validateIdempotencyKey(body.idempotency_key);
  } catch (error) {
    return jsonResponse(400, { ok: false, error: errorMessage(error) || "bad_application" });
  }
  const hash = await payloadHash(normalized.payload);
  const { data, error } = await issueAnalystNonce({
    p_nonce: randomNonce(),
    p_purpose: "ANALYST_APPLICATION_VERSION_SUBMITTED",
    p_actor_wallet: wallet,
    p_actor_role: "wallet",
    p_target_id: null,
    p_payload_hash: hash,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint_hash: await fingerprint(req),
  });
  if (error || !data?.[0]) return rpcFailure(error);
  const issued = data[0];
  const decision = Number(issued.version_no) > 1 ? "revise" : "submit";
  const binding = {
    purpose: "ANALYST_APPLICATION_VERSION_SUBMITTED",
    target_type: "application_version",
    target_ref: issued.public_ref,
    actor_wallet: wallet,
    actor_role: "wallet",
    decision,
    nonce: issued.issued_nonce,
    payload_hash: hash,
    issued_at: isoSeconds(issued.issued_at),
    expires_at: isoSeconds(issued.expires_at),
  };
  return jsonResponse(200, {
    ok: true,
    nonce: issued.issued_nonce,
    version_ref: issued.public_ref,
    version_no: issued.version_no,
    payload_hash: hash,
    message: canonicalAnalystEventMessage(binding),
    expires_at: binding.expires_at,
    proof_type: "wallet_signed_server_verified",
  });
}

async function currentApplicationDecision(wallet: string, targetId: string): Promise<"submit" | "revise"> {
  const { data: committedVersions } = await admin.from("analyst_application_versions")
    .select("version_no,created_by_wallet").eq("id", targetId)
    .eq("created_by_wallet", wallet).limit(1);
  const { data } = await admin.from("analyst_applications").select("status")
    .eq("applicant_wallet", wallet)
    .in("status", ["submitted", "in_review", "revision_requested"])
    .order("created_at", { ascending: false }).limit(1);
  return data?.[0]?.status === "revision_requested" || Number(committedVersions?.[0]?.version_no ?? 0) > 1
    ? "revise" : "submit";
}

async function commitApplication(body: Row): Promise<Response> {
  if (!await analystWritesEnabled()) return jsonResponse(503, { ok: false, error: "analyst_writes_disabled" });
  const wallet = safeText(body.wallet);
  const nonce = safeText(body.nonce);
  const message = safeText(body.message);
  const signature = safeText(body.signature);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  let normalized: Awaited<ReturnType<typeof normalizedApplication>>;
  try { normalized = await normalizedApplication(body); }
  catch (error) { return jsonResponse(400, { ok: false, error: errorMessage(error) || "bad_application" }); }
  const hash = await payloadHash(normalized.payload);
  const nonceResult = await loadBoundNonce(nonce);
  const bound = nonceResult.row;
  if (nonceResult.error || !bound || bound.purpose !== "ANALYST_APPLICATION_VERSION_SUBMITTED") {
    return jsonResponse(409, { ok: false, error: "unknown_or_wrong_nonce" });
  }
  const targetRef = applicationRef(String(bound.target_id));
  const decision = await currentApplicationDecision(wallet, String(bound.target_id));
  const binding = bindingFromNonce(bound, targetRef, "wallet", decision);
  if (bound.actor_wallet !== wallet || bound.payload_hash !== hash
      || !exactAnalystEventMessage(message, binding, Math.floor(Date.now() / 1000))) {
    return jsonResponse(409, { ok: false, error: "proof_binding_rejected" });
  }
  if (!await verifyEd25519Signature(message, signature, wallet)) {
    return jsonResponse(403, { ok: false, error: "bad_signature" });
  }
  let avatarUrl: string | null;
  try { avatarUrl = await uploadAvatar(wallet, normalized.image); }
  catch (error) { return jsonResponse(503, { ok: false, error: errorMessage(error) || "avatar_upload_failed" }); }
  const { data, error } = await admin.rpc("osi_v2_commit_analyst_application", {
    p_nonce: nonce,
    p_payload_hash: hash,
    p_signature: signature,
    p_handle: normalized.payload.profile.handle,
    p_display_name: normalized.payload.profile.display_name,
    p_bio: normalized.payload.profile.bio,
    p_expertise_public: normalized.payload.profile.expertise,
    p_links_public: normalized.payload.profile.links,
    p_details_restricted: normalized.payload.application,
    p_avatar_url: avatarUrl,
    p_avatar_sha256: normalized.image?.sha256 ?? null,
    p_avatar_mime: normalized.image?.mime ?? null,
  });
  if (error || !data?.[0]) return rpcFailure(error);
  return jsonResponse(200, {
    ok: true,
    application: {
      id: data[0].application_id,
      version_id: data[0].application_version_id,
      version_ref: data[0].public_ref,
      version_no: data[0].version_no,
      status: data[0].status,
    },
    proof: { label: "Wallet-signed & server-verified" },
    idempotent_replay: data[0].idempotent_replay === true,
  });
}

async function exactReviewTarget(input: Row, requireCurrent = true) {
  const { data: versions, error } = await admin.from("analyst_application_versions")
    .select("id,application_id,version_no")
    .eq("id", input.application_version_id).limit(1);
  const version = versions?.[0];
  if (error || !version || applicationRef(String(version.id)) !== input.version_ref) return null;
  const { data: applications } = await admin.from("analyst_applications")
    .select("id,applicant_wallet,current_version_id,status")
    .eq("id", version.application_id).limit(1);
  const application = applications?.[0];
  if (!application || (requireCurrent && (application.current_version_id !== version.id || application.status !== "in_review"))) return null;
  return { version, application };
}

async function prepareReview(req: Request, body: Row): Promise<Response> {
  if (!await analystWritesEnabled()) return jsonResponse(503, { ok: false, error: "analyst_writes_disabled" });
  const wallet = safeText(body.wallet);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  const gate = await fullMaintainer(req, wallet);
  if (!gate.ok) return jsonResponse(403, { ok: false, error: gate.reason });
  let input: Row;
  let idempotencyKey: string;
  try {
    input = normalizeApplicationReview(body.review);
    idempotencyKey = validateIdempotencyKey(body.idempotency_key);
  } catch (error) { return jsonResponse(400, { ok: false, error: errorMessage(error) || "bad_review" }); }
  const target = await exactReviewTarget(input);
  if (!target) return jsonResponse(404, { ok: false, error: "not_found_or_not_reviewable" });
  if (target.application.applicant_wallet === wallet) return jsonResponse(403, { ok: false, error: "self_review_denied" });
  const { data: history } = await admin.from("analyst_application_reviews").select("id")
    .eq("application_version_id", input.application_version_id)
    .eq("reviewer_wallet", wallet).limit(1);
  const purpose = history?.length ? "ANALYST_APPLICATION_REVIEW_REVISED" : "ANALYST_APPLICATION_REVIEW_CAST";
  const signedPayload = { ...input, actor_role: "maintainer", maintainer_auth_id: gate.auth_id };
  const hash = await payloadHash(signedPayload);
  const { data, error } = await issueAnalystNonce({
    p_nonce: randomNonce(), p_purpose: purpose, p_actor_wallet: wallet,
    p_actor_role: "maintainer", p_target_id: input.application_version_id,
    p_payload_hash: hash, p_idempotency_key: idempotencyKey,
    p_request_fingerprint_hash: await fingerprint(req),
  });
  if (error || !data?.[0]) return rpcFailure(error);
  const issued = data[0];
  const binding = {
    purpose, target_type: "application_version", target_ref: input.version_ref,
    actor_wallet: wallet, actor_role: "maintainer", decision: input.decision,
    nonce: issued.issued_nonce, payload_hash: hash,
    issued_at: isoSeconds(issued.issued_at), expires_at: isoSeconds(issued.expires_at),
  };
  return jsonResponse(200, {
    ok: true, nonce: issued.issued_nonce, payload_hash: hash,
    message: canonicalAnalystEventMessage(binding), expires_at: binding.expires_at,
    proof_type: "wallet_signed_server_verified", counted_weight: 0,
  });
}

async function commitReview(req: Request, body: Row): Promise<Response> {
  if (!await analystWritesEnabled()) return jsonResponse(503, { ok: false, error: "analyst_writes_disabled" });
  const wallet = safeText(body.wallet);
  const nonce = safeText(body.nonce);
  const message = safeText(body.message);
  const signature = safeText(body.signature);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  const gate = await fullMaintainer(req, wallet);
  if (!gate.ok) return jsonResponse(403, { ok: false, error: gate.reason });
  let input: Row;
  try { input = normalizeApplicationReview(body.review); }
  catch (error) { return jsonResponse(400, { ok: false, error: errorMessage(error) || "bad_review" }); }
  const nonceResult = await loadBoundNonce(nonce);
  const bound = nonceResult.row;
  if (nonceResult.error || !bound || !["ANALYST_APPLICATION_REVIEW_CAST", "ANALYST_APPLICATION_REVIEW_REVISED"].includes(bound.purpose)) {
    return jsonResponse(409, { ok: false, error: "unknown_or_wrong_nonce" });
  }
  const target = await exactReviewTarget(input, bound.consumed_at != null ? false : true);
  if (!target) return jsonResponse(404, { ok: false, error: "not_found_or_not_reviewable" });
  if (target.application.applicant_wallet === wallet) return jsonResponse(403, { ok: false, error: "self_review_denied" });
  const hash = await payloadHash({ ...input, actor_role: "maintainer", maintainer_auth_id: gate.auth_id });
  const binding = bindingFromNonce(bound, input.version_ref, "maintainer", input.decision);
  if (bound.actor_wallet !== wallet || bound.target_id !== input.application_version_id
      || bound.payload_hash !== hash
      || !exactAnalystEventMessage(message, binding, Math.floor(Date.now() / 1000))) {
    return jsonResponse(409, { ok: false, error: "proof_binding_rejected" });
  }
  if (!await verifyEd25519Signature(message, signature, wallet)) {
    return jsonResponse(403, { ok: false, error: "bad_signature" });
  }
  const { data, error } = await admin.rpc("osi_v2_commit_application_review", {
    p_nonce: nonce, p_payload_hash: hash, p_signature: signature,
    p_decision: input.decision, p_reason_code: input.reason_code,
  });
  if (error || !data?.[0]) return rpcFailure(error);
  return jsonResponse(200, {
    ok: true,
    application_id: data[0].application_id,
    application_version_id: data[0].application_version_id,
    status: data[0].status,
    activation_ready: data[0].activation_ready === true,
    proof: { label: "Wallet-signed & server-verified" },
    next_step: data[0].activation_ready === true
      ? "Confirm the exact ANALYST_PROBATION Memo to activate the server-derived 0.50 probationary tier."
      : "The immutable application decision is complete.",
    idempotent_replay: data[0].idempotent_replay === true,
  });
}

async function activationTarget(input: Row, maintainerWallet: string, allowApproved = false) {
  const wallet = safeText(input.analyst_wallet);
  try { validateWallet(wallet); } catch { return null; }
  const versionId = safeText(input.application_version_id);
  const versionRef = safeText(input.version_ref);
  if (applicationRef(versionId) !== versionRef || wallet === maintainerWallet) return null;
  const { data: applications } = await admin.from("analyst_applications")
    .select("id,applicant_wallet,current_version_id,status")
    .eq("applicant_wallet", wallet).eq("current_version_id", versionId)
    .in("status", allowApproved ? ["in_review", "approved"] : ["in_review"]).limit(1);
  const application = applications?.[0];
  if (!application) return null;
  const { data: reviews } = await admin.from("analyst_application_reviews")
    .select("id,reviewer_wallet,decision,weight,is_active,event_receipt_id")
    .eq("application_version_id", versionId).eq("reviewer_wallet", maintainerWallet)
    .eq("decision", "approve").eq("weight", 0).eq("is_active", true).limit(1);
  return reviews?.[0] ? { wallet, versionId, versionRef, application } : null;
}

async function prepareActivation(req: Request, body: Row): Promise<Response> {
  if (!await analystWritesEnabled()) return jsonResponse(503, { ok: false, error: "analyst_writes_disabled" });
  const wallet = safeText(body.wallet);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  const gate = await fullMaintainer(req, wallet);
  if (!gate.ok) return jsonResponse(403, { ok: false, error: gate.reason });
  const target = await activationTarget(body.activation as Row, wallet);
  if (!target) return jsonResponse(404, { ok: false, error: "not_ready_for_probation" });
  let idempotencyKey: string;
  try { idempotencyKey = validateIdempotencyKey(body.idempotency_key); }
  catch { return jsonResponse(400, { ok: false, error: "bad_idempotency_key" }); }
  const signedPayload = {
    ...analystProbationPayload(target.wallet, target.versionId, target.versionRef),
    maintainer_auth_id: gate.auth_id,
  };
  const hash = await payloadHash(signedPayload);
  const { data, error } = await issueAnalystNonce({
    p_nonce: randomNonce(), p_purpose: "ANALYST_PROBATION",
    p_actor_wallet: wallet, p_actor_role: "maintainer",
    p_target_id: target.wallet, p_payload_hash: hash,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint_hash: await fingerprint(req),
  });
  if (error || !data?.[0]) return rpcFailure(error);
  const issued = data[0];
  const binding = {
    purpose: "ANALYST_PROBATION", target_type: "analyst",
    target_ref: issued.public_ref, actor_wallet: wallet,
    actor_role: "maintainer", decision: "probation",
    nonce: issued.issued_nonce, payload_hash: hash,
    issued_at: isoSeconds(issued.issued_at), expires_at: isoSeconds(issued.expires_at),
  };
  return jsonResponse(200, {
    ok: true, nonce: issued.issued_nonce, analyst_ref: issued.public_ref,
    payload_hash: hash, memo: canonicalAnalystEventMessage(binding),
    expires_at: binding.expires_at, proof_type: "solana_memo",
    derived_outcome: { status: "probationary_analyst", tier_code: "probationary", weight: "0.50" },
  });
}

async function commitActivation(req: Request, body: Row): Promise<Response> {
  if (!await analystWritesEnabled()) return jsonResponse(503, { ok: false, error: "analyst_writes_disabled" });
  const wallet = safeText(body.wallet);
  const nonce = safeText(body.nonce);
  const memo = safeText(body.memo);
  const txSig = safeText(body.tx_sig);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  const gate = await fullMaintainer(req, wallet);
  if (!gate.ok) return jsonResponse(403, { ok: false, error: gate.reason });
  const target = await activationTarget(body.activation as Row, wallet, true);
  if (!target) return jsonResponse(404, { ok: false, error: "not_ready_for_probation" });
  const hash = await payloadHash({
    ...analystProbationPayload(target.wallet, target.versionId, target.versionRef),
    maintainer_auth_id: gate.auth_id,
  });
  const nonceResult = await loadBoundNonce(nonce);
  const bound = nonceResult.row;
  if (nonceResult.error || !bound || bound.purpose !== "ANALYST_PROBATION") {
    return jsonResponse(409, { ok: false, error: "unknown_or_wrong_nonce" });
  }
  const targetRef = await analystRef(target.wallet);
  const binding = bindingFromNonce(bound, targetRef, "maintainer", "probation");
  if (bound.actor_wallet !== wallet || bound.target_id !== target.wallet
      || bound.payload_hash !== hash
      || !exactAnalystEventMessage(memo, binding, Math.floor(Date.now() / 1000))) {
    return jsonResponse(409, { ok: false, error: "proof_binding_rejected" });
  }
  const chain = await verifyMemoTransaction(txSig, wallet, memo, binding.issued_at, binding.expires_at);
  if (!chain.ok) return jsonResponse(409, { ok: false, error: chain.reason });
  const { data, error } = await admin.rpc("osi_v2_commit_analyst_probation", {
    p_nonce: nonce, p_payload_hash: hash, p_tx_sig: txSig,
    p_memo_ref: memo, p_occurred_at: (chain as { occurred_at: string }).occurred_at,
  });
  if (error || !data?.[0]) return rpcFailure(error);
  // D19 Step 1: additive, best-effort SAS credential reconciliation. Analyst
  // activation (DB state + Memo) has already succeeded above; this never blocks
  // or fails the activation and is a logged no-op until Step 0 pubkeys exist.
  await maybeReconcileSasCredential(admin, {
    wallet: data[0].analyst_wallet,
    status: data[0].status,
  });
  return jsonResponse(200, {
    ok: true,
    analyst: {
      wallet: data[0].analyst_wallet,
      status: data[0].status,
      tier_code: data[0].tier_code,
      weight: Number(data[0].weight),
    },
    proof: { label: "Memo-anchored on Solana", tx_sig: txSig },
    idempotent_replay: data[0].idempotent_replay === true,
  });
}

async function hmacHex(input: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SERVICE_ROLE_KEY + "\u0000osi-v2-analyst-read"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index++) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

async function issueReadChallenge(req: Request, body: Row): Promise<Response> {
  const wallet = safeText(body.wallet);
  const purpose = safeText(body.purpose);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  if (!["ANALYST_READ_MY_WORKSPACE", "ANALYST_READ_MAINTAINER_QUEUE"].includes(purpose)) {
    return jsonResponse(400, { ok: false, error: "bad_read_purpose" });
  }
  if (purpose === "ANALYST_READ_MAINTAINER_QUEUE") {
    const gate = await fullMaintainer(req, wallet);
    if (!gate.ok) return jsonResponse(403, { ok: false, error: gate.reason });
  }
  const nonce = randomNonce();
  const issuedAt = Math.floor(Date.now() / 1000);
  const target = { target_type: "analyst", target_id: wallet };
  const { data, error } = await admin.rpc("osi_v2_issue_read_nonce", {
    p_nonce: nonce, p_purpose: purpose, p_actor_wallet: wallet,
    p_target_type: target.target_type, p_target_id: target.target_id,
    p_request_fingerprint_hash: await fingerprint(req),
  });
  if (error || !data?.[0]) return rpcFailure(error);
  const fields = {
    purpose, ...target, wallet, nonce,
    issued_at: isoSeconds(data[0].issued_at), expires_at: isoSeconds(data[0].expires_at),
  };
  const mac = await hmacHex(challengeSigningInput(fields));
  return jsonResponse(200, { ok: true, challenge: buildChallenge(fields, mac), expires_at: fields.expires_at });
}

async function verifyRead(body: Row, purpose: string): Promise<ReadVerification> {
  const wallet = safeText(body.wallet);
  const challenge = safeText(body.challenge);
  const signature = safeText(body.signature);
  try { validateWallet(wallet); } catch { return { ok: false, status: 400, reason: "bad_wallet" }; }
  const fields = parseChallenge(challenge);
  if (!fields) return { ok: false, status: 400, reason: "bad_challenge" };
  const binding = validateChallengeBinding(fields, {
    purpose, target_type: "analyst", target_id: wallet, wallet,
  }, Math.floor(Date.now() / 1000));
  if (!binding.ok) return { ok: false, status: 403, reason: binding.reason || "bad_challenge" };
  const expectedMac = await hmacHex(challengeSigningInput(fields));
  if (!equalHex(fields.hmac, expectedMac)) return { ok: false, status: 403, reason: "bad_challenge" };
  if (!await verifyEd25519Signature(challenge, signature, wallet)) {
    return { ok: false, status: 403, reason: "bad_signature" };
  }
  const { data, error } = await admin.rpc("osi_v2_consume_read_nonce", {
    p_nonce: fields.nonce, p_purpose: purpose, p_actor_wallet: wallet,
    p_target_type: "analyst", p_target_id: wallet,
  });
  if (error) return { ok: false, status: 503, reason: "challenge_unavailable" };
  if (data !== true) return { ok: false, status: 409, reason: "replayed_or_expired" };
  return { ok: true, wallet };
}

async function verifyReadSession(req: Request, body: Row, requiredScope: string): Promise<ReadVerification> {
  if (!await readSessionEnabled()) {
    return { ok: false, status: 503, reason: "read_session_disabled_or_unavailable" };
  }
  const verified = await verifyReadSessionToken({
    token: safeText(body.read_session),
    secret: SERVICE_ROLE_KEY,
    issuer: readSessionIssuer(SUPABASE_URL),
    origin: req.headers.get("origin") ?? "",
    allowedOrigin: ALLOWED_ORIGIN,
    wallet: safeText(body.wallet),
    requiredScope,
  });
  if (verified.ok === true && typeof verified.wallet === "string") {
    return { ok: true, wallet: verified.wallet };
  }
  return {
    ok: false,
    status: typeof verified.status === "number" ? verified.status : 403,
    reason: typeof verified.reason === "string" ? verified.reason : "read_session_tampered",
  };
}

async function profileGraph(profiles: Row[]) {
  const wallets = profiles.map((profile) => String(profile.wallet));
  const walletSet = new Set(wallets);
  const contributions: Record<string, Row[]> = {};
  const receipts: Record<string, Row[]> = {};
  if (!wallets.length) return { contributions, receipts };
  const [{ data: contributionRows }, { data: actorReceipts }, { data: targetReceipts }, { data: supportReceipts }] = await Promise.all([
    admin.from("analyst_contributions")
      .select("analyst_wallet,kind,subject_type,subject_id,created_at")
      .in("analyst_wallet", wallets).order("created_at", { ascending: false }).limit(300),
    admin.from("event_receipts")
      .select("event_type,actor_wallet,actor_role,decision,proof_type,tx_sig,server_verified,occurred_at")
      .in("actor_wallet", wallets).eq("server_verified", true)
      .order("occurred_at", { ascending: false }).limit(500),
    admin.from("event_receipts")
      .select("event_type,target_id,actor_wallet,actor_role,decision,proof_type,tx_sig,server_verified,occurred_at")
      .eq("target_type", "analyst").in("target_id", wallets).eq("server_verified", true)
      .order("occurred_at", { ascending: false }).limit(200),
    admin.from("event_receipts")
      .select("event_type,actor_wallet,actor_role,decision,proof_type,tx_sig,memo_ref,server_verified,occurred_at,verification_metadata")
      .eq("event_type", "SUPPORT_PAYMENT_CONFIRMED").eq("proof_type", "solana_memo")
      .eq("server_verified", true).order("occurred_at", { ascending: false }).limit(500),
  ]);
  for (const row of contributionRows ?? []) (contributions[String(row.analyst_wallet)] ??= []).push(row);
  for (const row of actorReceipts ?? []) (receipts[String(row.actor_wallet)] ??= []).push(row);
  for (const row of targetReceipts ?? []) (receipts[String(row.target_id)] ??= []).push(row);
  for (const row of supportReceipts ?? []) {
    const metadata = row.verification_metadata && typeof row.verification_metadata === "object"
      ? row.verification_metadata : {};
    const manifest = Array.isArray(metadata.recipient_manifest) ? metadata.recipient_manifest : [];
    for (const recipient of manifest) {
      const wallet = String(recipient?.wallet ?? "");
      if (!walletSet.has(wallet)) continue;
      (receipts[wallet] ??= []).push({
        ...row,
        recipient_amount_lamports: String(recipient?.amount_lamports ?? ""),
        payment_total_lamports: String(metadata.total_lamports ?? ""),
        payment_target_public_ref: String(metadata.target_public_ref ?? ""),
        payment_finality: String(metadata.finality ?? ""),
        payment_slot: String(metadata.slot ?? ""),
        payment_block_time: metadata.block_time ?? null,
      });
    }
  }
  return { contributions, receipts };
}

const PROFILE_COLS = "wallet,handle,display_name,bio,avatar_url,expertise_public,links_public,status,tier_code,weight_cached,created_at,updated_at";

async function listPublicProfiles(): Promise<Response> {
  const { data, error } = await admin.from("analyst_profiles").select(PROFILE_COLS)
    .in("status", PUBLIC_PROFILE_STATUSES).eq("verified", true).eq("approved", true)
    .order("updated_at", { ascending: false }).limit(100);
  if (error) return jsonResponse(503, { ok: false, error: "public_profiles_unavailable" });
  const graph = await profileGraph(data ?? []);
  return jsonResponse(200, {
    ok: true,
    analysts: (data ?? []).map((profile) => publicAnalystDto(
      profile, graph.contributions[String(profile.wallet)] ?? [], graph.receipts[String(profile.wallet)] ?? [],
    )),
  });
}

async function myWorkspace(req: Request, body: Row): Promise<Response> {
  const verified = await verifyReadSession(req, body, READ_SESSION_SCOPES.ANALYST_WORKSPACE);
  if (!verified.ok) return jsonResponse(verified.status, { ok: false, error: verified.reason });
  const wallet = verified.wallet;
  const [{ data: profiles }, { data: applications }] = await Promise.all([
    admin.from("analyst_profiles").select(PROFILE_COLS + ",verified,approved").eq("wallet", wallet).limit(1),
    admin.from("analyst_applications")
      .select("id,applicant_wallet,origin,status,current_version_id,created_at,updated_at")
      .eq("applicant_wallet", wallet).order("created_at", { ascending: false }).limit(20),
  ]);
  const applicationIds = (applications ?? []).map((row) => String(row.id));
  const { data: versions } = applicationIds.length
    ? await admin.from("analyst_application_versions")
      .select("id,application_id,version_no,expertise_public,details_restricted,supersedes_version_id,revision_reason_code,submitted_at,created_at")
      .in("application_id", applicationIds).order("version_no", { ascending: false }).limit(100)
    : { data: [] as Row[] };
  const versionIds = (versions ?? []).map((row) => String(row.id));
  const { data: reviews } = versionIds.length
    ? await admin.from("analyst_application_reviews")
      .select("application_version_id,reviewer_wallet,decision,weight,reason_code,is_active,created_at")
      .in("application_version_id", versionIds).order("created_at", { ascending: false }).limit(100)
    : { data: [] as Row[] };
  return jsonResponse(200, {
    ok: true,
    profile: profiles?.[0] ?? null,
    applications: (applications ?? []).map((application) => ({
      ...application,
      versions: (versions ?? []).filter((version) => version.application_id === application.id).map((version) => ({
        ...version,
        version_ref: applicationRef(String(version.id)),
        proof_type: "wallet_signed_server_verified",
        reviews: (reviews ?? []).filter((review) => review.application_version_id === version.id),
      })),
    })),
  });
}

async function maintainerQueue(req: Request, body: Row): Promise<Response> {
  const verified = await verifyReadSession(req, body, READ_SESSION_SCOPES.ANALYST_MAINTAINER);
  if (!verified.ok) return jsonResponse(verified.status, { ok: false, error: verified.reason });
  const gate = await fullMaintainer(req, verified.wallet);
  if (!gate.ok) return jsonResponse(403, { ok: false, error: gate.reason });
  const { data: applications, error } = await admin.from("analyst_applications")
    .select("id,applicant_wallet,status,current_version_id,created_at,updated_at")
    .in("status", ["in_review", "revision_requested"]).order("updated_at", { ascending: true }).limit(100);
  if (error) return jsonResponse(503, { ok: false, error: "queue_unavailable" });
  const versionIds = (applications ?? []).map((row) => String(row.current_version_id)).filter(Boolean);
  const wallets = (applications ?? []).map((row) => String(row.applicant_wallet));
  const [{ data: versions }, { data: profiles }, { data: reviews }] = await Promise.all([
    versionIds.length ? admin.from("analyst_application_versions")
      .select("id,application_id,version_no,expertise_public,details_restricted,supersedes_version_id,revision_reason_code,submitted_at")
      .in("id", versionIds).limit(100) : Promise.resolve({ data: [] }),
    wallets.length ? admin.from("analyst_profiles").select(PROFILE_COLS).in("wallet", wallets).limit(100)
      : Promise.resolve({ data: [] }),
    versionIds.length ? admin.from("analyst_application_reviews")
      .select("application_version_id,reviewer_wallet,decision,weight,reason_code,is_active,created_at")
      .in("application_version_id", versionIds).order("created_at", { ascending: false }).limit(200)
      : Promise.resolve({ data: [] }),
  ]);
  return jsonResponse(200, {
    ok: true,
    applications: (applications ?? []).map((application) => {
      const version = (versions ?? []).find((row: Row) => row.id === application.current_version_id) ?? null;
      return {
        ...application,
        profile: (profiles ?? []).find((row: Row) => row.wallet === application.applicant_wallet) ?? null,
        version: version ? { ...version, version_ref: applicationRef(String(version.id)) } : null,
        reviews: (reviews ?? []).filter((row: Row) => row.application_version_id === application.current_version_id),
      };
    }),
    permitted_decisions: ["approve", "reject", "request_revision"],
    abstain_available: false,
    abstain_unavailable_reason: "The canonical application review decision set does not include abstain.",
  });
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return jsonResponse(503, { ok: false, error: "not_configured" });
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return jsonResponse(413, { ok: false, error: "body_too_large" });
  }
  let body: Row;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) throw new RangeError();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError();
    body = parsed as Row;
  } catch (error) {
    return jsonResponse(error instanceof RangeError ? 413 : 400, {
      ok: false, error: error instanceof RangeError ? "body_too_large" : "bad_json",
    });
  }

  switch (body.op) {
    case "list_public_profiles": return await listPublicProfiles();
    case "issue_read_challenge": return await issueReadChallenge(req, body);
    case "my_workspace": return await myWorkspace(req, body);
    case "maintainer_queue": return await maintainerQueue(req, body);
    case "prepare_application": return await prepareApplication(req, body);
    case "commit_application": return await commitApplication(body);
    case "prepare_review": return await prepareReview(req, body);
    case "commit_review": return await commitReview(req, body);
    case "prepare_activation": return await prepareActivation(req, body);
    case "commit_activation": return await commitActivation(req, body);
    case "rollout_status": return jsonResponse(200, { ok: true, analyst_writes_enabled: await analystWritesEnabled() });
    default: return jsonResponse(400, { ok: false, error: "bad_op" });
  }
});
