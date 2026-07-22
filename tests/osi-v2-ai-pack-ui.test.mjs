import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = join(import.meta.dirname, '..');
const source = readFileSync(join(root, 'assets/js/v2-ai-pack-integration.js'), 'utf8');
const CASE_REF = 'OSI-C-AI-PACK-UI-0001';
const WALLET = '11111111111111111111111111111111';
const XSS = '<img src=x onerror="globalThis.__xss=1">';
const OWNER_ONLY = 'OWNER_ONLY_SENTINEL';
const ANALYST_ONLY = 'ANALYST_ONLY_SENTINEL';
const PRIVATE_REVIEW = 'PRIVATE_REVIEW_SENTINEL';

let assertions = 0;
function ok(name, condition) {
  assertions += 1;
  if (!condition) throw new Error(`not ok ${assertions} - ${name}`);
  console.log(`ok ${assertions} - ${name}`);
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this.innerHTML = '';
    this.attributes = new Map();
    this.disabled = false;
    this.dataset = {};
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  replaceChildren() { this.innerHTML = ''; }
  querySelectorAll() { return []; }
  addEventListener() {}
  focus() { this.focused = true; }
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function renderFixture({ capabilities, result, wallet = '', mode = 'public', caseItem = {} }) {
  const rootNode = new FakeElement('osi-ai-pack-root');
  const requests = [];
  let readSessionCalls = 0;
  const document = {
    getElementById(id) { return id === 'osi-ai-pack-root' ? rootNode : null; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  const window = {
    walletPubkey: wallet,
    osiV2RegisterPrivateCache() {},
    osiV2ReadSession: async () => {
      readSessionCalls += 1;
      return { wallet, token: 'fixture-read-session' };
    },
  };
  const context = vm.createContext({
    window,
    document,
    SUPABASE_URL: 'https://fixture.supabase.co',
    SUPABASE_ANON_KEY: 'fixture-anon-key',
    SUPA_AUTH_TOKEN: '',
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const payload = body.op === 'capabilities' ? { ok: true, ...capabilities } : { ok: true, ...result };
      return { ok: true, status: 200, json: async () => payload };
    },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
    TextEncoder,
    Uint8Array,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(source, context, { filename: 'v2-ai-pack-integration.js' });
  window.osiV2AiPackRender({
    public_ref: CASE_REF,
    visibility: 'public',
    submitted_by_wallet: '11111111111111111111111111111112',
    ...caseItem,
  }, capabilities || {}, mode);
  await settle();
  return { html: rootNode.innerHTML, requests, readSessionCalls, window, rootNode };
}

const maliciousPublic = await renderFixture({
  result: {
    viewer_role: 'public',
    packs: [{
      public_ref: 'OSI-AP-PUBLIC',
      pack_type: 'victim',
      versions: [
        {
          version_ref: 'OSI-APV-UNAPPROVED',
          version_no: 3,
          lifecycle_state: 'review_required',
          content_public_brief: 'UNAPPROVED_SENTINEL',
          content_owner_safe: OWNER_ONLY,
          content_analyst_restricted: ANALYST_ONLY,
        },
        {
          version_ref: `OSI-APV-PUBLIC-"${XSS}`,
          version_no: 2,
          lifecycle_state: 'approved',
          created_at: new Date().toISOString(),
          content_public_brief: `Public brief\n${XSS}`,
          content_owner_safe: OWNER_ONLY,
          content_analyst_restricted: ANALYST_ONLY,
          staleness: { public: { stale: true, stale_at: new Date().toISOString(), reason: XSS } },
          confidence_profile: {
            public_verifiability: { label: XSS, basis: XSS },
          },
          reviews: [{ public_rationale: PRIVATE_REVIEW, private_note: PRIVATE_REVIEW }],
        },
      ],
    }],
  },
});
ok('ordinary public viewer uses only the public endpoint', maliciousPublic.readSessionCalls === 0
  && maliciousPublic.requests.some((row) => row.op === 'list_public_case_packs')
  && !maliciousPublic.requests.some((row) => row.op === 'get_case_packs'));
ok('public defense hides unapproved versions and every returned restricted field',
  !maliciousPublic.html.includes('UNAPPROVED_SENTINEL')
  && !maliciousPublic.html.includes(OWNER_ONLY)
  && !maliciousPublic.html.includes(ANALYST_ONLY)
  && !maliciousPublic.html.includes(PRIVATE_REVIEW));
ok('model content, refs, profile values, and stale reasons remain escaped text',
  maliciousPublic.html.includes('&lt;img src=x onerror=&quot;globalThis.__xss=1&quot;&gt;')
  && !maliciousPublic.html.includes('<img')
  && !maliciousPublic.html.includes('onerror="globalThis.__xss=1"'));
ok('public approved brief remains visible without creating an HTML link or executable node',
  maliciousPublic.html.includes('Public brief<br>') && !/<a\b/i.test(maliciousPublic.html));

const missingState = await renderFixture({
  result: {
    viewer_role: 'public',
    packs: [{
      public_ref: 'OSI-AP-MISSING',
      pack_type: 'exchange',
      versions: [{
        version_ref: 'OSI-APV-MISSING',
        version_no: 1,
        lifecycle_state: 'approved',
        content_public_brief: 'Public state fixture.',
        confidence_profile: {},
      }],
    }],
  },
});
ok('missing layer staleness is unavailable rather than silently current',
  missingState.html.includes('Public staleness unavailable')
  && !missingState.html.includes('current at generation'));

const ownerView = await renderFixture({
  wallet: WALLET,
  mode: 'mine',
  capabilities: {
    ai_pack_writes_enabled: true,
    ai_pack_review_writes_enabled: true,
    viewer_role: 'owner',
    can_generate: true,
    analyst_eligible: true,
    generation_prerequisite: null,
  },
  result: {
    viewer_role: 'owner',
    packs: [{
      public_ref: 'OSI-AP-OWNER',
      pack_type: 'victim',
      versions: [{
        version_ref: 'OSI-APV-OWNER',
        version_no: 1,
        lifecycle_state: 'review_required',
        content_public_brief: 'Public owner fixture.',
        content_owner_safe: OWNER_ONLY,
        content_analyst_restricted: ANALYST_ONLY,
        reviews: [{ public_rationale: PRIVATE_REVIEW, private_note: PRIVATE_REVIEW }],
        staleness: { owner_safe: { stale: false } },
        confidence_profile: {},
        can_review_exact_version: true,
      }],
    }],
  },
  caseItem: { submitted_by_wallet: WALLET },
});
ok('proven owner uses the private read-session endpoint', ownerView.readSessionCalls === 1
  && ownerView.requests.some((row) => row.op === 'get_case_packs'));
ok('owner sees owner-safe content but never analyst-restricted content or analyst review detail',
  ownerView.html.includes(OWNER_ONLY)
  && !ownerView.html.includes(ANALYST_ONLY)
  && !ownerView.html.includes(PRIVATE_REVIEW));
ok('Case owner generation stays disabled even if a broad analyst capability is over-returned',
  ownerView.html.includes('Case-owner generation is deferred')
  && /id="osi-ai-pack-generate"[^>]*disabled/.test(ownerView.html));
ok('owner feedback remains visibly advisory and uncounted',
  ownerView.html.includes('Owner advisory feedback')
  && ownerView.html.includes('contributes zero review weight'));

const analystView = await renderFixture({
  wallet: WALLET,
  capabilities: {
    ai_pack_writes_enabled: true,
    ai_pack_review_writes_enabled: true,
    viewer_role: 'analyst',
    can_generate: true,
    analyst_eligible: true,
    maintainer_access: false,
  },
  result: {
    viewer_role: 'analyst',
    packs: [{
      public_ref: 'OSI-AP-ANALYST',
      pack_type: 'law_enforcement',
      versions: [{
        version_ref: 'OSI-APV-ANALYST',
        version_no: 1,
        lifecycle_state: 'review_required',
        content_public_brief: 'Public analyst fixture.',
        content_owner_safe: OWNER_ONLY,
        content_analyst_restricted: `${ANALYST_ONLY}\n${XSS}`,
        confidence_profile: {},
        reviews: [{
          review_public_ref: `OSI-APR-${XSS}`,
          decision: 'support',
          reviewer_wallet: WALLET,
          weight: 1.5,
          public_rationale: XSS,
        }],
        quorum: { approve_count: 1, approve_weight: 1.5, required_count: 2, required_weight: 2.5 },
        can_review_exact_version: false,
        review_prerequisite: `Creator cannot review this version. ${XSS}`,
        can_finalize: false,
        finalize_prerequisite: 'Needs one more independent analyst.',
      }],
    }],
  },
});
ok('analyst can view only the server-authorized restricted layer as escaped text',
  analystView.html.includes(ANALYST_ONLY)
  && analystView.html.includes('&lt;img src=x onerror=&quot;globalThis.__xss=1&quot;&gt;')
  && !analystView.html.includes('<img'));
ok('server-derived exact-version review denial is visible and disables the control',
  analystView.html.includes('Creator cannot review this version.')
  && /id="osi-ai-review-submit"[^>]*disabled/.test(analystView.html));
ok('missing review proof is labeled unavailable rather than verified',
  analystView.html.includes('Proof unavailable')
  && !analystView.html.includes('Wallet-signed and server-verified'));
ok('all returned review strings remain escaped and private note is never rendered',
  !analystView.html.includes('<img') && !analystView.html.includes(PRIVATE_REVIEW));
ok('review note browser cap matches the server and database boundary',
  source.includes('id="osi-ai-review-note" maxlength="4000"')
  && !source.includes('id="osi-ai-review-note" maxlength="8000"'));
ok('terminal generation failure clears only its exact retry idempotency slot',
  source.includes('failure.retryWithNewIdempotencyKey=payload.retry_with_new_idempotency_key===true')
  && source.includes('if(error&&error.retryWithNewIdempotencyKey)clearOperation(operation.slot)'));

const maintainerView = await renderFixture({
  wallet: WALLET,
  capabilities: {
    ai_pack_writes_enabled: true,
    ai_pack_review_writes_enabled: true,
    viewer_role: 'maintainer',
    can_generate: true,
    analyst_eligible: false,
    maintainer_access: true,
  },
  result: {
    viewer_role: 'maintainer',
    packs: [{
      public_ref: 'OSI-AP-MAINTAINER',
      pack_type: 'exchange',
      versions: [{
        version_ref: 'OSI-APV-MAINTAINER',
        version_no: 1,
        lifecycle_state: 'supported',
        content_public_brief: 'Public maintainer fixture.',
        content_owner_safe: 'Owner maintainer fixture.',
        content_analyst_restricted: 'Restricted maintainer fixture.',
        confidence_profile: {},
        staleness: { analyst_restricted: { stale: false } },
        reviews: [],
        quorum: { approve_count: 1, approve_weight: 1.5, required_count: 2, required_weight: 2.5 },
        can_finalize: false,
        finalize_prerequisite: 'Needs one more independent analyst and 1.00 counted weight.',
      }],
    }],
  },
});
ok('maintainer finalization uses the exact server prerequisite and stays disabled',
  maintainerView.html.includes('Needs one more independent analyst and 1.00 counted weight.')
  && /id="osi-ai-approve"[^>]*disabled/.test(maintainerView.html));

ok('retryable signed actions retain one operation and target idempotency record',
  source.includes('function operationRecord(operation,target,payload)')
  && source.includes('state.operationKeys[slot]=current')
  && source.includes('clearOperation(operation.slot)')
  && !source.includes("idempotency_key:randomKey('ai-pack')"));
const approvalBlock = source.slice(source.indexOf('async function approve()'), source.indexOf('function bind()'));
ok('final approval uses the exact class-A Memo transaction path and never signMessage',
  approvalBlock.includes('prepare_approval')
  && approvalBlock.includes('castOnchainVote(prepared.memo)')
  && approvalBlock.includes('commit_approval')
  && approvalBlock.includes('tx_sig:txSig')
  && !approvalBlock.includes('signMessage('));
ok('generation, review, and owner feedback use exact Stage-5 signMessage writes',
  source.includes("exactWrite('prepare_generation','commit_generation'")
  && source.includes("exactWrite('prepare_review','commit_review'")
  && source.includes("exactWrite('prepare_owner_feedback','commit_owner_feedback'"));
ok('render invalidates stale loads synchronously and binds responses to the exact Case',
  /function render\([^)]*\)\{\s*state\.loadToken\+\+/.test(source)
  && source.includes("token===state.loadToken&&ref===caseRef()"));
ok('model output uses the existing mobile-safe wrapping treatment',
  source.includes('<p class="osi-evidence-ref">')
  && source.includes('<b class="osi-evidence-ref">'));
ok('AI Pack browser code contains no service-role credential or console logging',
  !/service[_-]?role/i.test(source) && !/console\s*\./.test(source));
ok('AI Pack user-visible source contains no em dash',
  !/[—]|&mdash;|&#8212;/.test(source));

console.log(`1..${assertions}`);
