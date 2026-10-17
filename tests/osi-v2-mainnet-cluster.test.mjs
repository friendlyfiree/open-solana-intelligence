import { readFileSync } from "node:fs";
import { isSolanaMainnetGenesis, SOLANA_MAINNET_GENESIS_HASH } from
  "../supabase/functions/_shared/osi-v2-payment-core.mjs";
import { genesisBatchFailure, SOLANA_MAINNET_GENESIS_HASH as CLUSTER_GENESIS } from
  "../supabase/functions/_shared/osi-v2-cluster-core.mjs";

const expected = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const sources = [
  "supabase/functions/osi-v2-report-write/index.ts",
  "supabase/functions/osi-v2-wire/index.ts",
  "supabase/functions/osi-v2-governance-write/index.ts",
  "supabase/functions/osi-v2-ai-pack/index.ts",
  "supabase/functions/osi-v2-case-write/index.ts",
  "supabase/functions/osi-v2-analyst/index.ts",
].map((path) => readFileSync(new URL("../" + path, import.meta.url), "utf8"));
const memoGateways = sources.slice(1);

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

ok("the shared cluster check carries the same complete mainnet identity",
  CLUSTER_GENESIS === expected);
ok("Case, analyst, Wire, governance and AI Pack Memos all ask the RPC for its genesis hash",
  memoGateways.every((source) => source.includes('method: "getGenesisHash"'))
    && memoGateways.every((source) => source.includes("genesisBatchFailure(")));
ok("a genesis hash that differs from mainnet is the wrong cluster",
  genesisBatchFailure([{ id: 3, result: "GH7ome3EiwEr7tu9JuTh2dpYWBJK3z69Xm1ZE3MEE6JC" }]) === "wrong_cluster");
ok("a missing or failed genesis item is a retryable RPC failure, not a cluster verdict",
  genesisBatchFailure([{ id: 1, result: {} }]) === "rpc_invalid_response"
    && genesisBatchFailure([{ id: 3, error: { code: -32005, message: "busy" } }]) === "rpc_invalid_response"
    && genesisBatchFailure({ id: 3, result: expected }) === "rpc_invalid_response"
    && genesisBatchFailure(null) === "rpc_invalid_response");
ok("the mainnet genesis passes, at the batch position each caller uses",
  genesisBatchFailure([{ id: 3, result: expected }]) === null
    && genesisBatchFailure([{ id: 2, result: expected }], expected, 2) === null);

console.log(`\n${passed} mainnet cluster regression checks passed.`);
