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

// ---- base58Encode (round-trips, incl. all-zero edge case) ----
for (const k of [
  "11111111111111111111111111111111",
  "So11111111111111111111111111111111111111112",
  "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG",
  "HGzKE9KTjugR2WrQd1wpqr6gcZT6GZGLtr4L5SPYDR9G",
]) {
  ok("base58 round-trip " + k.slice(0, 8), core.base58Encode(core.base58Decode(k)) === k);
}

// ---- isOnCurve (reference vectors from @solana/web3.js PublicKey.isOnCurve) ----
ok("isOnCurve: system program is on curve",
  core.isOnCurve(core.base58Decode("11111111111111111111111111111111")) === true);
ok("isOnCurve: SAS program id is on curve",
  core.isOnCurve(core.base58Decode(PROGRAM)) === true);
ok("isOnCurve: a derived PDA is OFF curve",
  core.isOnCurve(core.base58Decode("HGzKE9KTjugR2WrQd1wpqr6gcZT6GZGLtr4L5SPYDR9G")) === false);

// ---- findProgramAddress / deriveAttestationPda (vs @solana/web3.js) ----
// Vector 1: seeds [ "attestation", CRED, SCHEMA, WALLET ], program = SAS
//   web3.js findProgramAddressSync => HGzKE9KTjugR2WrQd1wpqr6gcZT6GZGLtr4L5SPYDR9G, bump 255
const pdaVec1 = await core.deriveAttestationPda({
  credential: "8krGZVXQipRG3d29QQgi3nT9Ufg1VMc48VN7Gcbb9G2G",
  schema: "So11111111111111111111111111111111111111112",
  wallet: "SysvarC1ock11111111111111111111111111111111",
});
ok("deriveAttestationPda matches web3.js (bump 255)",
  pdaVec1 === "HGzKE9KTjugR2WrQd1wpqr6gcZT6GZGLtr4L5SPYDR9G", pdaVec1);
// Vector 2: exercises the bump search (first off-curve bump is 253)
const enc = new TextEncoder();
const vec2 = await core.findProgramAddress(
  [
    enc.encode("attestation"),
    core.base58Decode("So11111111111111111111111111111111111111112"),
    core.base58Decode("8krGZVXQipRG3d29QQgi3nT9Ufg1VMc48VN7Gcbb9G2G"),
    core.base58Decode(PROGRAM),
  ],
  PROGRAM,
);
ok("findProgramAddress bump search matches web3.js (bump 253)",
  vec2.address === "6rHiseWZPcKM6jfDCaG8Tf8xkWE7XQ7ayDvry1JRFuR3" && vec2.bump === 253,
  vec2.address + "/" + vec2.bump);

// ---- base64ToBytes ----
ok("base64ToBytes decodes account data",
  (() => {
    const b = core.base64ToBytes("AAECaGk="); // 00 01 02 'h' 'i'
    return b.length === 5 && b[0] === 0 && b[1] === 1 && b[2] === 2 && b[3] === 104 && b[4] === 105;
  })());

// ---- glue / shim / issuer wiring (import shape only, no network) ----
const { readFileSync } = await import("node:fs");
const read = (p) => readFileSync(new URL("../supabase/functions/" + p, import.meta.url), "utf8");
const glue = read("_shared/osi-v2-sas-onchain.ts");
const shim = read("_shared/osi-v2-sas-sdk.ts");
const issuer = read("_shared/osi-v2-sas-issuer.ts");
const analyst = read("osi-v2-analyst/index.ts");

ok("read glue has NO computed/dynamic import and NO remote esm.sh import",
  !/computedImport/.test(glue) && !/import\((?!\s*["']\.)/.test(glue) && !/esm\.sh/.test(glue));
ok("read glue derives the PDA SDK-free and reads via fetch",
  /deriveAttestationPda/.test(glue) && /fetch\(RPC_URL/.test(glue) && /getAccountInfo/.test(glue));
ok("read glue never returns a raw error in a public reason (neutral rpc_unavailable)",
  /rpc_unavailable/.test(glue) && /rawError/.test(glue));
ok("SDK shim carries @ts-nocheck and statically imports the pinned SDK URLs",
  /^\/\/ @ts-nocheck/.test(shim)
    && /from "https:\/\/esm\.sh\/@solana\/kit@5"/.test(shim)
    && /from "https:\/\/esm\.sh\/sas-lib@1\.0\.10"/.test(shim));
ok("issuer imports the SDK from the static shim (not a dynamic import)",
  /from "\.\/osi-v2-sas-sdk\.ts"/.test(issuer) && !/computedImport|import\(/.test(issuer));
ok("analyst imports issuance from the issuer module",
  /maybeReconcileSasCredential.*from "\.\.\/_shared\/osi-v2-sas-issuer\.ts"/.test(analyst));

console.log(`osi-v2-sas-core: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
