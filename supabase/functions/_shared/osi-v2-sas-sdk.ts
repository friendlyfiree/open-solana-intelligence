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
//
// `?deps=ws@8.18.0` is load-bearing and must not be dropped.
//
// The Solana SDK pulls `ws` transitively for RPC subscriptions. esm.sh resolves
// that to the newest release at build time, and `ws@8.21.3`'s denonext build
// throws while evaluating: it cannot resolve `node:url`, so destructuring `URL`
// off the failed import gives "Cannot destructure property 'URL' of 'p(...)' as
// it is null". That is a module-evaluation failure, so the whole function fails
// to boot and the Edge Runtime answers every request, even an unknown operation,
// with WORKER_ERROR.
//
// Nothing in this repository has to change for that to happen. A deployment
// built before the bad release keeps working; the next deployment of the same
// source picks up the broken transitive version and dies. That is exactly how
// it happened in production on 2026-08-08: an unrelated change was deployed,
// the gateway stopped booting, and redeploying the previous known-good source
// failed identically, which is what proved the fault was not in this repository.
//
// The pin is deliberately on the exact broken package rather than on the SDK
// version, because every @solana/kit 5.x resolves to the same bad `ws`. Verify
// with `deno eval "await import('<url>')"` before widening it again.
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
} from "https://esm.sh/@solana/kit@5?deps=ws@8.18.0";

export {
  deriveAttestationPda,
  fetchSchema,
  serializeAttestationData,
  getCreateAttestationInstruction,
  getCloseAttestationInstruction,
} from "https://esm.sh/sas-lib@1.0.10?deps=ws@8.18.0";
