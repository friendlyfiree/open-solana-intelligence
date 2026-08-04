import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { createReadSessionClient } = require("../assets/js/52-read-session.js");

let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}

const origin = "https://open-solana-intel.vercel.app";
const wallet = "11111111111111111111111111111111";
const scopes = ["case:mine", "report:mine"];
let nowMs = 1_800_000_000_000;
let signatures = 0;
let renewals = 0;
const data = new Map();
const storage = {
  getItem: (key) => data.has(key) ? data.get(key) : null,
  setItem: (key, value) => data.set(key, String(value)),
  removeItem: (key) => data.delete(key),
};
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = (iat, exp, jti, subject = wallet, authSub = null, tokenScopes = scopes) => `osi2r.${encode({
  v: 1, iss: "issuer", aud: origin, sub: subject, iat, exp,
  sid_iat: 1_800_000_000, abs_exp: 1_800_028_800, jti, scp: tokenScopes, auth_sub: authSub,
})}.signature`;
const memoryStorage = () => {
  const records = new Map();
  return {
    records,
    storage: {
      getItem: (key) => records.has(key) ? records.get(key) : null,
      setItem: (key, value) => records.set(key, String(value)),
      removeItem: (key) => records.delete(key),
    },
  };
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const client = createReadSessionClient({
  storage,
  origin,
  now: () => nowMs,
  setTimeout: () => 1,
  clearTimeout: () => {},
  ensureWallet: async () => wallet,
  signMessage: async () => {
    signatures += 1;
    return "signed";
  },
  request: async (body) => {
    if (body.op === "issue_read_session_challenge") return { challenge: "challenge" };
    if (body.op === "create_read_session") {
      return { read_session: token(1_800_000_000, 1_800_001_800, "A".repeat(32)) };
    }
    if (body.op === "renew_read_session") {
      renewals += 1;
      return { read_session: token(1_800_001_500, 1_800_003_300, "B".repeat(32)) };
    }
    throw new Error("unexpected request");
  },
});

const first = await client.get(["report:mine"], { allowUnlock: true });
ok("first private read requests exactly one wallet signature",
  signatures === 1 && first.payload.exp === 1_800_001_800);

nowMs += 1_500_000;
client.noteActivity();
await new Promise((resolve) => setImmediate(resolve));
const renewed = await client.get(["report:mine"], { allowUnlock: true });
ok("activity near idle expiry renews by presenting the existing token",
  renewals === 1 && signatures === 1 && renewed.payload.exp === 1_800_003_300);
ok("silent renewal preserves wallet, audience, scopes and absolute lifetime",
  renewed.payload.sub === wallet
    && renewed.payload.aud === origin
    && renewed.payload.scp.includes("report:mine")
    && renewed.payload.abs_exp === 1_800_028_800);

{
  const isolated = memoryStorage();
  const issue = deferred();
  let signed = 0;
  const staleUnlockClient = createReadSessionClient({
    storage: isolated.storage,
    origin,
    now: () => nowMs,
    setTimeout: () => 1,
    clearTimeout: () => {},
    ensureWallet: async () => wallet,
    signMessage: async () => { signed += 1; return "signed"; },
    request: async (body) => {
      if (body.op === "issue_read_session_challenge") return issue.promise;
      if (body.op === "create_read_session") {
        return { read_session: token(1_800_001_500, 1_800_003_300, "C".repeat(32)) };
      }
      throw new Error("unexpected request");
    },
  });
  const unlocking = staleUnlockClient.get(["report:mine"], { allowUnlock: true });
  await new Promise((resolve) => setImmediate(resolve));
  staleUnlockClient.handleWallet("11111111111111111111111111111112");
  issue.resolve({ challenge: "stale challenge" });
  await assert.rejects(unlocking, /read_session_changed/);
  ok("a wallet change invalidates an in-flight unlock before any signature or token write",
    signed === 0 && !isolated.records.has("osi_v2_read_session_v1"));
}

{
  const isolated = memoryStorage();
  const issue = deferred();
  const stableAuthClient = createReadSessionClient({
    storage: isolated.storage,
    origin,
    now: () => nowMs,
    setTimeout: () => 1,
    clearTimeout: () => {},
    initialWallet: wallet,
    initialAuthSubject: "auth-subject",
    ensureWallet: async () => wallet,
    signMessage: async () => "signed",
    request: async (body) => {
      if (body.op === "issue_read_session_challenge") return issue.promise;
      if (body.op === "create_read_session") {
        return { read_session: token(1_800_001_500, 1_800_003_300, "D".repeat(32), wallet, "auth-subject") };
      }
      throw new Error("unexpected request");
    },
  });
  const unlocking = stableAuthClient.get(["report:mine"], { allowUnlock: true });
  await new Promise((resolve) => setImmediate(resolve));
  stableAuthClient.handleAuth("auth-subject");
  issue.resolve({ challenge: "stable challenge" });
  const result = await unlocking;
  ok("a duplicate same-subject auth event does not cancel a valid in-flight unlock",
    result.payload.auth_sub === "auth-subject");
}

{
  const isolated = memoryStorage();
  isolated.storage.setItem("osi_v2_read_session_v1", JSON.stringify({
    token: token(1_800_001_500, 1_800_001_900, "E".repeat(32), wallet, "auth-one"),
  }));
  const renewal = deferred();
  let clearEvents = 0;
  const renewalClient = createReadSessionClient({
    storage: isolated.storage,
    origin,
    now: () => nowMs,
    setTimeout: () => 1,
    clearTimeout: () => {},
    initialWallet: wallet,
    initialAuthSubject: "auth-one",
    ensureWallet: async () => wallet,
    signMessage: async () => "signed",
    onClear: () => { clearEvents += 1; },
    request: async (body) => {
      if (body.op === "renew_read_session") return renewal.promise;
      throw new Error("unexpected request");
    },
  });
  renewalClient.noteActivity();
  await new Promise((resolve) => setImmediate(resolve));
  renewalClient.handleAuth("auth-two");
  renewal.resolve({
    read_session: token(1_800_001_500, 1_800_003_300, "F".repeat(32), wallet, "auth-one"),
  });
  await new Promise((resolve) => setImmediate(resolve));
  ok("a stale renewal cannot repopulate storage after the auth identity changes",
    clearEvents === 1 && !isolated.records.has("osi_v2_read_session_v1"));
}

{
  const isolated = memoryStorage();
  isolated.storage.setItem("osi_v2_read_session_v1", JSON.stringify({
    token: token(1_800_001_500, 1_800_003_300, "G".repeat(32)),
  }));
  const callbacks = [];
  let clearEvents = 0;
  const timerClient = createReadSessionClient({
    storage: isolated.storage,
    origin,
    now: () => nowMs,
    setTimeout: (callback) => { callbacks.push(callback); return callbacks.length; },
    clearTimeout: () => {},
    initialWallet: wallet,
    initialAuthSubject: null,
    ensureWallet: async () => wallet,
    signMessage: async () => "signed",
    request: async () => { throw new Error("unexpected request"); },
    onClear: () => { clearEvents += 1; },
  });
  timerClient.clear("explicit_refresh");
  await callbacks[0]();
  ok("a cancelled expiry timer cannot clear a newer generation twice",
    clearEvents === 1 && !isolated.records.has("osi_v2_read_session_expired_v1"));
}


// Scopes the wallet is not entitled to must cost at most one round trip.
//
// The server derives scopes from standing and ignores what the client asks
// for, so signing again cannot produce a scope the wallet does not have. Before
// this guard, every visit to an analyst-only surface reopened the wallet, got
// back a token that still lacked the scope, and failed anyway: moving between
// tabs produced an endless run of prompts that could never succeed.
//
// This section keeps its own clock. The shared `nowMs` above is advanced by
// earlier checks, and a token that drifts into the renewal window gets silently
// refreshed, which would hide the very prompt these checks are counting.
const BASE_SCOPES = ["case:mine", "case:detail", "report:mine", "wire:mine", "aipack:detail", "analyst:workspace"];
const ANALYST_SCOPES = BASE_SCOPES.concat(["case:review", "report:review", "wire:queue"]);
const SCOPE_NOW = 2_000_000_000_000;
const SCOPE_SECONDS = SCOPE_NOW / 1000;

function scopeToken(scp, serial) {
  return `osi2r.${encode({
    v: 1, iss: "issuer", aud: origin, sub: wallet,
    iat: SCOPE_SECONDS, exp: SCOPE_SECONDS + 1800,
    sid_iat: SCOPE_SECONDS, abs_exp: SCOPE_SECONDS + 28800,
    jti: `S${String(serial).padStart(31, "x")}`, scp, auth_sub: null,
  })}.signature`;
}

function scopeHarness(grants, seedScopes) {
  const isolated = memoryStorage();
  if (seedScopes) {
    isolated.storage.setItem("osi_v2_read_session_v1", JSON.stringify({ token: scopeToken(seedScopes, 0) }));
  }
  const state = { signatures: 0, renewals: 0, grants, serial: 0 };
  state.client = createReadSessionClient({
    storage: isolated.storage,
    origin,
    now: () => SCOPE_NOW,
    setTimeout: () => 0,
    clearTimeout: () => {},
    ensureWallet: async () => wallet,
    signMessage: async () => { state.signatures += 1; return "signed"; },
    request: async (body) => {
      if (body.op === "issue_read_session_challenge") return { ok: true, challenge: "challenge" };
      if (body.op === "renew_read_session") state.renewals += 1;
      if (body.op === "create_read_session" || body.op === "renew_read_session") {
        return { ok: true, read_session: scopeToken(state.grants, ++state.serial) };
      }
      throw new Error(`unexpected op ${body.op}`);
    },
  });
  return state;
}

async function reach(state, scopes) {
  try { await state.client.get(scopes, { allowUnlock: true }); return "ok"; }
  catch (error) { return error.code || error.message; }
}

{
  const state = scopeHarness(BASE_SCOPES);
  const opened = await reach(state, ["case:mine"]);
  const afterOpen = state.signatures;
  const granted = [await reach(state, ["report:mine"]), await reach(state, ["wire:mine"])];
  ok("one signature opens every surface the wallet is entitled to",
    opened === "ok" && afterOpen === 1 && granted.every((value) => value === "ok") && state.signatures === 1);

  const denied = [
    await reach(state, ["case:review"]),
    await reach(state, ["case:review"]),
    await reach(state, ["wire:queue"]),
    await reach(state, ["report:review"]),
  ];
  ok("a scope the wallet lacks is refused without ever reopening the wallet",
    denied.every((value) => value === "read_session_scope_denied") && state.signatures === 1);

  ok("refusing one surface leaves the rest of the session working",
    await reach(state, ["case:mine"]) === "ok" && state.signatures === 1);
}

{
  // A token restored on page load may predate standing granted since. It is
  // worth exactly one round trip, and the answer then holds for every scope.
  const state = scopeHarness(ANALYST_SCOPES, BASE_SCOPES);
  ok("a stale token still serves the scopes it does carry, with no signature",
    await reach(state, ["case:mine"]) === "ok" && state.signatures === 0);
  ok("newly granted standing is picked up by exactly one signature",
    await reach(state, ["case:review"]) === "ok" && state.signatures === 1);
  ok("the refreshed token then covers the rest without asking again",
    await reach(state, ["report:review"]) === "ok"
    && await reach(state, ["wire:queue"]) === "ok"
    && state.signatures === 1);
}

{
  // Two surfaces unlocking at once must not share each other's verdict.
  const state = scopeHarness(BASE_SCOPES);
  const [allowed, refused] = await Promise.all([reach(state, ["case:mine"]), reach(state, ["case:review"])]);
  ok("concurrent callers are judged independently against one unlock",
    allowed === "ok" && refused === "read_session_scope_denied" && state.signatures === 1);
}

console.log(`\n${passed} read-session client renewal checks passed.`);
