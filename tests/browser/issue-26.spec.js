const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const WALLET = '11111111111111111111111111111111';
const OTHER = '11111111111111111111111111111112';
const TX = '2'.repeat(88);
const CASE_REF = 'OSI-C-A1B2C3D4E5F60718';
const AI_CASE_REF = 'OSI-A1B2C3D4E5F6';
const AI_PACK_REF = 'OSI-AP-A1B2C3D4E5F6';
const AI_VERSION_REF = 'OSI-APV-A1B2C3D4E5F60718';
const AI_REVIEW_REF = 'OSI-APR-A1B2C3D4E5F60718';
const PRIVATE_REF = 'OSI-C-PRIVATE000000001';
const REPORT_REF = 'OSI-RPT-A1B2C3D4E5F6';
const VERSION_REF = 'OSI-RV-A1B2C3D4E5F60718';
const WIRE_REPORT_REF = 'OSI-WR-A1B2C3D4E5F6';
const WIRE_VERSION_REF = 'OSI-WV-A1B2C3D4E5F60718';
const PRIVATE_SENTINEL = 'PRIVATE_FIXTURE_SENTINEL';
const WIRE_PRIVATE_SENTINEL = 'WIRE_PRIVATE_FIXTURE_SENTINEL';
const AI_RESTRICTED_SENTINEL = 'AI_RESTRICTED_FIXTURE_SENTINEL';
const AI_LONG_TOKEN = '3'.repeat(240);
const now = Date.now();
const iso = (offsetDays) => new Date(now + offsetDays * 86_400_000).toISOString();

const proofRows = [
  { event_type: 'CASE_REVIEWED', label: 'Wallet-signed and server-verified', actor_wallet: OTHER, actor_role: 'analyst', decision: 'approve', occurred_at: iso(-8) },
  { event_type: 'CASE_OPENED', label: 'Memo-anchored on Solana', actor_wallet: OTHER, actor_role: 'analyst', decision: 'open', occurred_at: iso(-7), tx_sig: TX, solscan_url: `https://solscan.io/tx/${TX}` },
  {
    event_type: 'REWARD_PAYMENT_CONFIRMED', label: 'SOL transfer verified on Solana',
    actor_wallet: WALLET, actor_role: 'case_owner', decision: 'paid', occurred_at: iso(-1),
    tx_sig: TX, solscan_url: `https://solscan.io/tx/${TX}`,
    payment_proof: {
      cluster: 'mainnet-beta', finality: 'finalized', payer_wallet: WALLET,
      recipient_manifest: [{ wallet: OTHER, amount_lamports: '1000000000', recipient_type: 'report_author', target_ref: VERSION_REF }],
      total_lamports: '1000000000', target_public_ref: CASE_REF,
      memo_verified: true, transfers_verified: true, slot: '123456', block_time: iso(-1),
    },
  },
  { event_type: 'CHALLENGE_WINDOW_OPENED', label: 'System event', actor_wallet: '', actor_role: 'system', decision: 'recorded', occurred_at: iso(-2) },
];

const reviews = [
  { reviewer_wallet: OTHER, reviewer_role: 'analyst', decision: 'approve_open', reason_code: 'public_scope_clear', weight: .5, is_active: true, proof_label: 'Wallet-signed and server-verified', created_at: iso(-8) },
];

const richCase = {
  public_ref: CASE_REF,
  title: 'Reviewed transfer-path investigation',
  summary: 'Public-safe evidence is attached to an independently reviewed and challengeable process.',
  category: 'exploit', risk_tier: 'high', visibility: 'public', stage: 'in_challenge_window',
  created_at: iso(-9), submitted_by_wallet: WALLET,
  evidence: [{ kind: 'onchain_tx', ref: TX, sha256: 'a'.repeat(64) }],
  reviews,
  reports: [{
    public_ref: REPORT_REF,
    current_version: { version_ref: VERSION_REF },
    versions: [{ version_ref: VERSION_REF, lifecycle_state: 'published' }],
  }],
  governance: {
    resolution: {
      state: 'in_challenge_window', winning_report_version_ref: VERSION_REF,
      challenge_window_opens_at: iso(-1), challenge_window_closes_at: iso(6),
      selection_quorum: { leader_version_ref: VERSION_REF, leader_count: 3, leader_weight: 4.75, required_count: 3, required_weight: 4.5, tie_unresolved: false },
      seal_quorum: { approve_count: 0, approve_weight: 0, required_count: 3, required_weight: 4.5, ready: false },
      reviews: [{ phase: 'selection', target_version_ref: VERSION_REF, reviewer_wallet: OTHER, decision: 'select', weight: 1.5, public_rationale: 'The exact version has the strongest reviewed evidence manifest.', proof_label: 'Wallet-signed and server-verified', created_at: iso(-2) }],
    },
    challenges: [{
      public_ref: 'OSI-CH-A1B2C3D4E5F6', state: 'under_review', blocking: true,
      challenger_wallet: OTHER, public_safe_summary: 'A cited transfer needs additional independent context.',
      admissibility_deadline_at: iso(1), review_deadline_at: iso(4),
      reviews: [{ phase: 'adjudication', reviewer_wallet: WALLET, decision: 'accept', weight: .5, public_rationale: 'Additional evidence review is warranted.', proof_label: 'Wallet-signed and server-verified', created_at: iso(-.5) }],
      outcome_quorum: { accept_count: 1, accept_weight: .5, reject_count: 0, reject_weight: 0, required_count: 3, required_weight: 4.5 },
    }],
  },
  money: {
    reward: {
      state: 'pledged', status: 'partially_fulfilled', amount_lamports: '3000000000',
      confirmed_lamports: '1000000000', outstanding_lamports: '2000000000',
      winning_report_author_wallet: OTHER, winning_report_version_ref: VERSION_REF,
      payments: [{ amount_lamports: '1000000000', state: 'confirmed', confirmed_at: iso(-1), solscan_url: `https://solscan.io/tx/${TX}` }],
    },
    support_options: [{ target_type: 'report_version', target_ref: VERSION_REF, wallet: OTHER, label: 'Published Report author' }],
    confirmed_support: [{ support_type: 'voluntary', amount_lamports: '100000000', state: 'confirmed', confirmed_at: iso(-1), solscan_url: `https://solscan.io/tx/${TX}` }],
  },
  proof_log: proofRows,
};

const aiCase = {
  ...richCase,
  public_ref: AI_CASE_REF,
  title: 'AI Pack evidence-layer fixture',
  summary: 'A fixture Case with approved evidence for the native AI Pack drawer.',
  stage: 'open_public',
  submitted_by_wallet: OTHER,
  governance: {},
  money: {},
  proof_log: [],
};

const publicCases = [
  richCase,
  aiCase,
  { ...richCase, public_ref: 'OSI-C-PLEDGED00000001', title: 'Pledged reward state', stage: 'open_public', money: { reward: { status: 'pledged' } }, governance: {}, proof_log: [] },
  { ...richCase, public_ref: 'OSI-C-FULFILLED000001', title: 'Fulfilled reward state', stage: 'sealed', money: { reward: { status: 'fulfilled' } }, governance: {}, proof_log: proofRows },
];

const privateCase = {
  ...richCase, public_ref: PRIVATE_REF, title: 'Private owner workspace', visibility: 'private', stage: 'submitted',
  details_restricted: PRIVATE_SENTINEL, governance: {}, reports: [], proof_log: [], money: {},
};

function version(no, state, decisions) {
  return {
    id: `33333333-3333-3333-3333-33333333333${no}`,
    version_ref: `${VERSION_REF.slice(0, -1)}${no}`, version_no: no, lifecycle_state: state,
    body_private: `Restricted version ${no} narrative for authorized fixture rendering.`,
    content_public_safe: `Public-safe version ${no} summary.`, evidence_snapshot_hash: String(no).repeat(64),
    submitted_at: iso(-6 + no), evidence: [{ ordinal: 1, kind: 'onchain_tx', ref: TX }],
    proof: { proof_type: 'solana_memo', server_verified: true, tx_sig: TX, occurred_at: iso(-6 + no) },
    quorum: { approve_count: 3, approve_weight: 4.75, required_count: 3, required_weight: 4.5, approve_ready: true },
    reviews: decisions.map((decision, index) => ({
      reviewer_wallet: index ? WALLET : OTHER, reviewer_handle: `reviewer${index + 1}`,
      decision, reason_code: 'evidence_reviewed', public_rationale: `${decision} rationale remains attributable in immutable history.`,
      private_note: `Restricted ${decision} note.`, weight: index ? .5 : 1.5, tier_snapshot: index ? 'probationary' : 'verified',
      is_active: index === decisions.length - 1, created_at: iso(-3 + index / 10), proof: { proof_type: 'wallet_signed_server_verified' },
    })),
  };
}

const reportFixture = {
  case_public_ref: CASE_REF, report_public_ref: REPORT_REF, author_wallet: OTHER,
  current_version_ref: `${VERSION_REF.slice(0, -1)}3`, current_version_no: 3,
  current_published_version_ref: `${VERSION_REF.slice(0, -1)}1`, revision_eligible: true,
  review_mutations_enabled: true, access: 'analyst',
  versions: [
    version(1, 'published', ['approve']),
    version(2, 'in_review', ['reject', 'request_revision']),
    version(3, 'submitted', ['abstain']),
  ],
};

const aiPackFixture = {
  viewer_role: 'analyst',
  packs: [{
    public_ref: AI_PACK_REF,
    case_public_ref: AI_CASE_REF,
    pack_type: 'exchange',
    current_version_ref: AI_VERSION_REF,
    versions: [{
      version_ref: AI_VERSION_REF,
      version_no: 1,
      lifecycle_state: 'review_required',
      created_at: iso(-1),
      created_by_wallet: OTHER,
      created_by_role: 'analyst',
      content_public_brief: `Public evidence-layer fixture ${AI_LONG_TOKEN}`,
      content_owner_safe: `Owner-safe fixture ${AI_LONG_TOKEN}`,
      content_analyst_restricted: `${AI_RESTRICTED_SENTINEL} lawful context ${AI_LONG_TOKEN}`,
      confidence_profile: {
        public_verifiability: { label: 'High', basis: 'All public citations are independently retrievable.' },
        onchain_reproducibility: { value: 2, denominator: 2, basis: 'Both cited transactions resolve on mainnet.' },
        evidence_coverage: { status: 'partial', basis: 'One open Case question remains.' },
        source_consistency: { label: 'Corroborated', basis: 'Two independent sources agree.' },
        analyst_attestation: { value: 1.5, basis: 'Count gate remains unmet.' },
      },
      staleness: {
        public: { stale: false },
        owner_safe: { stale: true, stale_at: iso(-.25), reason: 'Owner-safe evidence changed after generation.' },
        analyst_restricted: { stale: false },
      },
      quorum: { approve_count: 1, approve_weight: 1.5, required_count: 2, required_weight: 2.5, ready: false },
      reviews: [{
        review_public_ref: AI_REVIEW_REF,
        reviewer_wallet: WALLET,
        decision: 'support',
        weight: 1.5,
        public_rationale: 'The artifact remains evidence-bound but needs one more independent analyst.',
        proof_label: 'Wallet-signed and server-verified',
        created_at: iso(-.5),
      }],
      can_review_exact_version: true,
      review_prerequisite: null,
      can_finalize: false,
      finalize_prerequisite: 'Needs one more independent analyst and 1.00 counted weight.',
    }],
  }],
};

const wireFixture = {
  wire_report_public_ref: WIRE_REPORT_REF,
  status: 'active',
  current_version_ref: `${WIRE_VERSION_REF.slice(0, -1)}2`,
  current_version_no: 2,
  current_published_version_ref: null,
  revision_eligible: true,
  versions: [1, 2].map((no) => ({
    version_ref: `${WIRE_VERSION_REF.slice(0, -1)}${no}`,
    version_no: no,
    lifecycle_state: 'submitted',
    title_public_safe: `Wire fixture version ${no}`,
    content_public_safe: `Public-safe Wire fixture summary ${no} remains private before independent publication.`,
    body_private: `${WIRE_PRIVATE_SENTINEL} restricted analysis version ${no} records transaction order, alternatives, and source limits.`,
    uncertainties_private: `Attribution remains uncertain for Wire fixture version ${no}.`,
    evidence_snapshot_hash: String(no).repeat(64),
    revision_reason_code: no === 1 ? null : 'clarification',
    supersedes_version_ref: no === 1 ? null : `${WIRE_VERSION_REF.slice(0, -1)}1`,
    submitted_at: iso(-3 + no),
    evidence: [{ ordinal: 1, kind: 'onchain_tx', ref: TX, sha256: 'a'.repeat(64) }],
    proof: { proof_type: 'solana_memo', server_verified: true, tx_sig: TX, occurred_at: iso(-3 + no) },
  })),
};

const publicWireListItem = {
  wire_report_public_ref: WIRE_REPORT_REF,
  version_public_ref: WIRE_VERSION_REF,
  version_no: 1,
  title: 'Published Wire governance fixture',
  summary: 'A reviewed standalone finding remains attributable, challengeable, and exact-version bound.',
  author: { wallet: OTHER, handle: 'wire-author', display_name: 'Wire author fixture' },
  evidence_count: 1, review_count: 2, challenge_count: 1,
  support_lamports: '100000000', promoted: true, is_current_published: true,
  challenge_state: 'challenge_upheld_under_re_review',
  publication_channel: 'maintainer_bootstrap', published_at: iso(-2),
  publication_proof: { event_type: 'WIRE_REPORT_PUBLISHED', label: 'Memo-anchored on Solana', proof_type: 'solana_memo', tx_sig: TX, occurred_at: iso(-2), decision_channel: 'maintainer_bootstrap' },
  proof_log: [
    { event_type: 'WIRE_REPORT_REVIEW_CAST', label: 'Wallet-signed and server-verified', proof_type: 'wallet_signed_server_verified', actor_wallet: WALLET, actor_role: 'analyst', decision: 'approve', weight: 1.5, occurred_at: iso(-3) },
    { event_type: 'WIRE_REPORT_PUBLISHED', label: 'Memo-anchored on Solana', proof_type: 'solana_memo', actor_wallet: WALLET, actor_role: 'maintainer', decision: 'publish', decision_channel: 'maintainer_bootstrap', tx_sig: TX, occurred_at: iso(-2) },
    { event_type: 'SUPPORT_PAYMENT_CONFIRMED', label: 'Memo-anchored on Solana', proof_type: 'solana_memo', actor_wallet: WALLET, actor_role: 'supporter', decision: 'sent', tx_sig: TX, occurred_at: iso(-1) },
  ],
};

const publicWireDetail = {
  ...publicWireListItem,
  is_current_published: true,
  analysis: 'The detailed published analysis follows the exact transaction sequence and records alternative explanations.',
  uncertainties: 'Wallet control and attribution remain uncertain after independent review.',
  evidence: [{ ordinal: 1, kind: 'onchain_tx', ref: TX, sha256: 'a'.repeat(64) }],
  reviews: [
    { review_public_ref: 'OSI-WRV-A1B2C3D4E5F6', reviewer: { wallet: WALLET, handle: 'reviewer-one', display_name: 'Reviewer one' }, actor_role: 'analyst', decision: 'approve', weight: 1.5, tier_snapshot: 'verified', public_rationale: 'The exact evidence supports publication with the stated uncertainty.', proof_type: 'wallet_signed_server_verified', created_at: iso(-3) },
    { review_public_ref: 'OSI-WRV-B1B2C3D4E5F6', reviewer: { wallet: '11111111111111111111111111111113', handle: 'reviewer-two', display_name: 'Reviewer two' }, actor_role: 'analyst', decision: 'approve', weight: .5, tier_snapshot: 'probationary', public_rationale: 'The limits are explicit and evidence remains independently inspectable.', proof_type: 'wallet_signed_server_verified', created_at: iso(-2.5) },
  ],
  challenges: [{
    challenge_public_ref: 'OSI-CHL-A1B2C3D4E5F60718', challenger_wallet: '11111111111111111111111111111114', state: 'accepted',
    public_safe_summary: 'The exact published version omitted material transaction context.', created_at: iso(-1.5), terminal_at: iso(-1),
    reviews: [{ review_public_ref: 'OSI-CRV-A1B2C3D4E5F6', reviewer: { wallet: WALLET, handle: 'challenge-reviewer', display_name: 'Challenge reviewer' }, actor_role: 'analyst', decision: 'accept', weight: 1.5, public_rationale: 'The linked evidence confirms a material omission.', proof_type: 'wallet_signed_server_verified', created_at: iso(-1) }],
  }],
  support: [{ amount_lamports: '100000000', from_wallet: WALLET, proof_type: 'solana_memo', tx_sig: TX, confirmed_at: iso(-1) }],
  publication: publicWireListItem.publication_proof,
};

const wireQueueItem = {
  wire_report_public_ref: 'OSI-WR-B1B2C3D4E5F6',
  version_public_ref: 'OSI-WV-B1B2C3D4E5F60718',
  title: 'Wire queue fixture', summary: 'A public-safe queue summary for exact review.',
  analysis: 'Restricted queue analysis remains available only through the signed analyst projection and has sufficient detail.',
  uncertainties: 'Attribution remains uncertain pending independent review.',
  author_wallet: OTHER, lifecycle_state: 'in_review',
  evidence: [{ ordinal: 1, kind: 'onchain_tx', ref: TX, sha256: 'b'.repeat(64) }],
  quorum: { approve_count: 1, approve_weight: .5, required_count: 2, required_weight: 2 },
};

const analystFixture = {
  wallet: OTHER, handle: 'public-analyst', display_name: 'Public analyst fixture',
  bio: 'A public-safe profile returned by the analyst projection.', status: 'verified', tier_code: 'verified', weight: 1.5,
  expertise: ['onchain_tracing'], links: [], contributions: [{ kind: 'report', subject_type: 'report_version', subject_id: VERSION_REF, created_at: iso(-2) }], proof_history: [],
};

const analystWorkspace = {
  ok: true,
  profile: { ...analystFixture, weight_cached: 1.5, expertise_public: analystFixture.expertise, links_public: [] },
  applications: [{
    id: '44444444-4444-4444-4444-444444444444', status: 'revision_requested',
    versions: [{ version_no: 2, version_ref: 'OSI-AV-A1B2C3D4E5F60718', details_restricted: { motivation: PRIVATE_SENTINEL, experience: 'Public evidence review experience.', proof_urls: [] }, expertise_public: ['onchain_tracing'] }],
    reviews: [{ decision: 'request_revision', reason_code: 'more_public_work_samples', weight: 0, created_at: iso(-1) }],
  }],
};

function token(origin) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    v: 1, iss: 'osi-v2-case-read', aud: origin, sub: WALLET,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    jti: 'fixture-session-jti-00000000000000000001',
    scp: ['case:mine', 'case:detail', 'case:review', 'case:maintainer', 'report:mine', 'report:review', 'wire:mine', 'wire:queue', 'analyst:workspace', 'analyst:maintainer', 'aipack:detail'],
    auth_sub: null,
  })}.fixture-signature`;
}

async function installFixtureNetwork(page) {
  await page.addInitScript(({ wallet }) => {
    const count = (name) => Number(sessionStorage.getItem(`fixture_provider_${name}`) || 0);
    const bump = (name) => sessionStorage.setItem(`fixture_provider_${name}`, String(count(name) + 1));
    const listeners = {};
    const provider = {
      isPhantom: true, isConnected: true,
      publicKey: { toString: () => wallet },
      connect: async (options) => { bump(options && options.onlyIfTrusted ? 'trustedConnect' : 'connect'); return { publicKey: provider.publicKey }; },
      disconnect: async () => { (listeners.disconnect || []).forEach((fn) => fn()); },
      signMessage: async () => { bump('signMessage'); return { signature: new Uint8Array(64).fill(7) }; },
      signAndSendTransaction: async () => { bump('transaction'); return { signature: '2'.repeat(88) }; },
      on: (name, fn) => { (listeners[name] || (listeners[name] = [])).push(fn); },
      off: (name, fn) => { listeners[name] = (listeners[name] || []).filter((item) => item !== fn); },
      __emit: (name, payload) => { (listeners[name] || []).forEach((fn) => fn(payload)); },
    };
    window.phantom = { solana: provider };
    window.solana = provider;
    window.__fixtureProvider = provider;
    window.__fixtureProviderCounts = () => ({
      connect: count('connect'), trustedConnect: count('trustedConnect'),
      signMessage: count('signMessage'), transaction: count('transaction'),
    });
  }, { wallet: WALLET });

  await page.route(/https:\/\/(?:bundle\.run|unpkg\.com|cdn\.jsdelivr\.net)\/.*/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.route('https://api.coingecko.com/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ solana: { usd: 0, usd_24h_change: 0 }, bitcoin: { usd: 0, usd_24h_change: 0 }, ethereum: { usd: 0, usd_24h_change: 0 } }),
  }));
  await page.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/functions/v1/**', async (route) => {
    const request = route.request();
    let body = {};
    try { body = request.postDataJSON() || {}; } catch (_) {}
    const endpoint = new URL(request.url()).pathname.split('/').pop();
    let response = { ok: true };
    if (endpoint === 'osi-v2-case-read') {
      if (body.op === 'list_public_cases') response.cases = publicCases;
      else if (body.op === 'get_public_case') response.case = publicCases.find((item) => item.public_ref === body.public_ref) || richCase;
      else if (body.op === 'list_my_cases') response.cases = [privateCase];
      else if (body.op === 'list_reviewable_cases') response.cases = [privateCase];
      else if (body.op === 'issue_read_session_challenge') response.challenge = 'OSI private read fixture challenge';
      else if (body.op === 'create_read_session') response.read_session = token(new URL(page.url()).origin);
      else if (body.op === 'maintainer_case_overview') response = { ok: true, metrics: {}, flags: {} };
    } else if (endpoint === 'osi-v2-report-read') {
      if (body.op === 'list_public_reports') response.reports = [{
        report_public_ref: REPORT_REF, version_public_ref: VERSION_REF, version_no: 1, state: 'published',
        body: 'Published public Report content.', content_public_safe: 'Public-safe Report summary.', evidence: [], review_timeline: [],
        quorum: { approve_count: 3, approve_weight: 4.75, required_count: 3, required_weight: 4.5 },
        publication_proof: { tx_sig: TX }, process_notice: 'Publication does not resolve the Case.',
      }];
      else response.reports = [reportFixture];
    } else if (endpoint === 'osi-v2-ai-pack') {
      if (body.op === 'capabilities') {
        const owner = body.case_ref === CASE_REF || body.case_ref === PRIVATE_REF;
        response = {
          ok: true,
          ai_pack_writes_enabled: true,
          ai_pack_review_writes_enabled: false,
          wallet_connected: true,
          viewer_role: owner ? 'owner' : 'analyst',
          analyst_eligible: !owner,
          maintainer_access: false,
          can_generate: !owner,
          generation_prerequisite: owner
            ? 'Case-owner generation is deferred until a separate budget and quota release.'
            : null,
        };
      } else if (body.op === 'get_case_packs') {
        response = { ok: true, ...aiPackFixture };
      } else if (body.op === 'list_public_case_packs') {
        response = { ok: true, viewer_role: 'public', packs: [] };
      } else if (body.op === 'prepare_generation') {
        await new Promise((resolve) => setTimeout(resolve, 180));
        response = {
          ok: false,
          error: 'ai_pack_case_cooldown_active',
          details: { retry_after_seconds: 90 },
        };
      }
    } else if (endpoint === 'osi-v2-wire') {
      if (body.op === 'capabilities') response = {
        ok: true, wire_writes_enabled: true, publication_enabled: true,
        payment_writes_enabled: true, challenge_enabled: true, support_enabled: true,
        analyst_eligible: true, maintainer_access: false, promotion_enabled: true,
        wallet_connected: true, prerequisite: null,
      };
      else if (body.op === 'list_my_wire_reports') response = {
        ok: true, reports: [wireFixture], private_projection: true,
      };
      else if (body.op === 'list_public_wire_reports') response = {
        ok: true, reports: [publicWireListItem], public_projection: true,
      };
      else if (body.op === 'get_public_wire_report') response = {
        ok: true, report: publicWireDetail, public_projection: true,
      };
      else if (body.op === 'list_wire_review_queue') response = {
        ok: true, reports: [wireQueueItem], private_projection: true,
      };
    } else if (endpoint === 'osi-v2-analyst') {
      if (body.op === 'list_public_profiles') response.analysts = [analystFixture];
      else if (body.op === 'my_workspace') response = analystWorkspace;
      else if (body.op === 'maintainer_queue') response.applications = [];
    } else if (body.op === 'actor_capabilities' || body.op === 'capabilities') {
      response = {
        ok: true, case_writes_enabled: false, report_writes_enabled: false,
        resolution_lifecycle_writes_enabled: false, payment_writes_enabled: false,
        analyst_eligible: true, maintainer_access: false,
        prerequisite: 'Fixture keeps production writes disabled.',
      };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
}

async function ready(page) {
  page.__issue26Errors = [];
  page.on('pageerror', (error) => page.__issue26Errors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const fixtureSriBlock = text.includes("Failed to find a valid digest in the 'integrity' attribute")
      && /https:\/\/(?:bundle\.run|unpkg\.com|cdn\.jsdelivr\.net)\//.test(text)
      && text.includes("OLBgp1GsljhM2TJ+sbHjaiH9txEUvgdDTAzHv2P24donTt6/529l+9Ua0vFImLlb");
    if (!fixtureSriBlock) page.__issue26Errors.push(`console: ${text}`);
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure() && request.failure().errorText || 'unknown';
    if (!failure.includes('ERR_ABORTED')) page.__issue26Errors.push(`network: ${request.url()} ${failure}`);
  });
  page.on('response', (response) => { if (response.status() >= 400) page.__issue26Errors.push(`http: ${response.status()} ${response.url()}`); });
  await installFixtureNetwork(page);
  await page.goto('/');
  await page.waitForFunction(() => typeof window.osiNavigate === 'function' && typeof window.osiV2OpenMyCases === 'function');
  await expect(page.locator('#osi-home-live-state')).toContainText('Reviewed transfer-path investigation');
}

function expectCleanRuntime(page) {
  expect(page.__issue26Errors).toEqual([]);
}

test('Platform menu exercises hover intent, keyboard, click and touch behavior', async ({ page }) => {
  await ready(page);
  const trigger = page.locator('#platform-menu-trigger');
  const menu = page.locator('#platform-menu');
  await expect(menu).toBeHidden();
  const hoverTiming = await page.locator('.osi-platform-wrap').evaluate(async (wrap) => {
    const menuNode = document.getElementById('platform-menu');
    wrap.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
    const immediate = menuNode.hidden;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const at60 = menuNode.hidden;
    await new Promise((resolve) => setTimeout(resolve, 70));
    return { immediate, at60, at130: menuNode.hidden };
  });
  expect(hoverTiming).toEqual({ immediate: true, at60: true, at130: false });
  await page.locator('.osi-platform-wrap').dispatchEvent('pointerenter', { pointerType: 'mouse' });
  await expect(menu).toBeVisible();
  const leaveTiming = await page.locator('.osi-platform-wrap').evaluate(async (wrap) => {
    const menuNode = document.getElementById('platform-menu');
    wrap.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    const at120 = menuNode.hidden;
    await new Promise((resolve) => setTimeout(resolve, 130));
    return { at120, at250: menuNode.hidden };
  });
  expect(leaveTiming).toEqual({ at120: false, at250: true });

  await page.locator('.osi-brand').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#global-nav > [data-global-view="registry"]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(trigger).toBeFocused();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(menu).toBeVisible();
  await trigger.click();
  await expect(menu).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#mobile-nav-toggle').click();
  await expect(page.locator('#global-nav')).toBeVisible();
  await trigger.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#global-nav')).toBeHidden();
  expectCleanRuntime(page);
});

test('Home keeps a compact three-section product route with truthful live actions', async ({ page }) => {
  await ready(page);
  await expect(page.locator('#global-nav > [data-global-view="registry"]')).toHaveText('Home');
  await expect(page.locator('#global-nav > .osi-nav-link', { hasText: 'How It Works' })).toHaveCount(0);
  await expect(page.locator('link[data-osi-route-style][media="print"]')).toHaveCount(9);
  await expect(page.locator('link[rel="stylesheet"]:not([media])')).toHaveCount(2);
  await expect(page.locator('main > section.osi-home')).toHaveCount(3);
  const wordCount = await page.locator('main > section.osi-home').evaluateAll((sections) =>
    sections.reduce((count, section) => count + (section.textContent || '').trim().split(/\s+/).filter(Boolean).length, 0));
  expect(wordCount).toBeLessThanOrEqual(390);
  await expect(page.locator('[data-action-contract]')).toHaveCount(9);
  await expect(page.locator('main > section.osi-home [data-action-contract]')).toHaveCount(0);
  await expect(page.locator('.osi-route-gallery > .osi-route-card')).toHaveCount(4);
  await expect(page.locator('.osi-route-report .art-manifest')).toBeVisible();
  await expect(page.locator('.osi-route-report .art-version-current')).toBeVisible();
  await expect(page.locator('.osi-route-report .art-hash-ring')).toBeVisible();
  await expect(page.locator('#platform-menu [data-action-contract]')).toHaveCount(5);
  await expect(page.locator('#wbMenu [data-action-contract]')).toHaveCount(4);
  await expect(page.locator('#maintainerAccessMenu')).toBeHidden();
  for (const action of ['case', 'report', 'wire', 'analyst', 'review', 'governance', 'money', 'proof', 'operations']) {
    await expect(page.locator(`[data-action-contract="${action}"]`)).toHaveCount(1);
  }
  await page.evaluate(() => window.osiNavigate('field'));
  await page.waitForFunction(() => [...document.querySelectorAll('link[data-osi-route-style]')].every((link) => link.media === 'all' && link.sheet));
  await expect(page.locator('link[data-osi-route-style][media="all"]')).toHaveCount(9);
  await expect(page.locator('#platform-menu-trigger')).toHaveAttribute('aria-current', 'page');
  await page.evaluate(() => window.osiNavigate('registry'));
  await expect(page.locator('#platform-menu-trigger')).not.toHaveAttribute('aria-current', 'page');
  await page.locator('#global-nav > [data-global-view="methodology"]').click();
  await expect(page.locator('#about-hero')).toBeVisible();
  await expect(page.locator('#osi-about-emblem')).toBeVisible();
  await expect(page.locator('.osi-about-wordmark figcaption')).toContainText('Never used as a proof or verification seal');
  await page.locator('#global-nav > [data-global-view="registry"]').click();
  await expect(page.locator('#osi-home-title')).toBeVisible();
  expectCleanRuntime(page);
});

test('direct workspace routes activate their styles before rendering', async ({ page }) => {
  await installFixtureNetwork(page);
  await page.goto('/#field-office');
  await page.waitForFunction(() => document.body.dataset.view === 'field' && [...document.querySelectorAll('link[data-osi-route-style]')].every((link) => link.media === 'all' && link.sheet));
  await expect(page.getByRole('heading', { name: 'The Field Office', level: 1 })).toBeVisible();
  await expect(page.locator('link[data-osi-route-style][media="all"]')).toHaveCount(9);
});

test('canonical workspace navigation and support dialog preserve keyboard access', async ({ page }) => {
  await ready(page);
  await expect(page.locator('link[data-osi-route-style][media="print"]')).toHaveCount(9);
  await page.evaluate(() => window.showView('wire'));
  await expect(page.locator('link[data-osi-route-style][media="all"]')).toHaveCount(9);
  await expect(page.locator('body')).toHaveAttribute('data-view', 'wire');

  await page.evaluate(() => window.showView('registry'));
  const walletButton = page.locator('#walletBtn');
  await walletButton.focus();
  await walletButton.press('ArrowDown');
  await expect(walletButton).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitem', { name: 'My Cases' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(walletButton).toBeFocused();

  const opener = page.locator('.osi-hero-actions .osi-button-primary');
  await expect(opener).toBeVisible();
  await opener.focus();
  await page.evaluate((wallet) => window.openTip(wallet, 'OSI project support', 0.1, 'Voluntary support'), OTHER);
  const dialog = page.getByRole('dialog', { name: 'Voluntary support' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('.tip-card')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.tip-send')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('.tip-x')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expectCleanRuntime(page);
});

test('signal enhancement fails open when its runtime is unavailable', async ({ page }) => {
  await installFixtureNetwork(page);
  await page.route('**/assets/js/95-signal-interactions.js', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.goto('/');
  await page.waitForFunction(() => typeof window.osiNavigate === 'function');
  const opacity = await page.locator('main > [data-signal-reveal]').evaluateAll((nodes) =>
    nodes.map((node) => getComputedStyle(node).opacity));
  expect(opacity).toEqual(['1', '1', '1']);
});

test('real product DOM renders lifecycle fixtures and keeps one shared private signature', async ({ page }) => {
  await ready(page);
  await expect(page.locator('body')).not.toContainText(PRIVATE_SENTINEL);
  await expect(page.locator('#home-analyst-list')).toContainText('Public analyst fixture');

  await page.evaluate(() => window.osiNavigate('field'));
  await page.getByLabel('Filter by status').selectOption('all');
  await expect(page.locator(`[data-case-ref="${CASE_REF}"]`)).toBeVisible();
  await expect(page.locator('#field-cases')).toContainText('Pledged reward state');
  await expect(page.locator('#field-cases')).toContainText('Fulfilled reward state');
  await page.locator(`[data-case-ref="${CASE_REF}"]`).click();
  await expect(page.locator('#osi-case-drawer')).toBeVisible();

  await page.locator('[data-tab="reports"]').click();
  await expect(page.locator('#osi-public-reports')).toContainText('Published public Report content');
  await page.locator('[data-tab="resolution"]').click();
  await expect(page.locator('#osi-case-content')).toContainText(VERSION_REF);
  await page.locator('[data-tab="challenges"]').click();
  await expect(page.locator('#osi-case-content')).toContainText('additional independent context');
  await page.locator('[data-tab="reward"]').click();
  await expect(page.locator('#osi-case-content')).toContainText('Partially Fulfilled');
  await expect(page.locator('#osi-case-content')).toContainText('Voluntary support');
  await page.locator('[data-tab="proof"]').click();
  for (const label of ['Wallet-signed and server-verified', 'Memo-anchored on Solana', 'SOL transfer verified on Solana', 'System event']) {
    await expect(page.locator('#osi-case-content')).toContainText(label);
  }
  const solscan = page.locator(`#osi-case-content a[href="https://solscan.io/tx/${TX}"]`).first();
  await expect(solscan).toBeVisible();
  await expect(solscan).toHaveAttribute('target', '_blank');
  await expect(solscan).toHaveAttribute('rel', /noopener/);
  await page.locator('#osi-case-drawer .osi-case-close').click();

  await page.evaluate(() => window.osiNavigate('records'));
  await expect(page.locator('#case-records')).toContainText(CASE_REF);
  await expect(page.locator('#case-records')).toContainText('Reviewed');
  await expect(page.locator('#case-records')).toContainText('SOL transfer verified on Solana');
  const publicRecordCard = page.locator(`[data-cid="${CASE_REF}"]`);
  await expect(publicRecordCard).toHaveJSProperty('tagName', 'ARTICLE');
  await expect(publicRecordCard).not.toHaveAttribute('role', 'button');
  const publicRecordOpener = publicRecordCard.getByRole('button', { name: 'View Record' });
  await publicRecordOpener.focus();
  await publicRecordOpener.click();
  const publicRecordDrawer = page.locator('#cr-drawer');
  await expect(publicRecordDrawer).toBeVisible();
  await expect(publicRecordDrawer).toHaveAttribute('aria-hidden', 'false');
  await expect(publicRecordDrawer.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  await expect(publicRecordDrawer.locator('.cr-drawer-x')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(publicRecordDrawer).toBeHidden();
  await expect(publicRecordDrawer).toHaveAttribute('aria-hidden', 'true');
  await expect(publicRecordOpener).toBeFocused();
  await publicRecordOpener.click();
  await expect(publicRecordDrawer).toBeVisible();
  await page.evaluate(() => window.osiNavigate('field'));
  await expect(publicRecordDrawer).toBeHidden();

  await page.evaluate(() => window.osiNavigate('prooflog'));
  await expect(page.locator('#pl-dash .pl-stat.seal .pl-stat-val')).toHaveText('2');
  await expect(page.locator('#pl-dash .pl-stat.challenge')).toContainText('0');
  await expect(page.locator('#pl-body')).not.toContainText(PRIVATE_SENTINEL);

  await page.evaluate(() => window.osiV2OpenMyCases());
  await expect(page.locator(`[data-case-ref="${PRIVATE_REF}"]`)).toBeVisible();
  expect((await page.evaluate(() => window.__fixtureProviderCounts())).signMessage).toBe(1);
  await page.locator(`[data-case-ref="${PRIVATE_REF}"]`).click();
  await expect(page.locator('#osi-case-content')).toContainText(PRIVATE_SENTINEL);
  await page.locator('#osi-case-drawer .osi-case-close').click();

  await page.evaluate(() => window.osiV2OpenMyReports());
  await expect(page.locator('#field-cases')).toContainText('Version history (3)');
  await page.evaluate(() => window.osiV2OpenReportQueue());
  for (const decision of ['Approve', 'Reject', 'Request Revision', 'Abstain']) {
    await expect(page.locator('#field-cases')).toContainText(decision);
  }
  await page.evaluate(() => window.osiAnalystOpenWorkspace('profile'));
  expect(await page.evaluate(() => window.location.hash)).toBe('#identity');
  await expect(page.locator('#identity-body')).toContainText('Server-derived weight');
  const analystProfileTab = page.locator('#osi-workspace-tab-profile');
  const analystApplicationsTab = page.locator('#osi-workspace-tab-applications');
  await expect(analystProfileTab).toHaveAttribute('aria-selected', 'true');
  await expect(analystProfileTab).toHaveAttribute('tabindex', '0');
  await expect(analystApplicationsTab).toHaveAttribute('tabindex', '-1');
  await analystProfileTab.focus();
  await analystProfileTab.press('ArrowRight');
  await expect(analystApplicationsTab).toBeFocused();
  await expect(analystApplicationsTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#identity-body')).toContainText('Revision requested');
  await analystApplicationsTab.press('Home');
  await expect(analystProfileTab).toBeFocused();
  await analystProfileTab.press('End');
  await expect(analystApplicationsTab).toBeFocused();
  expect((await page.evaluate(() => window.__fixtureProviderCounts())).signMessage).toBe(1);

  await page.reload();
  await page.waitForFunction(() => typeof window.osiV2OpenMyCases === 'function');
  await page.evaluate(() => window.osiV2OpenMyCases());
  await expect(page.locator(`[data-case-ref="${PRIVATE_REF}"]`)).toBeVisible();
  expect((await page.evaluate(() => window.__fixtureProviderCounts())).signMessage).toBe(1);

  const validToken = await page.evaluate(() => sessionStorage.getItem('osi_v2_read_session_v1'));
  await page.evaluate(({ other }) => window.__fixtureProvider.__emit('accountChanged', { toString: () => other }), { other: OTHER });
  expect(await page.evaluate(() => sessionStorage.getItem('osi_v2_read_session_v1'))).toBeNull();
  await page.evaluate(() => window.__fixtureProvider.__emit('disconnect'));
  expect(await page.evaluate(() => sessionStorage.getItem('osi_v2_read_session_v1'))).toBeNull();

  await page.evaluate((record) => {
    const parsed = JSON.parse(record);
    const parts = parsed.token.split('.');
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    payload.exp = Math.floor(Date.now() / 1000) - 1;
    parts[1] = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    sessionStorage.setItem('osi_v2_read_session_v1', JSON.stringify({ token: parts.join('.') }));
  }, validToken);
  await page.reload();
  await page.waitForFunction(() => typeof window.osiV2OpenMyCases === 'function');
  expect(await page.evaluate(() => sessionStorage.getItem('osi_v2_read_session_v1'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('osi_v2_read_session_expired_v1'))).toBe('1');
  expectCleanRuntime(page);
});

test('AI Pack drawer preserves capability, keyboard, reduced-motion, and 390px contracts', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ready(page);
  await page.evaluate(() => window.osiNavigate('field'));
  await page.getByLabel('Filter by status').selectOption('all');
  const opener = page.locator(`[data-case-ref="${AI_CASE_REF}"]`);
  await expect(opener).toBeVisible();
  await opener.click();
  await expect(page.locator('#osi-case-drawer')).toBeVisible();

  const aiTab = page.locator('[data-tab="ai_pack"]');
  await aiTab.click();
  await expect(page.locator('#osi-ai-pack-root')).toContainText(AI_RESTRICTED_SENTINEL);
  await expect(page.locator('#osi-ai-pack-root')).toContainText('Evidence Confidence Profile');
  await expect(page.locator('#osi-ai-pack-root')).toContainText('current at last server check');
  await expect(page.locator('#osi-ai-pack-generate')).toBeEnabled();
  await expect(page.locator('#osi-ai-review-submit')).toBeDisabled();
  await expect(page.locator('#osi-ai-review-help')).toContainText('production-disabled');
  await expect(page.locator('#osi-ai-layer option')).toHaveCount(3);
  await page.locator('#osi-ai-pack-generate').click();
  await expect(page.locator('#osi-ai-pack-generate')).toBeDisabled();
  await expect(page.locator('#osi-ai-pack-generation-status')).toContainText('Try again in 2 minutes.');
  await expect(page.locator('#osi-ai-pack-generate')).toBeEnabled();

  await aiTab.focus();
  await aiTab.press('ArrowRight');
  await expect(page.locator('[data-tab="resolution"]')).toBeFocused();
  await expect(page.locator('#osi-case-content')).toHaveAttribute('aria-labelledby', 'osi-case-tab-resolution');
  await page.locator('[data-tab="resolution"]').press('ArrowLeft');
  await expect(page.locator('[data-tab="ai_pack"]')).toBeFocused();
  await expect(page.locator('#osi-case-content')).toHaveAttribute('aria-labelledby', 'osi-case-tab-ai_pack');
  await expect(page.locator('#osi-ai-pack-root')).toContainText(AI_RESTRICTED_SENTINEL);

  await page.locator('#osi-ai-layer').selectOption('owner_safe');
  await expect(page.locator('#osi-ai-pack-root')).toContainText('Owner-safe fixture');
  await page.locator('#osi-ai-layer').selectOption('analyst_restricted');
  await expect(page.locator('#osi-ai-pack-root')).toContainText(AI_RESTRICTED_SENTINEL);

  const versionButton = page.locator('[data-ai-version]').first();
  await versionButton.focus();
  await expect(versionButton).toBeFocused();
  await expect(versionButton).toHaveAttribute('aria-current', 'true');
  const focusStyle = await versionButton.evaluate((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return { outline: parseFloat(style.outlineWidth), height: rect.height };
  });
  expect(focusStyle.outline).toBeGreaterThanOrEqual(2);
  expect(focusStyle.height).toBeGreaterThanOrEqual(40);
  expect(await page.locator('#osi-case-drawer .osi-case-panel').evaluate((node) => getComputedStyle(node).animationName)).toBe('none');

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('#osi-ai-pack-root')).toContainText(AI_LONG_TOKEN.slice(0, 80));
    const overflow = await page.locator('#osi-case-drawer').evaluate((drawer) => {
      const panel = drawer.querySelector('.osi-case-panel');
      const content = drawer.querySelector('.osi-case-content');
      return {
        document: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        panel: panel.scrollWidth <= panel.clientWidth + 1,
        content: content.scrollWidth <= content.clientWidth + 1,
      };
    });
    expect(overflow).toEqual({ document: true, panel: true, content: true });
  }

  await page.locator('#osi-case-drawer .osi-case-close').click();
  await expect(page.locator('#osi-case-drawer')).toBeHidden();
  await expect(opener).toBeFocused();
  expectCleanRuntime(page);
});

test('Wire private fixture and revision form fit desktop and 390px', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => window.osiV2OpenMyWireReports());
  await expect(page.locator('#wire-cases')).toContainText(WIRE_REPORT_REF);
  await expect(page.locator('#wire-cases')).toContainText('Version history (2)');
  await expect(page.locator('#wire-cases')).toContainText(WIRE_PRIVATE_SENTINEL);
  await expect(page.locator('#wire-cases')).toContainText('Published content is exposed only through the public allowlist');
  expect((await page.evaluate(() => window.__fixtureProviderCounts())).signMessage).toBe(1);

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate((reportRef) => window.osiV2OpenWireForm(reportRef), WIRE_REPORT_REF);
    const modal = page.locator('#osi-wire-modal');
    await expect(modal).toHaveClass(/open/);
    await expect(page.locator('#osi-wire-context')).toContainText('Next version 3');
    await expect(page.locator('#osi-wire-title')).toHaveValue('Wire fixture version 2');
    await expect(page.locator('#osi-wire-modal-copy')).toContainText('remain private');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    const box = await page.locator('#osi-wire-modal .fo-form').boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');
    await expect(modal).not.toHaveClass(/open/);
  }
  await page.evaluate(({ other }) => window.__fixtureProvider.__emit('accountChanged', { toString: () => other }), { other: OTHER });
  await expect(page.locator('body')).not.toContainText(WIRE_PRIVATE_SENTINEL);
  expect(await page.evaluate(() => sessionStorage.getItem('osi_v2_read_session_v1'))).toBeNull();
  expectCleanRuntime(page);
});

test('published, challenged, supported, and promoted Wire states fit desktop and 390px', async ({ page }) => {
  await ready(page);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate((versionRef) => window.osiV2OpenWireReport(versionRef), WIRE_VERSION_REF);
    const drawer = page.locator('#osi-wire-drawer');
    await expect(drawer).toHaveClass(/open/);
    await expect(page.locator('#osi-wire-detail-state')).toContainText('Challenge upheld, under re-review');
    await expect(page.locator('#osi-wire-detail-content')).toContainText('Wire author fixture');
    for (const [tab, text] of [
      ['evidence', TX.slice(0, 12)],
      ['reviews', 'Reviewer one'],
      ['challenges', 'material transaction context'],
      ['support', '100000000 lamports'],
      ['proof', /Wire Report Published/i],
    ]) {
      await page.locator(`[data-wire-tab="${tab}"]`).click();
      await expect(page.locator('#osi-wire-detail-content')).toContainText(text);
    }
    await expect(page.locator('#osi-wire-detail-actions')).toContainText('Support current author');
    await expect(page.locator('#osi-wire-detail-actions')).toContainText('already promoted');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    const box = await drawer.boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');
    await expect(drawer).not.toHaveClass(/open/);
  }

  await page.evaluate(() => window.osiV2OpenWireQueue());
  await expect(page.locator('#wire-cases')).toContainText('Wire queue fixture');
  await expect(page.locator('#wire-cases')).toContainText('Approve quorum 1 / 2 analysts');
  await expect(page.locator('#wire-cases')).toContainText('Author self-review is rejected by the database');
  expectCleanRuntime(page);
});

test('user identity, analyst workspace and Operations gate use one accessible product system', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => window.osiNavigate('identity'));
  await expect(page.locator('#identity-view')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your Intelligence Passport', level: 1 })).toBeVisible();
  await expect(page.locator('.identity-tabs [role="tab"]')).toHaveCount(6);
  const identityFirstTab = page.locator('.identity-tabs [role="tab"]').first();
  const identityLastTab = page.locator('.identity-tabs [role="tab"]').last();
  await identityFirstTab.focus();
  await identityFirstTab.press('End');
  await expect(identityLastTab).toBeFocused();
  await expect(identityLastTab).toHaveAttribute('aria-selected', 'true');

  await page.evaluate(() => window.osiAnalystOpenWorkspace('profile'));
  await expect(page.locator('#osi-workspace-tab-profile')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#identity-body')).toContainText('Server-derived weight');

  await page.evaluate(() => window.osiNavigate('admin'));
  expect(await page.evaluate(() => window.location.hash)).toBe('#admin');
  await expect(page.locator('#admin-view')).toBeVisible();
  await expect(page.getByRole('heading', { name: /OPERATIONS CENTER/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
  await expect(page.locator('#admLocked')).toContainText('Connected wallet is not authorized');
  await expect(page.locator('#admLogin form.adm-card')).toBeHidden();
  await expect(page.locator('#admPanel')).toBeHidden();
  expectCleanRuntime(page);
});

test('mobile, reduced motion and 200 percent reflow preserve access without overflow', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await ready(page);
  const duration = await page.locator('#osi-hero-signal-text').evaluate((node) => getComputedStyle(node, '::after').animationDuration);
  expect(parseFloat(duration)).toBeLessThanOrEqual(.02);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await expect(page.locator('.osi-home-hero .osi-button-primary')).toBeVisible();

  // A 1440px display at 200% browser zoom has a 720 CSS-pixel layout viewport.
  await page.setViewportSize({ width: 720, height: 500 });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await expect(page.locator('#osi-home-title')).toBeVisible();

  const workspaces = [
    ['registry', '#osi-home-title'],
    ['field', '#field-view'],
    ['wire', '#wire-view'],
    ['records', '#records-hero'],
    ['analysts', '#analysts'],
    ['prooflog', '#prooflog'],
    ['methodology', '#about-hero'],
  ];
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [view, selector] of workspaces) {
      await page.evaluate((route) => window.osiNavigate(route), view);
      await expect(page.locator(selector)).toBeVisible();
      expect(await page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    }
  }

  await page.evaluate(() => window.osiNavigate('field'));
  const cta = page.locator('#field-view .fo-cta');
  await expect(cta).toBeVisible();
  expect((await cta.boundingBox()).height).toBeGreaterThanOrEqual(40);
  await cta.click();
  await expect(page.locator('#fo-modal')).not.toHaveClass(/open/);
  await expect(page.locator('#stw-toast')).toContainText('Case intake is safely disabled while rollout checks are incomplete.');
  expectCleanRuntime(page);
});

test('capture every populated main workspace for preview QA', async ({ page }) => {
  test.skip(!process.env.OSI_QA_SCREENSHOT_DIR, 'Screenshot capture is enabled only for release QA.');
  const directory = path.resolve(process.env.OSI_QA_SCREENSHOT_DIR);
  fs.mkdirSync(directory, { recursive: true });
  const primeReveals = async () => page.evaluate(async () => {
    const height = document.documentElement.scrollHeight;
    for (let y = 0; y < height; y += Math.max(320, Math.floor(innerHeight * .72))) {
      scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 45));
    }
    scrollTo(0, 0);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const capture = async (name) => {
    await primeReveals();
    await page.screenshot({ path: path.join(directory, `${name}-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await primeReveals();
    await page.screenshot({ path: path.join(directory, `${name}-mobile.png`), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
  };
  await ready(page);
  await capture('home-populated');

  await page.evaluate(() => window.osiNavigate('field'));
  await page.getByLabel('Filter by status').selectOption('all');
  await capture('field-office-populated');
  await page.locator(`[data-case-ref="${CASE_REF}"]`).click();
  await page.locator('[data-tab="resolution"]').click();
  await capture('case-governance-populated');
  await page.locator('#osi-case-drawer .osi-case-close').click();

  await page.evaluate(() => window.osiNavigate('wire'));
  await page.waitForTimeout(120);
  await page.evaluate(({ other }) => {
    window.eval(`wireState.data=[${JSON.stringify({
      id: 'fixture-dispatch', subject: 'Fixture standalone finding',
      body: 'A public-safe standalone finding rendered only in release QA.', author: 'fixture analyst',
      wallet: other, created_at: new Date().toISOString(), premium: false,
    })}];drawWire();`);
  }, { other: OTHER });
  await capture('wire-populated');

  await page.evaluate(() => window.osiNavigate('records'));
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    const row = { id: 'fixture-record', company: 'Fixture sealed record', summary: 'Reviewed public-safe record.', onchain: 'wallet reference', offchain: 'https://example.com/evidence', tx: '2'.repeat(88), wallet: '11111111111111111111111111111112', sealed: true, approved: true, created_at: new Date().toISOString() };
    window.__crList = [row]; window.__crRecords = { 'fixture-record': row }; window.__crPacks = {};
    window.__crChallenged = {}; window.__crChallengeCounts = {}; window.__crOpenChallengeCount = 0;
    window.__crSourceState = 'loaded'; window.__crVouchesLoaded = false; window.crPaint();
  });
  const recordLayout = await page.evaluate(() => {
    const main = document.querySelector('#records-hero .cr-maincol').getBoundingClientRect();
    const aside = document.querySelector('#records-hero .cr-aside').getBoundingClientRect();
    return { mainBottom: main.bottom, asideTop: aside.top };
  });
  expect(recordLayout.asideTop).toBeGreaterThanOrEqual(recordLayout.mainBottom - 1);
  await capture('public-records-populated');

  await page.evaluate(() => window.osiNavigate('analysts'));
  await expect(page.locator('#lb-body')).toContainText('Public analyst fixture');
  const sparseAnalystLayout = await page.evaluate(() => {
    const main = document.querySelector('#analysts .lb-maincol').getBoundingClientRect();
    const aside = document.querySelector('#analysts .lb-aside').getBoundingClientRect();
    return { mainBottom: main.bottom, asideTop: aside.top };
  });
  expect(sparseAnalystLayout.asideTop).toBeGreaterThanOrEqual(sparseAnalystLayout.mainBottom - 1);
  await capture('analyst-network-populated');

  await page.evaluate(() => window.osiNavigate('prooflog'));
  await page.waitForTimeout(120);
  await page.evaluate((rows) => {
    window.__plEvents = rows.map((row, index) => ({ ...row, item_type: 'case', item_id: `fixture-${index}`, created_at: new Date(Date.now() - index * 60000).toISOString(), tx_sig: index === 3 ? '' : '2'.repeat(88) }));
    window.__plSourceState = 'loaded'; window.plPaint();
  }, proofRows);
  await capture('proof-log-populated');

  await page.evaluate(() => window.osiNavigate('methodology'));
  await capture('about');

  await page.evaluate(() => window.osiV2OpenReportQueue());
  await expect(page.locator('#field-cases')).toContainText('Version history (3)');
  await capture('report-review-populated');
  expectCleanRuntime(page);
});
