// @ts-nocheck
// OSI V2 — SAS SDK shim (issuance signing path only).
//
// Why this file exists: the Supabase Edge Runtime only ships modules that are
// STATICALLY imported and bundled at deploy time. A computed/runtime dynamic
// import of a remote URL is NOT bundled and fails at runtime with
// "Module not found". So the Solana signing SDKs must be statically imported.
//
// To keep the CI `deno check` gate fast and resilient (it otherwise downloads
// and type-checks the entire third-party SDK `.d.ts` graph on every run), this
// one small module carries `// @ts-nocheck` and re-exports exactly the symbols
// the issuance path uses. Consumers import typed-as-`any` helpers from here.
//
// This module is imported ONLY by osi-v2-sas-issuer.ts, which is imported ONLY
// by osi-v2-analyst. The verification/read path never imports it, so the heavy
// signing SDK is not bundled into the other functions.

export {
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
} from "https://esm.sh/@solana/kit@5";

export {
  deriveAttestationPda,
  fetchSchema,
  serializeAttestationData,
  getCreateAttestationInstruction,
  getCloseAttestationInstruction,
} from "https://esm.sh/sas-lib@1.0.10";
