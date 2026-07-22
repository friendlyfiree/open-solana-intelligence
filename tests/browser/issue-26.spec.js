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
const ROLE_WALLETS = Object.freeze({
  legacy: WALLET,
  ordinary_wallet: WALLET,
  analyst_candidate: '11111111111111111111111111111115',
  verified_analyst: '11111111111111111111111111111116',
  maintainer: '11111111111111111111111111111117',
});
const APPLICATION_ID = '55555555-5555-4555-8555-555555555555';
const APPLICATION_VERSION_ID = '66666666-6666-4666-8666-666666666666';
const APPLICATION_VERSION_REF = 'OSI-AV-B1B2C3D4E5F60718';
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

const resolutionSelectionCase = {
  ...richCase,
  public_ref: 'OSI-C-1111111111111111',
  title: 'Resolution selection control fixture',
  stage: 'resolution_selection',
  submitted_by_wallet: OTHER,
  governance: {
    resolution: {
      public_ref: 'OSI-RES-1111111111111111',
      state: 'selection_open',
      selection_quorum: {
        leader_version_ref: VERSION_REF,
        leader_count: 3,
        leader_weight: 4.75,
        required_count: 3,
        required_weight: 4.5,
        tie_unresolved: false,
      },
      reviews: [],
    },
    challenges: [],
  },
  money: {},
  proof_log: [],
};

const sealReadyCase = {
  ...richCase,
  public_ref: 'OSI-C-2222222222222222',
  title: 'Seal-ready lifecycle control fixture',
  stage: 'resolved',
  submitted_by_wallet: OTHER,
  governance: {
    resolution: {
      public_ref: 'OSI-RES-2222222222222222',
      state: 'in_challenge_window',
      winning_report_version_ref: VERSION_REF,
      challenge_window_opens_at: iso(-9),
      challenge_window_closes_at: iso(-2),
      selection_quorum: { leader_version_ref: VERSION_REF, leader_count: 3, leader_weight: 4.75, required_count: 3, required_weight: 4.5, tie_unresolved: false },
      seal_quorum: { approve_count: 3, approve_weight: 4.75, required_count: 3, required_weight: 4.5, ready: true },
      reviews: [],
    },
    challenges: [],
  },
  money: {},
  proof_log: [],
};

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

const candidateApplication = {
  id: APPLICATION_ID,
  status: 'submitted',
  applicant_wallet: ROLE_WALLETS.analyst_candidate,
  profile: {
    wallet: ROLE_WALLETS.analyst_candidate,
    handle: 'candidate-fixture',
    display_name: 'Analyst candidate fixture',
    bio: 'Contributor applying through the immutable analyst-candidacy path.',
  },
  version: {
    id: APPLICATION_VERSION_ID,
    version_ref: APPLICATION_VERSION_REF,
    version_no: 1,
    expertise_public: ['onchain_tracing'],
    details_restricted: {
      motivation: 'Contribute reproducible public Solana incident research.',
      experience: 'Published wallet-flow notes with explicit uncertainty.',
      proof_urls: ['https://example.org/candidate-proof'],
    },
  },
  reviews: [],
};

function token(origin, wallet = WALLET) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    v: 1, iss: 'osi-v2-case-read', aud: origin, sub: wallet,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    jti: 'fixture-session-jti-00000000000000000001',
    scp: ['case:mine', 'case:detail', 'case:review', 'case:maintainer', 'report:mine', 'report:review', 'wire:mine', 'wire:queue', 'analyst:workspace', 'analyst:maintainer', 'aipack:detail'],
    auth_sub: null,
  })}.fixture-signature`;
}

async function installFixtureNetwork(page, options = {}) {
  const role = options.role || 'legacy';
  const connected = role !== 'anonymous';
  const wallet = ROLE_WALLETS[role] || WALLET;
  page.__fixtureRole = role;
  page.__fixtureOps = [];
  await page.addInitScript(({ wallet: fixtureWallet, connected: initiallyConnected, maintainer }) => {
    const count = (name) => Number(sessionStorage.getItem(`fixture_provider_${name}`) || 0);
    const bump = (name) => sessionStorage.setItem(`fixture_provider_${name}`, String(count(name) + 1));
    const listeners = {};
    const publicKey = { toString: () => fixtureWallet };
    const provider = {
      isPhantom: true, isConnected: initiallyConnected,
      publicKey: initiallyConnected ? publicKey : null,
      connect: async (connectOptions) => {
        bump(connectOptions && connectOptions.onlyIfTrusted ? 'trustedConnect' : 'connect');
        if (!initiallyConnected && window.__fixtureAllowExplicitConnect !== true) throw new Error(connectOptions && connectOptions.onlyIfTrusted ? 'not trusted' : 'not connected');
        provider.isConnected = true;
        provider.publicKey = publicKey;
        return { publicKey };
      },
      disconnect: async () => {
        provider.isConnected = false;
        provider.publicKey = null;
        (listeners.disconnect || []).forEach((fn) => fn());
      },
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
    if (maintainer) {
      const session = {
        access_token: 'fixture-maintainer-session',
        user: { id: '77777777-7777-4777-8777-777777777777', email: 'maintainer@example.org' },
      };
      window.supabase = {
        createClient: () => ({
          auth: {
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            getSession: async () => ({ data: { session }, error: null }),
            signInWithPassword: async () => ({ data: { session }, error: null }),
            signOut: async () => ({ error: null }),
          },
        }),
      };
    }
  }, { wallet, connected, maintainer: role === 'maintainer' });

  const roleAudit = role !== 'legacy';
  const lifecycle = options.lifecycle === true;
  const empty = options.empty === true;
  const publicFailure = options.publicFailure === true;
  const analystEligible = role === 'verified_analyst';
  const maintainerAccess = role === 'maintainer';
  const writesEnabled = connected;
  let submittedCase = false;
  let caseReviewed = false;
  let openedCase = false;
  let applicationReviewed = false;
  let applicationActivated = false;
  let wireReviewed = false;
  let wirePublished = false;

  await page.route(/https:\/\/(?:bundle\.run|unpkg\.com|cdn\.jsdelivr\.net)\/.*/, (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.route('https://api.coingecko.com/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ solana: { usd: 0, usd_24h_change: 0 }, bitcoin: { usd: 0, usd_24h_change: 0 }, ethereum: { usd: 0, usd_24h_change: 0 } }),
  }));
  await page.route('**/rest/v1/**', (route) => {
    const requestUrl = new URL(route.request().url());
    const rows = maintainerAccess && requestUrl.pathname.endsWith('/osi_config')
      ? [{ key: 'admin_wallet', value: wallet }]
      : [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });
  await page.route('**/functions/v1/**', async (route) => {
    const request = route.request();
    let body = {};
    try { body = request.postDataJSON() || {}; } catch (_) {}
    const endpoint = new URL(request.url()).pathname.split('/').pop();
    page.__fixtureOps.push({
      endpoint,
      op: body.op || '',
      action: body.action || '',
      phase: body.payload && body.payload.phase || '',
      target: body.target_ref || body.version_public_ref || body.case_ref || '',
    });
    let responseStatus = 200;
    let response = { ok: true };
    if (endpoint === 'osi-v2-case-read') {
      const openedFixture = { ...privateCase, visibility: 'public', stage: 'open_public', details_restricted: undefined };
      const lifecycleRichCase = lifecycle ? {
        ...richCase,
        governance: {
          ...richCase.governance,
          challenges: richCase.governance.challenges.map((challenge) => ({
            ...challenge,
            outcome_quorum: { accept_count: 3, accept_weight: 4.75, reject_count: 0, reject_weight: 0, required_count: 3, required_weight: 4.5 },
          })),
        },
      } : richCase;
      const baseCases = publicCases.map((item) => item.public_ref === CASE_REF ? lifecycleRichCase : item);
      const auditCases = roleAudit ? baseCases.concat(resolutionSelectionCase, sealReadyCase) : baseCases;
      if (body.op === 'list_public_cases') {
        if (publicFailure) responseStatus = 503;
        response = publicFailure
          ? { ok: false, error: 'read_failed' }
          : { ok: true, cases: empty ? [] : (openedCase ? auditCases.concat(openedFixture) : auditCases) };
      }
      else if (body.op === 'get_public_case') response.case = (openedCase && body.public_ref === PRIVATE_REF)
        ? openedFixture
        : auditCases.find((item) => item.public_ref === body.public_ref) || richCase;
      else if (body.op === 'list_my_cases') response.cases = submittedCase ? [privateCase] : [privateCase];
      else if (body.op === 'list_reviewable_cases') {
        const reviewedFixture = caseReviewed ? {
          ...privateCase,
          reviews: privateCase.reviews.concat({
            reviewer_wallet: wallet,
            reviewer_role: analystEligible ? 'analyst' : 'maintainer',
            decision: 'approve_open',
            reason_code: 'public_scope_clear',
            weight: analystEligible ? .5 : 0,
            is_active: true,
            proof_label: 'Wallet-signed and server-verified',
            created_at: iso(0),
          }),
        } : privateCase;
        response = roleAudit && !(analystEligible || maintainerAccess)
          ? { ok: false, error: 'not_eligible_reviewer' }
          : { ok: true, cases: [reviewedFixture] };
      }
      else if (body.op === 'issue_read_session_challenge') response.challenge = 'OSI private read fixture challenge';
      else if (body.op === 'create_read_session') response.read_session = token(new URL(page.url()).origin, wallet);
      else if (body.op === 'maintainer_case_overview') response = {
        ok: true,
        overview: { totals: { cases: 4, cases_by_visibility: { private: 1, public: 3 }, migration_manual_queue_rows: 0 }, flags: { OSI_V2_WRITES_ENABLED: 'false' } },
      };
    } else if (endpoint === 'osi-v2-case-write') {
      if (body.op === 'actor_capabilities') response = {
        ok: true,
        case_writes_enabled: writesEnabled,
        report_writes_enabled: writesEnabled,
        analyst_eligible: analystEligible,
        maintainer_access: maintainerAccess,
        maintainer_gate: maintainerAccess ? 'full' : 'denied',
        prerequisite: writesEnabled ? null : 'Connect a wallet to continue.',
      };
      else if (body.op === 'prepare_case') response = { ok: true, nonce: 'case-nonce', memo: 'OSI CASE_SUBMITTED fixture memo' };
      else if (body.op === 'commit_case') {
        submittedCase = true;
        response = { ok: true, case: privateCase };
      } else if (body.op === 'prepare_review') response = { ok: true, nonce: 'case-review-nonce', message: 'OSI CASE_REVIEWED fixture message' };
      else if (body.op === 'commit_review') {
        caseReviewed = true;
        response = { ok: true, actor_open_ready: false };
      }
      else if (body.op === 'prepare_open') response = { ok: true, nonce: 'case-open-nonce', memo: 'OSI CASE_OPENED fixture memo' };
      else if (body.op === 'commit_open') {
        openedCase = true;
        response = { ok: true, case: { ...privateCase, visibility: 'public', stage: 'open_public' } };
      }
    } else if (endpoint === 'osi-v2-governance-write') {
      if (body.op === 'actor_capabilities') response = {
        ok: true,
        resolution_lifecycle_writes_enabled: writesEnabled,
        analyst_eligible: analystEligible,
        maintainer_access: maintainerAccess,
      };
      else if (body.op === 'prepare') {
        const memoActions = ['resolution_finalize', 'seal_finalize', 'challenge_finalize'];
        response = {
          ok: true,
          nonce: `governance-${body.action}-nonce`,
          proof_text: `OSI ${body.action} fixture proof`,
          proof_type: memoActions.includes(body.action) ? 'solana_memo' : 'wallet_signed_server_verified',
          purpose: body.action,
        };
      } else if (body.op === 'commit') response = { ok: true, action: body.action };
    } else if (endpoint === 'osi-v2-report-read') {
      if (body.op === 'list_public_reports' && publicFailure) { responseStatus = 503; response = { ok: false, error: 'read_failed' }; }
      else if (body.op === 'list_public_reports' && empty) response.reports = [];
      else if (body.op === 'list_public_reports') response.reports = [{
        report_public_ref: REPORT_REF, version_public_ref: VERSION_REF, version_no: 1, state: 'published',
        body: 'Published public Report content.', content_public_safe: 'Public-safe Report summary.', evidence: [], review_timeline: [],
        quorum: { approve_count: 3, approve_weight: 4.75, required_count: 3, required_weight: 4.5 },
        publication_proof: { tx_sig: TX }, process_notice: 'Publication does not resolve the Case.',
      }];
      else if (body.op === 'list_review_queue' && roleAudit && !(analystEligible || maintainerAccess)) response = { ok: false, error: 'not_eligible_or_full_maintainer' };
      else response.reports = [reportFixture];
    } else if (endpoint === 'osi-v2-ai-pack') {
      if (body.op === 'capabilities') {
        const owner = body.case_ref === CASE_REF || body.case_ref === PRIVATE_REF;
        response = roleAudit ? {
          ok: true,
          ai_pack_writes_enabled: writesEnabled,
          ai_pack_review_writes_enabled: writesEnabled && (analystEligible || maintainerAccess),
          wallet_connected: connected,
          viewer_role: maintainerAccess ? 'maintainer' : (analystEligible ? 'analyst' : (connected ? 'owner' : 'public')),
          analyst_eligible: analystEligible,
          maintainer_access: maintainerAccess,
          can_generate: analystEligible,
          generation_prerequisite: analystEligible ? null : 'Generation requires an eligible analyst and the dedicated write gate.',
        } : {
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
        const roleVersion = {
          ...aiPackFixture.packs[0].versions[0],
          can_review_exact_version: analystEligible,
          review_prerequisite: analystEligible ? null : 'Only an independently eligible analyst may review this exact version.',
          can_finalize: maintainerAccess,
          finalize_prerequisite: maintainerAccess ? null : 'Full maintainer double-gate and analyst quorum are required.',
          quorum: maintainerAccess
            ? { approve_count: 2, approve_weight: 2.5, required_count: 2, required_weight: 2.5, ready: true }
            : aiPackFixture.packs[0].versions[0].quorum,
        };
        response = roleAudit
          ? { ok: true, viewer_role: maintainerAccess ? 'maintainer' : (analystEligible ? 'analyst' : 'owner'), packs: [{ ...aiPackFixture.packs[0], versions: [roleVersion] }] }
          : { ok: true, ...aiPackFixture };
      } else if (body.op === 'list_public_case_packs') {
        response = { ok: true, viewer_role: 'public', packs: [] };
      } else if (body.op === 'prepare_generation') {
        if (lifecycle) response = { ok: true, nonce: 'ai-generation-nonce', message: 'OSI AI PACK generation fixture message' };
        else {
          await new Promise((resolve) => setTimeout(resolve, 180));
          response = {
            ok: false,
            error: 'ai_pack_case_cooldown_active',
            details: { retry_after_seconds: 90 },
          };
        }
      } else if (body.op === 'commit_generation') response = { ok: true, version_ref: AI_VERSION_REF };
      else if (body.op === 'prepare_review') response = { ok: true, nonce: 'ai-review-nonce', message: 'OSI AI PACK review fixture message' };
      else if (body.op === 'commit_review') response = { ok: true, review_ref: AI_REVIEW_REF };
      else if (body.op === 'prepare_approval') response = { ok: true, nonce: 'ai-approval-nonce', memo: 'OSI AI_PACK_APPROVED fixture memo' };
      else if (body.op === 'commit_approval') response = { ok: true, version_ref: AI_VERSION_REF };
    } else if (endpoint === 'osi-v2-wire') {
      if (body.op === 'capabilities') response = roleAudit ? {
        ok: true, wire_writes_enabled: writesEnabled, publication_enabled: analystEligible || maintainerAccess,
        payment_writes_enabled: writesEnabled, challenge_enabled: writesEnabled, support_enabled: writesEnabled,
        analyst_eligible: analystEligible, maintainer_access: maintainerAccess, promotion_enabled: analystEligible || maintainerAccess,
        review_enabled: analystEligible, wallet_connected: connected,
        prerequisite: connected ? null : 'Connect a wallet to continue.',
      } : {
        ok: true, wire_writes_enabled: true, publication_enabled: true,
        payment_writes_enabled: true, challenge_enabled: true, support_enabled: true,
        analyst_eligible: true, maintainer_access: false, promotion_enabled: true,
        wallet_connected: true, prerequisite: null,
      };
      else if (body.op === 'list_my_wire_reports') response = {
        ok: true, reports: [wireFixture], private_projection: true,
      };
      else if (body.op === 'list_public_wire_reports') response = {
        ok: !publicFailure,
        error: publicFailure ? 'read_failed' : undefined,
        reports: empty ? [] : [{ ...publicWireListItem, promoted: lifecycle ? false : publicWireListItem.promoted }],
        public_projection: true,
      };
      else if (body.op === 'get_public_wire_report') response = {
        ok: true, report: { ...publicWireDetail, promoted: lifecycle ? false : publicWireDetail.promoted }, public_projection: true,
      };
      else if (body.op === 'list_wire_review_queue') response = {
        ok: !(roleAudit && !(analystEligible || maintainerAccess)),
        error: roleAudit && !(analystEligible || maintainerAccess) ? 'not_eligible_or_full_maintainer' : undefined,
        reports: [{
          ...wireQueueItem,
          lifecycle_state: wirePublished ? 'published' : wireQueueItem.lifecycle_state,
          quorum: { ...wireQueueItem.quorum, approve_ready: wireReviewed },
          my_active_review: wireReviewed ? { decision: 'approve' } : null,
        }],
        private_projection: true,
      };
      else if (body.op === 'prepare_wire') response = { ok: true, nonce: 'wire-submit-nonce', memo: 'OSI WIRE_REPORT_VERSION_SUBMITTED fixture memo' };
      else if (body.op === 'commit_wire') response = { ok: true, wire_report_public_ref: WIRE_REPORT_REF, version_no: 1 };
      else if (body.op === 'prepare_wire_review') response = { ok: true, nonce: 'wire-review-nonce', message: 'OSI WIRE review fixture message' };
      else if (body.op === 'commit_wire_review') {
        wireReviewed = true;
        response = { ok: true, review_ref: 'OSI-WRV-C1B2C3D4E5F6' };
      } else if (body.op === 'prepare_wire_publication') response = { ok: true, nonce: 'wire-publication-nonce', memo: 'OSI WIRE_REPORT_PUBLISHED fixture memo' };
      else if (body.op === 'commit_wire_publication') {
        wirePublished = true;
        response = { ok: true, version_public_ref: body.version_public_ref };
      } else if (body.op === 'prepare_wire_promotion') response = { ok: true, nonce: 'wire-promotion-nonce', proof_text: 'OSI WIRE promoted fixture message', proof_type: 'wallet_signed_server_verified', purpose: 'wire_promote' };
      else if (body.op === 'commit_wire_promotion') response = { ok: true, case_public_ref: 'OSI-C-3333333333333333' };
      else if (body.op === 'prepare_wire_challenge') response = { ok: true, nonce: 'wire-challenge-nonce', proof_text: `OSI ${body.action} fixture message`, proof_type: 'wallet_signed_server_verified', purpose: body.action };
      else if (body.op === 'commit_wire_challenge') response = { ok: true, action: body.action };
    } else if (endpoint === 'osi-v2-proof' && body.mode === 'sas_verify') {
      const verified = [OTHER, ROLE_WALLETS.verified_analyst].includes(body.wallet);
      response = {
        ok: true,
        valid: verified,
        state: verified ? 'verified' : 'not_found',
        reason: verified ? null : 'No current OSI analyst credential.',
        source: 'fixture_sas_public_verifier',
        credential: verified ? OTHER : null,
        schema: verified ? ROLE_WALLETS.verified_analyst : null,
        checked_at: iso(0),
      };
    } else if (endpoint === 'osi-v2-analyst') {
      const roleAnalystProfile = { ...analystFixture, wallet, handle: 'verified-role-fixture', display_name: 'Verified analyst role fixture' };
      const candidateWorkspaceApplication = {
        id: APPLICATION_ID,
        status: applicationActivated ? 'probationary' : 'submitted',
        versions: [{
          id: APPLICATION_VERSION_ID,
          version_no: 1,
          version_ref: APPLICATION_VERSION_REF,
          details_restricted: candidateApplication.version.details_restricted,
          expertise_public: candidateApplication.version.expertise_public,
        }],
        reviews: [],
      };
      if (body.op === 'list_public_profiles') response = publicFailure
        ? { ok: false, error: 'read_failed' }
        : { ok: true, analysts: empty ? [] : (analystEligible ? [analystFixture, roleAnalystProfile] : [analystFixture]) };
      else if (body.op === 'my_workspace') {
        if (!roleAudit) response = analystWorkspace;
        else if (analystEligible) response = { ...analystWorkspace, profile: { ...roleAnalystProfile, weight_cached: 1.5, expertise_public: ['onchain_tracing'], links_public: [] } };
        else if (role === 'analyst_candidate') response = { ok: true, profile: null, applications: [candidateWorkspaceApplication] };
        else response = { ok: true, profile: null, applications: [] };
      } else if (body.op === 'maintainer_queue') {
        const reviews = applicationReviewed ? [{
          reviewer_wallet: wallet,
          decision: 'approve',
          reason_code: 'meets_probationary_baseline',
          is_active: true,
          created_at: iso(-.1),
        }] : [];
        response.applications = applicationActivated ? [] : [{ ...candidateApplication, reviews }];
      } else if (body.op === 'prepare_application') response = { ok: true, nonce: 'application-nonce', message: 'OSI analyst application fixture message', version_ref: APPLICATION_VERSION_REF };
      else if (body.op === 'commit_application') response = { ok: true, application: { id: APPLICATION_ID, version_no: 1 } };
      else if (body.op === 'prepare_review') response = { ok: true, nonce: 'application-review-nonce', message: 'OSI analyst application review fixture message' };
      else if (body.op === 'commit_review') {
        applicationReviewed = true;
        response = { ok: true, activation_ready: true };
      } else if (body.op === 'prepare_activation') response = { ok: true, nonce: 'application-activation-nonce', memo: 'OSI ANALYST_PROBATION fixture memo' };
      else if (body.op === 'commit_activation') {
        applicationActivated = true;
        response = { ok: true, analyst: { wallet: ROLE_WALLETS.analyst_candidate, tier: 'probationary', weight: .5 } };
      }
    } else if (body.op === 'actor_capabilities' || body.op === 'capabilities') {
      response = roleAudit ? {
        ok: true,
        case_writes_enabled: writesEnabled,
        report_writes_enabled: writesEnabled,
        resolution_lifecycle_writes_enabled: writesEnabled,
        payment_writes_enabled: writesEnabled,
        analyst_eligible: analystEligible,
        maintainer_access: maintainerAccess,
        prerequisite: connected ? null : 'Connect a wallet to continue.',
      } : {
        ok: true, case_writes_enabled: false, report_writes_enabled: false,
        resolution_lifecycle_writes_enabled: false, payment_writes_enabled: false,
        analyst_eligible: true, maintainer_access: false,
        prerequisite: 'Fixture keeps production writes disabled.',
      };
    }
    if (publicFailure && ((endpoint === 'osi-v2-wire' && body.op === 'list_public_wire_reports') || (endpoint === 'osi-v2-analyst' && body.op === 'list_public_profiles'))) responseStatus = 503;
    await route.fulfill({ status: responseStatus, contentType: 'application/json', body: JSON.stringify(response) });
  });
}

async function ready(page, options = {}) {
  page.__issue26Errors = [];
  page.on('pageerror', (error) => page.__issue26Errors.push(`page: ${error.message}`));
  page.on('console', (message) => {
    if (!['error', 'warning'].includes(message.type())) return;
    const text = message.text();
    const fixtureSriBlock = text.includes("Failed to find a valid digest in the 'integrity' attribute")
      && /https:\/\/(?:bundle\.run|unpkg\.com|cdn\.jsdelivr\.net)\//.test(text)
      && text.includes("OLBgp1GsljhM2TJ+sbHjaiH9txEUvgdDTAzHv2P24donTt6/529l+9Ua0vFImLlb");
    const expectedPublicFailure = options.publicFailure
      && message.type() === 'error'
      && /^Failed to load resource: the server responded with a status of 503 \(Service Unavailable\)$/.test(text);
    if (!fixtureSriBlock && !expectedPublicFailure) page.__issue26Errors.push(`console ${message.type()}: ${text}`);
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure() && request.failure().errorText || 'unknown';
    if (!failure.includes('ERR_ABORTED')) page.__issue26Errors.push(`network: ${request.url()} ${failure}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !(options.publicFailure && response.status() === 503 && response.url().includes('/functions/v1/'))) {
      page.__issue26Errors.push(`http: ${response.status()} ${response.url()}`);
    }
  });
  await installFixtureNetwork(page, options);
  await page.goto('/');
  await page.waitForFunction(() => typeof window.osiNavigate === 'function' && typeof window.osiV2OpenMyCases === 'function');
  if (options.publicFailure) await expect(page.locator('#osi-home-live-state')).toContainText('Public Case index unavailable');
  else if (options.empty) await expect(page.locator('#osi-home-live-state')).toContainText('No public Cases are listed');
  else await expect(page.locator('#osi-home-live-state')).toContainText('Reviewed transfer-path investigation');
  const role = options.role || 'legacy';
  const wallet = ROLE_WALLETS[role] || WALLET;
  if (role === 'verified_analyst') {
    await page.evaluate(({ actor }) => {
      window.VERIFIED_ANALYSTS = window.VERIFIED_ANALYSTS || {};
      window.ANALYST_WEIGHT = window.ANALYST_WEIGHT || {};
      window.VERIFIED_ANALYSTS[actor] = { wallet: actor, handle: 'verified-role-fixture', display_name: 'Verified analyst role fixture', tier: 'verified', weight: 1.5 };
      window.ANALYST_WEIGHT[actor] = 1.5;
      if (typeof updateWalletUI === 'function') updateWalletUI();
    }, { actor: wallet });
  }
  if (role === 'maintainer') {
    await page.evaluate(async ({ actor }) => {
      if (typeof SUPA_AUTH_READY !== 'undefined') await SUPA_AUTH_READY;
      if (typeof loadConfig === 'function') await loadConfig();
      OSI_ADMIN_WALLET = actor;
      if (typeof setMaintainerServerGate === 'function') setMaintainerServerGate(true, 'full');
      if (typeof updateWalletUI === 'function') updateWalletUI();
    }, { actor: wallet });
    await page.waitForFunction(() => typeof resolveMaintainerAccess === 'function' && resolveMaintainerAccess().allowed === true);
  }
}

function expectCleanRuntime(page) {
  expect(page.__issue26Errors).toEqual([]);
}

async function openPlatformItem(page, name) {
  const trigger = page.locator('#platform-menu-trigger');
  await trigger.click();
  await expect(page.locator('#platform-menu')).toBeVisible();
  const item = page.locator('#platform-menu').getByRole('button', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) });
  await expect(item).toHaveCount(1);
  await item.click();
}

async function expectNoPageOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

async function auditPublicFilters(page) {
  await page.evaluate(() => window.osiNavigate('records'));
  for (const filter of ['all', 'reviewed', 'memo', 'challenged', 'sealed']) {
    const button = page.locator(`#cr-fils [data-f="${filter}"]`);
    await button.click();
    await expect(button).toHaveClass(/active/);
  }

  await page.evaluate(() => window.osiNavigate('prooflog'));
  for (const filter of ['all', 'case', 'report', 'vote', 'challenge', 'support', 'seal']) {
    const button = page.locator(`#pl-fils [data-f="${filter}"]`);
    await button.click();
    await expect(button).toHaveClass(/active/);
  }
}

const readinessRoles = [
  ['anonymous', 'Connect Wallet', false, false],
  ['ordinary_wallet', 'My OSI', false, false],
  ['analyst_candidate', 'My OSI', false, false],
  ['verified_analyst', 'Analyst Desk', true, false],
  ['maintainer', 'Maintainer Console', false, true],
];

for (const [role, workspaceTitle, canReview, canMaintain] of readinessRoles) {
  test(`launch readiness: ${role} reaches every authorized top-level and role workspace surface`, async ({ page }) => {
    await ready(page, { role });

    await page.locator('#global-nav [data-global-view="registry"]').click();
    await expect(page.locator('body')).toHaveAttribute('data-view', 'registry');
    for (const [label, view] of [
      ['Field Office', 'field'],
      ['The Wire', 'wire'],
      ['Public Records', 'records'],
      ['Proof Log', 'prooflog'],
      ['Analyst Network', 'analysts'],
    ]) {
      await openPlatformItem(page, label);
      await expect(page.locator('body')).toHaveAttribute('data-view', view);
    }

    await page.locator('#global-nav [data-global-view="methodology"]').click();
    await expect(page.locator('#about-hero')).toBeVisible();
    await page.locator('#sas-verifier-wallet').fill(OTHER);
    await page.locator('#sas-verifier-form').getByRole('button', { name: 'Verify wallet' }).click();
    await expect(page.locator('#sas-verifier-status')).toContainText('Verified:');

    await openPlatformItem(page, 'Resolution lifecycle');
    await expect(page.getByLabel('Filter by status')).toHaveValue('resolution_selection');
    await openPlatformItem(page, 'Reward & support');
    await expect(page.getByLabel('Filter by status')).toHaveValue('sealed');

    await auditPublicFilters(page);

    await openPlatformItem(page, 'My OSI');
    await expect(page.locator('#workspace-view')).toBeVisible();
    await expect(page.locator('#workspace-body')).toContainText(workspaceTitle);

    await openPlatformItem(page, 'Open a Case');
    if (role === 'anonymous') {
      await expect(page.locator('#fo-modal')).not.toHaveClass(/open/);
      await expect(page.locator('#stw-toast')).toContainText(/Connect (Phantom first|a Solana wallet to continue)/);
    } else {
      await expect(page.locator('#fo-modal')).toHaveClass(/open/);
      await page.locator('#fo-modal .fo-x').click();
    }

    await openPlatformItem(page, 'Review Queue');
    if (canReview || canMaintain) {
      await expect(page.locator(`[data-case-ref="${PRIVATE_REF}"]`)).toBeVisible();
    } else {
      await expect(page.locator('#field-cases')).toContainText(/workspace unavailable|eligible V2 analyst|full maintainer|wallet not connected/i);
    }

    await page.evaluate(() => window.osiNavigate('identity'));
    if (role === 'anonymous') {
      await expect(page.locator('#identity-body')).toContainText('Wallet Required');
    } else {
      const tabs = page.locator('.identity-tabs [role="tab"]');
      await expect(tabs).toHaveCount(6);
      for (let index = 0; index < 6; index += 1) {
        await tabs.nth(index).click();
        await expect(page.locator('.identity-pane.active')).toBeVisible();
      }
    }

    if (role === 'analyst_candidate') {
      await page.evaluate(() => window.osiAnalystOpenWorkspace('applications'));
      await expect(page.locator('#identity-body')).toContainText('Submitted');
      await expect(page.locator('#identity-body')).toContainText('Current version 1');
    }

    if (canMaintain) {
      await page.locator('#walletBtn').click();
      const operations = page.locator('#maintainerAccessMenu');
      await expect(operations).toBeVisible();
      await operations.click();
      await expect(page.locator('#admPanel')).toBeVisible();
      await page.getByRole('button', { name: 'Refresh overview' }).click();
      await expect(page.locator('#osi-native-ops-overview')).toContainText('Cases');
    } else {
      await page.evaluate(() => window.osiNavigate('admin'));
      await expect(page.locator('#admLocked')).toContainText(/Access denied|Connect the configured|Connected wallet is not authorized/i);
      await expect(page.locator('#admPanel')).toBeHidden();
    }

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const view of ['registry', 'field', 'wire', 'records', 'analysts', 'prooflog', 'methodology', 'identity', 'workspace', 'admin']) {
        await page.evaluate((target) => window.osiNavigate(target), view);
        await expectNoPageOverflow(page);
      }
    }
    expectCleanRuntime(page);
  });
}

test('launch readiness: public empty states are explanatory and contain no raw sentinel values', async ({ page }) => {
  await ready(page, { role: 'anonymous', empty: true });
  await page.evaluate(() => window.osiNavigate('field'));
  await expect(page.locator('#field-cases')).toContainText('No public V2 Cases yet');

  await page.evaluate(async () => {
    window.CASE_STUDIES = [];
    window.osiNavigate('wire');
    await window.wireOpenPublic();
  });
  await expect(page.locator('#wire-cases')).toContainText('The wire is quiet');

  await page.evaluate(() => window.osiNavigate('analysts'));
  await expect(page.locator('#lb-body')).toContainText('No activated analysts yet');
  await page.evaluate(() => window.osiNavigate('records'));
  await expect(page.locator('#case-records')).toContainText('No public records have been sealed yet');
  await page.evaluate(() => window.osiNavigate('prooflog'));
  await expect(page.locator('#pl-body')).toContainText(/No proof events|No matching proof/i);
  expect(await page.locator('#main-content').innerText()).not.toMatch(/\b(?:undefined|NaN)\b/);
  expectCleanRuntime(page);
});

test('launch readiness: public read failures stay retryable, fail closed, and avoid raw errors', async ({ page }) => {
  await ready(page, { role: 'anonymous', publicFailure: true });
  await expect(page.locator('#osi-home-live-state')).toContainText('No cached or invented Case data is shown');

  await page.evaluate(() => window.osiNavigate('field'));
  await expect(page.locator('#field-cases')).toContainText('Public registry unavailable');
  await page.evaluate(async () => {
    window.CASE_STUDIES = [];
    window.osiNavigate('wire');
    await window.wireOpenPublic();
  });
  await expect(page.locator('#wire-cases')).toContainText('Live dispatches are temporarily unavailable');
  await expect(page.locator('#wire-cases').getByRole('button', { name: 'Retry live source' })).toBeVisible();
  expect(await page.locator('#main-content').innerText()).not.toMatch(/read[_ ]failed|undefined|NaN/i);
  expectCleanRuntime(page);
});

async function expectFixtureOperation(page, endpoint, op, action = '') {
  await expect.poll(() => page.__fixtureOps.some((entry) => entry.endpoint === endpoint && entry.op === op && (!action || entry.action === action))).toBe(true);
}

function fixtureOperationCount(page, endpoint, op, action = '', phase = '') {
  return page.__fixtureOps.filter((entry) => entry.endpoint === endpoint && entry.op === op
    && (!action || entry.action === action) && (!phase || entry.phase === phase)).length;
}

async function expectNewFixtureOperation(page, endpoint, op, action, phase, previousCount) {
  await expect.poll(() => fixtureOperationCount(page, endpoint, op, action, phase)).toBeGreaterThan(previousCount);
}

test('launch readiness: verified analyst controls traverse Case, Wire, governance, challenge, and AI Pack writes', async ({ page }) => {
  test.setTimeout(180_000);
  page.on('dialog', (dialog) => dialog.accept(dialog.type() === 'prompt'
    ? 'The exact evidence and process prerequisites were independently reviewed.'
    : undefined));
  await ready(page, { role: 'verified_analyst', lifecycle: true });
  await page.evaluate((tx) => { window.castOnchainVote = async () => tx; }, TX);

  await openPlatformItem(page, 'Open a Case');
  await expect(page.locator('#v2-case-title')).toBeFocused();
  await page.locator('#v2-case-title').fill('Lifecycle fixture Case');
  await page.locator('#v2-case-summary').fill('A neutral public-safe Case summary with enough detail for independent review and publication.');
  await page.locator('#v2-case-details').fill('Restricted fixture context records transaction order, uncertainty, and review limits without prohibited data.');
  await page.locator('#v2-case-transactions').fill(TX);
  await page.locator('#v2-case-confirm').check();
  await page.locator('#v2-case-submit').click();
  await expectFixtureOperation(page, 'osi-v2-case-write', 'commit_case');
  await expect(page.locator('#fo-modal')).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('#fo-title')).toHaveText('My Cases');

  await page.evaluate(() => window.osiV2OpenReviewQueue());
  const initialReview = page.locator(`[data-case-ref="${PRIVATE_REF}"]`).first();
  await expect(initialReview).toBeVisible();
  await initialReview.click();
  await expect(page.locator('#osi-case-drawer')).toBeVisible();
  await page.getByRole('button', { name: 'Record review' }).click();
  await page.locator('#osi-review-submit').click();
  await expectFixtureOperation(page, 'osi-v2-case-write', 'commit_review');
  const anchorOpen = page.getByRole('button', { name: 'Anchor public open' });
  await expect(anchorOpen).toBeVisible();
  await anchorOpen.click();
  await expectFixtureOperation(page, 'osi-v2-case-write', 'commit_open');
  await expect(page.locator('#osi-case-state')).toContainText('Public investigation');
  await page.evaluate(() => window.osiV2CloseCase());
  await expect(page.locator('#osi-case-drawer')).toBeHidden();

  await page.evaluate(() => window.osiV2OpenWireForm());
  await expect(page.locator('#osi-wire-title')).toBeFocused();
  await page.locator('#osi-wire-title').fill('Lifecycle Wire fixture');
  await page.locator('#osi-wire-summary').fill('A public-safe standalone finding prepared for independent review and exact publication.');
  await page.locator('#osi-wire-analysis').fill('The detailed fixture analysis follows transaction order, competing explanations, and reproducible evidence limitations.');
  await page.locator('#osi-wire-uncertainties').fill('Wallet control and attribution remain uncertain after the observed transfers.');
  await page.locator('#osi-wire-transactions').fill(TX);
  await page.locator('#osi-wire-safety').check();
  await page.locator('#osi-wire-submit').click();
  await expectFixtureOperation(page, 'osi-v2-wire', 'commit_wire');
  await expect(page.locator('#osi-wire-modal')).not.toHaveClass(/\bopen\b/);
  await expect(page.locator('#wire-cases')).toContainText('Private author workspace');

  await page.evaluate(() => window.osiV2OpenWireQueue());
  await expect(page.locator('[data-wire-queue-card]')).toBeVisible();
  await page.locator('[data-wire-review-rationale]').fill('The exact evidence supports publication with the stated limits.');
  await page.locator('[data-wire-review]').click();
  await expectFixtureOperation(page, 'osi-v2-wire', 'commit_wire_review');
  await expect(page.locator('[data-wire-publish]')).toBeVisible();
  await page.locator('[data-wire-publish]').dispatchEvent('click');
  await expectFixtureOperation(page, 'osi-v2-wire', 'commit_wire_publication');

  await page.evaluate((versionRef) => window.osiV2OpenWireReport(versionRef), WIRE_VERSION_REF);
  await page.locator('[data-wire-tab="challenges"]').click();
  await page.locator('#osi-wire-challenge-summary').fill('This exact publication requires additional material transaction context.');
  await page.locator('[data-wire-governance="submit"]').click();
  await expectFixtureOperation(page, 'osi-v2-wire', 'commit_wire_challenge', 'challenge_submit');
  await expect(page.locator('[data-wire-promote]')).toBeVisible();
  await page.locator('[data-wire-promote]').click();
  await expectFixtureOperation(page, 'osi-v2-wire', 'commit_wire_promotion', 'wire_promote');
  await page.waitForTimeout(200);
  await page.evaluate(() => window.osiV2CloseWireReport());

  await page.evaluate((caseRef) => window.osiV2OpenCase(caseRef), resolutionSelectionCase.public_ref);
  await page.locator('[data-tab="resolution"]').click();
  await page.locator('#osi-resolution-rationale').fill('This exact published version leads the independent count and weight gates.');
  const selectionReviewCount = fixtureOperationCount(page, 'osi-v2-governance-write', 'commit', 'resolution_review', 'selection');
  await page.getByRole('button', { name: 'Sign and record review' }).click();
  await expectNewFixtureOperation(page, 'osi-v2-governance-write', 'commit', 'resolution_review', 'selection', selectionReviewCount);
  await page.waitForTimeout(200);

  await page.evaluate((caseRef) => window.osiV2OpenCase(caseRef), sealReadyCase.public_ref);
  await page.locator('[data-tab="resolution"]').click();
  const sealReviewCount = fixtureOperationCount(page, 'osi-v2-governance-write', 'commit', 'resolution_review', 'seal');
  await page.getByRole('button', { name: 'Sign seal review' }).click();
  await expectNewFixtureOperation(page, 'osi-v2-governance-write', 'commit', 'resolution_review', 'seal', sealReviewCount);
  await page.waitForTimeout(200);

  await page.evaluate((caseRef) => window.osiV2OpenCase(caseRef), CASE_REF);
  await page.locator('[data-tab="challenges"]').click();
  await page.locator('#osi-challenge-summary').fill('The selected exact version needs additional independent transaction context.');
  await page.locator('#osi-challenge-evidence').fill('88888888-8888-4888-8888-888888888888');
  await page.getByRole('button', { name: 'Sign and submit challenge' }).click();
  await expectFixtureOperation(page, 'osi-v2-governance-write', 'commit', 'challenge_submit');
  await page.waitForTimeout(200);
  await page.locator('[data-tab="challenges"]').click();
  await page.getByRole('button', { name: 'Accept review' }).click();
  await expectFixtureOperation(page, 'osi-v2-governance-write', 'commit', 'challenge_review');
  await page.waitForTimeout(200);
  await page.locator('[data-tab="challenges"]').click();
  await page.getByRole('button', { name: 'Memo-anchor quorum outcome' }).click();
  await expectFixtureOperation(page, 'osi-v2-governance-write', 'commit', 'challenge_finalize');
  await page.waitForTimeout(200);

  await page.evaluate((caseRef) => window.osiV2OpenCase(caseRef), AI_CASE_REF);
  await page.locator('[data-tab="ai_pack"]').click();
  await page.locator('#osi-ai-pack-generate').click();
  await expectFixtureOperation(page, 'osi-v2-ai-pack', 'commit_generation');
  await page.waitForTimeout(200);
  await page.locator('#osi-ai-review-rationale').fill('The immutable artifact remains evidence-bound and appropriately qualified.');
  await page.locator('#osi-ai-review-submit').click();
  await expectFixtureOperation(page, 'osi-v2-ai-pack', 'commit_review');
  expectCleanRuntime(page);
});

test('launch readiness: full maintainer controls review candidacy and finalize only analyst-ready outcomes', async ({ page }) => {
  test.setTimeout(120_000);
  page.on('dialog', (dialog) => dialog.accept());
  await ready(page, { role: 'maintainer', lifecycle: true });
  await page.evaluate((tx) => { window.castOnchainVote = async () => tx; }, TX);

  await page.evaluate(() => window.admOpen());
  await expect(page.locator('#admPanel')).toBeVisible();
  await page.getByRole('button', { name: 'Refresh queue' }).click();
  const application = page.locator(`[data-application-id="${APPLICATION_ID}"]`);
  await expect(application).toBeVisible();
  await application.getByRole('button', { name: 'Approve' }).click();
  await expectFixtureOperation(page, 'osi-v2-analyst', 'commit_review');
  await expectFixtureOperation(page, 'osi-v2-analyst', 'commit_activation');

  await page.evaluate((caseRef) => window.osiV2OpenCase(caseRef), resolutionSelectionCase.public_ref);
  await page.locator('[data-tab="resolution"]').click();
  await page.getByRole('button', { name: 'Finalize server-derived leader' }).click();
  await expectFixtureOperation(page, 'osi-v2-governance-write', 'commit', 'resolution_finalize');

  await page.evaluate((caseRef) => window.osiV2OpenCase(caseRef), sealReadyCase.public_ref);
  await page.locator('[data-tab="resolution"]').click();
  await page.getByRole('button', { name: 'Memo-anchor process seal' }).click();
  await expectFixtureOperation(page, 'osi-v2-governance-write', 'commit', 'seal_finalize');

  await page.evaluate((caseRef) => window.osiV2OpenCase(caseRef), AI_CASE_REF);
  await page.locator('[data-tab="ai_pack"]').click();
  await page.locator('#osi-ai-approve').click();
  await expectFixtureOperation(page, 'osi-v2-ai-pack', 'commit_approval');
  expectCleanRuntime(page);
});

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
