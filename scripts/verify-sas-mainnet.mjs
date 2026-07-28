#!/usr/bin/env node
// Read-only, SDK-free production audit of OSI's SAS program, Credential,
// Schema, issuer, and every explicitly supplied analyst wallet.

import {
  SAS_PROGRAM_ID,
  base58Decode,
  base64ToBytes,
  deriveAttestationPda,
  evaluateAttestation,
  validateWallet,
} from "../supabase/functions/_shared/osi-v2-sas-core.mjs";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

function required(name, pattern) {
  const value = String(process.env[name] ?? "").trim();
  if (!value || (pattern && !pattern.test(value))) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

const rpcUrl = required("SOLANA_RPC_URL", /^https:\/\//);
const programId = String(process.env.SAS_PROGRAM_ID || SAS_PROGRAM_ID).trim();
const credential = required("SAS_CREDENTIAL", /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const schema = required("SAS_SCHEMA", /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const issuer = required("SAS_ISSUER", /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const wallets = String(process.env.SAS_WALLETS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
wallets.forEach(validateWallet);

let nextId = 0;
async function rpc(method, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error) throw new Error(`RPC ${method} failed`);
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

function accountBytes(account) {
  const encoded = account?.data?.[0];
  return typeof encoded === "string" ? base64ToBytes(encoded) : new Uint8Array();
}

function safeAccount(label, pubkey, account) {
  return {
    label,
    pubkey,
    owner: account?.owner ?? null,
    executable: account?.executable === true,
    data_length: account ? accountBytes(account).length : null,
    present: !!account,
  };
}

if (programId !== SAS_PROGRAM_ID) throw new Error("unexpected SAS program id");
const genesis = await rpc("getGenesisHash", []);
if (genesis !== MAINNET_GENESIS) throw new Error("RPC is not Solana mainnet-beta");

const pdaRows = await Promise.all(wallets.map(async (wallet) => ({
  wallet,
  pda: await deriveAttestationPda({ programId, credential, schema, wallet }),
})));
const keys = [programId, credential, schema, issuer, ...pdaRows.map((row) => row.pda)];
const result = await rpc("getMultipleAccounts", [
  keys,
  { encoding: "base64", commitment: "finalized" },
]);
const accounts = result?.value;
if (!Array.isArray(accounts) || accounts.length !== keys.length) {
  throw new Error("RPC returned an incomplete account set");
}

const [programAccount, credentialAccount, schemaAccount, issuerAccount] = accounts;
if (!programAccount || programAccount.owner !== UPGRADEABLE_LOADER || programAccount.executable !== true) {
  throw new Error("SAS program is absent, not executable, or owned by an unexpected loader");
}
if (!credentialAccount || credentialAccount.owner !== programId || credentialAccount.executable === true) {
  throw new Error("OSI Credential account ownership is invalid");
}
if (!schemaAccount || schemaAccount.owner !== programId || schemaAccount.executable === true) {
  throw new Error("OSI Schema account ownership is invalid");
}
if (!issuerAccount || issuerAccount.owner !== SYSTEM_PROGRAM || issuerAccount.executable === true) {
  throw new Error("configured issuer is not a normal system-owned authority account");
}

const credentialBytes = accountBytes(credentialAccount);
const schemaBytes = accountBytes(schemaAccount);
if (credentialBytes.length !== 108 || credentialBytes[0] !== 0) {
  throw new Error("OSI Credential account data shape is unexpected");
}
if (schemaBytes.length !== 163 || schemaBytes[0] !== 1) {
  throw new Error("OSI_VERIFIED_ANALYST Schema account data shape is unexpected");
}
const credentialKeyBytes = base58Decode(credential);
if (!credentialKeyBytes.every((value, index) => schemaBytes[index + 1] === value)) {
  throw new Error("Schema is not bound to the configured OSI Credential");
}
const schemaText = new TextDecoder().decode(schemaBytes);
if (!schemaText.includes("OSI_VERIFIED_ANALYST")
    || !schemaText.includes("No PII, no case data.")
    || !schemaText.includes("tier")
    || !schemaText.includes("status")) {
  throw new Error("Schema name, privacy statement, or tier/status fields are unexpected");
}

const attestations = pdaRows.map((row, index) => {
  const account = accounts[index + 4];
  const status = evaluateAttestation({
    found: !!account,
    ownerProgram: account?.owner,
    data: accountBytes(account),
  }, { programId, credential, schema, issuer }, Math.floor(Date.now() / 1000));
  if (!status.valid || status.state !== "verified") {
    throw new Error(`analyst attestation is not valid: ${row.wallet} (${status.reason})`);
  }
  return {
    wallet: row.wallet,
    attestation_pubkey: row.pda,
    owner: account.owner,
    data_length: accountBytes(account).length,
    state: status.state,
    reason: status.reason,
    expiry: status.expiry,
  };
});

console.log(JSON.stringify({
  ok: true,
  network: "mainnet-beta",
  genesis_hash: genesis,
  accounts: [
    safeAccount("sas_program", programId, programAccount),
    safeAccount("osi_credential", credential, credentialAccount),
    safeAccount("osi_verified_analyst_schema", schema, schemaAccount),
    safeAccount("configured_issuer", issuer, issuerAccount),
  ],
  schema_binding: {
    credential_bound: true,
    name: "OSI_VERIFIED_ANALYST",
    fields: ["tier", "status"],
    pii_or_case_data: false,
  },
  attestations,
}, null, 2));
