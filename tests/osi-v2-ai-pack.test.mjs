import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AI_PACK_APPROVAL_EVENT,
  AI_PACK_CONFIDENCE_COMPONENTS,
  AI_PACK_GENERATION_EVENT,
  GenerationExecutionError,
  assertSafeText,
  authorizedCasePacksDto,
  buildLayerInputs,
  callAnthropicLayer,
  canonicalAiPackApprovalMemo,
  canonicalAiPackProof,
  executeReservedGeneration,
  fixedConfidenceProfile,
  fixedEvidenceManifestHashes,
  generationCostUsdMicros,
  groupPublicPackRows,
  initialConfidenceProfile,
  normalizeOwnerFeedback,
  normalizeReview,
  parseAiPackProof,
  publicPackDto,
  safeEvidenceReference,
  validateAiPackProof,
  validateEvidenceRows,
  validateStructuredLayerOutput,
  validateVersionRef,
} from "../supabase/functions/osi-v2-ai-pack/core.ts";

const ROOT = new URL("../", import.meta.url);
const WALLET = "11111111111111111111111111111111";
const OTHER_WALLET = "SysvarRent111111111111111111111111111111111";
const CASE_REF = "OSI-ABCDEF123456";
const PACK_REF = "OSI-AP-ABCDEF123456";
const VERSION_REF = "OSI-APV-ABCDEF1234567890";
const RECEIPT_ID = "44444444-4444-4444-8444-444444444444";
const NOW = 1_800_000_000;

function evidence(overrides = {}) {
  return {
    evidence_item_id: "11111111-1111-4111-8111-111111111111",
    kind: "url",
    ref: "https://evidence.example/public/item",
    sha256: "a".repeat(64),
    is_public: true,
    moderation_state: "approved",
    access_scope: "public",
    ordinal: 0,
    ...overrides,
  };
}

const MANIFEST = [
  evidence(),
  evidence({
    evidence_item_id: "22222222-2222-4222-8222-222222222222",
    ref: "https://evidence.example/owner/item",
    sha256: "b".repeat(64),
    is_public: false,
    access_scope: "owner_safe",
  }),
  evidence({
    evidence_item_id: "33333333-3333-4333-8333-333333333333",
    kind: "wallet",
    ref: OTHER_WALLET,
    sha256: "c".repeat(64),
    is_public: false,
    access_scope: "analyst_restricted",
  }),
];

function proof(overrides = {}) {
  return {
    purpose: AI_PACK_GENERATION_EVENT,
    version_ref: VERSION_REF,
    actor_wallet: WALLET,
    actor_role: "analyst",
    decision: "generate",
    nonce: "n".repeat(32),
    payload_hash: "f".repeat(64),
    issued_at: NOW,
    expires_at: NOW + 120,
    ...overrides,
  };
}

function confidence(overrides = {}) {
  return {
    public_verifiability: 1 / 3,
    onchain_reproducibility: 0,
    evidence_coverage: 0,
    source_consistency: 0,
    analyst_attestation: 0,
    ...overrides,
  };
}

function publicRow(overrides = {}) {
  return {
    case_public_ref: CASE_REF,
    pack_public_ref: PACK_REF,
    pack_type: "victim",
    version_ref: VERSION_REF,
    version_no: 1,
    lifecycle_state: "approved",
    content_public_brief: "Source-bound public evidence summary.",
    confidence_profile: confidence(),
    public_layer_is_stale: false,
    public_layer_stale_at: null,
    public_layer_stale_reason: null,
    approval_receipt_id: RECEIPT_ID,
    approved_at: "2027-01-15T12:00:00Z",
    created_at: "2027-01-15T11:00:00Z",
    ...overrides,
  };
}

function providerResponse({
  citations = ["E1"],
  body = "The supplied evidence supports this source-bound summary.",
  status = 200,
  stopReason = "end_turn",
  inputTokens = 10,
  outputTokens = 5,
  requestId = "req_test",
} = {}) {
  return new Response(JSON.stringify({
    content: [{
      type: "text",
      text: JSON.stringify({
        sections: [{ heading: "Evidence summary", body, citations }],
      }),
    }],
    stop_reason: stopReason,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }), {
    status,
    headers: {
      "content-type": "application/json",
      "request-id": requestId,
    },
  });
}

async function reservation(overrides = {}) {
  const validated = validateEvidenceRows(MANIFEST, 40);
  return {
    generation_state: "reserved",
    pack_type: "victim",
    model: "claude-sonnet-5",
    max_input_chars: 24000,
    max_output_tokens: 1000,
    max_output_chars: 12000,
    max_evidence_items: 40,
    provider_timeout_ms: 45000,
    input_price_usd_micros_per_mtok: "3000000",
    output_price_usd_micros_per_mtok: "15000000",
    evidence_manifest: MANIFEST,
    ...await fixedEvidenceManifestHashes(validated),
    ...overrides,
  };
}

test("AI Pack refs and proof text accept only the exact V2 class", () => {
  assert.equal(validateVersionRef(VERSION_REF), VERSION_REF);
  assert.throws(() => validateVersionRef("OSI-PV-ABCDEF1234567890"), /version_ref_invalid/);
  assert.throws(() => validateVersionRef("OSI-APV-abcdef1234567890"), /version_ref_invalid/);

  const message = canonicalAiPackProof(proof());
  assert.deepEqual(parseAiPackProof(message), proof());
  assert.equal(validateAiPackProof(message, proof(), NOW + 1).ok, true);
  assert.equal(validateAiPackProof(message, proof({ decision: "approve" }), NOW + 1).ok, false);
  assert.equal(validateAiPackProof(message, proof(), NOW + 121).reason, "proof_expired");
  assert.throws(
    () => canonicalAiPackProof(proof({ actor_role: "owner" })),
    /proof_actor_or_decision_invalid/,
  );
  assert.equal(parseAiPackProof(message.replace("|t=pack_version|", "|t=case|")), null);
});

test("approval Memo is the exact maintainer-bound class-A proof", () => {
  const binding = proof({
    purpose: AI_PACK_APPROVAL_EVENT,
    actor_role: "maintainer",
    decision: "approve",
  });
  const memo = canonicalAiPackApprovalMemo(binding);
  assert.equal(memo, canonicalAiPackProof(binding));
  assert.throws(() => canonicalAiPackApprovalMemo(proof()), /approval_purpose_invalid/);
});

test("review and owner feedback normalization reject unsafe or invented authority", () => {
  const review = normalizeReview({
    version_ref: VERSION_REF,
    decision: "support",
    public_rationale: "The cited evidence is reproducible.",
    private_note: "Restricted analyst context.",
  });
  assert.equal(review.reason_code, "support");
  assert.throws(() => normalizeReview({
    ...review,
    decision: "declare_guilty",
  }), /review_decision_invalid/);
  assert.throws(() => normalizeReview({
    ...review,
    public_rationale: "The wallet is a proven criminal.",
  }), /unsupported_verdict_forbidden/);

  const feedback = normalizeOwnerFeedback({
    version_ref: VERSION_REF,
    feedback_type: "clarification",
    public_safe_summary: "Please clarify the transaction ordering.",
    feedback_restricted: null,
  });
  assert.equal(feedback.feedback_type, "clarification");
  assert.throws(() => normalizeOwnerFeedback({
    ...feedback,
    feedback_type: "approve",
  }), /feedback_type_invalid/);
});

test("evidence safety rejects secrets, personal data, illegal access, and unsafe references", () => {
  for (const unsafe of [
    "seed phrase alpha beta gamma delta",
    "Contact owner@example.com for details",
    "Use stolen credentials to retrieve the file",
    "sk-ant-secretsecretsecretsecret",
  ]) {
    assert.throws(() => assertSafeText(unsafe), /prohibited/);
  }
  assert.equal(
    safeEvidenceReference(evidence({ ref: "https://evidence.example/item?view=compact" })),
    "https://evidence.example/item",
  );
  assert.throws(
    () => safeEvidenceReference(evidence({
      ref: "https://evidence.example/item?access_token=secret",
    })),
    /secret_parameter/,
  );
  assert.throws(
    () => validateEvidenceRows([evidence({ moderation_state: "blocked" })], 40),
    /evidence_not_approved/,
  );
});

test("manifest validation enforces approval, public scope, uniqueness, and trusted cap", () => {
  assert.equal(validateEvidenceRows(MANIFEST, 40).length, 3);
  assert.throws(
    () => validateEvidenceRows([evidence({ is_public: false })], 40),
    /public_scope_not_public/,
  );
  assert.throws(
    () => validateEvidenceRows([evidence({ moderation_state: "blocked" })], 40),
    /evidence_not_approved/,
  );
  assert.throws(
    () => validateEvidenceRows([evidence(), evidence()], 40),
    /duplicate_or_invalid_evidence_item/,
  );
  assert.throws(() => validateEvidenceRows(MANIFEST, 2), /evidence_manifest_too_large/);
});

test("three cumulative provider inputs preserve strict layer isolation and hashes", async () => {
  const validated = validateEvidenceRows(MANIFEST, 40);
  const inputs = buildLayerInputs(validated, "victim", 24000);
  assert.equal(inputs.public.evidence.length, 1);
  assert.equal(inputs.owner_safe.evidence.length, 2);
  assert.equal(inputs.analyst_restricted.evidence.length, 3);
  assert.doesNotMatch(inputs.public.prompt, /owner\/item/);
  assert.doesNotMatch(inputs.public.prompt, new RegExp(OTHER_WALLET));
  assert.doesNotMatch(inputs.owner_safe.prompt, new RegExp(OTHER_WALLET));
  assert.match(inputs.analyst_restricted.prompt, new RegExp(OTHER_WALLET));

  const hashes = await fixedEvidenceManifestHashes(validated);
  assert.equal(new Set(Object.values(hashes)).size, 3);
  for (const hash of Object.values(hashes)) assert.match(hash, /^[0-9a-f]{64}$/);
});

test("public layer with no public evidence is limitations-only and cannot cite private evidence", () => {
  const rows = validateEvidenceRows(MANIFEST.slice(1), 40);
  const input = buildLayerInputs(rows, "exchange", 24000).public;
  assert.equal(input.evidence.length, 0);
  assert.deepEqual(input.allowed_citations, []);
  assert.match(input.prompt, /citation_id":"NONE"/);
  const output = validateStructuredLayerOutput({
    sections: [{
      heading: "Limitations",
      body: "No evidence is authorized for this layer.",
      citations: [],
    }],
  }, input, 12000);
  assert.match(output.content, /No evidence is authorized/);
  assert.throws(() => validateStructuredLayerOutput({
    sections: [{
      heading: "Leak",
      body: "Restricted evidence appears at https://evidence.example/owner/item.",
      citations: [],
    }],
  }, input, 12000), /cross_layer_evidence_leak|uncited_reference_forbidden/);
});

test("structured provider output requires allowed citations and rejects verdicts and invented refs", () => {
  const input = buildLayerInputs(validateEvidenceRows(MANIFEST, 40), "victim", 24000).public;
  assert.throws(() => validateStructuredLayerOutput({
    sections: [{ heading: "Summary", body: "Evidence-backed neutral summary.", citations: [] }],
  }, input, 12000), /uncited_reference_forbidden/);
  assert.throws(() => validateStructuredLayerOutput({
    sections: [{
      heading: "Verdict",
      body: "The address is definitively a proven criminal.",
      citations: ["E1"],
    }],
  }, input, 12000), /unsupported_verdict_forbidden/);
  assert.throws(() => validateStructuredLayerOutput({
    sections: [{
      heading: "Summary",
      body: "See https://invented.example/not-in-manifest for more.",
      citations: ["E1"],
    }],
  }, input, 12000), /uncited_reference_forbidden/);
});

test("provider call uses only server model/cap and returns allowlisted telemetry", async () => {
  const input = buildLayerInputs(validateEvidenceRows(MANIFEST, 40), "victim", 24000).public;
  let request;
  const fetchImpl = async (_url, init) => {
    request = init;
    return providerResponse();
  };
  const result = await callAnthropicLayer({
    fetchImpl,
    apiKey: "server-secret-provider-key-value",
    model: "claude-sonnet-5",
    maxTokens: 1000,
    maxChars: 12000,
    timeoutMs: 45000,
    input,
  });
  const sent = JSON.parse(request.body);
  assert.equal(sent.model, "claude-sonnet-5");
  assert.equal(sent.max_tokens, 1000);
  assert.equal(request.headers["x-api-key"], "server-secret-provider-key-value");
  assert.doesNotMatch(request.body, /server-secret-provider-key-value/);
  assert.equal(result.input_tokens, 10);
  assert.equal(result.output_tokens, 5);
  assert.equal(result.request_id, "req_test");
  assert.deepEqual(result.citations, ["E1"]);
});

test("reserved generation performs exactly three sequential isolated calls then one commit", async () => {
  const events = [];
  let active = 0;
  let maxActive = 0;
  const providerBodies = [];
  const fetchImpl = async (_url, init) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const body = JSON.parse(init.body);
    providerBodies.push(body.messages[0].content);
    const count = providerBodies.length;
    await Promise.resolve();
    active -= 1;
    return providerResponse({
      citations: Array.from({ length: count }, (_, index) => "E" + (index + 1)),
      requestId: "req_" + count,
    });
  };
  const rpc = async (name, args) => {
    events.push({ name, args });
    return {
      data: name === "osi_v2_commit_ai_pack_generation"
        ? [{
          pack_public_ref: PACK_REF,
          version_public_ref: VERSION_REF,
          version_no: 1,
          lifecycle_state: "review_required",
          idempotent_replay: false,
        }]
        : [],
      error: null,
    };
  };
  const result = await executeReservedGeneration({
    reservation: await reservation(),
    nonce: "n".repeat(32),
    apiKey: "server-secret-provider-key-value",
    fetchImpl,
    rpc,
    occurredAt: "2027-01-15T12:00:00Z",
  });
  assert.equal(result.provider_calls, 3);
  assert.equal(providerBodies.length, 3);
  assert.equal(maxActive, 1);
  assert.doesNotMatch(providerBodies[0], /owner\/item/);
  assert.doesNotMatch(providerBodies[1], new RegExp(OTHER_WALLET));
  assert.match(providerBodies[2], new RegExp(OTHER_WALLET));
  assert.deepEqual(events.map((event) => event.name), ["osi_v2_commit_ai_pack_generation"]);
  assert.equal(events[0].args.p_provider_input_tokens, 30);
  assert.equal(events[0].args.p_provider_output_tokens, 15);
  assert.equal(events[0].args.p_cost_usd_micros, "315");
  assert.deepEqual(
    Object.keys(events[0].args.p_confidence_profile).sort(),
    [...AI_PACK_CONFIDENCE_COMPONENTS].sort(),
  );
  assert.equal(events[0].args.p_confidence_profile.analyst_attestation, 0);
});

test("committed replay makes zero provider and database calls", async () => {
  let providerCalls = 0;
  let rpcCalls = 0;
  const result = await executeReservedGeneration({
    reservation: {
      generation_state: "committed",
      receipt_id: RECEIPT_ID,
      version_public_ref: VERSION_REF,
    },
    nonce: "n".repeat(32),
    apiKey: "server-secret-provider-key-value",
    fetchImpl: async () => {
      providerCalls += 1;
      return providerResponse();
    },
    rpc: async () => {
      rpcCalls += 1;
      return { data: [], error: null };
    },
  });
  assert.equal(result.already_committed, true);
  assert.equal(result.provider_calls, 0);
  assert.equal(providerCalls, 0);
  assert.equal(rpcCalls, 0);
});

test("concurrent reserved replay makes zero duplicate provider or database calls", async () => {
  let providerCalls = 0;
  let rpcCalls = 0;
  await assert.rejects(
    executeReservedGeneration({
      reservation: {
        generation_state: "reserved",
        idempotent_replay: true,
        version_public_ref: VERSION_REF,
      },
      nonce: "n".repeat(32),
      apiKey: "server-secret-provider-key-value",
      fetchImpl: async () => {
        providerCalls += 1;
        return providerResponse();
      },
      rpc: async () => {
        rpcCalls += 1;
        return { data: [], error: null };
      },
    }),
    (error) => error instanceof GenerationExecutionError
      && error.code === "ai_pack_generation_in_progress"
      && error.status === 409,
  );
  assert.equal(providerCalls, 0);
  assert.equal(rpcCalls, 0);
});

test("unsafe reservation fails durably before the provider", async () => {
  let providerCalls = 0;
  const events = [];
  const unsafe = await reservation({
    evidence_manifest: [
      evidence({ provider_text: "seed phrase alpha beta gamma delta" }),
    ],
  });
  await assert.rejects(
    executeReservedGeneration({
      reservation: unsafe,
      nonce: "n".repeat(32),
      apiKey: "server-secret-provider-key-value",
      fetchImpl: async () => {
        providerCalls += 1;
        return providerResponse();
      },
      rpc: async (name, args) => {
        events.push({ name, args });
        return { data: [], error: null };
      },
    }),
    (error) => error instanceof GenerationExecutionError
      && error.code === "ai_pack_generation_binding_changed",
  );
  assert.equal(providerCalls, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "osi_v2_fail_ai_pack_generation");
  assert.equal(events[0].args.p_provider_input_tokens, 0);
});

test("configured evidence cap cannot exceed the hard Phase-1 maximum", async () => {
  let providerCalls = 0;
  const events = [];
  await assert.rejects(
    executeReservedGeneration({
      reservation: await reservation({ max_evidence_items: 41 }),
      nonce: "n".repeat(32),
      apiKey: "server-secret-provider-key-value",
      fetchImpl: async () => {
        providerCalls += 1;
        return providerResponse();
      },
      rpc: async (name, args) => {
        events.push({ name, args });
        return { data: [], error: null };
      },
    }),
    /ai_pack_config_invalid|max_evidence_items_invalid/,
  );
  assert.equal(providerCalls, 0);
  // Invalid trusted configuration fails before a reservation can be charged.
  assert.equal(events.length, 0);
});

test("mid-flight provider refusal records cumulative telemetry and makes no commit", async () => {
  let calls = 0;
  const events = [];
  await assert.rejects(
    executeReservedGeneration({
      reservation: await reservation(),
      nonce: "n".repeat(32),
      apiKey: "server-secret-provider-key-value",
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? providerResponse({ requestId: "req_one", inputTokens: 10, outputTokens: 5 })
          : providerResponse({
            status: 429,
            requestId: "req_two",
            inputTokens: 7,
            outputTokens: 0,
          });
      },
      rpc: async (name, args) => {
        events.push({ name, args });
        return { data: [], error: null };
      },
    }),
    (error) => error instanceof GenerationExecutionError
      && error.code === "provider_rate_limited",
  );
  assert.equal(calls, 2);
  assert.deepEqual(events.map((event) => event.name), ["osi_v2_fail_ai_pack_generation"]);
  assert.equal(events[0].args.p_provider_input_tokens, 17);
  assert.equal(events[0].args.p_provider_output_tokens, 5);
  assert.equal(events[0].args.p_cost_usd_micros, "126");
});

test("domain commit failure durably records the provider spend", async () => {
  const events = [];
  await assert.rejects(
    executeReservedGeneration({
      reservation: await reservation(),
      nonce: "n".repeat(32),
      apiKey: "server-secret-provider-key-value",
      fetchImpl: async () => providerResponse(),
      rpc: async (name, args) => {
        events.push({ name, args });
        return name === "osi_v2_commit_ai_pack_generation"
          ? { data: null, error: { code: "40001" } }
          : { data: [{ generation_state: "failed" }], error: null };
      },
    }),
    (error) => error instanceof GenerationExecutionError
      && error.code === "ai_pack_generation_commit_failed",
  );
  assert.deepEqual(events.map((event) => event.name), [
    "osi_v2_commit_ai_pack_generation",
    "osi_v2_commit_ai_pack_generation",
    "osi_v2_fail_ai_pack_generation",
  ]);
  assert.equal(events[2].args.p_provider_input_tokens, 30);
  assert.equal(events[2].args.p_provider_output_tokens, 15);
  assert.equal(events[2].args.p_cost_usd_micros, "315");
});

test("lost first commit response is reconciled without repeating provider calls", async () => {
  let providerCalls = 0;
  let commitCalls = 0;
  const result = await executeReservedGeneration({
    reservation: await reservation(),
    nonce: "n".repeat(32),
    apiKey: "server-secret-provider-key-value",
    fetchImpl: async () => {
      providerCalls += 1;
      return providerResponse();
    },
    rpc: async (name) => {
      assert.equal(name, "osi_v2_commit_ai_pack_generation");
      commitCalls += 1;
      return commitCalls === 1
        ? { data: null, error: { code: "transport_error" } }
        : {
          data: [{
            pack_public_ref: PACK_REF,
            version_public_ref: VERSION_REF,
            lifecycle_state: "review_required",
            idempotent_replay: true,
          }],
          error: null,
        };
    },
  });
  assert.equal(providerCalls, 3);
  assert.equal(commitCalls, 2);
  assert.equal(result.idempotent_replay, true);
});

test("failure telemetry RPC errors surface reconciliation instead of claiming a terminal state", async () => {
  await assert.rejects(
    executeReservedGeneration({
      reservation: await reservation(),
      nonce: "n".repeat(32),
      apiKey: "server-secret-provider-key-value",
      fetchImpl: async () => providerResponse({ status: 429 }),
      rpc: async () => ({ data: null, error: { code: "network_error" } }),
    }),
    (error) => error instanceof GenerationExecutionError
      && error.code === "ai_pack_failure_recording_failed"
      && error.status === 503,
  );
});

test("unsafe model output is rejected and failure telemetry excludes the content", async () => {
  const events = [];
  await assert.rejects(
    executeReservedGeneration({
      reservation: await reservation(),
      nonce: "n".repeat(32),
      apiKey: "server-secret-provider-key-value",
      fetchImpl: async () => providerResponse({
        body: "The seed phrase is alpha beta gamma delta epsilon.",
      }),
      rpc: async (name, args) => {
        events.push({ name, args });
        return { data: [], error: null };
      },
    }),
    (error) => error instanceof GenerationExecutionError
      && error.code === "provider_output_unsafe",
  );
  assert.equal(events.length, 1);
  assert.doesNotMatch(JSON.stringify(events), /alpha beta gamma/);
});

test("confidence profile stays five separate bounded components", () => {
  const rows = validateEvidenceRows(MANIFEST, 40);
  const initial = initialConfidenceProfile(rows);
  assert.deepEqual(Object.keys(initial).sort(), [...AI_PACK_CONFIDENCE_COMPONENTS].sort());
  assert.equal(initial.public_verifiability, 1 / 3);
  assert.equal(initial.analyst_attestation, 0);
  assert.deepEqual(fixedConfidenceProfile(initial), initial);
  assert.throws(
    () => fixedConfidenceProfile({ ...initial, overall_score: 0.8 }),
    /confidence_profile_keys_invalid/,
  );
  assert.throws(
    () => fixedConfidenceProfile({ ...initial, source_consistency: 1.1 }),
    /confidence_component_invalid/,
  );
});

test("public projection independently requires an approval receipt and approved time", () => {
  const dto = publicPackDto(publicRow());
  assert.equal(dto.version_ref, VERSION_REF);
  assert.equal(dto.staleness.public.stale, false);
  assert.equal(
    dto.disclaimer,
    "Informational intelligence only; not legal or financial advice; no custody; no recovery guaranteed; attribution remains challengeable.",
  );
  assert.equal("content_owner_safe" in dto, false);
  assert.equal("approval_receipt_id" in dto, false);
  assert.equal(publicPackDto(publicRow({ approval_receipt_id: null })), null);
  assert.equal(publicPackDto(publicRow({ approved_at: null })), null);
  assert.equal(publicPackDto(publicRow({ lifecycle_state: "review_required" })), null);

  const grouped = groupPublicPackRows([
    publicRow(),
    publicRow({
      version_ref: "OSI-APV-ABCDEF1234567891",
      version_no: 2,
      approval_receipt_id: "55555555-5555-4555-8555-555555555555",
    }),
    publicRow({
      version_ref: "OSI-APV-ABCDEF1234567892",
      lifecycle_state: "review_required",
    }),
  ]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].versions.length, 2);
});

test("staleness is per-layer and missing checks remain unavailable, never false-current", () => {
  const commonVersion = {
    version_ref: VERSION_REF,
    version_no: 1,
    lifecycle_state: "review_required",
    created_at: "2027-01-15T12:00:00Z",
    created_by_wallet: WALLET,
    created_by_role: "analyst",
    model: "claude-sonnet-5",
    approved_at: null,
    content_public_brief: "Public source-bound summary.",
    content_owner_safe: "Owner-safe source-bound summary.",
    content_analyst_restricted: "Analyst-restricted source-bound summary.",
    confidence_profile: confidence(),
    staleness: {
      public: { stale: false, stale_at: null, reason: null },
      owner_safe: {
        stale: true,
        stale_at: "2027-01-16T12:00:00Z",
        reason: "owner_safe_manifest_drift",
      },
      // analyst_restricted intentionally absent
    },
    quorum: null,
    reviews: [],
    owner_feedback: [],
  };
  const owner = authorizedCasePacksDto([{
    pack_public_ref: PACK_REF,
    pack_type: "victim",
    current_version_ref: VERSION_REF,
    versions: [commonVersion],
  }], "owner", CASE_REF);
  const ownerVersion = owner[0].versions[0];
  assert.equal(ownerVersion.staleness.public.stale, false);
  assert.equal(ownerVersion.staleness.owner_safe.stale, true);
  assert.equal("analyst_restricted" in ownerVersion.staleness, false);
  assert.equal(ownerVersion.quorum.ready, false);
  assert.equal(ownerVersion.quorum.required_count, null);

  const analyst = authorizedCasePacksDto([{
    pack_public_ref: PACK_REF,
    pack_type: "victim",
    current_version_ref: VERSION_REF,
    versions: [commonVersion],
  }], "analyst", CASE_REF);
  assert.equal(analyst[0].versions[0].staleness.analyst_restricted.stale, null);
});

test("invalid review decisions fail the private projection instead of becoming support", () => {
  assert.throws(() => authorizedCasePacksDto([{
    pack_public_ref: PACK_REF,
    pack_type: "victim",
    current_version_ref: VERSION_REF,
    versions: [{
      version_ref: VERSION_REF,
      version_no: 1,
      lifecycle_state: "review_required",
      created_by_wallet: WALLET,
      created_by_role: "analyst",
      model: "claude-sonnet-5",
      content_public_brief: "Public source-bound summary.",
      content_owner_safe: "Owner-safe source-bound summary.",
      content_analyst_restricted: "Restricted source-bound summary.",
      confidence_profile: confidence(),
      reviews: [{
        review_public_ref: "OSI-APR-ABCDEF1234567890",
        reviewer_wallet: OTHER_WALLET,
        decision: "invented",
        weight: 1,
        public_rationale: "A sufficiently long rationale.",
      }],
    }],
  }], "analyst", CASE_REF), /review_decision_invalid/);
});

test("cost snapshots use exact ceiling arithmetic", () => {
  assert.equal(generationCostUsdMicros(1, 0, 3_000_000n, 15_000_000n), 3n);
  assert.equal(generationCostUsdMicros(1, 1, 1n, 1n), 1n);
  assert.equal(generationCostUsdMicros(30, 15, 3_000_000n, 15_000_000n), 315n);
});

test("gateway statically preserves the service-only, fail-closed boundary", async () => {
  const source = await readFile(
    new URL("supabase/functions/osi-v2-ai-pack/index.ts", ROOT),
    "utf8",
  );
  for (const op of [
    "capabilities",
    "list_public_packs",
    "list_public_case_packs",
    "get_case_packs",
    "prepare_generation",
    "commit_generation",
    "prepare_review",
    "commit_review",
    "prepare_owner_feedback",
    "commit_owner_feedback",
    "prepare_approval",
    "commit_approval",
  ]) {
    assert.match(source, new RegExp('case "' + op + '"'));
  }
  assert.match(source, /READ_SESSION_SCOPES\.AIPACK_DETAIL/);
  assert.match(source, /verifyEd25519Signature/);
  assert.match(source, /validateConfirmedMemoTransaction/);
  assert.match(source, /MAINNET_GENESIS_HASH/);
  assert.match(source, /maintainerGate/);
  assert.match(source, /gate\.reason \?\? "maintainer_denied"/);
  assert.match(source, /OSI_V2_AI_PACK_WRITES_ENABLED/);
  assert.match(source, /OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED/);
  assert.match(source, /osi_v2_reserve_ai_pack_generation/);
  assert.match(source, /executeReservedGeneration/);
  assert.match(source, /MAX_BODY_BYTES/);
  assert.match(source, /isExactReadSessionOrigin/);
  const approvalCommit = source.slice(
    source.indexOf("async function commitApproval"),
    source.indexOf("serve(async"),
  );
  assert.ok(
    approvalCommit.indexOf("if (bound.consumed_at)")
      < approvalCommit.indexOf("requireWriteFlags(req, true)"),
    "committed class-A replay must remain available after a flag disable",
  );
  assert.doesNotMatch(source, /Access-Control-Allow-Origin["']?\s*:\s*["']\*/);
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error|debug)/);
  assert.doesNotMatch(source, /body\.(?:model|max_tokens|max_output_tokens|max_input_chars)/);
  assert.doesNotMatch(source, /ANTHROPIC_API_KEY[^;\n]*body/);
  const coreSource = await readFile(
    new URL("../supabase/functions/osi-v2-ai-pack/core.ts", import.meta.url),
    "utf8",
  );
  assert.match(coreSource, /GenerationRpc[\s\S]*PromiseLike/);
});
