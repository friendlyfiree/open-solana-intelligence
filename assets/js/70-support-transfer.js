


// ===== Solana voluntary support: a real, CONFIRMED SOL transfer, wallet-to-wallet =====
// Non-custodial. OSI never holds, escrows, or routes the funds. Support is
// voluntary and does NOT influence review, ranking, consensus, publication, or
// sealing. Only an explicitly configured (OSI support wallet) or maintainer-
// attested (bounty winner) recipient is ever used; a reported/target wallet is
// never a recipient. Demo behaviour requires window.OSI_DEMO_MODE === true.
var SOL_UI_MAX = 100;                                  // reasonable per-transfer UI maximum (SOL)
var tipCtx = { wallet:null, amount:0.1, label:'', kind:'', item_type:null, item_id:null };
var tipFlow = { sending:false, stage:'idle' };         // idle | confirm | awaiting | confirming
var tipReturnFocus = null;

function tipFocusableElements(modal){
  if(!modal) return [];
  return Array.prototype.filter.call(
    modal.querySelectorAll('button:not([disabled]),input:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'),
    function(el){ return el.offsetParent !== null && el.getAttribute('aria-hidden') !== 'true'; }
  );
}
function tipHandleKeydown(event){
  var modal=document.getElementById('tip-modal');
  if(!modal || !modal.classList.contains('open')) return;
  if(event.key === 'Escape'){
    event.preventDefault();
    closeTip();
    return;
  }
  if(event.key !== 'Tab') return;
  var items=tipFocusableElements(modal);
  if(!items.length){
    event.preventDefault();
    var card=modal.querySelector('.tip-card'); if(card) card.focus();
    return;
  }
  var first=items[0], last=items[items.length-1];
  var activeIndex=items.indexOf(document.activeElement);
  if(event.shiftKey && (document.activeElement===first || activeIndex===-1)){ event.preventDefault(); last.focus(); }
  else if(!event.shiftKey && (document.activeElement===last || activeIndex===-1)){ event.preventDefault(); first.focus(); }
}
document.addEventListener('keydown', tipHandleKeydown);

// Safe SOL -> lamports. Numeric, positive, within the UI max, and no more than 9
// decimals (SOL precision). Integer lamports are composed from the decimal
// string, never via floating-point lamport math.
function osiSolToLamports(sol){
  var s = String(sol==null?'':sol).trim();
  if(!/^\d{1,7}(\.\d{1,9})?$/.test(s)) return null;    // digits only, no sign/exponent, <=9 decimals
  var n = Number(s);
  if(!isFinite(n) || n <= 0 || n > SOL_UI_MAX) return null;
  var parts = s.split('.');
  var whole = parts[0] || '0';
  var frac  = (parts[1] || '').padEnd(9,'0').slice(0,9);
  var lamports = Number(whole) * 1e9 + Number(frac);
  if(!Number.isSafeInteger(lamports) || lamports <= 0) return null;
  return lamports;
}
// A recipient is usable only if it is a valid Solana address and not the
// connected wallet itself.
function osiTipRecipientOk(){
  return !!(tipCtx && tipCtx.wallet && isSolAddr(tipCtx.wallet) &&
            (!walletPubkey || String(tipCtx.wallet)!==String(walletPubkey)));
}

// Build + submit a real System Program transfer through the connected wallet.
// Returns the submitted signature (NOT yet confirmed). Throws neutral codes.
async function sendTipTx(toWallet, lamports, memoText){
  const prov = getProvider();
  if(!prov) throw new Error("PROVIDER");
  if(!walletPubkey || !prov.publicKey || prov.isConnected === false) throw new Error("NOTCONNECTED");
  if(!isSolAddr(toWallet)) throw new Error("INVALID_RECIPIENT");
  if(!Number.isSafeInteger(lamports) || lamports <= 0) throw new Error("BAD_AMOUNT");
  const { PublicKey, Transaction, SystemProgram, TransactionInstruction } = solanaWeb3;
  const fromPub = new PublicKey(walletPubkey);
  let toPub;
  try{ toPub = new PublicKey(toWallet); }catch(e){ throw new Error("INVALID_RECIPIENT"); }
  if(toPub.equals(fromPub)) throw new Error("SELF_TRANSFER");

  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: fromPub, toPubkey: toPub, lamports: lamports }));
  if(memoText){
    tx.add(new TransactionInstruction({
      keys: [{ pubkey: fromPub, isSigner: true, isWritable: false }],
      programId: new PublicKey(MEMO_PROGRAM_ID),
      data: new TextEncoder().encode(memoText)
    }));
  }
  tx.feePayer = fromPub;
  const blockhash = await fetchRecentBlockhash();
  if(!blockhash) throw new Error("NETWORK");
  tx.recentBlockhash = blockhash;
  const submit = function(){ return prov.signAndSendTransaction(tx); };
  const signed = typeof window.osiV2ApproveTransaction === 'function'
    ? await window.osiV2ApproveTransaction(memoText || (toWallet+':'+lamports), submit)
    : await submit();
  return signed && signed.signature;
}

// Poll the RPC until the signature is confirmed/finalized. Returns true on
// confirmation, throws "ONCHAIN_FAILED" if the tx errored, returns false on
// timeout. Never fabricates a result: if web3 is unavailable we cannot confirm.
async function osiConfirmSignature(sig, timeoutMs){
  if(!sig || !window.solanaWeb3 || !solanaWeb3.Connection) return false;
  var C = solanaWeb3.Connection;
  var deadline = Date.now() + (timeoutMs || 60000);
  for(var k=0; k<RPC_FALLBACKS.length && Date.now()<deadline; k++){
    var conn;
    try{ conn = new C(RPC_FALLBACKS[k], "confirmed"); }catch(e){ continue; }
    while(Date.now() < deadline){
      try{
        var res = await conn.getSignatureStatuses([sig]);
        var s = res && res.value && res.value[0];
        if(s){
          if(s.err) throw new Error("ONCHAIN_FAILED");
          if(s.confirmationStatus==='confirmed' || s.confirmationStatus==='finalized') return true;
        }
      }catch(e){
        if(String(e && e.message)==='ONCHAIN_FAILED') throw e;
        break; // endpoint problem -> try the next endpoint
      }
      await new Promise(function(r){ setTimeout(r, 1500); });
    }
  }
  return false;
}

function tipSendBtn(){ return document.querySelector('.tip-send'); }
function setTipStatus(html){ var st=document.getElementById('tip-status'); if(st) st.innerHTML = html || ''; }
// Enable/disable the send button and reflect recipient/amount readiness.
function refreshTipSendState(){
  var btn = tipSendBtn(); if(!btn) return;
  if(tipFlow.sending) return;                          // don't fight an in-flight send
  var recipOk = osiTipRecipientOk();
  var lamports = osiSolToLamports(tipCtx.amount);
  tipFlow.stage = 'idle';
  btn.textContent = 'Review & send →';
  btn.disabled = !(recipOk && lamports!==null);
  if(!recipOk){ setTipStatus('<span class="tip-err">Support recipient unavailable.</span>'); }
  else if(lamports===null){ setTipStatus('<span class="tip-err">Enter a valid amount (up to '+SOL_UI_MAX+' SOL).</span>'); }
  else { setTipStatus(''); }
}
function openTip(wallet, label, amount, title, meta){
  meta = meta || {};
  var preset = (amount && Number(amount) > 0) ? Number(amount) : 0.1;
  tipCtx = { wallet: wallet, amount: preset, label: label || 'OSI project support',
             kind: meta.kind || 'osi', item_type: meta.item_type || null,
             item_id: (meta.item_id!=null ? meta.item_id : null) };
  tipFlow = { sending:false, stage:'idle' };
  var hd=document.getElementById('tip-h'); if(hd) hd.textContent = title || '◎ Voluntary support';
  var lab=document.getElementById('tip-label'); if(lab) lab.textContent = tipCtx.label;
  var ad=document.getElementById('tip-addr'); if(ad) ad.textContent = (wallet && isSolAddr(wallet)) ? short(wallet) : '';
  var cu=document.getElementById('tip-custom'); if(cu) cu.value='';
  var presets=[0.05,0.1,0.5,1];
  var idx=presets.indexOf(preset);
  document.querySelectorAll('.tip-amt').forEach(function(b,i){ b.classList.toggle('active', i===idx); });
  if(idx===-1 && cu){ cu.value = preset; }
  updateTipUsd();
  resetSolanaPay();
  refreshTipSendState();
  var m=document.getElementById('tip-modal');
  if(m){
    tipReturnFocus = document.activeElement && typeof document.activeElement.focus==='function' ? document.activeElement : null;
    m.classList.add('open');
    m.setAttribute('aria-hidden','false');
    var card=m.querySelector('.tip-card'); if(card) window.setTimeout(function(){ card.focus(); },0);
  }
}
function closeTip(){
  var m=document.getElementById('tip-modal');
  if(m){ m.classList.remove('open'); m.setAttribute('aria-hidden','true'); }
  tipFlow={sending:false,stage:'idle'};
  var target=tipReturnFocus; tipReturnFocus=null;
  if(target && target.isConnected && typeof target.focus==='function') window.setTimeout(function(){ target.focus(); },0);
}
function setTipAmt(a, btn){
  tipCtx.amount = a;
  document.querySelectorAll('.tip-amt').forEach(function(b){ b.classList.remove('active'); });
  if(btn) btn.classList.add('active');
  var cu=document.getElementById('tip-custom'); if(cu) cu.value='';
  updateTipUsd(); refreshTipSendState();
}
function setTipCustom(v){
  var a = parseFloat(v);
  if(!isNaN(a) && a > 0){ tipCtx.amount = a; document.querySelectorAll('.tip-amt').forEach(function(b){ b.classList.remove('active'); }); }
  updateTipUsd(); refreshTipSendState();
}
function updateTipUsd(){
  var el=document.getElementById('tip-usd');
  if(el) el.textContent = SOL_PRICE ? ('≈ $'+(tipCtx.amount*SOL_PRICE).toLocaleString(undefined,{maximumFractionDigits:2})+' at the current SOL price') : '';
  renderSolanaPay();
}
// Send button. First click validates and shows an explicit confirmation summary;
// second click requests the wallet signature. Hard-guarded against double sends.
function confirmTip(){
  if(tipFlow.sending) return;
  if(!osiTipRecipientOk()){ refreshTipSendState(); return; }
  var lamports = osiSolToLamports(tipCtx.amount);
  if(lamports===null){ refreshTipSendState(); return; }
  var btn = tipSendBtn();
  if(tipFlow.stage !== 'confirm'){
    tipFlow.stage = 'confirm';
    if(btn) btn.textContent = 'Confirm · sign in your wallet';
    setTipStatus(
      '<div class="tip-confirm mono">Send <b>'+escapeHtml(String(tipCtx.amount))+' SOL</b> to <b>'+escapeHtml(tipCtx.label)+'</b> '
      + '<span style="color:var(--ink-faint)">'+escapeHtml(short(tipCtx.wallet))+'</span><br>'
      + 'Direct wallet-to-wallet · OSI does not custody funds · Support does not affect review or publication.'
      + '<br><button type="button" class="tip-cancel" onclick="cancelTipConfirm()">Cancel</button></div>'
    );
    return;
  }
  osiTipSend(lamports);
}
function cancelTipConfirm(){
  if(tipFlow.sending) return;
  tipFlow.stage = 'idle';
  var btn = tipSendBtn(); if(btn){ btn.disabled=false; btn.textContent='Review & send →'; }
  setTipStatus('<span class="mono" style="color:var(--ink-faint)">Cancelled.</span>');
}
// Actually perform the transfer: request signature, wait for RPC confirmation,
// and only then show success + record the event with the REAL signature.
async function osiTipSend(lamports){
  var btn = tipSendBtn();
  tipFlow.sending = true; tipFlow.stage = 'awaiting';
  if(btn){ btn.disabled = true; btn.textContent = 'Working…'; }
  try{
    if(!walletPubkey){
      setTipStatus('<span class="mono" style="color:var(--ink-dim)">Connect your wallet to continue…</span>');
      if(typeof toggleWallet==='function'){ try{ await toggleWallet(); }catch(e){} }
      if(!walletPubkey){ setTipStatus('<span class="tip-err">Wallet not connected.</span>'); return; }
    }
    if(String(tipCtx.wallet)===String(walletPubkey)){ setTipStatus('<span class="tip-err">That is your own wallet.</span>'); return; }
    var memo = 'OSI1|SUPPORT_SENT|from='+walletPubkey+'|to='+tipCtx.wallet+'|amount='+tipCtx.amount+'|ts='+Math.floor(Date.now()/1000);
    setTipStatus('<span class="mono" style="color:var(--ink-dim)">Awaiting your approval in the wallet…</span>');
    var sig;
    try{
      sig = await sendTipTx(tipCtx.wallet, lamports, memo);
    }catch(e){
      var m = String((e && e.message) || e || '');
      var friendly;
      if(/reject|denied|cancel|user/i.test(m)) friendly='Signature cancelled.';
      else if(/insufficient|0x1\b|debit/i.test(m)) friendly='Not enough SOL for that amount plus the network fee.';
      else if(/NETWORK/i.test(m)) friendly='Could not reach the Solana network. Try again shortly.';
      else if(/NOTCONNECTED|PROVIDER/i.test(m)) friendly='Wallet not connected.';
      else if(/INVALID_RECIPIENT/i.test(m)) friendly='The recipient address is invalid.';
      else if(/SELF_TRANSFER/i.test(m)) friendly='That is your own wallet.';
      else if(/BAD_AMOUNT/i.test(m)) friendly='Enter a valid amount.';
      else if(/Buffer/i.test(m)) friendly='The wallet library is still loading, try once more in a second.';
      else friendly='The transfer was not sent.';
      setTipStatus('<span class="tip-err">'+escapeHtml(friendly)+'</span>');
      return;
    }
    if(!sig){ setTipStatus('<span class="tip-err">The transfer was not sent.</span>'); return; }
    setTipStatus('<span class="mono" style="color:var(--ink-dim)">Confirming on Solana…</span>');
    tipFlow.stage = 'confirming';
    var confirmed=false, failed=false;
    try{ confirmed = await osiConfirmSignature(sig, 60000); }
    catch(e){ failed = true; }
    var solUrl = 'https://solscan.io/tx/'+encodeURIComponent(sig);
    if(failed){
      setTipStatus('<span class="tip-err">The transfer failed on-chain. <a href="'+solUrl+'" target="_blank" rel="noopener">view on Solana ↗</a></span>');
      return;
    }
    if(!confirmed){
      setTipStatus('<span class="tip-err">Submitted, but confirmation timed out. <a href="'+solUrl+'" target="_blank" rel="noopener">check on Solana ↗</a></span>');
      return;
    }
    // Confirmed. Only now: success + record the event with the confirmed signature.
    setTipStatus('<span class="tip-ok">✓ Sent '+escapeHtml(String(tipCtx.amount))+' SOL. <a href="'+solUrl+'" target="_blank" rel="noopener">view on Solana ↗</a></span>');
    if(typeof recordOnchainEvent==='function'){
      recordOnchainEvent({ event_type:'support', amount:tipCtx.amount, token:'SOL',
        item_type:tipCtx.item_type||null, item_id:(tipCtx.item_id!=null?tipCtx.item_id:null),
        label:'voluntary support', memo_text:memo, tx_sig:sig });
    }
    if(typeof showToast==='function') showToast('Support sent ✓');
  } finally {
    tipFlow.sending = false; tipFlow.stage = 'idle';
    var b2 = tipSendBtn(); if(b2){ b2.disabled = false; b2.textContent = 'Review & send →'; }
  }
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


function bountyTargetText(card){ const t = card.querySelector('.b-target'); return (t && t.textContent.trim().slice(0,80)) || "case"; }

// Reflect a boosted bounty in the UI (used on click and after a refresh).
function markBoostedUI(card, sig){
  const btn = card.querySelector('.btn-stake, [data-wire-interest]'); if(!btn) return;
  btn.dataset.signalState = 'complete';
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
async function stakeBoost(btn){
  const card = btn.closest('.bounty'); if(!card) return;
  const bid = card.dataset.bid;
  const mine = lsGet('stw_boosted', {});
  if(btn.disabled || btn.dataset.signalState==='pending' || btn.dataset.signalState==='complete') return;
  if(bid && mine[bid]){ markBoostedUI(card, mine[bid].tx || null); return; }
  btn.dataset.signalState = 'pending';
  btn.disabled = true;
  btn.textContent = 'Awaiting approval…';
  const _bts = Math.floor(Date.now()/1000);
  const memo = "OSI_CASE_BACKED|case_id=" + (bid||"") + "|subject=" + String(bountyTargetText(card)).replace(/\|/g,"/") + "|backer=" + (walletPubkey||"") + "|ts=" + _bts;
  let completed = false;
  try{
    await withOnchainVote("Boost", memo, async (sig)=>{
      const numEl = card.querySelector('.b-reward .n');
      if(numEl){ numEl.textContent = (parseInt(numEl.textContent) || 0) + 1; }
      if(bid){ const stored = lsGet('stw_boosted', {}); stored[bid] = { name: bountyTargetText(card), tx: sig, ts: Date.now() }; lsSet('stw_boosted', stored); }
      markBoostedUI(card, sig);
      completed = true;
      recordOnchainEvent({ event_type:'demand_signal', item_type:'bounty', item_id:bid, label:'pledged demand for '+bountyTargetText(card), memo_text:memo, tx_sig:sig });
      if(SUPA_ON && bid){ try{ await supaPost('bounty_boosts', { bounty_id: bid, voter: voterId() }); hydrateBoosts(); }catch(e){ console.warn('OSI: boost sync failed.', e); } }
    });
  }finally{
    if(!completed){
      btn.dataset.signalState = 'idle';
      btn.disabled = false;
      btn.textContent = 'Signal interest';
    }
  }
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
      const c = Math.max(counts[card.dataset.bid] || 0, mine[card.dataset.bid] ? 1 : 0);
      n.textContent = c; counts[card.dataset.bid] = c;
    });
    window.boostCounts = counts;
    if(typeof fieldUpdateDemand==='function') fieldUpdateDemand();
  }catch(e){ console.warn('OSI: boost counts unavailable, showing local view.', e); }
}
