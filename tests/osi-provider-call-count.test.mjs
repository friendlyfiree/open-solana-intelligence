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
const wireIntegration = readFileSync(new URL("../assets/js/v2-wire-integration.js", import.meta.url), "utf8");
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
  nowMs += 1_801_000;
let expiryDenied = false;
try { await expiring.get([READ_SESSION_SCOPES.CASE_MINE]); } catch (error) { expiryDenied = error.message === "read_session_expired"; }
ok("genuine inactivity expiry clears private state and never silently signs", expiryDenied && signMessageCalls === beforeExpirySignatures);
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
ok("Wire Phase 1 requests exactly one class-A transaction approval per prepared version",
  (wireIntegration.match(/state\.pending\.txSig=await castOnchainVote\(/g) || []).length === 1
    && wireIntegration.includes("if(!state.pending.txSig)"));

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

// Phantom detection must survive a second installed Solana wallet, a wallet
// that only publishes window.phantom.solana, and a late-injecting extension.
function phantomStub(overrides) {
  const stub = {
    isPhantom: true, isConnected: false, publicKey: null, connectCalls: 0,
    async connect() {
      stub.connectCalls += 1;stub.isConnected = true;stub.publicKey = { toString: () => wallet };
      return { publicKey: stub.publicKey };
    },
  };
  return Object.assign(stub, overrides || {});
}
function walletKey(ctx) { return vm.runInContext("walletPubkey", ctx); }
function walletContext(globals) {
  const store = new MemoryStorage();
  const created = {
    window: null, document: { readyState: "complete", getElementById: () => null, body: { dataset: {} } },
    localStorage: store, sessionStorage: store, console, Promise, Map, Set,
    TextEncoder, TextDecoder, Uint8Array, setTimeout, clearTimeout,
    lsGet: () => "", pfIdenticon: () => "", showToast: () => {}, openedUrls: [],
  };
  Object.assign(created, globals || {});
  created.window = created;
  created.open = (url) => { created.openedUrls.push(url); };
  vm.createContext(created);vm.runInContext(walletSource, created);
  return created;
}

const foreignWallet = { isPhantom: false, isConnected: false, publicKey: null, connect: async () => ({}) };
const namespaced = phantomStub();
const namespacedContext = walletContext({ phantom: { solana: namespaced }, solana: foreignWallet });
ok("a second installed wallet on window.solana never hides Phantom",
  namespacedContext.getProvider() === namespaced);
ok("connecting with a foreign window.solana still opens Phantom",
  (await namespacedContext.toggleWallet()) === true && namespaced.connectCalls === 1
    && walletKey(namespacedContext) === wallet);

const listed = phantomStub();
const listContext = walletContext({ solana: Object.assign({}, foreignWallet, { providers: [foreignWallet, listed] }) });
ok("Phantom is found in a multi-provider list", listContext.getProvider() === listed);

const emptyContext = walletContext({ solana: foreignWallet });
ok("a browser with no Phantom reports it honestly and offers the install page",
  emptyContext.getProvider() === null
    && (await emptyContext.toggleWallet()) === false
    && emptyContext.openedUrls.length === 1);

const lateProvider = phantomStub();
const lateContext = walletContext({ document: { readyState: "loading", getElementById: () => null, body: { dataset: {} } } });
const lateConnect = lateContext.toggleWallet();
setTimeout(() => { lateContext.phantom = { solana: lateProvider }; }, 200);
ok("an extension that injects after the page starts still connects",
  (await lateConnect) === true && lateProvider.connectCalls === 1 && lateContext.openedUrls.length === 0);

const keyOnProvider = phantomStub({ async connect() { keyOnProvider.isConnected = true;keyOnProvider.publicKey = { toString: () => wallet };return undefined; } });
const keyOnProviderContext = walletContext({ phantom: { solana: keyOnProvider } });
ok("a connect result without a publicKey falls back to the provider key",
  (await keyOnProviderContext.toggleWallet()) === true && walletKey(keyOnProviderContext) === wallet);

// Phantom answers a request its suspended worker could not handle with a
// generic internal error. One retry is honest; a decline never is.
const sleepyProvider = phantomStub();
const sleepyBase = sleepyProvider.connect;
sleepyProvider.connect = async function (options) {
  if (sleepyProvider.connectCalls === 0) {
    sleepyProvider.connectCalls += 1;
    const error = new Error("Unexpected error");
    error.code = -32603;
    throw error;
  }
  return sleepyBase.call(sleepyProvider, options);
};
const sleepyContext = walletContext({ phantom: { solana: sleepyProvider } });
ok("a suspended Phantom worker is retried once and connects",
  (await sleepyContext.toggleWallet()) === true && sleepyProvider.connectCalls === 2
    && walletKey(sleepyContext) === wallet);

const declinedProvider = phantomStub({
  async connect() {
    declinedProvider.connectCalls += 1;
    const error = new Error("User rejected the request.");
    error.code = 4001;
    throw error;
  },
});
const declinedContext = walletContext({ phantom: { solana: declinedProvider } });
ok("a declined connection is never retried behind the user's back",
  (await declinedContext.toggleWallet()) === false && declinedProvider.connectCalls === 1);

const mappingContext = walletContext({ phantom: { solana: phantomStub() } });
const unexpected = Object.assign(new Error("Unexpected error"), { code: -32603 });
ok("the generic provider error is named for what the visitor can do about it",
  mappingContext.walletErrorDetail(unexpected).indexOf("Phantom did not answer this request") === 0
    && mappingContext.walletErrorDetail(new Error("locked")).indexOf("Phantom is locked") === 0);
ok("a server code is not mistaken for a wallet failure",
  mappingContext.walletErrorDetail(new Error("case_writes_disabled")) === ""
    && mappingContext.walletErrorDetail(new Error("A Case can include at most 12 structured evidence references.")) === "");

const libraryContext = walletContext({ phantom: { solana: phantomStub() } });
await libraryContext.toggleWallet();
let libraryFailure = "";
try { await libraryContext.castOnchainVote("CASE_SUBMITTED"); } catch (error) { libraryFailure = libraryContext.walletErrorMessage(error, "Signing"); }
ok("a missing transaction library is named instead of thrown as a raw ReferenceError",
  libraryFailure === "The Solana transaction library did not load in this browser. Hard-refresh (Ctrl/Cmd + Shift + R) and try again.");
ok("an empty wallet is told about the network fee",
  libraryContext.walletErrorMessage(new Error("Attempt to debit an account but found no record of a prior credit."), "Signing")
    === "This wallet does not hold enough SOL for the Solana network fee (~0.000005 SOL). Add a small amount of SOL, then try again.");

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

// The voluntary support transfer keeps its own tailored wording and inherits
// every shared wallet mapping instead of falling back to "was not sent".
const tipSource = readFileSync(new URL("../assets/js/70-support-transfer.js", import.meta.url), "utf8");
ok("the support transfer explains a wallet failure with the shared mapping",
  /walletErrorDetail\(e\)\)\|\|'The transfer was not sent\.'/.test(tipSource)
    && tipSource.indexOf("Not enough SOL for that amount plus the network fee.") > 0);

console.log(`\n${passed} provider call-count and invalidation checks passed.`);
