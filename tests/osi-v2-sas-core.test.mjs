// Dependency-free unit tests for the SAS verification decision core.
// Run: node tests/osi-v2-sas-core.test.mjs

const core = await import(
  new URL("../supabase/functions/_shared/osi-v2-sas-core.mjs", import.meta.url)
);

let pass = 0;
let fail = 0;
function ok(name, condition, detail = "") {
  if (condition) { pass += 1; return; }
  fail += 1;
  console.error("FAIL " + name + (detail ? " :: " + detail : ""));
}

// Real base58 pubkeys (each decodes to exactly 32 bytes).
const CRED = "11111111111111111111111111111111"; // 32 zero bytes
const SCHEMA = "So11111111111111111111111111111111111111112";
const ISSUER = "SysvarC1ock11111111111111111111111111111111";
const OTHER = "SysvarRent111111111111111111111111111111111";
const PROGRAM = core.SAS_PROGRAM_ID;

// ---- base58Decode ----
ok("base58 system program => 32 zero bytes",
  (() => {
    const b = core.base58Decode(CRED);
    return b.length === 32 && b.every((x) => x === 0);
  })());
ok("base58 decodes 32-byte pubkeys", core.base58Decode(SCHEMA).length === 32);
ok("base58 rejects bad chars", (() => {
  try { core.base58Decode("0OIl"); return false; } catch { return true; }
})());

// ---- isPubkey / validateWallet ----
ok("isPubkey accepts valid", core.isPubkey(SCHEMA) === true);
ok("isPubkey rejects short", core.isPubkey("abc") === false);
ok("validateWallet throws on junk", (() => {
  try { core.validateWallet("not a key"); return false; } catch { return true; }
})());

// ---- attestation buffer builder ----
function le32(n) { return Uint8Array.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]); }
function le64(value) {
  const out = new Uint8Array(8);
  let v = BigInt(value);
  if (v < 0n) v += 1n << 64n;
  for (let i = 0; i < 8; i += 1) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
function buildAttestation({ credential, schema, signer, expiry, data = Uint8Array.from([1, 2]) }) {
  const parts = [
    Uint8Array.from([0]),           // discriminator
    new Uint8Array(32),             // nonce
    core.base58Decode(credential),
    core.base58Decode(schema),
    le32(data.length),
    data,
    core.base58Decode(signer),
    le64(expiry),
    new Uint8Array(32),             // tokenAccount
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const now = 1_800_000_000;
const expected = { programId: PROGRAM, credential: CRED, schema: SCHEMA, issuer: ISSUER };

// ---- decodeAttestationAccount ----
ok("decode extracts credential/schema/signer/expiry", (() => {
  const buf = buildAttestation({ credential: CRED, schema: SCHEMA, signer: ISSUER, expiry: now + 1000 });
  const d = core.decodeAttestationAccount(buf);
  return d.credential.length === 32 && d.signer.length === 32 && Number(d.expiry) === now + 1000;
})());
ok("decode throws on truncated", (() => {
  try { core.decodeAttestationAccount(new Uint8Array([0, 1, 2])); return false; } catch { return true; }
})());

// ---- evaluateAttestation ----
function evalBuf(overrides, exp = expected, atNow = now) {
  const buf = buildAttestation({
    credential: overrides.credential ?? CRED,
    schema: overrides.schema ?? SCHEMA,
    signer: overrides.signer ?? ISSUER,
    expiry: overrides.expiry ?? (now + 1000),
  });
  return core.evaluateAttestation(
    { found: true, ownerProgram: overrides.owner ?? PROGRAM, data: buf }, exp, atNow,
  );
}

ok("verified when everything matches and unexpired",
  evalBuf({}).state === "verified" && evalBuf({}).valid === true);
ok("verified with zero expiry (no expiry)",
  evalBuf({ expiry: 0 }).state === "verified");
ok("expired when expiry in past",
  evalBuf({ expiry: now - 10 }).state === "expired" && evalBuf({ expiry: now - 10 }).valid === false);
ok("invalid on issuer mismatch",
  evalBuf({ signer: OTHER }).state === "invalid" && evalBuf({ signer: OTHER }).reason === "issuer_mismatch");
ok("invalid on schema mismatch",
  evalBuf({ schema: OTHER }).reason === "schema_mismatch");
ok("invalid on credential mismatch",
  evalBuf({ credential: OTHER }).reason === "credential_mismatch");
ok("invalid on wrong owning program",
  evalBuf({ owner: OTHER }).reason === "wrong_program");
ok("invalid/absent when account not found",
  core.evaluateAttestation({ found: false }, expected, now).reason === "absent");
ok("not_configured when expected pubkeys missing",
  core.evaluateAttestation({ found: true, data: new Uint8Array(200) },
    { programId: PROGRAM, credential: null, schema: SCHEMA, issuer: ISSUER }, now).reason === "not_configured");
ok("decode_error surfaces as invalid",
  core.evaluateAttestation({ found: true, ownerProgram: PROGRAM, data: new Uint8Array([0, 1]) },
    expected, now).reason === "decode_error");

// ---- shadowStateFor ----
ok("shadow pending on rpc failure",
  core.shadowStateFor({ status: { state: "verified" }, rpcFailed: true }) === "pending_verification");
ok("shadow uses status when ok",
  core.shadowStateFor({ status: { state: "verified" }, rpcFailed: false }) === "verified");

// ---- reconcileIssuance ----
ok("issuance no-op when unconfigured",
  core.reconcileIssuance({ settings: null, status: "verified_analyst" }).action === "noop_unconfigured");
ok("issuance no-op when configured but flag off",
  core.reconcileIssuance({ settings: { configured: true, issuanceEnabled: false }, status: "verified_analyst" }).action
    === "noop_unconfigured");
const goodSettings = { configured: true, issuanceEnabled: true, credential: CRED, schema: SCHEMA, issuer: ISSUER };
ok("issuance issues for analyst tier",
  core.reconcileIssuance({ settings: goodSettings, status: "probationary_analyst" }).action === "issue");
ok("issuance encodes tier code",
  core.reconcileIssuance({ settings: goodSettings, status: "senior_analyst" }).tierCode === 3);
ok("issuance revokes for non-analyst tier",
  core.reconcileIssuance({ settings: goodSettings, status: "contributor" }).action === "revoke");

// ---- tierStatusCode ----
ok("tier codes", core.tierStatusCode("probationary_analyst") === 1
  && core.tierStatusCode("verified_analyst") === 2
  && core.tierStatusCode("senior_analyst") === 3
  && core.tierStatusCode("contributor") === 0);

// ---- reviewKindForGovernanceAction ----
ok("governance action -> resolution",
  core.reviewKindForGovernanceAction("resolution_review") === "resolution");
ok("governance action -> challenge",
  core.reviewKindForGovernanceAction("challenge_review") === "challenge");
ok("governance action -> null for others",
  core.reviewKindForGovernanceAction("resolution_finalize") === null);

// ---- response DTOs (no secrets/PII) ----
const dto = core.publicVerifierResponse({
  wallet: SCHEMA,
  status: { state: "verified", valid: true, reason: "valid", expiry: null },
  expected, source: "live", checkedAt: "2026-07-17T00:00:00Z",
});
ok("public DTO reports validity and echoes expected pubkeys",
  dto.ok === true && dto.valid === true && dto.credential === CRED && dto.program_id === PROGRAM);
ok("public DTO carries no secret-looking fields",
  !("issuer_secret" in dto) && !("private_note" in dto));
const nc = core.notConfiguredResponse(SCHEMA);
ok("not-configured DTO is honest", nc.valid === false && nc.reason === "not_configured");

console.log(`osi-v2-sas-core: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
