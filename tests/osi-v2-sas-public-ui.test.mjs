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
// The credential's wording never borrows "verified", which is an analyst
// tier: a missing credential reads as missing review authority.
ok('non-verified analyst state stays visible without inventing authority',
  negativeCalls === 1
  && negativeSlot.children.length === 1
  && negativeSlot.children[0].getAttribute('data-sas-badge') === 'invalid'
  && negativeSlot.children[0].textContent.startsWith('No current SAS review authority')
  && !/verified/i.test(negativeSlot.children[0].textContent));

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
  && positiveSlot.children[0].textContent.startsWith('SAS review authority · checked ')
  && positiveSlot.children[0].textContent.includes('2026'));
// HA-25: the same wallet's tier can be "Probationary analyst", so the badge
// names what the credential is and never says "verified" in visible text or
// in its accessible name. The attribute keeps the verifier's state code.
ok('positive badge describes on-chain review authority, not a verified tier',
  !/verified/i.test(positiveSlot.children[0].textContent)
  && !/verified/i.test(positiveSlot.children[0].getAttribute('aria-label'))
  && positiveSlot.children[0].getAttribute('aria-label').includes('separate from the analyst tier')
  && positiveSlot.children[0].getAttribute('aria-label').startsWith('Current on-chain SAS review authority.'));

const turkish = load(async () => ({
  ok: true, wallet: WALLET, valid: true, state: 'verified', reason: 'valid',
  credential: CREDENTIAL, schema: SCHEMA, source: 'live', checked_at: '2026-07-28T10:00:00Z',
}), (key, variables) => {
  const values = {
    'SAS review authority · checked {checked}': 'SAS inceleme yetkisi · kontrol: {checked}',
    'Current on-chain SAS review authority. Last checked {checked}. This is separate from the analyst tier. Read the Solana Attestation Service explanation.':
      'Güncel zincir üstü SAS inceleme yetkisi. Son kontrol: {checked}. Bu, analist kademesinden ayrıdır. Solana Attestation Service açıklamasını okuyun.',
  };
  return String(values[key] || key).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => String(variables?.[name] ?? `{${name}}`));
});
const turkishSlot = new FakeElement('span', turkish.document);
turkishSlot.setAttribute('data-sas-wallet', WALLET);
await turkish.api.decorateSlot(turkishSlot);
ok('timestamped SAS badge and accessible name follow the active locale',
  turkishSlot.children[0].textContent.startsWith('SAS inceleme yetkisi · kontrol: ')
  && !/doğrula/i.test(turkishSlot.children[0].textContent)
  && turkishSlot.children[0].getAttribute('aria-label').includes('Son kontrol:')
  && turkishSlot.children[0].getAttribute('aria-label').includes('kademesinden ayrıdır')
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
  && nodes.status.textContent.startsWith('No current SAS review authority.')
  && !/verified\b/i.test(nodes.status.textContent.replace('OSI_VERIFIED_ANALYST', ''))
  && textTree(nodes.result).includes('State: Invalid.')
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
ok('checking, pending and unavailable states remain explicit and fail closed',
  source.includes("badgeFor(slot,null,'checking')")
  && source.includes("badgeFor(slot,null,'unavailable')")
  && source.includes('SAS check pending')
  && source.includes('Live SAS check unavailable'));

// The badge's own read in flight is not a credential state, and a failed
// client read says nothing about whether a review counted: only the server's
// authority record decides that.
const slow = load(() => new Promise(() => {}));
const slowSlot = new FakeElement('span', slow.document);
slowSlot.setAttribute('data-sas-wallet', WALLET);
slow.api.decorateSlot(slowSlot);
ok('a badge still reading shows a neutral checking state, not a warning',
  slowSlot.children.length === 1
  && slowSlot.children[0].getAttribute('data-sas-badge') === 'checking'
  && slowSlot.children[0].className === 'osi-chip'
  && !/pending|verified|counted/i.test(slowSlot.children[0].textContent));
const failing = load(async () => { throw new Error('network'); });
const failingSlot = new FakeElement('span', failing.document);
failingSlot.setAttribute('data-sas-wallet', WALLET);
await failing.api.decorateSlot(failingSlot);
ok('a failed live read states only that the live check is unavailable',
  failingSlot.children[0].getAttribute('data-sas-badge') === 'unavailable'
  && failingSlot.children[0].textContent === 'Live SAS check unavailable'
  && !/counted|authority/i.test(failingSlot.children[0].textContent));

// HA-25 wording pass. A positive public verifier answer names the credential
// as current review authority; the visible copy never calls it "verified".
let positiveVerifierCalls = 0;
const positiveVerifier = load(async () => {
  positiveVerifierCalls += 1;
  return { ok: true, wallet: WALLET, valid: true, state: 'verified', reason: 'valid', credential: CREDENTIAL, schema: SCHEMA, source: 'live', checked_at: '2026-07-28T10:00:00Z' };
});
const positiveNodes = {
  input: new FakeElement('input', positiveVerifier.document),
  status: new FakeElement('div', positiveVerifier.document),
  result: new FakeElement('div', positiveVerifier.document),
};
const positiveAnswer = await positiveVerifier.api.verifyPublicWallet(WALLET, positiveNodes);
ok('positive verifier answer reads as current review authority, never as a verified tier',
  positiveVerifierCalls === 1
  && positiveAnswer && positiveAnswer.valid === true
  && positiveNodes.status.className.includes('success')
  && positiveNodes.status.textContent.startsWith('Current SAS review authority: ')
  && positiveNodes.status.textContent.includes('OSI_VERIFIED_ANALYST')
  && !/verified\b/i.test(positiveNodes.status.textContent.replace('OSI_VERIFIED_ANALYST', '')));

// A failed verifier read is an error, offers no badge, and still avoids the
// tier word.
const brokenVerifier = load(async () => { throw new Error('network'); });
const brokenNodes = {
  input: new FakeElement('input', brokenVerifier.document),
  status: new FakeElement('div', brokenVerifier.document),
  result: new FakeElement('div', brokenVerifier.document),
};
const brokenAnswer = await brokenVerifier.api.verifyPublicWallet(WALLET, brokenNodes);
ok('an unavailable verifier shows no review authority badge and no verified wording',
  brokenAnswer === null
  && brokenNodes.status.className.includes('error')
  && brokenNodes.status.textContent === 'The verifier is temporarily unavailable. No review authority badge is shown.'
  && !/verified/i.test(brokenNodes.status.textContent));

// An invalid wallet never reaches the verifier and is not described in
// credential words at all.
let invalidWalletCalls = 0;
const invalidWallet = load(async () => { invalidWalletCalls += 1; return { ok: true }; });
const invalidNodes = {
  input: new FakeElement('input', invalidWallet.document),
  status: new FakeElement('div', invalidWallet.document),
  result: new FakeElement('div', invalidWallet.document),
};
await invalidWallet.api.verifyPublicWallet('not-a-wallet', invalidNodes);
ok('a malformed wallet is refused before any verifier call',
  invalidWalletCalls === 0
  && invalidNodes.status.textContent === 'Enter a valid Solana wallet address.'
  && invalidNodes.input.getAttribute('aria-invalid') === 'true');

// Pending and invalid credential chips keep their state codes but use the
// review-authority vocabulary.
for (const [state, expected] of [['pending_verification', 'SAS check pending'], ['invalid', 'No current SAS review authority']]) {
  const chip = load(async () => ({ ok: true, wallet: WALLET, valid: false, state, reason: 'absent', checked_at: '2026-07-28T10:00:00Z' }));
  const slot = new FakeElement('span', chip.document);
  slot.setAttribute('data-sas-wallet', WALLET);
  await chip.api.decorateSlot(slot);
  ok(`${state} chip keeps its state code and avoids the tier word`,
    slot.children[0].getAttribute('data-sas-badge') === state
    && slot.children[0].className === 'osi-chip warning'
    && slot.children[0].textContent.startsWith(expected)
    && !/verified/i.test(slot.children[0].textContent));
}

ok('the old "SAS verified" badge wording is gone from the badge source',
  !source.includes("tr('SAS verified')")
  && !source.includes('SAS invalid / not verified')
  && !source.includes('No verified badge is shown'));

// The About section states the separation once, in plain words, next to the
// verifier, and keeps the credential identifier unchanged.
const aboutStart = index.indexOf('id="sas-verifier"');
const aboutEnd = index.indexOf('</section>', aboutStart);
const about = index.slice(aboutStart, aboutEnd);
ok('About SAS separates tier from on-chain review authority in one plain sentence',
  aboutStart > 0
  && about.includes('Tier and on-chain review authority are separate. A probationary analyst can hold a current SAS credential; the tier, not the credential, sets how much a review weighs.')
  && about.includes('<code translate="no">OSI_VERIFIED_ANALYST</code>')
  && !about.includes('OSI verified analyst credential')
  && !/\u2014/.test(about));

console.log(`\n${passed} SAS public UI assertions passed.`);
