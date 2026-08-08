// Regression cover for the defects found by walking every tab, sub-tab, drawer
// and modal of the shipped page against production data. Each check pins the
// exact fault that was observed, so a later edit cannot quietly restore it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file), 'utf8');

const index = read('index.html');
const i18n = read('assets/js/03-i18n.js');
const wallet = read('assets/js/60-wallet-workspace.js');
const navigation = read('assets/js/94-navigation-shell.js');
const sas = read('assets/js/96-sas-public.js');
const caseUi = read('assets/js/v2-case-integration.js');
const wireUi = read('assets/js/v2-wire-integration.js');
const analystUi = read('assets/js/v2-analyst-integration.js');
const recordsUi = read('assets/js/84-public-records.js');
const proofUi = read('assets/js/44-prooflog-deck.js');

const sections = read('assets/css/20-sections.css');
const views = read('assets/css/30-views.css');
const polish = read('assets/css/60-final-polish.css');
const redesign = read('assets/css/70-intelligence-redesign.css');
const activation = read('assets/css/v2-activation.css');
const caseCss = read('assets/css/v2-case-integration.css');

let passed = 0;
function ok(name, value) {
  if (!value) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}

// ── Dead controls ───────────────────────────────────────────────────────────
ok('the Analyst Network keeps its "Open My Applications" route reachable',
  index.includes('onclick="osiAnalystOpenWorkspace(\'applications\')">Open My Applications</button>')
    && !/#analysts \.lb-cta\.ghost[^\n{]*\{\s*display:\s*none/.test(polish));
ok('a ghost analyst CTA does not carry the filled button glow',
  polish.includes('.lb-cta:not(.ghost){box-shadow'));

// ── Stuck states ────────────────────────────────────────────────────────────
ok('the Wire review queue owns its own loading and failure states',
  wireUi.includes("host.innerHTML='<div class=\"osi-v2-skeleton\"></div><div class=\"osi-v2-skeleton\"></div>'")
    && wireUi.includes('Wire review queue locked')
    && wireUi.includes('osiV2RefreshWireQueue')
    && wireUi.includes('window.osiV2RefreshWireQueue='));
ok('a locked or unavailable Wire queue always offers a way back to the public feed',
  (wireUi.match(/onclick="wireOpenPublic\(\)">Back to public Wire<\/button>/g) || []).length >= 3);
ok('the recovery control row is styled',
  caseCss.includes('.osi-wire-queue-recover{') && activation.includes('.osi-workspace-recover{'));

// ── Machine codes never reach the reader ────────────────────────────────────
ok('the review queue translates a refused lane instead of printing its code',
  caseUi.includes('function laneReasonMessage(reason)')
    && caseUi.includes('laneReasonMessage(result.reason)')
    && !caseUi.includes("result.reason||t('Full maintainer access is required for this lane.')"));
ok('an unmapped lane code falls back to the neutral sentence',
  caseUi.includes("return /^[a-z0-9_]+$/.test(code)?t('This lane is not available to the current role.'):code;"));

// ── Analyst workspace keeps its chrome ──────────────────────────────────────
ok('the analyst workspace loading, locked and failed states keep the workspace header',
  analystUi.includes('function workspaceShell(bodyHtml)')
    && (analystUi.match(/workspaceShell\(/g) || []).length >= 4);

// ── The address bar never contradicts the view ──────────────────────────────
ok('showView keeps the hash in step with the rendered view',
  wallet.includes("window.osiSyncRouteForView(v)")
    && navigation.includes('function syncRouteForView(view)')
    && navigation.includes('window.osiSyncRouteForView = syncRouteForView;'));
ok('the route sync replaces instead of pushing, so it invents no history entry',
  /function syncRouteForView[\s\S]*?window\.history\.replaceState/.test(navigation)
    && !/function syncRouteForView[\s\S]*?window\.history\.pushState/.test(navigation.slice(navigation.indexOf('function syncRouteForView'), navigation.indexOf('function navigate'))));
ok('a Case or profile route is never flattened into a view hash',
  /function syncRouteForView[\s\S]*?if \(caseRouteRef\(hash\) \|\| profileRoute\(hash\) \|\| walletProfileRoute\(hash\)\) return;/.test(navigation));
ok('a profile address carries a public identifier and nothing else',
  /function profileRoute\(hash\)[\s\S]*?hash === 'maintainer' \|\| \/\^analyst\\\/\[A-Za-z0-9_\]\{2,32\}\$\/\.test\(hash\)/.test(navigation)
    && analystUi.includes("/^analyst\\/([A-Za-z0-9_]{2,32})$/")
    && analystUi.includes("window.osiOpenAnalystByHandle=openProfileByHandle;"));
ok('navigate still owns its own history entry',
  navigation.includes('suppressRouteSync = true')
    && navigation.includes('suppressRouteSync = false')
    && navigation.includes('window.history.pushState({ osiView: target }'));

// ── Verification honesty ────────────────────────────────────────────────────
ok('a verified SAS answer is cleared as soon as the wallet field changes',
  sas.includes("walletInput.addEventListener('input'")
    && /walletInput\.addEventListener\('input'[\s\S]*?clearNode\(nodes\.result\)/.test(sas));

// ── Layout faults ───────────────────────────────────────────────────────────
ok('analyst weight and proof values line up with their right-aligned headers',
  activation.includes('#analysts .osi-analyst-row>*:nth-child(5)')
    && activation.includes('#analysts .osi-analyst-row>*:nth-child(6){text-align:right}'));
ok('the record status pill stays one box when its label wraps',
  /\.cr-status\{display:inline-flex/.test(sections));
ok('the Public Records toolbar declares its rows instead of wrapping by accident',
  sections.includes('grid-template-areas:"search sort" "filters filters"'));
ok('the Operations Center shares the site gutter and centres its signed-out gate',
  views.includes('#admin-view .wrap{max-width:none;width:100%;padding-left:32px;padding-right:32px}')
    && views.includes('.adm-wrap{width:100%;max-width:1280px;margin:0 auto}')
    && views.includes('#admLogin,#admLocked{display:flex;justify-content:center'));
ok('the public SAS verifier inherits its own card typography',
  redesign.includes('#sas-verifier-form > p {')
    && redesign.includes('#sas-verifier-form .osi-form-status:empty {'));
ok('the analyst application consent reads as a sentence, not a field label',
  activation.includes('.osi-analyst-form .osi-report-safety>span{')
    && /\.osi-analyst-form \.osi-report-safety>span\{[^}]*text-transform:none/.test(activation));
ok('the four analyst reference cards end on one line when the roster is short',
  /nth-last-child\(-n \+ 2\)\) \.lb-aside \{[\s\S]*?align-items: stretch;/.test(redesign));

// ── Recorded values are not an empty state ──────────────────────────────────
ok('the passport identity record uses labelled rows, not the dashed empty box',
  wallet.includes('class="identity-record"')
    && wallet.includes('identity-record-row')
    && !/identity-mini-grid"><div class="identity-empty">Display name/.test(wallet)
    && views.includes('.identity-record-row{'));
ok('a confirmed analyst roster answer renders as a state, not as an empty result',
  wallet.includes('class="identity-note') && views.includes('.identity-note.is-verified{'));

// ── Turkish ─────────────────────────────────────────────────────────────────
ok('the Turkish dictionary holds no conflicting duplicate key', (() => {
  const start = i18n.indexOf('var turkish = {');
  const body = i18n.slice(start);
  const re = /^ {4}'((?:[^'\\]|\\.)*)':\s*'((?:[^'\\]|\\.)*)',?\s*$/gm;
  const map = new Map();
  let m;
  while ((m = re.exec(body))) {
    if (!map.has(m[1])) map.set(m[1], new Set());
    map.get(m[1]).add(m[2]);
  }
  return [...map.values()].every((values) => values.size === 1);
})());
ok('the record, action and analyst counts go through the locale API',
  recordsUi.includes("crT(reports.length===1?'Showing {from}-{to} of {total} record'")
    && proofUi.includes("plT(evs.length===1?'Showing {from}-{to} of {total} action'")
    && analystUi.includes("t('{count} analysts',{count:0})"));
ok('the count helpers are declared at module scope, not inside another function',
  /^function plT\(key,variables\)/m.test(proofUi) && /^function crT\(key,variables\)/m.test(recordsUi));
ok('Turkish covers the copy that walking the product in TR found untranslated',
  ["'Status': 'Durum'",
    "'Sealed outcomes only'",
    "'Evidence not indexed'",
    "'No open challenges'",
    "'Connect a wallet to open your passport'",
    "'Sign in with the authority account'",
    "'Wire review queue locked'",
    "'Back to public Wire'",
    "'Choose a unique handle and short public bio; expertise is optional.'",
    "'{count} analysts'",
    "'Showing {from}-{to} of {total} records'"].every((key) => i18n.includes(key)));

console.log(`\n${passed} surface walkthrough checks passed.`);
