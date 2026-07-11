// OSI V2 Stage-5 public nonce issuer.
//
// This function does not mutate a Case/Report and does not create a receipt.
// It issues a short-lived exact-bound nonce only. A future action-specific
// endpoint must recompute the payload hash, verify the canonical Ed25519
// signature and call the service-only atomic consume RPC in its own action
// transaction. Domain writes remain gated by OSI_V2_WRITES_ENABLED=false.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  CLASS_B_PURPOSES,
  canonicalProofMessage,
  randomNonce,
  requestFingerprint,
  trustedClientAddress,
  validateProofBinding,
  validateWallet,
} from "../_shared/osi-v2-proof-core.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("OSI_V2_ALLOWED_ORIGIN") ?? "*";
const MAX_BODY_BYTES = 16_384;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

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
  return typeof value === "string" ? value : "";
}

function unixSeconds(value: unknown): number {
  const milliseconds = Date.parse(String(value ?? ""));
  if (!Number.isFinite(milliseconds)) throw new TypeError("invalid server timestamp");
  return Math.floor(milliseconds / 1000);
}

async function issueNonce(req: Request, body: Record<string, unknown>): Promise<Response> {
  const purpose = safeText(body.purpose);
  const actorWallet = safeText(body.actor_wallet);
  const targetType = safeText(body.target_type);
  const targetId = safeText(body.target_id);
  const payloadHash = safeText(body.payload_hash);
  const idempotencyKey = safeText(body.idempotency_key);

  if (!CLASS_B_PURPOSES.has(purpose)) {
    return jsonResponse(400, { ok: false, error: "bad_purpose" });
  }
  try {
    validateWallet(actorWallet);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(targetType)) throw new TypeError();
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(targetId)) throw new TypeError();
    if (!/^[0-9a-f]{64}$/.test(payloadHash)) throw new TypeError();
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) throw new TypeError();
  } catch {
    return jsonResponse(400, { ok: false, error: "bad_binding" });
  }

  const nonce = randomNonce();
  const fingerprint = await requestFingerprint(
    SERVICE_ROLE_KEY,
    trustedClientAddress(req.headers),
  );
  const { data, error } = await admin.rpc("osi_v2_issue_nonce", {
    p_nonce: nonce,
    p_purpose: purpose,
    p_actor_wallet: actorWallet,
    p_target_type: targetType,
    p_target_id: targetId,
    p_payload_hash: payloadHash,
    p_idempotency_key: idempotencyKey,
    p_request_fingerprint_hash: fingerprint,
  });

  if (error) {
    const message = String(error.message ?? "");
    if (message.includes("disabled")) {
      return jsonResponse(503, { ok: false, error: "proof_disabled" });
    }
    if (message.includes("rate limit")) {
      return jsonResponse(429, { ok: false, error: "rate_limited" });
    }
    if (message.includes("Idempotency key")) {
      return jsonResponse(409, { ok: false, error: "idempotency_conflict" });
    }
    return jsonResponse(500, { ok: false, error: "nonce_issue_failed" });
  }

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return jsonResponse(500, { ok: false, error: "nonce_issue_failed" });

  const binding = validateProofBinding({
    purpose,
    actor_wallet: actorWallet,
    target_type: targetType,
    target_id: targetId,
    payload_hash: payloadHash,
    nonce: row.issued_nonce,
    issued_at: unixSeconds(row.issued_at),
    expires_at: unixSeconds(row.expires_at),
  });

  return jsonResponse(200, {
    ok: true,
    binding,
    message: canonicalProofMessage(binding),
    idempotent_replay: row.idempotent_replay === true,
    already_consumed: Boolean(row.consumed_receipt_id),
  });
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "method_not_allowed" });
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return jsonResponse(503, { ok: false, error: "not_configured" });
  }

  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return jsonResponse(413, { ok: false, error: "body_too_large" });
  }

  let raw = "";
  let body: Record<string, unknown>;
  try {
    raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return jsonResponse(413, { ok: false, error: "body_too_large" });
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError();
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { ok: false, error: "bad_json" });
  }

  if (body.mode !== "issue_nonce") {
    return jsonResponse(400, { ok: false, error: "bad_mode" });
  }
  return await issueNonce(req, body);
});
