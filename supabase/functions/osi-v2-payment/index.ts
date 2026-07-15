// OSI V2 native SOL payment gateway. The browser receives a server-derived
// intent and asks Phantom to sign that exact transaction. A persistent success
// is created only after this gateway verifies mainnet, finality, signer, every
// System Program transfer, the canonical Memo, freshness and nonce binding.

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
  PAYMENT_MAX_RECIPIENTS,
  isSolanaMainnetGenesis,
  formatLamportsAsSol,
  normalizePaymentTargetRef,
  parseSolToLamports,
  validateFinalizedPaymentTransaction,
} from "../_shared/osi-v2-payment-core.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("OSI_V2_ALLOWED_ORIGIN") ?? "*";
const SOLANA_RPC_URL = Deno.env.get("SOLANA_RPC_URL") ?? "https://api.mainnet-beta.solana.com";
const MAX_BODY_BYTES = 24_576;

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
  return error instanceof Error ? error.message : "invalid_payment_request";
}

function rpcFailure(error: Row | null): Response {
  const code = safeText(error?.code);
  if (code === "42501") return jsonResponse(403, { ok: false, error: "payment_not_authorized_or_not_ready" });
  if (code === "23505") return jsonResponse(409, { ok: false, error: "transaction_already_used" });
  if (["23514", "22023"].includes(code)) return jsonResponse(409, { ok: false, error: "payment_binding_rejected" });
  if (code === "40001") return jsonResponse(409, { ok: false, error: "payment_state_changed_retry" });
  if (code === "P0001") return jsonResponse(429, { ok: false, error: "payment_rate_limited" });
  if (code === "55000") return jsonResponse(503, { ok: false, error: "payment_writes_disabled_or_unavailable" });
  return jsonResponse(500, { ok: false, error: "payment_write_failed" });
}

async function writesEnabled(): Promise<boolean> {
  const { data, error } = await admin.from("osi_config").select("value")
    .eq("key", "OSI_V2_PAYMENT_WRITES_ENABLED").limit(1);
  return !error && data?.[0]?.value === "true";
}

async function fingerprint(req: Request): Promise<string> {
  return await requestFingerprint(
    SERVICE_ROLE_KEY + "\u0000osi-v2-payment",
    trustedClientAddress(req.headers),
  );
}

async function loadNonce(nonce: string) {
  const { data, error } = await admin.from("osi_nonces")
    .select("nonce,purpose,actor_wallet,target_type,target_id,payload_hash,issued_at,expires_at,consumed_at,consumed_by_receipt_id,binding_context")
    .eq("nonce", nonce).limit(1);
  return { row: data?.[0] ?? null, error };
}

function normalizeIdempotency(value: unknown): string {
  const text = safeText(value);
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(text)) throw new TypeError("idempotency_key is invalid");
  return text;
}

function exactLamports(value: unknown): string {
  return String(parseSolToLamports(safeText(value)));
}

function normalizePaymentRequest(kind: string, body: Row): Row {
  if (kind === "reward") return { amount_lamports: exactLamports(body.amount_sol) };
  if (kind !== "support" || !Array.isArray(body.recipients)
      || body.recipients.length < 1 || body.recipients.length > PAYMENT_MAX_RECIPIENTS) {
    throw new TypeError("support recipient request is invalid");
  }
  return {
    recipients: body.recipients.map((entry: Row) => {
      const targetType = safeText(entry?.target_type);
      if (!["report_author", "analyst", "counted_reviewer"].includes(targetType)) {
        throw new TypeError("support target_type is invalid");
      }
      const value: Row = {
        target_type: targetType,
        target_ref: normalizePaymentTargetRef(entry.target_ref),
        amount_lamports: exactLamports(entry.amount_sol),
      };
      if (targetType === "counted_reviewer") {
        value.reviewer_wallet = validateWallet(safeText(entry.reviewer_wallet));
      }
      return value;
    }),
  };
}

async function capabilities(body: Row): Promise<Response> {
  const wallet = safeText(body.wallet);
  if (wallet) {
    try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  }
  return jsonResponse(200, {
    ok: true,
    payment_writes_enabled: await writesEnabled(),
    network: "mainnet-beta",
    native_sol_only: true,
    non_custodial: true,
    atomic_support_max_recipients: PAYMENT_MAX_RECIPIENTS,
    solana_pay_enabled: false,
  });
}

async function preparePledge(req: Request, body: Row): Promise<Response> {
  if (!await writesEnabled()) return jsonResponse(503, { ok: false, error: "payment_writes_disabled" });
  let wallet: string;
  let action: string;
  let caseRef: string;
  let amount: bigint;
  let idempotency: string;
  try {
    wallet = validateWallet(safeText(body.wallet));
    action = safeText(body.action);
    if (!["create", "revise", "withdraw"].includes(action)) throw new TypeError("pledge action is invalid");
    caseRef = normalizePaymentTargetRef(body.case_ref);
    amount = action === "withdraw" ? 1n : parseSolToLamports(safeText(body.amount_sol));
    idempotency = normalizeIdempotency(body.idempotency_key);
  } catch (error) {
    return jsonResponse(400, { ok: false, error: errorMessage(error) });
  }
  const { data, error } = await admin.rpc("osi_v2_prepare_pledge", {
    p_nonce: randomNonce(), p_action: action, p_actor_wallet: wallet,
    p_case_ref: caseRef, p_amount_lamports: String(amount),
    p_idempotency_key: idempotency,
    p_request_fingerprint_hash: await fingerprint(req),
  });
  if (error || !data?.[0]) return rpcFailure(error);
  const issued = data[0];
  return jsonResponse(200, {
    ok: true,
    already_committed: !!issued.consumed_receipt_id,
    action,
    purpose: issued.purpose,
    pledge_id: issued.pledge_id,
    case_public_ref: issued.case_public_ref,
    amount_lamports: String(issued.amount_lamports),
    amount_sol: formatLamportsAsSol(String(issued.amount_lamports)),
    revision_no: Number(issued.revision_no),
    nonce: issued.issued_nonce,
    payload_hash: issued.payload_hash,
    proof_text: issued.proof_text,
    proof_type: "wallet_signed_server_verified",
    expires_at: issued.expires_at,
    receipt_id: issued.consumed_receipt_id ?? null,
    idempotent_replay: issued.idempotent_replay === true,
  });
}

async function commitPledge(body: Row): Promise<Response> {
  if (!await writesEnabled()) return jsonResponse(503, { ok: false, error: "payment_writes_disabled" });
  const wallet = safeText(body.wallet);
  const nonce = safeText(body.nonce);
  const action = safeText(body.action);
  const proofText = safeText(body.proof_text);
  const signature = safeText(body.signature);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  const loaded = await loadNonce(nonce);
  const bound = loaded.row;
  if (loaded.error || !bound || bound.actor_wallet !== wallet
      || bound.binding_context?.action !== action || bound.binding_context?.proof_text !== proofText) {
    return jsonResponse(409, { ok: false, error: "unknown_or_wrong_pledge_nonce" });
  }
  if (!await verifyEd25519Signature(proofText, signature, wallet)) {
    return jsonResponse(403, { ok: false, error: "bad_signature" });
  }
  const { data, error } = await admin.rpc("osi_v2_commit_pledge", {
    p_nonce: nonce, p_action: action,
    p_amount_lamports: String(bound.binding_context.amount_lamports),
    p_proof_text: proofText, p_signature: signature,
  });
  if (error || !data?.[0]) return rpcFailure(error);
  const row = data[0];
  return jsonResponse(200, {
    ok: true,
    pledge: {
      id: row.pledge_id,
      case_public_ref: row.case_public_ref,
      state: row.state,
      amount_lamports: String(row.amount_lamports),
      amount_sol: formatLamportsAsSol(String(row.amount_lamports)),
      revision_no: Number(row.revision_no),
    },
    receipt: {
      id: row.receipt_id,
      event_type: bound.purpose,
      proof_type: "wallet_signed_server_verified",
      label: "Wallet-signed & server-verified",
      server_verified: true,
    },
    idempotent_replay: row.idempotent_replay === true,
  });
}

async function preparePayment(req: Request, body: Row): Promise<Response> {
  if (!await writesEnabled()) return jsonResponse(503, { ok: false, error: "payment_writes_disabled" });
  let wallet: string;
  let kind: string;
  let targetRef: string;
  let request: Row;
  let idempotency: string;
  try {
    wallet = validateWallet(safeText(body.wallet));
    kind = safeText(body.payment_kind);
    targetRef = normalizePaymentTargetRef(body.target_ref);
    request = normalizePaymentRequest(kind, body);
    idempotency = normalizeIdempotency(body.idempotency_key);
  } catch (error) {
    return jsonResponse(400, { ok: false, error: errorMessage(error) });
  }
  const { data, error } = await admin.rpc("osi_v2_prepare_payment", {
    p_nonce: randomNonce(), p_payment_kind: kind, p_payer_wallet: wallet,
    p_target_ref: targetRef, p_request: request,
    p_idempotency_key: idempotency,
    p_request_fingerprint_hash: await fingerprint(req),
  });
  if (error || !data?.[0]) return rpcFailure(error);
  const issued = data[0];
  const recipients = (issued.recipient_manifest ?? []).map((entry: Row) => ({
    ordinal: Number(entry.ordinal),
    wallet: entry.wallet,
    recipient_type: entry.recipient_type,
    target_ref: entry.target_ref,
    amount_lamports: String(entry.amount_lamports),
    amount_sol: formatLamportsAsSol(String(entry.amount_lamports)),
  }));
  return jsonResponse(200, {
    ok: true,
    already_committed: !!issued.consumed_receipt_id,
    payment_id: issued.payment_id,
    payment_kind: issued.payment_kind,
    purpose: issued.purpose,
    network: "mainnet-beta",
    payer_wallet: wallet,
    actor_role: issued.actor_role,
    target_public_ref: issued.target_public_ref,
    recipient_manifest: recipients,
    recipient_count: recipients.length,
    manifest_hash: issued.manifest_hash,
    total_lamports: String(issued.total_lamports),
    total_sol: formatLamportsAsSol(String(issued.total_lamports)),
    nonce: issued.issued_nonce,
    payload_hash: issued.payload_hash,
    memo: issued.memo,
    issued_at: issued.issued_at,
    expires_at: issued.expires_at,
    receipt_id: issued.consumed_receipt_id ?? null,
    direct_wallet_to_wallet: true,
    osi_custody: false,
    irreversible: true,
    idempotent_replay: issued.idempotent_replay === true,
  });
}

async function rpcTransaction(txSig: string): Promise<Row> {
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
        { jsonrpc: "2.0", id: 3, method: "getGenesisHash" },
      ]),
    });
  } catch { throw new Error("rpc_unavailable"); }
  if (!response.ok) throw new Error("rpc_unavailable");
  const results = await response.json().catch(() => null) as Row[] | null;
  if (!Array.isArray(results)) throw new Error("rpc_invalid_response");
  if (!isSolanaMainnetGenesis(results.find((item) => item.id === 3)?.result)) {
    throw new Error("wrong_cluster");
  }
  return {
    transaction: results.find((item) => item.id === 1)?.result ?? null,
    status: results.find((item) => item.id === 2)?.result?.value?.[0] ?? null,
  };
}

async function commitPayment(body: Row): Promise<Response> {
  if (!await writesEnabled()) return jsonResponse(503, { ok: false, error: "payment_writes_disabled" });
  const wallet = safeText(body.wallet);
  const nonce = safeText(body.nonce);
  const txSig = safeText(body.tx_sig);
  try { validateWallet(wallet); } catch { return jsonResponse(400, { ok: false, error: "bad_wallet" }); }
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(txSig)) {
    return jsonResponse(400, { ok: false, error: "bad_transaction_signature" });
  }
  const loaded = await loadNonce(nonce);
  const bound = loaded.row;
  if (loaded.error || !bound || bound.actor_wallet !== wallet
      || !["REWARD_PAYMENT_CONFIRMED", "SUPPORT_PAYMENT_CONFIRMED"].includes(bound.purpose)) {
    return jsonResponse(409, { ok: false, error: "unknown_or_wrong_payment_nonce" });
  }
  let rpc: Row;
  try { rpc = await rpcTransaction(txSig); }
  catch (error) { return jsonResponse(503, { ok: false, error: errorMessage(error) }); }
  const verified = validateFinalizedPaymentTransaction(
    rpc.transaction,
    rpc.status,
    {
      payment_kind: bound.binding_context.payment_kind,
      target_public_ref: bound.binding_context.target_public_ref,
      payer_wallet: bound.actor_wallet,
      actor_role: bound.binding_context.actor_role,
      nonce: bound.nonce,
      payload_hash: bound.payload_hash,
      issued_at: Math.floor(Date.parse(String(bound.issued_at)) / 1000),
      expires_at: Math.floor(Date.parse(String(bound.expires_at)) / 1000),
      recipient_manifest: bound.binding_context.recipient_manifest,
    },
    txSig,
  );
  if (!verified.ok && verified.state === "awaiting_finality") {
    if (rpc.transaction) {
      const { error } = await admin.rpc("osi_v2_record_payment_submission", {
        p_nonce: nonce, p_tx_sig: txSig,
      });
      if (error) return rpcFailure(error);
    }
    return jsonResponse(202, {
      ok: true,
      state: "awaiting_finality",
      reason: verified.reason,
      payment_id: bound.target_id,
      tx_sig: txSig,
      paid: false,
      retryable: true,
    });
  }
  if (!verified.ok) {
    if (rpc.transaction) {
      const { error } = await admin.rpc("osi_v2_record_payment_failure", {
        p_nonce: nonce, p_tx_sig: txSig, p_error: verified.reason,
      });
      if (error) return rpcFailure(error);
    }
    return jsonResponse(409, {
      ok: false,
      error: verified.reason,
      state: "verification_failed",
      paid: false,
    });
  }
  const { data, error } = await admin.rpc("osi_v2_commit_payment", {
    p_nonce: nonce,
    p_tx_sig: txSig,
    p_slot: verified.slot,
    p_block_time: verified.block_time,
    p_finality: verified.finality,
    p_rpc_metadata: {
      fee_lamports: verified.fee_lamports,
      transaction_signature: txSig,
    },
  });
  if (error || !data?.[0]) return rpcFailure(error);
  const committed = data[0];
  return jsonResponse(200, {
    ok: true,
    payment_id: committed.payment_id,
    payment_kind: committed.payment_kind,
    state: committed.state,
    paid: committed.state === "confirmed",
    receipt: {
      id: committed.receipt_id,
      event_type: bound.purpose,
      proof_type: "solana_memo",
      label: "SOL transfer verified on Solana",
      server_verified: true,
      tx_sig: txSig,
      solscan_url: `https://solscan.io/tx/${txSig}`,
      slot: verified.slot,
      block_time: verified.block_time,
      finality: verified.finality,
      memo: verified.memo,
      payer_wallet: wallet,
      recipients: verified.recipient_manifest,
      total_lamports: verified.total_lamports,
      total_sol: formatLamportsAsSol(verified.total_lamports),
    },
    pledge_state: committed.pledge_state ?? null,
    confirmed_total_lamports: String(committed.confirmed_total_lamports ?? "0"),
    outstanding_lamports: String(committed.outstanding_lamports ?? "0"),
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
    body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError();
  } catch { return jsonResponse(400, { ok: false, error: "bad_json" }); }
  switch (body.op) {
    case "capabilities": return await capabilities(body);
    case "prepare_pledge": return await preparePledge(req, body);
    case "commit_pledge": return await commitPledge(body);
    case "prepare_payment": return await preparePayment(req, body);
    case "commit_payment": return await commitPayment(body);
    default: return jsonResponse(400, { ok: false, error: "bad_op" });
  }
});
