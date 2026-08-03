


// review queue seed, one clearly-labelled example so the scoring UI stays
// demonstrable; real submissions render above it as "pending review".
let walletPubkey = null;                 // connected wallet address (string)
var _osiWalletReadyResolve=null,_osiWalletReadyDone=false;
window.OSI_WALLET_READY=new Promise(function(resolve){_osiWalletReadyResolve=resolve;});
function markWalletReady(){if(!_osiWalletReadyDone){_osiWalletReadyDone=true;if(_osiWalletReadyResolve)_osiWalletReadyResolve(walletPubkey||null);}}

// Phantom's own handle is window.phantom.solana. window.solana is only a
// legacy alias that any Solana extension can claim, so a second installed
// wallet must never make an installed Phantom look missing.
function isPhantomProvider(candidate){
  return !!(candidate && candidate.isPhantom && typeof candidate.connect === 'function');
}
function getProvider(){
  var namespaced = window.phantom && window.phantom.solana;
  if(isPhantomProvider(namespaced)) return namespaced;
  if(isPhantomProvider(window.solana)) return window.solana;
  // Some browsers publish every injected Solana provider in one list when more
  // than one wallet is installed.
  var lists = [window.solana && window.solana.providers, window.phantom && window.phantom.providers];
  for(var i=0;i<lists.length;i++){
    var list = lists[i];
    if(!list || typeof list.length !== 'number') continue;
    for(var k=0;k<list.length;k++) if(isPhantomProvider(list[k])) return list[k];
  }
  return null;
}
// A wallet extension can finish injecting after the page starts running, so a
// missing provider is only honest once the page has settled. Nothing here ever
// prompts: it waits for the injected object and gives up on a fixed deadline.
var OSI_PROVIDER_WAIT_MS = 3000;
function waitForProvider(timeoutMs){
  var immediate = getProvider();
  if(immediate) return Promise.resolve(immediate);
  var limit = typeof timeoutMs === 'number' ? timeoutMs : OSI_PROVIDER_WAIT_MS;
  return new Promise(function(resolve){
    var deadline = Date.now() + limit, settled = false;
    function settle(value){ if(settled) return; settled = true; resolve(value); }
    function poll(){
      var provider = getProvider();
      if(provider) return settle(provider);
      if(Date.now() >= deadline) return settle(null);
      setTimeout(poll, 120);
    }
    poll();
  });
}

function clearWalletCache(){
  try{ localStorage.removeItem('stw_profile_name'); }catch(e){}
  try{ localStorage.removeItem('stw_wallet_off'); }catch(e){}
  try{ sessionStorage.removeItem('osi_wallet_session'); }catch(e){}
}
function clearWalletAuthorization(options){
  options=options||{};
  window.__osiProof = null;
  window.__osiIntake = null;
  window.__osiV2ReadProof = null;
  window.__osiWalletAuthorization = null;
  if(options.preserveReadSession!==true&&typeof window.osiV2ClearReadSession==='function')window.osiV2ClearReadSession(options.reason||'wallet_changed');
  if(options.preserveReadSession!==true&&typeof window.osiV2ReportClearSession === 'function') window.osiV2ReportClearSession();
  if(typeof setMaintainerServerGate === 'function') setMaintainerServerGate(false,'wallet_changed');
}
// onlyIfTrusted never opens an approval prompt. An explicit OSI disconnect
// disables automatic restore until the user connects again.
function sessionRestoreWanted(){ try{ return localStorage.getItem('osi_phantom_restore') !== '0'; }catch(e){ return true; } }
// True only when Phantom is present AND reports a connected publicKey AND we hold the address.
function getConnectedProvider(){
  var prov = getProvider();
  if(!prov) return null;
  if(prov.isConnected === false) return null;
  if(!prov.publicKey) return null;
  if(!walletPubkey) return null;
  return prov;
}
// Map common Phantom / network failures to a clear, non-crashing message.
function walletErrorMessage(e, ctx){
  var code = e && (e.code !== undefined ? e.code : (e.error && e.error.code));
  var msg = String((e && e.message) || e || "").toLowerCase();
  ctx = ctx || "Action";
  if(code === 4001 || msg.indexOf("user rejected") >= 0 || msg.indexOf("rejected the request") >= 0) return "You declined the request in Phantom.";
  if(code === -32002 || msg.indexOf("already pending") >= 0 || msg.indexOf("request of type") >= 0) return "A Phantom request is already open. Finish or close the Phantom popup, then try again.";
  if(msg.indexOf("popup") >= 0 || msg.indexOf("blocked") >= 0) return "Phantom popup was blocked. Allow popups for this site, then try again.";
  if(msg.indexOf("notconnected") >= 0 || msg.indexOf("not connected") >= 0 || msg.indexOf("publickey") >= 0 || msg.indexOf("provider missing") >= 0) return "Connect Phantom first.";
  if(msg.indexOf("insufficient") >= 0 || msg.indexOf("no record of a prior credit") >= 0) return "This wallet does not hold enough SOL for the Solana network fee (~0.000005 SOL). Add a small amount of SOL, then try again.";
  if(msg.indexOf("transaction library") >= 0 || msg.indexOf("solanaweb3") >= 0) return "The Solana transaction library did not load in this browser. Hard-refresh (Ctrl/Cmd + Shift + R) and try again.";
  if(msg.indexOf("rpc") >= 0 || msg.indexOf("network") >= 0 || msg.indexOf("blockhash") >= 0 || msg.indexOf("timeout") >= 0 || msg.indexOf("fetch") >= 0) return "Could not reach the Solana network. Check your connection and try again in a moment.";
  if(msg.indexOf("buffer") >= 0) return "Could not build the transaction in this browser. Hard-refresh (Ctrl/Cmd + Shift + R) and try again.";
  return ctx + " could not be completed. " + (((e && e.message) || "Please try again."));
}
// Small menu under the wallet button (Open profile / Disconnect).
function closeWalletMenu(){ var m=document.getElementById('wbMenu'); if(m) m.classList.remove('open'); }
function openWalletMenu(){ var m=document.getElementById('wbMenu'); if(m) m.classList.add('open'); }
function toggleWalletMenu(){ var m=document.getElementById('wbMenu'); if(m) m.classList.toggle('open'); }

var _osiWalletIntent=null,_osiWalletIntentRunning=false;
async function osiResumeWalletIntent(){
  if(_osiWalletIntentRunning||!_osiWalletIntent||!walletPubkey)return false;
  var intent=_osiWalletIntent;
  _osiWalletIntent=null;
  _osiWalletIntentRunning=true;
  try{
    await intent.action();
    return true;
  }catch(error){
    if(typeof showToast==='function')showToast(walletErrorMessage(error,intent.label||'Requested action'));
    return false;
  }finally{
    _osiWalletIntentRunning=false;
  }
}
async function osiConnectForIntent(name,label,action){
  _osiWalletIntent={name:String(name||'wallet-action'),label:String(label||'Requested action'),action:action};
  if(typeof showToast==='function')showToast('Connect Wallet to continue. This action will resume once after connection.');
  var connected=await toggleWallet();
  if(connected)await osiResumeWalletIntent();
  else if(typeof showToast==='function')showToast('Wallet not connected. The '+String(label||'requested')+' action is saved; use Connect Wallet to resume it once.');
  return connected;
}
window.osiConnectForIntent=osiConnectForIntent;
window.osiResumeWalletIntent=osiResumeWalletIntent;

async function toggleWalletOnce(){
  var prov = getProvider();
  // Only a page that is still loading can still gain a provider, so a settled
  // page answers immediately and keeps the install tab inside the user gesture.
  if(!prov && document.readyState !== 'complete') prov = await waitForProvider();
  if(!prov){
    if(typeof showToast==='function') showToast("Phantom not found. Install it from phantom.app, then refresh and connect.");
    try{ window.open("https://phantom.app/","_blank"); }catch(e){}
    markWalletReady();return false;
  }
  if(walletPubkey && prov.publicKey && prov.isConnected !== false) return true; // already connected this session
  try{
    var resp = await prov.connect();
    // Phantom answers with the key; some builds only publish it on the provider.
    var connectedKey = (resp && resp.publicKey) || prov.publicKey;
    if(!connectedKey){ if(typeof showToast==='function') showToast("Connect Phantom first."); return false; }
    walletPubkey = connectedKey.toString();
    try{ sessionStorage.setItem('osi_wallet_session','1'); }catch(e){}
    try{ localStorage.setItem('osi_phantom_restore','1'); }catch(e){}
    clearWalletAuthorization();
    if(typeof window.osiV2ReadSessionHandleWallet==='function')window.osiV2ReadSessionHandleWallet(walletPubkey);
    updateWalletUI();
    markWalletReady();
    if(typeof showToast==='function') showToast('Connected \u2713  Use the wallet button to open your profile or disconnect.');
    await osiResumeWalletIntent();
    return true;
  }catch(e){
    if(typeof showToast==='function') showToast(walletErrorMessage(e, "Connection"));
    markWalletReady();return false;
  }
}
var _osiWalletConnectPromise=null;
function toggleWallet(){
  if(_osiWalletConnectPromise)return _osiWalletConnectPromise;
  var pending=toggleWalletOnce();_osiWalletConnectPromise=pending;
  return pending.finally(function(){if(_osiWalletConnectPromise===pending)_osiWalletConnectPromise=null;});
}

function updateWalletUI(){
  const btn = document.getElementById('walletBtn');
  const txt = document.getElementById('wbText');
  if(!btn || !txt) return;
  if(walletPubkey){
    btn.classList.add('connected');
    btn.setAttribute('aria-label','Open wallet menu for '+walletPubkey.slice(0,4)+'\u2026'+walletPubkey.slice(-4));
    const nm = lsGet('stw_profile_name','');
    txt.textContent = nm ? nm : (walletPubkey.slice(0,4)+'\u2026'+walletPubkey.slice(-4));
    let av = document.getElementById('wbAva');
    if(!av){ av=document.createElement('span'); av.id='wbAva'; av.className='wb-ava'; btn.insertBefore(av, btn.firstChild); }
    av.innerHTML = pfIdenticon(walletPubkey, 18);
    const dot = btn.querySelector('.wb-dot'); if(dot) dot.style.display='none';
  } else {
    btn.classList.remove('connected');
    btn.setAttribute('aria-label','Connect Wallet');
    if(typeof closeWalletMenu==='function') closeWalletMenu();
    txt.textContent = "Connect Wallet";
    const av = document.getElementById('wbAva'); if(av) av.remove();
    const dot = btn.querySelector('.wb-dot'); if(dot) dot.style.display='';
  }
  if(typeof updateAdminButton === 'function') updateAdminButton();
  if(typeof updateMaintainerAccessUI === 'function') updateMaintainerAccessUI();
  if(typeof refreshMaintainerGate === 'function' && walletPubkey) refreshMaintainerGate();
  if(document.body.dataset.view==='admin' && typeof renderAdminAccess==='function') renderAdminAccess({clear:true});
  if(typeof refreshApplyWalletRow === 'function') refreshApplyWalletRow();
  if(document.body.dataset.view==='profile' && typeof renderProfile==='function') renderProfile();
}
// Build + send a Memo transaction as a verifiable on-chain "signed vote".
// No transfer, no recipient, only the standard network fee applies.
// Returns the transaction signature on success, throws on failure.
async function castOnchainVote(memoText){
  const prov = getProvider();
  if(!prov) throw new Error("PROVIDER missing");
  if(!walletPubkey || !prov.publicKey || prov.isConnected === false) throw new Error("NOTCONNECTED");
  // A blocked or failed CDN leaves this global undefined. Say so instead of
  // throwing a bare ReferenceError at a user who is mid-submission.
  if(typeof solanaWeb3 === 'undefined' || !solanaWeb3 || !solanaWeb3.Transaction) throw new Error("The Solana transaction library is not available in this browser.");
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
  const blockhash = await fetchRecentBlockhash();
  if(!blockhash) throw new Error("NETWORK: could not reach the Solana network. Check your connection and try again in a moment.");
  tx.recentBlockhash = blockhash;

  const submit = function(){ return prov.signAndSendTransaction(tx); };
  const signed = typeof window.osiV2ApproveTransaction === 'function'
    ? await window.osiV2ApproveTransaction(memoText, submit)
    : await submit();  // Phantom signs + sends
  return signed.signature;
}

// Wrapper used by vote/boost buttons: ensure wallet, send the memo tx, then run the UI action.
async function withOnchainVote(actionLabel, memoText, onSuccess){
  if(!getConnectedProvider()){
    var ok = confirm('"' + actionLabel + '" is recorded as a real on-chain action.\n\nConnect your Phantom wallet to sign it. No money is paid to anyone, only the standard Solana network fee (~0.000005 SOL).');
    if(!ok) return;
    var connected = await toggleWallet();
    if(!connected || !getConnectedProvider()){
      if(typeof showToast==='function') showToast("Connect Phantom first, then try again.");
      return;
    }
  }
  var sig;
  try{
    sig = await castOnchainVote(memoText);
    if(!sig) throw new Error("signing failed");
  }catch(e){
    var friendly = walletErrorMessage(e, "Signing");
    if(typeof showToast==='function') showToast(friendly); else alert(friendly);
    return; // signing failed: do NOT submit data
  }
  try{ await onSuccess(sig); }catch(e){ /* the success handler manages its own UI and writes */ }
}

if(typeof window.OSI_DEBUG_WORKSPACE === 'undefined') window.OSI_DEBUG_WORKSPACE = false;
function resolveWorkspaceContext(){
  var wallet = walletPubkey || null;
  var walletConnected = (typeof getConnectedProvider === 'function') ? !!getConnectedProvider() : !!wallet;
  var maintainerAccess = (typeof resolveMaintainerAccess === 'function') ? resolveMaintainerAccess() : { allowed:false };
  var isMaintainer = !!maintainerAccess.allowed;
  var verifiedAnalyst = !!(wallet && typeof isVerifiedAnalyst === 'function' && isVerifiedAnalyst(wallet));
  var analystProfile = (wallet && window.VERIFIED_ANALYSTS) ? (window.VERIFIED_ANALYSTS[String(wallet)] || null) : null;
  var workspaceRole = 'public';

  if(isMaintainer) workspaceRole = 'maintainer';
  else if(walletConnected && verifiedAnalyst) workspaceRole = 'analyst';
  else if(walletConnected) workspaceRole = 'wallet';

  var ctx = {
    wallet: wallet,
    walletConnected: walletConnected,
    isMaintainer: isMaintainer,
    isVerifiedAnalyst: verifiedAnalyst,
    analystProfile: analystProfile,
    workspaceRole: workspaceRole,
    permissions: {
      canOpenCase: walletConnected,
      canSubmitReport: walletConnected,
      canSubmitWire: walletConnected,
      canReview: isMaintainer || (walletConnected && verifiedAnalyst),
      canReviewWire: walletConnected && verifiedAnalyst,
      canInspectWireQueue: isMaintainer || (walletConnected && verifiedAnalyst),
      canVouch: walletConnected && verifiedAnalyst,
      canAdminApprove: isMaintainer,
      canSealRecord: isMaintainer
    }
  };

  if(window.OSI_DEBUG_WORKSPACE && window.console && typeof window.console.debug === 'function'){
    window.console.debug('[OSI workspace]', ctx);
  }
  return ctx;
}
function getWorkspaceRoleLabel(ctx){
  var role = (ctx && ctx.workspaceRole) || 'public';
  if(role === 'maintainer') return 'Maintainer Console';
  if(role === 'analyst') return 'Analyst Desk';
  if(role === 'wallet') return 'Wallet Workspace';
  return 'Public Registry';
}

// Point every [data-mailto] element at the contact address.
function wireContactLinks(){
  document.querySelectorAll('[data-mailto]').forEach(a=>{
    const subj = encodeURIComponent(a.getAttribute('data-subject') || "Open Solana Intelligence");
    a.setAttribute('href', "mailto:" + CONTACT_EMAIL + "?subject=" + subj);
  });
}

// ---- case studies (data-driven, collapsible) ----
function toggleCase(el){ el.closest('.co').classList.toggle('open'); }


function openReport(kind, id){
  if(kind==='case'){
    if(typeof window.osiNavigate==='function') window.osiNavigate('records'); else showView('records');
    setTimeout(function(){
      const el=document.getElementById('case-'+id);
      if(el){ el.classList.add('open'); el.scrollIntoView({behavior:'smooth',block:'center'}); }
      else { const l=document.getElementById('case-studies-list'); if(l) l.scrollIntoView({behavior:'smooth',block:'start'}); }
    },140);
  }
}

function renderCaseStudies(){
  const host = document.getElementById('case-studies-list');
  const sec = document.getElementById('case-studies');
  if(!host) return;
  const LIST = window.CASE_STUDIES;
  if(!LIST || !LIST.length){
    if(sec) sec.style.display='none';
    return;
  }
  if(sec) sec.style.display='';
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
    <div class="co cs-card" id="case-${cs.id}">
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
          <div class="cs-block"><div class="cs-h mono">03 · Funds traced, ${cs.identifiedSOL.toLocaleString()} SOL</div>
            <div class="cs-table-wrap"><table class="cs-table">
              <thead><tr><th>Wallet</th><th>Balance (SOL)</th><th>Custody / Validator</th></tr></thead>
              <tbody>${rows}</tbody>
              <tfoot>${cs.footer ? `<tr><td colspan="3" style="color:var(--ink-dim);line-height:1.5">${cs.footer}</td></tr>` : `<tr><td>Total identified</td><td class="num">${cs.identifiedSOL.toLocaleString()}</td><td>declared: ${cs.declaredSOL.toLocaleString()}</td></tr>`}</tfoot>
            </table></div>
          </div>
          <div class="disclaimer"><b>${noteLead}.</b> ${noteRest}</div>
          ${OSI_SUPPORT_WALLET && location.pathname.toLowerCase().endsWith('/legacy.html') ? `<div class="cs-support"><div class="cs-support-t">Support the OSI project</div><div class="cs-support-s">Voluntary, direct wallet-to-wallet support for OSI in SOL. Non-custodial, and it does not influence review, ranking, or publication.</div><button class="cs-support-btn" onclick="openTip('${OSI_SUPPORT_WALLET}','OSI project support',0.5,'\u25ce Voluntary support')">\u25ce Support the OSI project</button></div>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}
// ---- community interactions ----
// ---- top-level view tabs ----
const VIEW_OF = { registry:'registry', how:'methodology', methodology:'methodology', 'case-studies':'research', community:'community', roadmap:'community', newsletter:'community' };
function showView(v){
  if(v!=='records' && typeof closeCaseDrawer==='function') closeCaseDrawer();
  if(v!=='registry' && typeof window.osiActivateRouteStyles==='function') window.osiActivateRouteStyles();
  document.body.dataset.view = v;
  if(v==='admin' && typeof renderAdminAccess==='function'){ renderAdminAccess({refresh:true}); }
  if(v==='identity' && typeof renderIdentity==='function'){ renderIdentity(); }
  if(v==='workspace' && typeof renderWorkspace==='function'){ renderWorkspace(); }
  if(v==='profile'){ renderProfile(); }
  if(v==='field'){ renderFieldOffice(); }
  if(v==='wire'){ renderWire({activatePublic:true}); }
  if(v==='analysts'){ renderLeaderboard(); }
  if(v==='prooflog'){ renderProofLog(); }
  if(v==='records'){ if(typeof renderCaseRecords==='function' && (typeof demoRecState==='undefined' || demoRecState===null)){ try{ renderCaseRecords(); }catch(e){} } }
  // Keep the address bar honest about which view is on screen, including for
  // the workspace routes that switch views without going through osiNavigate.
  if(typeof window.osiSyncRouteForView==='function') window.osiSyncRouteForView(v);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function identityRoleLabel(ctx){
  var role = (ctx && ctx.workspaceRole) || 'public';
  if(role === 'maintainer') return 'Maintainer';
  if(role === 'analyst') return 'Verified Analyst';
  if(role === 'wallet') return 'Connected Wallet';
  return 'Public';
}
function identityRoleClass(ctx){
  var role = (ctx && ctx.workspaceRole) || 'public';
  return role === 'maintainer' ? 'maintainer' : (role === 'analyst' ? 'analyst' : (role === 'wallet' ? 'wallet' : 'public'));
}
// The passport reads the same public V2 projections the rest of the product
// reads. It never asks for a wallet signature and never shows private Case or
// unpublished Report material: everything below comes from an answer any
// visitor could already fetch.
async function identityPublicRead(path, body){
  if(typeof window.osiPublicRead !== 'function') return null;
  try{ return await window.osiPublicRead(path, body); }catch(e){ return null; }
}
function identityTabs(){
  var tabs = [
    ['overview','Overview'],
    ['identity','Identity'],
    ['pow','Proof-of-Work'],
    ['analyst','Analyst Status'],
    ['cases','Cases & Reports'],
    ['settings','Settings']
  ];
  return '<div class="identity-tabs" role="tablist" aria-label="OSI Identity sections">'
    + tabs.map(function(t,i){ return '<button class="identity-tab'+(i===0?' active':'')+'" id="identity-tab-'+t[0]+'" type="button" role="tab" aria-selected="'+(i===0?'true':'false')+'" aria-controls="identity-panel-'+t[0]+'" tabindex="'+(i===0?'0':'-1')+'" data-tab="'+t[0]+'" onclick="identityTab(\''+t[0]+'\')" onkeydown="identityTabKeydown(event)">'+escapeHtml(t[1])+'</button>'; }).join('')
    + '</div>';
}
function identityTab(id, focusTab){
  var root = document.getElementById('identity-shell'); if(!root) return;
  var activeTab = null;
  root.querySelectorAll('.identity-tab').forEach(function(b){
    var on = b.getAttribute('data-tab') === id;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.setAttribute('tabindex', on ? '0' : '-1');
    if(on) activeTab = b;
  });
  root.querySelectorAll('.identity-pane').forEach(function(p){
    var on = p.getAttribute('data-pane') === id;
    p.classList.toggle('active', on);
    p.hidden = !on;
  });
  if(focusTab && activeTab) activeTab.focus();
}
function identityTabKeydown(event){
  if(!event || ['ArrowLeft','ArrowRight','Home','End'].indexOf(event.key) === -1) return;
  var list = event.currentTarget && event.currentTarget.closest('[role="tablist"]');
  if(!list) return;
  var tabs = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
  var current = tabs.indexOf(event.currentTarget);
  if(current < 0 || !tabs.length) return;
  event.preventDefault();
  var next = event.key === 'Home' ? 0 : (event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length);
  identityTab(tabs[next].getAttribute('data-tab'), true);
}
function identityHero(){
  var dots = ''; for(var i=0;i<20;i++){ dots += '<span></span>'; }
  return '<div class="identity-hero">'
    + '<div class="identity-hero-main"><div class="identity-kicker">OSI Identity</div>'
    + '<h1>Your Intelligence Passport</h1>'
    + '<p>Wallet-linked identity, role status, and proof-of-work across OSI.</p></div>'
    + '<div class="identity-mark" aria-hidden="true">'+dots+'</div>'
    + '</div>';
}
function identityUnavailable(text){
  return '<div class="identity-pow-v unavailable">'+escapeHtml(text || 'Not available yet')+'</div>';
}
function identityPowCard(label, value, note){
  var val = (value === null || value === undefined) ? identityUnavailable('Not available yet') : '<div class="identity-pow-v">'+escapeHtml(String(value))+'</div>';
  return '<div class="identity-pow-card"><div><div class="identity-pow-k">'+escapeHtml(label)+'</div>'+val+'</div><div class="identity-pow-s">'+escapeHtml(note || 'Verified source pending')+'</div></div>';
}
function identityPowGrid(m){
  var s = (m && m.stats) || {};
  return '<div class="identity-pow">'
    + identityPowCard('Cases Filed', s.casesFiled, 'Public Cases submitted by this wallet')
    + identityPowCard('Reports Submitted', s.reportsSubmitted, 'Immutable Case and Wire versions signed')
    + identityPowCard('Reviews Cast', s.reviews, 'Typed reviews recorded with a receipt')
    + identityPowCard('Challenges Filed', s.challenges, 'Public challenge records')
    + identityPowCard('Signed Actions', s.signedActions, 'Server-verified proof receipts')
    + identityPowCard('Published Records', s.publicRecords, 'Published Report and Wire versions')
    + identityPowCard('Support Sent', s.supportSent, 'Verified direct SOL transfers')
    + identityPowCard('Memo Anchors', s.memoAnchors, 'Confirmed Solana Memo receipts')
    + '</div>';
}
// Titles come from the shared Proof Log classifier so the passport, the Case
// drawer and the Proof Log always name the same receipt the same way.
function identityEventText(ev){
  if(typeof plMemo === 'function'){
    var mapped = plMemo(ev);
    if(mapped && mapped.title) return mapped.title;
  }
  var t = String((ev && ev.event_type) || 'signed_action');
  if(t === 'wire_dispatch') return 'Filed a Wire dispatch';
  if(t === 'analyst_vouch') return ev.vote === 'reject' ? 'Filed or supported a challenge' : 'Signed an analyst review';
  if(t === 'demand_signal') return 'Backed a case';
  return 'Signed an OSI action';
}
function identityProofLabel(ev){
  if(typeof plProofState === 'function') return plProofState(ev).label;
  return String((ev && ev.label) || 'Recorded receipt');
}
function identityActivity(m){
  var events = (m && m.events) || [];
  if(!events.length) return '<div class="identity-empty">No public signed activity yet.</div>';
  return '<div class="identity-activity">' + events.slice(0,8).map(function(ev){
    var reference = String(ev.target_public_ref || ev.item_id || '');
    var when = (typeof fdAgo === 'function') ? fdAgo(ev.created_at) : '';
    var meta = [identityProofLabel(ev), reference, when].filter(Boolean).join(' / ');
    var sig = String(ev.tx_sig || '');
    var link = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(sig)
      ? '<a href="https://solscan.io/tx/'+encodeURIComponent(sig)+'" target="_blank" rel="noopener">Verify</a>'
      : '<span></span>';
    return '<div class="identity-act-row"><i class="identity-act-dot"></i><div><b>'+escapeHtml(identityEventText(ev))+'</b><span>'+escapeHtml(meta)+'</span></div>'+link+'</div>';
  }).join('') + '</div>';
}
function identityStatusCard(m){
  var ctx = m.ctx || {};
  var connected = !!(ctx.walletConnected && m.wallet);
  var rows = ''
    + '<div class="identity-status-row"><span>Wallet connection</span><b>'+(connected ? '<span class="identity-status-pill">Connected</span>' : '<span class="identity-status-pill off">Not connected</span>')+'</b></div>'
    + '<div class="identity-status-row"><span>Wallet</span><b>'+escapeHtml(m.walletShort || 'Not connected')+'</b></div>'
    + '<div class="identity-status-row"><span>Verified analyst</span><b>'+escapeHtml(ctx.isVerifiedAnalyst ? 'Verified' : 'Not verified')+'</b></div>'
    + '<div class="identity-status-row"><span>Maintainer session</span><b>'+escapeHtml(ctx.isMaintainer ? 'Active' : 'Not active')+'</b></div>';
  // Weight, tier and status are the server-derived values from the public
  // analyst projection. No local score is computed for a governance figure.
  if(m.analystStatus){ rows += '<div class="identity-status-row"><span>Analyst status</span><b>'+escapeHtml(m.analystStatus.replace(/_/g,' '))+'</b></div>'; }
  if(m.analystTier){ rows += '<div class="identity-status-row"><span>Analyst tier</span><b>'+escapeHtml(m.analystTier.replace(/_/g,' '))+'</b></div>'; }
  if(m.analystWeight !== null && m.analystWeight !== undefined){ rows += '<div class="identity-status-row"><span>Counted review weight</span><b>'+escapeHtml(Number(m.analystWeight).toFixed(2))+'</b></div>'; }
  if(m.supportSol > 0){ rows += '<div class="identity-status-row"><span>Verified support sent</span><b>'+escapeHtml(String(Number(m.supportSol.toFixed(9))))+' SOL</b></div>'; }
  return '<div class="identity-card"><div class="identity-card-head"><div class="identity-card-title">Current Status</div><div class="identity-card-note">Read-only context</div></div>'+rows+'</div>';
}
function identityAvatarHtml(m, name){
  if(m && m.avatarUrl && typeof osiAvatarSvg === 'function'){
    return '<div class="identity-avatar">'+osiAvatarSvg(m.wallet, 80, name, m.avatarUrl || '')+'</div>';
  }
  var seed = String(name || (m && m.walletShort) || 'OSI').trim();
  var ch = (seed.charAt(0) || 'O').toUpperCase();
  return '<div class="identity-avatar identity-avatar-seal"><span class="identity-seal-code">OSI</span><span class="identity-seal-initial">'+escapeHtml(ch)+'</span></div>';
}
function identityPassport(m){
  var ctx = m.ctx || {};
  var name = m.displayName || m.walletShort || 'Connected wallet';
  var av = identityAvatarHtml(m, name);
  var bio = m.bio ? '<div class="identity-bio">'+escapeHtml(m.bio)+'</div>' : '<div class="identity-bio"><div class="identity-empty">No public operator note yet.</div></div>';
  return '<div class="identity-passport">'
    + '<div class="identity-operator">'+av+'<div>'
    + '<h2 class="identity-name">'+escapeHtml(name)+'</h2>'
    + '<div class="identity-wallet-line"><span class="identity-wallet-short">'+escapeHtml(m.walletShort || '')+'</span><button class="identity-copy" type="button" onclick="pfCopy(walletPubkey)">Copy</button></div>'
    + '<span class="identity-role '+identityRoleClass(ctx)+'">'+escapeHtml(identityRoleLabel(ctx))+'</span>'
    + '</div></div>' + bio + '</div>';
}
function identitySidebar(m){
  var ctx = m.ctx || {};
  return '<aside class="identity-sidebar" aria-label="Identity sidebar">'
    + '<div class="identity-sidebar-panel"><div class="identity-side-title">Wallet &amp; Security</div>'
    + '<div class="identity-side-row"><span>Connected wallet</span><b>'+escapeHtml(m.walletShort || 'Not connected')+'</b></div>'
    + '<div class="identity-side-row"><span>Network</span><b>Solana Mainnet</b></div>'
    + '<div class="identity-side-row"><span>Status</span><b>'+escapeHtml(ctx.walletConnected ? 'Connected' : 'Not connected')+'</b></div></div>'
    + '<div class="identity-sidebar-panel"><div class="identity-side-title">Profile Visibility</div>'
    + '<div class="identity-side-row"><span>Public profile</span><b>Not configured</b></div>'
    + '<div class="identity-readonly">Visibility controls are informational in this read-only passport.</div></div>'
    + '<div class="identity-sidebar-panel"><div class="identity-side-title">Quick Actions</div>'
    + '<button class="identity-action" type="button" onclick="osiV2OpenMyCases()"><span>My Cases</span><small>Private V2 Case read</small></button>'
    + '<button class="identity-action" type="button" onclick="osiV2OpenMyReports()"><span>My Reports</span><small>Immutable version history</small></button>'
    + '<button class="identity-action" type="button" onclick="osiAnalystOpenWorkspace(\'profile\')"><span>Analyst profile</span><small>Server-authorized workspace</small></button>'
    + '<button class="identity-action" type="button" onclick="osiAnalystOpenWorkspace(\'applications\')"><span>Applications</span><small>Wallet-signed versions</small></button>'
    + '</div></aside>';
}
function identityConnectHtml(ctx){
  var maint = ctx && ctx.isMaintainer ? '<div class="identity-empty identity-gate-note">Maintainer session is active. Connect a wallet to view the wallet-linked passport.</div>' : '';
  // The hero above already says "Your Intelligence Passport". Repeating it in
  // the card said the same thing twice on one screen and told the visitor
  // nothing about what to do next.
  return identityHero() + '<div class="identity-connect-state"><div class="identity-connect-card"><div class="identity-kicker">Wallet Required</div><h2>Connect a wallet to open your passport</h2><p>Your role status, signed actions, published records, and proof-of-work are read from the same public sources any visitor can read. This page is read-only and never asks for a signature.</p><button class="identity-connect" type="button" onclick="toggleWallet().then(function(){if(typeof renderIdentity===\'function\')renderIdentity();})">Connect Wallet</button>'+maint+'</div></div>';
}
// The same receipt can arrive through the Case projection, the Wire
// projection and the analyst history. Only fields all three carry may take
// part in the key, otherwise one action would be counted several times.
function identityReceiptKey(ev){
  return [ev.event_type, ev.tx_sig, ev.occurred_at || ev.created_at].map(function(value){
    return String(value == null ? '' : value);
  }).join('|');
}
function identityLamportsToSol(lamports){
  var text = String(lamports == null ? '0' : lamports);
  if(!/^\d+$/.test(text)) return 0;
  return Number(text) / 1e9;
}
// One pass over every receipt attributable to this wallet. Each counter maps
// to an exact registry event type, so a number here is always a receipt a
// visitor can open on Solscan or in the Proof Log; nothing is estimated.
function identityCollectStats(model, events){
  var stats = { casesFiled:0, reportsSubmitted:0, reviews:0, challenges:0, signedActions:events.length, publicRecords:model.stats.publicRecords || 0, supportSent:0, memoAnchors:0 };
  var supportLamports = 0;
  var filedCases = {};
  events.forEach(function(ev){
    var type = String(ev.event_type || '').toUpperCase();
    if(type === 'CASE_SUBMITTED') filedCases[String(ev.target_public_ref || ev.item_id || type)] = 1;
    if(type === 'CASE_REPORT_VERSION_SUBMITTED' || type === 'WIRE_REPORT_VERSION_SUBMITTED') stats.reportsSubmitted++;
    if(/_REVIEW_(CAST|REVISED)$/.test(type)) stats.reviews++;
    if(type === 'CHALLENGE_SUBMITTED') stats.challenges++;
    if(type === 'SUPPORT_PAYMENT_CONFIRMED' || type === 'REWARD_PAYMENT_CONFIRMED'){
      stats.supportSent++;
      var proof = ev.payment_proof || {};
      supportLamports += identityLamportsToSol(proof.recipient_amount_lamports != null ? proof.recipient_amount_lamports : proof.total_lamports);
    }
    if(typeof plProofState === 'function' && plProofState(ev).onchain === true) stats.memoAnchors++;
  });
  stats.casesFiled = Object.keys(filedCases).length;
  model.supportSol = supportLamports;
  return stats;
}
async function identityLoadModel(ctx){
  var W = String(ctx.wallet || '');
  var analystProfile = ctx.analystProfile || null;
  var localName = ''; try{ localName = lsGet('stw_profile_name','') || ''; }catch(e){}
  var model = {
    ctx:ctx, wallet:W, walletShort:workspaceShort(W),
    displayName:localName || workspaceShort(W), bio:'', avatarUrl:'',
    stats:{ casesFiled:null, reportsSubmitted:null, reviews:null, challenges:null, signedActions:null, publicRecords:null, supportSent:null, memoAnchors:null },
    events:[], analystWeight:null, analystTier:'', analystStatus:'', contributions:null,
    supportSol:0, sourceAvailable:false
  };
  var reads = await Promise.all([
    identityPublicRead('osi-v2-analyst', { op:'list_public_profiles' }),
    identityPublicRead('osi-v2-case-read', { op:'list_public_cases' }),
    typeof window.osiV2ListPublicWireReports === 'function'
      ? window.osiV2ListPublicWireReports().catch(function(){ return null; })
      : Promise.resolve(null)
  ]);
  var profiles = reads[0], publicCases = reads[1], publicWire = reads[2];
  model.sourceAvailable = !!(profiles || publicCases || publicWire);

  var serverProfile = null;
  if(profiles && Array.isArray(profiles.analysts)){
    serverProfile = profiles.analysts.find(function(row){ return String(row.wallet) === W; }) || null;
  }
  if(serverProfile){
    model.displayName = serverProfile.display_name || (serverProfile.handle ? ('@'+String(serverProfile.handle).replace(/^@/,'')) : model.displayName);
    model.bio = String(serverProfile.bio || '');
    model.analystWeight = serverProfile.weight == null ? null : Number(serverProfile.weight);
    model.analystTier = String(serverProfile.tier_code || '');
    model.analystStatus = String(serverProfile.status || '');
    model.contributions = Array.isArray(serverProfile.contributions) ? serverProfile.contributions.length : null;
  }else if(localName){
    model.displayName = localName;
  }else if(analystProfile && (analystProfile.name || analystProfile.handle)){
    model.displayName = analystProfile.name || ('@'+String(analystProfile.handle).replace(/^@/,''));
  }
  model.avatarUrl = (typeof osiAvatarUrl === 'function') ? osiAvatarUrl(W, serverProfile || analystProfile) : '';

  // Receipts for this wallet come from three public projections. The analyst
  // endpoint returns this wallet's own receipt history; the Case and Wire
  // projections carry every public receipt, filtered here to this actor.
  var seen = {}, events = [];
  function absorb(receipt, reference){
    if(!receipt || String(receipt.actor_wallet || '') !== W) return;
    var row = Object.assign({ proof_source:'native_public_dto' }, receipt);
    if(reference && !row.target_public_ref) row.target_public_ref = reference;
    row.created_at = row.occurred_at || row.created_at || null;
    // The Case and Wire projections state the proof claim in `label`. The
    // analyst history states it as `proof_type`, so it is mapped onto the same
    // vocabulary here rather than falling through to "legacy".
    if(!row.label){
      var type = String(row.proof_type || '');
      row.label = type === 'solana_memo' ? 'Memo-anchored on Solana'
        : type === 'wallet_signed_server_verified' ? 'Wallet-signed and server-verified'
        : type === 'system_event' ? 'System event' : '';
    }
    var key = identityReceiptKey(row);
    if(seen[key]) return;
    seen[key] = 1;
    events.push(row);
  }
  var publishedVersionRefs = {}, publicRecords = 0;
  if(publicCases && Array.isArray(publicCases.cases)){
    publicCases.cases.forEach(function(item){
      var reference = String(item.public_ref || '');
      (Array.isArray(item.proof_log) ? item.proof_log : []).forEach(function(receipt){ absorb(receipt, reference); });
      (Array.isArray(item.reports) ? item.reports : []).forEach(function(report){
        var current = report && report.current_version;
        if(report && report.published === true && current && current.version_ref){
          publishedVersionRefs[String(current.version_ref)] = 1;
        }
      });
    });
  }
  if(publicWire && Array.isArray(publicWire.reports)){
    publicWire.reports.forEach(function(item){
      var reference = String(item.version_public_ref || '');
      (Array.isArray(item.proof_log) ? item.proof_log : []).forEach(function(receipt){ absorb(receipt, reference); });
      if(item.author && String(item.author.wallet || '') === W && item.is_current_published !== false) publicRecords++;
    });
  }
  // Absorbed last so a richer public receipt always wins the de-duplication
  // over the same event seen through the analyst history.
  if(serverProfile && Array.isArray(serverProfile.proof_history)){
    serverProfile.proof_history.forEach(function(receipt){ absorb(receipt, ''); });
  }
  events.sort(function(left, right){
    return new Date(right.created_at || 0) - new Date(left.created_at || 0);
  });
  // A published record is one this wallet actually authored: the version it
  // signed is the version the public projection currently publishes. The
  // public Case projection never names an unpublished author, so nothing
  // private is inferred here.
  var countedVersions = {};
  events.forEach(function(ev){
    if(String(ev.event_type || '') !== 'CASE_REPORT_VERSION_SUBMITTED') return;
    var ref = String(ev.public_ref || ev.target_public_ref || '');
    if(!ref || countedVersions[ref] || !publishedVersionRefs[ref]) return;
    countedVersions[ref] = 1;
    publicRecords++;
  });
  model.events = events;
  // With no reachable projection every counter stays null and the passport
  // says "Not available yet" instead of showing a zero it cannot stand behind.
  if(model.sourceAvailable){
    model.stats.publicRecords = publicRecords;
    model.stats = identityCollectStats(model, events);
  }
  return model;
}
function identityConnectedHtml(m){
  var overview = '<div class="identity-pane active" id="identity-panel-overview" role="tabpanel" aria-labelledby="identity-tab-overview" data-pane="overview"><div class="identity-stack"><div class="identity-grid">'+identityPassport(m)+identityStatusCard(m)+'</div><div class="identity-card"><div class="identity-card-head"><div class="identity-card-title">Proof-of-Work</div><div class="identity-card-note">Live sources</div></div>'+identityPowGrid(m)+'</div><div class="identity-card"><div class="identity-card-head"><div class="identity-card-title">Recent Activity</div><div class="identity-card-note">Public proof trail</div></div>'+identityActivity(m)+'</div></div></div>';
  // Recorded values are values, not an empty state. They use the same labelled
  // row the sidebar uses, so a real display name never renders inside the
  // dashed "nothing here yet" box.
  var identityRow = function(label, value, missing){
    return '<div class="identity-record-row'+(missing ? ' is-missing' : '')+'"><span>'+escapeHtml(label)+'</span><b>'+escapeHtml(value)+'</b></div>';
  };
  var identityRecord = identityRow('Display name', m.displayName || 'Not set', !m.displayName)
    + identityRow('Wallet', m.walletShort || 'Not connected', !m.walletShort)
    + identityRow('Role', identityRoleLabel(m.ctx), false)
    + identityRow('Operator note', m.bio || 'No public operator note yet.', !m.bio);
  var identity = '<div class="identity-pane" id="identity-panel-identity" role="tabpanel" aria-labelledby="identity-tab-identity" data-pane="identity" hidden><div class="identity-card"><div class="identity-card-head"><div class="identity-card-title">Identity Record</div><div class="identity-card-note">Read-only</div></div><div class="identity-record">'+identityRecord+'</div></div></div>';
  var pow = '<div class="identity-pane" id="identity-panel-pow" role="tabpanel" aria-labelledby="identity-tab-pow" data-pane="pow" hidden><div class="identity-stack"><div class="identity-card"><div class="identity-card-head"><div class="identity-card-title">Proof-of-Work Ledger</div><div class="identity-card-note">No generated score</div></div>'+identityPowGrid(m)+'</div><div class="identity-card"><div class="identity-card-head"><div class="identity-card-title">Signed Activity</div><div class="identity-card-note">Proof log events</div></div>'+identityActivity(m)+'</div></div></div>';
  // A confirmed roster answer is a state, not an empty result, so it gets a
  // solid note with its own tone instead of the dashed placeholder box.
  var analystNote = m.ctx.isVerifiedAnalyst ? 'This wallet is on the verified analyst roster.' : 'This wallet is not currently on the verified analyst roster.';
  var analyst = '<div class="identity-pane" id="identity-panel-analyst" role="tabpanel" aria-labelledby="identity-tab-analyst" data-pane="analyst" hidden><div class="identity-stack"><div class="identity-card"><div class="identity-card-head"><div class="identity-card-title">Analyst Status</div><div class="identity-card-note">Server-derived roster</div></div><div class="identity-note'+(m.ctx.isVerifiedAnalyst?' is-verified':'')+'">'+escapeHtml(analystNote)+'</div><div class="osi-ws-actions"><button class="osi-ws-cta" type="button" onclick="osiAnalystOpenWorkspace(\'profile\')">Open analyst workspace</button><button class="osi-ws-cta" type="button" onclick="osiAnalystOpenWorkspace(\'applications\')">My applications</button></div></div>'+identityStatusCard(m)+'</div></div>';
  var cases = '<div class="identity-pane" id="identity-panel-cases" role="tabpanel" aria-labelledby="identity-tab-cases" data-pane="cases" hidden><div class="identity-card"><div class="identity-card-head"><div class="identity-card-title">Cases &amp; Reports</div><div class="identity-card-note">Authorized V2 reads</div></div>'+identityPowGrid(m)+'<div class="identity-readonly identity-section-note">Private Case and unpublished Report details are available only through their scoped wallet-authorized reads.</div><div class="osi-ws-actions"><button class="osi-ws-cta" type="button" onclick="osiV2OpenMyCases()">Open My Cases</button><button class="osi-ws-cta" type="button" onclick="osiV2OpenMyReports()">Open My Reports</button></div></div></div>';
  var settings = '<div class="identity-pane" id="identity-panel-settings" role="tabpanel" aria-labelledby="identity-tab-settings" data-pane="settings" hidden><div class="identity-card"><div class="identity-card-head"><div class="identity-card-title">Settings</div><div class="identity-card-note">Unavailable</div></div><div class="identity-empty">Profile and privacy settings require a dedicated server-authorized mutation. That mutation is not available, so this passport remains read-only.</div></div></div>';
  return identityHero() + identityTabs() + '<div class="identity-content"><main>'+overview+identity+pow+analyst+cases+settings+'</main>'+identitySidebar(m)+'</div>';
}
async function renderIdentity(){
  var host = document.getElementById('identity-body'); if(!host) return;
  var ctx = (typeof resolveWorkspaceContext === 'function') ? resolveWorkspaceContext() : { workspaceRole:'public', wallet:null, walletConnected:false, isMaintainer:false, isVerifiedAnalyst:false, analystProfile:null };
  if(!ctx.wallet){
    host.innerHTML = identityConnectHtml(ctx);
    return;
  }
  host.innerHTML = identityHero() + '<div class="identity-connect-state"><div class="identity-connect-card"><div class="identity-kicker">Loading</div><h2>Reading your public proof record</h2><p>Collecting this wallet\'s role, published records, and signed receipts from the public OSI projections.</p></div></div>';
  var model = await identityLoadModel(ctx);
  if(document.body && document.body.dataset && document.body.dataset.view === 'identity'){
    host.innerHTML = identityConnectedHtml(model);
  }
}
function workspaceShort(addr){
  if(!addr) return '';
  if(typeof short === 'function') return short(addr);
  addr = String(addr);
  return addr.length > 10 ? addr.slice(0,4) + '...' + addr.slice(-4) : addr;
}
function workspaceCard(title, note, action){
  return '<button class="osi-ws-card" type="button" onclick="'+action+'">'
    + '<b>'+escapeHtml(title)+'</b>'
    + '<span>'+escapeHtml(note)+'</span>'
    + '<i>Open</i>'
    + '</button>';
}
function workspaceCards(items){
  return '<div class="osi-ws-grid">' + items.map(function(it){ return workspaceCard(it[0], it[1], it[2]); }).join('') + '</div>';
}
function workspaceIdentityCard(ctx){
  var analystWorkspace = !!(ctx && ctx.isVerifiedAnalyst);
  return '<div class="osi-ws-identity">'
    + '<div><div class="osi-ws-identity-k">'+(analystWorkspace?'Analyst identity':'OSI Identity')+'</div><h2>'+(analystWorkspace?'Analyst workspace':'OSI Identity')+'</h2><p>'+(analystWorkspace?'Open your server-derived analyst profile and immutable application history.':'Open your wallet-linked intelligence passport, role status, and public proof record.')+'</p></div>'
    + '<button class="osi-ws-id-btn" type="button" onclick="'+(analystWorkspace?"osiAnalystOpenWorkspace('profile')":"osiNavigate('identity')")+'">'+(analystWorkspace?'Open Analyst Profile':'Open Intelligence Passport')+'</button>'
    + '</div>';
}
function renderWorkspace(){
  var host = document.getElementById('workspace-body');
  if(!host) return;
  var ctx = (typeof resolveWorkspaceContext === 'function') ? resolveWorkspaceContext() : { workspaceRole:'public', wallet:null, walletConnected:false, isMaintainer:false, isVerifiedAnalyst:false, permissions:{} };
  var role = ctx.workspaceRole || 'public';
  var title = 'OSI Workspace';
  var msg = 'Connect a wallet to see your cases, signed actions, and role.';
  var sideLabel = 'Workspace role';
  var sideValue = (typeof getWorkspaceRoleLabel === 'function') ? getWorkspaceRoleLabel(ctx) : 'Public Registry';
  var actions = '';
  var cards = '';

  if(role === 'wallet'){
    title = 'My OSI';
    msg = 'Your wallet-linked workspace for case work, report history, and signed activity.';
    sideLabel = 'Wallet';
    sideValue = workspaceShort(ctx.wallet);
    cards = workspaceCards([
      ['My Cases','Private and public Cases authorized for this wallet.',"osiV2OpenMyCases()"],
      ['My Reports','Exact immutable Report version history.',"osiV2OpenMyReports()"],
      ['My Wire Reports','Private and published Wire version history.',"osiV2OpenMyWireReports()"],
      ['Analyst Profile','Server-derived profile or application starting point.',"osiAnalystOpenWorkspace('profile')"],
      ['My Applications','Wallet-signed analyst application versions.',"osiAnalystOpenWorkspace('applications')"]
    ]);
  } else if(role === 'analyst'){
    title = 'Analyst Desk';
    msg = 'Verified analyst workspace for review, votes, reports, and reputation.';
    sideLabel = 'Wallet';
    sideValue = workspaceShort(ctx.wallet);
    cards = workspaceCards([
      ['My Reviews','Cases authorized for your typed review.',"osiV2OpenReviewQueue()"],
      ['Report Review Queue','Exact unpublished Report versions awaiting review.',"osiV2OpenReportQueue()"],
      ['Wire Review Queue','Exact Wire versions awaiting review.',"osiV2OpenWireQueue()"],
      ['My Reports','Exact immutable Report version history.',"osiV2OpenMyReports()"],
      ['My Wire Reports','Private and published Wire version history.',"osiV2OpenMyWireReports()"],
      ['Analyst Profile','Server-derived profile and application history.',"osiAnalystOpenWorkspace('profile')"]
    ]);
  } else if(role === 'maintainer'){
    title = 'Maintainer Console';
    msg = 'Maintainer workspace for publishing, moderation, analyst applications, and safety review.';
    sideLabel = ctx.wallet ? 'Maintainer wallet' : 'Session';
    sideValue = ctx.wallet ? workspaceShort(ctx.wallet) : 'Supabase auth active';
    cards = workspaceCards([
      ['Operations Center','Double-gated lifecycle and publication controls.',"admOpen()"],
      ['Case Review Queue','Native Case reviews authorized for this maintainer.',"osiV2OpenReviewQueue()"],
      ['Report Review Queue','Exact Report versions awaiting authorized review.',"osiV2OpenReportQueue()"],
      ['Wire Review Queue','Wire versions awaiting review or bootstrap publication inspection.',"osiV2OpenWireQueue()"],
      ['My Wire Reports','Private and published Wire version history.',"osiV2OpenMyWireReports()"],
      ['Analyst Applications','Double-gated application review queue.',"admOpen()"]
    ]);
  } else {
    actions = '<div class="osi-ws-actions"><button class="osi-ws-cta primary" type="button" onclick="toggleWallet().then(function(){if(typeof renderWorkspace===\'function\')renderWorkspace();})">Connect Wallet</button></div>';
  }

  var body = '<div class="osi-ws-body">' + workspaceIdentityCard(ctx) + cards + '</div>';
  host.innerHTML = '<div class="osi-ws-head">'
    + '<div><div class="osi-ws-kicker mono">'+escapeHtml(sideValue)+'</div><h1>'+escapeHtml(title)+'</h1><p class="osi-ws-msg">'+escapeHtml(msg)+'</p>'+actions+'</div>'
    + '<aside class="osi-ws-side" aria-label="Workspace context"><div class="l">'+escapeHtml(sideLabel)+'</div><div class="v">'+escapeHtml(sideValue)+'</div></aside>'
    + '</div>'
    + body;
}
