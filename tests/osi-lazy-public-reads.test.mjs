// Two reads used to run on every page load for surfaces that may never open:
// the CoinGecko SOL price (only the legacy support dialog shows it, and the
// free API often answers 429, which printed a console error everywhere) and
// the maintainer profile (only the Analyst Network draws it). Both are now
// read on demand. These checks keep them from drifting back into boot.
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const app = read("assets/js/99-app.js");
const deck = read("assets/js/44-prooflog-deck.js");
const tip = read("assets/js/70-support-transfer.js");
const analyst = read("assets/js/v2-analyst-integration.js");
const csp = read("vercel.json");
let passed = 0;
function ok(name, value) {
  if (!value) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}
const code = (source) => source.replace(/\/\/[^\n]*/g, "");

ok("boot no longer fetches the SOL price", !/^\s*loadPrice\(\);/m.test(code(app)));
ok("the legacy support dialog asks for the price when it opens",
  /function openTip[\s\S]*?loadPrice\(\)\.then\(function\(\)\{[\s\S]*?updateTipUsd\(\);/.test(tip));
ok("the price read is single flight, reused for five minutes and paused after a failure",
  deck.includes("var SOL_PRICE_TTL_MS = 5 * 60 * 1000;") && deck.includes("if(solPriceInflight) return solPriceInflight;")
    && deck.includes("var SOL_PRICE_RETRY_MS = 60 * 1000;") && deck.includes("if(!r.ok) throw new Error('price_http_'+r.status);"));
ok("a failed price read leaves the estimate empty rather than showing a stale or zero figure",
  tip.includes("SOL_PRICE ? ('≈ $'") && deck.includes("!(Number(j.solana.usd) > 0)"));
ok("CSP still names the price API, so the legacy dialog keeps working", csp.includes("https://api.coingecko.com"));

const loadProfiles = analyst.slice(analyst.indexOf("async function loadPublicProfiles"), analyst.indexOf("function maintainerCardWanted"));
ok("loading the analyst roster no longer reads the maintainer profile by itself",
  loadProfiles.includes("if(maintainerCardWanted())ensureMaintainerProfile();") && !/[^.]loadMaintainerProfile\(\);/.test(loadProfiles));
ok("the maintainer card is read when the Analyst Network opens or the maintainer gates are held",
  /view==='analysts'\|\|state\.maintainerAccess===true/.test(analyst)
    && /attributeFilter:\['data-view'\]/.test(analyst));
ok("a profile link naming the maintainer still resolves it before saying unavailable",
  /if\(!profile&&!state\.maintainerProfileLoaded\)\{[\s\S]*?await ensureMaintainerProfile\(\);[\s\S]*?maintainerModalProfile\(lateMaintainer\)/.test(analyst));
ok("a maintainer capability change still reloads the card", /state\.maintainerAccess=next;\s*loadMaintainerProfile\(\);/.test(analyst));
console.log(`\n${passed} lazy public read checks passed.`);
