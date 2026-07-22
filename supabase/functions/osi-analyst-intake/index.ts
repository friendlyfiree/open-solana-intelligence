// Legacy review-floor READ compatibility only.
//
// Pending V1 rows remain private. Callers must present the short-lived,
// origin-bound V2 read session and are rechecked against the current V2 analyst
// roster or the full two-factor maintainer gate. Legacy review writes are
// intentionally disabled: they did not satisfy the Stage-5 replay, immutable
// history, self-review, quorum, or confirmed-Memo requirements.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  READ_SESSION_SCOPES,
  readSessionIssuer,
  verifyReadSessionToken,
} from "../_shared/osi-v2-read-session-core.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ALLOWED_ORIGIN = Deno.env.get("OSI_V2_ALLOWED_ORIGIN")
  ?? Deno.env.get("OSI_INTAKE_ALLOWED_ORIGIN") ?? "";
const MAINTAINER_AUTH_UUID = Deno.env.get("OSI_MAINTAINER_AUTH_UUID") ?? "";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

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

async function readSessionEnabled(): Promise<boolean> {
  const { data, error } = await admin.from("osi_config").select("value")
    .eq("key", "OSI_V2_READ_SESSION_ENABLED").limit(1);
  return !error && data?.[0]?.value === "true";
}

async function isVerifiedAnalyst(wallet: string): Promise<boolean> {
  const { data, error } = await admin.from("analyst_profiles")
    .select("wallet,status,verified,approved,weight_cached")
    .eq("wallet", wallet).limit(1);
  const analyst = data?.[0];
  return !error && !!analyst && analyst.verified === true && analyst.approved === true
    && ["probationary_analyst", "verified_analyst", "senior_analyst"].includes(String(analyst.status))
    && Number(analyst.weight_cached) >= 0.50;
}

async function hasFullMaintainerAccess(req: Request, wallet: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(MAINTAINER_AUTH_UUID)) return false;
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  const [{ data: configRows, error: configError }, authResult] = await Promise.all([
    admin.from("osi_config").select("value").eq("key", "admin_wallet").limit(1),
    admin.auth.getUser(token),
  ]);
  return !configError && authResult.error == null
    && authResult.data?.user?.id === MAINTAINER_AUTH_UUID
    && configRows?.[0]?.value === wallet;
}

async function authorizeRead(
  req: Request,
  body: Record<string, unknown>,
): Promise<{ ok: true; role: "analyst" | "maintainer" } | { ok: false; status: number; reason: string }> {
  if (!await readSessionEnabled()) {
    return { ok: false, status: 503, reason: "read_session_disabled_or_unavailable" };
  }
  const wallet = String(body.wallet ?? "");
  const verified = await verifyReadSessionToken({
    token: String(body.read_session ?? ""),
    secret: SERVICE_ROLE_KEY,
    issuer: readSessionIssuer(SUPABASE_URL),
    origin: req.headers.get("origin") ?? "",
    allowedOrigin: ALLOWED_ORIGIN,
    wallet,
    requiredScope: READ_SESSION_SCOPES.CASE_REVIEW,
  });
  if (verified.ok !== true) {
    return {
      ok: false,
      status: typeof verified.status === "number" ? verified.status : 403,
      reason: typeof verified.reason === "string" ? verified.reason : "unauthorized",
    };
  }
  if (await isVerifiedAnalyst(wallet)) return { ok: true, role: "analyst" };
  if (await hasFullMaintainerAccess(req, wallet)) return { ok: true, role: "maintainer" };
  return { ok: false, status: 403, reason: "not_eligible_reviewer" };
}

async function loadPending() {
  const [reports, bounties, challenges] = await Promise.all([
    admin.from("reports").select(REPORT_COLS).eq("approved", false)
      .order("created_at", { ascending: false }).limit(60),
    admin.from("bounties").select(BOUNTY_COLS).eq("approved", false)
      .order("created_at", { ascending: false }).limit(60),
    admin.from("challenges").select(CHALLENGE_COLS).eq("status", "open")
      .order("created_at", { ascending: false }).limit(60),
  ]);
  if (reports.error || bounties.error || challenges.error) throw new Error("read_failed");
  return {
    reports: reports.data ?? [],
    bounties: bounties.data ?? [],
    challenges: challenges.data ?? [],
  };
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

  let body: Record<string, unknown> | null = null;
  try { body = await req.json(); } catch { body = null; }
  if (!body) return jsonResponse(400, { error: "bad_request" });

  if (body.mode === "review_action") {
    return jsonResponse(503, { error: "legacy_review_writes_disabled" });
  }

  const access = await authorizeRead(req, body);
  if (!access.ok) return jsonResponse(access.status, { reason: access.reason });
  try {
    return jsonResponse(200, { role: access.role, ...await loadPending() });
  } catch {
    return jsonResponse(500, { error: "read_failed" });
  }
});
