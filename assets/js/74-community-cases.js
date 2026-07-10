

// ---- Community cases: anyone can OPEN a case (public after maintainer approval) ----
async function submitBounty(){
  const target=(document.getElementById('bf-target').value||'').trim();
  const detail=(document.getElementById('bf-detail').value||'').trim();
  const rewardSol=parseFloat((document.getElementById('bf-reward').value||'').trim())||0;
  if(!target){ showToast("Name the target of the bounty (a company or wallet set)."); return; }
  if(!detail){ showToast("Describe what the bounty needs proven (trace, custody, corroboration)."); return; }
  if(!rateOk('submit', 6000)){ showToast("Give it a few seconds between submissions."); return; }
  var _sgB = safetyGate(target + "\n" + detail);
  if(!_sgB.ok){ osiBlockShow(_sgB.hits); return; }
  const id='bnt_'+Date.now();   // id exists before signing so the memo can reference case=<id>
  osiSignEvent({
    eventType: 'CASE_SUBMITTED',
    actionLabel: 'Open a case',
    caseId: id,
    itemType: 'bounty',
    itemId: id,
    sensitive: true,            // no subject/allegation in memo, memo_text, or label
    onSuccess: async (sig)=>{
    let img='';
    try{ img = await uploadPicked('bf'); }
    catch(e){ showToast("Image upload failed, filing the case without it."); }
    const mine=lsGet('stw_bounties',[]); mine.unshift({ id, target, detail, reward_sol:rewardSol, image:img, tx: sig||'', sub: SUPA_ON?'\u23f3 awaiting maintainer approval':'proposed here' }); lsSet('stw_bounties',mine);
    ['bf-target','bf-detail','bf-reward'].forEach(function(x){ const el=document.getElementById(x); if(el) el.value=''; });
    if(SUPA_ON){ try{ const brow = { id, title:target, target, detail, reward_sol:rewardSol, created_by: walletPubkey||'', approved:false }; if(img) brow.image = img; await supaPost('bounties', brow); renderFieldOffice(); }catch(e){ console.warn('OSI: bounty publish failed.',e); } }
    try{ await sendForm({ _subject:'OSI, New Bounty: '+target, type:'bounty-proposal', target, detail, reward: rewardSol?rewardSol+' SOL':'(none)', by: walletPubkey||'(none)', tx: sig||'(none)' }); }catch(e){}
    clearPickedFile('bf');
    fieldCloseForm();
    showToast(SUPA_ON?'\u2713 Case signed on-chain \u00b7 now in peer review. It publishes when analyst consensus reaches '+CONSENSUS_THRESHOLD+' weight.':'\u2713 Case proposed \u00b7 it enters peer review.');
    }
  });
}

// Reflect an applied bounty in the UI (used on click and after a refresh).
function markAppliedUI(card, sig){
  const btn = card.querySelector('.btn-apply'); if(!btn) return;
  // applied, but keep it clickable so a researcher can file more than one report
  btn.textContent = "✦ Apply again"; btn.disabled = false;
  if(sig && !card.querySelector('.apply-tx')){
    const note = document.createElement('div'); note.className = "apply-tx mono";
    note.style.cssText = "font-size:9px;color:#b98cff;margin-top:4px";
    note.innerHTML = `<a href="https://solscan.io/tx/${sig}" target="_blank" rel="noopener" style="color:#b98cff;text-decoration:none">↗ application on-chain ✓</a>`;
    btn.parentElement.appendChild(note);
  }
}
// Clear this browser's local draft submissions + applied marks (e.g. test data).
function clearMyDrafts(){
  lsSet('stw_reports', []); lsSet('stw_applied', {});
  renderReviewQueue();
  document.querySelectorAll('.bounty[data-bid] .btn-apply').forEach(function(b){ b.disabled=false; b.textContent='✦ Apply'; const tx=b.parentElement.querySelector('.apply-tx'); if(tx) tx.remove(); });
  showToast('Your local drafts were cleared from this device.');
}

// ---- Apply to a bounty: open a report form, sign it with the wallet, file it
// as a pending report that goes public once a maintainer approves. ----
let applyCtx = { bid: '', target: '' };

function openApplyModal(btn){
  const card = btn.closest('.bounty'); if(!card) return;
  applyCtx = { bid: card.dataset.bid, target: bountyTargetText(card) };
  const nm = document.getElementById('apply-bounty-name'); if(nm) nm.textContent = '🎯 ' + applyCtx.target;
  const rep = document.getElementById('apply-report'); if(rep) rep.value = '';
  clearPickedFile('apply');
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
  if(!report){ showToast("Write up your findings before submitting."); return; }
  if(!rateOk('submit', 6000)){ showToast("Give it a few seconds between submissions."); return; }
  var _sgR = safetyGate(report);
  if(!_sgR.ok){ osiBlockShow(_sgR.hits); return; }
  const target = applyCtx.target, bid = applyCtx.bid;
  const id = 'rep_' + Date.now();   // id exists before signing so the memo can reference report=<id>
  osiSignEvent({
    eventType: 'REPORT_SUBMITTED',
    actionLabel: 'Submit report',
    caseId: bid,                    // the case this report is filed under
    reportId: id,
    itemType: 'report',
    itemId: id,
    sensitive: true,               // no report summary/allegation in memo, memo_text, or label
    onSuccess: async (sig)=>{
    let att = '';
    try{ att = await uploadPicked('apply'); }
    catch(e){ showToast("Attachment upload failed, submitting without it."); }
    const reports = lsGet('stw_reports', []);
    reports.unshift({ id, bounty: target, company: target, summary: report, onchain: '', offchain: '', attachment: att, wallet: walletPubkey || '', tx: sig || '', up: 0, dn: 0 });
    lsSet('stw_reports', reports);
    if(bid){ const mine = lsGet('stw_applied', {}); mine[bid] = true; lsSet('stw_applied', mine); const c = document.querySelector('.bounty[data-bid="' + bid + '"]'); if(c) markAppliedUI(c, sig); }
    if(SUPA_ON){ try{ const row = { id, bounty: target, company: target, wallet: walletPubkey || '', summary: report, onchain: '', offchain: '', tx: sig || '', approved: false }; if(att) row.attachment = att; await supaPost('reports', row); }catch(e){ console.warn('OSI: report publish failed.', e); } }
    try{ await sendForm({ _subject: 'OSI, Bounty Report: ' + target, type: 'bounty-report', bounty: target, wallet: walletPubkey || '(none)', summary: report, attachment: att || '(none)', tx: sig || '(none)' }); }catch(e){}
    clearPickedFile('apply');
    closeApplyModal();
    renderReviewQueue();
    openCommunityTab('tab-analysts');
    const q = document.getElementById('review-list'); if(q) q.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast("\u2713 Submission signed on-chain and sent, pending maintainer approval.");
    }
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

// Superseded: the peer review queue is now #consensus-floor (renderReviewFloor),
// and published reports live in Public Records (renderCaseRecords). This old
// forum-style list under #review-list duplicated both, so it is retired.
// Kept as a no-op that clears the mount point so existing call sites stay safe.
function renderReviewQueue(){
  const host = document.getElementById('review-list');
  if(host) host.innerHTML = '';
}

// Pull maintainer-approved reports from the shared backend so every visitor
// sees them; the submitter still sees their own not-yet-approved reports.
// Retired alongside renderReviewQueue: published reports are shown in Public
// Records now, not in this Analysts-tab forum list. No-op keeps callers safe.
async function hydrateReportsFromSupabase(){
  const host = document.getElementById('review-list');
  if(host) host.innerHTML = '';
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
  showView('analysts');
  openCommunityTab(id);
  if(typeof renderAnalysts==='function') renderAnalysts();
  if(typeof renderReviewFloor==='function') renderReviewFloor();
}

// Analyst application, sends Telegram / X handles + optional proof to the
// maintainer via Formspree. No mail client opens, no page jump.
async function submitAnalystApplication(){
  if(!isSolAddr(walletPubkey||'')){ showToast("Connect your Solana wallet first. Your analyst identity and reputation are tied to it."); return; }
  const tg  = (document.getElementById('an-tg').value || '').trim();
  const tw  = (document.getElementById('an-tw').value || '').trim();
  const web = (document.getElementById('an-web').value || '').trim();
  if(!tg && !tw){ showToast("Add your Telegram or X username so the maintainer can reach you."); return; }
  if(!rateOk('apply', 30000)){ showToast("You just sent an application. Give the maintainer a moment."); return; }
  const handle = tg || tw;
  if(SUPA_ON && isSolAddr(walletPubkey||'')){
    try{ await supaUpsertAnalyst({ wallet: walletPubkey, handle:(tw||'').replace(/^@/,'')||null, telegram:(tg||'').replace(/^@/,'')||null, link: web||null, verified:false, approved:false }); }catch(e){}
  }
  try{
    const res = await sendForm({ _subject: 'OSI, Analyst Application: ' + handle, type: 'analyst-application', telegram: tg || '(none)', twitter: tw || '(none)', website: web || '(none)' });
    if(res.ok){
      ['an-tg','an-tw','an-web'].forEach(id=>document.getElementById(id).value='');
      lsSet('stw_applied_analyst', true);
      showToast('✓ Application sent, the maintainer will get back to you.');
    } else {
      showToast('Could not send right now, please try again later.');
    }
  }catch(e){ showToast('Could not send right now, please try again later.'); }
}

// Direct inline subscribe, posts to Formspree, never opens a mail app.

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