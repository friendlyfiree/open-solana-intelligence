import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let passed = 0;
function ok(name, condition){
  if(!condition) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}

const wireSource = readFileSync(new URL('../assets/js/40-wire-field.js', import.meta.url), 'utf8');
const functionalSurfaceSource = readFileSync(new URL('../assets/js/88-functional-surface.js', import.meta.url), 'utf8');
const wireHost = { innerHTML:'', querySelectorAll:()=>[] };
const wireStatsHost = { innerHTML:'' };
let wireRowsMode = 'pending';
let releaseRows;
const pendingRows = new Promise((resolve)=>{ releaseRows = resolve; });
const wireContext = {
  window:null,
  document:{
    getElementById:(id)=>id==='wire-cases' ? wireHost : (id==='wire-stats' ? wireStatsHost : null),
    querySelectorAll:()=>[],
  },
  console,
  Promise,
  Date,
  setInterval:()=>1,
  clearInterval:()=>{},
  SUPA_ON:true,
  OSI_SUPPORT_WALLET:'',
  supaGet:async()=>{
    if(wireRowsMode==='pending') return pendingRows;
    if(wireRowsMode==='error') throw new Error('source unavailable');
    return [];
  },
  short:(value)=>String(value).slice(0,4),
  escapeHtml:(value)=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'),
  lsGet:()=>({}),
  hydrateBoosts:()=>{},
};
wireContext.window = wireContext;
wireContext.CASE_STUDIES = [];
vm.createContext(wireContext);
vm.runInContext(wireSource, wireContext);

const firstRender = wireContext.renderWire();
ok('The Wire exposes an explicit loading state before its source resolves', wireHost.innerHTML.includes('Opening the live wire'));
releaseRows([]);
await firstRender;
ok('an available source with zero rows renders the genuine empty state without a dormant intake control', wireHost.innerHTML.includes('The wire is quiet') && wireHost.innerHTML.includes('Native Wire intake remains unavailable') && !wireHost.innerHTML.includes('wireOpenForm'));

wireRowsMode = 'error';
await wireContext.renderWire();
ok('a source failure is distinct from empty and offers a real retry action', wireHost.innerHTML.includes('temporarily unavailable') && wireHost.innerHTML.includes('class="wire-retry"') && wireHost.innerHTML.includes('onclick="renderWire()"') && !wireHost.innerHTML.includes('The wire is quiet'));
ok('functional-surface intake locking does not disable the live-source retry', !functionalSurfaceSource.includes('.wire-retry'));

const unattributed = vm.runInContext("wireCard({id:'wire-1',subject:'Public evidence',body:'Exact evidence only',premium:false,created_at:'2026-01-01'})", wireContext);
ok('missing author attribution is labeled honestly instead of inventing an analyst', unattributed.includes('source not attributed') && !unattributed.includes('by analyst'));
ok('Wire interest uses the dedicated stateful action hook', unattributed.includes('data-wire-interest') && unattributed.includes('stakeBoost(this)'));

const supportSource = readFileSync(new URL('../assets/js/70-support-transfer.js', import.meta.url), 'utf8');
const saved = {};
let providerCalls = 0;
let effects = 0;
const countNode = { textContent:'0' };
const titleNode = { textContent:'Exact public dispatch' };
const appended = [];
const button = {
  dataset:{}, disabled:false, textContent:'Signal interest', style:{},
  parentElement:{ appendChild:(node)=>appended.push(node) },
  closest:()=>card,
};
const card = {
  dataset:{ bid:'wire-1' },
  querySelector:(selector)=>{
    if(selector==='.btn-stake, [data-wire-interest]') return button;
    if(selector==='.b-target') return titleNode;
    if(selector==='.b-reward .n') return countNode;
    if(selector==='.boost-tx') return null;
    return null;
  },
};
const supportContext = {
  window:null,
  document:{ addEventListener:()=>{}, querySelector:()=>null, querySelectorAll:()=>[], getElementById:()=>null, createElement:()=>({ className:'', style:{}, innerHTML:'' }) },
  console,
  Promise,
  Date,
  TextEncoder,
  URLSearchParams,
  encodeURIComponent,
  setTimeout,
  clearTimeout,
  SUPA_ON:false,
  SOL_PRICE:null,
  RPC_FALLBACKS:[],
  walletPubkey:'wallet-1',
  lsGet:(key, fallback)=>saved[key] || fallback,
  lsSet:(key, value)=>{ saved[key] = value; },
  withOnchainVote:async(_label, _memo, onSuccess)=>{
    providerCalls += 1;
    await new Promise((resolve)=>setTimeout(resolve, 0));
    await onSuccess('wire-transaction-signature');
  },
  recordOnchainEvent:()=>{ effects += 1; },
  hydrateBoosts:()=>{},
};
supportContext.window = supportContext;
vm.createContext(supportContext);
vm.runInContext(supportSource, supportContext);

await Promise.all([supportContext.stakeBoost(button), supportContext.stakeBoost(button)]);
ok('concurrent first interest clicks request exactly one provider transaction approval', providerCalls===1);
ok('successful interest marks the actual Wire button complete and disabled', button.disabled===true && button.dataset.signalState==='complete' && button.textContent.includes('Boosted'));
ok('successful interest produces one count increment and one recorded effect', String(countNode.textContent)==='1' && effects===1 && saved.stw_boosted['wire-1'].tx==='wire-transaction-signature');

await supportContext.stakeBoost(button);
ok('a second click after success performs zero additional provider calls or effects', providerCalls===1 && effects===1 && String(countNode.textContent)==='1');

button.disabled = false;
button.dataset.signalState = 'idle';
button.textContent = 'Signal interest';
card.dataset.bid = 'wire-2';
supportContext.withOnchainVote = async()=>{ providerCalls += 1; throw new Error('unexpected provider failure'); };
let rejected = false;
try{ await supportContext.stakeBoost(button); }catch(_error){ rejected = true; }
ok('an unexpected provider failure restores the action for a deliberate retry', rejected && button.disabled===false && button.dataset.signalState==='idle' && button.textContent==='Signal interest');

console.log(`\n${passed} Wire integrity checks passed.`);
