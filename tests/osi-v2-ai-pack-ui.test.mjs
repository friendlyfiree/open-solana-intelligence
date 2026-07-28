import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = join(import.meta.dirname, '..');
const source = readFileSync(join(root, 'assets/js/v2-ai-pack-integration.js'), 'utf8');
const CASE_REF = 'OSI-C-AI-PACK-UI-0001';
const WALLET = '11111111111111111111111111111111';
const XSS = '<img src=x onerror="globalThis.__xss=1">';

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
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function fixture({ capabilities, exactCapabilities, result, wallet = WALLET }) {
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
    SUPA_AUTH_TOKEN: 'fixture-maintainer-session',
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const payload = body.op === 'capabilities'
        ? { ok: true, ...exactCapabilities }
        : { ok: true, ...result };
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
  const markup = window.osiV2AiPackRender({
    public_ref: CASE_REF,
    visibility: 'public',
    submitted_by_wallet: '11111111111111111111111111111112',
  }, capabilities || {}, 'public');
  await settle();
  return { markup, html: rootNode.innerHTML, requests, readSessionCalls, window, rootNode };
}

for (const denied of [
  { name: 'anonymous', wallet: '', caps: {} },
  { name: 'Case owner', caps: { ai_pack_access_mode: 'maintainer_only', viewer_role: 'owner', maintainer_access: false } },
  { name: 'verified analyst', caps: { ai_pack_access_mode: 'maintainer_only', viewer_role: 'analyst', maintainer_access: false } },
  { name: 'probationary analyst', caps: { ai_pack_access_mode: 'maintainer_only', viewer_role: 'analyst', analyst_eligible: false, maintainer_access: false } },
  { name: 'wallet-only half-maintainer', caps: { ai_pack_access_mode: 'maintainer_only', viewer_role: 'public', maintainer_access: false } },
  { name: 'auth-only half-maintainer', wallet: '', caps: { ai_pack_access_mode: 'maintainer_only', viewer_role: 'public', maintainer_access: false } },
]) {
  const view = await fixture({ capabilities: denied.caps, wallet: denied.wallet ?? WALLET });
  ok(`${denied.name} sees no AI Pack surface and triggers no provider-facing read`,
    view.markup === '' && view.requests.length === 0 && view.readSessionCalls === 0);
}

const maintainer = await fixture({
  capabilities: {
    ai_pack_access_mode: 'maintainer_only',
    ai_pack_writes_enabled: true,
    ai_pack_review_writes_enabled: false,
    viewer_role: 'maintainer',
    maintainer_access: true,
    can_generate: true,
  },
  exactCapabilities: {
    ai_pack_access_mode: 'maintainer_only',
    ai_pack_writes_enabled: true,
    ai_pack_review_writes_enabled: false,
    viewer_role: 'maintainer',
    maintainer_access: true,
    can_generate: true,
    provider_configured: true,
  },
  result: {
    viewer_role: 'maintainer',
    packs: [{
      public_ref: 'OSI-AP-MAINTAINER',
      pack_type: 'exchange',
      versions: [{
        version_ref: `OSI-APV-${XSS}`,
        version_no: 1,
        lifecycle_state: 'draft',
        created_at: new Date().toISOString(),
        content_public_brief: `Public layer\n${XSS}`,
        content_owner_safe: `Owner-safe layer\n${XSS}`,
        content_analyst_restricted: `Restricted layer\n${XSS}`,
        confidence_profile: {
          public_verifiability: { label: XSS, basis: XSS },
        },
        reviews: [{ public_rationale: 'MUST_NOT_RENDER_IN_PRIVATE_MODE' }],
      }],
    }],
  },
});
ok('full maintainer gets the private workspace and exact capability refresh',
  maintainer.markup.includes('Maintainer-only AI Pack')
    && maintainer.requests.filter((row) => row.op === 'capabilities').length === 1);
ok('full maintainer uses one scoped private read session and no public discovery endpoint',
  maintainer.readSessionCalls === 1
    && maintainer.requests.filter((row) => row.op === 'get_case_packs').length === 1
    && !maintainer.requests.some((row) => /^list_public/.test(String(row.op))));
ok('private draft generation is visible and review, feedback, approval, and publication controls are absent',
  maintainer.html.includes('Generate a maintainer-only immutable draft')
    && maintainer.html.includes('Private draft only')
    && !maintainer.html.includes('osi-ai-review-submit')
    && !maintainer.html.includes('osi-ai-feedback-submit')
    && !maintainer.html.includes('osi-ai-approve')
    && !maintainer.html.includes('MUST_NOT_RENDER_IN_PRIVATE_MODE'));
ok('all returned model content, references, and confidence values remain escaped text',
  maintainer.html.includes('&lt;img src=x onerror=&quot;globalThis.__xss=1&quot;&gt;')
    && !maintainer.html.includes('<img')
    && !maintainer.html.includes('onerror="globalThis.__xss=1"'));
ok('missing layer freshness is unavailable rather than invented as current',
  maintainer.html.includes('staleness unavailable')
    && !maintainer.html.includes('current at last server check'));
ok('maintainer-only copy describes a private artifact and rejects verdict authority',
  maintainer.markup.includes('Private artifact, not verdict')
    && maintainer.markup.includes('stores drafts privately')
    && maintainer.html.includes('does not calculate an accuracy'));
ok('retryable generation retains one exact operation and idempotency record',
  source.includes('function operationRecord(operation,target,payload)')
    && source.includes('state.operationKeys[slot]=current')
    && source.includes("exactWrite('prepare_generation','commit_generation'"));
ok('private reads are constrained to the AI Pack detail read-session scope',
  source.includes("window.osiV2ReadSession(['aipack:detail']")
    && source.includes("caps.ai_pack_access_mode==='maintainer_only'")
    && source.includes('caps.maintainer_access===true'));
ok('browser source contains neither service-role material nor logging',
  !/service[_-]?role/i.test(source) && !/console\s*\./.test(source));
ok('clearing the Case invalidates pending loads and wipes private content',
  source.includes('state.loadToken++') && source.includes('root.replaceChildren()'));
ok('AI Pack user-visible source contains no em dash',
  !/[â€”]|&mdash;|&#8212;/.test(source));

console.log(`1..${assertions}`);
