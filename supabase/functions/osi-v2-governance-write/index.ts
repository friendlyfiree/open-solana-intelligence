// OSI V2 Resolution, Challenge and Case-seal write gateway.
// All browser writes are normalized here, re-authorized in PostgreSQL and
// committed only after an exact wallet signature or confirmed mainnet Memo.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  randomNonce,
  requestFingerprint,
  trustedClientAddress,
  validateWallet,
  verifyEd25519Signature,
} from "../_shared/osi-v2-proof-core.mjs";
import {
  maintainerGate,
  validateConfirmedMemoTransaction,
} from "../_shared/osi-v2-case-write-core.mjs";
import {
  GOVERNANCE_MEMO_EVENTS,
  governanceProofLabel,
  normalizeGovernancePayload,
  validateGovernanceIdempotencyKey,
  validateGovernanceProofText,
  validateGovernanceTargetRef,
} from "../_shared/osi-v2-governance-core.mjs";
import { reviewKindForGovernanceAction } from "../_shared/osi-v2-sas-core.mjs";
import { resolveReviewIdByReceipt, runShadowValidation } from "../_shared/osi-v2-sas-onchain.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("OSI_V2_ALLOWED_ORIGIN") ?? "*";
const SOLANA_RPC_URL = Deno.env.get("SOLANA_RPC_URL") ?? "https://api.mainnet-beta.solana.com";
const MAINTAINER_AUTH_UUID = Deno.env.get("OSI_MAINTAINER_AUTH_UUID") ?? "";
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const MAX_BODY_BYTES = 32_768;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Row = Record<string, any>;

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

function rpcFailure(error: Row | null): Response {
  const code = safeText(error?.code);
  if (code === "42501") return jsonResponse(403, { ok: false, error: "not_authorized_or_conflicted" });
  if (code === "23505") return jsonResponse(409, { ok: false, error: "active_challenge_exists" });
  if (code === "23514" || code === "22023") {
    return jsonResponse(409, { ok: false, error: "proof_binding_rejected" });
  }
  if (code === "40001") return jsonResponse(409, { ok: false, error: "governance_state_changed_retry" });
  if (code === "P0001") return jsonResponse(429, { ok: false, error: "rate_limited_or_cooldown" });
  if (code === "55000") {
    return jsonResponse(503, { ok: false, error: "resolution_lifecycle_writes_disabled_or_unavailable" });
  }
  return jsonResponse(500, { ok: false, error: "governance_write_failed" });
}

async function lifecycleWritesEnabled(): Promise<boolean> {
  const { data, error } = await admin.from("osi_config").select("value")
    .eq("key", "OSI_V2_RESOLUTION_LIFECYCLE_WRITES_ENABLED").limit(1);
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
    configuredAdminWallet(), authenticatedMaintainerId(req),
  ]);
  const gate = maintainerGate(!!authId, wallet, adminWallet);
  return { ...gate, auth_id: gate.ok ? authId : "" };
}

async function analystRole(wallet: string): Promise<"analyst" | "senior" | ""> {
  const { data } = await admin.from("analyst_profiles")
    .select("status,verified,approved,weight_cached")
    .eq("wallet", wallet).limit(1);
  const profile = data?.[0];
  if (!profile || profile.verified !== true || profile.approved !== true
      || !["probationary_analyst", "verified_analyst", "senior_analyst"].includes(profile.status)
      || Number(profile.weight_cached) < 0.5 || Number(profile.weight_cached) > 3) return "";
  return profile.status === "senior_analyst" ? "senior" : "analyst";
}

async function fingerprint(req: Request): Promise<string> {
  return await requestFingerprint(
    SERVICE_ROLE_KEY + "\u0000osi-v2-governance-write",
    trustedClientAddress(req.headers),
  );
}

async function expireDue(): Promise<boolean> {
  const { error } = await admin.rpc("osi_v2_expire_due_challenges", { p_limit: 25 });
  return !error;
}

async function loadBoundNonce(nonce: string) {
  const { data, error } = await admin.from("osi_nonces")
    .select("nonce,purpose,actor_wallet,target_type,target_id,payload_hash,issued_at,expires_at,consumed_at,consumed_by_receipt_id,binding_context")
    .eq("nonce", nonce).limit(1);
  return { row: data?.[0] ?? null, error };
}

function requiresMaintainer(action: string, payload: Row): boolean {
  return action === "resolution_finalize" || action === "seal_finalize"
    || (action === "challenge_admit" && payload.route === "maintainer");
}

function requiresAnalyst(action: string, payload: Row): boolean {
  return action === "resolution_review" || action === "challenge_review"
    || action === "challenge_finalize"
    || (action === "challenge_admit" && payload.route === "analyst");
}

async function capabilities(req: Request, body: Row): Promise<Response> {
  const wallet = safeText(body.wallet);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  const [enabled, role, maintainer] = await Promise.all([
    lifecycleWritesEnabled(), analystRole(wallet), fullMaintainer(req, wallet),
  ]);
  return jsonResponse(200, {
    ok: true,
    resolution_lifecycle_writes_enabled: enabled,
    analyst_eligible: !!role,
    analyst_role: role || null,
    maintainer_access: maintainer.ok === true,
    maintainer_gate: maintainer.ok ? "full" : maintainer.reason,
  });
}

async function prepare(req: Request, body: Row): Promise<Response> {
  if (!await lifecycleWritesEnabled()) {
    return jsonResponse(503, { ok: false, error: "resolution_lifecycle_writes_disabled" });
  }
  const wallet = safeText(body.wallet);
  const action = safeText(body.action);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  let payload: Row;
  let targetRef: string;
  let idempotencyKey: string;
  try {
    payload = normalizeGovernancePayload(action, body.payload);
    targetRef = validateGovernanceTargetRef(action, body.target_ref);
    idempotencyKey = validateGovernanceIdempotencyKey(body.idempotency_key);
  } catch (error) {
    return jsonResponse(400, { ok: false, error: errorMessage(error) || "bad_governance_payload" });
  }
  let maintainerAuthId = "";
  if (requiresMaintainer(action, payload)) {
    const gate = await fullMaintainer(req, wallet);
    if (!gate.ok) return jsonResponse(403, { ok: false, error: gate.reason });
    maintainerAuthId = gate.auth_id;
  }
  if (requiresAnalyst(action, payload) && !await analystRole(wallet)) {
    return jsonResponse(403, { ok: false, error: "not_eligible_analyst" });
  }
  const { data, error } = await admin.rpc("osi_v2_prepare_governance_action", {
    p_nonce: randomNonce(), p_action: action, p_actor_wallet: wallet,
    p_target_ref: targetRef, p_payload: payload,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint_hash: await fingerprint(req),
    p_maintainer_auth_uuid: maintainerAuthId || null,
  });
  if (error || !data?.[0]) return rpcFailure(error);
  const issued = data[0];
  if (issued.consumed_receipt_id) {
    return jsonResponse(200, {
      ok: true, already_committed: true, action, purpose: issued.purpose,
      target_public_ref: issued.target_public_ref,
      receipt_id: issued.consumed_receipt_id, idempotent_replay: true,
    });
  }
  return jsonResponse(200, {
    ok: true, already_committed: false, action, purpose: issued.purpose,
    target_public_ref: issued.target_public_ref, actor_role: issued.actor_role,
    weight: issued.weight == null ? null : Number(issued.weight),
    quorum_hash: issued.quorum_hash || null, nonce: issued.issued_nonce,
    payload_hash: issued.payload_hash,
    proof_text: issued.proof_text,
    proof_type: issued.proof_type,
    expires_at: issued.expires_at,
    idempotent_replay: issued.idempotent_replay === true,
  });
}

async function verifyMainnetMemo(
  txSig: string, wallet: string, memo: string, issuedAt: string, expiresAt: string,
) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(txSig)) {
    return { ok: false, reason: "bad_transaction_signature" };
  }
  let response: Response;
  try {
    response = await fetch(SOLANA_RPC_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "getTransaction", params: [txSig, {
          commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0,
        }] },
        { jsonrpc: "2.0", id: 2, method: "getSignatureStatuses", params: [[txSig], {
          searchTransactionHistory: true,
        }] },
        { jsonrpc: "2.0", id: 3, method: "getGenesisHash" },
      ]),
    });
  } catch { return { ok: false, reason: "rpc_unavailable" }; }
  if (!response.ok) return { ok: false, reason: "rpc_unavailable" };
  let results: Row[];
  try { results = await response.json() as Row[]; }
  catch { return { ok: false, reason: "rpc_invalid_response" }; }
  if (!Array.isArray(results)) return { ok: false, reason: "rpc_invalid_response" };
  if (results.find((item) => item.id === 3)?.result !== MAINNET_GENESIS_HASH) {
    return { ok: false, reason: "wrong_cluster" };
  }
  const transaction = results.find((item) => item.id === 1)?.result;
  const status = results.find((item) => item.id === 2)?.result?.value?.[0];
  return validateConfirmedMemoTransaction(transaction, status, {
    tx_sig: txSig, wallet, memo,
    issued_at: Math.floor(Date.parse(issuedAt) / 1000),
    expires_at: Math.floor(Date.parse(expiresAt) / 1000),
  });
}

async function commit(req: Request, body: Row): Promise<Response> {
  if (!await lifecycleWritesEnabled()) {
    return jsonResponse(503, { ok: false, error: "resolution_lifecycle_writes_disabled" });
  }
  const wallet = safeText(body.wallet);
  const nonce = safeText(body.nonce);
  const action = safeText(body.action);
  const proofText = safeText(body.proof_text);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  const nonceResult = await loadBoundNonce(nonce);
  const bound = nonceResult.row;
  if (nonceResult.error || !bound || bound.binding_context?.action !== action
      || bound.actor_wallet !== wallet) {
    return jsonResponse(409, { ok: false, error: "unknown_or_wrong_nonce" });
  }
  let payload: Row;
  try { payload = normalizeGovernancePayload(action, body.payload); }
  catch (error) {
    return jsonResponse(400, { ok: false, error: errorMessage(error) || "bad_governance_payload" });
  }
  const expected = {
    purpose: String(bound.purpose), target_type: String(bound.target_type),
    target_id: String(bound.target_id),
    target_public_ref: String(bound.binding_context?.target_public_ref ?? ""),
    actor_wallet: wallet, payload_hash: String(bound.payload_hash), nonce,
  };
  const parsed = validateGovernanceProofText(
    proofText, expected,
    bound.consumed_at
      ? Math.min(Date.now(), Date.parse(String(bound.expires_at)))
      : Date.now(),
  );
  if (!parsed.ok || proofText !== bound.binding_context?.proof_text) {
    return jsonResponse(409, { ok: false, error: "proof_binding_rejected" });
  }
  let maintainerAuthId = "";
  if (requiresMaintainer(action, payload)) {
    const gate = await fullMaintainer(req, wallet);
    if (!gate.ok) return jsonResponse(403, { ok: false, error: gate.reason });
    maintainerAuthId = gate.auth_id;
  }
  if (requiresAnalyst(action, payload) && !await analystRole(wallet)) {
    return jsonResponse(403, { ok: false, error: "not_eligible_analyst" });
  }
  const isMemo = GOVERNANCE_MEMO_EVENTS.has(bound.purpose);
  let signature: string | null = null;
  let txSig: string | null = null;
  let occurredAt: string | null = null;
  if (isMemo) {
    txSig = safeText(body.tx_sig);
    const chain = await verifyMainnetMemo(
      txSig, wallet, proofText, String(bound.issued_at), String(bound.expires_at),
    );
    if (!chain.ok) return jsonResponse(409, { ok: false, error: chain.reason });
    occurredAt = (chain as { occurred_at: string }).occurred_at;
  } else {
    signature = safeText(body.signature);
    if (!await verifyEd25519Signature(proofText, signature, wallet)) {
      return jsonResponse(403, { ok: false, error: "bad_signature" });
    }
  }
  const { data, error } = await admin.rpc("osi_v2_commit_governance_action", {
    p_nonce: nonce, p_payload: payload, p_proof_text: proofText,
    p_signature: signature, p_tx_sig: txSig, p_occurred_at: occurredAt,
    p_maintainer_auth_uuid: maintainerAuthId || null,
  });
  if (error || !data?.[0]) return rpcFailure(error);
  const committed = data[0];
  // D19 Step 3: best-effort shadow validation of the just-committed analyst
  // review. The receipt is already durably recorded above; this only records
  // SAS telemetry and never affects the commit or its response.
  const reviewKind = reviewKindForGovernanceAction(action);
  if (reviewKind && committed.receipt_id) {
    const reviewId = await resolveReviewIdByReceipt(admin, reviewKind, committed.receipt_id);
    await runShadowValidation(admin, { reviewKind, reviewId, wallet });
  }
  const bootstrapChannel =
    bound.binding_context?.server_binding?.decision_channel === "maintainer_bootstrap";
  return jsonResponse(200, {
    ok: true, action: committed.action, purpose: committed.purpose,
    target_public_ref: committed.target_public_ref,
    case_public_ref: committed.case_public_ref || null,
    resolution_public_ref: committed.resolution_public_ref || null,
    challenge_public_ref: committed.challenge_public_ref || null,
    state: committed.state, receipt_id: committed.receipt_id,
    decision_channel: bootstrapChannel ? "maintainer_bootstrap" : "standard",
    proof: {
      event_type: committed.purpose,
      label: governanceProofLabel(committed.purpose),
      proof_type: isMemo ? "solana_memo" : "wallet_signed_server_verified",
      tx_sig: txSig, server_verified: true,
      decision_channel: bootstrapChannel ? "maintainer_bootstrap" : "standard",
    },
    idempotent_replay: committed.idempotent_replay === true,
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
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return jsonResponse(413, { ok: false, error: "body_too_large" });
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError();
    body = parsed as Row;
  } catch { return jsonResponse(400, { ok: false, error: "bad_json" }); }

  if (!await expireDue()) {
    return jsonResponse(503, { ok: false, error: "challenge_maintenance_unavailable" });
  }
  switch (body.op) {
    case "actor_capabilities": return await capabilities(req, body);
    case "prepare": return await prepare(req, body);
    case "commit": return await commit(req, body);
    default: return jsonResponse(400, { ok: false, error: "bad_op" });
  }
});
