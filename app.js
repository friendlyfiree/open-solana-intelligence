// RPC endpoints, Helius (fast & reliable, primary), public RPC as automatic fallback.
// NOTE: this key is visible in the page source, that's unavoidable for a static
// site. Protect it by locking allowed domains in your Helius dashboard.
const HELIUS_RPC = "https://mainnet.helius-rpc.com/?api-key=6cb1f3a8-f0cc-404b-a403-37afd1f3f427";
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const SOL_RPC = HELIUS_RPC; // primary for balance reads

// getBalance with automatic fallback: try Helius first, then the public RPC.
async function rpcGetBalance(addr){
  const body = JSON.stringify({jsonrpc:"2.0",id:1,method:"getBalance",params:[addr]});
  for(const url of [HELIUS_RPC, PUBLIC_RPC]){
    try{
      const res = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body});
      const j = await res.json();
      if(j && j.result && typeof j.result.value === 'number') return j.result.value;
    }catch(e){ /* fall through to next endpoint */ }
  }
  throw new Error('balance unavailable');
}
const fmt = n => n>=1e6 ? (n/1e6).toFixed(2)+"M" : n>=1e3 ? (n/1e3).toFixed(1)+"K" : n.toLocaleString();
const fmtFull = n => Math.round(n).toLocaleString();
const short = a => a.slice(0,4)+"…"+a.slice(-4);

let SOL_PRICE = 0;

function render(){
  const host = document.getElementById('companies');
  let totalWallets=0, totalDeclared=0;

  const DATA = window.TREASURY_DATA;
  if(!DATA || !DATA.companies){
    host.innerHTML = '<div class="method-note" style="text-align:center;padding:28px">Company data (<b>data.js</b>) didn\'t load. Make sure <b>data.js</b> is deployed in the same folder as index.html.</div>';
    return;
  }

  DATA.companies.forEach((c,i)=>{
    totalWallets += c.wallets.length;
    totalDeclared += c.declaredSOL;

    const walletRows = c.wallets.map(w=>{
      const conf = w.confidence || (c.confidence==='high'?'high':'');
      const dot = conf ? `<span class="wv ${conf}"></span>` : '';
      return `<div class="w">
        <div class="w-main">
          <div class="w-addr">${dot}<span class="a">${w.addr}</span>
            <button class="copy" onclick="copyAddr(this,'${w.addr}')" title="Copy address">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
          </div>
          <div class="w-type">${w.type}</div>
        </div>
        <div class="w-bal">
          <div class="b loading" data-addr="${w.addr}">····</div>
          <div class="l">SOL</div>
        </div>
      </div>`;
    }).join('');

    const sourceRows = (c.sources&&c.sources.length)
      ? c.sources.map(s=>`<a href="${s.url}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>${s.label}</a>`).join('')
      : `<div class="method-note">Source links to be added.</div>`;

    const timelineRows = c.timeline.map(t=>`<div class="e"><span class="d">${t.date}</span><span class="ev">${t.event}</span></div>`).join('');

    const valPills = c.validators.length
      ? `<div class="row"><span class="lbl">Validators</span><div class="pills">${c.validators.map(v=>`<span class="pill val">${v}</span>`).join('')}</div></div>` : '';

    const card = document.createElement('div');
    card.className='co';
    card.innerHTML = `
      <div class="co-top" onclick="toggleCo(this)">
        <div class="co-id">
          <span class="rank">#${String(i+1).padStart(2,'0')}</span>
          <div class="co-name">
            <div class="nm">${c.name}<span class="ticker">${c.exchange}: ${c.ticker}</span>
              <span class="src-badge ${c.source}">${c.source==='independent'?'◆ Original attribution':(c.source==='community'?'◈ Community-sourced':'◇ Publicly labeled')}</span>
            </div>
            <div class="meta">
              <span><b>${c.wallets.length}</b> wallets</span>
              <span><b>${c.custodians.join(' · ')}</b></span>
              ${c.avgCost?`<span>avg <b>$${c.avgCost}</b>/SOL</span>`:''}
            </div>
          </div>
        </div>
        <div class="co-fig">
          <div class="amt">
            <div class="n">${fmt(c.declaredSOL)}</div>
            <div class="u">SOL DECLARED</div>
          </div>
          <div class="exp"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg></div>
        </div>
      </div>
      <div class="co-body">
        <div class="co-summary">${c.summary}</div>
        <div class="co-grid">
          <div class="panel left">
            <h4>Attributed wallets <span class="count">${c.wallets.length} addresses · live balances</span></h4>
            <div class="wallets">${walletRows}</div>
            <div class="method-note">Full attribution methodology for this entity will be published here.</div>
          </div>
          <div class="panel">
            <h4>Profile</h4>
            <div class="kv">
              <div class="row"><span class="lbl">Custodians</span><div class="pills">${c.custodians.map(x=>`<span class="pill">${x}</span>`).join('')}</div></div>
              ${valPills}
              <div class="row"><span class="lbl">Acquisition timeline</span><div class="tl">${timelineRows}</div></div>
              <div class="row"><span class="lbl">Public sources</span><div class="srcs">${sourceRows}</div></div>
            </div>
          </div>
        </div>
      </div>`;
    host.appendChild(card);
  });

  document.getElementById('s-wal').textContent = totalWallets;
  document.getElementById('s-sol').textContent = fmt(totalDeclared);
  window.__declared = totalDeclared;
}

function toggleCo(el){
  const card = el.closest('.co');
  const wasOpen = card.classList.contains('open');
  card.classList.toggle('open');
  if(!wasOpen) loadBalances(card);
}

function copyAddr(btn,addr){
  navigator.clipboard.writeText(addr).then(()=>{
    const orig = btn.innerHTML;
    btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="#14f195" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';
    setTimeout(()=>btn.innerHTML=orig,1200);
  });
}

// fetch live balances for a card's wallets via Solana RPC
async function loadBalances(card){
  const els = card.querySelectorAll('.w-bal .b[data-addr]');
  for(const el of els){
    if(el.dataset.done) continue;
    const addr = el.dataset.addr;
    try{
      const lamports = await rpcGetBalance(addr);
      const sol = lamports/1e9;
      el.classList.remove('loading');
      el.textContent = sol>=1000?fmt(sol):sol.toFixed(2);
      el.dataset.done="1";
    }catch(e){
      el.classList.remove('loading');el.classList.add('err');
      el.textContent='-';
      el.dataset.done="1";
    }
    await new Promise(r=>setTimeout(r,90));
  }
}

// live SOL price for the USD stat
async function loadPrice(){
  try{
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const j = await r.json();
    SOL_PRICE = j.solana.usd;
    document.getElementById('s-price').textContent = `at $${SOL_PRICE.toLocaleString()} / SOL`;
    if(window.__declared){
      document.getElementById('s-usd').textContent = '$'+fmt(window.__declared*SOL_PRICE);
    }
  }catch(e){
    document.getElementById('s-usd').textContent='-';
    document.getElementById('s-price').textContent='price unavailable';
  }
}

// ====================================================================
//  WALLET / dAPP LAYER, Phantom connect + on-chain memo vote
// ====================================================================

// ── CONTACT ─────────────────────────────────────────────────────────
// Feedback uses this address (click-to-copy). Keep it current.
const CONTACT_EMAIL = "aksusarya@proton.me";

// ── NEWSLETTER ──────────────────────────────────────────────────────
// All form submissions (requests, reports, applications, newsletter) are
// delivered through Web3Forms. Paste your free access key below (get one at
// web3forms.com). Submissions arrive at the email tied to that key.
// Until it's set, the forms politely say signups open soon.
const WEB3FORMS_KEY = "e8e7134b-bc86-483f-add9-8f735d686a2f";

// Single delivery helper: injects the access key, maps the subject, and posts
// to Web3Forms. Returns the fetch response so callers can check res.ok.
async function sendForm(fields){
  if(!WEB3FORMS_KEY || WEB3FORMS_KEY.indexOf("PASTE_YOUR") !== -1){ return { ok: false }; }
  const payload = Object.assign({ access_key: WEB3FORMS_KEY }, fields);
  if(payload._subject && !payload.subject){ payload.subject = payload._subject; }
  return fetch("https://api.web3forms.com/submit", {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(payload)
  });
}

// On-chain votes are written as a Solana Memo transaction, a real,
// verifiable signed action that pays NO ONE (only the ~0.000005 SOL
// network fee). This site collects nothing.
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

// ── WALLET REQUESTS (community demand board) ────────────────────────
// Seed requests the project wants traced. Vote tallies start honest (0):
// there is no backend yet, so the only real increment we can show is the
// visitor's own upvote (kept in this browser). New requests are emailed to
// the maintainer via Formspree AND saved on this device so they show up and
// can be voted on. Global, cross-device tallying is the Phase 2 backend.
const REQUESTS = [
  { id: "upexi",     name: "Upexi, SOL treasury wallets",                  sub: "open · community demand signal", base: 0 },
  { id: "yueda",     name: "Yueda Digital Holdings, SOL custody wallets",  sub: "open · community demand signal", base: 0 },
  { id: "classover", name: "Classover Holdings, SOL positions",            sub: "open · community demand signal", base: 0 }
];
function lsGet(k, def){ try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; }catch(e){ return def; } }
function lsSet(k, val){ try{ localStorage.setItem(k, JSON.stringify(val)); }catch(e){} }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function safeUrl(u){ u = String(u || '').trim(); return /^https?:\/\//i.test(u) ? u : ''; }

// a stable per-browser id so one browser counts as one vote
function voterId(){ let v = lsGet('stw_voter', null); if(!v){ v = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36); lsSet('stw_voter', v); } return v; }

// ── OPTIONAL GLOBAL BACKEND (Supabase) ──────────────────────────────
// Leave BOTH blank → the boards run on local storage (per-browser, the
// honest default). Fill them in (Supabase dashboard → Settings → API) to
// make Wallet Requests + their upvotes GLOBAL, shared across every visitor.
// Run the setup SQL first. Any failure falls back to local automatically.
// URL + public key now live in config.js (a tiny file you can edit safely,
// without ever touching this large file). If config.js is missing, the app
// quietly runs in local-only mode instead of erroring.
const SUPABASE_URL = (window.OSI_SUPABASE_URL || "https://afibxpniwfnavdobecrn.supabase.co");
const SUPABASE_ANON_KEY = (window.OSI_SUPABASE_KEY || "");
const SUPA_ON = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
let SUPA_AUTH_TOKEN = null;   // set when a maintainer signs in; the public uses null
function supaHeaders(extra){
  const h = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  // A signed-in maintainer sends their session token on Authorization.
  // Otherwise a legacy (eyJ...) key also goes on Authorization, but a new
  // sb_publishable_ key must NOT (the gateway rejects a non-JWT Bearer value).
  if(SUPA_AUTH_TOKEN) h.Authorization = 'Bearer ' + SUPA_AUTH_TOKEN;
  else if(/^eyJ/.test(SUPABASE_ANON_KEY)) h.Authorization = 'Bearer ' + SUPABASE_ANON_KEY;
  return Object.assign(h, extra || {});
}
async function supaGet(path){ const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { headers: supaHeaders() }); if(!r.ok) throw new Error('supa get ' + r.status); return r.json(); }
async function supaPost(table, row){ const r = await fetch(SUPABASE_URL + '/rest/v1/' + table, { method: 'POST', headers: supaHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(row) }); if(!r.ok && r.status !== 409) throw new Error('supa post ' + r.status); return true; }
async function supaDelete(path){ const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { method: 'DELETE', headers: supaHeaders() }); if(!r.ok) throw new Error('supa del ' + r.status); return true; }
async function supaPatch(path, row){ const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { method:'PATCH', headers: supaHeaders({ Prefer:'return=minimal' }), body: JSON.stringify(row) }); if(!r.ok) throw new Error('supa patch ' + r.status); return true; }
async function supaSignIn(email, password){
  const r = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', { method:'POST', headers:{ apikey: SUPABASE_ANON_KEY, 'Content-Type':'application/json' }, body: JSON.stringify({ email: email, password: password }) });
  let data = {}; try{ data = await r.json(); }catch(_){}
  if(!r.ok || !data.access_token) throw new Error(data.error_description || data.msg || ('sign-in failed (' + r.status + ')'));
  SUPA_AUTH_TOKEN = data.access_token; return data;
}
function supaSignOut(){ SUPA_AUTH_TOKEN = null; }

// ---- Maintainer moderation console (open with the lock icon, or the #admin URL) ----
function admEsc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function admOpen(){ showView('admin'); }
async function admLogin(){
  const email=(document.getElementById('admEmail').value||'').trim();
  const pw=document.getElementById('admPw').value||'';
  const msg=document.getElementById('admMsg');
  if(!SUPA_ON){ msg.textContent='Supabase is not configured yet (check config.js).'; return; }
  if(!email || !pw){ msg.textContent='Enter the maintainer email and password.'; return; }
  msg.textContent='Signing in...';
  try{
    await supaSignIn(email, pw);
    msg.textContent='';
    document.getElementById('admLogin').style.display='none';
    document.getElementById('admPanel').style.display='block';
    document.getElementById('admWho').textContent=email;
    admRefresh();
  }catch(e){ msg.textContent='Sign-in failed: '+e.message; }
}
function admLogout(){
  supaSignOut();
  document.getElementById('admPanel').style.display='none';
  document.getElementById('admLogin').style.display='block';
  const pw=document.getElementById('admPw'); if(pw) pw.value='';
}
async function admRefresh(){
  const host=document.getElementById('admQueue');
  host.innerHTML='<div class="adm-muted">Loading queue...</div>';
  try{
    const reports = await supaGet('reports?select=*&order=created_at.desc');
    let requests=[]; try{ requests = await supaGet('requests?select=*&order=created_at.desc'); }catch(_){}
    host.innerHTML = admRender(reports||[], requests||[]);
  }catch(e){
    host.innerHTML='<div class="adm-err">Could not load the queue ('+admEsc(e.message)+').<br><br>Most likely the admin SQL policies have not been run yet, or this account is not the maintainer. Run osi_admin_setup.sql in the Supabase SQL Editor, then refresh.</div>';
  }
}
function admItem(kind, table, r){
  const approved = !!r.approved;
  const title = kind==='report' ? admEsc(r.company || r.bounty || r.id) : admEsc(r.name || r.id);
  const sub = kind==='report'
    ? admEsc((r.wallet ? ('wallet ' + String(r.wallet).slice(0,12) + '...  ') : '') + String(r.summary||'').slice(0,160))
    : 'wallet investigation request';
  const id = admEsc(r.id);
  const acts = approved
    ? '<button class="adm-b warn" onclick="admSet(\''+table+'\',\''+id+'\',false)">Unpublish</button><button class="adm-b del" onclick="admDel(\''+table+'\',\''+id+'\')">Delete</button>'
    : '<button class="adm-b ok" onclick="admSet(\''+table+'\',\''+id+'\',true)">Approve &amp; publish</button><button class="adm-b del" onclick="admDel(\''+table+'\',\''+id+'\')">Reject</button>';
  return '<div class="adm-row"><div class="adm-meta"><div class="adm-t">'+title+'<span class="adm-kind">'+kind+'</span></div><div class="adm-s">'+sub+'</div></div><div class="adm-acts">'+acts+'</div></div>';
}
function admRender(reports, requests){
  const pend=[], pub=[];
  reports.forEach(function(r){ (r.approved?pub:pend).push(admItem('report','reports',r)); });
  requests.forEach(function(r){ (r.approved?pub:pend).push(admItem('request','requests',r)); });
  let h='';
  h+='<div class="adm-sec"><div class="adm-h">PENDING REVIEW <span>'+pend.length+'</span></div>'+(pend.length?pend.join(''):'<div class="adm-muted">Nothing waiting. Clear desk.</div>')+'</div>';
  h+='<div class="adm-sec"><div class="adm-h">PUBLISHED <span>'+pub.length+'</span></div>'+(pub.length?pub.join(''):'<div class="adm-muted">Nothing published yet.</div>')+'</div>';
  return h;
}
async function admSet(table, id, approved){
  try{ await supaPatch(table+'?id=eq.'+encodeURIComponent(id), { approved: approved }); showToast(approved?'Published. Now public for everyone.':'Unpublished.'); admRefresh(); if(typeof renderRequests==='function') renderRequests(); }
  catch(e){ showToast('Action failed: '+e.message); }
}
async function admDel(table, id){
  if(!confirm('Delete this permanently? This cannot be undone.')) return;
  try{ await supaDelete(table+'?id=eq.'+encodeURIComponent(id)); showToast('Deleted.'); admRefresh(); if(typeof renderRequests==='function') renderRequests(); }
  catch(e){ showToast('Delete failed: '+e.message); }
}
document.addEventListener('DOMContentLoaded', function(){ if(location.hash==='#admin'){ try{ showView('admin'); }catch(_){} } });
window.addEventListener('hashchange', function(){ if(location.hash==='#admin'){ try{ showView('admin'); }catch(_){} } });


// review queue seed, one clearly-labelled example so the scoring UI stays
// demonstrable; real submissions render above it as "pending review".
const REPORTS_SEED = [
  { id: 'example', company: 'Example, DeFi Development Corp', ticker: 'NASDAQ: DFDV', example: true,
    summary: 'Sample card showing what a submitted report looks like: attributes 2.18M SOL across 9 addresses, Coinbase Prime custody, two-validator staking, with an SEC 8-K and an on-chain inflow trace. Submit your own above and it lands here as pending.',
    onchain: '', offchain: '', up: 0, dn: 0 }
];

let walletPubkey = null;                 // connected wallet address (string)

function getProvider(){
  // Phantom injects window.solana
  if(window.solana && window.solana.isPhantom) return window.solana;
  return null;
}

async function toggleWallet(){
  const prov = getProvider();
  if(!prov){
    alert("Phantom wallet not found.\n\nInstall it from phantom.app, then refresh this page to connect.");
    window.open("https://phantom.app/","_blank");
    return;
  }
  if(walletPubkey){
    // disconnect
    try{ await prov.disconnect(); }catch(e){}
    walletPubkey = null;
    updateWalletUI();
    return;
  }
  try{
    const resp = await prov.connect();
    walletPubkey = resp.publicKey.toString();
    updateWalletUI();
  }catch(e){
    // user rejected
  }
}

function updateWalletUI(){
  const btn = document.getElementById('walletBtn');
  const txt = document.getElementById('wbText');
  if(walletPubkey){
    btn.classList.add('connected');
    txt.textContent = walletPubkey.slice(0,4)+"…"+walletPubkey.slice(-4);
  }else{
    btn.classList.remove('connected');
    txt.textContent = "Connect Wallet";
  }
  if(typeof refreshApplyWalletRow === 'function') refreshApplyWalletRow();
}

// Build + send a Memo transaction as a verifiable on-chain "signed vote".
// No transfer, no recipient, only the standard network fee applies.
// Returns the transaction signature on success, throws on failure.
async function castOnchainVote(memoText){
  const prov = getProvider();
  if(!prov || !walletPubkey) throw new Error("not connected");
  const { Connection, PublicKey, Transaction, TransactionInstruction } = solanaWeb3;
  const fromPub = new PublicKey(walletPubkey);

  // SPL Memo instruction: the connected wallet signs, the memo text is the payload.
  const ix = new TransactionInstruction({
    keys: [{ pubkey: fromPub, isSigner: true, isWritable: false }],
    programId: new PublicKey(MEMO_PROGRAM_ID),
    data: new TextEncoder().encode(memoText)
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = fromPub;

  // Fetch a recent blockhash, trying Helius then the public RPC.
  let blockhash = null;
  for(const url of [HELIUS_RPC, PUBLIC_RPC]){
    try{ const r = await new Connection(url, "confirmed").getLatestBlockhash(); if(r && r.blockhash){ blockhash = r.blockhash; break; } }catch(e){ /* try next */ }
  }
  if(!blockhash) throw new Error("could not reach the Solana network, try again in a moment");
  tx.recentBlockhash = blockhash;

  const signed = await prov.signAndSendTransaction(tx);  // Phantom signs + sends
  return signed.signature;
}

// Wrapper used by vote/boost buttons: ensure wallet, send the memo tx, then run the UI action.
async function withOnchainVote(actionLabel, memoText, onSuccess){
  if(!walletPubkey){
    const ok = confirm(`"${actionLabel}" is recorded as a real on-chain action.\n\nConnect your Phantom wallet to sign it. No money is paid to anyone, only the standard Solana network fee (~0.000005 SOL).`);
    if(ok) await toggleWallet();
    if(!walletPubkey) return;
  }
  try{
    const sig = await castOnchainVote(memoText);
    onSuccess(sig);
  }catch(e){
    const msg = String((e && e.message) || e || "");
    if(msg.includes("Buffer")){
      alert("Couldn't build the transaction in this browser. Hard-refresh the page (Ctrl/Cmd + Shift + R) and try again. If it keeps failing, update your wallet extension.");
    }else{
      alert("Vote not completed: " + (msg || "the transaction was cancelled."));
    }
  }
}

// Point every [data-mailto] element at the contact address.
function wireContactLinks(){
  document.querySelectorAll('[data-mailto]').forEach(a=>{
    const subj = encodeURIComponent(a.getAttribute('data-subject') || "Open Solana Intelligence");
    a.setAttribute('href', "mailto:" + CONTACT_EMAIL + "?subject=" + subj);
  });
}

// auto-reconnect if Phantom already trusted this site
window.addEventListener('load', async ()=>{
  wireContactLinks();
  const prov = getProvider();
  if(prov){
    try{
      const resp = await prov.connect({ onlyIfTrusted:true });
      walletPubkey = resp.publicKey.toString();
      updateWalletUI();
    }catch(e){ /* not previously connected */ }
    prov.on && prov.on('disconnect', ()=>{ walletPubkey=null; updateWalletUI(); });
  }
});

render();
renderCaseStudies();
syncTabCounts();
renderRequests();
renderReviewQueue();
restoreBountyState();
loadPrice();

// ---- case studies (data-driven, collapsible) ----
function toggleCase(el){ el.closest('.co').classList.toggle('open'); }

function renderCaseStudies(){
  const host = document.getElementById('case-studies-list');
  if(!host) return;
  const LIST = window.CASE_STUDIES;
  if(!LIST || !LIST.length){
    host.innerHTML = '<div class="method-note" style="text-align:center;padding:24px">Case studies (<b>data.js</b>) didn\'t load.</div>';
    return;
  }
  host.innerHTML = LIST.map(cs=>{
    const timeline = cs.timeline.map(t=>`<div class="e"><span class="d">${t.date}</span><span class="ev">${t.event}</span></div>`).join('');
    const clusters = cs.clusters.map(cl=>`
      <div class="cluster">
        <div class="cl-tag">${cl.tag}</div>
        <div class="cl-title">${cl.title}</div>
        <p>${cl.body}</p>
        <div class="cl-proofs">${cl.proofs.map(p=>`<a href="${p.url}" target="_blank" rel="noopener">${p.label}</a>`).join('')}</div>
      </div>`).join('');
    const rows = cs.holdings.map(h=>`<tr><td><a class="mono" href="https://solscan.io/account/${h.addr}" target="_blank" rel="noopener">${h.short}</a></td><td class="num">${h.balance}</td><td>${h.validator}</td></tr>`).join('');
    const headVal = cs.headlineValue || (cs.identifiedSOL>=1e6 ? (cs.identifiedSOL/1e6).toFixed(2)+'M' : Math.round(cs.identifiedSOL).toLocaleString());
    const headLabel = cs.headlineLabel || "SOL TRACED";
    const noteParts = (cs.note||'').split('. ');
    const noteLead = noteParts.shift()||'';
    const noteRest = noteParts.join('. ');
    return `
    <div class="co cs-card">
      <div class="co-top" onclick="toggleCase(this)">
        <div class="co-id">
          <div class="co-name">
            <div class="nm">${cs.company}<span class="ticker">${cs.exchange}: ${cs.ticker}</span><span class="by-badge">by ${cs.author}</span></div>
            <div class="meta">${cs.summary}</div>
          </div>
        </div>
        <div class="co-fig">
          <div class="amt"><div class="n">${headVal}</div><div class="u">${headLabel}</div></div>
          <div class="exp"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg></div>
        </div>
      </div>
      <div class="co-body">
        <div class="cs-inner">
          <div class="comm-intro" style="max-width:840px;margin-bottom:20px"><p>${cs.intro}</p></div>
          <div class="cs-block"><div class="cs-h mono">01 · The disclosures we anchored on</div><div class="tl">${timeline}</div></div>
          <div class="cs-block"><div class="cs-h mono">02 · Following the money</div><div class="cluster-grid">${clusters}</div></div>
          <div class="cs-block"><div class="cs-h mono">03 · The identified treasury, ${cs.identifiedSOL.toLocaleString()} SOL</div>
            <div class="cs-table-wrap"><table class="cs-table">
              <thead><tr><th>Wallet</th><th>Balance (SOL)</th><th>Custody / Validator</th></tr></thead>
              <tbody>${rows}</tbody>
              <tfoot>${cs.footer ? `<tr><td colspan="3" style="color:var(--ink-dim);line-height:1.5">${cs.footer}</td></tr>` : `<tr><td>Total identified</td><td class="num">${cs.identifiedSOL.toLocaleString()}</td><td>declared: ${cs.declaredSOL.toLocaleString()}</td></tr>`}</tfoot>
            </table></div>
          </div>
          <div class="warn"><b>${noteLead}.</b> ${noteRest}</div>
        </div>
      </div>
    </div>`;
  }).join('');
}
// ---- community interactions ----
// ---- top-level view tabs ----
const VIEW_OF = { registry:'registry', how:'methodology', methodology:'methodology', 'case-studies':'research', community:'community', roadmap:'community', newsletter:'community' };
function showView(v){
  document.body.dataset.view = v;
  if(v==='graph'){ if(window.__initGraph) window.__initGraph(); }
  else if(window.__graphHide){ window.__graphHide(); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function goSection(id){
  document.body.dataset.view = VIEW_OF[id] || 'registry';
  requestAnimationFrame(()=>{ const el = document.getElementById(id); if(el) el.scrollIntoView({ behavior:'smooth', block:'start' }); });
  return false;
}
function syncTabCounts(){
  try{
    const co = (window.TREASURY_DATA && window.TREASURY_DATA.companies) ? window.TREASURY_DATA.companies.length : null;
    const cs = window.CASE_STUDIES ? window.CASE_STUDIES.length : null;
    const a = document.getElementById('vc-co'); if(a && co!=null) a.textContent = co;
    const b = document.getElementById('vc-cases'); if(b && cs!=null) b.textContent = cs;
    const lf = document.getElementById('lb-founder'); if(lf && cs!=null) lf.textContent = cs + ' published';
  }catch(e){}
}

function switchTab(btn, id){
  document.querySelectorAll('.ctab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(id).classList.add('active');
  document.body.dataset.sub = id;
}

function bountyTargetText(card){ const t = card.querySelector('.b-target'); return (t && t.textContent.trim().slice(0,80)) || "wallet hunt"; }

// Reflect a boosted bounty in the UI (used on click and after a refresh).
function markBoostedUI(card, sig){
  const btn = card.querySelector('.btn-stake'); if(!btn) return;
  btn.textContent = "✓ Boosted"; btn.style.background = "var(--sol)"; btn.style.color = "var(--bg)"; btn.disabled = true;
  if(sig && !card.querySelector('.boost-tx')){
    const note = document.createElement('div'); note.className = "boost-tx mono";
    note.style.cssText = "font-size:9px;color:var(--sol);margin-top:4px";
    note.innerHTML = `<a href="https://solscan.io/tx/${sig}" target="_blank" rel="noopener" style="color:var(--sol);text-decoration:none">↗ on-chain ✓</a>`;
    btn.parentElement.appendChild(note);
  }
}

// Boost = a real on-chain memo signalling demand. Persists across refresh
// (local fallback always; global + deduped per browser when Supabase is on).
function stakeBoost(btn){
  const card = btn.closest('.bounty'); if(!card) return;
  const bid = card.dataset.bid;
  const memo = "OSI boost, signal demand: " + bountyTargetText(card);
  withOnchainVote("Boost", memo, async (sig)=>{
    const numEl = card.querySelector('.b-reward .n');
    if(numEl){ numEl.textContent = (parseInt(numEl.textContent) || 0) + 1; }
    if(bid){ const mine = lsGet('stw_boosted', {}); mine[bid] = true; lsSet('stw_boosted', mine); }
    markBoostedUI(card, sig);
    if(SUPA_ON && bid){ try{ await supaPost('bounty_boosts', { bounty_id: bid, voter: voterId() }); hydrateBoosts(); }catch(e){ console.warn('OSI: boost sync failed.', e); } }
  });
}

// Pull the global boost totals when a backend is configured (never less than
// this browser's own boost, so a just-cast boost never visually drops to zero).
async function hydrateBoosts(){
  if(!SUPA_ON) return;
  try{
    const rows = await supaGet('bounty_boosts?select=bounty_id');
    const counts = {}; (rows || []).forEach(r => { counts[r.bounty_id] = (counts[r.bounty_id] || 0) + 1; });
    const mine = lsGet('stw_boosted', {});
    document.querySelectorAll('.bounty[data-bid]').forEach(card => {
      const n = card.querySelector('.b-reward .n'); if(!n) return;
      n.textContent = Math.max(counts[card.dataset.bid] || 0, mine[card.dataset.bid] ? 1 : 0);
    });
  }catch(e){ console.warn('OSI: boost counts unavailable, showing local view.', e); }
}

// Reflect an applied bounty in the UI (used on click and after a refresh).
function markAppliedUI(card, sig){
  const btn = card.querySelector('.btn-apply'); if(!btn) return;
  btn.textContent = "✓ Applied"; btn.style.background = "#9945ff"; btn.style.color = "#fff"; btn.style.borderColor = "#9945ff"; btn.disabled = true;
  if(sig && !card.querySelector('.apply-tx')){
    const note = document.createElement('div'); note.className = "apply-tx mono";
    note.style.cssText = "font-size:9px;color:#b98cff;margin-top:4px";
    note.innerHTML = `<a href="https://solscan.io/tx/${sig}" target="_blank" rel="noopener" style="color:#b98cff;text-decoration:none">↗ application on-chain ✓</a>`;
    btn.parentElement.appendChild(note);
  }
}

// ---- Apply to a bounty: open a report form, sign it with the wallet, file it
// as a pending report that goes public once a maintainer approves. ----
let applyCtx = { bid: '', target: '' };

function openApplyModal(btn){
  const card = btn.closest('.bounty'); if(!card) return;
  applyCtx = { bid: card.dataset.bid, target: bountyTargetText(card) };
  const nm = document.getElementById('apply-bounty-name'); if(nm) nm.textContent = '🎯 ' + applyCtx.target;
  ['apply-report','apply-onchain','apply-offchain'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  refreshApplyWalletRow();
  const m = document.getElementById('apply-modal'); if(m) m.classList.add('open');
}
function closeApplyModal(){ const m = document.getElementById('apply-modal'); if(m) m.classList.remove('open'); }

// Keep the modal's wallet line in sync with the connection state.
function refreshApplyWalletRow(){
  const row = document.getElementById('apply-wallet-row'); if(!row) return;
  if(walletPubkey){ row.textContent = '◆ Signing as ' + short(walletPubkey); row.classList.add('connected'); }
  else { row.innerHTML = 'Connect your wallet to sign this application. <a href="#" onclick="toggleWallet();return false;" style="color:var(--sol);text-decoration:none">Connect →</a>'; row.classList.remove('connected'); }
}

async function submitBountyReport(){
  const report = (document.getElementById('apply-report').value || '').trim();
  const on  = (document.getElementById('apply-onchain').value || '').trim();
  const off = (document.getElementById('apply-offchain').value || '').trim();
  if(!report){ showToast("Write your attribution report before submitting."); return; }
  if(!on){ showToast("Add at least an on-chain proof link (Solscan / explorer)."); return; }
  const target = applyCtx.target, bid = applyCtx.bid;
  const memo = "OSI bounty report: " + target + (walletPubkey ? (" | by " + walletPubkey) : "");
  withOnchainVote("Submit report", memo, async (sig)=>{
    const id = 'rep_' + Date.now();
    // 1) local pending, so the submitter sees it immediately (tied to their wallet)
    const reports = lsGet('stw_reports', []);
    reports.unshift({ id, bounty: target, company: target, summary: report, onchain: on, offchain: off, wallet: walletPubkey || '', tx: sig || '', up: 0, dn: 0 });
    lsSet('stw_reports', reports);
    // 2) mark the bounty as applied (persists across refresh)
    if(bid){ const mine = lsGet('stw_applied', {}); mine[bid] = true; lsSet('stw_applied', mine); const c = document.querySelector('.bounty[data-bid="' + bid + '"]'); if(c) markAppliedUI(c, sig); }
    // 3) global pending via Supabase, public only after a maintainer approves
    if(SUPA_ON){ try{ await supaPost('reports', { id, bounty: target, company: target, wallet: walletPubkey || '', summary: report, onchain: on, offchain: off, tx: sig || '', approved: false }); }catch(e){ console.warn('OSI: report publish failed.', e); } }
    // 4) email the maintainer for approval
    try{ await sendForm({ _subject: 'OSI, Bounty Report: ' + target, type: 'bounty-report', bounty: target, wallet: walletPubkey || '(none)', summary: report, onchain_proof: on, offchain_proof: off || '(none)', tx: sig || '(none)' }); }catch(e){}
    // 5) close + take them to the queue to see it land as pending
    closeApplyModal();
    renderReviewQueue();
    openCommunityTab('tab-analysts');
    const q = document.getElementById('review-list'); if(q) q.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast("✓ Report signed on-chain and submitted, pending maintainer approval.");
  });
}

// On load, restore this browser's boosted/applied bounties + global counts.
function restoreBountyState(){
  const boosted = lsGet('stw_boosted', {}); const applied = lsGet('stw_applied', {});
  document.querySelectorAll('.bounty[data-bid]').forEach(card => {
    const bid = card.dataset.bid;
    if(boosted[bid]){
      const n = card.querySelector('.b-reward .n'); if(n){ n.textContent = (parseInt(n.textContent) || 0) + 1; }
      markBoostedUI(card, null);
    }
    if(applied[bid]) markAppliedUI(card, null);
  });
  hydrateBoosts(); // global totals override the local fallback when configured
}

async function upvoteReq(btn){
  const id = btn.dataset.id;
  if(!id) return;
  const votes = lsGet('stw_votes', {});
  const wasVoted = !!votes[id];
  // Un-voting is free (no signature). Casting an upvote is a real on-chain action.
  if(wasVoted){
    delete votes[id]; lsSet('stw_votes', votes); renderRequests();
    if(SUPA_ON){ try{ await supaDelete('request_votes?request_id=eq.' + encodeURIComponent(id) + '&voter=eq.' + encodeURIComponent(voterId())); hydrateRequestsFromSupabase(); }catch(e){ console.warn('OSI: vote sync failed.', e); } }
    return;
  }
  const nameEl = btn.closest('.req') ? btn.closest('.req').querySelector('.req-name') : null;
  const memo = "OSI wallet-request upvote: " + ((nameEl && nameEl.textContent.trim().slice(0,80)) || id);
  withOnchainVote("Upvote", memo, async (sig)=>{
    const v = lsGet('stw_votes', {}); v[id] = true; lsSet('stw_votes', v);
    renderRequests();
    if(SUPA_ON){ try{ await supaPost('request_votes', { request_id: id, voter: voterId() }); hydrateRequestsFromSupabase(); }catch(e){ console.warn('OSI: vote sync failed.', e); } }
  });
}

// Render the board from local data first (instant + resilient), then, if a
// global backend is configured, enrich it with everyone's requests + votes.
function renderRequests(){
  renderRequestsFrom(localRequestsModel());
  if(SUPA_ON) hydrateRequestsFromSupabase();
}
function reqRowHtml(r){
  const voteStyle = r.voted ? 'color:var(--sol);border-color:var(--sol)' : '';
  return `<div class="req">
      <div class="req-ic">⌖</div>
      <div class="req-body">
        <div class="req-name">${escapeHtml(r.name)}</div>
        <div class="req-sub mono">${escapeHtml(r.sub || 'open · community demand signal')}</div>
      </div>
      <button class="up" data-id="${escapeHtml(r.id)}" onclick="upvoteReq(this)" style="${voteStyle}">▲ <span>${r.count}</span></button>
    </div>`;
}
function renderRequestsFrom(model){
  const host = document.getElementById('req-list');
  if(!host) return;
  host.innerHTML = model.map(reqRowHtml).join('');
}
function localRequestsModel(){
  const userReqs = lsGet('stw_requests', []);
  const votes = lsGet('stw_votes', {});
  const list = REQUESTS.concat(Array.isArray(userReqs) ? userReqs : []);
  return list.map(r => ({ id: r.id, name: r.name, sub: r.sub, count: (r.base || 0) + (votes[r.id] ? 1 : 0), voted: !!votes[r.id] }));
}
async function hydrateRequestsFromSupabase(){
  try{
    const [dbReqs, dbVotes] = await Promise.all([
      supaGet('requests?select=id,name&approved=eq.true&order=created_at.asc'),
      supaGet('request_votes?select=request_id')
    ]);
    const counts = {}; (dbVotes || []).forEach(v => { counts[v.request_id] = (counts[v.request_id] || 0) + 1; });
    const myVotes = lsGet('stw_votes', {});
    const seen = new Set(); const merged = [];
    REQUESTS.concat((dbReqs || []).map(r => ({ id: r.id, name: r.name, sub: 'community request' })))
      .forEach(r => { if(!seen.has(r.id)){ seen.add(r.id); merged.push(r); } });
    // show the submitter their own not-yet-approved requests (visible only to them)
    const have = new Set(merged.map(r => r.id));
    const localPending = (lsGet('stw_requests', []) || []).filter(r => !have.has(r.id));
    const model = merged.map(r => ({ id: r.id, name: r.name, sub: r.sub, count: Math.max(counts[r.id] || 0, myVotes[r.id] ? 1 : 0), voted: !!myVotes[r.id] }))
      .concat(localPending.map(r => ({ id: r.id, name: r.name, sub: '⏳ awaiting maintainer approval', count: 0, voted: false })));
    renderRequestsFrom(model);
  }catch(e){ console.warn('OSI: global board unavailable, showing local view.', e); }
}

function scoreReport(btn, dir){
  const label = dir>0 ? "Upvote" : "Downvote";
  const co = (btn.closest('.report-card')||document).querySelector('.rc-co');
  const memo = "OSI report " + (dir>0?"upvote":"downvote") + ": " + ((co && co.textContent.trim().slice(0,80)) || "attribution review");
  withOnchainVote(label, memo, (sig)=>{
    const span = btn.querySelector('span');
    let n = parseInt(span.textContent);
    span.textContent = n+1;
    btn.style.opacity = "1";
    btn.disabled = true;
    // one vote per wallet (UI): dim the opposite button
    const sib = btn.parentElement.querySelectorAll('button');
    sib.forEach(b=>{ if(b!==btn) b.disabled=true; });
    if(sig){
      btn.title = "Recorded on-chain";
      const row = btn.closest('.rc-score');
      if(row && !row.querySelector('.tx-link')){
        const note = document.createElement('a');
        note.className = "tx-link mono";
        note.href = "https://solscan.io/tx/"+sig;
        note.target = "_blank"; note.rel = "noopener";
        note.style.cssText = "font-size:9px;color:var(--sol);text-decoration:none;align-self:center";
        note.textContent = "↗ ✓";
        row.appendChild(note);
      }
    }
  });
}

async function submitRequest(){
  const name = (document.getElementById('rq-name').value || '').trim();
  const hint = (document.getElementById('rq-hint').value || '').trim();
  if(!name){ showToast("Add a fund or company name to request a trace."); return; }
  const id = 'req_' + Date.now();
  const label = hint ? (name + ', ' + hint) : name;
  // save locally so the submitter sees it right away (deduped by id vs backend)
  const userReqs = lsGet('stw_requests', []);
  userReqs.push({ id, name: label, sub: SUPA_ON ? '⏳ awaiting maintainer approval' : 'requested here · community demand signal', base: 0 });
  lsSet('stw_requests', userReqs);
  renderRequests();
  document.getElementById('rq-name').value = ''; document.getElementById('rq-hint').value = '';
  // submit to the shared board as PENDING (not public until a maintainer approves)
  if(SUPA_ON){ try{ await supaPost('requests', { id, name: label, approved: false }); hydrateRequestsFromSupabase(); }catch(e){ console.warn('OSI: request publish failed.', e); } }
  // always email the maintainer for triage / approval
  const okMsg = SUPA_ON ? '✓ Sent for review, it goes public once a maintainer approves.' : '✓ Request added and sent to the maintainer.';
  try{
    const res = await sendForm({ _subject: 'OSI, Wallet Request: ' + name, type: 'wallet-request', company: name, hint: hint || '(none)' });
    showToast(res.ok ? okMsg : '✓ Saved, could not reach the maintainer; try again later.');
  }catch(e){ showToast('✓ Saved, could not reach the maintainer; try again later.'); }
}

async function submitResearch(){
  const co  = (document.getElementById('sub-co').value || '').trim();
  const sum = (document.getElementById('sub-sum').value || '').trim();
  const on  = (document.getElementById('sub-onchain').value || '').trim();
  const off = (document.getElementById('sub-offchain').value || '').trim();
  if(!co){ showToast("Name the subject company or fund."); return; }
  if(!on || !off){ showToast("A report needs BOTH an on-chain proof link AND off-chain corroboration."); return; }
  const id = 'rep_' + Date.now();
  // 1) add it to the review queue as a pending report (saved on this device)
  const reports = lsGet('stw_reports', []);
  reports.unshift({ id: id, company: co, summary: sum || 'No summary provided.', onchain: on, offchain: off, wallet: walletPubkey || '', up: 0, dn: 0 });
  lsSet('stw_reports', reports);
  renderReviewQueue();
  ['sub-co','sub-sum','sub-onchain','sub-offchain'].forEach(fid=>document.getElementById(fid).value='');
  // 2) global pending via Supabase, so it lands in the maintainer's admin queue
  if(SUPA_ON){ try{ await supaPost('reports', { id: id, bounty: '', company: co, wallet: walletPubkey || '', summary: sum || 'No summary provided.', onchain: on, offchain: off, tx: '', approved: false }); }catch(e){ console.warn('OSI: research publish failed.', e); } }
  // 3) email the maintainer for review (real intake)
  try{
    await sendForm({ _subject: 'OSI, Research Submission: ' + co, type: 'research-submission', company: co, summary: sum || '(none)', onchain_proof: on, offchain_proof: off });
  }catch(e){}
  // 4) take the user to the queue so they see it land as pending
  openCommunityTab('tab-analysts');
  const q = document.getElementById('review-list'); if(q) q.scrollIntoView({ behavior: 'smooth', block: 'center' });
  showToast('✓ Submitted for review, added as pending and sent to the maintainer.');
}

// One report card. Three states: the seed example, a pending submission
// (local, or in Supabase awaiting approval), and an approved report a
// maintainer has published for everyone.
function reportCardHtml(r){
  const onUrl = safeUrl(r.onchain), offUrl = safeUrl(r.offchain);
  const onP = onUrl ? `<a class="proof-tag onchain" href="${escapeHtml(onUrl)}" target="_blank" rel="noopener">⛓ on-chain proof ↗</a>` : `<span class="proof-tag onchain">⛓ on-chain proof attached</span>`;
  const offP = offUrl ? `<a class="proof-tag offchain" href="${escapeHtml(offUrl)}" target="_blank" rel="noopener">▤ off-chain proof ↗</a>` : `<span class="proof-tag offchain">▤ SEC filing attached</span>`;
  const tick = r.ticker ? `<span class="ticker">${escapeHtml(r.ticker)}</span>` : '';
  const who = r.wallet ? short(r.wallet) : 'you';
  const txLink = r.tx ? ` <a class="mono" href="https://solscan.io/tx/${escapeHtml(r.tx)}" target="_blank" rel="noopener" style="color:var(--sol);text-decoration:none;font-size:9px">↗ signed ✓</a>` : '';
  const bountyTag = r.bounty ? `<div class="rc-bounty mono">🎯 ${escapeHtml(r.bounty)}</div>` : '';
  let by, conf;
  if(r.example){ by = `<span style="color:var(--amber)">example</span> · illustrates how scoring works`; conf = '◑ pending verification'; }
  else if(r.approved){ by = `by <span style="color:var(--cyan)" title="${escapeHtml(r.wallet || '')}">${escapeHtml(who)}</span> · <span style="color:var(--sol)">◆ approved by maintainer</span>`; conf = '✓ published'; }
  else { by = `by <span style="color:var(--cyan)" title="${escapeHtml(r.wallet || '')}">${escapeHtml(who)}</span> · ⏳ pending review`; conf = '◑ pending verification'; }
  return `<div class="report-card${r.approved ? ' approved' : ''}" style="margin-bottom:11px">
      <div class="rc-top">
        <div>
          <div class="rc-co">${escapeHtml(r.company)} ${tick}</div>
          <div class="rc-by mono">${by}${txLink}</div>
          ${bountyTag}
        </div>
        <div class="rc-score">
          <button class="vote-up" onclick="scoreReport(this,1)">▲ <span>${r.up || 0}</span></button>
          <button class="vote-dn" onclick="scoreReport(this,-1)">▼ <span>${r.dn || 0}</span></button>
        </div>
      </div>
      <div class="rc-sum">${escapeHtml(r.summary)}</div>
      <div class="rc-proof">${onP}${offP}<span class="proof-tag conf">${conf}</span></div>
    </div>`;
}

// Render the review queue: this visitor's pending submissions + the example,
// then, if a backend is configured, everyone's maintainer-approved reports.
function renderReviewQueue(){
  const host = document.getElementById('review-list');
  if(!host) return;
  const userReports = lsGet('stw_reports', []);
  const all = (Array.isArray(userReports) ? userReports : []).concat(REPORTS_SEED);
  host.innerHTML = all.map(reportCardHtml).join('');
  if(SUPA_ON) hydrateReportsFromSupabase();
}

// Pull maintainer-approved reports from the shared backend so every visitor
// sees them; the submitter still sees their own not-yet-approved reports.
async function hydrateReportsFromSupabase(){
  try{
    const dbReports = await supaGet('reports?select=id,bounty,company,wallet,summary,onchain,offchain,tx&approved=eq.true&order=created_at.desc');
    const approved = (dbReports || []).map(r => Object.assign({}, r, { approved: true }));
    const approvedIds = new Set(approved.map(r => r.id));
    const localPending = (lsGet('stw_reports', []) || []).filter(r => !approvedIds.has(r.id));
    const host = document.getElementById('review-list');
    if(!host) return;
    host.innerHTML = approved.concat(localPending).concat(REPORTS_SEED).map(reportCardHtml).join('');
  }catch(e){ console.warn('OSI: published reports unavailable, showing local view.', e); }
}

// Activate a community sub-tab by id (used after submitting research).
function openCommunityTab(id){
  document.querySelectorAll('.ctab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  const panel = document.getElementById(id); if(panel) panel.classList.add('active');
  document.querySelectorAll('.ctab').forEach(b=>{ if((b.getAttribute('onclick') || '').indexOf("'" + id + "'") !== -1) b.classList.add('active'); });
  document.body.dataset.sub = id;
}

// sidebar → jump straight to a Community sub-tab (and switch into Community view)
function goCommunity(id){
  showView('community');
  openCommunityTab(id);
}

// Analyst application, sends Telegram / X handles + optional proof to the
// maintainer via Formspree. No mail client opens, no page jump.
async function submitAnalystApplication(){
  const tg  = (document.getElementById('an-tg').value || '').trim();
  const tw  = (document.getElementById('an-tw').value || '').trim();
  const web = (document.getElementById('an-web').value || '').trim();
  if(!tg && !tw){ showToast("Add your Telegram or X username so the maintainer can reach you."); return; }
  const handle = tg || tw;
  try{
    const res = await sendForm({ _subject: 'OSI, Analyst Application: ' + handle, type: 'analyst-application', telegram: tg || '(none)', twitter: tw || '(none)', website: web || '(none)' });
    if(res.ok){
      ['an-tg','an-tw','an-web'].forEach(id=>document.getElementById(id).value='');
      showToast('✓ Application sent, the maintainer will get back to you.');
    } else {
      showToast('Could not send right now, please try again later.');
    }
  }catch(e){ showToast('Could not send right now, please try again later.'); }
}

// Direct inline subscribe, posts to Formspree, never opens a mail app.
async function subscribeNewsletter(){
  const el = document.getElementById('nl-email');
  const email = (el && el.value.trim()) || "";
  if(!email || email.indexOf('@') < 1){ showToast("Enter a valid email to subscribe."); return; }
  if(!WEB3FORMS_KEY || WEB3FORMS_KEY.indexOf("PASTE_YOUR") !== -1){
    showToast("Newsletter signups open shortly, almost there.");
    return;
  }
  try{
    const res = await sendForm({ email: email, list: "Weekly Brief", _subject: "OSI, Newsletter Signup" });
    if(res.ok){ if(el) el.value=""; showToast("✓ You're on the list, thanks!"); }
    else { showToast("Couldn't subscribe right now, please try again later."); }
  }catch(e){ showToast("Couldn't subscribe right now, please try again later."); }
}

// Copy the contact email to the clipboard (used by the Feedback links).
function copyContact(e){
  if(e && e.preventDefault) e.preventDefault();
  try{ navigator.clipboard.writeText(CONTACT_EMAIL); }catch(_){}
  showToast("Contact email copied: " + CONTACT_EMAIL);
}

// Small transient toast notification.
function showToast(msg){
  let t = document.getElementById('stw-toast');
  if(!t){
    t = document.createElement('div');
    t.id = 'stw-toast';
    t.style.cssText = "position:fixed;left:50%;bottom:74px;transform:translateX(-50%);z-index:80;background:var(--bg-raised);border:1px solid var(--sol);color:var(--ink);font-family:'JetBrains Mono',monospace;font-size:12px;padding:10px 16px;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.5);opacity:0;transition:opacity .2s;pointer-events:none;max-width:90vw;text-align:center";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = "1";
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(()=>{ t.style.opacity = "0"; }, 2600);
}
