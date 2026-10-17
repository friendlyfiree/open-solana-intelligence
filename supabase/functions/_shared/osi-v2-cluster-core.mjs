// Dependency-free Solana cluster check shared by every Memo-anchored and
// payment verification. It runs unchanged under Deno in the Edge Functions and
// under Node in tests.

export const SOLANA_MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

// Reads the getGenesisHash item of a JSON-RPC batch. Only a genesis hash that
// is present and different proves the wrong cluster. A missing or failed item
// is a retryable RPC failure, never a cluster verdict. Returns null when the
// batch identifies the expected cluster.
export function genesisBatchFailure(results, expected = SOLANA_MAINNET_GENESIS_HASH, id = 3) {
  if (!Array.isArray(results)) return "rpc_invalid_response";
  const genesis = results.find((item) => item?.id === id);
  if (typeof genesis?.result === "string" && genesis.result !== expected) return "wrong_cluster";
  if (genesis?.result !== expected) return "rpc_invalid_response";
  return null;
}
