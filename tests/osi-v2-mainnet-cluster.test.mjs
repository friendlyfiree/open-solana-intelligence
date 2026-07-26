import { readFileSync } from "node:fs";
import { isSolanaMainnetGenesis, SOLANA_MAINNET_GENESIS_HASH } from
  "../supabase/functions/_shared/osi-v2-payment-core.mjs";

const expected = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const sources = [
  "supabase/functions/osi-v2-report-write/index.ts",
  "supabase/functions/osi-v2-wire/index.ts",
  "supabase/functions/osi-v2-governance-write/index.ts",
  "supabase/functions/osi-v2-ai-pack/index.ts",
].map((path) => readFileSync(new URL("../" + path, import.meta.url), "utf8"));

let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}

ok("healthy Solana mainnet genesis response is recognized exactly",
  SOLANA_MAINNET_GENESIS_HASH === expected && isSolanaMainnetGenesis(expected));
ok("the previously truncated value and non-mainnet clusters are rejected",
  !isSolanaMainnetGenesis("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
    && !isSolanaMainnetGenesis("GH7ome3EiwEr7tu9JuTh2dpYWBJK3z69Xm1ZE3MEE6JC"));
ok("every Memo-anchored cluster gate compares the complete mainnet identity",
  sources.every((source) => source.includes(`"${expected}"`))
    && sources.every((source) => !source.includes('"5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"')));

console.log(`\n${passed} mainnet cluster regression checks passed.`);
