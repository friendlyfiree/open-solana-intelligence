const PROJECT_REF = "afibxpniwfnavdobecrn";
const PRODUCTION_ORIGIN = "https://open-solana-intel.vercel.app";
const FUNCTIONS_BASE = `https://${PROJECT_REF}.supabase.co/functions/v1`;
const SEC_URL =
  "https://ir.hyperiondefi.com/static-files/9e1bc2d6-8df8-4c20-a4e4-506f702eaf37/0001104659-26-036286/hypd-20251231x10k.htm";
const TEST_CARD = "4111111111111111";

const waitArgument = Deno.args.find((value) => value.startsWith("--wait-seconds="));
const waitSeconds = Number(waitArgument?.split("=")[1] ?? "0");
if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 600) {
  throw new Error("wait-seconds must be an integer from 0 through 600");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function randomId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}-${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function base58Encode(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = "1" + encoded;
  }
  return encoded || "1";
}

function base64Encode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function post(functionName, body, expectedStatus = 200) {
  const response = await fetch(`${FUNCTIONS_BASE}/${functionName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": PRODUCTION_ORIGIN,
    },
    body: JSON.stringify(body),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = { ok: false, error: "invalid_json_response" };
  }
  if (response.status !== expectedStatus) {
    throw new Error(
      `${functionName}:${String(body.op)} expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

function requireSuccess(payload, label) {
  assert(payload?.ok === true, `${label} did not return ok:true: ${JSON.stringify(payload)}`);
  return payload;
}

async function assertPrivateConsumers(wallet, readSession, label) {
  const calls = [
    ["osi-v2-case-read", { op: "list_my_cases", wallet, read_session: readSession }],
    ["osi-v2-report-read", { op: "list_my_reports", wallet, read_session: readSession }],
    ["osi-v2-wire", { op: "list_my_wire_reports", wallet, read_session: readSession }],
    ["osi-v2-analyst", { op: "my_workspace", wallet, read_session: readSession }],
  ];
  for (const [functionName, body] of calls) {
    const payload = await post(functionName, body);
    requireSuccess(payload, `${label} ${functionName}:${body.op}`);
  }
}

const publicCases = requireSuccess(
  await post("osi-v2-case-read", { op: "list_public_cases" }),
  "public Case listing",
);
assert(Array.isArray(publicCases.cases), "public Case listing did not return a cases array");
const eligibleCase = publicCases.cases.find((item) =>
  ["open_public", "in_review", "reopened"].includes(String(item?.stage))
);
assert(eligibleCase?.public_ref, "production has no public Case eligible for Report preparation");

const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
const wallet = base58Encode(publicKey);
let signatureCount = 0;

const challenge = requireSuccess(
  await post("osi-v2-case-read", { op: "issue_read_session_challenge", wallet }),
  "read-session challenge",
);
assert(typeof challenge.challenge === "string" && challenge.challenge.length > 40, "challenge is absent");
const signatureBytes = new Uint8Array(
  await crypto.subtle.sign("Ed25519", keyPair.privateKey, new TextEncoder().encode(challenge.challenge)),
);
signatureCount += 1;
const created = requireSuccess(
  await post("osi-v2-case-read", {
    op: "create_read_session",
    wallet,
    challenge: challenge.challenge,
    signature: base64Encode(signatureBytes),
  }),
  "read-session creation",
);
assert(created.ttl_seconds === 1800, `read-session idle TTL is ${created.ttl_seconds}, expected 1800`);
assert(
  created.absolute_expires_at - created.issued_at === 28800,
  "read-session absolute lifetime is not eight hours",
);
for (
  const scope of [
    "case:mine",
    "case:detail",
    "report:mine",
    "wire:mine",
    "aipack:detail",
    "analyst:workspace",
  ]
) {
  assert(created.scopes?.includes(scope), `read-session scope is absent: ${scope}`);
}
await assertPrivateConsumers(wallet, created.read_session, "initial session");

const aiPackResult = await post("osi-v2-ai-pack", {
  op: "get_case_packs",
  case_ref: eligibleCase.public_ref,
  wallet,
  read_session: created.read_session,
});
requireSuccess(aiPackResult, "AI Pack private consumer");

const casePayload = {
  title: "Production contributor-flow smoke",
  summary_public: "Public-safe contributor flow validation.",
};
requireSuccess(
  await post("osi-v2-case-write", {
    op: "prepare_case",
    wallet,
    case: casePayload,
    idempotency_key: randomId("prod-case"),
  }),
  "minimal Case preparation",
);

const reportPayload = {
  body_private:
    "Public transactions show a repeated transfer pattern. This production smoke prepares a nonce only and does not commit a Report.",
  content_public_safe: "Public transactions show a repeated transfer pattern.",
  evidence: [{ kind: "url", ref: SEC_URL }],
};
requireSuccess(
  await post("osi-v2-report-write", {
    op: "prepare_report",
    wallet,
    case_ref: eligibleCase.public_ref,
    report: reportPayload,
    idempotency_key: randomId("prod-report"),
  }),
  "Report SEC URL preparation",
);
const refusedReport = await post("osi-v2-report-write", {
  op: "prepare_report",
  wallet,
  case_ref: eligibleCase.public_ref,
  report: { ...reportPayload, body_private: `${reportPayload.body_private} ${TEST_CARD}` },
  idempotency_key: randomId("prod-report-card"),
}, 400);
assert(
  refusedReport.error === "prohibited_personal_data",
  `test card was not refused by Report validation: ${JSON.stringify(refusedReport)}`,
);

const wirePayload = {
  title_public_safe: "Production contributor-flow smoke",
  content_public_safe: "Public transactions show a repeated transfer pattern.",
  body_private:
    "Public transactions show a repeated transfer pattern. This production smoke prepares a nonce only and does not commit a Wire version.",
  evidence: [{ kind: "url", ref: SEC_URL }],
};
requireSuccess(
  await post("osi-v2-wire", {
    op: "prepare_wire",
    wallet,
    wire: wirePayload,
    idempotency_key: randomId("prod-wire"),
  }),
  "Wire SEC URL preparation",
);
const refusedWire = await post("osi-v2-wire", {
  op: "prepare_wire",
  wallet,
  wire: { ...wirePayload, body_private: `${wirePayload.body_private} ${TEST_CARD}` },
  idempotency_key: randomId("prod-wire-card"),
}, 400);
assert(
  refusedWire.error === "prohibited_personal_data",
  `test card was not refused by Wire validation: ${JSON.stringify(refusedWire)}`,
);
for (const [name, bodyPrivate, expectedError] of [
  [
    "secret material",
    "This detailed analysis is long enough but asks for a seed phrase and private key.",
    "prohibited_secret_material",
  ],
  [
    "illegal-access material",
    "This detailed analysis includes stolen credentials for unauthorized access.",
    "prohibited_illegal_access_material",
  ],
  [
    "doxxing material",
    "This detailed analysis includes a private home address for doxxing.",
    "prohibited_personal_data",
  ],
]) {
  const refused = await post("osi-v2-wire", {
    op: "prepare_wire",
    wallet,
    wire: { ...wirePayload, body_private: bodyPrivate },
    idempotency_key: randomId(`prod-wire-${name.replaceAll(" ", "-")}`),
  }, 400);
  assert(
    refused.error === expectedError,
    `${name} was not refused by Wire validation: ${JSON.stringify(refused)}`,
  );
}
const refusedHttpWire = await post("osi-v2-wire", {
  op: "prepare_wire",
  wallet,
  wire: { ...wirePayload, evidence: [{ kind: "url", ref: "http://example.com/evidence" }] },
  idempotency_key: randomId("prod-wire-http"),
}, 400);
assert(
  refusedHttpWire.error === "evidence URL is invalid",
  `non-HTTPS evidence was not refused by Wire validation: ${JSON.stringify(refusedHttpWire)}`,
);

const xHandle = `osi_smoke_${randomId("").replaceAll("-", "").slice(0, 4)}`;
assert(/^[a-z0-9_]{2,15}$/.test(xHandle), "smoke X handle does not match the application contract");
requireSuccess(
  await post("osi-v2-analyst", {
    op: "prepare_application",
    wallet,
    application: {
      x_handle: xHandle,
      display_name: "OSI smoke",
      bio: "Independent public-source analyst.",
      experience: "I trace public transactions and document reproducible findings.",
    },
    idempotency_key: randomId("prod-analyst"),
  }),
  "minimal analyst application preparation",
);

if (waitSeconds > 0) {
  console.log(`Waiting ${waitSeconds}s to cross the retired five-minute session boundary.`);
  await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
}

await assertPrivateConsumers(wallet, created.read_session, "post-boundary original session");
const renewed = requireSuccess(
  await post("osi-v2-case-read", {
    op: "renew_read_session",
    wallet,
    read_session: created.read_session,
  }),
  "silent read-session renewal",
);
assert(renewed.silently_renewed === true, "renewal was not marked silent");
assert(renewed.absolute_expires_at === created.absolute_expires_at, "renewal extended absolute lifetime");
assert(signatureCount === 1, `session required ${signatureCount} signatures instead of one`);
await assertPrivateConsumers(wallet, renewed.read_session, "renewed session");

console.log(JSON.stringify({
  ok: true,
  project_ref: PROJECT_REF,
  wallet,
  eligible_case: eligibleCase.public_ref,
  idle_ttl_seconds: created.ttl_seconds,
  absolute_ttl_seconds: created.absolute_expires_at - created.issued_at,
  signatures: signatureCount,
  crossed_old_boundary_seconds: waitSeconds,
  prepared_only: ["case", "report", "wire", "analyst_application"],
  wire_safety_checks: ["payment_card", "secret_material", "illegal_access", "doxxing", "https_only"],
  committed_domain_records: 0,
}));
