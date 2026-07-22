// Legacy AI Pack compatibility service.
//
// Public callers receive an explicit metadata projection only. Full legacy pack
// content requires the origin-bound V2 read session plus a current V2 analyst
// seat or both maintainer credentials. Generation is fail-closed until the
// accepted native AI Pack model, Stage-5 write proof, quotas, and dedicated
// capability flag exist; this function never calls a model provider.

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
  ?? Deno.env.get("OSI_AIPACK_ALLOWED_ORIGIN") ?? "";
const MAINTAINER_AUTH_UUID = Deno.env.get("OSI_MAINTAINER_AUTH_UUID") ?? "";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

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

function clip(value: unknown, max: number): string {
  const text = String(value ?? "").trim();
  return text.length > max ? text.slice(0, max) : text;
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

async function authorizeRestrictedRead(
  req: Request,
  body: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
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
    requiredScope: READ_SESSION_SCOPES.REPORT_REVIEW,
  });
  if (verified.ok !== true) {
    return {
      ok: false,
      status: typeof verified.status === "number" ? verified.status : 403,
      reason: typeof verified.reason === "string" ? verified.reason : "unauthorized",
    };
  }
  if (await isVerifiedAnalyst(wallet) || await hasFullMaintainerAccess(req, wallet)) {
    return { ok: true };
  }
  return { ok: false, status: 403, reason: "not_authorized" };
}

async function handleGet(req: Request, body: Record<string, unknown>): Promise<Response> {
  const caseRef = clip(body.case_ref, 128);
  const packType = clip(body.pack_type, 40);
  if (!caseRef) return jsonResponse(400, { error: "missing_case" });

  const access = await authorizeRestrictedRead(req, body);
  if (!access.ok) return jsonResponse(access.status, { reason: access.reason });

  let query = admin.from("escalation_packs")
    .select("id,pack_type,content,status,created_at")
    .eq("case_ref", caseRef).in("status", ["approved", "attested"])
    .order("created_at", { ascending: false }).limit(1);
  if (packType) query = query.eq("pack_type", packType);
  const { data, error } = await query;
  if (error) return jsonResponse(500, { error: "lookup_failed" });
  const pack = data?.[0];
  if (!pack) return jsonResponse(404, { reason: "no_pack" });
  return jsonResponse(200, {
    ok: true,
    pack_type: pack.pack_type,
    status: pack.status,
    content: pack.content,
  });
}

async function handlePublicMeta(): Promise<Response> {
  const { data, error } = await admin.from("escalation_packs")
    .select("case_ref,pack_type,status,created_at")
    .eq("status", "approved")
    .order("created_at", { ascending: false }).limit(200);
  if (error) return jsonResponse(500, { error: "lookup_failed" });
  return jsonResponse(200, { ok: true, packs: data ?? [] });
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

  let body: Record<string, unknown> | null = null;
  try { body = await req.json(); } catch { body = null; }
  const mode = String(body?.mode ?? "");
  if (mode === "public_meta") return await handlePublicMeta();
  if (mode === "get") return await handleGet(req, body ?? {});
  if (mode === "generate") {
    return jsonResponse(503, { ok: false, error: "native_ai_pack_generation_disabled" });
  }
  return jsonResponse(400, { error: "bad_mode" });
});
