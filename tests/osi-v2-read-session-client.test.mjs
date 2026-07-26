import { createRequire } from "node:module";

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
const token = (iat, exp, jti) => `osi2r.${encode({
  v: 1, iss: "issuer", aud: origin, sub: wallet, iat, exp,
  sid_iat: 1_800_000_000, abs_exp: 1_800_028_800, jti, scp: scopes, auth_sub: null,
})}.signature`;

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

console.log(`\n${passed} read-session client renewal checks passed.`);
