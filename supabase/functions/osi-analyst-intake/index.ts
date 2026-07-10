// ============================================================================
// Supabase Edge Function: osi-analyst-intake
// ----------------------------------------------------------------------------
// Secure read path for the Analysts review floor AFTER Stage 2A RLS hardening.
//
// Pending case/report intake is no longer readable with the anon key. This
// function is the only way non-maintainers reach it, and it authorizes every
// caller server-side before returning anything:
//
//   1. Maintainer  -> a valid Supabase session JWT (Authorization: Bearer ...)
//   2. Analyst     -> an off-chain ed25519 wallet signature that proves wallet
//                     ownership, then a service-role lookup requiring
//                     analysts.verified = true AND analysts.approved = true
//   3. Everyone else -> HTTP 403
//
// Reads use the SERVICE ROLE key (bypasses RLS). The service role key never
// leaves this function, is never logged, and is never returned to the client.
// RLS stays exactly as Stage 2A left it — pending rows remain non-public.
//
// Deploy notes:
//   - Function name: osi-analyst-intake  (callable at /functions/v1/osi-analyst-intake)
//   - "Verify JWT" MUST be OFF: verified analysts authenticate with a wallet
//     signature, not a Supabase JWT, so this function does its own auth.
//   - Required env (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected
//     by Supabase). Optionally set OSI_INTAKE_ALLOWED_ORIGIN to your site origin
//     to narrow CORS (defaults to "*").
// ============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import nacl from "https://esm.sh/tweetnacl@1.0.3";
import bs58 from "https://esm.sh/bs58@5.0.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("OSI_INTAKE_ALLOWED_ORIGIN") ?? "*";

const PURPOSE = "OSI Analyst Intake Access v1";
const MAX_AGE_MS = 120_000; // 120s freshness window (stateless replay guard)

// service-role client: bypasses RLS. Never expose this key or client to callers.
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Only the columns the existing review floor + drawer render. No secrets,
// no AI-Pack content (escalation_packs is never read here).
const REPORT_COLS =
  "id,company,bounty,summary,onchain,offchain,tx,image,wallet,approved,review_status,created_at";
const BOUNTY_COLS =
  "id,target,title,detail,onchain,image,created_by,approved,review_status,created_at";
const CHALLENGE_COLS =
  "id,item_type,item_id,item_label,challenger,reason,status,created_at";

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Max-Age": "3600",
    "Vary": "Origin",
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

// Pull the pending intake the review floor needs, with the service role.
async function loadPending() {
  const [reports, bounties, challenges] = await Promise.all([
    admin.from("reports").select(REPORT_COLS).eq("approved", false)
      .order("created_at", { ascending: false }).limit(60),
    admin.from("bounties").select(BOUNTY_COLS).eq("approved", false)
      .order("created_at", { ascending: false }).limit(60),
    admin.from("challenges").select(CHALLENGE_COLS).eq("status", "open")
      .order("created_at", { ascending: false }).limit(60),
  ]);
  return {
    reports: reports.data ?? [],
    bounties: bounties.data ?? [],
    challenges: challenges.data ?? [],
  };
}

// Publication threshold: number of DISTINCT verified-analyst approvals required
// to publish a target. Read from osi_config (no schema change); defaults to 1.
// The existing weight-based consensus_threshold is left untouched for the
// client consensus meter; Stage 2C publication uses this simple count.
async function publishThreshold(): Promise<number> {
  try {
    const { data } = await admin.from("osi_config").select("value")
      .eq("key", "analyst_publish_min_approvals").limit(1);
    const v = data && data[0] ? parseInt(String(data[0].value), 10) : NaN;
    if (Number.isFinite(v) && v >= 1) return v;
  } catch { /* fall back to default */ }
  return 1;
}

// Count distinct wallets that (a) have an 'approve' vouch on this item AND
// (b) are currently verified+approved analysts. Ignores stale/non-verified
// votes so the count is a true verified-analyst approval count.
async function countVerifiedApprovals(itemType: string, itemId: string): Promise<number> {
  const { data: votes } = await admin.from("vouches")
    .select("analyst,vote").eq("item_type", itemType).eq("item_id", itemId).eq("vote", "approve");
  const wallets = Array.from(new Set((votes ?? []).map((v) => String(v.analyst)).filter(Boolean)));
  if (!wallets.length) return 0;
  const { data: verified } = await admin.from("analysts")
    .select("wallet").in("wallet", wallets).eq("verified", true).eq("approved", true);
  const vset = new Set((verified ?? []).map((a) => String(a.wallet)));
  return wallets.filter((w) => vset.has(w)).length;
}

// review_action: record a verified analyst's approve/challenge vote (server-side,
// service role) and publish the target if the approval threshold is met. Errors
// are neutral codes only — never echo report/case narrative.
async function handleReviewAction(
  body: Record<string, unknown>,
  wallet: string,
): Promise<Response> {
  const itemType = String(body.item_type ?? "");
  const itemId = String(body.item_id ?? "");
  const vote = String(body.vote ?? "");
  const txSig = String(body.tx_sig ?? "");

  if (itemType !== "report" && itemType !== "bounty" && itemType !== "challenge") {
    return jsonResponse(400, { reason: "bad_item_type" });
  }
  if (vote !== "approve" && vote !== "challenge") return jsonResponse(400, { reason: "bad_vote" });
  if (!itemId) return jsonResponse(400, { reason: "missing_item" });
  if (!txSig) return jsonResponse(400, { reason: "missing_tx" }); // tx_sig required, but is NOT identity

  // vouches stores 'approve' | 'reject' (client meter reads that); a 'challenge'
  // action is stored as 'reject'.
  const dbVote = vote === "approve" ? "approve" : "reject";

  // Challenge items (uphold/dismiss votes on the challenges table) are recorded
  // only — they never publish a report/bounty. Handled here so review-floor
  // challenge voting keeps working without any anon vouches insert.
  if (itemType === "challenge") {
    await admin.from("vouches").delete()
      .eq("item_type", itemType).eq("item_id", itemId).eq("analyst", wallet);
    const { error: cErr } = await admin.from("vouches")
      .insert({ item_type: itemType, item_id: itemId, analyst: wallet, vote: dbVote });
    if (cErr) return jsonResponse(500, { error: "vote_failed" });
    const cData = await loadPending();
    return jsonResponse(200, { role: "analyst", recorded: true, published: false, ...cData });
  }

  const table = itemType === "report" ? "reports" : "bounties";
  const { data: rows, error: lookupErr } = await admin.from(table)
    .select("id,approved,review_status").eq("id", itemId).limit(1);
  if (lookupErr) return jsonResponse(500, { error: "lookup_failed" });
  const target = rows && rows[0];
  if (!target) return jsonResponse(404, { reason: "not_found" });

  const alreadyPublic = target.approved === true;

  // Dedupe: replace any prior vote from this analyst on this item, then insert.
  await admin.from("vouches").delete()
    .eq("item_type", itemType).eq("item_id", itemId).eq("analyst", wallet);
  const { error: voteErr } = await admin.from("vouches")
    .insert({ item_type: itemType, item_id: itemId, analyst: wallet, vote: dbVote });
  if (voteErr) return jsonResponse(500, { error: "vote_failed" });

  // Publish only on approve, only if not already public, only at/over threshold.
  let published = alreadyPublic;
  if (!alreadyPublic && vote === "approve") {
    const [threshold, approvals] = await Promise.all([
      publishThreshold(),
      countVerifiedApprovals(itemType, itemId),
    ]);
    if (approvals >= threshold) {
      const patch = itemType === "report"
        ? { approved: true, review_status: "approved" }
        : { approved: true, review_status: "approved_public" };
      const { error: pubErr } = await admin.from(table).update(patch).eq("id", itemId);
      if (pubErr) return jsonResponse(500, { error: "publish_failed" });
      published = true;
    }
  }
  // A 'challenge' vote never publishes.

  const data = await loadPending(); // refreshed lists so the client updates without re-signing
  return jsonResponse(200, { role: "analyst", recorded: true, published, ...data });
}

// Maintainer path: a valid Supabase user session (the app's only authenticated
// role). The publishable anon key is NOT a user JWT, so getUser rejects it.
async function isMaintainer(authHeader: string | null): Promise<boolean> {
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  try {
    const { data, error } = await admin.auth.getUser(token);
    return !error && !!data?.user;
  } catch {
    return false;
  }
}

// Analyst path: verify the signed message proves ownership of `wallet`.
function verifyProof(
  body: Record<string, unknown> | null,
): { ok: boolean; wallet?: string; reason?: string } {
  const wallet = String(body?.wallet ?? "");
  const message = String(body?.message ?? "");
  const signature = String(body?.signature ?? "");
  if (!wallet || !message || !signature) return { ok: false, reason: "missing_fields" };
  if (!message.startsWith(PURPOSE)) return { ok: false, reason: "bad_purpose" };
  if (message.indexOf("wallet: " + wallet) === -1) return { ok: false, reason: "wallet_mismatch" };

  const issuedMatch = message.match(/issued:\s*(\d+)/);
  if (!issuedMatch) return { ok: false, reason: "no_timestamp" };
  const issued = Number(issuedMatch[1]);
  if (!Number.isFinite(issued) || Math.abs(Date.now() - issued) > MAX_AGE_MS) {
    return { ok: false, reason: "stale" };
  }
  if (!/nonce:\s*\S+/.test(message)) return { ok: false, reason: "no_nonce" };

  let pub: Uint8Array;
  let sig: Uint8Array;
  try {
    pub = bs58.decode(wallet);
  } catch {
    return { ok: false, reason: "bad_wallet" };
  }
  if (pub.length !== 32) return { ok: false, reason: "bad_wallet" };
  try {
    sig = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  } catch {
    return { ok: false, reason: "bad_signature_encoding" };
  }
  if (sig.length !== 64) return { ok: false, reason: "bad_signature_length" };

  const msgBytes = new TextEncoder().encode(message);
  const valid = nacl.sign.detached.verify(msgBytes, sig, pub);
  return valid ? { ok: true, wallet } : { ok: false, reason: "bad_signature" };
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

  // 1) Maintainer via Supabase session JWT.
  try {
    if (await isMaintainer(req.headers.get("authorization"))) {
      const data = await loadPending();
      return jsonResponse(200, { role: "maintainer", ...data });
    }
  } catch {
    // fall through to the analyst path
  }

  // 2) Verified analyst via wallet signature.
  let body: Record<string, unknown> | null = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  const proof = verifyProof(body);
  if (!proof.ok) return jsonResponse(403, { reason: proof.reason ?? "unauthorized" });

  const { data: rows, error } = await admin
    .from("analysts")
    .select("wallet,verified,approved")
    .eq("wallet", proof.wallet!)
    .limit(1);
  if (error) return jsonResponse(500, { error: "lookup_failed" });

  const analyst = rows && rows[0];
  if (!analyst || analyst.verified !== true || analyst.approved !== true) {
    return jsonResponse(403, { reason: "not_verified" });
  }

  // Verified analyst: either take a review action, or list pending intake.
  if (body && body.mode === "review_action") {
    return await handleReviewAction(body, proof.wallet!);
  }

  const data = await loadPending();
  return jsonResponse(200, { role: "analyst", ...data });
});
