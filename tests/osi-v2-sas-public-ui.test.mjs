import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/js/96-sas-public.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const WALLET = '2'.repeat(32);
const CREDENTIAL = '3'.repeat(32);
const SCHEMA = '4'.repeat(32);

let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.children = [];
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.listeners = {};
    this.value = '';
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = String(value);
    }
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; this.textContent = ''; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  querySelectorAll() { return []; }
  scrollIntoView() {}
  focus() {}
}

function textTree(node) {
  return [node.textContent, ...node.children.flatMap((child) => textTree(child))].join(' ');
}

function load(provider, translate) {
  const elements = new Map();
  const document = {
    readyState: 'loading',
    body: {},
    createElement(tagName) { return new FakeElement(tagName, document); },
    getElementById(id) { return elements.get(id) || null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const context = {
    window: null,
    document,
    Promise,
    Object,
    String,
    Array,
    RegExp,
    Error,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    console,
    osiPublicApi: provider,
    osiT: translate,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: '96-sas-public.js' });
  return { api: context.osiSasVerification, document, elements };
}

let negativeCalls = 0;
const negative = load(async () => {
  negativeCalls += 1;
  return { ok: true, wallet: WALLET, valid: false, state: 'invalid', reason: 'absent', credential: CREDENTIAL, schema: SCHEMA, source: 'live', checked_at: '2026-07-28T10:00:00Z' };
});
const negativeSlot = new FakeElement('span', negative.document);
negativeSlot.setAttribute('data-sas-wallet', WALLET);
await negative.api.decorateSlot(negativeSlot);
ok('non-verified analyst state stays visible without inventing authority',
  negativeCalls === 1
  && negativeSlot.children.length === 1
  && negativeSlot.children[0].getAttribute('data-sas-badge') === 'invalid'
  && negativeSlot.children[0].textContent.includes('not verified'));

let positiveCalls = 0;
let requestedPath = '';
let requestedBody = null;
const positive = load(async (path, body) => {
  positiveCalls += 1;
  requestedPath = path;
  requestedBody = body;
  return { ok: true, wallet: WALLET, valid: true, state: 'verified', reason: 'valid', credential: CREDENTIAL, schema: SCHEMA, source: 'live', checked_at: '2026-07-28T10:00:00Z' };
});
const positiveSlot = new FakeElement('span', positive.document);
positiveSlot.setAttribute('data-sas-wallet', WALLET);
await positive.api.decorateSlot(positiveSlot);
ok('badge calls the public sas_verify endpoint through the real client provider',
  positiveCalls === 1
  && requestedPath === 'osi-v2-proof'
  && requestedBody.mode === 'sas_verify'
  && requestedBody.wallet === WALLET);
ok('positive badge uses the existing proof-label class and links to the explanation',
  positiveSlot.children.length === 1
  && positiveSlot.children[0].className === 'osi-proof-label'
  && positiveSlot.children[0].href === '#sas-verifier'
  && positiveSlot.children[0].getAttribute('data-sas-badge') === 'verified'
  && positiveSlot.children[0].textContent.includes('SAS verified')
  && positiveSlot.children[0].textContent.includes('2026'));

const turkish = load(async () => ({
  ok: true, wallet: WALLET, valid: true, state: 'verified', reason: 'valid',
  credential: CREDENTIAL, schema: SCHEMA, source: 'live', checked_at: '2026-07-28T10:00:00Z',
}), (key, variables) => {
  const values = {
    'SAS verified': 'SAS doğrulandı',
    'SAS analyst review authority verified. Last checked {checked}. Read the Solana Attestation Service explanation.':
      'SAS analist inceleme yetkisi doğrulandı. Son kontrol: {checked}. Solana Attestation Service açıklamasını okuyun.',
  };
  return String(values[key] || key).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => String(variables?.[name] ?? `{${name}}`));
});
const turkishSlot = new FakeElement('span', turkish.document);
turkishSlot.setAttribute('data-sas-wallet', WALLET);
await turkish.api.decorateSlot(turkishSlot);
ok('timestamped SAS badge and accessible name follow the active locale',
  turkishSlot.children[0].textContent.includes('SAS doğrulandı')
  && turkishSlot.children[0].getAttribute('aria-label').includes('Son kontrol:')
  && !turkishSlot.children[0].getAttribute('aria-label').includes('Last checked'));

for (const state of ['expired', 'revoked']) {
  const visible = load(async () => ({
    ok: true, wallet: WALLET, valid: false, state, reason: state,
    checked_at: '2026-07-28T10:00:00Z',
  }));
  const slot = new FakeElement('span', visible.document);
  slot.setAttribute('data-sas-wallet', WALLET);
  await visible.api.decorateSlot(slot);
  ok(`${state} SAS state is explicit and never styled as verified`,
    slot.children[0].getAttribute('data-sas-badge') === state
    && slot.children[0].className === 'osi-chip warning'
    && slot.children[0].textContent.toLowerCase().includes(state));
}

let verifierCalls = 0;
const verifier = load(async () => {
  verifierCalls += 1;
  return { ok: true, wallet: WALLET, valid: false, state: 'invalid', reason: 'absent', credential: CREDENTIAL, schema: SCHEMA, source: 'live', checked_at: '2026-07-22T00:00:00Z' };
});
const nodes = {
  input: new FakeElement('input', verifier.document),
  status: new FakeElement('div', verifier.document),
  result: new FakeElement('div', verifier.document),
};
await verifier.api.verifyPublicWallet(WALLET, nodes);
ok('public verifier handles a wallet with no credential as a neutral result',
  verifierCalls === 1
  && !nodes.status.className.includes('error')
  && nodes.status.textContent.startsWith('Not verified.')
  && !textTree(nodes.result).includes('current OSI review authority'));
ok('no-credential result exposes configured Credential and Schema explorer links without inventing a badge',
  nodes.result.children.some((child) => child.className === 'osi-about-actions')
  && !nodes.result.children.some((child) => child.getAttribute && child.getAttribute('data-sas-badge') === 'verified'));

ok('SAS visibility introduces no stylesheet and reuses existing badge, form, and button classes',
  index.includes('./assets/js/96-sas-public.js')
  && !index.includes('sas-public.css')
  && source.includes("badge.className='osi-proof-label'")
  && index.includes('class="fo-in" id="sas-verifier-wallet"')
  && index.includes('class="osi-button osi-button-secondary" type="submit"')
  && !/createElement\(['"]style['"]\)|<style|rel=['"]stylesheet['"]/.test(source));
ok('pending and unavailable states remain explicit and fail closed',
  source.includes("badgeFor(slot,null,'pending_verification')")
  && source.includes("badgeFor(slot,null,'unavailable')")
  && source.includes('SAS verification pending')
  && source.includes('SAS unavailable \\u00b7 no authority counted'));

console.log(`\n${passed} SAS public UI assertions passed.`);
