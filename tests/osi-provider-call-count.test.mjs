import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import {
  issueReadSessionToken,
  READ_SESSION_SCOPES,
  readSessionIssuer,
} from "../supabase/functions/_shared/osi-v2-read-session-core.mjs";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, "binary").toString("base64");
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, "base64").toString("binary");

const require = createRequire(import.meta.url);
const clientCore = require("../assets/js/52-read-session.js");
let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}

class MemoryStorage {
  constructor(seed) { this.values = new Map(seed ? [...seed.values] : []); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const secret = "provider-count-test-secret-which-is-longer-than-thirty-two-bytes";
const wallet = "11111111111111111111111111111111";
const origin = "https://open-solana-intel.vercel.app";
const issuer = readSessionIssuer("https://afibxpniwfnavdobecrn.supabase.co");
const allScopes = Object.values(READ_SESSION_SCOPES);
let nowMs = 1_784_110_000_000;
let signMessageCalls = 0;
let challengeCalls = 0;
let createCalls = 0;
let cacheClears = 0;
const storage = new MemoryStorage();

async function request(body) {
  if (body.op === "issue_read_session_challenge") {
    challengeCalls += 1;
    return { ok: true, challenge: `challenge-${challengeCalls}` };
  }
  if (body.op === "create_read_session") {
    createCalls += 1;
    const issued = await issueReadSessionToken({
      secret, issuer, audience: origin, allowedOrigin: origin, wallet,
      scopes: allScopes, authSubject: null, jti: String(createCalls).padStart(32, "A"),
      nowSeconds: Math.floor(nowMs / 1000),
    });
    return { ok: true, read_session: issued.token };
  }
  throw new Error("unexpected request");
}

function client(store = storage) {
  const value = clientCore.createReadSessionClient({
    storage: store, origin, request,
    ensureWallet: async () => wallet,
    signMessage: async () => { signMessageCalls += 1; return "signed"; },
    now: () => nowMs,
    setTimeout: () => 1,
    clearTimeout: () => {},
    onClear: () => { cacheClears += 1; },
  });
  value.registerCache("private-dtos", () => { cacheClears += 1; });
  return value;
}

const first = client();
await Promise.all([
  first.get([READ_SESSION_SCOPES.CASE_MINE]),
  first.get([READ_SESSION_SCOPES.REPORT_MINE]),
  first.get([READ_SESSION_SCOPES.ANALYST_WORKSPACE]),
]);
ok("concurrent first private reads share one signMessage", signMessageCalls === 1 && challengeCalls === 1 && createCalls === 1);

await first.get([READ_SESSION_SCOPES.CASE_REVIEW]);
await first.get([READ_SESSION_SCOPES.REPORT_REVIEW]);
await first.get([READ_SESSION_SCOPES.ANALYST_WORKSPACE]);
await first.get([READ_SESSION_SCOPES.CASE_MAINTAINER]);
await first.get([READ_SESSION_SCOPES.ANALYST_MAINTAINER]);
ok("private view navigation adds zero signatures", signMessageCalls === 1);

const reloadStorage = new MemoryStorage(storage);
const reloaded = client(reloadStorage);
await reloaded.get([READ_SESSION_SCOPES.CASE_MINE], { allowUnlock: false });
ok("valid session reload adds zero signatures", signMessageCalls === 1 && challengeCalls === 1);

reloaded.handleWallet("22222222222222222222222222222222");
ok("accountChanged clears token and all registered private caches", reloadStorage.getItem(clientCore.TOKEN_KEY) === null && cacheClears >= 2);

const expiryStorage = new MemoryStorage(storage);
const expiring = client(expiryStorage);
await expiring.get([READ_SESSION_SCOPES.CASE_MINE]);
const beforeExpirySignatures = signMessageCalls;
nowMs += 301_000;
let expiryDenied = false;
try { await expiring.get([READ_SESSION_SCOPES.CASE_MINE]); } catch (error) { expiryDenied = error.message === "read_session_expired"; }
ok("expiry clears private state and never silently signs", expiryDenied && signMessageCalls === beforeExpirySignatures);
await expiring.get([READ_SESSION_SCOPES.CASE_MINE], { explicitRefresh: true });
ok("explicit refresh performs exactly one new signMessage", signMessageCalls === beforeExpirySignatures + 1);
expiring.clear("disconnect");
ok("disconnect clears the browser-session token", expiryStorage.getItem(clientCore.TOKEN_KEY) === null);

const authStorage = new MemoryStorage();
const authClient = client(authStorage);
await authClient.get([READ_SESSION_SCOPES.CASE_MINE]);
authClient.handleAuth("00000000-0000-4000-8000-000000000001");
ok("Supabase auth identity change clears the read session", authStorage.getItem(clientCore.TOKEN_KEY) === null);

const broker = clientCore.createWalletApprovalBroker();
const writeApprovals = new Map();
const writeKinds = ["case-submit", "case-review", "challenge", "reward-pledge", "report-review", "analyst-application"];
for (const kind of writeKinds) {
  const approve = async () => {
    writeApprovals.set(kind, (writeApprovals.get(kind) || 0) + 1);
    return `${kind}-signature`;
  };
  await Promise.all([broker.message(`exact-${kind}-proof`, approve), broker.message(`exact-${kind}-proof`, approve)]);
}
ok("each Case, review, challenge, pledge, Report and analyst Class-B write has exactly one provider approval",
  writeKinds.every((kind) => writeApprovals.get(kind) === 1));

let databaseEffects = 0;
try {
  await broker.message("rejected-proof", async () => { throw new Error("user rejected"); });
  databaseEffects += 1;
} catch {}
ok("rejected signature has no database effect", databaseEffects === 0);
await broker.message("rejected-proof", async () => "retry-signature");
databaseEffects += 1;
ok("clean retry requests one new approval and commits once", databaseEffects === 1);

let transactionApprovals = 0;
await Promise.all([
  broker.transaction("exact-sol-transfer", async () => { transactionApprovals += 1; return { signature: "tx" }; }),
  broker.transaction("exact-sol-transfer", async () => { transactionApprovals += 1; return { signature: "tx" }; }),
]);
ok("one SOL transfer has exactly one transaction approval", transactionApprovals === 1);

// Exercise the real wallet connect function with a mock Phantom provider.
const walletSource = readFileSync(new URL("../assets/js/60-wallet-workspace.js", import.meta.url), "utf8");
let connectCalls = 0;
const provider = {
  isPhantom: true, isConnected: false, publicKey: null,
  async connect() { connectCalls += 1; this.isConnected = true; this.publicKey = { toString: () => wallet }; return { publicKey: this.publicKey }; },
};
const storageMock = new MemoryStorage();
const context = {
  window: null, document: { getElementById: () => null, body: { dataset: {} } },
  localStorage: storageMock, sessionStorage: storageMock, console, Promise, Map, Set,
  TextEncoder, TextDecoder, Uint8Array, setTimeout, clearTimeout,
  lsGet: () => "", pfIdenticon: () => "", showToast: () => {},
};
context.window = context;context.solana = provider;
vm.createContext(context);vm.runInContext(walletSource, context);
await Promise.all([context.toggleWallet(), context.toggleWallet(), context.toggleWallet()]);
ok("explicit concurrent connect calls open Phantom once", connectCalls === 1);

const bootSource = readFileSync(new URL("../assets/js/99-app.js", import.meta.url), "utf8");
let trustedConnectCalls = 0;
let trustedSignCalls = 0;
const loadHandlers = [];
const trustedProvider = {
  isPhantom: true, isConnected: false, publicKey: null,
  on: () => {},
  async connect(options) {
    trustedConnectCalls += 1;
    ok("trusted reload uses onlyIfTrusted", options && options.onlyIfTrusted === true);
    this.isConnected = true;this.publicKey = { toString: () => wallet };
    return { publicKey: this.publicKey };
  },
  async signMessage() { trustedSignCalls += 1; return { signature: new Uint8Array(64) }; },
};
const trustedStorage = new MemoryStorage();trustedStorage.setItem("osi_phantom_restore", "1");
const bootContext = {
  window: null, document: { getElementById: () => null, querySelectorAll: () => [], body: { dataset: {} }, addEventListener: () => {} },
  localStorage: trustedStorage, sessionStorage: trustedStorage, console, Promise, Map, Set,
  TextEncoder, TextDecoder, Uint8Array, setTimeout, clearTimeout,
  lsGet: () => "", pfIdenticon: () => "", showToast: () => {},
  renderCaseStudies: () => {}, renderCaseRecords: () => {}, syncTabCounts: () => {},
  renderRequests: () => {}, renderReviewQueue: () => {}, restoreBountyState: () => {},
  renderFieldOffice: () => {}, renderWire: () => {}, loadConfig: async () => {},
  loadAnalysts: async () => [], renderAnalysts: () => {}, renderReviewFloor: () => {},
  updateAdminButton: () => {}, renderTicker: () => {}, renderActivity: () => {}, loadPrice: () => {},
  wireContactLinks: () => {}, location: { hash: "", pathname: "/" },
};
bootContext.window = bootContext;bootContext.solana = trustedProvider;
bootContext.addEventListener = (name, handler) => { if (name === "load") loadHandlers.push(handler); };
vm.createContext(bootContext);vm.runInContext(walletSource, bootContext);vm.runInContext(bootSource, bootContext);
for (const handler of loadHandlers) handler();
await new Promise((resolve) => setTimeout(resolve, 0));
ok("trusted reload performs one silent connect and zero signature prompts", trustedConnectCalls === 1 && trustedSignCalls === 0);

console.log(`\n${passed} provider call-count and invalidation checks passed.`);
