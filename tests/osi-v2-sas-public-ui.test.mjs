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

function load(provider) {
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
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: '96-sas-public.js' });
  return { api: context.osiSasVerification, document, elements };
}

let negativeCalls = 0;
const negative = load(async () => {
  negativeCalls += 1;
  return { ok: true, wallet: WALLET, valid: false, state: 'invalid', reason: 'absent', credential: CREDENTIAL, schema: SCHEMA, source: 'live' };
});
const negativeSlot = new FakeElement('span', negative.document);
negativeSlot.setAttribute('data-sas-wallet', WALLET);
await negative.api.decorateSlot(negativeSlot);
ok('badge never renders for a non-verified wallet', negativeCalls === 1 && negativeSlot.children.length === 0);

let positiveCalls = 0;
let requestedPath = '';
let requestedBody = null;
const positive = load(async (path, body) => {
  positiveCalls += 1;
  requestedPath = path;
  requestedBody = body;
  return { ok: true, wallet: WALLET, valid: true, state: 'verified', reason: 'valid', credential: CREDENTIAL, schema: SCHEMA, source: 'live' };
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
  && positiveSlot.children[0].getAttribute('data-sas-badge') === 'verified');

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

console.log(`\n${passed} SAS public UI assertions passed.`);
