
// ============================================================
//  ON-CHAIN AUDIT INDEX  (surface the signed actions that already happen)
//  Best-effort, additive: never blocks or reverses any action. The
//  on-chain memo transaction is the real proof; Supabase is just an index.
// ============================================================
function solscanTx(sig){ return 'https://solscan.io/tx/' + encodeURIComponent(sig); }
async function recordOnchainEvent(ev){
  if(typeof SUPA_ON==='undefined' || !SUPA_ON || !ev || !ev.tx_sig) return;
  try{
    await supaPost('onchain_events', {
      event_type:   ev.event_type || 'event',
      actor_wallet: ev.actor_wallet || (typeof walletPubkey!=='undefined' ? walletPubkey : null) || null,
      item_type:    ev.item_type || null,
      item_id:      (ev.item_id!=null) ? String(ev.item_id) : null,
      vote:         ev.vote || null,
      amount:       (ev.amount!=null && ev.amount!=='') ? Number(ev.amount) : null,
      token:        ev.token || null,
      label:        ev.label || null,
      memo_text:    ev.memo_text || null,
      tx_sig:       ev.tx_sig,
      status:       'confirmed'
    });
  }catch(e){ /* the on-chain memo tx remains the source of truth */ }
}
// ============================================================
//  OSI signed-event helper layer (Stage 1)
//  Thin, additive wrapper over withOnchainVote + recordOnchainEvent.
//  New events use the OSI1 memo grammar. No allegation text, rejection
//  reasons, or AI-Pack content ever goes into the memo or memo_text.
// ============================================================
function osiSignerRole(){
  try{
    if(typeof resolveMaintainerAccess === 'function' && resolveMaintainerAccess().allowed) return 'maintainer';
    if(typeof isVerifiedAnalyst === 'function' && isVerifiedAnalyst(walletPubkey)) return 'analyst';
  }catch(e){}
  return 'user';
}
function osiSanitizeMemoField(v){ return String(v==null?'':v).replace(/[|\r\n]/g,'/').slice(0,64); }
// OSI1|<EVENT_TYPE>|case=<case_id>|report=<report_id>|actor=<wallet>|role=<role>|ts=<unix>
function osiBuildMemo(eventType, o){
  o = o || {};
  return 'OSI1|' + String(eventType)
    + '|case='   + osiSanitizeMemoField(o.caseId   || '')
    + '|report=' + osiSanitizeMemoField(o.reportId || '')
    + '|actor='  + osiSanitizeMemoField(o.actor || (typeof walletPubkey!=='undefined' ? walletPubkey : '') || 'anon')
    + '|role='   + osiSanitizeMemoField(o.role  || osiSignerRole())
    + '|ts='     + (o.ts || Math.floor(Date.now()/1000));
}
// Map OSI1 event types to the DB event_type strings the Proof Log reader
// (plGroup) already recognizes, so no reader change is needed.
function osiEventTypeToDb(eventType){
  var m = { CASE_SUBMITTED:'case_opened', REPORT_SUBMITTED:'report_submitted' };
  return m[String(eventType)] || String(eventType).toLowerCase();
}
// Sign an OSI1 memo, then (best-effort) index it into onchain_events.
// opts: { eventType, actionLabel, caseId, reportId, itemType, itemId,
//         vote, amount, token, publicLabel, sensitive, onSuccess }
async function osiSignEvent(opts){
  opts = opts || {};
  var ts = Math.floor(Date.now()/1000);
  var role = osiSignerRole();
  var memo = osiBuildMemo(opts.eventType, {
    caseId: opts.caseId, reportId: opts.reportId, role: role, ts: ts
  });
  await withOnchainVote(opts.actionLabel || opts.eventType, memo, async function(sig){
    try{
      if(typeof recordOnchainEvent === 'function'){
        recordOnchainEvent({
          event_type: osiEventTypeToDb(opts.eventType),
          item_type:  opts.itemType || null,
          item_id:    opts.itemId || opts.caseId || opts.reportId || null,
          vote:       opts.vote || null,
          amount:     (opts.amount != null && opts.amount !== '') ? Number(opts.amount) : null,
          token:      opts.token || null,
          // Privacy: sensitive/intake events store NO narrative label or memo_text.
          label:      opts.sensitive ? null : (opts.publicLabel || null),
          memo_text:  opts.sensitive ? null : memo,
          tx_sig:     sig
        });
      }
    }catch(e){ /* on-chain memo tx remains source of truth */ }
    if(typeof opts.onSuccess === 'function') await opts.onSuccess(sig, memo);
  });
}
function raShortW(w){ w=String(w||''); return w.length>8 ? (w.slice(0,4)+'\u2026'+w.slice(-4)) : (w||'someone'); }
function raSignedItem(ev){
  var w=raShortW(ev.actor_wallet);
  var item=escapeHtml(String(ev.item_id||'').slice(0,12));
  var type=escapeHtml(ev.item_type||'item');
  var ic='\u2605', label, signed='Signed memo';
  if(ev.event_type==='analyst_vouch'){ ic='\u2713'; label='Analyst <b>'+w+'</b> '+(ev.vote==='approve'?'approved':'challenged')+' '+type+(item?(' '+item):''); }
  else if(ev.event_type==='report_submitted'){ ic='\u25a4'; label='Researcher <b>'+w+'</b> filed a report'+(ev.label?(' '+escapeHtml(String(ev.label).replace(/^filed report on /,'on '))):''); }
  else if(ev.event_type==='wire_dispatch'){ ic='\u25c8'; label='Analyst <b>'+w+'</b> filed a dispatch'+(ev.label?(' '+escapeHtml(String(ev.label).replace(/^filed a dispatch on /,'on '))):''); }
  else if(ev.event_type==='demand_signal'){ ic='\u25ce'; label='<b>'+w+'</b> backed the case'+(ev.label?(' '+escapeHtml(String(ev.label).replace(/^pledged demand for /,'for '))):''); }
  else if(ev.event_type==='support'){ ic='\u25ce'; signed='Signed transfer'; label='<b>'+w+'</b> sent '+(ev.amount!=null?(escapeHtml(String(ev.amount))+' '+escapeHtml(ev.token||'SOL')):'support')+(ev.label?(' '+escapeHtml(String(ev.label).replace(/^supported /,'to support '))):''); }
  else if(ev.event_type==='maintainer_seal'){ ic='\u2713'; label='Maintainer <b>'+w+'</b> sealed '+type+(item?(' '+item):'')+' as a public record'; }
  else { label='<b>'+w+'</b> signed an action'; }
  var link=ev.tx_sig?(' \u00b7 <a href="'+solscanTx(ev.tx_sig)+'" target="_blank" rel="noopener" class="ra-solscan">'+signed+' \u2197</a>'):'';
  return '<div class="ra-item"><span class="ra-ic sgn">'+ic+'</span><div class="ra-tx"><div class="ra-t">'+label+'</div><div class="ra-m">'+raTimeAgo(ev.created_at)+link+'</div></div></div>';
}
// ============================================================
//  INTELLIGENCE BRIEFING  (interactive product walkthrough)
//  A demo cursor walks in from the controls, "presses", the
//  element lights up, real boxes open. Pure visual simulation:
//  no wallet, no submit, no on-chain, no Supabase write, and no
//  typing into the page while it runs. Findings are framed as
//  high-confidence, not certainty.
// ============================================================
var DEMO_WALK = 720; // cursor travel time, matches the CSS transition

var DEMO_STEPS = [
  { view:'registry', sel:'.hero h1', sel2:'.hero-main', noCursor:true, dur:7000,
    title:'Open Solana Intelligence',
    body:'A guided tour, no wallet and no signup. OSI is an open, community-run desk for on-chain Solana incidents: a drained wallet, a rug, a scam. Anyone opens a case for free, analysts trace it on-chain, and the finding becomes a public record. It never promises to recover funds.' },
  { view:'registry', sel:'#how-osi-works .home-flow-grid', sel2:'#how-osi-works', noCursor:true, dur:8500,
    title:'How OSI works',
    body:'Open a case, trace the trail, review the evidence, and seal the record. The homepage now shows the whole flow as four compact steps for a fast reviewer pass.' },
  { view:'registry', sel:'#safeguards .home-trust-grid', sel2:'#safeguards', dur:9500,
    title:'Why trust OSI',
    body:'OSI is built around wallet-signed actions, human review, and non-custodial limits. It documents public evidence without claiming recovery, custody, or legal certainty.' },
  { view:'records', sel:'#case-records .cr-card', sel2:'#records-hero', dur:9000,
    title:'The public case archive',
    body:'Reviewed and sealed cases live here as compact, verifiable records: the case id, an honest status of Reviewed or Sealed, the on-chain evidence, and any reviewed packs. It reads like an intelligence archive, not a feed.' },
  { view:'records', box:'demoBoxRecord', modalMode:true, modalPoint:'.crd-dl', cardLeft:true, dur:11000,
    title:'Open a record, download the packs',
    body:'Open any record and the full dossier slides in: verification on Solana, the summary, the evidence, the analyst-review status, and the reviewed escalation packs ready to download. Drafts are never shown in public, only reviewed work.' },
  { view:'registry', sel:'.osi-home-hero .osi-hero-panel', sel2:'.osi-home-hero', dur:9000,
    title:'Signed and verifiable on Solana',
    body:'The live overview frames the system as a read-only status console: open cases, signed actions, public records, analyst reputation, and Solana Mainnet.' },
  { view:'registry', sel:'#home-final-cta .home-final-actions', sel2:'#home-final-cta', dur:8000,
    title:'Choose the next step',
    body:'Open a case, join the analyst layer, or view the live console. The calls to action stay focused on the three actions a reviewer needs to understand first.' },
  { view:'field', sel:'#field-cases > div', sel2:'#field-stats', clickSel:'#field-cases > div', dur:8500,
    title:'The Field Office',
    body:'A live case board. Anyone posts a case for free; analysts claim it and trace the wallets on-chain. The Wire, for unprompted dispatches, sits one tab over.' },
  { view:'field', box:'demoBoxApply', modalMode:true, clickSel:'.bounty .btn-apply', dur:9500,
    title:'Claim a case',
    body:'Take a case and you get this box: write up your findings, attach the proof, and sign the submission with your wallet. No middleman ever holds your work.' },
  { view:'field', box:'demoBoxGuard', modalMode:true, modalPoint:'#og-agree', dur:12000,
    title:'A safety check before anything goes public',
    body:'Before any case or report is submitted, this stop appears. OSI will never ask for your seed phrase. Only publicly verifiable, open-source evidence gets published, never private messages or personal data. Nothing moves until you tick the box. It protects the person who was hit and the analyst working the case.' },
  { view:'field', box:'demoBoxPay', modalMode:true, modalPoint:'#tip-pay-toggle', modalReveal:'toggleSolanaPay', dur:11000,
    title:'Solana Pay, built in',
    body:'Support and rewards move on Solana Pay. Open the panel for a QR any Solana wallet can scan, or tap to pay on mobile. If a sponsor funds a reward, they release it the same way, peer to peer, settled on-chain. OSI never holds it.' },
  { view:'wire', box:'demoBoxWire', sel:'#wire-form', sel2:'#wire-cases', clickSel:'.wire-cta', dur:9000,
    title:'The Wire',
    body:'Found something unprompted? File it here: the subject, the trail, your confidence per address, the links. After review it joins the public record and the community can back it.' },
  { view:'analysts', sel:'#consensus-floor', sel2:'#lb-board', clickSel:'#consensus-floor .rvc-review', mockReview:true, dur:9500,
    title:'Peer review, live',
    body:'This is what a verified analyst sees: a pending finding, a weighted vote to publish or flag, and a maintainer seal as the final check while the roster grows. Consensus has to clear before anything joins the record. No single voice decides.' },
  { view:'registry', sel:'#walletBtn', sel2:'.wb-wrap', dur:9000,
    title:'Connect to take part',
    body:'Connect a Solana wallet here to open your own case, vouch as an analyst, or support a finding, all signed by you. You also get a profile with your case records and any reviewed packs. The tour itself never needs your wallet.' },
  { view:'registry', sel:null, dur:8000,
    title:'The record is public',
    body:'Original on-chain forensics, an open case board, AI-assisted escalation packs, and a community that reviews its own work in the open. Explore freely from here. Nothing on this site asks for your wallet.' }
];
var demoIdx = 0, demoPlaying = false, demoTimer = null, demoStepStart = 0, demoPausedElapsed = 0, demoPrevSB = '', demoRzT = null, demoMockHTML = null;
var demoTrackRAF = null, demoTrackArmed = false, demoArmT = null, demoRecState = null;

// ---- boxes the briefing opens (read-only) ----
function demoBoxApply(){
  var btn = document.querySelector('.bounty .btn-apply');
  if(btn && typeof openApplyModal === 'function'){ openApplyModal(btn); return; }
  var m = document.getElementById('apply-modal');
  if(m){ var nm = document.getElementById('apply-bounty-name'); if(nm) nm.textContent = '\uD83C\uDFAF Sample target'; m.classList.add('open'); }
}
function demoBoxPay(){
  // No hardcoded fallback wallet. Support opens only to the configured OSI wallet.
  var w = (typeof OSI_SUPPORT_WALLET !== 'undefined' && OSI_SUPPORT_WALLET) ? OSI_SUPPORT_WALLET : '';
  if(!w){ if(typeof showToast === 'function') showToast('Support is unavailable until a support wallet is configured.'); return; }
  if(typeof openTip === 'function') openTip(w, 'OSI project support', 0.1, '\u25CE Voluntary support', {kind:'osi'});
}
function demoBoxWire(){ if(typeof wireOpenForm === 'function') wireOpenForm(); demoBlurInputs(); }
function demoBoxGuard(){ if(typeof osiSubmitGuard === 'function'){ osiSubmitGuard('report', function(){}); } }
function demoBoxCloseAll(){
  if(typeof closeApplyModal === 'function') closeApplyModal();
  if(typeof closeTip === 'function') closeTip();
  var wf = document.getElementById('wire-form'); if(wf) wf.hidden = true;
  if(typeof osiGuardClose === 'function') osiGuardClose();
  if(typeof closeCaseDrawer === 'function') closeCaseDrawer();
  if(typeof closeCaseFile === 'function') closeCaseFile();
}
function demoInjectMockReview(){
  var host = document.getElementById('consensus-floor'); if(!host) return;
  if(demoMockHTML === null) demoMockHTML = host.innerHTML;
  host.innerHTML = '<div class="rvq-note mono">Example view: how the queue looks to a verified analyst.</div>'
    + '<div class="rvq-list"><div class="rvc">'
    + '<div class="rvc-left">'
      + '<div class="rvc-badges"><span class="rvc-type report">REPORT</span><span class="rvc-st new">NEW</span></div>'
      + '<div class="rvc-ttl">OSI-5153 \u00b7 Sample wallet-drainer attribution</div>'
      + '<div class="rvc-by mono">Submitted by 42Vq\u2026XU4y \u00b7 2d ago</div>'
      + '<div class="rvc-sum">A pending report linking a wallet cluster to an exchange deposit, awaiting peer review.</div>'
      + '<div class="rvc-chips"><span class="rvc-chip"><i>\u26d3</i>Evidence 6</span><span class="rvc-chip"><i>\u2398</i>TX Links 3</span></div>'
    + '</div>'
    + '<div class="rvc-mid">'
      + '<div class="rvc-cs-top"><span class="rvc-cs-l mono">PUBLISH CONSENSUS</span><b class="rvc-cs-v mono">2 / 3 weight</b></div>'
      + '<div class="rvc-bar"><div class="rvc-bar-fill" style="width:66%"></div></div>'
      + '<div class="rvc-votes mono"><span class="ok">\u25cf Approve 2</span><span class="bad">\u25cf Reject 0</span><span class="rvc-cs-note"><span class="rvc-cs-need">1 more to publish</span></span></div>'
    + '</div>'
    + '<div class="rvc-right">'
      + '<span class="rvc-yv-l mono">YOUR VOTE</span><span class="rvc-yv mono">Not voted</span>'
      + '<button class="rvc-review" type="button">Review</button>'
    + '</div>'
  + '</div></div>';
}
function demoClearMock(){
  if(demoMockHTML !== null){
    var host = document.getElementById('consensus-floor');
    if(host) host.innerHTML = demoMockHTML;
    demoMockHTML = null;
    if(typeof renderReviewFloor === 'function'){ try{ renderReviewFloor(); }catch(e){} }
  }
}

function publicRecordsDemoSample(){
  if(window.OSI_DEMO_MODE !== true) return [];
  var rec = { id:'OSIDEMO1', company:'Wallet-drainer incident (sample)', summary:'Sample record. Funds drained through a malicious token approval, then routed across intermediary wallets toward an exchange deposit.', tx:'', onchain:'intermediary wallet cluster', offchain:'', sealed:true, created_at:new Date().toISOString() };
  return [{ record:rec, packs:[ {case_ref:'OSIDEMO1',pack_type:'victim',content:'Sample victim brief.'}, {case_ref:'OSIDEMO1',pack_type:'exchange',content:'Sample exchange pack.'}, {case_ref:'OSIDEMO1',pack_type:'law_enforcement',content:'Sample law enforcement brief.'} ] }];
}
function demoInjectRecords(){
  var demoRecords = publicRecordsDemoSample();
  if(!demoRecords.length) return;
  var sec = document.getElementById('case-records-sec'); if(!sec) return;
  if(demoRecState === null){ demoRecState = { list: window.__crList, recs: window.__crRecords, packs: window.__crPacks, hidden: (sec.style.display === 'none'), html: (document.getElementById('case-records') || {}).innerHTML }; }
  sec.style.display = '';
  if(!document.querySelector('#case-records .cr-card')){
    var rec = demoRecords[0].record;
    window.__crList = [rec]; window.__crRecords = {}; window.__crRecords[rec.id] = rec;
    window.__crPacks = {}; window.__crPacks[rec.id] = demoRecords[0].packs;
    if(typeof crPaint === 'function') crPaint();
  }
}
function demoClearRecords(){
  if(demoRecState === null) return;
  if(typeof closeCaseDrawer === 'function') closeCaseDrawer();
  window.__crList = demoRecState.list; window.__crRecords = demoRecState.recs; window.__crPacks = demoRecState.packs;
  var host = document.getElementById('case-records'); if(host && typeof demoRecState.html === 'string') host.innerHTML = demoRecState.html;
  var sec = document.getElementById('case-records-sec'); if(sec && demoRecState.hidden) sec.style.display = 'none';
  demoRecState = null;
  if(typeof renderCaseRecords === 'function'){ try{ renderCaseRecords(); }catch(e){} }
}
function demoBoxRecord(){
  demoInjectRecords();
  var id = (window.__crList && window.__crList[0]) ? window.__crList[0].id : null;
  if(id && typeof openCaseRecord === 'function') openCaseRecord(id);
}

// ---- cursor / click / arrow helpers ----
function demoIsTouch(){ try{ if(window.matchMedia && window.matchMedia('(hover: none)').matches) return true; }catch(e){} return false; }
function demoCenterOf(el){ var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 90) }; }
function demoCenterPoint(){ return { x: window.innerWidth / 2, y: window.innerHeight * 0.46 }; }
function demoClampPt(p){ p.x = Math.max(22, Math.min(window.innerWidth - 22, p.x)); p.y = Math.max(22, Math.min(window.innerHeight - 22, p.y)); return p; }
// cursor enters from the control card so the move always reads as deliberate guidance
function demoCursorWalk(x, y){
  var c = document.getElementById('demo-cursor'); if(!c) return;
  if(demoIsTouch()){ c.style.opacity = '0'; return; }
  var card = document.getElementById('demo-card'); var sx, sy;
  if(card){ var cr = card.getBoundingClientRect(); sx = cr.left + 24; sy = cr.top + 18; } else { sx = window.innerWidth - 70; sy = window.innerHeight - 70; }
  c.style.transition = 'none';
  c.style.transform = 'translate(' + sx + 'px,' + sy + 'px)';
  c.style.opacity = '1';
  void c.offsetWidth; // reflow so the next transform animates
  c.style.transition = '';
  c.style.transform = 'translate(' + x + 'px,' + y + 'px)';
}
function demoCursorHide(){ var c = document.getElementById('demo-cursor'); if(c) c.style.opacity = '0'; }
function demoPress(){ var c = document.getElementById('demo-cursor'); if(!c || demoIsTouch()) return; c.classList.add('press'); setTimeout(function(){ c.classList.remove('press'); }, 180); }
function demoArrowTo(x, y){
  var card = document.getElementById('demo-card'), ar = document.getElementById('demo-arrow'); if(!card || !ar) return;
  if(demoIsTouch()){ ar.style.opacity = '0'; return; }
  var cr = card.getBoundingClientRect();
  var ang = Math.atan2(y - (cr.top + cr.height / 2), x - (cr.left + cr.width / 2)) * 180 / Math.PI;
  ar.style.opacity = '1'; ar.style.transform = 'rotate(' + ang + 'deg)';
}
function demoArrowHide(){ var ar = document.getElementById('demo-arrow'); if(ar) ar.style.opacity = '0'; }
function demoRipple(x, y){
  var fx = document.getElementById('demo-fx'); if(!fx) return;
  var r = document.createElement('div'); r.className = 'demo-click';
  r.style.left = x + 'px'; r.style.top = y + 'px';
  fx.appendChild(r);
  setTimeout(function(){ if(r.parentNode) r.parentNode.removeChild(r); }, 720);
}
function demoBlurInputs(){ var a = document.activeElement; if(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && !(a.closest && a.closest('.demo-card'))){ try{ a.blur(); }catch(e){} } }
// while the briefing runs, the page is for looking, not typing (Escape exits)
function demoKeyBlock(e){
  if(e.key === 'Escape'){ demoStop(); return; }
  var t = e.target;
  if(t && t.closest && t.closest('.demo-card')) return;
  if(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)){ e.preventDefault(); e.stopPropagation(); }
}

function demoStart(){
  demoIdx = 0; demoPausedElapsed = 0;
  var root = document.getElementById('demo-root'); if(!root) return;
  if(typeof welcomeClose === 'function') welcomeClose();
  demoPrevSB = document.documentElement.style.scrollBehavior;
  document.documentElement.style.scrollBehavior = 'auto';
  root.hidden = false;
  document.body.classList.add('demo-on');
  root.addEventListener('wheel', demoBlockScroll, { passive:false });
  root.addEventListener('touchmove', demoBlockScroll, { passive:false });
  document.addEventListener('keydown', demoKeyBlock, true);
  if(demoTimer) clearInterval(demoTimer);
  demoTimer = setInterval(demoTick, 50);
  demoPlaying = true;
  demoTrackArmed = false; if(demoTrackRAF) cancelAnimationFrame(demoTrackRAF); demoTrackRAF = requestAnimationFrame(demoTrackLoop);
  if(typeof demoInjectRecords === 'function') demoInjectRecords();
  var pb = document.getElementById('demo-play'); if(pb) pb.textContent = '\u2759\u2759';
  demoGoStep(0);
}
function demoBlockScroll(e){ if(e.target.closest && e.target.closest('.demo-card')) return; e.preventDefault(); }
function demoStop(){
  var root = document.getElementById('demo-root'); if(!root) return;
  demoBoxCloseAll(); demoClearMock();
  if(demoTimer){ clearInterval(demoTimer); demoTimer = null; }
  demoPlaying = false;
  root.removeEventListener('wheel', demoBlockScroll, { passive:false });
  root.removeEventListener('touchmove', demoBlockScroll, { passive:false });
  document.removeEventListener('keydown', demoKeyBlock, true);
  root.hidden = true;
  document.body.classList.remove('demo-on');
  var spot = document.getElementById('demo-spot'); if(spot){ spot.classList.remove('on'); spot.classList.remove('center'); spot.classList.remove('off'); spot.classList.remove('pulse'); }
  demoCursorHide(); demoArrowHide();
  if(demoTrackRAF){ cancelAnimationFrame(demoTrackRAF); demoTrackRAF = null; } demoTrackArmed = false; if(demoArmT){ clearTimeout(demoArmT); demoArmT = null; }
  if(typeof demoBoxCloseAll === 'function') demoBoxCloseAll();
  if(typeof demoClearRecords === 'function') demoClearRecords();
  document.documentElement.style.scrollBehavior = demoPrevSB || '';
  try{ showView('registry'); window.scrollTo(0, 0); }catch(e){}
}
function demoNext(){ if(demoIdx >= DEMO_STEPS.length - 1){ demoStop(); return; } demoGoStep(demoIdx + 1); }
function demoPrev(){ if(demoIdx <= 0) return; demoGoStep(demoIdx - 1); }
function demoTogglePlay(){
  demoPlaying = !demoPlaying;
  if(demoPlaying){ demoStepStart = Date.now() - demoPausedElapsed; }
  else { demoPausedElapsed = Date.now() - demoStepStart; }
  var b = document.getElementById('demo-play'); if(b) b.textContent = demoPlaying ? '\u2759\u2759' : '\u25B6';
}
function demoTick(){
  if(!demoPlaying) return;
  var step = DEMO_STEPS[demoIdx]; if(!step) return;
  var frac = Math.min(1, (Date.now() - demoStepStart) / step.dur);
  var bar = document.getElementById('demo-prog'); if(bar) bar.style.width = (frac * 100) + '%';
  if(frac >= 1){ demoNext(); }
}
function demoNeedFallback(el){ return !el || el.getBoundingClientRect().height < 4; }
function demoFindTarget(step){
  if(!step.sel) return null;
  var el = document.querySelector(step.sel);
  if(demoNeedFallback(el) && step.sel2) el = document.querySelector(step.sel2);
  if(demoNeedFallback(el)) return null;
  return el;
}
function demoGoStep(i){
  i = Math.max(0, Math.min(DEMO_STEPS.length - 1, i));
  demoIdx = i;
  demoTrackArmed = false; if(demoArmT){ clearTimeout(demoArmT); demoArmT = null; }
  var step = DEMO_STEPS[i];
  demoBoxCloseAll(); demoClearMock();
  var dcard = document.getElementById('demo-card'); if(dcard){ if(step.cardLeft) dcard.classList.add('dc-left'); else dcard.classList.remove('dc-left'); }
  demoStepStart = Date.now(); demoPausedElapsed = 0;
  var st = document.getElementById('demo-step'); if(st) st.textContent = ('0' + (i + 1)).slice(-2) + ' / ' + ('0' + DEMO_STEPS.length).slice(-2);
  var tt = document.getElementById('demo-title'); if(tt) tt.textContent = step.title;
  var bd = document.getElementById('demo-body'); if(bd) bd.textContent = step.body;
  var bar = document.getElementById('demo-prog'); if(bar) bar.style.width = '0%';
  var back = document.getElementById('demo-back'); if(back) back.disabled = (i === 0);
  var nx = document.getElementById('demo-next'); if(nx) nx.textContent = (i === DEMO_STEPS.length - 1) ? 'Finish' : 'Next \u203A';
  try{ showView(step.view); }catch(e){}
  demoCursorHide(); demoArrowHide();
  if(!step.sel && !step.box){ try{ window.scrollTo(0, 0); }catch(e){} }
  setTimeout(function(){ if(DEMO_STEPS[demoIdx] === step) demoSetup(step); }, 90);
}
function demoSetup(step){
  if(step.mockReview) demoInjectMockReview();
  if(step.modalMode && !step.sel){ demoModalStep(step); return; }
  if(!step.sel){ demoPlace(null); return; }
  demoLocate(step, 0);
}
function demoLocate(step, attempt){
  if(DEMO_STEPS[demoIdx] !== step) return;
  var el = demoFindTarget(step);
  if(!el){
    if(attempt < 10){ setTimeout(function(){ demoLocate(step, attempt + 1); }, 150); return; }
    el = document.querySelector('section[data-view="' + step.view + '"]');
    if(demoNeedFallback(el)){ demoPlace(null); return; }
  }
  try{ el.scrollIntoView({ block:'center', inline:'nearest' }); }catch(e){ try{ el.scrollIntoView(); }catch(_){} }
  requestAnimationFrame(function(){ requestAnimationFrame(function(){
    if(DEMO_STEPS[demoIdx] !== step) return;
    if(step.noCursor){
      var r = el.getBoundingClientRect();
      demoPlace(r, true); demoCursorHide();
      demoArrowTo(r.left + r.width / 2, r.top + Math.min(r.height / 2, 80));
      return;
    }
    demoGesture(step, el);
  }); });
}
// content step: cursor walks in, presses, the element lights up
function demoGesture(step, el){
  if(step.clickSel){ var pre = document.querySelector(step.clickSel); if(pre){ try{ pre.scrollIntoView({ block:'center', inline:'nearest' }); }catch(e){} } }
  requestAnimationFrame(function(){
    if(DEMO_STEPS[demoIdx] !== step) return;
    var ce = step.clickSel ? document.querySelector(step.clickSel) : el;
    var cp = demoClampPt(ce ? demoCenterOf(ce) : demoCenterPoint());
    demoCursorWalk(cp.x, cp.y);
    demoArrowTo(cp.x, cp.y);
    setTimeout(function(){
      if(DEMO_STEPS[demoIdx] !== step) return;
      demoPress(); demoRipple(cp.x, cp.y);
      if(step.box && typeof window[step.box] === 'function'){ try{ window[step.box](); }catch(e){} demoBlurInputs(); }
      setTimeout(function(){
        if(DEMO_STEPS[demoIdx] !== step) return;
        if(step.modalMode){ demoPlaceModal(); demoArrowHide(); return; }
        var t2 = demoFindTarget(step) || el;
        if(!t2){ demoPlace(null); return; }
        try{ t2.scrollIntoView({ block:'center', inline:'nearest' }); }catch(e){}
        requestAnimationFrame(function(){
          if(DEMO_STEPS[demoIdx] !== step) return;
          var rect = t2.getBoundingClientRect();
          demoPlace(rect, true);
          demoArrowTo(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 80));
        });
      }, step.box ? 260 : 80);
    }, DEMO_WALK + 60);
  });
}
// modal step: either click a trigger then the modal opens, or open the modal then point at its control
function demoModalStep(step){
  if(step.clickSel){
    var pre = document.querySelector(step.clickSel); if(pre){ try{ pre.scrollIntoView({ block:'center', inline:'nearest' }); }catch(e){} }
    requestAnimationFrame(function(){
      if(DEMO_STEPS[demoIdx] !== step) return;
      var ce = document.querySelector(step.clickSel);
      var cp = demoClampPt(ce ? demoCenterOf(ce) : demoCenterPoint());
      demoCursorWalk(cp.x, cp.y); demoArrowTo(cp.x, cp.y);
      setTimeout(function(){
        if(DEMO_STEPS[demoIdx] !== step) return;
        demoPress(); demoRipple(cp.x, cp.y);
        if(step.box && typeof window[step.box] === 'function'){ try{ window[step.box](); }catch(e){} demoBlurInputs(); }
        setTimeout(function(){ if(DEMO_STEPS[demoIdx] === step){ demoPlaceModal(); demoArrowHide(); } }, 220);
      }, DEMO_WALK + 60);
    });
  } else {
    if(step.box && typeof window[step.box] === 'function'){ try{ window[step.box](); }catch(e){} demoBlurInputs(); }
    setTimeout(function(){
      if(DEMO_STEPS[demoIdx] !== step) return;
      var mp = step.modalPoint ? document.querySelector(step.modalPoint) : null;
      var cp = demoClampPt(mp ? demoCenterOf(mp) : demoCenterPoint());
      demoCursorWalk(cp.x, cp.y); demoArrowTo(cp.x, cp.y);
      setTimeout(function(){
        if(DEMO_STEPS[demoIdx] !== step) return;
        demoPress(); demoRipple(cp.x, cp.y);
        if(step.modalReveal && typeof window[step.modalReveal] === 'function'){ try{ window[step.modalReveal](); }catch(e){} }
        demoBlurInputs(); demoPlaceModal(); demoArrowHide();
      }, DEMO_WALK + 60);
    }, 260);
  }
}
function demoPlaceModal(){
  var spot = document.getElementById('demo-spot'); if(!spot) return;
  spot.classList.remove('center'); spot.classList.remove('on'); spot.classList.remove('pulse'); spot.classList.add('off');
}
function demoPlace(rect, pulse){
  var spot = document.getElementById('demo-spot');
  var card = document.getElementById('demo-card');
  if(!spot || !card) return;
  spot.style.transition = '';
  spot.classList.remove('off');
  var vw = window.innerWidth, vh = window.innerHeight, M = 16;
  if(!rect){
    spot.classList.remove('pulse');
    spot.classList.add('center'); spot.classList.add('on');
    spot.style.left = (vw / 2) + 'px'; spot.style.top = (vh / 2) + 'px';
    spot.style.width = '0px'; spot.style.height = '0px';
    demoArrowHide();
    return;
  }
  spot.classList.remove('center');
  var pad = 8;
  var tx = Math.max(M, rect.left - pad), ty = Math.max(M, rect.top - pad);
  var tw = Math.min(vw - 2 * M, rect.width + 2 * pad), th = Math.min(vh - 2 * M, rect.height + 2 * pad);
  var crd = card.getBoundingClientRect(); var gap = 14;
  if(crd && crd.width && tx + tw > crd.left - gap && ty + th > crd.top - gap){
    var nTh = (crd.top - gap) - ty;
    if(nTh >= 120){ th = nTh; }
    else { var nTw = (crd.left - gap) - tx; if(nTw >= 220){ tw = nTw; } }
  }
  spot.style.left = tx + 'px'; spot.style.top = ty + 'px';
  spot.style.width = tw + 'px'; spot.style.height = th + 'px';
  spot.classList.add('on');
  if(pulse){ spot.classList.add('pulse'); setTimeout(function(){ spot.classList.remove('pulse'); }, 720); }
  demoArmTrack();
}
// snap the highlight box to a rect WITHOUT animation (used by the live tracker)
function demoPlaceSnap(rect){
  var spot = document.getElementById('demo-spot'); if(!spot || !rect) return;
  var vw = window.innerWidth, vh = window.innerHeight, M = 16, pad = 8;
  var tx = Math.max(M, rect.left - pad), ty = Math.max(M, rect.top - pad);
  var tw = Math.min(vw - 2*M, rect.width + 2*pad), th = Math.min(vh - 2*M, rect.height + 2*pad);
  var card = document.getElementById('demo-card'); var crd = card ? card.getBoundingClientRect() : null; var gap = 14;
  if(crd && crd.width && tx + tw > crd.left - gap && ty + th > crd.top - gap){
    var nTh = (crd.top - gap) - ty; if(nTh >= 120){ th = nTh; } else { var nTw = (crd.left - gap) - tx; if(nTw >= 220){ tw = nTw; } }
  }
  spot.style.transition = 'none';
  spot.style.left = tx + 'px'; spot.style.top = ty + 'px'; spot.style.width = tw + 'px'; spot.style.height = th + 'px';
  spot.classList.remove('center'); spot.classList.remove('off'); spot.classList.add('on');
}
function demoArmTrack(){ if(demoArmT) clearTimeout(demoArmT); demoTrackArmed = false; demoArmT = setTimeout(function(){ demoTrackArmed = true; }, 560); }
// continuously pin the highlight to the live target rect: zoom, scroll or reflow can never desync it
function demoTrackLoop(){
  demoTrackRAF = requestAnimationFrame(demoTrackLoop);
  if(!demoTrackArmed) return;
  var root = document.getElementById('demo-root'); if(!root || root.hidden) return;
  var step = DEMO_STEPS[demoIdx]; if(!step || step.modalMode || !step.sel) return;
  var el = demoFindTarget(step); if(!el) return;
  var r = el.getBoundingClientRect(); if(r.height < 4) return;
  demoPlaceSnap(r);
  if(!step.noCursor) demoArrowTo(r.left + r.width/2, r.top + Math.min(r.height/2, 80));
}
function demoRealign(){
  var root = document.getElementById('demo-root'); if(!root || root.hidden) return;
  var step = DEMO_STEPS[demoIdx]; if(!step) return;
  if(step.modalMode){ demoPlaceModal(); return; }
  if(!step.sel){ demoPlace(null); return; }
  var el = demoFindTarget(step) || document.querySelector('section[data-view="' + step.view + '"]');
  if(el && el.getBoundingClientRect().height >= 4){
    try{ el.scrollIntoView({ block:'center', inline:'nearest' }); }catch(e){}
    requestAnimationFrame(function(){ requestAnimationFrame(function(){
      var rect = el.getBoundingClientRect();
      demoPlace(rect);
      if(!step.noCursor) demoArrowTo(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 80));
    }); });
  } else { demoPlace(null); }
}
window.addEventListener('resize', function(){ if(demoRzT) clearTimeout(demoRzT); demoRzT = setTimeout(demoRealign, 140); });

// ---- welcome card: greets first-time visitors, launches or dismisses ----
function welcomeShow(){
  var w = document.getElementById('osi-welcome'); if(w){ w.style.display = ''; w.hidden = false; try{ localStorage.setItem('osi_briefing_seen','1'); }catch(e){} }
}
function welcomeClose(){
  var w = document.getElementById('osi-welcome'); if(w){ w.hidden = true; w.style.display = 'none'; }
}
function welcomeStart(){ welcomeClose(); demoStart(); }
// ---- pre-submission safety guard: protects OSI, the victim, and the analyst ----
var _osiGuardFn = null;
var _osiGuardKind = null;
function osiSubmitGuard(kind, proceed){
  _osiGuardFn = (typeof proceed === 'function') ? proceed : null;
  _osiGuardKind = kind;
  var _bl = document.getElementById('og-block'); if(_bl) _bl.hidden = true;
  var titles = { 'case':'Before you open a case', 'intel':'Before you file a dispatch', 'application':'Before you apply', 'report':'Before you submit your report' };
  var t = document.getElementById('og-title'); if(t) t.textContent = titles[kind] || 'Read this first';
  var ag = document.getElementById('og-agree'); if(ag) ag.checked = false;
  var go = document.getElementById('og-go'); if(go) go.disabled = true;
  var pub = (kind === 'report' || kind === 'intel');
  var ex = document.getElementById('og-extra');
  if(ex){ ex.innerHTML = pub ? '<div class="og-item os"><span class="og-ic">\u26d3</span><div><b>Open-source evidence only.</b> Everything you submit can become public. Include only what is publicly verifiable: on-chain transactions, public addresses, open-source records. Never submit private messages, DMs, screenshots of private chats, or anyone\u2019s personal data. Private information must never be published here.</div></div>' : ''; }
  var ctx = document.getElementById('og-check-tx');
  if(ctx){ ctx.textContent = pub ? 'I understand: no seed phrase or private key, and I am submitting only public, open-source evidence, no private messages.' : 'I understand, and I am not sharing any seed phrase or private key.'; }
  var m = document.getElementById('osi-guard'); if(m){ m.style.display=''; m.hidden=false; }
}
function osiGuardToggle(){ var ag=document.getElementById('og-agree'), go=document.getElementById('og-go'); if(go) go.disabled = !(ag && ag.checked); }
function osiGuardClose(){ var m=document.getElementById('osi-guard'); if(m){ m.hidden=true; m.style.display='none'; } _osiGuardFn=null; }
function osiGuardProceed(){
  var ag=document.getElementById('og-agree'); if(!(ag && ag.checked)) return;
  try{
    var res = osiSafetyScan(osiScanFor(_osiGuardKind), _osiGuardKind);
    if(res && res.blocked){
      var r=document.getElementById('ogb-reasons'); if(r) r.textContent='Detected: '+res.reasons.join(', ')+'.';
      var b=document.getElementById('og-block'); if(b){ b.hidden=false; try{ b.scrollIntoView({block:'nearest'}); }catch(e){} }
      return; // blocked: do not sign on-chain, do not write to Supabase
    }
  }catch(e){ /* fail-open: a scanner error must never break the submit flow */ }
  var fn=_osiGuardFn; osiGuardClose(); if(typeof fn==='function'){ try{ fn(); }catch(e){} }
}

// ===== Local Safety Gate (client-side, no API/AI/backend) =====
// A guardrail that blocks obviously risky USER content before it is signed
// on-chain or written to Supabase. It is bypassable by design (client-side),
// so the real protection stays the maintainer-approval step + RLS. This only
// stops accidental/casual risky content from ever reaching the queue.
// NOTE: tx signatures and private keys are both ~88-char base58 and cannot be
// told apart by length, so private keys are matched by keyword + byte-array
// format only, never by base58 length. That keeps tx hashes (allowed) safe.
var SAFETY_PROFANITY = /\b(f+u+c+k+(?:ing|er|ers|ed|s)?|motherf\w+|c+u+n+t+s?|n[i1]gg(?:er|a|ers|as)|f[a4]gg?(?:ot|ots)?|f[a4]gs?|spics?|kikes?|wetbacks?|trann(?:y|ies)|retard(?:ed|s)?)\b/i;

// --- the scanner: returns {blocked, reasons[]} ; tuned to avoid blocking legit on-chain evidence
function osiSafetyScan(text, kind){
  var reasons = [];
  if(!text) return { blocked:false, reasons:reasons };
  var t = String(text);
  var low = t.toLowerCase();
  function add(r){ if(reasons.indexOf(r) < 0) reasons.push(r); }

  // 1) seed / recovery phrase: keyword, OR a clean maximal run of an exact BIP39 length
  var seedHit = /\b(seed|recovery|mnemonic)\s*(phrase|words?)\b/i.test(t) || /\bseed\s*:/i.test(t);
  if(!seedHit){
    var STOP = {the:1,and:1,but:1,for:1,with:1,that:1,this:1,your:1,you:1,are:1,was:1,her:1,his:1,its:1,our:1,their:1,from:1,have:1,has:1,had:1,not:1,all:1,any:1,can:1,will:1,out:1,who:1,how:1,why:1,what:1,when:1,where:1,been:1,were:1,they:1,them:1,then:1,than:1,into:1,over:1,just:1,like:1,some:1,more:1,also:1,only:1,sent:1,went:1,here:1,came:1,used:1,both:1,each:1,very:1,much:1,many:1,most:1,wallet:1,funds:1,money:1,token:1,tokens:1,coins:1,scam:1,scammer:1,hack:1,hacked:1,stole:1,stolen:1,drained:1,sol:1,usdc:1,address:1,wallets:1};
    var ow = t.split(/\s+/), run = [];
    for(var i=0;i<=ow.length;i++){
      var w = ow[i] || '';
      if(/^[a-z]{3,8}$/.test(w)){ run.push(w); }
      else {
        if([12,15,18,21,24].indexOf(run.length) >= 0){
          var sN=0, uq={}; for(var j=0;j<run.length;j++){ if(STOP[run[j]]) sN++; uq[run[j]]=1; }
          if(sN<=1 && Object.keys(uq).length===run.length){ seedHit = true; break; }
        }
        run = [];
      }
    }
  }
  if(seedHit) add('a seed or recovery phrase');

  // 2) private key: keyword, byte-array, or long hex ONLY. Never base58 length (tx sigs share it).
  if(/\b(private|secret)\s*key\b/i.test(t)) add('a private key');
  else if(/\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){47,}\s*\]/.test(t)) add('a private key (keypair array)');
  else if(/\b[0-9a-fA-F]{64,}\b/.test(t)) add('a private key (hex)');

  // application is just a contact handle + a public link, so only the catastrophic checks apply
  if(kind === 'application') return { blocked:reasons.length>0, reasons:reasons };

  // 3) email
  if(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i.test(t)) add('an email address');

  // 4) phone: formatted or +country only (bare digit runs are amounts/slots, allowed)
  if(/\+\d[\d\s().\-]{7,}\d/.test(t) || /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/.test(t)) add('a phone number');

  // 5) personal identity / home address (doxxing)
  if(/\b(real name is|their name is|his name is|her name is|full name is|lives at|home address|residing at|home is at)\b/i.test(low)) add('a personal identity or home address');
  else if(/\b\d{1,5}\s+(?:[a-z0-9.]+\s){1,4}(street|avenue|boulevard|apartment|suite)\b/i.test(low)) add('a home address');

  // 6) threats
  if(/\b(i\s*will\s*kill|i'?ll\s*kill|kill\s*you|you\s*are\s*dead|you'?re\s*dead|i\s*will\s*find\s*you|i'?ll\s*find\s*you|watch\s*your\s*back|i\s*know\s*where\s*you\s*live|hunt\s*you\s*down|burn\s*your)\b/i.test(low)) add('a threat');

  // 7) spam: too many links, or a long repeated-character run
  var links = (t.match(/https?:\/\//gi) || []).length;
  if(links > 6) add('too many links (spam)');
  else if(/(.)\1{14,}/.test(t)) add('repeated-character spam');

  // 8) heavy profanity / slurs (the maintainer asked for a clean, professional record)
  if(SAFETY_PROFANITY.test(low)) add('heavy profanity or a slur');

  return { blocked:reasons.length>0, reasons:reasons };
}

// gather the relevant field text per submission kind
function osiScanFor(kind){
  function v(id){ var e=document.getElementById(id); return e ? String(e.value||'') : ''; }
  if(kind === 'case')        return v('bf-target') + '\n' + v('bf-detail');
  if(kind === 'report')      return v('apply-report');
  if(kind === 'intel')       return v('wire-subject-in') + '\n' + v('wire-body-in');
  if(kind === 'application') return v('an-tg') + '\n' + v('an-web');
  return '';
}


function safetyGate(text){
  var t = String(text || '');
  var low = t.toLowerCase();
  var hits = [];
  function add(l){ if(hits.indexOf(l) === -1) hits.push(l); }

  // seed / recovery phrase (protects the user from doxxing themselves)
  if(/\b(seed phrase|recovery phrase|secret recovery phrase|mnemonic phrase|mnemonic|seed words?)\b/i.test(t)) add('a seed or recovery phrase');
  var run = low.match(/\b[a-z]{3,8}(?:\s+[a-z]{3,8}){11,23}\b/);
  if(run){
    var ws = run[0].split(/\s+/);
    var STOP = /^(the|and|for|you|your|was|were|are|this|that|with|but|not|they|them|then|now|gone|sent|send|lost|funds|fund|wallet|money|scam|scammed|stole|stolen|drain|drained|please|help|someone|somebody|anybody|nothing|hacked|hack|hacker|address|account|transaction|transfer|swap|swapped|staked|stake|claimed|signed|approve|approved|phantom|solana|ethereum|bitcoin|usdc|usdt|dollars|amount|balance|from|have|has|had|will|been|into|onto|over|back|just|like|when|what|where|which|there|their|would|could|should|because|after|before|while|through|around|between|here|told|said|asked|paid|using|used|received|missing|moving|moved|tracing|traced|going|doing|trying|really|started|looking|getting|coins|token|tokens|exchange|binance|coinbase|thanks|thank)$/;
    var nar = 0; for(var i=0;i<ws.length;i++){ if(STOP.test(ws[i])) nar++; }
    if(nar === 0) add('a seed or recovery phrase');
  }

  // private key (keyword + exported byte-array; NOT base58 length, see note above)
  if(/\b(private key|secret key|priv\s*key|privkey|keypair|secret phrase)\b/i.test(t)) add('a private key');
  if(/\[\s*\d{1,3}\s*(?:,\s*\d{1,3}\s*){47,}\]/.test(t)) add('a private key');

  // email
  if(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/.test(t)) add('an email address');

  // phone (needs grouping or country code, so amounts/hashes do not trip it)
  if(/(?:\+\d{1,3}[\s.\-]?)?(?:\(\d{3}\)|\d{3})[\s.\-]\d{3}[\s.\-]\d{4}\b/.test(t) || /\+\d{1,3}[\s.\-]?\d{9,12}\b/.test(t)) add('a phone number');

  // physical address / government ID
  if(/\b\d{1,5}\s+(?:[A-Za-z0-9.]+\s+){1,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|place|pl|way|highway|hwy|apt|suite|ste)\b/i.test(t)) add('a home address');
  if(/\b\d{3}\-\d{2}\-\d{4}\b/.test(t)) add('a personal ID number');

  // private message / DM content
  if(/(?:\b(?:the|our|my|his|her|their)\s+dms?\b|\bin\s+(?:the\s+|our\s+|his\s+|her\s+|their\s+)?dms?\b|\bprivate\s+(?:message|chat|conversation|dm)s?\b|\bscreenshot\s+of\b[\s\S]{0,40}?\b(?:dm|chat|conversation|messages?|texts?)\b|\b(?:he|she|they|we)\s+(?:dm(?:ed|d)?|messaged|texted|pm(?:ed|d)?)\s+me\b|\b(?:dm(?:ed|d)?|messaged|texted)\s+me\s+(?:saying|that|this)\b|\bover\s+(?:dm|whatsapp|telegram|signal|imessage)\b)/i.test(t)) add('private message content');

  // threats (first-person)
  if(/\b(?:i(?:'?| a)m going to|i will|i'?ll|im gonna|i'?m gonna|we will|we'?ll|im going to)\b[^.!?\n]{0,40}\b(?:kill|hurt|harm|find you|come for you|come to your|beat you|destroy you|end you|make you pay|expose you|burn|stab|shoot|murder)\b/i.test(t)) add('a threat');

  // direct accusation / name-calling at a person (the event itself is fine; naming a person a "thief" is not)
  if(/\b(?:you(?:'?| a)re|he'?s|she'?s|they'?re|is|are)\s+(?:a |an |the )?(?:thief|thieves|scammer|scammers|fraudster|fraud|criminal|crook|liar|con\s?artist|pedophile|paedophile|terrorist|rapist)\b/i.test(t)) add('a direct accusation or name-calling');

  // spam / excessive links
  var urls = (t.match(/https?:\/\/[^\s]+/gi) || []);
  if(urls.length > 5) add('too many links (spam)');
  var seen = {}, rep = false;
  for(var u=0; u<urls.length; u++){ var k = urls[u].toLowerCase(); seen[k] = (seen[k]||0)+1; if(seen[k] >= 3) rep = true; }
  if(rep) add('repeated links (spam)');
  if(/\b(?:free (?:crypto|sol|airdrop|nft|tokens?)|claim your (?:free|reward|airdrop)|connect your wallet to (?:claim|receive)|guaranteed (?:profit|returns|gains)|double your (?:sol|crypto|money)|click here to (?:win|claim))\b/i.test(t)) add('spam content');

  // heavy profanity / slur
  if(SAFETY_PROFANITY.test(t)) add('heavy profanity or a slur');

  return { ok: hits.length === 0, hits: hits };
}

function osiBlockShow(hits){
  var lst = document.getElementById('osi-block-list');
  if(lst){ lst.innerHTML = (hits && hits.length) ? ('<div class="ob-det">Detected in your text: ' + hits.join(', ') + '. Please remove it and try again.</div>') : ''; }
  var m = document.getElementById('osi-block'); if(m){ m.style.display = ''; m.hidden = false; }
}
function osiBlockClose(){ var m = document.getElementById('osi-block'); if(m){ m.hidden = true; m.style.display = 'none'; } }
(function(){
  function go(){ try{ if(localStorage.getItem('osi_briefing_seen')==='1') return; }catch(e){} setTimeout(welcomeShow, 800); }
  if(document.readyState === 'loading'){ document.addEventListener('DOMContentLoaded', go); } else { go(); }
})();

// ===== CONSENSUS (analyst peer-review / progressive decentralization) =====
let CONSENSUS_THRESHOLD = 4;   // weight needed to publish; the same weight of rejections closes an item
let CONSENSUS_AUTO = true;     // analysts hold near-seal power: consensus publishes without waiting for the maintainer
window.ANALYST_WEIGHT = window.ANALYST_WEIGHT || {};
window.VOUCHES = window.VOUCHES || {};
// ---- vote power ladder (capped, earned by REP tier):
//   Tier I Apprentice \u00d71 \u00b7 Tier II Investigator \u00d72 \u00b7 Tier III Detective \u00d73 \u00b7 Tier IV Chief \u00d74
function analystWeight(wallet){ const w = window.ANALYST_WEIGHT[String(wallet)]; return Math.max(0, Math.min(4, (w==null?0:Number(w)))); }
function vouchKey(type,id){ return type+'|'+id; }
async function loadVouches(){
  if(!SUPA_ON) return;
  try{
    const rows = await supaGet('vouches?select=item_type,item_id,analyst,vote') || [];
    const map={};
    rows.forEach(function(v){
      const k=vouchKey(v.item_type, v.item_id);
      if(!map[k]) map[k]={approve:[],reject:[]};
      map[k][v.vote==='reject'?'reject':'approve'].push(String(v.analyst));
    });
    window.VOUCHES = map;
  }catch(e){ /* table may not exist yet */ }
}
function vouchTally(type,id){
  const v = window.VOUCHES[vouchKey(type,id)] || {approve:[],reject:[]};
  let aw=0, rw=0;
  v.approve.forEach(function(w){ aw += analystWeight(w); });
  v.reject.forEach(function(w){ rw += analystWeight(w); });
  return { approve:v.approve, reject:v.reject, aw:aw, rw:rw };
}
function myVouch(type,id){
  if(!walletPubkey) return null;
  const v = window.VOUCHES[vouchKey(type,id)] || {approve:[],reject:[]};
  if(v.approve.indexOf(walletPubkey)!==-1) return 'approve';
  if(v.reject.indexOf(walletPubkey)!==-1) return 'reject';
  return null;
}
// author head start: an analyst author's own standing pre-fills the bar,
// but at least ONE independent vote is always required (no single voice decides).
function vouchAuthorW(type,row){
  if(type==='challenge' || !row) return 0;
  var creator = row.created_by || row.wallet || '';
  return analystWeight(creator);
}
function vouchThreshold(type,id,row){
  if(type==='challenge') return CONSENSUS_THRESHOLD;
  return Math.max(1, CONSENSUS_THRESHOLD - vouchAuthorW(type,row));
}
// first weight to reach its line locks the item; a locked item takes no more votes
function vouchDecision(type,id,row){
  if(row && row.review_status==='rejected') return 'rejected';
  if(row && row.status==='upheld') return 'published';
  if(row && row.status==='dismissed') return 'rejected';
  if(row && row.approved===true && type!=='challenge') return 'published';
  const t = vouchTally(type,id);
  const thr = vouchThreshold(type,id,row);
  if(t.aw>=thr && t.aw>=t.rw) return 'published';
  if(t.rw>=CONSENSUS_THRESHOLD) return 'rejected';
  return null;
}
function consensusMeter(type,id,row){
  const t = vouchTally(type,id);
  const dec = vouchDecision(type,id,row);
  const thr = vouchThreshold(type,id,row);
  const aW  = vouchAuthorW(type,row);
  const ap = Math.min(100, Math.round(t.aw / Math.max(1,thr) * 100));
  const rp = Math.min(100, Math.round(t.rw / Math.max(1,CONSENSUS_THRESHOLD) * 100));
  const isCh = (type==='challenge');
  let status;
  if(dec==='published') status = '<span class="cm-lock ok">'+(isCh?'\u2713 challenge upheld \u00b7 record returns to review':'\u2713 consensus reached \u00b7 published \u00b7 locked')+'</span>';
  else if(dec==='rejected') status = '<span class="cm-lock bad">'+(isCh?'\u2715 challenge dismissed \u00b7 locked':'\u2715 closed by consensus \u00b7 locked')+'</span>';
  else {
    const need = Math.max(0, thr - t.aw);
    status = '<span class="cm-st">'+need+' more weight to '+(isCh?'uphold':'publish')+(aW>0?(' \u00b7 author standing \u00d7'+aW+' counted'):'')+'</span>';
  }
  return '<div class="cm'+(dec?' done':'')+'">'
    + '<div class="cm-bar"><div class="cm-fill" style="width:'+ap+'%"></div></div>'
    + (t.rw>0 ? '<div class="cm-bar rj"><div class="cm-fill rj" style="width:'+rp+'%"></div></div>' : '')
    + '<div class="cm-meta mono"><span class="cm-w">\u2713 '+t.aw+' / '+thr+'</span>'
      + (t.rw>0 ? ('<span class="cm-rj">\u2715 '+t.rw+' / '+CONSENSUS_THRESHOLD+'</span>') : '')
      + status
    + '</div></div>';
}
async function vouch(type,id,vote,creator){
  if(!isVerifiedAnalyst(walletPubkey)){ showToast("Only verified analysts can vote. Apply from the Analysts tab, or earn a seat by signed work."); return; }
  if(creator && walletPubkey && String(creator)===String(walletPubkey)){ showToast("You cannot vote on your own submission."); return; }
  const row = (window.__rfRows||{})[vouchKey(type,id)] || null;
  if(vouchDecision(type,id,row)){ showToast("This item is locked \u00b7 consensus already decided."); return; }
  if(myVouch(type,id)){ showToast("Your vote is on-chain and immutable \u00b7 one vote per item."); return; }
  const _vts = Math.floor(Date.now()/1000);
  const _vmemo = vote==='approve'
    ? "OSI_ANALYST_VOUCH|item_type="+type+"|item_id="+id+"|vote=approve|weight="+analystWeight(walletPubkey)+"|analyst="+(walletPubkey||'')+"|ts="+_vts
    : "OSI_CHALLENGE_FILED|item_type="+type+"|item_id="+id+"|weight="+analystWeight(walletPubkey)+"|challenger="+(walletPubkey||'')+"|ts="+_vts;
  withOnchainVote(vote==='approve' ? 'Vouch to publish' : 'Vote to close', _vmemo, async (sig)=>{
    try{
      // Keep the signed proof-log event (Stage 1 behavior; onchain_events insert).
      recordOnchainEvent({ event_type:'analyst_vouch', item_type:type, item_id:id, vote:vote, label:(vote==='approve'?'approved':'challenged')+' '+type, memo_text:_vmemo, tx_sig:sig });
      // Stage 2C: the vote + any publication are performed server-side by the
      // verified Edge Function (no direct anon vouches insert, no anon publish).
      var _res = await osiReviewAction({ item_type:type, item_id:id, vote:(vote==='approve'?'approve':'challenge'), tx_sig:sig });
      if(_res && (_res.reports||_res.bounties||_res.challenges)){
        window.__osiIntake = { at: Date.now(), data: { reports:_res.reports||[], bounties:_res.bounties||[], challenges:_res.challenges||[] } };
      }
      showToast('Review action recorded.');
      if(_res && _res.published) showToast('Record approved for public review.');
      await loadVouches();
      renderReviewFloor();
      if(typeof renderActivity==='function'){ try{ renderActivity(); }catch(e){} }
      if(_res && _res.published){ try{ renderFieldOffice(); renderWire(); if(typeof hydrateReportsFromSupabase==='function') hydrateReportsFromSupabase(); loadAnalysts(); if(typeof renderCaseRecords==='function') renderCaseRecords(); }catch(e){} }
    }catch(e){ showToast((e && e.status===403) ? 'Analyst access required \u00b7 verify your analyst wallet.' : 'Could not record the review action. Please try again.'); }
  });
}
// ===== challenges: any wallet can contest a published record; analysts judge it =====
var chxCtx=null;
function chxOpen(itemType,itemId,label){
  if(!walletPubkey){ showToast('Connect your wallet first \u00b7 a challenge must be signed.'); return; }
  chxCtx={item_type:String(itemType),item_id:String(itemId),item_label:String(label||'')};
  var t=document.getElementById('chx-title'); if(t) t.textContent='Challenge \u00b7 '+(label||itemId);
  var th=document.getElementById('chx-thr'); if(th) th.textContent=String(CONSENSUS_THRESHOLD);
  var r=document.getElementById('chx-reason'); if(r) r.value='';
  var m=document.getElementById('chx-modal'); if(m){ m.classList.add('open'); document.body.style.overflow='hidden'; }
  if(r) setTimeout(function(){ try{r.focus();}catch(e){} },60);
}
function chxClose(){ var m=document.getElementById('chx-modal'); if(m) m.classList.remove('open'); document.body.style.overflow=''; }
async function chxSubmit(){
  if(!chxCtx) return;
  var reason=(document.getElementById('chx-reason')||{}).value||''; reason=reason.trim();
  if(reason.length<30){ showToast('Lay out the evidence \u00b7 at least a sentence or two with the on-chain facts.'); return; }
  if(!rateOk('challenge', 8000)){ showToast('Give it a few seconds.'); return; }
  var ctx=chxCtx;
  try{
    var ex=await supaGet('challenges?select=id&item_type=eq.'+encodeURIComponent(ctx.item_type)+'&item_id=eq.'+encodeURIComponent(ctx.item_id)+'&challenger=eq.'+encodeURIComponent(walletPubkey)+'&status=eq.open&limit=1');
    if(ex && ex.length){ showToast('You already have an open challenge on this record.'); return; }
  }catch(e){}
  var _ts=Math.floor(Date.now()/1000);
  var memo='OSI_CHALLENGE_FILED|item_type='+ctx.item_type+'|item_id='+ctx.item_id+'|challenger='+(walletPubkey||'')+'|ts='+_ts;
  withOnchainVote('File a challenge', memo, async function(sig){
    try{
      await supaPost('challenges', { item_type:ctx.item_type, item_id:ctx.item_id, item_label:ctx.item_label, challenger:walletPubkey, reason:reason, status:'open' });
      recordOnchainEvent({ event_type:'analyst_vouch', item_type:'challenge', item_id:ctx.item_id, vote:'reject', label:'challenged a published '+ctx.item_type, memo_text:memo, tx_sig:sig });
      showToast('\u2696 Challenge filed and signed \u00b7 verified analysts will judge it.');
      chxClose(); renderReviewFloor();
    }catch(e){ showToast('Challenge could not be filed \u00b7 the challenges table may not exist yet.'); }
  });
}
var rfTab='pending', rfPageN=1, RF_PER=6;
var RF_Q='';
function rfSetTab(t){ rfTab=t; rfPageN=1; renderReviewFloor(); }
function rfSetPage(p){ rfPageN=p|0; renderReviewFloor(); }
function rfSearch(v){ RF_Q=(v||'').trim().toLowerCase(); rfPageN=1; renderReviewFloor(); }
// evidence / tx / attachment counts from real row data
function rfEvidence(row, type){
  if(!row) return 0;
  if(type==='challenge') return 0;
  var fields = type==='bounty' ? [row.detail, row.onchain] : [row.onchain, row.offchain, row.summary];
  return fields.reduce(function(s,f){ return s + crCountTokens(f); }, 0);
}
function rfTxLinks(row, type){
  if(!row) return 0;
  var t = row.tx || row.onchain || '';
  return crCountTokens(t);
}
function rfAttach(row){ return row && row.image ? 1 : 0; }
// item's live status bucket for tabs
function rfBucket(it){
  var row=(window.__rfRows||{})[vouchKey(it.type,it.id)]||null;
  var dec=vouchDecision(it.type,it.id,row);
  if(dec==='rejected') return 'rejected';
  if(it.type==='challenge') return 'disputed';
  if(row && row.review_status==='challenged') return 'disputed';
  if(dec==='published') return 'ready';
  var t=vouchTally(it.type,it.id);
  var thr=vouchThreshold(it.type,it.id,row);
  if(t.aw>=thr && t.aw>=t.rw) return 'ready';
  return 'pending';
}
// Demo queue is unavailable in live mode. It only renders when
// window.OSI_DEMO_MODE === true, so sample review items cannot leak into testing.
function reviewQueueSample(){
  if(window.OSI_DEMO_MODE !== true) return [];
  var now = Date.now();
  function t(days){ return new Date(now - days*86400000).toISOString(); }
  return [
    { type:'report', id:'DMO-5153', title:'Upexi', creator:'42VqAbcdEfGhXU4y', sub:'On-chain evidence pack regarding suspicious market activity and potential disclosure issues.', ts:t(2),
      row:{ id:'DMO-5153', company:'Upexi', wallet:'42VqAbcdEfGhXU4y', summary:'On-chain evidence pack regarding suspicious market activity and potential disclosure issues. The report traces a cluster of wallets moving funds through an intermediary before a public announcement.', onchain:'walletAAA111 walletBBB222 walletCCC333 txHashLongEnough1 txHashLongEnough2 txHashLongEnough3', tx:'sig111LongEnoughToCount sig222LongEnoughToCount sig333LongEnoughToCount', created_at:t(2) },
      votes:{ approve:['DEMO_B'], reject:[] } },
    { type:'bounty', id:'DMO-5181', title:'Wallet-Drainer Incident', creator:'7vAbCdEfGhLm2a', sub:'Initial evidence and victim reports related to a wallet drainer operating across multiple tokens.', ts:t(3),
      row:{ id:'DMO-5181', target:'Wallet-Drainer Incident', created_by:'7vAbCdEfGhLm2a', detail:'Initial evidence and victim reports related to a wallet drainer operating across multiple tokens. Victims report a malicious signature request followed by asset movement to a consolidation wallet.', onchain:'drainerWallet1 victimWallet1 victimWallet2 consolidation1 txHashLong1', created_at:t(3) },
      votes:{ approve:['DEMO_C'], reject:['DEMO_B'] } },
    { type:'challenge', id:'DMO-4990', title:'Exchange Deposit Attribution', creator:'HjKlMnPq9pQe', sub:'Attribution report linking deposit addresses to exchange clusters is challenged on an intermediary hop.', ts:t(4),
      row:{ id:'DMO-4990', item_label:'Exchange Deposit Attribution', challenger:'HjKlMnPq9pQe', item_id:'DMO-4990r', reason:'The attribution treats an exchange hot wallet as the endpoint, but the deposit routed through an intermediary the report never addresses. The on-chain path shows one more hop before the exchange.', created_at:t(4) },
      votes:{ approve:['DEMO_B'], reject:[] } },
    { type:'report', id:'DMO-5202', title:'Token Team Wallet Movements', creator:'8BvCdEfRtY1', sub:'Analysis of team wallet movements and token unlock events against the published vesting schedule.', ts:t(1),
      row:{ id:'DMO-5202', company:'Token Team Wallet Movements', wallet:'8BvCdEfRtY1', summary:'Analysis of team wallet movements and token unlock events against the published vesting schedule. Several transfers precede the stated cliff, moving tokens to fresh wallets ahead of the public unlock.', onchain:'teamWallet1 freshWallet1 freshWallet2 txHashLong1 txHashLong2', tx:'sigA1LongEnoughToCount sigA2LongEnoughToCount', created_at:t(1) },
      votes:{ approve:[], reject:[] } }
  ];
}
function rfInstallDemo(){
  if(window.OSI_DEMO_MODE !== true) return [];
  window.ANALYST_WEIGHT = window.ANALYST_WEIGHT || {};
  window.VERIFIED_ANALYSTS = window.VERIFIED_ANALYSTS || {};
  ['DEMO_B','DEMO_C'].forEach(function(w){ if(window.ANALYST_WEIGHT[w]==null) window.ANALYST_WEIGHT[w]=2; window.VERIFIED_ANALYSTS[w]=window.VERIFIED_ANALYSTS[w]||{handle:w}; });
  var sample=reviewQueueSample();
  window.VOUCHES = window.VOUCHES || {};
  sample.forEach(function(it){ window.__rfRows[vouchKey(it.type,it.id)]=it.row; window.VOUCHES[vouchKey(it.type,it.id)]=it.votes; });
  return sample.map(function(it){ return {type:it.type, id:it.id, title:it.title, sub:it.sub, ts:it.ts, creator:it.creator, _demo:true}; });
}
// ============================================================
//  Secure analyst/maintainer intake (Stage 2B)
//  Pending case/report intake is RLS-protected (Stage 2A). Verified analysts
//  prove wallet ownership with an off-chain signed message; the maintainer uses
//  the existing Supabase session. The Edge Function osi-analyst-intake verifies
//  server-side and returns pending rows. The client checks below are UI hints
//  only — never the security boundary.
// ============================================================
function osiB64(bytes){
  var u = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes||[]);
  var s=''; for(var i=0;i<u.length;i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
async function osiAnalystIntakeProof(){
  // Reuse a recent proof (well inside the server's 120s window) so unlocking the
  // floor and then voting does not trigger a second signMessage prompt.
  if(window.__osiProof && window.__osiProof.proof && window.__osiProof.proof.wallet===walletPubkey && (Date.now()-window.__osiProof.at < 90000)){
    return window.__osiProof.proof;
  }
  var prov = (typeof getConnectedProvider==='function') ? getConnectedProvider() : (typeof getProvider==='function'?getProvider():null);
  if(!walletPubkey || !prov){
    if(typeof toggleWallet==='function'){ try{ await toggleWallet(); }catch(e){} }
    prov = (typeof getConnectedProvider==='function') ? getConnectedProvider() : (typeof getProvider==='function'?getProvider():null);
  }
  if(!walletPubkey || !prov){ var e0=new Error('no_wallet'); e0.status=401; throw e0; }
  if(typeof prov.signMessage !== 'function'){ var e1=new Error('This wallet cannot sign messages.'); e1.status=400; throw e1; }
  var msg = 'OSI Analyst Intake Access v1\nwallet: '+walletPubkey+'\nissued: '+Date.now()+'\nnonce: '+(Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2));
  var res = await prov.signMessage(new TextEncoder().encode(msg), 'utf8');
  var sigBytes = (res && res.signature) ? res.signature : res;
  var proof = { wallet: walletPubkey, message: msg, signature: osiB64(sigBytes) };
  window.__osiProof = { at: Date.now(), proof: proof };
  return proof;
}
// Stage 2C: record a verified analyst review action (approve/challenge) through
// the secure Edge Function. Identity is the wallet signMessage proof; tx_sig is
// the on-chain memo reference (required, but never trusted as identity). The DB
// write + any publication happen server-side (service role), never anon.
async function osiReviewAction(o){
  var proof = await osiAnalystIntakeProof();
  var url = SUPABASE_URL + '/functions/v1/osi-analyst-intake';
  var headers = { 'Content-Type':'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization':'Bearer '+SUPABASE_ANON_KEY };
  var payload = { mode:'review_action', wallet:proof.wallet, message:proof.message, signature:proof.signature, item_type:o.item_type, item_id:o.item_id, vote:o.vote, tx_sig:o.tx_sig };
  var res = await fetch(url, { method:'POST', headers: headers, body: JSON.stringify(payload) });
  if(!res.ok){ var er=new Error('review_'+res.status); er.status=res.status; throw er; }
  return await res.json();
}
// Fetch pending intake from the secure endpoint. Caches per session so tab
// switches / pagination do not re-prompt Phantom; pass {force:true} to refresh.
async function osiAnalystIntakeFetch(opts){
  opts = opts || {};
  if(!opts.force && window.__osiIntake && (Date.now()-window.__osiIntake.at < 300000)){ return window.__osiIntake.data; }
  var url = SUPABASE_URL + '/functions/v1/osi-analyst-intake';
  var headers = { 'Content-Type':'application/json', 'apikey': SUPABASE_ANON_KEY };
  var maint = (typeof resolveMaintainerAccess==='function') ? resolveMaintainerAccess().allowed : false;
  var body;
  if(maint && SUPA_AUTH_TOKEN){
    headers['Authorization'] = 'Bearer ' + SUPA_AUTH_TOKEN;   // maintainer: Supabase session JWT
    body = '{}';
  } else {
    headers['Authorization'] = 'Bearer ' + SUPABASE_ANON_KEY; // analyst: gateway apikey; auth is the wallet proof
    body = JSON.stringify(await osiAnalystIntakeProof());
  }
  var res = await fetch(url, { method:'POST', headers: headers, body: body });
  if(!res.ok){ var er=new Error('intake_'+res.status); er.status=res.status; throw er; }
  var data = await res.json();
  window.__osiIntake = { at: Date.now(), data: data };
  window.__osiIntakeState = null;
  return data;
}
async function osiIntakeUnlock(){
  window.__osiIntakeState = null;
  try{ await osiAnalystIntakeFetch({ force:true }); }
  catch(e){ window.__osiIntakeState = (e && e.status===403) ? 'not_verified' : 'unavailable'; }
  try{ renderReviewFloor(); }catch(e){}
}
// Gated / unauthorized states — reuse existing empty-state styling, no redesign.
function rfGatedHtml(state){
  var note, action='';
  if(state==='no_wallet'){
    note='Connect a wallet to access the analyst review floor.';
    action='<button class="fo-cta" type="button" onclick="toggleWallet().then(function(){try{renderReviewFloor();}catch(e){}})">Connect wallet</button><a class="rvq-apply-link" onclick="apxOpen()" style="margin-left:12px;color:var(--sol);cursor:pointer;text-decoration:none">Apply as analyst →</a>';
  } else if(state==='not_verified'){
    note='Analyst access required · this wallet is not on the verified roster.';
    action='<a class="rvq-apply-link" onclick="apxOpen()" style="color:var(--sol);cursor:pointer;text-decoration:none">Apply as analyst →</a>';
  } else if(state==='needs_unlock'){
    note='Verify your analyst wallet to load the pending review floor.';
    action='<button class="fo-cta" type="button" onclick="osiIntakeUnlock()">Unlock review floor</button>';
  } else {
    note='Analyst intake temporarily unavailable. Please try again in a moment.';
    action='<button class="fo-cta" type="button" onclick="osiIntakeUnlock()">Retry</button>';
  }
  return '<div class="rvq-empty mono">'+note+'<div style="margin-top:14px">'+action+'</div></div>';
}
async function renderReviewFloor(){
  const host=document.getElementById('consensus-floor'); if(!host) return;
  const canVouch = isVerifiedAnalyst(walletPubkey);
  const isMaint = (typeof resolveMaintainerAccess === 'function') ? resolveMaintainerAccess().allowed : false;
  let reports=[], bounties=[], challenges=[];
  // Stage 2B: pending intake is RLS-protected. Read it only through the secure
  // Edge Function (verified analyst via wallet signature, or maintainer via JWT).
  // Never fall back to anon pending reads.
  var intakeState='ok';
  var demoMode = (window.OSI_DEMO_MODE === true);
  if(SUPA_ON && !demoMode){
    var cacheFresh = !!(window.__osiIntake && (Date.now()-window.__osiIntake.at < 300000));
    if(!walletPubkey){ intakeState='no_wallet'; }
    else if(!canVouch && !isMaint){ intakeState='not_verified'; }
    else if(cacheFresh || isMaint){
      try{ var _d = await osiAnalystIntakeFetch(); reports=_d.reports||[]; bounties=_d.bounties||[]; challenges=_d.challenges||[]; intakeState='ok'; }
      catch(e){ intakeState = (e && e.status===403) ? 'not_verified' : 'unavailable'; }
    }
    else if(window.__osiIntakeState==='not_verified'){ intakeState='not_verified'; }
    else if(window.__osiIntakeState==='unavailable'){ intakeState='unavailable'; }
    else { intakeState='needs_unlock'; }   // verified analyst, not yet unlocked this session
  }
  if(intakeState !== 'ok'){ host.innerHTML = rfGatedHtml(intakeState); return; }
  if(SUPA_ON){ try{ await loadVouches(); }catch(e){} }
  window.__rfRows = {};
  const items=[];
  reports.forEach(function(r){ window.__rfRows['report|'+r.id]=r; items.push({type:'report', id:String(r.id), title:(r.company||r.bounty||'Report'), sub:String(r.summary||'').slice(0,150), ts:r.created_at, creator:r.wallet||''}); });
  bounties.forEach(function(b){ window.__rfRows['bounty|'+b.id]=b; items.push({type:'bounty', id:String(b.id), title:(b.target||b.title||'Case'), sub:String(b.detail||'').slice(0,150), ts:b.created_at, creator:b.created_by||''}); });
  challenges.forEach(function(c){ window.__rfRows['challenge|'+c.id]=c; items.push({type:'challenge', id:String(c.id), title:(c.item_label||c.item_id||'record'), sub:String(c.reason||'').slice(0,150), ts:c.created_at, creator:c.challenger||''}); });

  var isDemo=false;
  if(!items.length && window.OSI_DEMO_MODE === true){ isDemo=true; rfInstallDemo().forEach(function(x){ items.push(x); }); }

  // bucket every item once
  items.forEach(function(it){ it._bucket=rfBucket(it); });

  const role = isDemo
    ? 'Sample queue \u00b7 demo data showing how peer review works. Real submissions replace these as soon as they are filed.'
    : (canVouch
      ? ('You are a verified analyst \u00b7 vote power \u00d7'+(analystWeight(walletPubkey)||1)+'. One immutable vote per item.')
      : (isMaint
          ? 'Maintainer view \u00b7 consensus publishes on its own at '+CONSENSUS_THRESHOLD+' weight; your seal remains the override.'
          : (walletPubkey ? 'Contributor access \u00b7 you can read the queue because you have cleared work. Voting needs a verified analyst seat.'
                          : 'Connect a verified analyst wallet to cast votes. Anyone can read the queue.')));

  const counts = { pending:0, ready:0, disputed:0, rejected:0 };
  items.forEach(function(it){ if(counts[it._bucket]!=null) counts[it._bucket]++; });

  // filter by tab + search
  let list = items.filter(function(x){ return x._bucket===rfTab; });
  if(RF_Q){
    list = list.filter(function(x){
      var hay=[x.title,x.sub,x.id,x.creator, x.id?osiCaseId(x.id):''].map(function(s){ return String(s||'').toLowerCase(); }).join(' ');
      return hay.indexOf(RF_Q)!==-1;
    });
  }
  list.sort(function(x,y){
    const tx=vouchTally(x.type,x.id), ty=vouchTally(y.type,y.id);
    const mx=Math.max(tx.aw,tx.rw), my2=Math.max(ty.aw,ty.rw);
    if(my2!==mx) return my2-mx;
    return new Date(y.ts||0)-new Date(x.ts||0);
  });
  const totalPages=Math.max(1, Math.ceil(list.length/RF_PER));
  if(rfPageN>totalPages) rfPageN=totalPages; if(rfPageN<1) rfPageN=1;
  const page=list.slice((rfPageN-1)*RF_PER, (rfPageN-1)*RF_PER+RF_PER);

  const tabs = '<div class="rvq-bar">'
    + '<div class="rvq-tabs">'
      + rfTabBtn('pending','Pending Review',counts.pending)
      + rfTabBtn('ready','Ready to Publish',counts.ready)
      + rfTabBtn('disputed','Disputed',counts.disputed)
      + rfTabBtn('rejected','Rejected',counts.rejected)
    + '</div>'
    + '<div class="rvq-search"><span class="rvq-search-ic">\u2315</span><input id="rvq-search-input" placeholder="Search case ID, title, wallet\u2026" value="'+escapeHtml(RF_Q)+'" oninput="rfSearch(this.value)"></div>'
  + '</div>';

  const roleNote='<div class="rvq-note mono'+(isDemo?' demo':'')+'">'+role+'</div>';

  let body;
  if(!page.length){
    var emptyMsg = { pending:'No items awaiting review. Cases and reports will appear here when submitted for analyst consensus.', ready:'Nothing has reached the publish line yet.', disputed:'No open disputes right now.', rejected:'Nothing has been closed by consensus.' }[rfTab] || 'Queue clear.';
    body = '<div class="rvq-empty mono">'+emptyMsg+'</div>';
  } else {
    body = '<div class="rvq-list">' + page.map(function(it){ return reviewCard(it, canVouch); }).join('') + '</div>';
  }

  let pager='';
  if(totalPages>1){
    pager='<div class="fo-pnav" style="justify-content:flex-end;margin-top:14px"><button class="fo-pg" type="button" '+(rfPageN<=1?'disabled':'')+' onclick="rfSetPage('+(rfPageN-1)+')">\u2039</button>';
    for(var pi=1;pi<=totalPages;pi++){ pager+='<button class="fo-pg n'+(pi===rfPageN?' active':'')+'" type="button" onclick="rfSetPage('+pi+')">'+pi+'</button>'; }
    pager+='<button class="fo-pg" type="button" '+(rfPageN>=totalPages?'disabled':'')+' onclick="rfSetPage('+(rfPageN+1)+')">\u203a</button></div>';
  }
  host.innerHTML = roleNote + tabs + body + pager;
}
function rfTabBtn(key,label,count){
  return '<button class="rvq-tab'+(rfTab===key?' active':'')+' t-'+key+'" type="button" onclick="rfSetTab(\''+key+'\')">'+label+' <span class="rvq-ct">'+count+'</span></button>';
}
function reviewCard(it, canVouch){
  const row=(window.__rfRows||{})[vouchKey(it.type,it.id)]||null;
  const mine = myVouch(it.type, it.id);
  const dec = vouchDecision(it.type,it.id,row);
  const locked = !!dec;
  const own = (it.creator && walletPubkey && String(it.creator)===String(walletPubkey));
  const t = vouchTally(it.type,it.id);
  const thr = vouchThreshold(it.type,it.id,row);
  const bucket = it._bucket || rfBucket(it);

  const typeBadge = it.type==='bounty'
    ? '<span class="rvc-type case">CASE</span>'
    : (it.type==='challenge' ? '<span class="rvc-type chal">CHALLENGE</span>' : '<span class="rvc-type report">REPORT</span>');
  const statusBadge = {
    pending:'<span class="rvc-st new">NEW</span>',
    ready:'<span class="rvc-st ready">READY</span>',
    disputed:'<span class="rvc-st disp">DISPUTED</span>',
    rejected:'<span class="rvc-st rej">CLOSED</span>'
  }[bucket] || '';

  const cid = osiCaseId(it.id);
  const ev = rfEvidence(row, it.type);
  const tx = rfTxLinks(row, it.type);
  const att = rfAttach(row);
  const chips = '<div class="rvc-chips">'
    + '<span class="rvc-chip"><i>\u26d3</i>Evidence '+ev+'</span>'
    + '<span class="rvc-chip"><i>\u2398</i>TX Links '+tx+'</span>'
    + (att? '<span class="rvc-chip"><i>\u25a4</i>Attachments '+att+'</span>' : '')
  + '</div>';

  // middle: consensus
  const pct = Math.min(100, Math.round(t.aw / Math.max(1,thr) * 100));
  const scoreLine = t.aw+' / '+thr+' weight';
  let consensusState='';
  if(dec==='published') consensusState='<span class="rvc-cs-lock ok">\u2713 consensus reached</span>';
  else if(dec==='rejected') consensusState='<span class="rvc-cs-lock bad">\u2715 closed</span>';
  else consensusState='<span class="rvc-cs-need">'+Math.max(0,thr-t.aw)+' more to publish</span>';
  const mid = '<div class="rvc-mid">'
    + '<div class="rvc-cs-top"><span class="rvc-cs-l mono">PUBLISH CONSENSUS</span><b class="rvc-cs-v mono">'+scoreLine+'</b></div>'
    + '<div class="rvc-bar"><div class="rvc-bar-fill" style="width:'+pct+'%"></div>'+(t.rw>0?('<div class="rvc-bar-rej" style="width:'+Math.min(100,Math.round(t.rw/Math.max(1,CONSENSUS_THRESHOLD)*100))+'%"></div>'):'')+'</div>'
    + '<div class="rvc-votes mono"><span class="ok">\u25cf Approve '+t.aw+'</span><span class="bad">\u25cf Reject '+t.rw+'</span>'+(it.type!=='challenge'?'<span class="rvc-cs-note">'+consensusState+'</span>':'<span class="rvc-cs-note">'+consensusState+'</span>')+'</div>'
  + '</div>';

  // right: your vote + review button
  let yourVote;
  if(own) yourVote='<span class="rvc-yv own mono">Your submission</span>';
  else if(mine) yourVote='<span class="rvc-yv '+(mine==='approve'?'ok':'bad')+' mono">'+(mine==='approve'?'\u2713 Voted publish':'\u2715 Voted close')+'</span>';
  else if(locked) yourVote='<span class="rvc-yv mono">Locked</span>';
  else yourVote='<span class="rvc-yv mono">Not voted</span>';
  const right = '<div class="rvc-right">'
    + '<span class="rvc-yv-l mono">YOUR VOTE</span>'
    + yourVote
    + '<button class="rvc-review" type="button" onclick="rvOpen(\''+it.type+'\',\''+crAttr(it.id)+'\')">Review</button>'
  + '</div>';

  return '<div class="rvc'+(locked?' locked':'')+'" data-b="'+bucket+'">'
    + '<div class="rvc-left">'
      + '<div class="rvc-badges">'+typeBadge+statusBadge+'</div>'
      + '<div class="rvc-ttl">'+escapeHtml(cid)+' \u00b7 '+escapeHtml(it.title)+'</div>'
      + '<div class="rvc-by mono">Submitted by '+raShortW(it.creator)+' \u00b7 '+raTimeAgo(it.ts)+'</div>'
      + (it.sub? '<div class="rvc-sum">'+escapeHtml(it.sub)+'</div>' : '')
      + chips
    + '</div>'
    + mid
    + right
  + '</div>';
}
// ===== review drawer: card is the summary, drawer is the full report + voting =====
var rvCtx=null;
function rvOpen(type,id){
  var row=(window.__rfRows||{})[vouchKey(type,id)]||null;
  if(!row){ showToast('This item could not be loaded.'); return; }
  rvCtx={type:type,id:id};
  var d=document.getElementById('rv-drawer'); var body=document.getElementById('rv-drawer-body');
  if(!d||!body) return;
  body.innerHTML=rvDrawerHtml(type,id,row);
  d.classList.add('open'); d.setAttribute('aria-hidden','false'); document.body.style.overflow='hidden';
}
function rvClose(){ var d=document.getElementById('rv-drawer'); if(d){ d.classList.remove('open'); d.setAttribute('aria-hidden','true'); } document.body.style.overflow=''; rvCtx=null; }
function rvDrawerHtml(type,id,row){
  var canVouch=isVerifiedAnalyst(walletPubkey);
  var mine=myVouch(type,id);
  var dec=vouchDecision(type,id,row);
  var locked=!!dec;
  var own=(row.wallet||row.created_by||row.challenger) && walletPubkey && String(row.wallet||row.created_by||row.challenger)===String(walletPubkey);
  var creator=row.wallet||row.created_by||row.challenger||'';
  var cid=osiCaseId(id);
  var title=escapeHtml(row.company||row.target||row.title||row.item_label||'Item');
  var typeLabel=type==='bounty'?'CASE':(type==='challenge'?'CHALLENGE':'REPORT');
  var fullText=escapeHtml(row.summary||row.detail||row.reason||'No written detail was provided with this submission.');
  var txRaw=String(row.tx||row.onchain||'');
  var txList=txRaw.split(/[\s,;\n]+/).filter(function(x){ return x && x.length>6; }).slice(0,12);
  var txHtml = txList.length
    ? '<div class="rvd-sec"><div class="rvd-sec-h mono">ON-CHAIN REFERENCES ('+txList.length+')</div>'+txList.map(function(tx){ return '<div class="rvd-tx"><code class="mono">'+escapeHtml(tx.slice(0,10)+'\u2026'+tx.slice(-8))+'</code><a href="'+solscanTx(tx)+'" target="_blank" rel="noopener">Solscan \u2197</a></div>'; }).join('')+'</div>'
    : '';
  var meter=consensusMeter(type,id,row);

  var voteBtns='';
  if(canVouch && !locked && !own && !mine){
    voteBtns='<div class="rvd-actions">'
      + '<button class="rvd-vote ap" onclick="vouch(\''+type+'\',\''+crAttr(id)+'\',\'approve\',\''+crAttr(creator)+'\');rvClose()">\u2713 Vouch to publish</button>'
      + '<button class="rvd-vote rj" onclick="vouch(\''+type+'\',\''+crAttr(id)+'\',\'reject\',\''+crAttr(creator)+'\');rvClose()">\u2715 Vote to close</button>'
      + (type!=='challenge' ? ('<button class="rvd-vote ch" onclick="rvClose();chxOpen(\''+type+'\',\''+crAttr(id)+'\',\''+crAttr(row.company||row.target||id)+'\')">\u2696 Challenge</button>') : '')
    + '</div>';
  } else if(own){
    voteBtns='<div class="rvd-note mono">This is your submission \u00b7 you cannot vote on your own work.</div>';
  } else if(mine){
    voteBtns='<div class="rvd-note mono">'+(mine==='approve'?'\u2713 You voted to publish':'\u2715 You voted to close')+' \u00b7 your vote is on-chain and immutable.</div>';
  } else if(locked){
    voteBtns='<div class="rvd-note mono">This item is locked \u00b7 consensus has decided.</div>';
  } else if(!canVouch){
    voteBtns='<div class="rvd-note mono">Voting needs a verified analyst seat. <a onclick="rvClose();apxOpen()">Apply to join \u2192</a></div>';
  }

  return '<div class="rvd-head">'
      + '<div class="rvd-badges"><span class="rvc-type '+(type==='bounty'?'case':(type==='challenge'?'chal':'report'))+'">'+typeLabel+'</span><span class="rvd-cid mono">'+escapeHtml(cid)+'</span></div>'
      + '<h3 class="rvd-title">'+title+'</h3>'
      + '<div class="rvd-by mono">Submitted by '+raShortW(creator)+' \u00b7 '+raTimeAgo(row.created_at)+'</div>'
    + '</div>'
    + '<div class="rvd-meter">'+meter+'</div>'
    + '<div class="rvd-sec"><div class="rvd-sec-h mono">'+(type==='challenge'?'CHALLENGE REASONING':'FULL REPORT')+'</div><div class="rvd-body-txt">'+fullText+'</div></div>'
    + txHtml
    + voteBtns;
}

// ----- maintainer: consensus settings -----
async function admSaveConsensus(){
  if(!requireMaintainerAccess('Save consensus settings')) return;
  const thr = parseInt((document.getElementById('admConThr').value||'3'),10);
  const auto = document.getElementById('admConAuto').checked ? 'on' : 'off';
  const msg = document.getElementById('admConMsg');
  if(isNaN(thr) || thr<1){ if(msg){ msg.style.color='var(--red)'; msg.textContent='Threshold must be 1 or more.'; } return; }
  osiSignEvent({ eventType:'CONFIG_CHANGED', actionLabel:'Save consensus settings', itemType:'config', itemId:'consensus', sensitive:true, onSuccess: async (sig)=>{
  if(msg){ msg.style.color='var(--ink-dim)'; msg.textContent='Saving\u2026'; }
  try{
    await supaUpsertConfig('consensus_threshold', String(thr));
    await supaUpsertConfig('consensus_auto', auto);
    CONSENSUS_THRESHOLD = thr; CONSENSUS_AUTO = (auto==='on');
    if(msg){ msg.style.color='var(--sol)'; msg.textContent = '\u2713 Saved. ' + (auto==='on' ? ('Items now auto-publish at '+thr+' approve-weight.') : 'Auto-publish off, your seal stays final.'); }
    renderReviewFloor();
  }catch(e){ if(msg){ msg.style.color='var(--red)'; msg.textContent='Failed: '+((e&&e.message)||e); } }
  }});
}

// ===== ANALYST ROSTER (founder-curated, level earned by verified work) =====
const ANALYST_TIERS = [
  { t:'I',   name:'Apprentice',      min:0,   cls:'pf-l1' },
  { t:'II',  name:'Investigator',    min:60,  cls:'pf-l2' },
  { t:'III', name:'Detective',       min:180, cls:'pf-l3' },
  { t:'IV',  name:'Chief Detective', min:400, cls:'pf-l4' }
];

// verified-analyst lookup (wallet -> {handle,name}); powers the ★ badge across the site
window.VERIFIED_ANALYSTS = window.VERIFIED_ANALYSTS || {};
async function loadAnalysts(){
  if(!SUPA_ON) return;
  try{
    const a = await supaGet('analysts?select=*&approved=eq.true&verified=eq.true') || [];
    const map={}, wmap={};
    a.forEach(function(x){ if(x.wallet){ map[String(x.wallet)] = { handle:x.handle, name:x.name, avatar_url:x.avatar_url||'' }; wmap[String(x.wallet)] = (x.tier_weight==null?1:Number(x.tier_weight)); } });
    window.VERIFIED_ANALYSTS = map; window.ANALYST_WEIGHT = wmap;
  }catch(e){ /* table may not exist yet */ }
}
function isVerifiedAnalyst(wallet){ return !!(wallet && window.VERIFIED_ANALYSTS && window.VERIFIED_ANALYSTS[String(wallet)]); }
function analystStats(wallet, reports, bounties){
  const w = String(wallet);
  const authored = reports.filter(function(r){ return String(r.wallet)===w; }).length;
  const won = bounties.filter(function(b){ return String(b.winner_wallet)===w; }).length;
  const xp = authored*15 + won*60;
  let idx=0; for(let i=0;i<ANALYST_TIERS.length;i++){ if(xp>=ANALYST_TIERS[i].min) idx=i; }
  return { authored:authored, won:won, xp:xp, tier:ANALYST_TIERS[idx] };
}
function analystCard(a){
  const handle = String(a.handle||'').replace(/^@/,'').replace(/[^A-Za-z0-9_]/g,'').slice(0,30);
  const name = escapeHtml(a.name || (handle ? '@'+handle : short(a.wallet)));
  const av = (typeof pfIdenticon==='function') ? pfIdenticon(String(a.wallet), 44) : '';
  const xrow = handle ? '<a class="ar-x" href="https://x.com/'+escapeHtml(handle)+'" target="_blank" rel="noopener">@'+escapeHtml(handle)+' \u2197</a>' : '<span class="ar-x mono" style="color:var(--ink-faint)">'+escapeHtml(short(a.wallet))+'</span>';
  const bio = a.bio ? '<div class="ar-bio">'+escapeHtml(String(a.bio).slice(0,160))+'</div>' : '';
  const t = a.tier;
  return '<div class="ar-card" role="button" tabindex="0" onclick="if(event.target.closest(&quot;a&quot;))return;openRosterProfile(\''+escapeHtml(String(a.wallet))+'\')" onkeydown="if(event.key===&quot;Enter&quot;)openRosterProfile(\''+escapeHtml(String(a.wallet))+'\')">'
    + '<div class="ar-top">'+av+'<div class="ar-id"><div class="ar-name">'+name+' <span class="ar-verif" title="Verified analyst">\u2605</span></div>'+xrow+'</div></div>'
    + bio
    + '<div class="ar-tier '+t.cls+'">TIER '+t.t+' \u00b7 '+escapeHtml(t.name)+'</div>'
    + '<div class="ar-stats">'
      + '<div><span class="n">'+a.xp+'</span><span class="l">XP</span></div>'
      + '<div><span class="n">'+a.authored+'</span><span class="l">intel</span></div>'
      + '<div><span class="n">'+a.won+'</span><span class="l">bounties won</span></div>'
    + '</div>'
  + '</div>';
}
async function renderAnalysts(){
  const host=document.getElementById('analyst-roster'); if(!host) return;
  if(!SUPA_ON){ host.innerHTML=''; return; }
  let analysts=[], reports=[], bounties=[];
  try{ analysts = await supaGet('analysts?select=*&approved=eq.true') || []; }catch(e){}
  try{ reports  = await supaGet('reports?select=wallet&approved=eq.true') || []; }catch(e){}
  try{ bounties = await supaGet('bounties?select=winner_wallet&winner_wallet=not.is.null') || []; }catch(e){}
  if(!analysts.length){ host.innerHTML=''; return; }
  const rows = analysts.map(function(a){ return Object.assign({}, a, analystStats(a.wallet, reports, bounties)); })
                       .sort(function(x,y){ return y.xp - x.xp; });
  host.innerHTML = '<div class="rec-sec-h">THE ROSTER \u00b7 VERIFIED ANALYSTS <span class="ar-count">'+rows.length+'</span></div><div class="ar-grid">' + rows.map(analystCard).join('') + '</div>';
}

// ===== Analyst Proof-of-Work Leaderboard (Round 1a) =====
// Reputation is earned from reviewed work only. Peer support (SOL) is voluntary and
// NEVER affects reputation or vote weight. Vote weight is capped. Identity signals are
// optional and do not by themselves confer trust. Demo data is only available when
// window.OSI_DEMO_MODE === true; live mode stays empty until real rows exist.
var LB_IS_DEMO = false;
var LEADERBOARD_SAMPLE = [
  { id:'a1', wallet:'7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', handle:'chainseer', name:'chainseer', tier:2, reviewed:34, reports:9, challenges:5, memo:71, weight:1.75, badges:['Verified','10+ reviews','First seal','Challenge accepted'], x:true, linkedin:true, joined:'Feb 2026', peer:2.4, risk:0 },
  { id:'a2', wallet:'4Nd1mYh8pQ2rStUvWxYz3aBcDeFgHjKmNpQrStUvWxY', handle:'memo_maria', name:'memo.maria', tier:2, reviewed:26, reports:5, challenges:4, memo:53, weight:1.5, badges:['Verified','Peer reviewer','Clean record'], x:false, linkedin:true, joined:'Feb 2026', peer:0.8, risk:0 },
  { id:'a3', wallet:'9zAbCdEfGhJkLmNpQrStUvWxYz2345678aBcDeFgHjK', handle:'solsleuth', name:'solsleuth', tier:2, reviewed:22, reports:6, challenges:3, memo:48, weight:1.5, badges:['Verified','6 approved reports'], x:true, linkedin:false, joined:'Mar 2026', peer:1.1, risk:0 },
  { id:'a4', wallet:'3RtY6uJ8kLmN2pQ4sV7wX9zAbCdEfGhJkLmNpQrStUv', handle:'rugtracer', name:'rugtracer', tier:1, reviewed:15, reports:4, challenges:2, memo:30, weight:1.25, badges:['Verified','Tracer'], x:true, linkedin:false, joined:'Mar 2026', peer:0.5, risk:0 },
  { id:'a5', wallet:'5FhGjKlMnBvCxZaSdFgHjKlPoIuYtReWqAsDfGhJkLm', handle:'', name:'', tier:1, reviewed:12, reports:3, challenges:1, memo:22, weight:1.25, badges:['Verified','Wallet-only'], x:false, linkedin:false, joined:'Apr 2026', peer:0, risk:0 },
  { id:'a6', wallet:'2WpQeRtYuIoPaSdFgHjKlZxCvBnMqWeRtYuIoPaSdFg', handle:'degen_dt', name:'degen.dt', tier:0, reviewed:6, reports:1, challenges:0, memo:9, weight:1.0, badges:['New analyst'], x:true, linkedin:false, joined:'Apr 2026', peer:0.2, risk:0 }
];
// transparent reputation: reviewed work + approved reports + successful challenges + signed actions
function lbRep(a){ return (a.reviewed||0)*4 + (a.reports||0)*10 + (a.challenges||0)*8 + (a.memo||0)*1; }
function lbTier(i){ return ANALYST_TIERS[Math.max(0, Math.min(ANALYST_TIERS.length-1, i||0))]; }
function lbList(){
  if(window.__realLb && window.__realLb.length){ window.__lbList = window.__realLb; return window.__realLb; }
  if(window.OSI_DEMO_MODE !== true){ LB_IS_DEMO=false; window.__lbList=[]; return []; }
  LB_IS_DEMO=true;
  var rows = LEADERBOARD_SAMPLE.map(function(a){ return Object.assign({}, a, { rep: lbRep(a) }); });
  rows.sort(function(x,y){ return y.rep - x.rep; });
  window.__lbList = rows;
  return rows;
}
// ===== identity: serious geometric avatar (deterministic gradient monogram; custom upload wins) =====
var OSI_AV_PAL=[['#22d3ee','#0e7490'],['#a78bfa','#5b21b6'],['#14f195','#047857'],['#fb923c','#9a3412'],['#38bdf8','#1e40af'],['#e879f9','#86198f']];
function osiAvatarUrl(wallet, a){
  try{ var loc=localStorage.getItem('stw_avatar_'+String(wallet||'')); if(loc) return loc; }catch(e){}
  if(a && a.avatar_url) return String(a.avatar_url);
  var m=(window.VERIFIED_ANALYSTS||{})[String(wallet||'')];
  return (m && m.avatar_url) ? String(m.avatar_url) : '';
}
function osiAvatarSvg(seed, size, name, url){
  size=size||40;
  if(url){ return '<img class="osi-av" src="'+escapeHtml(String(url))+'" alt="" width="'+size+'" height="'+size+'" style="width:'+size+'px;height:'+size+'px" loading="lazy">'; }
  var h=pfHash(String(seed||'osi'));
  var p=OSI_AV_PAL[h % OSI_AV_PAL.length];
  var rot=(h>>3)%360;
  var ch=(String(name||'').trim().charAt(0) || String(seed||'?').charAt(0) || '?').toUpperCase();
  var fs=Math.round(size*0.42), r=Math.round(size*0.3);
  return '<svg class="osi-av" width="'+size+'" height="'+size+'" viewBox="0 0 '+size+' '+size+'" role="img" aria-hidden="true">'
    +'<defs><linearGradient id="g'+h+'" gradientTransform="rotate('+rot+' .5 .5)"><stop offset="0" stop-color="'+p[0]+'"/><stop offset="1" stop-color="'+p[1]+'"/></linearGradient></defs>'
    +'<rect x="1" y="1" width="'+(size-2)+'" height="'+(size-2)+'" rx="'+r+'" fill="url(#g'+h+')" opacity=".92"/>'
    +'<rect x="1" y="1" width="'+(size-2)+'" height="'+(size-2)+'" rx="'+r+'" fill="none" stroke="rgba(255,255,255,.14)"/>'
    +'<text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="Archivo,sans-serif" font-weight="800" font-size="'+fs+'" fill="rgba(6,10,18,.9)">'+escapeHtml(ch)+'</text>'
  +'</svg>';
}
var LB_REP_TIP='REP = reviewed cases \u00d74 + approved reports \u00d710 + successful challenges \u00d78 + signed actions \u00d71. Peer support never affects REP.';
function lbStatus(a){ var v=(a.verified!==undefined)? !!a.verified : !!(a.handle||a.name); return v?'<span class="lp-st v">Verified</span>':'<span class="lp-st w">Wallet-only</span>'; }
function lbTierLine(a){ var t=lbTier(a.tier); return '<span class="lp-tier '+t.cls+'">Tier '+t.t+' \u00b7 '+escapeHtml(t.name)+'</span>'; }
function lbName(a){ return a.name ? escapeHtml(a.name) : escapeHtml(short(a.wallet)); }
function lbHandle(a){ return a.handle ? ('@'+escapeHtml(a.handle)) : escapeHtml(short(a.wallet)); }
function lbAct(a){
  var parts=[];
  if(a.reviewed) parts.push('<b>'+a.reviewed+'</b> reviewed');
  if(a.reports)  parts.push('<b>'+a.reports+'</b> reports');
  if(a.challenges) parts.push('<b>'+a.challenges+'</b> challenges');
  if(a.memo) parts.push('<b>'+a.memo+'</b> signed');
  if(a.won) parts.push('<b>'+a.won+'</b> wins');
  return parts.length ? parts.join('<span class="sep">\u00b7</span>') : '<span class="mut">new on the roster</span>';
}
function lbPodiumCard(a, rank){
  var av=osiAvatarSvg(a.wallet, 56, a.name||a.handle, osiAvatarUrl(a.wallet, a));
  return '<div class="lp-pod'+(rank===1?' first':'')+'" role="button" tabindex="0" onclick="openAnalystProfile(\''+a.id+'\')" onkeydown="if(event.key===\'Enter\'){openAnalystProfile(\''+a.id+'\');}">'
    +'<span class="lp-rank r'+rank+'">'+rank+'</span>'
    +'<div class="lp-pod-av">'+av+'</div>'
    +'<div class="lp-pod-nm">'+lbName(a)+'</div>'
    +'<div class="lp-pod-h mono">'+lbHandle(a)+'</div>'
    +'<div class="lp-pod-chips">'+lbStatus(a)+lbTierLine(a)+'</div>'
    +'<div class="lp-pod-rep" title="'+LB_REP_TIP+'"><span class="n">'+a.rep+'</span><span class="l">REP</span></div>'
    +'<div class="lp-pod-ft mono"><span>\u00d7'+a.weight+'</span><span class="l">weight</span></div>'
  +'</div>';
}
function lbTableRow(a, rank){
  var av=osiAvatarSvg(a.wallet, 34, a.name||a.handle, osiAvatarUrl(a.wallet, a));
  return '<div class="lp-row" role="button" tabindex="0" onclick="openAnalystProfile(\''+a.id+'\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();openAnalystProfile(\''+a.id+'\');}">'
    +'<span class="lp-n mono">'+rank+'</span>'
    +'<div class="lp-who">'+av+'<div class="lp-who-t"><b>'+lbName(a)+'</b><span class="mono">'+lbHandle(a)+'</span></div></div>'
    +'<span class="lp-cell st">'+lbStatus(a)+lbTierLine(a)+'</span>'
    +'<span class="lp-cell act">'+lbAct(a)+'</span>'
    +'<span class="lp-cell rep mono r" title="'+LB_REP_TIP+'">'+a.rep+' <i>REP</i></span>'
    +'<span class="lp-cell wt mono r">\u00d7'+a.weight+'</span>'
  +'</div>';
}
var lbPageN=1, LB_PER=8;
function lbPage(p){ lbPageN=p|0; renderLeaderboard(); var b=document.getElementById('lb-board'); if(b){ try{ b.scrollIntoView({behavior:'smooth',block:'start'}); }catch(e){} } }
function renderLeaderboard(){
  var pod=document.getElementById('lb-podium');
  var host=document.getElementById('lb-body');
  if(!host && !pod) return;
  var rows=lbList();
  if(!rows.length){
    if(pod){ pod.innerHTML='<div class="lb-empty-state"><b>No verified analysts ranked yet.</b><span>Verified analysts will appear here after signed contribution data is available.</span></div>'; }
    if(host){ host.innerHTML='<div class="fd-empty mono" style="padding:18px 14px">No analyst ranking rows available yet.</div>'; }
    var ec=document.getElementById('lb-count'); if(ec){ ec.textContent=''; }
    var ep=document.getElementById('lb-pnav'); if(ep){ ep.innerHTML=''; }
    return;
  }
  if(pod){
    var demo = LB_IS_DEMO ? '<div class="lb-demo">Demo roster shown \u00b7 verified analysts appear here after signed contributions.</div>' : '';
    var top=rows.slice(0,3);
    var order=[]; if(top[1]) order.push([top[1],2]); if(top[0]) order.push([top[0],1]); if(top[2]) order.push([top[2],3]);
    pod.innerHTML = demo + '<div class="lp-podium-row">' + order.map(function(x){ return lbPodiumCard(x[0],x[1]); }).join('') + '</div>';
  }
  if(host){
    var rest=rows.slice(3);
    var totalPages=Math.max(1, Math.ceil(rest.length/LB_PER));
    if(lbPageN>totalPages) lbPageN=totalPages; if(lbPageN<1) lbPageN=1;
    var from=(lbPageN-1)*LB_PER, page=rest.slice(from, from+LB_PER);
    host.innerHTML = page.length ? page.map(function(a,i){ return lbTableRow(a, from+i+4); }).join('')
                                 : '<div class="fd-empty mono" style="padding:18px 14px">The podium holds the whole roster right now.</div>';
    var c=document.getElementById('lb-count');
    if(c){ c.textContent = rows.length ? ('Showing '+rows.length+' analyst'+(rows.length===1?'':'s')+' \u00b7 ranked by signed proof-of-work') : ''; }
    var pn=document.getElementById('lb-pnav');
    if(pn){
      if(totalPages<=1){ pn.innerHTML=''; }
      else{
        var ph='<button class="fo-pg" type="button" '+(lbPageN<=1?'disabled':'')+' onclick="lbPage('+(lbPageN-1)+')" aria-label="Previous">\u2039</button>';
        for(var pi=1; pi<=totalPages; pi++){ ph+='<button class="fo-pg n'+(pi===lbPageN?' active':'')+'" type="button" onclick="lbPage('+pi+')">'+pi+'</button>'; }
        ph+='<button class="fo-pg" type="button" '+(lbPageN>=totalPages?'disabled':'')+' onclick="lbPage('+(lbPageN+1)+')" aria-label="Next">\u203a</button>';
        pn.innerHTML=ph;
      }
    }
  }
}
// ===== real roster: verified analysts replace the demo board as they sign work =====
async function lbHydrateReal(){
  if(!SUPA_ON) return;
  try{
    var analysts=await supaGet('analysts?select=*&approved=eq.true')||[];
    if(!analysts.length) return;
    var reports=[], bounties=[];
    try{ reports=await supaGet('reports?select=wallet&approved=eq.true')||[]; }catch(e){}
    try{ bounties=await supaGet('bounties?select=winner_wallet&winner_wallet=not.is.null')||[]; }catch(e){}
    var rows=analysts.map(function(a){
      var st=analystStats(a.wallet, reports, bounties);
      var rep=st.xp|0, ti=0;
      for(var i=0;i<ANALYST_TIERS.length;i++){ if(rep>=ANALYST_TIERS[i].min) ti=i; }
      return { id:'w:'+a.wallet, wallet:String(a.wallet), handle:a.handle||'', name:a.name||a.handle||'',
        verified:(a.verified!==false), avatar_url:a.avatar_url||'', tier:ti,
        reviewed:0, reports:st.authored|0, challenges:0, memo:0, won:st.won|0,
        weight:(a.tier_weight!=null? Number(a.tier_weight): (1+ti*0.25)), rep:rep,
        badges:['Verified'], x:false, linkedin:false, joined:'', peer:0, risk:0 };
    }).sort(function(x,y){ return y.rep-x.rep; });
    window.__realLb=rows; LB_IS_DEMO=false; lbPageN=1;
    renderLeaderboard();
  }catch(e){}
}
async function lbActions(){
  var host=document.getElementById('lb-actions'); if(!host) return;
  if(!SUPA_ON){ host.innerHTML='<div class="fd-empty mono">No recent analyst actions yet.</div>'; return; }
  try{
    var evs=await supaGet('onchain_events?select=event_type,tx_sig,created_at,actor_wallet&order=created_at.desc&limit=4');
    if(!evs||!evs.length){ host.innerHTML='<div class="fd-empty mono">No recent analyst actions yet.</div>'; return; }
    host.innerHTML=evs.map(function(ev){
      var sig=String(ev.tx_sig||'');
      var right=sig?('<a class="fd-ago mono" href="https://solscan.io/tx/'+encodeURIComponent(sig)+'" target="_blank" rel="noopener">'+escapeHtml(sig.slice(0,4)+'\u2026'+sig.slice(-4))+' \u2197</a>'):('<span class="fd-ago mono">'+fdAgo(ev.created_at)+'</span>');
      return '<div class="fd-it"><span class="fd-ic vio">\u25ce</span><div class="fd-tx"><b>'+escapeHtml(String(ev.event_type||'SIGNED_ACTION'))+'</b><span>'+raShortW(ev.actor_wallet)+' \u00b7 '+fdAgo(ev.created_at)+'</span></div>'+right+'</div>';
    }).join('');
  }catch(e){ host.innerHTML='<div class="fd-empty mono">Proof log unavailable right now.</div>'; }
}
// ===== apply-for-credentials modal =====
function apxOpen(){ var m=document.getElementById('apx-modal'); if(!m) return; m.classList.add('open'); document.body.style.overflow='hidden'; var t=document.getElementById('an-tg'); if(t) setTimeout(function(){ try{t.focus();}catch(e){} },60); }
function apxClose(){ var m=document.getElementById('apx-modal'); if(m) m.classList.remove('open'); document.body.style.overflow=''; }
// ===== profile avatar upload (saved to storage when connected; always remembered on this device) =====
function pfAvatarPick(){ var i=document.getElementById('pf-ava-file'); if(i) i.click(); }
async function pfAvatarChange(inp){
  var f=inp && inp.files && inp.files[0]; if(!f) return;
  if(!/^image\//.test(f.type||'')){ showToast('Please choose an image file.'); return; }
  if(f.size>2*1024*1024){ showToast('Image too large. Keep it under 2 MB.'); return; }
  if(!walletPubkey){ showToast('Connect your wallet first.'); return; }
  var url='';
  try{ url=await supaUpload(f); }catch(e){ url=''; }
  if(!url){
    try{ url=await new Promise(function(res,rej){ var r=new FileReader(); r.onload=function(){res(String(r.result));}; r.onerror=rej; r.readAsDataURL(f); }); }catch(e){ showToast('Could not read the image.'); return; }
    if(url.length>300000){ showToast('Upload unavailable offline; image too large to store locally.'); return; }
  }
  try{ localStorage.setItem('stw_avatar_'+walletPubkey, url); }catch(e){}
  if(SUPA_ON && /^https?:/.test(url)){
    try{ await fetch(SUPABASE_URL+'/rest/v1/analysts?wallet=eq.'+encodeURIComponent(walletPubkey), { method:'PATCH', headers:{ 'apikey':SUPABASE_ANON_KEY, 'Authorization':'Bearer '+(SUPA_AUTH_TOKEN||SUPABASE_ANON_KEY), 'Content-Type':'application/json', 'Prefer':'return=minimal' }, body:JSON.stringify({avatar_url:url}) }); }catch(e){}
  }
  showToast('Avatar updated.');
  try{ renderLeaderboard(); }catch(e){}
  try{ if(typeof CV_CTX==='object' && CV_CTX) openProfileCV(CV_CTX); }catch(e){}
}

// ===== OSI Profile CV: one premium identity surface, three roles (user / analyst / maintainer) =====
// Reputation reflects reviewed work only. Peer support and identity signals never affect vote weight.
var CV_CTX = null;
function cvSolscanAcct(w){ return 'https://solscan.io/account/'+encodeURIComponent(String(w)); }
function cvCopy(txt, btn){
  function done(){ if(btn){ var o=btn.textContent; btn.textContent='\u2713'; setTimeout(function(){ btn.textContent=o==='\u2713'?'\u29c9':o; }, 900); } }
  try{ navigator.clipboard.writeText(String(txt)).then(done, function(){ if(typeof showToast==='function') showToast('Copy failed.'); }); }
  catch(e){ if(typeof showToast==='function') showToast('Copy not available in this browser.'); }
}
function cvTab(btn, id){
  document.querySelectorAll('#ap-modal .cv-tab').forEach(function(b){ b.classList.toggle('active', b===btn); });
  document.querySelectorAll('#ap-modal .cv-pane').forEach(function(p){ p.classList.toggle('active', p.id===id); });
}
function cvTierByXp(xp){ var idx=0; for(var i=0;i<ANALYST_TIERS.length;i++){ if(xp>=ANALYST_TIERS[i].min) idx=i; } return ANALYST_TIERS[idx]; }

// ---- entry points ----
function openAnalystProfile(id){ // leaderboard rows (sample roster)
  var list = window.__lbList || lbList();
  var a=null; for(var i=0;i<list.length;i++){ if(String(list[i].id)===String(id)){ a=list[i]; break; } }
  if(!a) return;
  openProfileCV({ role:'analyst', src:'sample', data:a });
}
function openRosterProfile(wallet){ openProfileCV({ role:'analyst', src:'live', wallet:String(wallet) }); }
function openSelfProfile(){
  if(!walletPubkey){ if(typeof showToast==='function') showToast('Connect your wallet first (top right).'); return; }
  var maint = (typeof resolveMaintainerAccess === 'function') ? resolveMaintainerAccess().allowed : false;
  var role = maint ? 'maintainer' : (isVerifiedAnalyst(walletPubkey) ? 'analyst' : 'user');
  openProfileCV({ role:role, src:'live', wallet:walletPubkey, self:true });
  if(typeof closeWalletMenu==='function') closeWalletMenu();
}
function openProfileCV(ctx){
  CV_CTX = ctx;
  var body=document.getElementById('ap-modal-body'), m=document.getElementById('ap-modal');
  if(!body || !m) return;
  m.classList.add('open'); m.setAttribute('aria-hidden','false'); document.body.classList.add('cr-drawer-lock');
  if(ctx.src==='sample'){ body.innerHTML = cvHtml(cvFromSample(ctx.data), ctx); return; }
  body.innerHTML = '<div class="cv-loading mono">Building profile from live data\u2026</div>';
  cvLoadLive(ctx).then(function(model){ if(CV_CTX===ctx){ body.innerHTML = cvHtml(model, ctx); } });
}
function closeAnalystProfile(){ var m=document.getElementById('ap-modal'); if(m){ m.classList.remove('open'); m.setAttribute('aria-hidden','true'); } document.body.classList.remove('cr-drawer-lock'); CV_CTX=null; }

// ---- models ----
function cvFromSample(a){
  var t = lbTier(a.tier);
  return {
    demo:true, wallet:a.wallet, name:(a.name||''), handle:(a.handle||''),
    tier:t, weight:(a.weight||1), rep:(a.rep!=null?a.rep:lbRep(a)),
    joined:(a.joined||'-'), risk:!!a.risk, x:!!a.x, linkedin:!!a.linkedin,
    stats:{ reviewed:a.reviewed||0, reports:a.reports||0, challenges:a.challenges||0, signed:a.memo||0, vouchesGiven:null, backs:null },
    badges:(a.badges||[]).slice(), peer:(a.peer||0),
    records:[{id:null,label:'OSI-4433'},{id:null,label:'OSI-2185'},{id:null,label:'OSI-7706'}].slice(0, Math.max(1, Math.min(3, a.reports||1))),
    activity:[
      { t:'2h ago',  label:'Signed a review memo on a pending finding' },
      { t:'1d ago',  label:'Report approved and added to the public record' },
      { t:'3d ago',  label:'Challenge filed on a weak attribution, accepted' }
    ],
    firstSeen:(a.joined||'-'), signedTotal:(a.memo||0)
  };
}
async function cvLoadLive(ctx){
  var W = String(ctx.wallet||'');
  var entry = (window.VERIFIED_ANALYSTS||{})[W] || null;
  var m = { demo:false, wallet:W, name:(entry&&(entry.name||''))||'', handle:(entry&&(entry.handle||''))||'',
            x:false, linkedin:false, risk:false, joined:'-', peer:null,
    stats:{ reviewed:null, reports:null, challenges:null, signed:null, vouchesGiven:null, backs:null },
    badges:[], records:[], events:[], pending:!SUPA_ON };
  var weight = (typeof analystWeight==='function' ? analystWeight(W) : 0) || 1;
  m.weight = Math.min(2, weight);
  if(entry && entry.created_at){ try{ m.joined = new Date(entry.created_at).toLocaleDateString(); }catch(e){} }
  var authored=0, won=0;
  if(SUPA_ON){
    async function got(q){ try{ return await supaGet(q) || []; }catch(e){ return null; } }
    var reps = await got('reports?select=id&wallet=eq.'+encodeURIComponent(W)+'&approved=eq.true&limit=100');
    var wins = await got('bounties?select=id&winner_wallet=eq.'+encodeURIComponent(W)+'&limit=100');
    var evs  = await got('onchain_events?select=event_type,item_type,item_id,vote,label,tx_sig,created_at,actor_wallet&actor_wallet=eq.'+encodeURIComponent(W)+'&order=created_at.desc&limit=25');
    if(reps!==null){ authored=reps.length; m.stats.reports=authored; }
    if(wins!==null){ won=wins.length; }
    if(evs!==null){
      m.events = evs;
      m.stats.signed = evs.length;
      m.stats.vouchesGiven = evs.filter(function(e){ return e.event_type==='analyst_vouch'; }).length;
      m.stats.backs = evs.filter(function(e){ return e.event_type==='demand_signal'; }).length;
      m.stats.reviewed = m.stats.vouchesGiven;
      if(evs.length){ try{ m.firstSeen = new Date(evs[evs.length-1].created_at).toLocaleDateString(); }catch(e){} }
      if(ctx.role==='maintainer'){ m.sealsDone = evs.filter(function(e){ return e.event_type==='maintainer_seal'; }).length; }
    }
    if(ctx.role==='maintainer'){
      var pk = await got('escalation_packs?select=id&status=eq.approved&limit=200');
      m.packsApproved = (pk===null? null : pk.length);
    }
  }
  var xp = authored*15 + won*60;
  m.tier = entry ? cvTierByXp(xp) : (ctx.role==='maintainer' ? {name:'Maintainer',cls:'pf-l4',t:'M'} : {name:'Contributor',cls:'pf-l1',t:'-'});
  m.rep = (m.stats.reports!=null || m.stats.reviewed!=null || m.stats.signed!=null)
        ? ((m.stats.reports||0)*10 + (m.stats.reviewed||0)*4 + (m.stats.signed||0)) : null;
  // self-only local signals
  if(ctx.self){
    try{ m.selfBacked = Object.keys(lsGet('stw_boosted',{})||{}).length; }catch(e){ m.selfBacked = null; }
    try{ m.selfApplied = Object.keys(lsGet('stw_applied',{})||{}).length; }catch(e){ m.selfApplied = null; }
  }
  // public records authored (link into the archive when loaded)
  try{
    var cr = window.__crList || [];
    m.records = cr.filter(function(r){ return r && String(r.wallet||'')===W; }).slice(0,5)
      .map(function(r){ return { id:r.id, label:(typeof osiCaseId==='function'? osiCaseId(r.id) : String(r.id).slice(0,8)) }; });
  }catch(e){}
  // honest badges from live signals
  if(entry) m.badges.push('Verified analyst');
  if((m.stats.signed||0)>0) m.badges.push('Memo signer');
  if((m.stats.reports||0)>0) m.badges.push('Public record contributor');
  if((m.stats.reviewed||0)>0) m.badges.push('Case reviewer');
  if(ctx.role==='maintainer') m.badges.push('Maintainer');
  if(!m.badges.length) m.badges.push('New wallet');
  return m;
}

// ---- render ----
function cvNum(v){ return (v===null||v===undefined) ? '<span class="cv-pend" title="No live data yet">\u2013</span>' : String(v); }
function cvRecordBtn(r){
  if(!r.id) return '<span class="ap-case mono">'+escapeHtml(r.label)+'</span>';
  var id=String(r.id).replace(/[^A-Za-z0-9_-]/g,'');
  return '<button class="ap-case mono cv-reclink" type="button" onclick="(window.__crRecords&&window.__crRecords[\''+id+'\'])?openCaseRecord(\''+id+'\'):showView(\'records\')">'+escapeHtml(r.label)+' \u2197</button>';
}
function cvHtml(m, ctx){
  var role = ctx.role||'analyst';
  var nm = m.name ? escapeHtml(m.name) : (m.handle? '@'+escapeHtml(m.handle) : escapeHtml(short(m.wallet)));
  var av = (typeof pfIdenticon==='function') ? pfIdenticon(String(m.wallet), 64) : '';
  var roleLabel = role==='maintainer' ? 'MAINTAINER' : (role==='analyst' ? 'VERIFIED ANALYST' : 'CONTRIBUTOR');
  var roleCls   = role==='maintainer' ? 'maint' : (role==='analyst' ? 'an' : 'usr');
  var idsig = (m.x?'<span class="lb-id x">\uD835\uDD4F verified</span>':'') + (m.linkedin?'<span class="lb-id li">in verified</span>':'');
  if(!idsig) idsig='<span class="lb-id wo">wallet-only</span>';
  var handleLine = m.handle ? '<span class="cv-handle">@'+escapeHtml(m.handle)+'</span>' : '';
  var wshort = escapeHtml(short(m.wallet));
  var demoChip = m.demo ? '<span class="cv-demochip">SAMPLE</span>' : '';

  // ----- tabs -----
  var tabs = '<div class="cv-tabs" role="tablist">'
    + '<button class="cv-tab active" type="button" onclick="cvTab(this,\'cv-ov\')">Overview</button>'
    + '<button class="cv-tab" type="button" onclick="cvTab(this,\'cv-rc\')">Public records</button>'
    + '<button class="cv-tab" type="button" onclick="cvTab(this,\'cv-ac\')">Activity</button>'
    + (role==='maintainer' ? '<button class="cv-tab" type="button" onclick="cvTab(this,\'cv-mt\')">Maintainer</button>' : '')
    + '</div>';

  // ----- Overview pane: proof-of-work grid + badges -----
  var s=m.stats||{};
  var pow = '<div class="cv-kpis">'
    + '<div class="cv-kpi"><span class="n">'+cvNum(s.reviewed)+'</span><span class="l">Reviewed contributions</span></div>'
    + '<div class="cv-kpi"><span class="n">'+cvNum(s.reports)+'</span><span class="l">Approved reports</span></div>'
    + '<div class="cv-kpi"><span class="n">'+cvNum(s.challenges)+'</span><span class="l">Successful challenges</span></div>'
    + '<div class="cv-kpi"><span class="n">'+cvNum(s.signed)+'</span><span class="l">Memo-signed actions</span></div>'
    + (s.vouchesGiven!=null ? '<div class="cv-kpi"><span class="n">'+s.vouchesGiven+'</span><span class="l">Reviews signed</span></div>' : '')
    + (s.backs!=null ? '<div class="cv-kpi"><span class="n">'+s.backs+'</span><span class="l">Cases backed</span></div>' : '')
    + (ctx.self && m.selfApplied!=null ? '<div class="cv-kpi"><span class="n">'+m.selfApplied+'</span><span class="l">Reports submitted (this device)</span></div>' : '')
    + (ctx.self && m.selfBacked!=null ? '<div class="cv-kpi"><span class="n">'+m.selfBacked+'</span><span class="l">Cases supported (this device)</span></div>' : '')
    + '</div>';
  var badges = (m.badges&&m.badges.length) ? '<div class="ap-sec-l">Badges</div><div class="ap-badges">'+m.badges.map(function(b){return '<span class="ap-badge">'+escapeHtml(b)+'</span>';}).join('')+'</div>' : '';
  var usrCta = (role==='user')
    ? '<div class="cv-note">Anyone can contribute: open a case, file a report, support a finding. Build a signed track record, then <a class="cv-a" onclick="closeAnalystProfile();goCommunity(\'tab-analysts\')">apply to the verified roster \u2192</a></div>' : '';
  var ov = '<div class="cv-pane active" id="cv-ov"><div class="ap-sec-l">Proof of work</div>'+pow+badges+usrCta+'</div>';

  // ----- Records pane -----
  var recs = (m.records&&m.records.length)
    ? '<div class="ap-cases">'+m.records.map(cvRecordBtn).join('')+(m.demo?' <span class="ap-case-note">sample</span>':'')+'</div>'
    : '<div class="cv-empty mono">No public case records linked to this wallet yet.</div>';
  var rc = '<div class="cv-pane" id="cv-rc"><div class="ap-sec-l">Public case records</div>'+recs
    + '<div class="cv-note">Only reviewed cases appear in the public archive. <a class="cv-a" onclick="closeAnalystProfile();showView(\'records\')">Open the archive \u2192</a></div></div>';

  // ----- Activity pane -----
  var act;
  if(m.demo){
    act = '<div class="cv-demo-note mono">Sample data for demo only. Not real analyst activity \u00b7 no live transactions.</div>'
      + '<div class="cv-sactl">'+m.activity.map(function(x){ return '<div class="cv-sact"><span class="t mono">'+escapeHtml(x.t)+'</span><span>'+escapeHtml(x.label)+'</span></div>'; }).join('')+'</div>';
  } else if(m.events && m.events.length){
    act = '<div class="ra-feed cv-feed">'+m.events.map(raSignedItem).join('')+'</div>';
  } else {
    act = '<div class="cv-empty mono">No signed on-chain actions from this wallet yet.</div>';
  }
  var ac = '<div class="cv-pane" id="cv-ac"><div class="ap-sec-l">Recent signed actions</div>'+act+'</div>';

  // ----- Maintainer pane -----
  var mt='';
  if(role==='maintainer'){
    mt = '<div class="cv-pane" id="cv-mt"><div class="ap-sec-l">Operational record</div>'
      + '<div class="cv-kpis">'
      + '<div class="cv-kpi"><span class="n">'+cvNum(m.sealsDone)+'</span><span class="l">Records reviewed on-chain</span></div>'
      + '<div class="cv-kpi"><span class="n">'+cvNum(m.packsApproved)+'</span><span class="l">AI packs approved</span></div>'
      + '</div>'
      + '<div class="cv-mtacts">'
      + '<button class="cf-btn primary" type="button" onclick="closeAnalystProfile();admOpen()">Open Command Center</button>'
      + '<button class="cf-btn ghost" type="button" onclick="closeAnalystProfile();goCommunity(\'tab-analysts\')">Open review queue</button>'
      + '</div>'
      + '<div class="cv-note">Maintainer actions are signed and final-review only. AI drafts are never public until a human approves them.</div></div>';
  }

  // ----- right rail -----
  var rep = '<div class="cv-card"><div class="cv-card-h">REPUTATION &amp; STATUS</div>'
    + '<div class="cv-repline"><span class="cv-rep">'+(m.rep!=null?m.rep:'\u2013')+'</span><span class="cv-replbl">reputation'+(m.demo?'':' \u00b7 provisional')+'</span></div>'
    + '<div class="cv-kv"><span>Vote weight</span><b>\u00d7'+(m.weight||1)+' <i>capped</i></b></div>'
    + '<div class="cv-kv"><span>Tier</span><b>'+escapeHtml(m.tier.name)+'</b></div>'
    + '<div class="cv-kv"><span>Joined</span><b>'+escapeHtml(m.joined||'-')+'</b></div>'
    + '<div class="cv-kv"><span>Risk flags</span><b class="'+(m.risk?'cv-bad':'cv-ok')+'">'+(m.risk?'\u26a0 flagged':'none recorded')+'</b></div>'
    + '<div class="cv-fine">Reputation reflects reviewed work only. Peer support and identity signals do not affect vote weight.</div></div>';
  var peer = '<div class="cv-card"><div class="cv-card-h">PEER SUPPORT <span class="cv-hnote">not reputation</span></div>'
    + (m.demo
        ? '<div class="cv-peer">\u25ce '+(m.peer||0)+' SOL received <span class="cv-fine2">sample</span></div>'
        : '<div class="cv-peer cv-dim">No peer support recorded on-chain yet.</div>')
    + '<div class="cv-fine">Voluntary and peer to peer. It never affects reputation, vote weight, review authority, or ranking.</div></div>';
  var chain = '<div class="cv-card"><div class="cv-card-h">ON-CHAIN IDENTITY</div>'
    + '<div class="cv-kv"><span>Wallet</span><b class="mono">'+wshort+'</b></div>'
    + '<div class="cv-kv"><span>First seen</span><b>'+escapeHtml(m.firstSeen||m.joined||'-')+'</b></div>'
    + '<div class="cv-kv"><span>Signed actions</span><b>'+cvNum(m.signedTotal!=null?m.signedTotal:(s.signed))+'</b></div>'
    + '<div class="cv-kv"><span>Memo signer</span><b>'+(((m.signedTotal||s.signed||0)>0)?'yes':'\u2013')+'</b></div>'
    + '<a class="cv-scan" href="'+cvSolscanAcct(m.wallet)+'" target="_blank" rel="noopener">View on Solscan \u2197</a></div>';

  // ----- header -----
  var head = '<div class="cv-head">'
    + '<div class="cv-av">'+av+'</div>'
    + '<div class="cv-idbox">'
      + '<div class="cv-name">'+nm+' '+handleLine+' '+demoChip+'</div>'
      + '<div class="cv-pills"><span class="cv-role '+roleCls+'">'+roleLabel+'</span><span class="lb-tier '+m.tier.cls+'">'+escapeHtml(m.tier.name)+'</span>'+idsig+'</div>'
      + '<div class="cv-wline mono">'+wshort+' <button class="cv-copy" type="button" title="Copy wallet" onclick="cvCopy(\''+escapeHtml(String(m.wallet))+'\',this)">\u29c9</button> <a class="cv-wsol" href="'+cvSolscanAcct(m.wallet)+'" target="_blank" rel="noopener">Solana \u2197</a></div>'
    + '</div></div>';

  var foot = m.demo ? '<div class="ap-demo">Sample data for demo only \u00b7 not real analyst activity</div>' : '';
  return '<div class="cv-wrap">'
    + '<div class="cv-main">'+head+tabs+ov+rc+ac+mt+'</div>'
    + '<div class="cv-rail">'+rep+peer+chain+'</div>'
    + '</div>'+foot;
}
// ----- maintainer: roster management -----
async function supaUpsertAnalyst(row){
  const r = await fetch(SUPABASE_URL + '/rest/v1/analysts', {
    method:'POST',
    headers: supaHeaders({ Prefer:'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(row)
  });
  if(!r.ok && r.status!==409) throw new Error('analyst upsert ' + r.status);
  return true;
}
async function admAddAnalyst(){
  if(!requireMaintainerAccess('Add analyst')) return;
  const wallet=(document.getElementById('admAnWallet').value||'').trim();
  const handle=(document.getElementById('admAnHandle').value||'').trim().replace(/^@/,'');
  const name=(document.getElementById('admAnName').value||'').trim();
  const bio=(document.getElementById('admAnBio').value||'').trim();
  const msg=document.getElementById('admAnMsg');
  if(!isSolAddr(wallet)){ if(msg){ msg.style.color='var(--red)'; msg.textContent='Enter a valid Solana wallet address.'; } return; }
  osiSignEvent({ eventType:'ANALYST_VERIFIED', actionLabel:'Add analyst', itemType:'analyst', itemId: wallet, publicLabel:'Analyst verified', onSuccess: async (sig)=>{
  if(msg){ msg.style.color='var(--ink-dim)'; msg.textContent='Adding\u2026'; }
  try{
    await supaUpsertAnalyst({ wallet:wallet, handle:handle||null, name:name||null, bio:bio||null, verified:true, approved:true });
    if(msg){ msg.style.color='var(--sol)'; msg.textContent='\u2713 Analyst added to the roster.'; }
    ['admAnWallet','admAnHandle','admAnName','admAnBio'].forEach(function(id){ const e=document.getElementById(id); if(e) e.value=''; });
    admRefresh(); loadAnalysts(); renderAnalysts();
  }catch(e){ if(msg){ msg.style.color='var(--red)'; msg.textContent='Failed: '+((e&&e.message)||e)+' (did you run the latest SQL?)'; } }
  }});
}
async function admSetAnalyst(wallet, on){
  if(!requireMaintainerAccess(on ? 'Verify analyst' : 'Unverify analyst')) return;
  osiSignEvent({ eventType: on?'ANALYST_VERIFIED':'ANALYST_REVOKED', actionLabel: on?'Verify analyst':'Unverify analyst', itemType:'analyst', itemId: wallet, sensitive: !on, publicLabel: (on?'Analyst verified':null), onSuccess: async (sig)=>{
  try{
    await supaPatch('analysts?wallet=eq.'+encodeURIComponent(wallet), { verified:on, approved:on });
    showToast(on?'Analyst verified and on the roster.':'Analyst hidden from the roster.');
    admRefresh(); loadAnalysts(); renderAnalysts();
  }catch(e){ showToast('Failed: '+((e&&e.message)||e)); }
  }});
}
async function admDelAnalyst(wallet){
  if(!requireMaintainerAccess('Remove analyst')) return;
  if(!confirm('Remove this analyst from the roster? This cannot be undone.')) return;
  osiSignEvent({ eventType:'ANALYST_REVOKED', actionLabel:'Remove analyst', itemType:'analyst', itemId: wallet, sensitive:true, onSuccess: async (sig)=>{
  try{ await supaDelete('analysts?wallet=eq.'+encodeURIComponent(wallet)); showToast('Analyst removed.'); admRefresh(); loadAnalysts(); renderAnalysts(); }
  catch(e){ showToast('Failed: '+((e&&e.message)||e)); }
  }});
}

// ===== Maintainer button: visible only to the configured maintainer wallet =====
function updateAdminButton(){
  const btn=document.getElementById('admLockBtn'); if(!btn) return;
  const access = (typeof resolveMaintainerAccess === 'function') ? resolveMaintainerAccess() : { isMaintainerWallet:false };
  const show = !!access.isMaintainerWallet;
  btn.style.display = show ? '' : 'none';
}
function admUseConnectedAdmin(){
  if(!walletPubkey){ showToast("Connect your wallet first (top right), then click this again."); return; }
  const el=document.getElementById('admAdminW'); if(el) el.value=walletPubkey;
}
async function admSaveAdminWallet(){
  if(!requireMaintainerAccess('Save maintainer wallet')) return;
  const v=(document.getElementById('admAdminW').value||'').trim();
  const msg=document.getElementById('admAdminMsg');
  if(v && !isSolAddr(v)){ if(msg){ msg.style.color='var(--red)'; msg.textContent="That is not a valid Solana address."; } return; }
  osiSignEvent({ eventType:'CONFIG_CHANGED', actionLabel:'Save maintainer wallet', itemType:'config', itemId:'admin_wallet', sensitive:true, onSuccess: async (sig)=>{
  if(msg){ msg.style.color='var(--ink-dim)'; msg.textContent='Saving\u2026'; }
  try{
    await supaUpsertConfig('admin_wallet', v);
    OSI_ADMIN_WALLET = isSolAddr(v) ? v : '';
    updateAdminButton();
    if(msg){ msg.style.color='var(--sol)'; msg.textContent = OSI_ADMIN_WALLET ? ('\u2713 Saved. The maintainer button now appears only when '+short(OSI_ADMIN_WALLET)+' is connected.') : '\u2713 Cleared. The button stays visible until you set a wallet.'; }
  }catch(e){ if(msg){ msg.style.color='var(--red)'; msg.textContent='Save failed: '+((e&&e.message)||e); } }
  }});
}

// ===== Admin: edit a bounty (target, brief, reward, logo) =====
function admEditBounty(id){
  if(!requireMaintainerAccess('Edit case')) return;
  const b = (window.__admBounties||[]).find(function(x){ return String(x.id)===String(id); });
  if(!b){ showToast('Bounty not found, hit Refresh and try again.'); return; }
  document.getElementById('aeb-id').value = b.id;
  document.getElementById('aeb-target').value = b.target || b.title || '';
  document.getElementById('aeb-detail').value = b.detail || '';
  document.getElementById('aeb-reward').value = (b.reward_sol!=null ? b.reward_sol : '');
  document.getElementById('aeb-image').value = b.image || '';
  clearPickedFile('aeb');
  const prev=document.getElementById('aeb-file-prev'); if(prev){ const _ai=safeUrl(b.image); prev.innerHTML = _ai ? '<img src="'+escapeHtml(_ai)+'" alt="">' : ''; }
  const msg=document.getElementById('aeb-msg'); if(msg) msg.textContent='';
  document.getElementById('adm-edit-modal').classList.add('open');
}
function admCloseEdit(){ const m=document.getElementById('adm-edit-modal'); if(m) m.classList.remove('open'); }
async function admSaveBounty(){
  if(!requireMaintainerAccess('Save case')) return;
  const id = document.getElementById('aeb-id').value;
  const target = (document.getElementById('aeb-target').value||'').trim();
  const detail = (document.getElementById('aeb-detail').value||'').trim();
  let reward = parseFloat((document.getElementById('aeb-reward').value||'').trim()); if(isNaN(reward) || reward<0) reward=0; if(reward>2) reward=2;
  let image = (document.getElementById('aeb-image').value||'').trim();
  const msg = document.getElementById('aeb-msg');
  if(!target){ if(msg){ msg.style.color='var(--red)'; msg.textContent='Target cannot be empty.'; } return; }
  osiSignEvent({ eventType:'CASE_EDITED', actionLabel:'Save case', caseId: id, itemType:'bounty', itemId: id, sensitive:true, onSuccess: async (sig)=>{
  if(msg){ msg.style.color='var(--ink-dim)'; msg.textContent='Saving\u2026'; }
  try{
    try{ const up = await uploadPicked('aeb'); if(up) image = up; }catch(e){ if(msg) msg.textContent='Logo upload failed, saving the rest\u2026'; }
    await supaPatch('bounties?id=eq.'+encodeURIComponent(id), { target:target, title:target, detail:detail, reward_sol:reward, image:(image||null) });
    if(msg){ msg.style.color='var(--sol)'; msg.textContent='\u2713 Saved.'; }
    admCloseEdit(); admRefresh(); admReflow();
  }catch(e){ if(msg){ msg.style.color='var(--red)'; msg.textContent='Save failed: '+((e&&e.message)||e); } }
  }});
}

// ===== Support / payout wallet (maintainer-set, stored globally in Supabase) =====
let OSI_SUPPORT_WALLET = '';
let OSI_ADMIN_WALLET = '';
function isSolAddr(a){ a = String(a || '').trim(); return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a); }

async function loadConfig(){
  if(!SUPA_ON) return;
  try{
    const rows = await supaGet('osi_config?key=in.(support_wallet,admin_wallet,consensus_threshold,consensus_auto)&select=key,value');
    (rows||[]).forEach(function(r){
      if(r.key==='support_wallet' && r.value && isSolAddr(r.value)) OSI_SUPPORT_WALLET = String(r.value).trim();
      if(r.key==='admin_wallet'   && r.value && isSolAddr(r.value)) OSI_ADMIN_WALLET   = String(r.value).trim();
      if(r.key==='consensus_threshold' && r.value) CONSENSUS_THRESHOLD = parseInt(r.value,10)||3;
      if(r.key==='consensus_auto') CONSENSUS_AUTO = (r.value==='on');
    });
  }catch(e){ /* no config yet */ }
}
async function supaUpsertConfig(key, value){
  const r = await fetch(SUPABASE_URL + '/rest/v1/osi_config', {
    method:'POST',
    headers: supaHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ key: key, value: value, updated_at: new Date().toISOString() })
  });
  if(!r.ok && r.status !== 409) throw new Error('config save ' + r.status);
  return true;
}
function admUseConnected(){
  if(!walletPubkey){ showToast("Connect your wallet first (top right), then click this again."); return; }
  const el = document.getElementById('admSupport'); if(el) el.value = walletPubkey;
}
async function admSaveSupport(){
  if(!requireMaintainerAccess('Save support wallet')) return;
  const v = (document.getElementById('admSupport').value || '').trim();
  const msg = document.getElementById('admCfgMsg');
  if(v && !isSolAddr(v)){ if(msg){ msg.style.color='var(--red)'; msg.textContent = "That does not look like a valid Solana address."; } return; }
  osiSignEvent({ eventType:'CONFIG_CHANGED', actionLabel:'Save support wallet', itemType:'config', itemId:'support_wallet', sensitive:true, onSuccess: async (sig)=>{
  if(msg){ msg.style.color='var(--ink-dim)'; msg.textContent = 'Saving…'; }
  try{
    await supaUpsertConfig('support_wallet', v);
    OSI_SUPPORT_WALLET = isSolAddr(v) ? v : '';
    if(msg){ msg.style.color='var(--sol)'; msg.textContent = OSI_SUPPORT_WALLET ? ('\u2713 Saved. Flagship reports now accept support to ' + short(OSI_SUPPORT_WALLET) + '.') : '\u2713 Cleared. Support buttons are now hidden.'; }
    try{ renderCaseStudies(); }catch(e){}
    try{ renderWire(); }catch(e){}
  }catch(e){ if(msg){ msg.style.color='var(--red)'; msg.textContent = 'Save failed: ' + ((e && e.message) || e); } }
  }});
}

// ===== THE WIRE: open community intelligence, filed without a bounty =====
let wireState = { sort:'newest', data:[] };

async function renderWire(){
  if(!document.getElementById('wire-cases')) return;
  // Flagship investigations (the curated case studies) feature at the top of the wire.
  const featured = (window.CASE_STUDIES || []).map(function(cs){
    return { id:'cs_'+cs.id, _case:cs.id, subject: cs.company + (cs.ticker ? (' (' + cs.ticker + ')') : ''),
             body: cs.summary || cs.intro || '', author: (cs.author || 'aksusarya'), premium:true, image:'', wallet:'', created_at:'2099-01-01' };
  });
  let community = [];
  if(SUPA_ON){
    try{
      const rows = await supaGet('reports?select=id,bounty,company,wallet,summary,attachment,created_at&approved=eq.true&order=created_at.desc');
      community = (rows || [])
        .filter(function(r){ return !(r.bounty && String(r.bounty).trim()); })   // intel = no bounty
        .map(function(r){
          const isImg = r.attachment && /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(r.attachment);
          return { id:r.id, subject:(r.company || 'Intel dispatch'), body:(r.summary || ''),
                   author:(r.wallet ? short(r.wallet) : 'analyst'), wallet:(r.wallet || ''),
                   image:(isImg ? r.attachment : ''), attachment:(r.attachment || ''),
                   created_at:r.created_at, premium:false };
        });
    }catch(e){ /* feed still shows flagship */ }
  }
  wireState.data = featured.concat(community);
  drawWire();
}
function drawWire(){
  const host=document.getElementById('wire-cases'); if(!host) return;
  wireStats(wireState.data);
  let list = wireState.data.slice();
  if(wireState.sort==='supported'){
    list.sort(function(a,b){ return (((window.boostCounts||{})[b.id])||0) - (((window.boostCounts||{})[a.id])||0); });
  } else {
    list.sort(function(a,b){ if(a.premium!==b.premium) return a.premium?-1:1; return new Date(b.created_at||0) - new Date(a.created_at||0); });
  }
  if(!list.length){
    host.innerHTML = '<div class="wire-empty"><div class="wire-empty-h">The wire is quiet</div><p>No dispatches yet. Be the first to file one. Trace something nobody asked about and publish it here.</p><button class="wire-cta" onclick="wireOpenForm()">+ File a dispatch</button></div>';
    return;
  }
  host.innerHTML = list.map(wireCard).join('');
  const boosted=lsGet('stw_boosted',{});
  host.querySelectorAll('.bounty[data-bid]').forEach(function(card){ if(boosted[card.dataset.bid]) markBoostedUI(card,null); });
  hydrateBoosts();
}
function wireCard(d){
  const id = escapeHtml(d.id);
  const subject = escapeHtml(d.subject || 'Intel dispatch');
  const full = String(d.body || '');
  const snippet = escapeHtml(full.slice(0,130)) + (full.length>130 ? '\u2026' : '');
  const count = ((window.boostCounts||{})[d.id]) || 0;
  const author = escapeHtml(d.author||'analyst');
  const status = d.premium ? 'flag' : 'open';
  const statusLabel = d.premium ? 'FLAGSHIP' : 'DISPATCH';
  let actions = '';
  if(d.premium && d._case){
    actions += '<button class="wr-act primary" type="button" onclick="openReport(\'case\',\''+d._case+'\')">Read report \u2192</button>';
    // Voluntary support to the configured OSI wallet only (no per-dispatch wallet).
    if(OSI_SUPPORT_WALLET){ actions += '<button class="wr-act ghost" type="button" onclick="openTip(\''+OSI_SUPPORT_WALLET+'\',\'OSI project support\',0.5,\'\\u25ce Voluntary support\')">\u25ce Support</button>'; }
  } else {
    actions += '<button class="wr-act ghost" type="button" onclick="stakeBoost(this)">\u2191 Back</button>';
    // Stage 4: removed "Support the analyst" to a dispatch's self-declared wallet
    // (unverified, ambiguous). Support routes only to the configured OSI wallet.
  }
  return '<div class="wire-card bounty'+(d.premium?' premium':'')+'" data-bid="'+id+'">'
    + '<span class="fc-stripe"></span>'
    + '<div class="wr-head"><span class="wr-st '+status+'">'+statusLabel+'</span><span class="wr-by mono">by '+author+'</span><span class="wr-back mono"><span class="b-reward"><span class="n">'+count+'</span></span> backing</span></div>'
    + '<div class="fc-title b-target wr-title">'+subject+'</div>'
    + (snippet ? '<div class="wr-snip">'+snippet+'</div>' : '')
    + '<div class="wr-acts">'+actions+'</div>'
  + '</div>';
}
function wireStats(list){
  const host=document.getElementById('wire-stats'); if(!host) return;
  const total = list.length;
  const flag = list.filter(function(d){ return d.premium; }).length;
  const comm = total - flag;
  host.innerHTML =
      '<div class="wire-op"><div class="wire-op-n cy">'+total+'</div><div class="wire-op-l">Dispatches</div></div>'
    + '<div class="wire-op"><div class="wire-op-n">'+flag+'</div><div class="wire-op-l">Flagship reports</div></div>'
    + '<div class="wire-op"><div class="wire-op-n">'+comm+'</div><div class="wire-op-l">Community filings</div></div>';
}
function wireSort(s){ wireState.sort=s; document.querySelectorAll('.wire-sort').forEach(function(b){ b.classList.toggle('active', b.dataset.s===s); }); drawWire(); }
function wireOpenForm(){ const f=document.getElementById('wire-form'); if(f){ f.hidden=false; f.scrollIntoView({behavior:'smooth',block:'center'}); const t=document.getElementById('wire-subject-in'); if(t) t.focus(); } }
function wireCloseForm(){ const f=document.getElementById('wire-form'); if(f) f.hidden=true; }

async function submitIntel(){
  const subject = (document.getElementById('wire-subject-in').value || '').trim();
  const body = (document.getElementById('wire-body-in').value || '').trim();
  if(!subject){ showToast("Give your dispatch a subject (the entity or wallet it concerns)."); return; }
  if(!body){ showToast("Write up your findings before publishing."); return; }
  if(!rateOk('submit', 6000)){ showToast("Give it a few seconds before filing another dispatch."); return; }
  var _sgI = safetyGate(subject + "\n" + body);
  if(!_sgI.ok){ osiBlockShow(_sgI.hits); return; }
  const _its = Math.floor(Date.now()/1000);
  const memo = "OSI_WIRE_DISPATCH_SUBMITTED|subject=" + String(subject).replace(/\|/g,"/") + "|analyst=" + (walletPubkey||"anon") + "|ts=" + _its;
  withOnchainVote("File a dispatch", memo, async (sig)=>{
    let att = '';
    try{ att = await uploadPicked('wire'); }
    catch(e){ showToast("Attachment upload failed, publishing without it."); }
    const id = 'rep_' + Date.now();
    const reports = lsGet('stw_reports', []);
    reports.unshift({ id, bounty:'', company:subject, summary:body, onchain:'', offchain:'', attachment:att, wallet:walletPubkey||'', tx:sig||'', up:0, dn:0 });
    lsSet('stw_reports', reports);
    if(SUPA_ON){ try{ const row = { id, bounty:'', company:subject, wallet:walletPubkey||'', summary:body, onchain:'', offchain:'', tx:sig||'', approved:false }; if(att) row.attachment = att; await supaPost('reports', row); }catch(e){ console.warn('OSI: intel publish failed.', e); } }
    recordOnchainEvent({ event_type:'wire_dispatch', item_type:'report', item_id:id, label:'filed a dispatch on '+subject, memo_text:memo, tx_sig:sig });
    try{ await sendForm({ _subject:'OSI, Intel Dispatch: '+subject, type:'intel-listing', subject, wallet:walletPubkey||'(none)', summary:body, attachment:att||'(none)', tx:sig||'(none)' }); }catch(e){}
    clearPickedFile('wire');
    ['wire-subject-in','wire-body-in'].forEach(function(x){ const el=document.getElementById(x); if(el) el.value=''; });
    wireCloseForm();
    renderReviewQueue();
    showToast("\\u2713 Dispatch signed on-chain and submitted, it goes live on The Wire once a maintainer approves.");
  });
}

// ===== Solana Pay: turn any tip/reward/support into a scannable payment request =====
const SOLANA_PAY_QR_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
let _qrLibLoading = null, _payOpen = false, _qrTimer = null;

function loadQrLib(){
  if(window.qrcode) return Promise.resolve();
  if(_qrLibLoading) return _qrLibLoading;
  _qrLibLoading = new Promise(function(resolve, reject){
    const s = document.createElement('script');
    s.src = SOLANA_PAY_QR_CDN; s.async = true;
    s.onload = function(){ resolve(); };
    s.onerror = function(){ _qrLibLoading = null; reject(new Error('qr lib failed')); };
    document.head.appendChild(s);
  });
  return _qrLibLoading;
}
// Solana Pay transfer request spec: solana:<recipient>?amount=&label=&message=&memo=
function buildSolanaPayUrl(){
  if(!tipCtx || !tipCtx.wallet || !isSolAddr(tipCtx.wallet)) return '';
  const p = new URLSearchParams();
  if(tipCtx.amount && tipCtx.amount > 0) p.set('amount', String(tipCtx.amount));
  p.set('label', 'OSI');
  p.set('message', 'Voluntary support (does not influence review or publication)');
  p.set('memo', 'OSI1|SUPPORT_SENT');
  return 'solana:' + tipCtx.wallet + '?' + p.toString();
}
function resetSolanaPay(){
  _payOpen = false;
  const box = document.getElementById('tip-pay'); if(box) box.hidden = true;
  const tg = document.getElementById('tip-pay-toggle'); if(tg) tg.innerHTML = '\u229e&nbsp; Or pay with any wallet (Solana Pay) \u25be';
  const qr = document.getElementById('tip-qr'); if(qr) qr.innerHTML = '';
}
function toggleSolanaPay(){
  _payOpen = !_payOpen;
  const box = document.getElementById('tip-pay'); if(box) box.hidden = !_payOpen;
  const tg = document.getElementById('tip-pay-toggle'); if(tg) tg.innerHTML = _payOpen ? '\u229e&nbsp; Or pay with any wallet (Solana Pay) \u25b4' : '\u229e&nbsp; Or pay with any wallet (Solana Pay) \u25be';
  if(_payOpen) renderSolanaPay();
}
function renderSolanaPay(){
  if(!_payOpen) return;
  const url = buildSolanaPayUrl();
  const link = document.getElementById('tip-pay-link'); if(link) link.href = url || '#';
  clearTimeout(_qrTimer);
  _qrTimer = setTimeout(function(){
    const host = document.getElementById('tip-qr'); if(!host) return;
    if(!url){ host.innerHTML = ''; return; }
    host.innerHTML = '<div class="tip-qr-load mono">rendering QR…</div>';
    loadQrLib().then(function(){
      try{
        const qr = window.qrcode(0, 'M'); qr.addData(url); qr.make();
        host.innerHTML = '<img alt="Solana Pay QR" src="' + qr.createDataURL(5, 6) + '">';
      }catch(e){ host.innerHTML = '<div class="tip-qr-fallback mono">QR unavailable here, use the link below.</div>'; }
    }).catch(function(){ host.innerHTML = '<div class="tip-qr-fallback mono">QR unavailable here, use the link below.</div>'; });
  }, 160);
}
function copySolanaPay(){
  const url = buildSolanaPayUrl(); if(!url) return;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(function(){ showToast('Solana Pay link copied \u2713'); }, function(){ showToast('Copy failed, long-press the link to copy it.'); });
  } else { showToast('Copy not supported here, long-press the link.'); }
}

// ===== File + image attachments via Supabase Storage =====
const OSI_BUCKET = 'osi-uploads';
const _picked = {};   // { apply: File|null, bf: File|null }
function _fileInput(key){ return document.getElementById(key+'-file') || document.getElementById(key+'-image'); }
function onPickFile(key){
  const inp = _fileInput(key);
  const f = inp && inp.files && inp.files[0];
  const nameEl = document.getElementById(key+'-file-name');
  const prevEl = document.getElementById(key+'-file-prev');
  if(!f){ _picked[key]=null; if(nameEl) nameEl.textContent=''; if(prevEl) prevEl.innerHTML=''; return; }
  if(f.size > 10*1024*1024){ showToast("That file is over 10MB. Please attach something smaller."); if(inp) inp.value=''; return; }
  if(f.type && !/^(image\/(png|jpe?g|gif|webp|avif)|application\/pdf|text\/(plain|csv))$/i.test(f.type)){ showToast("That file type is not allowed. Attach an image, PDF, or text/CSV file."); if(inp) inp.value=''; _picked[key]=null; return; }
  _picked[key]=f;
  if(nameEl) nameEl.textContent = f.name;
  if(prevEl){
    if(/^image\//.test(f.type||'')){ const rd=new FileReader(); rd.onload=function(){ prevEl.innerHTML='<img src="'+rd.result+'" alt="preview">'; }; rd.readAsDataURL(f); }
    else { prevEl.innerHTML='<div class="file-doc">\uD83D\uDCC4 '+escapeHtml(f.name)+'</div>'; }
  }
}
function clearPickedFile(key){
  _picked[key]=null;
  const inp=_fileInput(key); if(inp) inp.value='';
  const nameEl=document.getElementById(key+'-file-name'); if(nameEl) nameEl.textContent='';
  const prevEl=document.getElementById(key+'-file-prev'); if(prevEl) prevEl.innerHTML='';
}
async function uploadPicked(key){ const f=_picked[key]; if(!f) return ''; return await supaUpload(f); }
async function supaUpload(file){
  if(!SUPA_ON || !file) return '';
  const m = file.name.match(/\.([a-z0-9]+)$/i); const ext = (m ? m[1] : 'bin').toLowerCase();
  const path = 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2,8) + '.' + ext;
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/' + OSI_BUCKET + '/' + path, {
    method:'POST',
    headers:{ 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + (SUPA_AUTH_TOKEN || SUPABASE_ANON_KEY), 'Content-Type': file.type || 'application/octet-stream', 'x-upsert':'false' },
    body: file
  });
  if(!res.ok) throw new Error('upload ' + res.status);
  return SUPABASE_URL + '/storage/v1/object/public/' + OSI_BUCKET + '/' + path;
}
// ===== THE FIELD OFFICE: the bounty operations hub =====
// Curated launch cases (real untraced DAT targets). Also a fallback when Supabase
// is unavailable. User-filed cases come from Supabase and merge in by id.
// Community intelligence requests: starter forensic cases the project wants traced (no posted reward).
// These are seeded into Supabase (where the maintainer manages them); this array is the offline
// fallback shown only if Supabase is unreachable.
const FIELD_SEED = [
  { id:'seed_drainer', target:'Wallet-drainer infrastructure, mapped',      reward_sol:0, detail:'Community intelligence request. Cluster the wallets behind a known drainer pattern, fingerprint the off-ramps, and document the reused infrastructure so the next victim can be warned early. Bring evidence and the community traces it.', created_at:'2026-06-24T00:00:00Z' },
  { id:'seed_rug',     target:'Rug pull post-mortem, follow the liquidity', reward_sol:0, detail:'Community intelligence request. When a token collapses, follow the money out: map the deployer wallets, the liquidity removal, and where the proceeds landed, with a confidence grade on every hop. Open to any analyst.', created_at:'2026-06-23T00:00:00Z' },
  { id:'seed_bridge',  target:'Cross-chain exit after an incident',         reward_sol:0, detail:'Community intelligence request. Trace funds that left Solana through a bridge after an incident: identify the entry wallet, the bridge route, and the destination cluster on the other chain, so exchanges can act on it.', created_at:'2026-06-22T00:00:00Z' },
  { id:'seed_phish',   target:'Phishing wave, shared attribution trail',    reward_sol:0, detail:'Community intelligence request. Aggregate reports from a phishing campaign, cluster the collector wallets, and build one shared attribution trail that victims and exchanges can act on together.', created_at:'2026-06-21T00:00:00Z' }
];
let fieldState = { filter:'open', sort:'reward', q:'', mine:false, page:1, data:[] };
const FIELD_PER_PAGE = 5;

async function renderFieldOffice(){
  if(!document.getElementById('field-cases')) return;
  var demo = (window.OSI_DEMO_MODE === true);   // sample cards only in demo mode
  let list = [];
  window.__foError = false;
  if(SUPA_ON){
    try{
      const rows = await supaGet('bounties?select=*&approved=eq.true&order=created_at.desc');
      list = rows || [];
    }catch(e){
      list = demo ? FIELD_SEED.slice() : [];   // live mode: NO seed cards on failure
      window.__foError = !demo;
    }
  } else {
    list = demo ? FIELD_SEED.slice() : [];     // live mode without Supabase: clean empty state
  }
  fieldState.data = list;
  drawFieldOffice();
  foDeckRender();
  try{ lbHydrateReal(); }catch(e){}
  try{ lbActions(); }catch(e){}
}
function drawFieldOffice(){
  const host=document.getElementById('field-cases'); if(!host) return;
  let base = fieldState.data.slice().filter(function(b){ if(b.winner_wallet) return true; var dl=bountyDeadline(b); return !dl || dl>Date.now(); });
  fieldStats(base);
  let list = base.slice();
  var mc=document.getElementById('fr-myc');
  if(mc){ var mn=base.filter(foIsMine).length; mc.textContent=mn; mc.style.display=mn?'':'none'; }
  const q = (fieldState.q||'').trim().toLowerCase();
  if(q){ list = list.filter(function(b){ return ((b.target||b.title||'')+' '+(b.detail||'')).toLowerCase().indexOf(q)!==-1; }); }
  if(fieldState.mine){ list = list.filter(foIsMine); }
  if(fieldState.filter==='open') list = list.filter(function(b){ return !b.winner_wallet; });
  else if(fieldState.filter==='resolved') list = list.filter(function(b){ return !!b.winner_wallet; });
  if(fieldState.sort==='reward') list.sort(function(a,b){ return (parseFloat(b.reward_sol)||0)-(parseFloat(a.reward_sol)||0); });
  else if(fieldState.sort==='newest') list.sort(function(a,b){ return new Date(b.created_at||0)-new Date(a.created_at||0); });
  else if(fieldState.sort==='boosts') list.sort(function(a,b){ return (((window.boostCounts||{})[b.id])||0)-(((window.boostCounts||{})[a.id])||0); });
  var totalPages = Math.max(1, Math.ceil(list.length / FIELD_PER_PAGE));
  if(fieldState.page > totalPages) fieldState.page = totalPages;
  if(fieldState.page < 1) fieldState.page = 1;
  var pFrom = (fieldState.page-1)*FIELD_PER_PAGE;
  var pageList = list.slice(pFrom, pFrom+FIELD_PER_PAGE);
  var cnt=document.getElementById('fo-count');
  if(cnt){ cnt.textContent = list.length ? ('Showing '+(pFrom+1)+'\u2013'+(pFrom+pageList.length)+' of '+list.length+' cases') : ''; }
  var pnav=document.getElementById('fo-pnav');
  if(pnav){
    if(totalPages<=1){ pnav.innerHTML=''; }
    else{
      var ph='<button class="fo-pg" type="button" '+(fieldState.page<=1?'disabled':'')+' onclick="fieldPage('+(fieldState.page-1)+')" aria-label="Previous page">\u2039</button>';
      for(var pi=1; pi<=totalPages; pi++){ ph+='<button class="fo-pg n'+(pi===fieldState.page?' active':'')+'" type="button" onclick="fieldPage('+pi+')">'+pi+'</button>'; }
      ph+='<button class="fo-pg" type="button" '+(fieldState.page>=totalPages?'disabled':'')+' onclick="fieldPage('+(fieldState.page+1)+')" aria-label="Next page">\u203a</button>';
      pnav.innerHTML=ph;
    }
  }
  if(!list.length){
    if(window.__foError){
      host.innerHTML='<div class="fo-empty"><div class="fo-empty-h">Cases are temporarily unavailable.</div><p>We could not reach the intelligence network just now. Refresh in a moment.</p><button class="fo-cta" onclick="renderFieldOffice()">Retry</button></div>';
      return;
    }
    if(fieldState.mine){
      host.innerHTML='<div class="fo-empty"><div class="fo-empty-h">No cases from this wallet yet.</div><p>Open your first case, it is free and signed with your wallet, so it shows up here as yours.</p><button class="fo-cta" onclick="fieldOpenForm()">+ Open a case</button></div>';
      return;
    }
    const w = fieldState.filter==='resolved' ? 'closed' : (fieldState.filter==='open' ? 'open' : '');
    const why = q ? 'No cases match your search.' : ('No '+w+' cases right now.');
    host.innerHTML='<div class="fo-empty"><div class="fo-empty-h">'+why+'</div><p>Be the first to file one. Name a target nobody has traced and let the community hunt it.</p><button class="fo-cta" onclick="fieldOpenForm()">+ Open a case</button></div>';
    return;
  }
  host.innerHTML = pageList.map(function(b,i){ return fieldCaseCard(b,i); }).join('');
  const boosted=lsGet('stw_boosted',{}), applied=lsGet('stw_applied',{});
  host.querySelectorAll('.bounty[data-bid]').forEach(function(card){
    if(boosted[card.dataset.bid]) markBoostedUI(card,null);
    if(applied[card.dataset.bid]) markAppliedUI(card,null);
  });
  hydrateBoosts();
  if(typeof foAutoPreview==='function'){ try{ foAutoPreview(); }catch(e){} }
}
function fieldSearch(v){ fieldState.q = v||''; fieldState.page=1; drawFieldOffice(); }

// Solana amblem (kucuk inline SVG, yesil) + bounty geri sayim
var SOL_MARK='<svg class="sol-mk" viewBox="0 0 24 19" aria-hidden="true"><path d="M5 1h18l-4 4H1z"/><path d="M1 7.5h18l4 4H5z"/><path d="M5 14h18l-4 4H1z"/></svg>';
function bountyDeadline(b){
  if(b && b.expires_at){ var t=new Date(b.expires_at).getTime(); if(!isNaN(t)&&t>0) return t; }
  if(!(parseFloat(b && b.reward_sol) > 0)) return 0;
  var id=String((b&&b.id)||(b&&b.target)||''); if(!id) return 0;
  var hsh=2166136261; for(var i=0;i<id.length;i++){ hsh^=id.charCodeAt(i); hsh=Math.imul(hsh,16777619); }
  var hours=100+(Math.abs(hsh)%101); // deterministic 100..200h window
  // base the countdown on the case created_at so it is identical on every device
  var base=(b && b.created_at) ? new Date(b.created_at).getTime() : 0;
  if(isNaN(base)||base<=0) base=Date.now();
  return base + hours*3600000;
}
function fmtCountdown(ms){
  if(ms<=0) return null;
  var tm=Math.floor(ms/60000), d=Math.floor(tm/1440), h=Math.floor((tm%1440)/60), m=tm%60;
  if(d>0) return d+'d '+h+'h';
  if(h>0) return h+'h '+m+'m';
  return m+'m';
}
function fieldTick(){
  document.querySelectorAll('.fo-case[data-deadline]').forEach(function(card){
    var dl=parseInt(card.dataset.deadline,10)||0; if(!dl) return;
    var left=dl-Date.now();
    if(left<=0){ card.style.display='none'; return; }
    var cd=card.querySelector('.fc-time[data-cd]'); if(cd){ cd.textContent=fmtCountdown(left); if(left<86400000) cd.classList.add('urgent'); }
  });
}
if(typeof window!=='undefined' && !window.__fieldTick){ window.__fieldTick=setInterval(fieldTick, 30000); }

function fieldCaseCard(b, i){
  const id = escapeHtml(b.id);
  const target = escapeHtml(b.target || b.title || 'case');
  const _d = String(b.detail||'').replace(/\s+/g,' ').trim();
  const descText = _d ? (_d.slice(0,96) + (_d.length>96 ? '\u2026' : '')) : 'No summary provided yet.';
  const desc = escapeHtml(descText);
  const reward = parseFloat(b.reward_sol) || 0;
  const resolved = !!b.winner_wallet;
  const count = ((window.boostCounts||{})[b.id]) || 0;
  const hot = !resolved && count >= 5;
  const status = resolved ? 'closed' : (hot ? 'hot' : 'open');
  const statusLabel = resolved ? 'REVIEWED' : 'SUBMITTED';
  const stageLabel = resolved ? 'Reviewed' : 'Submitted';
  const osi = 'OSI-' + ((pfHash(String(b.id)) % 9000) + 1000);
  const deadline = resolved ? 0 : bountyDeadline(b);
  const _left = deadline - Date.now();
  const _urgent = (deadline && _left < 86400000);
  let timeHtml;
  if(deadline && _left > 0 && !resolved){ timeHtml = '<span class="fc-time'+(_urgent?' urgent':'')+'" data-cd="1">'+fmtCountdown(_left)+'</span>'; }
  else { timeHtml = '<span class="fc-time dim">No deadline</span>'; }
  const supHtml = reward > 0 ? (SOL_MARK+' '+reward) : '<span class="fc-muted">No reward posted</span>';
  return '<div class="fo-case bounty '+status+'" data-bid="'+id+'" data-deadline="'+deadline+'" role="button" tabindex="0" onclick="fieldRowClick(\''+id+'\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();fieldRowClick(\''+id+'\');}">'
    + '<span class="fc-stripe"></span>'
    + '<div class="fc-id"><span class="fc-osi mono">'+osi+'</span><span class="fc-st '+status+'">'+statusLabel+'</span></div>'
    + '<div class="fc-main"><div class="fc-title b-target">'+target+'</div>'+(desc?('<div class="fc-desc">'+desc+'</div>'):'')+'</div>'
    + '<span class="fc-stage"><span class="fc-st '+status+'">'+stageLabel+'</span></span>'
    + '<span class="fc-sup mono">'+supHtml+'</span>'
    + '<span class="fc-back b-reward mono"><span class="n">'+count+'</span></span>'
    + '<span class="fc-dl mono">'+timeHtml+'</span>'
    + '<span class="fc-act"><span class="fc-open">Open \u203a</span></span>'
  + '</div>';
}


// ---- Case file drawer: the single detail surface for an open case ----
var caseFileData = null;
function foWide(){ return window.innerWidth>=1280 && !!document.getElementById('fo-preview'); }
function fieldRowClick(id){ if(foWide()){ foPreviewShow(id); } else { openCaseFile(id); } }
function foPreviewHtml(b){
  var target=escapeHtml(b.target||b.title||'case');
  var briefRaw=String(b.detail||'').replace(/\s+/g,' ').trim();
  var brief=escapeHtml(briefRaw||'No summary provided yet.');
  var reward=parseFloat(b.reward_sol)||0, resolved=!!b.winner_wallet;
  var count=((window.boostCounts||{})[b.id])||0;
  var status=resolved?'closed':(count>=5?'hot':'open');
  var label=resolved?'REVIEWED':'SUBMITTED';
  var osi='OSI-'+((pfHash(String(b.id))%9000)+1000);
  var dl=resolved?0:bountyDeadline(b), left=dl-Date.now();
  var timeV=resolved?'-':(dl&&left>0?fmtCountdown(left):'No deadline');
  var sup=reward>0?(SOL_MARK+' '+reward):'No reward posted';
  var hasDirectProof=!!(b.tx||b.tx_sig);
  var proofLabel=hasDirectProof?'Linked proof event':'No linked proof event';
  var proofDetail=hasDirectProof?'Ready for external verification':'Awaiting first signed action';
  var reviewDetail=resolved?'Reviewed case outcome':'Awaiting analyst report';
  var life='<div class="fp-flow" aria-label="Case lifecycle">'
    + '<span class="fp-step done"><i></i>Intake</span>'
    + '<span class="fp-line '+(resolved?'done':'')+'"></span>'
    + '<span class="fp-step '+(resolved?'done':'next')+'"><i></i>Evidence</span>'
    + '<span class="fp-line '+(resolved?'done':'')+'"></span>'
    + '<span class="fp-step '+(resolved?'active':'next')+'"><i></i>Review</span>'
    + '<span class="fp-line"></span>'
    + '<span class="fp-step next"><i></i>Seal</span>'
    + '</div>';
  var acts='<button class="cf-btn primary" type="button" onclick="openCaseFile(\''+escapeHtml(String(b.id))+'\')">View case file \u2197</button>'
    + (resolved
      ? '<button class="cf-btn ghost" type="button" onclick="caseFileReward()">\u25ce Support the winner</button>'
      : '<button class="cf-btn ghost" type="button" onclick="caseFileApply()">\u2726 Submit a report</button>'
        +'<button class="cf-btn ghost" type="button" onclick="caseFileBack()">\u2191 Support this case</button>')
    + (hasDirectProof
      ? '<button class="cf-btn ghost verify" type="button" onclick="foVerify()">'+SOL_MARK+' Verify on Solana</button>'
      : '<button class="cf-btn ghost verify disabled" type="button" disabled aria-disabled="true">No linked proof event</button>');
  return '<div class="fp-k">SELECTED CASE FILE</div>'
    +'<div class="fp-idrow"><span class="fp-osi mono">'+osi+'</span><span class="fc-st '+status+'">'+label+'</span></div>'
    +'<div class="fp-title">'+target+'</div>'
    +life
    +'<div class="fp-status-console">'
    +'<div><span>Current stage</span><b>'+escapeHtml(resolved?'Reviewed':'Submitted')+'</b></div>'
    +'<div><span>Review</span><b>'+escapeHtml(reviewDetail)+'</b></div>'
    +'<div><span>Proof</span><b>'+escapeHtml(proofDetail)+'</b></div>'
    +'</div>'
    +'<div class="fp-stats">'
    +'<div class="fp-stat"><span class="n">'+sup+'</span><span class="l">Reward / support</span></div>'
    +'<div class="fp-stat"><span class="n">'+count+'</span><span class="l">Backers</span></div>'
    +'<div class="fp-stat"><span class="n">'+timeV+'</span><span class="l">Deadline</span></div>'
    +'</div>'
    +'<div class="cf-sec-l">Case summary</div>'
    +'<div class="fp-sum">'+brief+'</div>'
    +'<div class="fp-proof-state '+(hasDirectProof?'linked':'pending')+'"><span>'+proofLabel+'</span><b>'+proofDetail+'</b></div>'
    +'<div class="fp-acts">'+acts+'</div>'
    +'<div class="fp-note">Peer support is voluntary and non-custodial. It never affects review outcomes.</div>';
}
function foPreviewShow(id){
  var host=document.getElementById('fo-preview'); if(!host) return;
  var list=(fieldState&&fieldState.data)?fieldState.data:[]; var b=null;
  for(var i=0;i<list.length;i++){ if(String(list[i].id)===String(id)){ b=list[i]; break; } }
  if(!b) return;
  caseFileData=b;
  host.innerHTML=foPreviewHtml(b);
  document.querySelectorAll('#field-cases .fo-case').forEach(function(r){ r.classList.toggle('selected', String(r.getAttribute('data-bid'))===String(id)); });
}
function foAutoPreview(){
  if(!foWide()) return;
  var sel=document.querySelector('#field-cases .fo-case.selected[data-bid]');
  var first=sel||document.querySelector('#field-cases .fo-case[data-bid]');
  if(first){ foPreviewShow(first.getAttribute('data-bid')); }
  else { var hh=document.getElementById('fo-preview'); if(hh) hh.innerHTML='<div class="fo-prev-empty mono">No open cases right now. Open the first one, it is free.</div>'; }
}
async function cfLoadProof(bid){
  var host=document.getElementById('cf-proof'); if(!host) return;
  if(!caseFileData || String(caseFileData.id)!==String(bid)) return;
  if(!SUPA_ON){ host.innerHTML='<span class="cv-empty mono">Live proof log loads when the backend is connected.</span>'; return; }
  try{
    var evs=await supaGet('onchain_events?select=event_type,item_type,item_id,vote,label,tx_sig,created_at,actor_wallet&item_id=eq.'+encodeURIComponent(String(bid))+'&order=created_at.desc&limit=8');
    if(!caseFileData || String(caseFileData.id)!==String(bid)) return;
    if(!evs || !evs.length){ host.innerHTML='<span class="cv-empty mono">No signed on-chain actions for this case yet. Backing it or filing a report writes the first memo.</span>'; return; }
    host.innerHTML='<div class="ra-feed cf-feed">'+evs.map(raSignedItem).join('')+'</div>';
  }catch(e){ host.innerHTML='<span class="cv-empty mono">Proof log unavailable right now.</span>'; }
}
function openCaseFile(id){
  var list = (fieldState && fieldState.data) ? fieldState.data : [];
  var b = null; for(var i=0;i<list.length;i++){ if(String(list[i].id)===String(id)){ b=list[i]; break; } }
  if(!b) return;
  caseFileData = b;
  var body = document.getElementById('cf-drawer-body'); if(body) body.innerHTML = cfDrawerHtml(b);
  if(typeof cfLoadProof === 'function') cfLoadProof(b.id);
  var dr = document.getElementById('cf-drawer'); if(dr){ dr.classList.add('open'); dr.setAttribute('aria-hidden','false'); }
  document.body.classList.add('cr-drawer-lock');
}
function closeCaseFile(){ var d=document.getElementById('cf-drawer'); if(d){ d.classList.remove('open'); d.setAttribute('aria-hidden','true'); } document.body.classList.remove('cr-drawer-lock'); }
// case lifecycle tracker: Submitted -> Under Review -> Reviewed -> Public Record
function cfLifecycle(idx){
  var steps = ['Submitted','Under Review','Reviewed','Public Record'];
  var track = '';
  for(var i=0;i<steps.length;i++){
    var dcls = i<idx ? 'done' : (i===idx ? 'current' : 'pending');
    track += '<span class="cf-dot '+dcls+'"></span>';
    if(i<steps.length-1) track += '<span class="cf-line '+(i<idx?'done':'pending')+'"></span>';
  }
  var labels = steps.map(function(s,i){ return '<span class="'+(i<idx?'done':(i===idx?'current':''))+'">'+s+'</span>'; }).join('');
  return '<div class="cf-life"><div class="cf-track">'+track+'</div><div class="cf-labels">'+labels+'</div></div>';
}

// ===== Proof Log: global timeline of signed, on-chain-verifiable actions =====
function proofLogDemoSample(){
  if(window.OSI_DEMO_MODE !== true) return [];
  var now = Date.now();
  function t(mins){ return new Date(now - mins*60000).toISOString(); }
  return [
    { event_type:'maintainer_seal', actor_wallet:'7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', item_type:'case', item_id:'OSI-4433', label:'sealed Hyperion DeFi', tx_sig:'5Kd8xQvT2mNpWqR7yZ3aBcDe1fGhJkLmNpQrStUvWxYz4aBcDeFgHjKmNpQrStUvWxYz2mNpWqR7yZ3aBc', created_at:t(9) },
    { event_type:'analyst_vouch', vote:'approve', actor_wallet:'4Nd1mYh8pQ2rStUvWxYz3aBcDeFgHjKmNpQrStUvWxY', item_type:'case', item_id:'OSI-4433', label:'approved case', tx_sig:'3Ab7Kd8xQvT2mNpWqR7yZ3aBcDe1fGhJkLmNpQrStUvWxYz4aBcDeFgHjKmNpQrStUvWxYz2mNpWqR7yaB', created_at:t(31) },
    { event_type:'report_submitted', actor_wallet:'9zAbCdEfGhJkLmNpQrStUvWxYz2345678aBcDeFgHjK', item_type:'report', item_id:'OSI-4433', label:'filed report on OSI-4433', tx_sig:'7Yz4aBcDeFgHjKmNpQrStUvWxYz2mNpWqR7yZ3aBcDe1fGhJkLmNpQrStUvWxYz4aBcDeFgHjKmNpQrSt', created_at:t(66) },
    { event_type:'case_opened', actor_wallet:'3RtY6uJ8kLmN2pQ4sV7wX9zAbCdEfGhJkLmNpQrStUv', item_type:'case', item_id:'OSI-7706', label:'opened case', tx_sig:'9Qr7yZ3aBcDe1fGhJkLmNpQrStUvWxYz4aBcDeFgHjKmNpQrStUvWxYz2mNpWqR7yZ3aBcDe1fGhJkLmNp', created_at:t(95) },
    { event_type:'demand_signal', actor_wallet:'3RtY6uJ8kLmN2pQ4sV7wX9zAbCdEfGhJkLmNpQrStUv', item_type:'case', item_id:'OSI-7706', label:'pledged demand for OSI-7706', tx_sig:'2Wx8yZ3aBcDe1fGhJkLmNpQrStUvWxYz4aBcDeFgHjKmNpQrStUvWxYz2mNpWqR7yZ3aBcDe1fGhJkLmNp', created_at:t(120) },
    { event_type:'analyst_vouch', vote:'challenge', actor_wallet:'5FhGjKlMnBvCxZaSdFgHjKlPoIuYtReWqAsDfGhJkLm', item_type:'report', item_id:'OSI-2185', label:'challenged report', tx_sig:'6Hj4aBcDeFgHjKmNpQrStUvWxYz2mNpWqR7yZ3aBcDe1fGhJkLmNpQrStUvWxYz4aBcDeFgHjKmNpQrSt', created_at:t(175) },
    { event_type:'wire_dispatch', actor_wallet:'2WpQeRtYuIoPaSdFgHjKlZxCvBnMqWeRtYuIoPaSdFg', item_type:'report', item_id:'WIRE-19', label:'filed a dispatch on a suspicious cluster', tx_sig:'8Kl4aBcDeFgHjKmNpQrStUvWxYz2mNpWqR7yZ3aBcDe1fGhJkLmNpQrStUvWxYz4aBcDeFgHjKmNpQrSt', created_at:t(240) },
    { event_type:'report_submitted', actor_wallet:'7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', item_type:'report', item_id:'OSI-5218', label:'filed report on OSI-5218', tx_sig:'4Mn4aBcDeFgHjKmNpQrStUvWxYz2mNpWqR7yZ3aBcDe1fGhJkLmNpQrStUvWxYz4aBcDeFgHjKmNpQrSt', created_at:t(360) }
  ];
}
var plState = { filter:'all', q:'', page:1 };
var PL_PER = 8;
// zengin timeline kartı (Proof Log'a özel; kompakt raSignedItem ayrı kalır)
function plGoCase(id){
  var rec = (window.__crRecords||{})[id];
  if(rec && typeof openCaseRecord==='function'){ showView('records'); setTimeout(function(){ openCaseRecord(id); },120); return; }
  showView('records');
}
function plCopyFallback(text, done){
  try{ var ta=document.createElement('textarea'); ta.value=String(text); ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done(); }
  catch(e){ showToast('Could not copy automatically.'); }
}
function plFilter(f){
  plState.filter=f; plState.page=1;
  document.querySelectorAll('#pl-fils .rf-tab').forEach(function(b){ b.classList.toggle('active', b.dataset.f===f); });
  plPaint();
}
function plSearch(v){ plState.q=(v||'').trim().toLowerCase(); plState.page=1; plPaint(); }
function plSetPage(p){ plState.page=p|0; plPaint(); var b=document.getElementById('pl-body'); if(b){ try{ b.scrollIntoView({behavior:'smooth',block:'start'}); }catch(e){} } }
function plSealedRender(){
  var card=document.getElementById('pl-sealed-card'); var host=document.getElementById('pl-sealed'); if(!card||!host) return;
  var seals=(window.__plEvents||[]).filter(function(e){ return e.event_type==='maintainer_seal'; });
  if(!seals.length){ card.style.display='none'; return; }
  var s=seals[0];
  var cid = s.item_id ? osiCaseId(s.item_id) : 'OSI-000000';
  var name = s.label ? escapeHtml(String(s.label).replace(/^sealed /,'').slice(0,40)) : '';
  card.style.display='';
  host.innerHTML = '<div class="pl-sl-top"><span class="pl-sl-id mono">'+cid+'</span>'+(name?('<span class="pl-sl-nm">'+name+'</span>'):'')+'</div>'
    + '<div class="pl-sl-meta mono">Sealed by '+raShortW(s.actor_wallet)+' \u00b7 '+raTimeAgo(s.created_at)+'</div>'
    + (s.tx_sig ? ('<a class="pl-sl-btn" href="'+solscanTx(s.tx_sig)+'" target="_blank" rel="noopener">View record \u2197</a>') : '');
}
// Proof Log v2: live view uses real onchain_events only. Existing sample rows
// remain available only when window.OSI_DEMO_MODE === true.
function plDemoMode(){ return window.OSI_DEMO_MODE === true; }
function plSourceState(){ return window.__plSourceState || 'idle'; }
function plGroup(ev){
  var t = String((ev && ev.event_type) || '').toLowerCase();
  var itemType = String((ev && ev.item_type) || '').toLowerCase();
  var vote = String((ev && ev.vote) || '').toLowerCase();
  if(t==='analyst_vouch' && (itemType==='challenge' || vote==='challenge')) return 'challenge';
  if(t==='analyst_vouch' || t==='review_signed' || t==='analyst_review') return 'vote';
  if(t==='report_submitted' || t==='wire_dispatch') return 'report';
  if(t==='demand_signal' || t==='support' || t==='support_signal') return 'support';
  if(t==='maintainer_seal' || t==='record_sealed' || t==='public_record_sealed') return 'seal';
  if(t==='case_opened' || t==='case_created' || t==='bounty_opened') return 'case';
  if(t.indexOf('challenge') !== -1) return 'challenge';
  return 'other';
}
function plMemo(ev){
  var map = {
    case:      { tag:'OSI_CASE_OPENED',      title:'Case Opened',      cls:'case' },
    report:    { tag:'OSI_REPORT_SUBMITTED', title:'Report Submitted', cls:'report' },
    vote:      { tag:'OSI_REVIEW_SIGNED',    title:'Analyst Review',   cls:'review' },
    challenge: { tag:'OSI_CHALLENGE_FILED',  title:'Challenge Filed',  cls:'challenge' },
    support:   { tag:'OSI_SUPPORT_SIGNAL',   title:'Support Signal',   cls:'support' },
    seal:      { tag:'OSI_RECORD_SEALED',    title:'Record Sealed',    cls:'seal' },
    other:     { tag:'OSI_SIGNED_ACTION',    title:'Signed Action',    cls:'other' }
  };
  return map[plGroup(ev)] || map.other;
}
function plCleanLabel(ev){
  var label = String((ev && ev.label) || '').trim();
  if(!label) return '';
  return label
    .replace(/^filed a dispatch on /i,'Dispatch: ')
    .replace(/^pledged demand for /i,'Support: ')
    .replace(/^supported /i,'Support: ')
    .replace(/^filed report on /i,'Report: ')
    .replace(/^sealed /i,'Sealed: ');
}
function plSignerRole(ev){
  var g = plGroup(ev);
  if(g==='vote') return 'Analyst';
  if(g==='challenge') return 'Challenger';
  if(g==='seal') return 'Maintainer';
  if(g==='support') return 'Supporter';
  if(g==='report') return 'Reporter';
  if(g==='case') return 'Case opener';
  return 'Signer';
}
function plJsString(s){ return String(s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;').replace(/\r?\n/g,' '); }
function plShortSig(sig){ sig=String(sig||''); return sig ? (sig.slice(0,5)+'...'+sig.slice(-5)) : ''; }
function plFullDate(ts){
  var t = new Date(ts||''); if(isNaN(t.getTime())) return '';
  var d = t.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
  var tm = t.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'UTC'});
  return d+' '+tm+' UTC';
}
function plAgo(ts){ var t = new Date(ts||''); return isNaN(t.getTime()) ? '' : raTimeAgo(ts); }
function plMemoStatus(ev){ return ev && ev.tx_sig ? 'Memo-verifiable' : 'No transaction link'; }
function plReferenceHtml(ev){
  var raw = ev && ev.item_id != null ? String(ev.item_id) : '';
  if(!raw) return 'Reference unavailable';
  var group = plGroup(ev);
  var display = (group==='case' || group==='vote' || group==='challenge' || group==='seal' || group==='support') ? osiCaseId(raw) : raw;
  return '<a onclick="plGoCase(\''+plJsString(raw)+'\')">'+escapeHtml(display)+'</a>';
}
function plCopyProofValue(text, label){
  if(!text) return;
  var done=function(){ showToast((label||'Value')+' copied.'); };
  if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(String(text)).then(done).catch(function(){ plCopyFallback(text,done); }); }
  else plCopyFallback(text,done);
}
function plTimelineCard(ev){
  ev = ev || {};
  var m = plMemo(ev);
  var sig = ev.tx_sig ? String(ev.tx_sig) : '';
  var wallet = ev.actor_wallet ? String(ev.actor_wallet) : '';
  var walletCell = wallet
    ? '<span title="'+escapeHtml(wallet)+'">'+escapeHtml(raShortW(wallet))+'</span><button class="plc-copy" type="button" title="Copy wallet" onclick="plCopyProofValue(\''+plJsString(wallet)+'\',\'Wallet\')">copy</button>'
    : '<span>Wallet unavailable</span>';
  var label = plCleanLabel(ev);
  var when = plFullDate(ev.created_at);
  var ago = plAgo(ev.created_at);
  var txHtml = sig
    ? '<div class="plc-tx-row"><code class="mono" title="'+escapeHtml(sig)+'">Tx '+escapeHtml(plShortSig(sig))+'</code><button class="plc-copy" type="button" title="Copy signature" onclick="plCopyProofValue(\''+plJsString(sig)+'\',\'Transaction signature\')">copy</button><a class="plc-verify" href="'+solscanTx(sig)+'" target="_blank" rel="noopener">View on Solana</a></div>'
    : '<span class="plc-no-tx">No transaction link</span>';
  return '<div class="plc type-'+m.cls+'" data-g="'+plGroup(ev)+'">'
    + '<span class="plc-dot" aria-hidden="true"></span>'
    + '<div class="plc-body">'
      + '<div class="plc-head">'
        + '<div><span class="plc-badge">'+m.tag+'</span></div>'
        + '<div><div class="plc-title">'+m.title+'</div><div class="plc-ref">'+(label?escapeHtml(label):'Signed OSI action')+' - '+plReferenceHtml(ev)+'</div></div>'
        + '<div class="plc-time">'+(ago?escapeHtml(ago):'Timestamp unavailable')+(when?('<br>'+escapeHtml(when)):'')+'</div>'
      + '</div>'
      + '<div class="plc-grid">'
        + '<div><div class="plc-meta-k">Wallet</div><div class="plc-meta-v">'+walletCell+'</div></div>'
        + '<div><div class="plc-meta-k">Wallet role</div><div class="plc-meta-v">'+escapeHtml(plSignerRole(ev))+'</div></div>'
        + '<div><div class="plc-meta-k">Memo status</div><div class="plc-meta-v '+(sig?'ok':'')+'">'+escapeHtml(plMemoStatus(ev))+'</div></div>'
        + '<div class="plc-action"><div class="plc-meta-k">Transaction</div>'+txHtml+'</div>'
      + '</div>'
    + '</div>'
  + '</div>';
}
function plDashRender(){
  var host=document.getElementById('pl-dash'); if(!host) return;
  var evs=window.__plEvents||[];
  var src=plSourceState();
  var canCount = src==='loaded' || src==='empty' || src==='demo';
  function val(n){ return canCount ? String(n) : 'Not available yet'; }
  function stat(cls, ic, label, value, sub){
    var isNa = value === 'Not available yet';
    return '<div class="pl-stat '+cls+'"><div class="pl-stat-top"><span class="pl-stat-ic">'+ic+'</span><span class="pl-stat-label">'+label+'</span></div><div><div class="pl-stat-val '+(isNa?'na':'')+'">'+value+'</div><div class="pl-stat-sub">'+sub+'</div></div></div>';
  }
  var total=evs.length;
  var memos=evs.filter(function(e){ return !!e.tx_sig; }).length;
  var cases=evs.filter(function(e){ return plGroup(e)==='case'; }).length;
  var reviews=evs.filter(function(e){ return plGroup(e)==='vote'; }).length;
  var challenges=evs.filter(function(e){ return plGroup(e)==='challenge'; }).length;
  var seals=evs.filter(function(e){ return plGroup(e)==='seal'; }).length;
  host.innerHTML =
      stat('signed','SIG','Signed Actions',val(total),'Wallet-signed records')
    + stat('memo','MEM','Memo Events',val(memos),'Transaction links indexed')
    + stat('case','CAS','Case Events',val(cases),'Cases opened')
    + stat('review','REV','Review Events',val(reviews),'Analyst review actions')
    + stat('challenge','CHL','Challenge Events',val(challenges),'Challenges filed')
    + stat('seal','SEA','Sealed Records',val(seals),'Public record seals')
    + stat('net','SOL','Network','Solana','Mainnet');
}
function plSchemaRender(){
  var host=document.getElementById('pl-schema'); if(!host) return;
  var rows=[
    ['OSI_CASE_OPENED','cy'],
    ['OSI_REPORT_SUBMITTED','vio'],
    ['OSI_REVIEW_SIGNED','vio'],
    ['OSI_CHALLENGE_FILED','warn'],
    ['OSI_RECORD_SEALED','ok'],
    ['OSI_SUPPORT_SIGNAL','ok']
  ];
  host.innerHTML = rows.map(function(r){ return '<div class="pl-sc"><code class="mono '+r[1]+'">'+r[0]+'</code></div>'; }).join('');
}
function plHealthRender(){
  var host=document.getElementById('pl-health'); if(!host) return;
  var src=plSourceState();
  var evs=window.__plEvents||[];
  var stateCls=''; var title='No signed proof events yet'; var body='Wallet-signed OSI actions will appear here after they are recorded.';
  if(src==='loaded' && evs.length){ stateCls='ok'; title='Live proof source connected'; body=evs.length+' signed proof event'+(evs.length===1?'':'s')+' loaded from the OSI proof index.'; }
  else if(src==='error'){ stateCls='err'; title='Proof source unavailable'; body='Unable to load signed events right now.'; }
  else if(src==='unavailable'){ stateCls='err'; title='Proof source unavailable'; body='The signed proof source is not connected in this environment.'; }
  else if(src==='demo'){ title='Demo mode enabled'; body='Sample proof events are visible because OSI_DEMO_MODE is enabled.'; }
  var lastMemo = evs.length ? (plAgo(evs[0].created_at)||'Timestamp unavailable') : 'Not available yet';
  host.innerHTML =
    '<div class="pl-health-state '+stateCls+'"><span class="pl-health-dot"></span><div><b>'+title+'</b><span>'+body+'</span></div></div>'
    + '<div class="pl-hl"><span class="pl-hl-k">Last indexed event</span><span class="pl-hl-v">'+escapeHtml(lastMemo)+'</span></div>'
    + '<div class="pl-hl"><span class="pl-hl-k">Network</span><span class="pl-hl-v"><span class="pl-net"><span class="pl-net-dot"></span>Solana Mainnet</span></span></div>';
}
function plPaint(){
  var host=document.getElementById('pl-body'); if(!host) return;
  plDashRender(); plSchemaRender(); plHealthRender(); plSealedRender();
  var all=(window.__plEvents||[]).slice();
  var src=plSourceState();
  var q=plState.q;
  var evs=all;
  if(q){
    evs=evs.filter(function(e){
      var hay=[e.actor_wallet,e.item_id,e.event_type,e.label,e.vote,e.tx_sig, e.item_id?osiCaseId(e.item_id):''].map(function(x){ return String(x||'').toLowerCase(); }).join(' ');
      return hay.indexOf(q)!==-1;
    });
  }
  if(plState.filter!=='all') evs=evs.filter(function(e){ return plGroup(e)===plState.filter; });
  var stripCls = (src==='loaded' && all.length) ? ' ok' : ((src==='error'||src==='unavailable') ? ' err' : '');
  var stripTitle = (src==='loaded' && all.length) ? 'Live proof source connected' : (src==='error'||src==='unavailable' ? 'Proof source unavailable' : (src==='demo' ? 'Demo mode enabled' : 'No signed proof events yet'));
  var stripBody = (src==='loaded' && all.length) ? (all.length+' real signed proof event'+(all.length===1?'':'s')+' loaded from onchain_events.')
    : (src==='error' ? 'Unable to load signed events right now.'
    : (src==='unavailable' ? 'Signed proof source is not connected in this environment.'
    : (src==='demo' ? 'Sample rows are visible only because OSI_DEMO_MODE is enabled.' : 'Wallet-signed OSI actions will appear here after they are recorded.')));
  var strip = '<div class="pl-strip'+stripCls+'"><span class="pl-strip-dot"></span><div class="pl-strip-t"><b>'+stripTitle+'</b><span>'+stripBody+'</span></div></div>';
  var totalPages=Math.max(1, Math.ceil(evs.length/PL_PER));
  if(plState.page>totalPages) plState.page=totalPages; if(plState.page<1) plState.page=1;
  var from=(plState.page-1)*PL_PER, page=evs.slice(from, from+PL_PER);
  var emptyTitle = (src==='error'||src==='unavailable') ? 'Proof source unavailable.' : (all.length ? 'No matching proof events found.' : 'No signed proof events found yet.');
  var emptyBody = (src==='error') ? 'Unable to load signed events right now.'
    : (src==='unavailable' ? 'The signed proof source is not connected in this environment.'
    : (all.length ? 'Try another filter or search term.' : 'Wallet-signed OSI actions will appear here after they are recorded.'));
  host.innerHTML = strip + (page.length
    ? '<div class="pl-timeline">' + page.map(plTimelineCard).join('') + '</div>'
    : '<div class="pl-empty"><h3>'+emptyTitle+'</h3><p>'+emptyBody+'</p></div>');
  var cnt=document.getElementById('pl-count');
  if(cnt) cnt.textContent = evs.length ? ('Showing '+(from+1)+'-'+(from+page.length)+' of '+evs.length+' action'+(evs.length===1?'':'s')) : '';
  var pn=document.getElementById('pl-pnav');
  if(pn){
    if(totalPages<=1){ pn.innerHTML=''; }
    else{
      var ph='<button class="fo-pg" type="button" '+(plState.page<=1?'disabled':'')+' onclick="plSetPage('+(plState.page-1)+')">Prev</button>';
      for(var pi=1;pi<=totalPages;pi++){ ph+='<button class="fo-pg n'+(pi===plState.page?' active':'')+'" type="button" onclick="plSetPage('+pi+')">'+pi+'</button>'; }
      ph+='<button class="fo-pg" type="button" '+(plState.page>=totalPages?'disabled':'')+' onclick="plSetPage('+(plState.page+1)+')">Next</button>';
      pn.innerHTML=ph;
    }
  }
}
async function renderProofLog(){
  var host = document.getElementById('pl-body'); if(!host) return;
  host.innerHTML = '<div class="pl-note">Loading signed proof events...</div>';
  var events = [];
  var source = 'unavailable';
  if(typeof SUPA_ON!=='undefined' && SUPA_ON){
    try{
      events = await supaGet('onchain_events?select=event_type,actor_wallet,item_type,item_id,vote,amount,token,label,tx_sig,created_at&order=created_at.desc&limit=100') || [];
      source = events.length ? 'loaded' : 'empty';
    }catch(e){ events=[]; source='error'; }
  }
  window.__plDemo = false;
  if(!events.length && source!=='error' && plDemoMode()){ window.__plDemo = true; events = proofLogDemoSample(); source='demo'; }
  window.__plEvents = events;
  window.__plSourceState = source;
  plState.filter='all'; plState.q=''; plState.page=1;
  var s=document.getElementById('pl-search'); if(s) s.value='';
  document.querySelectorAll('#pl-fils .rf-tab').forEach(function(b){ b.classList.toggle('active', b.dataset.f==='all'); });
  plPaint();
}
function cfDrawerHtml(b){
  var target = escapeHtml(b.target || b.title || 'case');
  var brief = escapeHtml(b.detail || 'Community intelligence request.');
  var reward = parseFloat(b.reward_sol) || 0;
  var resolved = !!b.winner_wallet;
  var count = ((window.boostCounts||{})[b.id]) || 0;
  var hot = !resolved && count >= 5;
  var status = resolved ? 'closed' : (hot ? 'hot' : 'open');
  var statusLabel = resolved ? 'REVIEWED' : 'SUBMITTED';
  var osi = 'OSI-' + ((pfHash(String(b.id)) % 9000) + 1000);
  var deadline = resolved ? 0 : bountyDeadline(b);
  var _left = deadline - Date.now();
  var timeVal = resolved ? '-' : (deadline && _left>0 ? fmtCountdown(_left) : 'No deadline');
  var filed = b.created_at ? new Date(b.created_at).toLocaleDateString() : '';
  var supVal = reward>0 ? (SOL_MARK+' '+reward+' SOL') : 'Community';
  var applied = !!lsGet('stw_applied',{})[b.id];
  var backed = !!lsGet('stw_boosted',{})[b.id];
  var actions;
  if(resolved){
    var wl = escapeHtml(b.winner_label || short(b.winner_wallet));
    actions = '<div class="cf-won">\uD83C\uDFC6 won by '+wl+'</div>'
      + '<button class="cf-btn primary" type="button" onclick="caseFileReward()">\u25ce Support the winner</button>';
  } else {
    actions = '<button class="cf-btn primary" type="button" onclick="caseFileApply()">\u2726 Submit a report</button>'
      + '<button class="cf-btn ghost'+(backed?' on':'')+'" type="button" onclick="caseFileBack()">\u2191 '+(backed?'Backed':'Support this case')+'</button>';
  }
  var foot = (filed ? 'Filed '+filed : '') + (backed ? (filed?' \u00b7 ':'')+'you backed this' : '') + (applied ? ((filed||backed)?' \u00b7 ':'')+'you submitted a report' : '');
  return ''
    + '<div class="cf-head"><div class="cf-osi mono">'+osi+'</div><span class="cf-st '+status+'">'+statusLabel+'</span></div>'
    + '<h3 class="cf-title">'+target+'</h3>'
    + cfLifecycle(resolved?2:0)
    + (!resolved ? '<div class="cf-stage-note">Open case, accepting analyst reports. This is not a reviewed public record yet.</div>' : '')
    + '<div class="cf-statrow">'
      + '<div class="cf-stat"><div class="cf-stat-n">'+supVal+'</div><div class="cf-stat-l">Peer support</div></div>'
      + '<div class="cf-stat"><div class="cf-stat-n">'+count+'</div><div class="cf-stat-l">Backing</div></div>'
      + '<div class="cf-stat"><div class="cf-stat-n">'+timeVal+'</div><div class="cf-stat-l">Time left</div></div>'
    + '</div>'
    + '<div class="cf-sec-l">Brief</div><p class="cf-desc">'+brief+'</p>'
    + (foot ? '<div class="cf-foot mono">'+foot+'</div>' : '')
    + '<div class="cf-actions">'+actions+'</div>'
    + '<div class="cf-sec-l">On-chain proof</div><div id="cf-proof" class="cf-proof"><span class="cv-empty mono">Checking signed actions\u2026</span></div>'
    + '<div class="cf-sec-l">Escalation packs</div><div class="cf-packs">AI briefs for the victim, the exchange desk, and law enforcement are prepared after a case is reviewed and published. <a class="cv-a" onclick="closeCaseFile();showView(\'records\')">See reviewed packs \u2192</a></div>'
    + '<div class="cf-note">OSI traces and documents. It cannot recover funds and never promises to. Evidence is public and on-chain: no seed phrases, no private data, no accusations.</div>';
}
// open the apply (report) flow for the case in the drawer, reusing the shared submit path
function caseFileApply(){
  var b = caseFileData; if(!b) return;
  applyCtx = { bid: b.id, target: (b.target||b.title||'case') };
  var nm = document.getElementById('apply-bounty-name'); if(nm) nm.textContent = '\uD83C\uDFAF ' + applyCtx.target;
  var rep = document.getElementById('apply-report'); if(rep) rep.value = '';
  if(typeof clearPickedFile==='function') clearPickedFile('apply');
  if(typeof refreshApplyWalletRow==='function') refreshApplyWalletRow();
  var m = document.getElementById('apply-modal'); if(m) m.classList.add('open');
}
// support the case in the drawer, same signed memo + backend path as the board boost
function caseFileBack(){
  var b = caseFileData; if(!b) return;
  if(lsGet('stw_boosted',{})[b.id]){ if(typeof showToast==='function') showToast('You already backed this case.'); return; }
  var bid = b.id, _bts = Math.floor(Date.now()/1000);
  var subj = String(b.target||b.title||'case').replace(/\|/g,'/');
  var memo = "OSI_CASE_BACKED|case_id=" + (bid||"") + "|subject=" + subj + "|backer=" + (walletPubkey||"") + "|ts=" + _bts;
  withOnchainVote("Support", memo, async function(sig){
    if(bid){ var mine = lsGet('stw_boosted', {}); mine[bid] = { name: (b.target||b.title), tx: sig, ts: Date.now() }; lsSet('stw_boosted', mine); }
    if(typeof recordOnchainEvent==='function') recordOnchainEvent({ event_type:'demand_signal', item_type:'bounty', item_id:bid, label:'pledged demand for '+(b.target||b.title), memo_text:memo, tx_sig:sig });
    if(SUPA_ON && bid){ try{ await supaPost('bounty_boosts', { bounty_id: bid, voter: voterId() }); if(typeof hydrateBoosts==='function') hydrateBoosts(); }catch(e){} }
    if(typeof showToast==='function') showToast('Support recorded on-chain.');
    try{ if(typeof drawFieldOffice==='function') drawFieldOffice(); }catch(e){}
    if(caseFileData && String(caseFileData.id)===String(bid)){ var body=document.getElementById('cf-drawer-body'); if(body) body.innerHTML=cfDrawerHtml(caseFileData); if(typeof cfLoadProof==='function') cfLoadProof(bid); }
  });
}
function caseFileReward(){
  // winner_wallet is set by the maintainer via the signed "Set winner" action
  // (admResolveBounty), so it is an explicitly attested recipient \u2014 never a
  // reported/target wallet. Support is voluntary and non-custodial.
  var b = caseFileData; if(!b || !isSolAddr(b.winner_wallet)) return;
  var reward = parseFloat(b.reward_sol)||0; var payAmt = reward>0?reward:0.1;
  if(typeof openTip==='function') openTip(b.winner_wallet, 'designated bounty winner', payAmt, '\u25ce Support the bounty winner', {kind:'winner', item_type:'bounty', item_id:b.id});
}
function fieldStats(list){
  const host=document.getElementById('field-stats'); if(!host) return;
  const open = list.filter(function(b){ return !b.winner_wallet; }).length;
  const closed = list.filter(function(b){ return !!b.winner_wallet; }).length;
  const pooled = list.reduce(function(s,b){ return s + (parseFloat(b.reward_sol)||0); }, 0);
  host.innerHTML =
      '<div class="fo-op"><div class="fo-op-ic">CASE</div><div class="fo-op-n">'+open+'</div><div class="fo-op-l">Open cases</div><span class="fo-op-sub">Active investigations</span></div>'
    + '<div class="fo-op"><div class="fo-op-ic sol">SOL</div><div class="fo-op-n sol">'+SOL_MARK+' '+pooled+'</div><div class="fo-op-l">Peer support</div><span class="fo-op-sub">Total backing</span></div>'
    + '<div class="fo-op"><div class="fo-op-ic ok">DONE</div><div class="fo-op-n">'+closed+'</div><div class="fo-op-l">Cases resolved</div><span class="fo-op-sub">All time</span></div>';
}
function fieldUpdateDemand(){
  document.querySelectorAll('.fo-demand-bar[data-bid]').forEach(function(bar){
    const c = ((window.boostCounts||{})[bar.dataset.bid]) || 0;
    bar.style.width = Math.min(100, c*12) + '%';
  });
}
function fieldFilter(f){ fieldState.filter=f; fieldState.page=1; document.querySelectorAll('.fo-fil').forEach(function(b){ b.classList.toggle('active', b.dataset.f===f); }); drawFieldOffice(); }
function fieldSort(s){ fieldState.sort=s; fieldState.page=1; document.querySelectorAll('.fo-sort').forEach(function(b){ b.classList.toggle('active', b.dataset.s===s); }); drawFieldOffice(); }
// ---- My Cases: cases opened from this wallet or drafted on this device ----
function foMyIds(){ var ids={}; (lsGet('stw_bounties',[])||[]).forEach(function(x){ if(x&&x.id) ids[String(x.id)]=1; }); return ids; }
function foIsMine(b){
  if(!b) return false;
  if(typeof walletPubkey!=='undefined' && walletPubkey && b.created_by && String(b.created_by)===String(walletPubkey)) return true;
  return !!foMyIds()[String(b.id)];
}
function fieldMine(on){
  fieldState.mine = !!on;
  fieldState.page = 1;
  var my=document.getElementById('fr-mycases'), fo=document.getElementById('fr-fieldoffice');
  if(my) my.classList.toggle('active', fieldState.mine);
  if(fo) fo.classList.toggle('active', !fieldState.mine);
  var t=document.getElementById('fo-title'), s=document.getElementById('fo-sub'), e=document.getElementById('fo-eyebrow');
  if(t) t.textContent = fieldState.mine ? 'My Cases' : 'The Field Office';
  if(s) s.textContent = fieldState.mine
    ? 'Every case opened from your wallet or drafted on this device. Track their stage, back them, or open the full file.'
    : 'Open cases, trace fund flows, and publish reviewed Solana incident records.';
  if(e) e.textContent = fieldState.mine ? 'Your docket' : 'Command Center';
  drawFieldOffice();
  try{ window.scrollTo({top:0,behavior:'smooth'}); }catch(err){ try{ window.scrollTo(0,0); }catch(e2){} }
}
// ---- Verify on Solana: always resolves to Solscan (the case's own signed trail) ----
function fieldPage(p){ fieldState.page = p|0; drawFieldOffice(); var q=document.getElementById('field-cases'); if(q){ try{ q.scrollIntoView({behavior:'smooth',block:'start'}); }catch(e){} } }
function foVerify(){
  var b=caseFileData; if(!b) return;
  var sig=b.tx||b.tx_sig||'';
  if(sig){ try{ window.open('https://solscan.io/tx/'+encodeURIComponent(String(sig)),'_blank','noopener'); }catch(e){} return; }
  if(!SUPA_ON){ showToast('No signed on-chain actions recorded for this case yet. Backing it writes the first memo.'); return; }
  var win=null; try{ win=window.open('about:blank','_blank'); }catch(e){}
  supaGet('onchain_events?select=tx_sig&item_id=eq.'+encodeURIComponent(String(b.id))+'&order=created_at.asc&limit=1')
    .then(function(evs){
      var s2=evs && evs[0] && evs[0].tx_sig;
      if(s2){
        var u='https://solscan.io/tx/'+encodeURIComponent(String(s2));
        if(win){ try{ win.location=u; }catch(e){ try{ win.close(); }catch(e2){} try{ window.open(u,'_blank','noopener'); }catch(e3){} } }
        else { try{ window.open(u,'_blank','noopener'); }catch(e){} }
      } else {
        if(win){ try{ win.close(); }catch(e){} }
        showToast('No signed on-chain actions for this case yet. Backing it writes the first memo.');
      }
    })
    .catch(function(){ if(win){ try{ win.close(); }catch(e){} } showToast('Could not reach the proof log right now.'); });
}
// ===== Console rail: shared left navigation, mounted into the intelligence views =====
var OSI_RAIL_VIEWS=['wire','records','analysts','prooflog','methodology'];
function osiRailHtml(active){
  function it(key,ic,label,on){ return '<button class="fr-i'+(active===key?' active':'')+'" type="button" onclick="'+on+'"><span class="fr-ic">'+ic+'</span>'+label+'</button>'; }
  return '<div class="fr-g mono">Field Office</div>'
    + it('field','\u25a3','Cases',"showView('field');fieldMine(false)")
    + it('mycases','\u25c8','My Cases',"showView('field');fieldMine(true)")
    + it('open','\uff0b','Open Case',"fieldOpenForm()")
    + it('wire','\u224b','The Wire',"showView('wire')")
    + '<div class="fr-g mono">Intelligence</div>'
    + it('records','\u25a4','Public Records',"showView('records')")
    + it('analysts','\u25ce','Analysts',"showView('analysts')")
    + it('prooflog','\u26d3','Proof Log',"showView('prooflog')")
    + it('methodology','\u00a7','Methodology',"showView('methodology')")
    + '<div class="fr-net"><div class="fr-net-h mono">Network <span class="fr-dot"></span></div><div class="fr-net-v mono">Solana Mainnet</div><div class="fr-net-s mono">non-custodial \u00b7 memo-verified</div><a class="fr-net-b" href="https://status.solana.com" target="_blank" rel="noopener">View network status \u2197</a></div>';
}
function osiRailMount(){
  OSI_RAIL_VIEWS.forEach(function(v){
    if(document.querySelector('.rail-shell[data-shell="'+v+'"]')) return;
    var secs=Array.prototype.slice.call(document.querySelectorAll('section[data-view="'+v+'"]'));
    if(!secs.length) return;
    var shell=document.createElement('div'); shell.className='rail-shell'; shell.setAttribute('data-shell',v);
    var rail=document.createElement('aside'); rail.className='fo-rail'; rail.setAttribute('aria-label','Console navigation');
    rail.innerHTML=osiRailHtml(v);
    var main=document.createElement('div'); main.className='rail-main';
    secs[0].parentNode.insertBefore(shell, secs[0]);
    secs.forEach(function(sc){ main.appendChild(sc); });
    shell.appendChild(rail); shell.appendChild(main);
  });
}
if(document.readyState!=='loading'){ try{ osiRailMount(); }catch(e){} } else { document.addEventListener('DOMContentLoaded', function(){ try{ osiRailMount(); }catch(e){} }); }
// ===== Operations deck: latest activity, recent proof log, analyst desk (real data only) =====
function fdAgo(ts){ var t=new Date(ts||0).getTime(); if(!t||isNaN(t)) return ''; var m=Math.floor((Date.now()-t)/60000); if(m<1) return 'just now'; if(m<60) return m+'m ago'; var h=Math.floor(m/60); if(h<24) return h+'h ago'; return Math.floor(h/24)+'d ago'; }
function foDeckActivity(){
  var host=document.getElementById('fd-activity'); if(!host) return;
  var rows=(fieldState.data||[]).slice().sort(function(a,b){ return new Date(b.created_at||0)-new Date(a.created_at||0); }).slice(0,3);
  if(!rows.length){ host.innerHTML='<div class="fd-empty mono">No case activity yet. Open the first case, it is free.</div>'; return; }
  host.innerHTML=rows.map(function(b){
    var osi='OSI-'+((pfHash(String(b.id))%9000)+1000);
    var t=escapeHtml(b.target||b.title||'case');
    return '<div class="fd-it" role="button" tabindex="0" onclick="fieldRowClick(\''+escapeHtml(String(b.id))+'\')"><span class="fd-ic">\u25a3</span><div class="fd-tx"><b>Case '+osi+' opened</b><span>'+t+'</span></div><span class="fd-ago mono">'+fdAgo(b.created_at)+'</span></div>';
  }).join('');
}
async function foDeckProof(){
  var host=document.getElementById('fd-proof'); if(!host) return;
  if(!SUPA_ON){ host.innerHTML='<div class="fd-empty mono">Signed on-chain actions appear here when the backend is connected.</div>'; return; }
  try{
    var evs=await supaGet('onchain_events?select=event_type,tx_sig,created_at,actor_wallet&order=created_at.desc&limit=3');
    if(!evs || !evs.length){ host.innerHTML='<div class="fd-empty mono">No signed on-chain actions yet. Backing a case writes the first memo.</div>'; return; }
    host.innerHTML=evs.map(function(ev){
      var sig=String(ev.tx_sig||'');
      var right=sig ? ('<a class="fd-ago mono" href="https://solscan.io/tx/'+encodeURIComponent(sig)+'" target="_blank" rel="noopener">'+escapeHtml(sig.slice(0,4)+'\u2026'+sig.slice(-4))+' \u2197</a>')
                    : ('<span class="fd-ago mono">'+fdAgo(ev.created_at)+'</span>');
      return '<div class="fd-it"><span class="fd-ic sol">\u26d3</span><div class="fd-tx"><b>'+escapeHtml(String(ev.event_type||'SIGNED_ACTION'))+'</b><span>by '+raShortW(ev.actor_wallet)+' \u00b7 '+fdAgo(ev.created_at)+'</span></div>'+right+'</div>';
    }).join('');
  }catch(e){ host.innerHTML='<div class="fd-empty mono">Proof log unavailable right now.</div>'; }
}
async function foDeckAnalysts(){
  var host=document.getElementById('fd-analysts'); if(!host) return;
  if(!SUPA_ON){ host.innerHTML='<div class="fd-empty mono">The verified analyst roster loads when the backend is connected.</div>'; return; }
  try{
    if(!window.VERIFIED_ANALYSTS) await loadAnalysts();
    var m=window.VERIFIED_ANALYSTS||{}; var ws=Object.keys(m);
    if(!ws.length){ host.innerHTML='<div class="fd-empty mono">No verified analysts on the roster yet. Be the first to join.</div>'; return; }
    host.innerHTML=ws.slice(0,3).map(function(w){
      var a=m[w]||{}; var nm=escapeHtml(a.handle||a.name||raShortW(w));
      return '<div class="fd-it"><span class="fd-ic vio">\u25ce</span><div class="fd-tx"><b>'+nm+'</b><span class="mono">'+raShortW(w)+'</span></div><span class="fd-ago mono">\u2605 verified</span></div>';
    }).join('') + '<div class="fd-count mono">'+ws.length+' verified analyst'+(ws.length===1?'':'s')+' on the roster</div>';
  }catch(e){ host.innerHTML='<div class="fd-empty mono">Roster unavailable right now.</div>'; }
}
function foDeckRender(){ try{ foDeckActivity(); }catch(e){} try{ foDeckProof(); }catch(e){} try{ foDeckAnalysts(); }catch(e){} }

function fieldOpenForm(){ var m=document.getElementById('fo-modal'); if(!m) return; m.classList.add('open'); document.body.style.overflow='hidden'; var t=document.getElementById('bf-target'); if(t) setTimeout(function(){ try{t.focus();}catch(e){} },60); }
function fieldCloseForm(){ var m=document.getElementById('fo-modal'); if(m) m.classList.remove('open'); document.body.style.overflow=''; }
document.addEventListener('keydown', function(e){ if(e.key==='Escape'){ var m=document.getElementById('fo-modal'); if(m && m.classList.contains('open')) fieldCloseForm(); var x=document.getElementById('apx-modal'); if(x && x.classList.contains('open')) apxClose(); var c=document.getElementById('chx-modal'); if(c && c.classList.contains('open')) chxClose(); var rv=document.getElementById('rv-drawer'); if(rv && rv.classList.contains('open')) rvClose(); } });

// RPC endpoints. Helius plus public RPCs, used via RPC_FALLBACKS below.
// NOTE: this key is visible in the page source, that's unavoidable for a static
// site. Protect it by locking allowed domains in your Helius dashboard.
const HELIUS_RPC = "https://mainnet.helius-rpc.com/?api-key=6cb1f3a8-f0cc-404b-a403-37afd1f3f427";
// Multiple CORS-friendly public RPCs so one flaky endpoint never blocks signing.
// Phantom itself broadcasts the transaction; these are only used to fetch a recent blockhash.
const RPC_FALLBACKS = [
  "https://solana-rpc.publicnode.com",
  HELIUS_RPC,
  "https://api.mainnet-beta.solana.com",
  "https://solana.drpc.org",
  "https://endpoints.omniatech.io/v1/sol/mainnet/public"
];
async function fetchRecentBlockhash(){
  if(!window.solanaWeb3 || !solanaWeb3.Connection) return null;
  const C = solanaWeb3.Connection;
  for(var pass=0; pass<2; pass++){
    for(var k=0; k<RPC_FALLBACKS.length; k++){
      try{
        var conn = new C(RPC_FALLBACKS[k], "confirmed");
        var r = await Promise.race([
          conn.getLatestBlockhash("confirmed"),
          new Promise(function(_,rej){ setTimeout(function(){ rej(new Error("rpc-timeout")); }, 7000); })
        ]);
        if(r && r.blockhash) return r.blockhash;
      }catch(e){ /* try the next endpoint */ }
    }
  }
  return null;
}

// getBalance with automatic fallback: try Helius first, then the public RPC.
const fmt = n => n>=1e6 ? (n/1e6).toFixed(2)+"M" : n>=1e3 ? (n/1e3).toFixed(1)+"K" : n.toLocaleString();
const fmtFull = n => Math.round(n).toLocaleString();
const short = a => a.slice(0,4)+"…"+a.slice(-4);

let SOL_PRICE = 0;




// fetch live balances for a card's wallets via Solana RPC

// live SOL price for the USD stat
async function loadPrice(){
  try{
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana,bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true');
    const j = await r.json();
    SOL_PRICE = j.solana.usd;
    const sp=document.getElementById('s-price'); if(sp) sp.textContent = `at $${SOL_PRICE.toLocaleString()} / SOL`;
    if(window.__declared){ const su=document.getElementById('s-usd'); if(su) su.textContent = '$'+fmt(window.__declared*SOL_PRICE); }
    setTk('sol', j.solana.usd, j.solana.usd_24h_change);
    if(j.bitcoin)  setTk('btc', j.bitcoin.usd,  j.bitcoin.usd_24h_change);
    if(j.ethereum) setTk('eth', j.ethereum.usd, j.ethereum.usd_24h_change);
  }catch(e){
    const su=document.getElementById('s-usd'); if(su) su.textContent='-';
    const sp=document.getElementById('s-price'); if(sp) sp.textContent='price unavailable';
  }
}

// ===== WSJ-style ticker (all tabs): live SOL/BTC/ETH + declared treasury holdings =====
// Treasury figures are self-declared public holdings (snapshot, late 2025/early 2026
// from Yahoo Finance, Helius, CoinGecko). Edit freely as companies update disclosures.
const SOL_TREASURIES = [];
function tickerUnit(){
  let s='';
  s+='<span class="tk"><span class="tk-sym">SOL</span><span class="tk-val tk-sol-val">\u2026</span><span class="tk-chg tk-sol-chg"></span></span>';
  s+='<span class="tk"><span class="tk-sym">BTC</span><span class="tk-val tk-btc-val">\u2026</span><span class="tk-chg tk-btc-chg"></span></span>';
  s+='<span class="tk"><span class="tk-sym">ETH</span><span class="tk-val tk-eth-val">\u2026</span><span class="tk-chg tk-eth-chg"></span></span>';
  SOL_TREASURIES.forEach(function(x){
    s+='<span class="tk tk-tre"><span class="tk-dot"></span><span class="tk-sym">'+x.t+'</span><span class="tk-sol">'+fmtFull(x.sol)+' SOL declared</span></span>';
  });
  return s;
}
function renderTicker(){
  const tr=document.getElementById('wsj-track'); if(!tr) return;
  tr.innerHTML = tickerUnit()+tickerUnit(); // two copies => seamless loop
}
function setTk(cls, price, chg){
  if(price==null) return;
  const txt='$'+Number(price).toLocaleString(undefined,{maximumFractionDigits: price<10?2:0});
  document.querySelectorAll('.tk-'+cls+'-val').forEach(function(el){ el.textContent=txt; });
  document.querySelectorAll('.tk-'+cls+'-chg').forEach(function(el){
    if(chg==null || isNaN(chg)){ el.textContent=''; return; }
    const up=chg>=0;
    el.textContent=(up?'\u25b2':'\u25bc')+Math.abs(chg).toFixed(1)+'%';
    el.className='tk-chg tk-'+cls+'-chg '+(up?'tk-up':'tk-down');
  });
}

// ===== Recent activity feed (homepage right rail) =====
function raTimeAgo(ts){
  if(!ts) return '';
  const diff=Date.now()-new Date(ts).getTime(); const m=Math.floor(diff/60000);
  if(m<1) return 'just now'; if(m<60) return m+'m ago';
  const h=Math.floor(m/60); if(h<24) return h+'h ago';
  const d=Math.floor(h/24); if(d<30) return d+'d ago';
  try{ return new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric'}); }catch(e){ return ''; }
}
function raItem(kind, title, sub, ts){
  const ic = kind==='rep' ? '<span class="ra-ic rep">\u25a4</span>'
           : kind==='bnt' ? '<span class="ra-ic bnt">\u25ce</span>'
           : kind==='req' ? '<span class="ra-ic req">\u2316</span>'
           :                '<span class="ra-ic cas">\u2605</span>';
  return '<div class="ra-item">'+ic+'<div class="ra-tx"><div class="ra-t">'+escapeHtml(sub)+' <b>'+escapeHtml(title)+'</b></div><div class="ra-m">'+raTimeAgo(ts)+'</div></div></div>';
}
function raCaseSeed(label){
  return (window.CASE_STUDIES||[]).map(function(c){ return raItem('cas', c.company+' ('+c.ticker+')', label, null); }).join('');
}
async function renderActivity(){
  const host=document.getElementById('activity-feed'); if(!host) return;
  const seed=raCaseSeed('Case file published:');
  host.innerHTML='<div class="ra-feed">'+(seed||'<div class="ra-empty">Activity will appear here as reports, bounties, and requests get published.</div>')+'</div>';
  if(!SUPA_ON) return;
  try{
    let signed='';
    try{ const ev=await supaGet('onchain_events?select=event_type,actor_wallet,item_type,item_id,vote,amount,token,label,tx_sig,created_at&order=created_at.desc&limit=10'); signed=(ev||[]).map(raSignedItem).join(''); }catch(_e){ /* table may not exist yet */ }
    const reps=await supaGet('reports?select=company,bounty,created_at&approved=eq.true&order=created_at.desc&limit=8');
    const bnts=await supaGet('bounties?select=target,title,created_at&approved=eq.true&order=created_at.desc&limit=8');
    const reqs=await supaGet('requests?select=name,created_at&approved=eq.true&order=created_at.desc&limit=8');
    const items=[];
    (reps||[]).forEach(function(r){ items.push({kind:'rep', title:r.company||r.bounty||'attribution report', sub:'New report:', ts:r.created_at}); });
    (bnts||[]).forEach(function(b){ items.push({kind:'bnt', title:b.target||b.title||'case', sub:'Case opened:', ts:b.created_at}); });
    (reqs||[]).forEach(function(q){ items.push({kind:'req', title:q.name||'wallet request', sub:'New request:', ts:q.created_at}); });
    var _cut=Date.now()-60*86400000;
    var _recent=items.filter(function(it){ var t=new Date(it.ts||0).getTime(); return t>0 && t>=_cut; });
    _recent.sort(function(a,b){ return new Date(b.ts||0)-new Date(a.ts||0); });
    const live=_recent.slice(0,12).map(function(it){ return raItem(it.kind, it.title, it.sub, it.ts); }).join('');
    host.innerHTML='<div class="ra-feed">'+signed+live+raCaseSeed('Case file:')+'</div>';
  }catch(e){ /* keep the seed view on failure */ }
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
const REQUESTS = [];
function lsGet(k, def){ try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; }catch(e){ return def; } }
function lsSet(k, val){ try{ localStorage.setItem(k, JSON.stringify(val)); }catch(e){} }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function safeUrl(u){ u = String(u || '').trim(); return /^https?:\/\//i.test(u) ? u : ''; }

// a stable per-browser id so one browser counts as one vote
function voterId(){ let v = lsGet('stw_voter', null); if(!v){ v = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36); lsSet('stw_voter', v); } return v; }
// Client-side spam speed-bump. A real rate limit needs a backend; this only stops casual rapid-fire from one browser.
function rateOk(key, ms){ try{ const now=Date.now(); const last=parseInt(localStorage.getItem('stw_rl_'+key)||'0',10)||0; if(now-last < ms) return false; localStorage.setItem('stw_rl_'+key, String(now)); return true; }catch(e){ return true; } }

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
function maintainerShortWallet(addr){
  addr = String(addr || '');
  return addr.length > 10 ? addr.slice(0,4) + '...' + addr.slice(-4) : addr;
}
function resolveMaintainerAccess(){
  var wallet = walletPubkey || null;
  var walletConnected = !!wallet;
  var adminWallet = (typeof OSI_ADMIN_WALLET !== 'undefined' && OSI_ADMIN_WALLET) ? String(OSI_ADMIN_WALLET).trim() : '';
  var isMaintainerWallet = !!(walletConnected && adminWallet && String(wallet) === adminWallet);
  var passwordAuthenticated = !!(typeof SUPA_AUTH_TOKEN !== 'undefined' && SUPA_AUTH_TOKEN);
  var state = 'no_wallet';
  if(walletConnected && !isMaintainerWallet) state = 'wrong_wallet';
  else if(isMaintainerWallet && !passwordAuthenticated) state = 'login_required';
  else if(isMaintainerWallet && passwordAuthenticated) state = 'allowed';
  return {
    walletConnected: walletConnected,
    wallet: wallet,
    isMaintainerWallet: isMaintainerWallet,
    passwordAuthenticated: passwordAuthenticated,
    allowed: state === 'allowed',
    state: state
  };
}
function maintainerAccessMessage(ctx, actionName){
  ctx = ctx || (typeof resolveMaintainerAccess === 'function' ? resolveMaintainerAccess() : {});
  var prefix = actionName ? (String(actionName) + ': ') : '';
  if(ctx.state === 'no_wallet') return prefix + 'Connect maintainer wallet.';
  if(ctx.state === 'wrong_wallet') return prefix + 'Maintainer wallet required.';
  if(ctx.state === 'login_required') return prefix + 'Authority login required.';
  return prefix + 'Maintainer access required.';
}
function admLockedHtml(ctx){
  var title = ctx.state === 'wrong_wallet' ? 'Access denied' : 'Maintainer Access Required';
  var body = ctx.state === 'no_wallet'
    ? 'Connect the configured maintainer wallet before opening the authority login.'
    : 'This wallet is not authorized for maintainer operations.';
  var note = ctx.wallet ? '<div class="adm-lock-note">Connected wallet<br><b>' + admEsc(maintainerShortWallet(ctx.wallet)) + '</b></div>' : '';
  var action = ctx.state === 'no_wallet'
    ? '<button class="adm-go" type="button" onclick="toggleWallet().then(function(){if(typeof renderAdminAccess===\'function\')renderAdminAccess({clear:true});})">Connect maintainer wallet</button>'
    : '<button class="adm-out" type="button" onclick="disconnectWallet()">Disconnect wallet</button>';
  return '<div class="adm-card locked"><div class="adm-access-tag">Authority gate</div><h3>' + title + '</h3><p>' + body + '</p>' + note + '<div class="adm-lock-actions">' + action + '</div></div>';
}
function admLockedHost(){
  var host = document.getElementById('admLocked');
  if(host) return host;
  var login = document.getElementById('admLogin');
  if(!login || !login.parentNode) return null;
  host = document.createElement('div');
  host.id = 'admLocked';
  login.parentNode.insertBefore(host, login);
  return host;
}
function admClearProtectedData(){
  var consoleHost = document.getElementById('admConsole'); if(consoleHost) consoleHost.innerHTML = '<div class="moc-loading">Maintainer access locked.</div>';
  var queue = document.getElementById('admQueue'); if(queue) queue.innerHTML = '';
  var controls = document.getElementById('esc-pack-controls'); if(controls) controls.innerHTML = '';
  var out = document.getElementById('esc-out'); if(out) out.value = '';
  var outWrap = document.getElementById('esc-out-wrap'); if(outWrap) outWrap.style.display = 'none';
  var status = document.getElementById('esc-status'); if(status) status.textContent = 'Locked';
  window.__admBounties = [];
  window.__admConsoleModel = null;
  window.__admSelectedKey = null;
}
function renderAdminAccess(opts){
  opts = opts || {};
  var ctx = resolveMaintainerAccess();
  var login = document.getElementById('admLogin');
  var panel = document.getElementById('admPanel');
  var locked = admLockedHost();
  if(!login || !panel) return ctx;
  if(!ctx.allowed){
    panel.style.display = 'none';
    admClearProtectedData();
    if(ctx.state === 'login_required'){
      if(locked) locked.style.display = 'none';
      login.style.display = 'block';
      var msg = document.getElementById('admMsg');
      if(msg && !msg.textContent) msg.textContent = 'Authority login required. Sign in to continue.';
    } else {
      login.style.display = 'none';
      if(locked){ locked.innerHTML = admLockedHtml(ctx); locked.style.display = 'block'; }
      var loginMsg = document.getElementById('admMsg'); if(loginMsg) loginMsg.textContent = '';
    }
    return ctx;
  }
  if(locked) locked.style.display = 'none';
  login.style.display = 'none';
  panel.style.display = 'block';
  var who = document.getElementById('admWho');
  if(who){ var email = document.getElementById('admEmail'); who.textContent = (email && email.value) ? email.value : 'authority session'; }
  var su=document.getElementById('admSupport'); if(su) su.value = OSI_SUPPORT_WALLET || '';
  var aw=document.getElementById('admAdminW'); if(aw) aw.value = OSI_ADMIN_WALLET || '';
  var ct=document.getElementById('admConThr'); if(ct) ct.value = CONSENSUS_THRESHOLD;
  var ca=document.getElementById('admConAuto'); if(ca) ca.checked = CONSENSUS_AUTO;
  if(opts.refresh && typeof admRefresh === 'function') admRefresh();
  return ctx;
}
function requireMaintainerAccess(actionName){
  var ctx = resolveMaintainerAccess();
  if(ctx.allowed) return true;
  if(document.body && document.body.dataset && document.body.dataset.view === 'admin'){
    try{ renderAdminAccess({clear:true}); }catch(_){}
  }
  var msg = maintainerAccessMessage(ctx, actionName);
  if(typeof showToast === 'function') showToast(msg); else alert(msg);
  return false;
}
function admOpen(){ showView('admin'); }
async function admLogin(){
  const email=(document.getElementById('admEmail').value||'').trim();
  const pw=document.getElementById('admPw').value||'';
  const msg=document.getElementById('admMsg');
  const pre = resolveMaintainerAccess();
  if(pre.state === 'no_wallet' || pre.state === 'wrong_wallet'){ renderAdminAccess({clear:true}); return; }
  if(!SUPA_ON){ msg.textContent='Supabase is not configured yet (check config.js).'; return; }
  if(!email || !pw){ msg.textContent='Enter the maintainer email and password.'; return; }
  msg.textContent='Signing in...';
  try{
    await supaSignIn(email, pw);
    if(!resolveMaintainerAccess().allowed){ msg.textContent=maintainerAccessMessage(resolveMaintainerAccess()); renderAdminAccess({clear:true}); return; }
    msg.textContent='';
    try{ localStorage.setItem('stw_maint_dev','1'); }catch(_){}
    if(typeof updateAdminButton==='function') updateAdminButton();
    renderAdminAccess({refresh:true});
  }catch(e){ msg.textContent='Sign-in failed: '+e.message; }
}
function admLogout(){
  supaSignOut();
  const pw=document.getElementById('admPw'); if(pw) pw.value='';
  if(typeof updateAdminButton==='function') updateAdminButton();
  renderAdminAccess({clear:true});
}
async function admSafeGet(path){
  try{ return { ok:true, rows:(await supaGet(path)) || [] }; }
  catch(e){ return { ok:false, rows:[], error:e }; }
}
function admShortWallet(w){ return w ? (typeof short === 'function' ? short(w) : maintainerShortWallet(w)) : 'Unknown'; }
function admTime(v){ return v ? ((typeof fdAgo === 'function') ? fdAgo(v) : new Date(v).toLocaleDateString()) : 'Unknown'; }
function admClip(s,n){ s=String(s==null?'':s).trim(); return s.length>n ? s.slice(0,n-1)+'...' : s; }
function admCount(v){ return v === null || v === undefined ? '<span class="v na">Not available yet</span>' : '<span class="v">'+admEsc(String(v))+'</span>'; }
function admVouchSummary(type,id,vouches){
  var a=0,r=0;
  (vouches||[]).forEach(function(v){
    if(String(v.item_type)===String(type) && String(v.item_id)===String(id)){
      if(v.vote==='reject') r++; else a++;
    }
  });
  return { approve:a, reject:r, total:a+r };
}
function admChallengeList(type,id,challenges){
  return (challenges||[]).filter(function(c){ return String(c.item_type||'')===String(type) && String(c.item_id||'')===String(id); });
}
function admProofList(type,id,events){
  return (events||[]).filter(function(e){ return String(e.item_type||'')===String(type) && String(e.item_id||'')===String(id); });
}
function admStatusFor(kind,row){
  if(kind==='pack') return row.status === 'approved' ? 'Reviewed pack' : 'Ready to review';
  if(kind==='challenge') return row.status ? String(row.status) : 'Open';
  if(kind==='analyst') return (row.approved && row.verified) ? 'Verified' : 'Application';
  if(row.sealed) return 'Sealed';
  if(row.approved) return 'Published';
  return 'Pending review';
}
function admRiskFor(item){
  if(item.challengeCount>0 || item.kind==='challenge') return { label:'Disputed', cls:'challenge' };
  if(item.kind==='pack') return { label:item.status.indexOf('Ready')===0?'Review':'Reviewed', cls:item.status.indexOf('Ready')===0?'pending':'ok' };
  if(item.status==='Pending review' || item.status==='Application') return { label:'Pending', cls:'pending' };
  if(item.status==='Sealed' || item.status==='Published' || item.status==='Verified') return { label:'Reviewed', cls:'ok' };
  return { label:'Monitor', cls:'' };
}
function admMakeItem(kind,row,ctx){
  var id = String(kind==='analyst' ? (row.wallet||row.id||'analyst') : (row.id||row.case_ref||'item'));
  var title = kind==='report' ? (row.company || row.bounty || row.title || id)
    : kind==='case' ? (row.target || row.title || id)
    : kind==='analyst' ? (row.name || row.handle || row.wallet || id)
    : kind==='challenge' ? (row.item_label || row.item_id || id)
    : (row.pack_type || row.case_ref || id);
  var submitter = kind==='report' ? row.wallet
    : kind==='case' ? (row.created_by || row.wallet)
    : kind==='analyst' ? row.wallet
    : kind==='challenge' ? row.challenger
    : '';
  var itemType = kind==='case' ? 'bounty' : (kind==='pack' ? 'report' : kind);
  var itemId = kind==='pack' ? row.case_ref : id;
  var votes = admVouchSummary(itemType, itemId, ctx.vouches);
  var challengeRows = admChallengeList(itemType, itemId, ctx.challenges);
  var proofs = admProofList(itemType, itemId, ctx.events);
  var status = admStatusFor(kind,row);
  var summary = row.summary || row.detail || row.reason || row.bio || row.content || '';
  var evidence = [row.onchain,row.offchain,row.tx,row.attachment,row.link].filter(Boolean).join(' / ');
  var it = {
    key:kind+'|'+id,
    kind:kind,
    id:id,
    title:String(title || id),
    submitter:submitter || '',
    status:status,
    votes:votes,
    challengeCount:challengeRows.length,
    challenges:challengeRows,
    proofEvents:proofs,
    created:row.created_at || row.updated_at || '',
    updated:row.updated_at || row.created_at || '',
    summary:String(summary || ''),
    evidence:String(evidence || ''),
    row:row,
    isPublic:!!(row.approved || row.sealed || row.status==='approved')
  };
  it.risk = admRiskFor(it);
  return it;
}
function admConsoleModel(src){
  var reports=src.reports.rows||[], bounties=src.bounties.rows||[], analysts=src.analysts.rows||[], challenges=src.challenges.rows||[], packs=src.packs.rows||[], events=src.events.rows||[], vouches=src.vouches.rows||[];
  var ctx = { challenges:challenges, events:events, vouches:vouches };
  var items=[];
  reports.filter(function(r){ return !r.approved || r.sealed || admChallengeList('report',r.id,challenges).length; }).forEach(function(r){ items.push(admMakeItem('report',r,ctx)); });
  bounties.filter(function(b){ return !b.approved || admChallengeList('bounty',b.id,challenges).length; }).forEach(function(b){ items.push(admMakeItem('case',b,ctx)); });
  analysts.filter(function(a){ return !(a.approved && a.verified); }).forEach(function(a){ items.push(admMakeItem('analyst',a,ctx)); });
  challenges.filter(function(c){ return !c.status || c.status==='open'; }).forEach(function(c){ items.push(admMakeItem('challenge',c,ctx)); });
  packs.filter(function(p){ return p.status !== 'approved'; }).forEach(function(p){ items.push(admMakeItem('pack',p,ctx)); });
  items.sort(function(a,b){ return new Date(b.updated||b.created||0) - new Date(a.updated||a.created||0); });
  return {
    sources:src,
    items:items,
    events:events,
    alerts:items.filter(function(i){ return i.kind==='challenge' || i.challengeCount>0 || i.risk.cls==='challenge'; }).slice(0,6),
    counts:{
      reports:src.reports.ok ? reports.filter(function(r){ return !r.approved; }).length : null,
      cases:src.bounties.ok ? bounties.filter(function(b){ return !b.approved; }).length : null,
      analysts:src.analysts.ok ? analysts.filter(function(a){ return !(a.approved && a.verified); }).length : null,
      ready:src.packs.ok ? packs.filter(function(p){ return p.status !== 'approved'; }).length : null,
      challenges:src.challenges.ok ? challenges.filter(function(c){ return !c.status || c.status==='open'; }).length : null,
      safety:null
    }
  };
}
function admStatCard(label,value,tone,note){
  return '<div class="moc-card '+(tone||'')+'"><div class="k">'+admEsc(label)+'</div>'+admCount(value)+'<div class="s">'+admEsc(note||'Live source pending')+'</div></div>';
}
function admFilterMatches(item,filter){
  if(!filter || filter==='overview' || filter==='queue') return true;
  if(filter==='cases') return item.kind==='case';
  if(filter==='reports') return item.kind==='report';
  if(filter==='analysts') return item.kind==='analyst';
  if(filter==='ready') return item.kind==='pack';
  if(filter==='challenges') return item.kind==='challenge';
  if(filter==='safety') return item.risk.cls==='challenge';
  if(filter==='proof') return item.proofEvents && item.proofEvents.length;
  return false;
}
function admConsoleNav(active){
  var nav=[['overview','Overview'],['queue','Review Queue'],['cases','Pending Cases'],['reports','Pending Reports'],['analysts','Analyst Applications'],['ready','Ready to Publish'],['challenges','Challenges'],['safety','Safety Flags'],['proof','Proof Log Review'],['settings','Settings'],['audit','Audit Trail']];
  return '<aside class="moc-nav"><div class="moc-nav-k">Command Center</div>'+nav.map(function(n){
    return '<button class="moc-nav-btn '+(active===n[0]?'active':'')+'" type="button" onclick="admConsoleFilter(\''+n[0]+'\')"><i></i><span>'+admEsc(n[1])+'</span></button>';
  }).join('')+'</aside>';
}
function admQueueHtml(items,selectedKey){
  if(!items.length) return '<div class="moc-empty">No items found for this section.</div>';
  return '<div class="moc-table-head"><span>Type</span><span>ID</span><span>Title / Subject</span><span>Submitter</span><span>Status</span><span>Votes</span><span>Challenges</span><span>Updated</span><span></span></div>'
    + items.map(function(it){
      var cls = it.kind==='case' ? 'case' : it.kind;
      return '<button class="moc-row '+(it.key===selectedKey?'active':'')+'" type="button" onclick="admSelectItem(\''+admEsc(String(it.key).replace(/\\/g,'\\\\').replace(/'/g,"\\'"))+'\')">'
        + '<span class="moc-pill '+cls+'">'+admEsc(it.kind==='case'?'Case':it.kind)+'</span>'
        + '<span>'+admEsc(admClip(it.id,18))+'</span>'
        + '<b>'+admEsc(admClip(it.title,72))+'</b>'
        + '<span title="'+admEsc(it.submitter)+'">'+admEsc(admShortWallet(it.submitter))+'</span>'
        + '<span class="moc-pill '+(it.status==='Pending review'||it.status==='Application'||it.status==='Ready to review'?'pending':'ok')+'">'+admEsc(it.status)+'</span>'
        + '<span>'+admEsc(String(it.votes.total))+'</span>'
        + '<span>'+admEsc(String(it.challengeCount))+'</span>'
        + '<span>'+admEsc(admTime(it.updated||it.created))+'</span>'
        + '<span class="moc-chevron">›</span>'
        + '</button>';
    }).join('');
}
function admSelectedHtml(it){
  if(!it) return '<aside class="moc-panel"><div class="moc-panel-body"><div class="moc-empty">Select a queue item to inspect its record.</div></div></aside>';
  var cls = it.kind==='case' ? 'case' : it.kind;
  var evidence = it.evidence || it.summary || 'No evidence summary available in visible fields.';
  var proofLabel = it.proofEvents.length ? (it.proofEvents.length + ' proof log event(s)') : 'No linked proof events found';
  var challengeLabel = it.challengeCount ? (it.challengeCount + ' open challenge(s)') : 'No linked challenges';
  var publicDisabled = it.isPublic ? '' : ' disabled';
  var analystDisabled = it.kind==='analyst' && it.submitter ? '' : ' disabled';
  return '<aside class="moc-panel" aria-label="Selected maintainer item">'
    + '<div class="moc-panel-head"><div class="moc-panel-k">Selected Item</div><span class="moc-pill '+cls+'">'+admEsc(it.kind==='case'?'Case':it.kind)+'</span><h3>'+admEsc(admClip(it.title,80))+'</h3><div class="moc-panel-id">'+admEsc(it.id)+'</div></div>'
    + '<div class="moc-panel-body"><div class="moc-detail">'
    + '<div class="moc-detail-row"><span>Submitter</span><b>'+admEsc(admShortWallet(it.submitter))+'</b></div>'
    + '<div class="moc-detail-row"><span>Status</span><b><span class="moc-pill '+(it.status==='Pending review'||it.status==='Application'||it.status==='Ready to review'?'pending':'ok')+'">'+admEsc(it.status)+'</span></b></div>'
    + '<div class="moc-detail-row"><span>Updated</span><b>'+admEsc(admTime(it.updated||it.created))+'</b></div>'
    + '<div class="moc-detail-row"><span>Analyst votes</span><b>'+admEsc(String(it.votes.approve))+' approve / '+admEsc(String(it.votes.reject))+' reject</b></div>'
    + '<div class="moc-detail-row"><span>Challenges</span><b>'+admEsc(challengeLabel)+'</b></div>'
    + '<div class="moc-detail-row"><span>Proof log</span><b>'+admEsc(proofLabel)+'</b></div>'
    + '</div><div class="moc-note moc-evidence" id="moc-evidence"><b>Evidence summary</b>'+admEsc(admClip(evidence,700))+'</div>'
    + '<div class="moc-actions">'
    + '<button class="moc-action" type="button" onclick="admFocusEvidence()">View Evidence</button>'
    + '<button class="moc-action" type="button" onclick="showView(\'prooflog\')">View Proof Log</button>'
    + '<button class="moc-action" type="button" onclick="showView(\'analysts\')">Open Full Review</button>'
    + '<button class="moc-action" type="button" onclick="showView(\'records\')"'+publicDisabled+'>Open Public Record</button>'
    + '<button class="moc-action" type="button" onclick="admOpenSelectedAnalyst()"'+analystDisabled+'>Open Analyst Profile</button>'
    + '</div><div class="moc-disabled">'
    + '<button class="moc-action" type="button" disabled>Approve / Reject disabled: Requires hardened backend</button>'
    + '<button class="moc-action" type="button" disabled>Seal Record disabled: Requires hardened backend review</button>'
    + '</div></div></aside>';
}
function admBottomHtml(model){
  var evs = model.sources.events.ok ? (model.events || []) : null;
  var activity = evs === null ? '<div class="moc-empty">Proof log activity is not connected yet.</div>' : (!evs.length ? '<div class="moc-empty">No public signed activity yet.</div>' : '<div class="moc-feed">'+evs.slice(0,5).map(function(e){
    return '<div class="moc-feed-row"><i class="moc-dot"></i><div><b>'+admEsc(e.label || e.event_type || 'Signed action')+'</b><span>'+admEsc(admShortWallet(e.actor_wallet))+' / '+admEsc(admTime(e.created_at))+'</span></div><span>'+admEsc(e.item_id?admClip(e.item_id,10):'')+'</span></div>';
  }).join('')+'</div>');
  var alerts = model.alerts.length ? '<div class="moc-feed">'+model.alerts.map(function(a){
    return '<div class="moc-feed-row"><i class="moc-dot" style="background:var(--amber);box-shadow:0 0 12px rgba(255,176,32,.5)"></i><div><b>'+admEsc(admClip(a.title,64))+'</b><span>'+admEsc(a.kind)+' / '+admEsc(a.risk.label)+'</span></div><span>'+admEsc(admTime(a.updated||a.created))+'</span></div>';
  }).join('')+'</div>' : '<div class="moc-empty">No open alerts from available real sources.</div>';
  var health = '<div class="moc-empty">System health telemetry is not connected yet.</div>';
  return '<div class="moc-bottom"><div class="moc-bottom-card"><div class="moc-bottom-h">Activity Feed</div>'+activity+'</div><div class="moc-bottom-card"><div class="moc-bottom-h">Recent Alerts</div>'+alerts+'</div><div class="moc-bottom-card"><div class="moc-bottom-h">Network Integrity</div>'+health+'</div></div>';
}
function admRenderConsole(model){
  var host=document.getElementById('admConsole'); if(!host) return;
  window.__admConsoleModel = model;
  var filter = window.__admConsoleFilter || 'overview';
  var items = model.items.filter(function(it){ return admFilterMatches(it,filter); });
  if(filter==='settings' || filter==='audit') items = [];
  var selected = items.find(function(it){ return it.key===window.__admSelectedKey; }) || items[0] || null;
  window.__admSelectedKey = selected ? selected.key : null;
  host.className = 'moc-shell';
  host.innerHTML = admConsoleNav(filter)
    + '<main class="moc-main"><div class="moc-head"><div class="moc-kicker">Authority Access</div><h2>Maintainer Operations Center</h2><p>Real-time oversight of OSI network integrity, verification, and public record lifecycle.</p></div>'
    + '<section class="moc-sec"><div class="moc-stats">'
    + admStatCard('Pending Reports',model.counts.reports,'pending','Pending review')
    + admStatCard('Pending Cases',model.counts.cases,'pending','Awaiting assessment')
    + admStatCard('Analyst Applications',model.counts.analysts,'analyst','Analyst onboarding')
    + admStatCard('Ready to Publish',model.counts.ready,'ok','Escalation packs')
    + admStatCard('Open Challenges',model.counts.challenges,'danger','Open disputes')
    + admStatCard('Safety Flags',model.counts.safety,'system','No dedicated source yet')
    + '</div></section><section class="moc-sec">'+admQueueHtml(items,window.__admSelectedKey)+admBottomHtml(model)+'</section></main>'
    + admSelectedHtml(selected);
}
function admConsoleFilter(filter){ window.__admConsoleFilter = filter || 'overview'; window.__admSelectedKey = null; if(window.__admConsoleModel) admRenderConsole(window.__admConsoleModel); }
function admSelectItem(key){ window.__admSelectedKey = key; if(window.__admConsoleModel) admRenderConsole(window.__admConsoleModel); }
function admCurrentSelected(){ var m=window.__admConsoleModel; if(!m) return null; return (m.items||[]).find(function(it){ return it.key===window.__admSelectedKey; }) || null; }
function admFocusEvidence(){ var el=document.getElementById('moc-evidence'); if(!el) return; el.scrollIntoView({behavior:'smooth',block:'center'}); el.classList.add('moc-evidence-flash'); setTimeout(function(){ el.classList.remove('moc-evidence-flash'); },1300); }
function admOpenSelectedAnalyst(){ var it=admCurrentSelected(); if(it && it.kind==='analyst' && it.submitter && typeof openRosterProfile==='function') openRosterProfile(it.submitter); else showView('analysts'); }
async function admRefresh(){
  var access = renderAdminAccess({clear:true});
  if(!access.allowed) return;
  const host=document.getElementById('admConsole');
  if(host){ host.className='moc-shell'; host.innerHTML='<div class="moc-loading">Loading real maintainer data...</div>'; }
  try{
    const reads = await Promise.all([
      admSafeGet('reports?select=*&order=created_at.desc&limit=200'),
      admSafeGet('bounties?select=*&order=created_at.desc&limit=200'),
      admSafeGet('analysts?select=*&order=created_at.desc&limit=300'),
      admSafeGet('challenges?select=*&order=created_at.desc&limit=200'),
      admSafeGet('escalation_packs?select=*&order=created_at.desc&limit=200'),
      admSafeGet('vouches?select=item_type,item_id,analyst,vote&limit=1000'),
      admSafeGet('onchain_events?select=event_type,actor_wallet,item_type,item_id,vote,label,tx_sig,created_at&order=created_at.desc&limit=80')
    ]);
    if(!resolveMaintainerAccess().allowed){ renderAdminAccess({clear:true}); return; }
    const model = admConsoleModel({ reports:reads[0], bounties:reads[1], analysts:reads[2], challenges:reads[3], packs:reads[4], vouches:reads[5], events:reads[6] });
    window.__admBounties = reads[1].rows || [];
    admRenderConsole(model);
  }catch(e){
    if(host) host.innerHTML='<div class="moc-error">Could not load the operations center ('+admEsc(e.message)+'). Recheck maintainer access and Supabase policies, then refresh.</div>';
  }
}
async function admResolveBounty(id){
  if(!requireMaintainerAccess('Resolve case')) return;
  const w = prompt("Paste the winning analyst's wallet address (copy it from their report).\n\nThis marks the bounty resolved and makes the reward button live on the board, so anyone can pay the winner in SOL. Leave blank to clear the winner.");
  if(w===null) return;
  const wallet=(w||'').trim();
  if(wallet && (wallet.length<32 || wallet.length>46)){ showToast("That does not look like a Solana wallet address."); return; }
  osiSignEvent({ eventType:'CASE_RESOLVED', actionLabel:'Resolve case', caseId: id, itemType:'bounty', itemId: id, sensitive:true, onSuccess: async (sig)=>{
  if(!wallet){
    try{ await supaPatch('bounties?id=eq.'+encodeURIComponent(id), { winner_wallet:null, winner_label:null }); showToast('Winner cleared.'); admRefresh(); admReflow(); }
    catch(e){ showToast('Failed: '+((e&&e.message)||e)); }
    return;
  }
  try{
    await supaPatch('bounties?id=eq.'+encodeURIComponent(id), { winner_wallet: wallet, winner_label: short(wallet) });
    showToast('Bounty resolved. The reward button is now live on the board.');
    admRefresh(); admReflow();
  }catch(e){ showToast('Could not resolve: '+((e&&e.message)||e)); }
  }});
}

function admReflow(){
  // After a moderation action, refresh every public-facing view so an approval
  // (or removal) is reflected live across the whole site, not just the queue.
  try{ if(typeof renderRequests==='function') renderRequests(); }catch(_){}
  try{ if(typeof hydrateRequestsFromSupabase==='function') hydrateRequestsFromSupabase(); }catch(_){}
  try{ if(typeof hydrateReportsFromSupabase==='function') hydrateReportsFromSupabase(); }catch(_){}
  try{ if(typeof renderFieldOffice==='function') renderFieldOffice(); }catch(_){}
  try{ if(typeof renderWire==='function') renderWire(); }catch(_){}
  try{ if(typeof renderActivity==='function') renderActivity(); }catch(_){}
}
async function admSet(table, id, approved){
  if(!requireMaintainerAccess(approved ? 'Approve item' : 'Unpublish item')) return;
  osiSignEvent({ eventType: approved?'MAINTAINER_APPROVAL':'MAINTAINER_REJECTION', actionLabel: approved?'Approve item':'Unpublish item', caseId: (table==='bounties'?id:''), reportId: (table==='reports'?id:''), itemType: (table==='reports'?'report':(table==='bounties'?'bounty':String(table||'item'))), itemId: id, sensitive: !approved, publicLabel: (approved?'Maintainer approved':null), onSuccess: async (sig)=>{
  try{ await supaPatch(table+'?id=eq.'+encodeURIComponent(id), { approved: approved }); showToast(approved?'Published. Now public for everyone.':'Unpublished.'); admRefresh(); admReflow(); }
  catch(e){ showToast('Action failed: '+e.message); }
  }});
}
async function admDel(table, id){
  if(!requireMaintainerAccess('Delete item')) return;
  if(!confirm('Delete this permanently? This cannot be undone.')) return;
  osiSignEvent({ eventType:'RECORD_DELETED', actionLabel:'Delete item', caseId: (table==='bounties'?id:''), reportId: (table==='reports'?id:''), itemType: (table==='reports'?'report':(table==='bounties'?'bounty':String(table||'item'))), itemId: id, sensitive:true, onSuccess: async (sig)=>{
  try{ await supaDelete(table+'?id=eq.'+encodeURIComponent(id)); showToast('Deleted.'); admRefresh(); admReflow(); }
  catch(e){ showToast('Delete failed: '+e.message); }
  }});
}
document.addEventListener('DOMContentLoaded', function(){ if(location.hash==='#admin'){ try{ showView('admin'); }catch(_){} } });
window.addEventListener('hashchange', function(){ if(location.hash==='#admin'){ try{ showView('admin'); }catch(_){} } });


// review queue seed, one clearly-labelled example so the scoring UI stays
// demonstrable; real submissions render above it as "pending review".
let walletPubkey = null;                 // connected wallet address (string)

function getProvider(){
  // Phantom injects window.solana
  if(window.solana && window.solana.isPhantom) return window.solana;
  return null;
}

function clearWalletCache(){
  try{ localStorage.removeItem('stw_profile_name'); }catch(e){}
  try{ localStorage.removeItem('stw_wallet_off'); }catch(e){}
  try{ sessionStorage.removeItem('osi_wallet_session'); }catch(e){}
}
// True only if the user connected earlier in THIS browser session (sessionStorage, not localStorage).
function sessionRestoreWanted(){ try{ return sessionStorage.getItem('osi_wallet_session') === '1'; }catch(e){ return false; } }
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
  if(msg.indexOf("rpc") >= 0 || msg.indexOf("network") >= 0 || msg.indexOf("blockhash") >= 0 || msg.indexOf("timeout") >= 0 || msg.indexOf("fetch") >= 0) return "Could not reach the Solana network. Check your connection and try again in a moment.";
  if(msg.indexOf("buffer") >= 0) return "Could not build the transaction in this browser. Hard-refresh (Ctrl/Cmd + Shift + R) and try again.";
  return ctx + " could not be completed. " + (((e && e.message) || "Please try again."));
}
// Small menu under the wallet button (Open profile / Disconnect).
function closeWalletMenu(){ var m=document.getElementById('wbMenu'); if(m) m.classList.remove('open'); }
function toggleWalletMenu(){ var m=document.getElementById('wbMenu'); if(m) m.classList.toggle('open'); }

async function toggleWallet(){
  var prov = getProvider();
  if(!prov){
    if(typeof showToast==='function') showToast("Phantom not found. Install it from phantom.app, then refresh and connect.");
    try{ window.open("https://phantom.app/","_blank"); }catch(e){}
    return false;
  }
  if(walletPubkey && prov.publicKey && prov.isConnected !== false) return true; // already connected this session
  try{
    var resp = await prov.connect();
    if(!resp || !resp.publicKey){ if(typeof showToast==='function') showToast("Connect Phantom first."); return false; }
    walletPubkey = resp.publicKey.toString();
    try{ sessionStorage.setItem('osi_wallet_session','1'); }catch(e){}
    updateWalletUI();
    if(typeof showToast==='function') showToast('Connected \u2713  Use the wallet button to open your profile or disconnect.');
    return true;
  }catch(e){
    if(typeof showToast==='function') showToast(walletErrorMessage(e, "Connection"));
    return false;
  }
}

function updateWalletUI(){
  const btn = document.getElementById('walletBtn');
  const txt = document.getElementById('wbText');
  if(!btn || !txt) return;
  if(walletPubkey){
    btn.classList.add('connected');
    const nm = lsGet('stw_profile_name','');
    txt.textContent = nm ? nm : (walletPubkey.slice(0,4)+'\u2026'+walletPubkey.slice(-4));
    let av = document.getElementById('wbAva');
    if(!av){ av=document.createElement('span'); av.id='wbAva'; av.className='wb-ava'; btn.insertBefore(av, btn.firstChild); }
    av.innerHTML = pfIdenticon(walletPubkey, 18);
    const dot = btn.querySelector('.wb-dot'); if(dot) dot.style.display='none';
  } else {
    btn.classList.remove('connected');
    if(typeof closeWalletMenu==='function') closeWalletMenu();
    txt.textContent = "Connect Wallet";
    const av = document.getElementById('wbAva'); if(av) av.remove();
    const dot = btn.querySelector('.wb-dot'); if(dot) dot.style.display='';
  }
  if(typeof updateAdminButton === 'function') updateAdminButton();
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

  const signed = await prov.signAndSendTransaction(tx);  // Phantom signs + sends
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
      canReview: isMaintainer || (walletConnected && verifiedAnalyst),
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

// Uniswap/PancakeSwap-style wallet: silent restore on refresh ONLY within the same browser session.
window.addEventListener('load', function(){
  wireContactLinks();
  var prov = getProvider();
  if(prov && prov.on){
    prov.on('disconnect', function(){ walletPubkey = null; clearWalletCache(); if(typeof closeWalletMenu==='function') closeWalletMenu(); updateWalletUI(); });
    prov.on('accountChanged', function(pk){
      if(pk){ walletPubkey = pk.toString(); } else { walletPubkey = null; clearWalletCache(); }
      updateWalletUI();
    });
  }
  // Silent restore only if the user connected earlier in this session; new browser session = manual connect.
  if(prov && sessionRestoreWanted()){
    prov.connect({ onlyIfTrusted:true }).then(function(resp){
      if(resp && resp.publicKey){ walletPubkey = resp.publicKey.toString(); updateWalletUI(); }
    }).catch(function(){ /* not trusted or revoked: stay disconnected, user connects manually */ });
  }
  document.addEventListener('click', function(e){
    var inside = e.target && e.target.closest && e.target.closest('.wb-wrap');
    if(!inside && typeof closeWalletMenu==='function') closeWalletMenu();
  });
});

renderCaseStudies();
if(typeof renderCaseRecords==='function') renderCaseRecords();
syncTabCounts();
renderRequests();
renderReviewQueue();
restoreBountyState();
renderFieldOffice();
renderWire();
loadConfig().then(function(){ try{ renderCaseStudies(); }catch(e){} try{ renderWire(); }catch(e){} try{ updateAdminButton(); }catch(e){} });
loadAnalysts().then(function(){ try{ renderAnalysts(); }catch(e){} try{ renderReviewFloor(); }catch(e){} });
window.addEventListener('hashchange', function(){ if(typeof updateAdminButton==='function') updateAdminButton(); });
renderTicker();
renderActivity();
loadPrice();

// ---- case studies (data-driven, collapsible) ----
function toggleCase(el){ el.closest('.co').classList.toggle('open'); }


function openReport(kind, id){
  if(kind==='case'){
    showView('records');
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
          <div class="warn"><b>${noteLead}.</b> ${noteRest}</div>
          ${OSI_SUPPORT_WALLET ? `<div class="cs-support"><div class="cs-support-t">Support the OSI project</div><div class="cs-support-s">Voluntary, direct wallet-to-wallet support for OSI in SOL. Non-custodial, and it does not influence review, ranking, or publication.</div><button class="cs-support-btn" onclick="openTip('${OSI_SUPPORT_WALLET}','OSI project support',0.5,'\u25ce Voluntary support')">\u25ce Support the OSI project</button></div>` : ''}
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
  if(v==='admin' && typeof renderAdminAccess==='function'){ renderAdminAccess({refresh:true}); }
  if(v==='identity' && typeof renderIdentity==='function'){ renderIdentity(); }
  if(v==='workspace' && typeof renderWorkspace==='function'){ renderWorkspace(); }
  if(v==='profile'){ renderProfile(); }
  if(v==='field'){ renderFieldOffice(); }
  if(v==='wire'){ renderWire(); }
  if(v==='analysts'){ renderLeaderboard(); }
  if(v==='prooflog'){ renderProofLog(); }
  if(v==='records'){ if(typeof renderCaseRecords==='function' && (typeof demoRecState==='undefined' || demoRecState===null)){ try{ renderCaseRecords(); }catch(e){} } }
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
async function identitySafeGet(path){
  if(typeof SUPA_ON === 'undefined' || !SUPA_ON) return null;
  try{ return await supaGet(path) || []; }catch(e){ return null; }
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
    + tabs.map(function(t,i){ return '<button class="identity-tab'+(i===0?' active':'')+'" type="button" role="tab" aria-selected="'+(i===0?'true':'false')+'" data-tab="'+t[0]+'" onclick="identityTab(\''+t[0]+'\')">'+escapeHtml(t[1])+'</button>'; }).join('')
    + '</div>';
}
function identityTab(id){
  var root = document.getElementById('identity-shell'); if(!root) return;
  root.querySelectorAll('.identity-tab').forEach(function(b){
    var on = b.getAttribute('data-tab') === id;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  root.querySelectorAll('.identity-pane').forEach(function(p){ p.classList.toggle('active', p.getAttribute('data-pane') === id); });
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
    + identityPowCard('Cases Opened', s.casesOpened, 'Visible cases opened by this wallet')
    + identityPowCard('Reports Submitted', s.reportsSubmitted, 'Visible submissions from this wallet')
    + identityPowCard('Reviews & Vouches', s.reviews, 'Visible review or vouch records')
    + identityPowCard('Challenges Filed', s.challenges, 'Visible public challenge records')
    + identityPowCard('Signed Actions', s.signedActions, 'Indexed proof log events')
    + identityPowCard('Public Records', s.publicRecords, 'Approved public contributions')
    + '</div>';
}
function identityEventText(ev){
  var t = String((ev && ev.event_type) || 'signed_action');
  if(t === 'wire_dispatch') return 'Filed a Wire dispatch';
  if(t === 'analyst_vouch') return ev.vote === 'reject' ? 'Filed or supported a challenge' : 'Signed an analyst review';
  if(t === 'demand_signal') return 'Backed a case';
  if(t === 'maintainer_seal') return 'Sealed a public record';
  if(t === 'case_opened') return 'Opened a case';
  if(t === 'report_submitted') return 'Submitted a report';
  return 'Signed an OSI action';
}
function identityActivity(m){
  var events = (m && m.events) || [];
  if(!events.length) return '<div class="identity-empty">No public signed activity yet.</div>';
  return '<div class="identity-activity">' + events.slice(0,5).map(function(ev){
    var item = ev.item_id ? ('Item ' + String(ev.item_id).slice(0,16)) : 'Public proof log';
    var when = (typeof fdAgo === 'function') ? fdAgo(ev.created_at) : '';
    var link = ev.tx_sig ? '<a href="https://solscan.io/tx/'+encodeURIComponent(String(ev.tx_sig))+'" target="_blank" rel="noopener">Verify</a>' : '<span></span>';
    return '<div class="identity-act-row"><i class="identity-act-dot"></i><div><b>'+escapeHtml(identityEventText(ev))+'</b><span>'+escapeHtml(item + (when ? (' / ' + when) : ''))+'</span></div>'+link+'</div>';
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
  if(ctx.isVerifiedAnalyst && m.analystWeight){ rows += '<div class="identity-status-row"><span>Review weight</span><b>x'+escapeHtml(String(m.analystWeight))+'</b></div>'; }
  if(ctx.isVerifiedAnalyst && m.analystStats && m.analystStats.tier){ rows += '<div class="identity-status-row"><span>Analyst tier</span><b>'+escapeHtml(m.analystStats.tier.name || 'Available')+'</b></div>'; }
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
    + '<button class="identity-action" type="button" onclick="showView(\'profile\')"><span>Edit profile</span><small>Existing profile</small></button>'
    + '<button class="identity-action" type="button" onclick="showView(\'profile\')"><span>Update avatar</span><small>Existing profile</small></button>'
    + '<button class="identity-action" type="button" onclick="openSelfProfile()"><span>Proof-of-Work CV</span><small>Public record</small></button>'
    + '<button class="identity-action" type="button" onclick="showView(\'workspace\')"><span>My OSI</span><small>Workspace</small></button>'
    + '</div></aside>';
}
function identityConnectHtml(ctx){
  var maint = ctx && ctx.isMaintainer ? '<div class="identity-empty identity-gate-note">Maintainer session is active. Connect a wallet to view the wallet-linked passport.</div>' : '';
  return identityHero() + '<div class="identity-connect-state"><div class="identity-connect-card"><div class="identity-kicker">Wallet Required</div><h2>Your Intelligence Passport</h2><p>Connect a wallet to view role status, signed actions, public records, and proof-of-work. This page is read-only.</p><button class="identity-connect" type="button" onclick="toggleWallet().then(function(){if(typeof renderIdentity===\'function\')renderIdentity();})">Connect Wallet</button>'+maint+'</div></div>';
}
async function identityLoadModel(ctx){
  var W = String(ctx.wallet || '');
  var enc = encodeURIComponent(W);
  var analystProfile = ctx.analystProfile || null;
  var localName = ''; try{ localName = lsGet('stw_profile_name','') || ''; }catch(e){}
  var model = { ctx:ctx, wallet:W, walletShort:workspaceShort(W), displayName:localName || workspaceShort(W), bio:'', avatarUrl:'', stats:{ casesOpened:null, reportsSubmitted:null, reviews:null, challenges:null, signedActions:null, publicRecords:null }, events:[], analystWeight:null, analystStats:null };
  var reads = await Promise.all([
    identitySafeGet('profiles?select=name&wallet=eq.'+enc+'&limit=1'),
    identitySafeGet('analysts?select=wallet,handle,name,bio,avatar_url,tier_weight,approved,verified,created_at&wallet=eq.'+enc+'&limit=1'),
    identitySafeGet('bounties?select=id&created_by=eq.'+enc+'&limit=200'),
    identitySafeGet('reports?select=id,approved&wallet=eq.'+enc+'&limit=200'),
    identitySafeGet('reports?select=id&wallet=eq.'+enc+'&approved=eq.true&limit=200'),
    identitySafeGet('vouches?select=item_id&analyst=eq.'+enc+'&limit=200'),
    identitySafeGet('challenges?select=id&challenger=eq.'+enc+'&limit=200'),
    identitySafeGet('onchain_events?select=event_type,item_type,item_id,vote,label,tx_sig,created_at,actor_wallet&actor_wallet=eq.'+enc+'&order=created_at.desc&limit=50'),
    identitySafeGet('reports?select=wallet&approved=eq.true&limit=500'),
    identitySafeGet('bounties?select=winner_wallet&winner_wallet=not.is.null&limit=500')
  ]);
  var prof = reads[0], analystRows = reads[1], cases = reads[2], reports = reads[3], publicReports = reads[4], vouches = reads[5], challenges = reads[6], events = reads[7], allReports = reads[8], allWins = reads[9];
  var analystRow = (analystRows && analystRows[0]) ? analystRows[0] : null;
  if(prof && prof[0] && prof[0].name) model.displayName = String(prof[0].name);
  else if(localName) model.displayName = localName;
  else if(analystRow && (analystRow.name || analystRow.handle)) model.displayName = analystRow.name || ('@'+String(analystRow.handle).replace(/^@/,''));
  else if(analystProfile && (analystProfile.name || analystProfile.handle)) model.displayName = analystProfile.name || ('@'+String(analystProfile.handle).replace(/^@/,''));
  if(analystRow && analystRow.bio) model.bio = String(analystRow.bio);
  model.avatarUrl = (typeof osiAvatarUrl === 'function') ? osiAvatarUrl(W, analystRow || analystProfile) : '';
  model.stats.casesOpened = cases === null ? null : cases.length;
  model.stats.reportsSubmitted = reports === null ? null : reports.length;
  model.stats.publicRecords = publicReports === null ? null : publicReports.length;
  model.stats.challenges = challenges === null ? null : challenges.length;
  model.events = events === null ? [] : events;
  model.stats.signedActions = events === null ? null : events.length;
  if(vouches !== null) model.stats.reviews = vouches.length;
  else if(events !== null) model.stats.reviews = events.filter(function(e){ return e.event_type === 'analyst_vouch'; }).length;
  if(ctx.isVerifiedAnalyst && typeof analystWeight === 'function') model.analystWeight = analystWeight(W);
  if(ctx.isVerifiedAnalyst && allReports !== null && allWins !== null && typeof analystStats === 'function') model.analystStats = analystStats(W, allReports, allWins);
  return model;
}
function identityConnectedHtml(m){
  var overview = '<div class="identity-pane active" data-pane="overview"><div class="identity-stack"><div class="identity-grid">'+identityPassport(m)+identityStatusCard(m)+'</div><div class="identity-card"><div class="identity-card-head"><div class="identity-card-title">Proof-of-Work</div><div class="identity-card-note">Live sources</div></div>'+identityPowGrid(m)+'</div><div class="identity-card"><div class="identity-card-head"><div class="identity-card-title">Recent Activity</div><div class="identity-card-note">Public proof trail</div></div>'+identityActivity(m)+'</div></div></div>';
  var identity = '<div class="identity-pane" data-pane="identity"><div class="identity-card"><div class="identity-card-head"><div class="identity-card-title">Identity Record</div><div class="identity-card-note">Read-only</div></div><div class="identity-mini-grid"><div class="identity-empty">Display name: '+escapeHtml(m.displayName || 'Not set')+'</div><div class="identity-empty">Wallet: '+escapeHtml(m.walletShort || 'Not connected')+'</div><div class="identity-empty">Role: '+escapeHtml(identityRoleLabel(m.ctx))+'</div><div class="identity-empty">Operator note: '+escapeHtml(m.bio || 'No public operator note yet.')+'</div></div></div></div>';
  var pow = '<div class="identity-pane" data-pane="pow"><div class="identity-stack"><div class="identity-card"><div class="identity-card-head"><div class="identity-card-title">Proof-of-Work Ledger</div><div class="identity-card-note">No generated score</div></div>'+identityPowGrid(m)+'</div><div class="identity-card"><div class="identity-card-head"><div class="identity-card-title">Signed Activity</div><div class="identity-card-note">Proof log events</div></div>'+identityActivity(m)+'</div></div></div>';
  var analystNote = m.ctx.isVerifiedAnalyst ? 'This wallet is on the verified analyst roster.' : 'This wallet is not currently on the verified analyst roster.';
  var analyst = '<div class="identity-pane" data-pane="analyst"><div class="identity-stack"><div class="identity-card"><div class="identity-card-head"><div class="identity-card-title">Analyst Status</div><div class="identity-card-note">Existing roster</div></div><div class="identity-empty">'+escapeHtml(analystNote)+'</div></div>'+identityStatusCard(m)+'</div></div>';
  var cases = '<div class="identity-pane" data-pane="cases"><div class="identity-card"><div class="identity-card-head"><div class="identity-card-title">Cases &amp; Reports</div><div class="identity-card-note">Visible records</div></div>'+identityPowGrid(m)+'<div class="identity-readonly identity-section-note">Pending or private rows may be hidden by access policies. This passport only displays visible OSI records.</div></div></div>';
  var settings = '<div class="identity-pane" data-pane="settings"><div class="identity-card"><div class="identity-card-head"><div class="identity-card-title">Settings</div><div class="identity-card-note">Read-only</div></div><div class="identity-empty">Settings and privacy controls are not enabled on this read-only passport. Use the existing Profile view for currently supported profile fields.</div></div></div>';
  return identityHero() + identityTabs() + '<div class="identity-content"><main>'+overview+identity+pow+analyst+cases+settings+'</main>'+identitySidebar(m)+'</div>';
}
async function renderIdentity(){
  var host = document.getElementById('identity-body'); if(!host) return;
  var ctx = (typeof resolveWorkspaceContext === 'function') ? resolveWorkspaceContext() : { workspaceRole:'public', wallet:null, walletConnected:false, isMaintainer:false, isVerifiedAnalyst:false, analystProfile:null };
  if(!ctx.wallet){
    host.innerHTML = identityConnectHtml(ctx);
    return;
  }
  host.innerHTML = identityHero() + '<div class="identity-connect-state"><div class="identity-connect-card"><div class="identity-kicker">Loading</div><h2>Your Intelligence Passport</h2><p>Reading existing OSI profile, role, and proof-of-work data.</p></div></div>';
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
function workspaceIdentityCard(){
  return '<div class="osi-ws-identity">'
    + '<div><div class="osi-ws-identity-k">OSI Identity</div><h2>OSI Identity</h2><p>Open your wallet-linked intelligence passport, role status, and proof-of-work record.</p></div>'
    + '<button class="osi-ws-id-btn" type="button" onclick="showView(\'identity\')">Open Intelligence Passport</button>'
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
      ['My Cases','Cases opened or filtered to your wallet.',"showView('field');if(typeof fieldMine==='function')fieldMine(true);"],
      ['My Reports','Reports and profile-linked reviewed work.',"showView('profile')"],
      ['Signed Actions','Memo-backed actions in the public proof log.',"showView('prooflog')"],
      ['Case Status','Open and pending case queue.',"showView('field')"]
    ]);
  } else if(role === 'analyst'){
    title = 'Analyst Desk';
    msg = 'Verified analyst workspace for review, votes, reports, and reputation.';
    sideLabel = 'Wallet';
    sideValue = workspaceShort(ctx.wallet);
    cards = workspaceCards([
      ['Review Queue','Items awaiting weighted analyst consensus.',"showView('analysts')"],
      ['My Votes','Signed review activity in the proof log.',"showView('prooflog')"],
      ['My Reports','Your wallet profile and reviewed work.',"showView('profile')"],
      ['Reputation','Analyst roster and reputation layer.',"showView('analysts')"]
    ]);
  } else if(role === 'maintainer'){
    title = 'Maintainer Console';
    msg = 'Maintainer workspace for publishing, moderation, analyst applications, and safety review.';
    sideLabel = ctx.wallet ? 'Maintainer wallet' : 'Session';
    sideValue = ctx.wallet ? workspaceShort(ctx.wallet) : 'Supabase auth active';
    cards = workspaceCards([
      ['Ready to Publish','Consensus-cleared items and final seals.',"showView('admin')"],
      ['Pending Reports','Reports awaiting maintainer review.',"showView('admin')"],
      ['Analyst Applications','Roster applications and verification.',"showView('admin')"],
      ['Safety Flags','Moderation and escalation review.',"showView('admin')"]
    ]);
  } else {
    actions = '<div class="osi-ws-actions"><button class="osi-ws-cta primary" type="button" onclick="toggleWallet().then(function(){if(typeof renderWorkspace===\'function\')renderWorkspace();})">Connect Wallet</button></div>';
  }

  var body = '<div class="osi-ws-body">' + workspaceIdentityCard() + cards + '</div>';
  host.innerHTML = '<div class="osi-ws-head">'
    + '<div><div class="osi-ws-kicker mono">'+escapeHtml(sideValue)+'</div><h1>'+escapeHtml(title)+'</h1><p class="osi-ws-msg">'+escapeHtml(msg)+'</p>'+actions+'</div>'
    + '<aside class="osi-ws-side" aria-label="Workspace context"><div class="l">'+escapeHtml(sideLabel)+'</div><div class="v">'+escapeHtml(sideValue)+'</div></aside>'
    + '</div>'
    + body;
}
// ===== Wallet profile: a personal console for the connected wallet =====
function walletButtonClick(){
  if(walletPubkey){ toggleWalletMenu(); }
  else { toggleWallet(); }
}

async function disconnectWallet(){
  var prov = getProvider();
  try{ if(prov && prov.disconnect) await prov.disconnect(); }catch(e){}
  walletPubkey = null;
  clearWalletCache();
  if(typeof closeWalletMenu==='function') closeWalletMenu();
  updateWalletUI();
  if(document.body && document.body.dataset && document.body.dataset.view==='admin' && typeof renderAdminAccess==='function') renderAdminAccess({clear:true});
  if(document.body && document.body.dataset && document.body.dataset.view==='profile') showView('registry');
  else if(document.body && document.body.dataset && document.body.dataset.view==='identity' && typeof renderIdentity==='function') await renderIdentity();
  if(typeof showToast==='function') showToast('Wallet disconnected.');
}

function pfHash(str){ let h=0; str=String(str); for(let i=0;i<str.length;i++){ h=(h<<5)-h+str.charCodeAt(i); h|=0; } return Math.abs(h); }
function pfIdenticon(addr, size){
  const h=pfHash(addr); const hue=h%360; const hue2=(Math.floor(h/7))%360; const n=5; const cell=size/n; const cells=[];
  for(let y=0;y<n;y++){ for(let x=0;x<3;x++){ if(((h>>(y*3+x))&1)===1){ cells.push([x,y]); if(x!==n-1-x) cells.push([n-1-x,y]); } } }
  const rects=cells.map(function(c){ return '<rect x="'+(c[0]*cell)+'" y="'+(c[1]*cell)+'" width="'+cell+'" height="'+cell+'"/>'; }).join('');
  return '<svg viewBox="0 0 '+size+' '+size+'" width="'+size+'" height="'+size+'" style="border-radius:5px;background:hsl('+hue2+',26%,12%)"><g fill="hsl('+hue+',70%,56%)">'+rects+'</g></svg>';
}
function pfStatus(id, pubIds){ return pubIds[id] ? '<span class="pf-badge pub">\u2713 Published</span>' : '<span class="pf-badge pend">\u23f3 Pending review</span>'; }
function pfDate(ts){ try{ return new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric'}); }catch(e){ return ''; } }
function pfTx(tx){ return tx ? ' \u00b7 <a class="pf-tx" href="https://solscan.io/tx/'+encodeURIComponent(tx)+'" target="_blank" rel="noopener">on-chain \u2197</a>' : ''; }

function pfGate(){
  return '<div class="pf-gate">'
    +'<div class="pf-gate-ic">\u25c6</div>'
    +'<div class="pf-gate-h">Your analyst console</div>'
    +'<p class="pf-gate-p">Connect your Phantom wallet to open your profile. Your wallet is your identity here: every report you file, every case you open, and every case you back is signed by it. This is the foundation of on-chain reputation (Phase 2).</p>'
    +'<button class="btn-fill" onclick="toggleWallet()">Connect Phantom \u2192</button>'
    +'</div>';
}
function pfReports(reports, pubIds){
  if(!reports.length) return '<div class="pf-empty">No reports filed yet. Apply to a case or submit research and it lands here.</div>';
  return reports.map(function(r){
    const title=escapeHtml(r.company||r.bounty||'Attribution report');
    const sum=escapeHtml(String(r.summary||'').slice(0,160));
    return '<div class="pf-item"><div class="pf-it-top"><div class="pf-it-t">'+title+'</div>'+pfStatus(r.id,pubIds)+'</div>'
      +'<div class="pf-it-s">'+sum+'</div>'
      +'<div class="pf-it-m mono">'+pfDate(parseInt(String(r.id).replace(/\D/g,''))||Date.now())+pfTx(r.tx)+'</div></div>';
  }).join('');
}
function pfBounties(bounties, pubIds){
  if(!bounties.length) return '<div class="pf-empty">No cases opened yet. Open a case on the board to file one.</div>';
  return bounties.map(function(b){
    const title=escapeHtml(b.target||b.title||'Bounty');
    const det=escapeHtml(String(b.detail||'').slice(0,150));
    return '<div class="pf-item"><div class="pf-it-top"><div class="pf-it-t">'+title+'</div>'+pfStatus(b.id,pubIds)+'</div>'
      +'<div class="pf-it-s">'+det+'</div></div>';
  }).join('');
}
function pfBoosts(boosted){
  const ids=Object.keys(boosted||{}); if(!ids.length) return '<div class="pf-empty">No cases backed yet. Back a case to signal it matters.</div>';
  return ids.map(function(bid){
    const v=boosted[bid]; let nm=(v&&v.name)?v.name:null;
    if(!nm){ const c=document.querySelector('.bounty[data-bid="'+bid+'"] .b-target'); nm=c?c.textContent.trim():bid; }
    const tx=(v&&v.tx)?v.tx:null;
    return '<div class="pf-item pf-mini"><div class="pf-it-t">\u2191 '+escapeHtml(nm)+'</div><div class="pf-it-m mono">boosted'+pfTx(tx)+'</div></div>';
  }).join('');
}
// ===== XP / reputation =====
const PF_RANKS = [
  { name:'Apprentice',         cls:'pf-l1', min:0 },
  { name:'Field Analyst',      cls:'pf-l2', min:60 },
  { name:'Detective',          cls:'pf-l3', min:180 },
  { name:'Chief Investigator', cls:'pf-l4', min:400 }
];
function pfApproved(reports, bounties, pubIds){
  let a=0; reports.forEach(function(x){ if(pubIds[x.id]) a++; }); bounties.forEach(function(x){ if(pubIds[x.id]) a++; }); return a;
}
function pfXP(reports, bounties, boosted, pubIds){
  const r=reports.length, b=bounties.length, bo=Object.keys(boosted||{}).length;
  return r*10 + b*15 + bo*4 + pfApproved(reports,bounties,pubIds)*30;
}
function pfRank(xp){
  let idx=0; for(let i=0;i<PF_RANKS.length;i++){ if(xp>=PF_RANKS[i].min) idx=i; }
  const cur=PF_RANKS[idx], next=PF_RANKS[idx+1]||null;
  const pct = next ? Math.max(4, Math.min(100, Math.round((xp-cur.min)/(next.min-cur.min)*100))) : 100;
  return { cur:cur, next:next, pct:pct };
}
function pfMonth(ts){ try{ return new Date(ts).toLocaleDateString('en-US',{month:'short',year:'numeric'}); }catch(e){ return 'recently'; } }

// name: live local + debounced sync to the wallet's profile row
let _pfNameT=null;
function pfSaveName(v){
  lsSet('stw_profile_name', v); pfLiveName(v);
  const av=document.getElementById('wbAva'); const wt=document.getElementById('wbText'); if(wt && walletPubkey) wt.textContent = v ? v : (walletPubkey.slice(0,4)+'\u2026'+walletPubkey.slice(-4));
  if(SUPA_ON && walletPubkey){ clearTimeout(_pfNameT); _pfNameT=setTimeout(function(){ supaUpsertProfile(walletPubkey, v).catch(function(){}); }, 800); }
}
async function supaUpsertProfile(addr, name){
  await fetch(SUPABASE_URL + '/rest/v1/profiles', {
    method:'POST', headers: supaHeaders({ Prefer:'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ wallet:addr, name:name, updated_at:new Date().toISOString() })
  });
}

function pfAnalystStatus(addr){
  if(isVerifiedAnalyst(addr)){
    return '<div class="pf-an verified"><span class="pf-an-ic">\u2605</span><div><div class="pf-an-t">Verified analyst</div><div class="pf-an-s">Founder-approved and on the public roster. Your tier rises automatically as your reports get approved and you win bounties.</div></div></div>';
  }
  if(lsGet('stw_applied_analyst', false)){
    return '<div class="pf-an pending"><span class="pf-an-ic">\u25d0</span><div><div class="pf-an-t">Application under review</div><div class="pf-an-s">The maintainer is reviewing your application. You can already file reports and apply to bounties in the meantime.</div></div></div>';
  }
  return '<div class="pf-an member"><span class="pf-an-ic">\u25c8</span><div><div class="pf-an-t">Contributor</div><div class="pf-an-s">Anyone can file reports and apply to bounties. Build a track record, then <a onclick="goCommunity(\'tab-analysts\')" style="color:var(--sol);cursor:pointer">apply to join the verified roster \u2192</a></div></div></div>';
}
function pfShell(addr, name, email, joined, reports, bounties, boosted, pubIds){
  const display = name ? escapeHtml(name) : short(addr);
  const xp = pfXP(reports, bounties, boosted, pubIds);
  const rk = pfRank(xp);
  const approved = pfApproved(reports, bounties, pubIds);
  const nBoost = Object.keys(boosted||{}).length;
  return ''
  +'<div class="pf-hero">'
    +'<button class="pf-dc" onclick="disconnectWallet()">\u23fb Disconnect</button>'
    +'<div class="pf-hero-top">'
      +'<div class="pf-ava" title="Change avatar" onclick="pfAvatarPick()" style="cursor:pointer">'+osiAvatarSvg(addr,72,(CV_CTX&&CV_CTX.data&&(CV_CTX.data.name||CV_CTX.data.handle))||'' ,osiAvatarUrl(addr,(CV_CTX&&CV_CTX.data)||null))+'<span class="pf-ava-edit mono">edit</span></div>'+'<input type="file" id="pf-ava-file" accept="image/*" style="display:none" onchange="pfAvatarChange(this)">'
      +'<div class="pf-id">'
        +'<div class="pf-name">'+display+' <span class="pf-clear '+rk.cur.cls+'">'+rk.cur.name+'</span></div>'
        +'<div class="pf-addr mono" title="Click to copy" onclick="pfCopy(\''+addr+'\')">'+escapeHtml(addr)+' <span class="pf-copy">copy</span></div>'
        +'<div class="pf-since mono">\u25c8 Member since '+pfMonth(joined)+'</div>'
      +'</div>'
    +'</div>'
    +pfAnalystStatus(addr)
    +'<div class="pf-xp">'
      +'<div class="pf-xp-top"><span class="pf-xp-n">'+xp+' <span class="pf-xp-u">XP</span></span>'
        +(rk.next ? ('<span class="pf-xp-next mono">'+(rk.next.min-xp)+' XP to '+rk.next.name+'</span>') : '<span class="pf-xp-next mono">top rank reached \u2605</span>')+'</div>'
      +'<div class="pf-xp-track"><div class="pf-xp-bar" style="width:'+rk.pct+'%"></div></div>'
    +'</div>'
  +'</div>'
  +'<div class="pf-stats">'
    +'<div class="pf-stat"><div class="n">'+reports.length+'</div><div class="l">Filings</div></div>'
    +'<div class="pf-stat"><div class="n" style="color:var(--sol)">'+approved+'</div><div class="l">Published</div></div>'
    +'<div class="pf-stat"><div class="n">'+bounties.length+'</div><div class="l">Bounties</div></div>'
    +'<div class="pf-stat"><div class="n">'+nBoost+'</div><div class="l">Backed</div></div>'
  +'</div>'
  +'<div class="pf-grid">'
    +'<div class="pf-col"><div class="pf-h">My filings <span class="pf-h-c">'+reports.length+'</span></div>'+pfReports(reports,pubIds)+'</div>'
    +'<div class="pf-col"><div class="pf-h">My bounties <span class="pf-h-c">'+bounties.length+'</span></div>'+pfBounties(bounties,pubIds)+'</div>'
    +'<div class="pf-col pf-col-wide"><div class="pf-h">My boosts <span class="pf-h-c">'+nBoost+'</span></div>'+pfBoosts(boosted)+'</div>'
  +'</div>'
  +'<div class="pf-cases"><div class="pf-h">My case records <span class="pf-h-c" id="pf-cases-n">0</span></div><div id="pf-cases-body"><div class="pf-empty mono">Loading</div></div></div>'
  +'<div class="pf-settings">'
    +'<div class="pf-h">Profile</div>'
    +'<div class="pf-set-grid">'
      +'<div class="pf-field"><label class="pf-lab">Display name</label>'
        +'<input class="pf-in" id="pf-name" value="'+(name?escapeHtml(name):'')+'" placeholder="e.g. aksusarya" oninput="pfSaveName(this.value)">'
        +'<div class="pf-hint mono">Shown instead of your address. Synced to your wallet.</div></div>'
      +'<div class="pf-field"><label class="pf-lab">Email <span class="pf-opt">optional</span></label>'
        +'<input class="pf-in" id="pf-email" type="email" value="'+(email?escapeHtml(email):'')+'" placeholder="you@example.com" oninput="lsSet(\'stw_profile_email\', this.value)">'
        +'<div class="pf-hint mono">Kept on this device, for your own record.</div></div>'
    +'</div>'
    +'<div class="pf-set-row"><span class="pf-hint mono">\u25c6 Signed in with Phantom \u00b7 '+short(addr)+'</span><button class="pf-dc sm" onclick="disconnectWallet()">\u23fb Disconnect wallet</button></div>'
  +'</div>';
}
function pfLiveName(v){ const el=document.querySelector('.pf-name'); if(el && el.firstChild){ el.firstChild.textContent=(v || (walletPubkey?short(walletPubkey):'')) + ' '; } }
function pfCopy(a){ try{ navigator.clipboard.writeText(a); showToast('Address copied.'); }catch(e){} }

async function renderProfile(){
  const host=document.getElementById('profile-body'); if(!host) return;
  if(!walletPubkey){ host.innerHTML=pfGate(); return; }
  const addr=walletPubkey;
  let joined=lsGet('stw_joined',''); if(!joined){ joined=new Date().toISOString(); lsSet('stw_joined',joined); }
  const reports=lsGet('stw_reports',[]);
  const bounties=lsGet('stw_bounties',[]);
  const boosted=lsGet('stw_boosted',{});
  let name=lsGet('stw_profile_name','');
  const email=lsGet('stw_profile_email','');
  host.innerHTML=pfShell(addr,name,email,joined,reports,bounties,boosted,{});
  if(typeof pfRenderCases==='function') pfRenderCases(addr);
  if(SUPA_ON){
    try{
      const pr=await supaGet('reports?select=id&wallet=eq.'+encodeURIComponent(addr)+'&approved=eq.true');
      const pb=await supaGet('bounties?select=id&created_by=eq.'+encodeURIComponent(addr)+'&approved=eq.true');
      const pubIds={}; (pr||[]).forEach(function(x){ pubIds[x.id]=1; }); (pb||[]).forEach(function(x){ pubIds[x.id]=1; });
      try{ const prof=await supaGet('profiles?select=name&wallet=eq.'+encodeURIComponent(addr)); if(prof&&prof[0]&&prof[0].name){ name=prof[0].name; lsSet('stw_profile_name',name); if(typeof updateWalletUI==='function') updateWalletUI(); } }catch(_){}
      if(document.body.dataset.view==='profile' && walletPubkey===addr){ host.innerHTML=pfShell(addr,name,email,joined,reports,bounties,boosted,pubIds); if(typeof pfRenderCases==='function') pfRenderCases(addr); }
    }catch(e){}
  }
}


// ===== Solana voluntary support: a real, CONFIRMED SOL transfer, wallet-to-wallet =====
// Non-custodial. OSI never holds, escrows, or routes the funds. Support is
// voluntary and does NOT influence review, ranking, consensus, publication, or
// sealing. Only an explicitly configured (OSI support wallet) or maintainer-
// attested (bounty winner) recipient is ever used; a reported/target wallet is
// never a recipient. Demo behaviour requires window.OSI_DEMO_MODE === true.
var SOL_UI_MAX = 100;                                  // reasonable per-transfer UI maximum (SOL)
var tipCtx = { wallet:null, amount:0.1, label:'', kind:'', item_type:null, item_id:null };
var tipFlow = { sending:false, stage:'idle' };         // idle | confirm | awaiting | confirming

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
  const signed = await prov.signAndSendTransaction(tx);
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
  var m=document.getElementById('tip-modal'); if(m) m.classList.add('open');
}
function closeTip(){ var m=document.getElementById('tip-modal'); if(m) m.classList.remove('open'); tipFlow={sending:false,stage:'idle'}; }
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
  const _bts = Math.floor(Date.now()/1000);
  const memo = "OSI_CASE_BACKED|case_id=" + (bid||"") + "|subject=" + String(bountyTargetText(card)).replace(/\|/g,"/") + "|backer=" + (walletPubkey||"") + "|ts=" + _bts;
  withOnchainVote("Boost", memo, async (sig)=>{
    const numEl = card.querySelector('.b-reward .n');
    if(numEl){ numEl.textContent = (parseInt(numEl.textContent) || 0) + 1; }
    if(bid){ const mine = lsGet('stw_boosted', {}); mine[bid] = { name: bountyTargetText(card), tx: sig, ts: Date.now() }; lsSet('stw_boosted', mine); }
    markBoostedUI(card, sig);
    recordOnchainEvent({ event_type:'demand_signal', item_type:'bounty', item_id:bid, label:'pledged demand for '+bountyTargetText(card), memo_text:memo, tx_sig:sig });
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
      const c = Math.max(counts[card.dataset.bid] || 0, mine[card.dataset.bid] ? 1 : 0);
      n.textContent = c; counts[card.dataset.bid] = c;
    });
    window.boostCounts = counts;
    if(typeof fieldUpdateDemand==='function') fieldUpdateDemand();
  }catch(e){ console.warn('OSI: boost counts unavailable, showing local view.', e); }
}

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


// ============================================================
// AI Escalation Pack Builder (maintainer-only pilot)
// Calls our Supabase Edge Function (never the AI directly).
// ============================================================
var escCaseEvidence = {};
var escLastFilename = 'OSI_escalation_pack.txt';

function escStatus(msg, cls){
  var el = document.getElementById('esc-status');
  if(!el) return;
  el.textContent = msg;
  el.className = 'esc-status' + (cls ? ' ' + cls : '');
}
function escSetOutput(text){
  var wrap = document.getElementById('esc-out-wrap');
  var out = document.getElementById('esc-out');
  if(out) out.value = text || '';
  if(wrap) wrap.style.display = text ? 'block' : 'none';
}
async function escLoadCases(){
  var sel = document.getElementById('esc-case');
  if(!sel) return;
  if(!resolveMaintainerAccess().allowed){ escStatus(maintainerAccessMessage(resolveMaintainerAccess()), 'warn'); return; }
  if(typeof SUPA_ON === 'undefined' || !SUPA_ON){ escStatus('Supabase is not configured.', 'warn'); return; }
  escStatus('Loading reviewed cases\u2026', 'busy');
  try{
    var rows = await supaGet('reports?approved=eq.true&select=id,company,summary,onchain,offchain,tx,wallet&order=id.desc&limit=200');
    escCaseEvidence = {};
    sel.innerHTML = '<option value="">Select a reviewed case\u2026</option>';
    (rows || []).forEach(function(r){
      escCaseEvidence[r.id] = { subject:r.company||'', summary:r.summary||'', onchain:r.onchain||'', offchain:r.offchain||'', tx:r.tx||'', wallet:r.wallet||'' };
      var o = document.createElement('option');
      o.value = r.id;
      var label = (r.company || r.summary || r.id || 'case');
      o.textContent = String(label).slice(0, 70);
      sel.appendChild(o);
    });
    escStatus((rows && rows.length) ? (rows.length + ' reviewed case(s) loaded.') : 'No reviewed cases yet.', (rows && rows.length) ? 'ok' : 'warn');
  }catch(e){
    escStatus('Could not load cases. Are you signed in as a maintainer?', 'warn');
  }
}
// ============================================================
// Stage 3: secure AI Pack access helpers
//  - proof: wallet signature, purpose "OSI AI Pack Access v1" (cached 90s)
//  - public_meta: metadata-only list for Public Records (never content)
//  - get/download: full pack content ONLY for a maintainer (JWT) or a
//    server-verified analyst, via the osi-ai-pack Edge Function. Anon and
//    ordinary connected wallets get metadata only (RLS no longer exposes it).
// ============================================================
async function osiAiPackProof(){
  if(window.__osiAiPackProof && window.__osiAiPackProof.proof && window.__osiAiPackProof.proof.wallet===walletPubkey && (Date.now()-window.__osiAiPackProof.at < 90000)){
    return window.__osiAiPackProof.proof;
  }
  var prov = (typeof getConnectedProvider==='function') ? getConnectedProvider() : (typeof getProvider==='function'?getProvider():null);
  if(!walletPubkey || !prov){
    if(typeof toggleWallet==='function'){ try{ await toggleWallet(); }catch(e){} }
    prov = (typeof getConnectedProvider==='function') ? getConnectedProvider() : (typeof getProvider==='function'?getProvider():null);
  }
  if(!walletPubkey || !prov){ var e0=new Error('no_wallet'); e0.status=401; throw e0; }
  if(typeof prov.signMessage !== 'function'){ var e1=new Error('This wallet cannot sign messages.'); e1.status=400; throw e1; }
  var msg = 'OSI AI Pack Access v1\nwallet: '+walletPubkey+'\nissued: '+Date.now()+'\nnonce: '+(Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2));
  var res = await prov.signMessage(new TextEncoder().encode(msg), 'utf8');
  var sigBytes = (res && res.signature) ? res.signature : res;
  var proof = { wallet: walletPubkey, message: msg, signature: osiB64(sigBytes) };
  window.__osiAiPackProof = { at: Date.now(), proof: proof };
  return proof;
}
// Metadata only (case_ref, pack_type, status). Safe for the public "reviewed
// pack" indicator; carries no pack content.
async function osiAiPackPublicMeta(){
  var url = SUPABASE_URL + '/functions/v1/osi-ai-pack';
  var headers = { 'Content-Type':'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization':'Bearer '+SUPABASE_ANON_KEY };
  var res = await fetch(url, { method:'POST', headers: headers, body: JSON.stringify({ mode:'public_meta' }) });
  if(!res.ok){ var er=new Error('meta_'+res.status); er.status=res.status; throw er; }
  var data = await res.json();
  return (data && data.packs) ? data.packs : [];
}
// Full pack content for AUTHORIZED callers only. Maintainers authenticate with
// their Supabase session JWT; everyone else signs a wallet proof (the server
// admits ONLY a verified analyst — a wallet merely appearing on a report does
// not qualify). Returns the JSON body or throws an Error whose .status carries
// the HTTP code.
async function osiAiPackGet(caseRef, packType){
  var url = SUPABASE_URL + '/functions/v1/osi-ai-pack';
  var maint = (typeof resolveMaintainerAccess==='function') ? resolveMaintainerAccess().allowed : false;
  var headers = { 'Content-Type':'application/json', 'apikey': SUPABASE_ANON_KEY };
  var payload = { mode:'get', case_ref: caseRef };
  if(packType) payload.pack_type = packType;
  if(maint && SUPA_AUTH_TOKEN){
    headers['Authorization'] = 'Bearer ' + SUPA_AUTH_TOKEN;
  } else {
    headers['Authorization'] = 'Bearer ' + SUPABASE_ANON_KEY;
    var proof = await osiAiPackProof();
    payload.wallet = proof.wallet; payload.message = proof.message; payload.signature = proof.signature;
  }
  var res = await fetch(url, { method:'POST', headers: headers, body: JSON.stringify(payload) });
  if(!res.ok){ var er=new Error('pack_'+res.status); er.status=res.status; throw er; }
  return await res.json();
}
// Download flow for Public Records + profile. Content is fetched on demand and
// never cached in the DOM; unauthorized callers get a friendly message.
async function osiAiPackDownload(caseRef, packType){
  try{
    var data = await osiAiPackGet(caseRef, packType);
    if(!data || !data.ok || !data.content){ if(typeof showToast==='function') showToast('This pack is not available.'); return; }
    var blob = new Blob([data.content], { type:'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = 'OSI_' + (packType||'pack') + '_' + caseRef + '.txt';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }catch(e){
    var st = e && e.status;
    var msg = (st===403 || st===401) ? 'Available to verified analysts and maintainers.'
      : (st===404) ? 'No reviewed pack is available for this case.'
      : 'Could not retrieve the pack right now.';
    if(typeof showToast==='function') showToast(msg); else if(typeof alert==='function') alert(msg);
  }
}
async function escGenerate(){
  if(!requireMaintainerAccess('Generate escalation pack')){ escStatus(maintainerAccessMessage(resolveMaintainerAccess()), 'warn'); return; }
  var sel = document.getElementById('esc-case');
  var caseRef = sel ? sel.value : '';
  var typeEl = document.querySelector('input[name="esc-type"]:checked');
  var pt = typeEl ? typeEl.value : '';
  if(!caseRef){ escStatus('Pick a reviewed case (Load, then select).', 'warn'); return; }
  if(!pt){ escStatus('Choose a pack type.', 'warn'); return; }
  var btn = document.querySelector('.esc-go');
  if(btn) btn.disabled = true;
  escStatus('Generating with Claude, this can take 10-30s\u2026', 'busy');
  escSetOutput('');
  try{
    // Evidence is fetched server-side from the reviewed case; the client never
    // supplies or trusts pack evidence. Maintainers authenticate with the
    // Supabase session JWT.
    var res = await fetch(SUPABASE_URL + '/functions/v1/osi-ai-pack', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'apikey':SUPABASE_ANON_KEY, 'Authorization':'Bearer ' + SUPA_AUTH_TOKEN },
      body: JSON.stringify({ mode:'generate', case_ref:caseRef, pack_type:pt })
    });
    if(res.status === 404){ escStatus('Backend not deployed yet. Deploy the Edge Function (see setup notes).', 'warn'); if(btn) btn.disabled=false; return; }
    if(res.status === 401 || res.status === 403){ escStatus('Not authorized. Sign in as a maintainer and retry.', 'warn'); if(btn) btn.disabled=false; return; }
    if(res.status === 429){ escStatus('Generation rate limit reached. Try again shortly.', 'warn'); if(btn) btn.disabled=false; return; }
    var data = null; try{ data = await res.json(); }catch(_e){}
    if(!res.ok || !data || !data.ok){
      var emsg = (data && data.error === 'not_reviewed') ? 'This case is not reviewed/approved yet.'
        : (data && data.error === 'refused') ? 'The model declined to produce this pack.'
        : (data && data.error) ? String(data.error) : ('Generation failed (' + res.status + ').');
      escStatus(emsg, 'warn'); if(btn) btn.disabled=false; return;
    }
    escSetOutput(data.content || '');
    var badge = document.getElementById('esc-badge');
    if(badge) badge.textContent = ((data.status || 'review_required') === 'review_required') ? 'ai_generated \u00b7 review_required' : ('ai_generated \u00b7 ' + data.status);
    escStatus('Done. Review required before use.', 'ok');
    escLastFilename = 'OSI_' + pt + '_' + (caseRef || 'case') + '.txt';
    if(typeof escRenderPackControls==='function') escRenderPackControls({ id: data.id, status: data.status || 'review_required', pack_type: pt });
  }catch(e){
    escStatus('Could not reach the backend. Is the Edge Function deployed?', 'warn');
  }
  if(btn) btn.disabled = false;
}
function escCopy(){
  var out = document.getElementById('esc-out'); if(!out || !out.value) return;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(out.value).then(function(){ escStatus('Copied to clipboard.', 'ok'); }, function(){ out.select(); });
  } else { out.select(); try{ document.execCommand('copy'); escStatus('Copied.', 'ok'); }catch(_e){} }
}
function escDownload(){
  var out = document.getElementById('esc-out'); if(!out || !out.value) return;
  var blob = new Blob([out.value], { type:'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = escLastFilename || 'OSI_escalation_pack.txt';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}


// ============================================================
// AI packs as persistent CASE ARTIFACTS
//  - load saved packs for a case (fixes "disappears on refresh")
//  - maintainer: mark a pack reviewed (publish) and seal a case
//  - Public Case Records archive + profile "My case records"
// ============================================================
var escCurrentPacks = [];

function escPackLabel(t){ return t==='victim' ? 'Victim brief' : (t==='exchange' ? 'Exchange pack' : (t==='law_enforcement' ? 'Law-enforcement brief' : String(t||'Pack'))); }
function escStatusLabel(s){ return s==='approved' ? 'reviewed' : (s==='discarded' ? 'discarded' : 'review required'); }

// Load any saved packs for a case and show the most recent one.
async function escLoadPacksForCase(caseRef){
  escCurrentPacks = [];
  var host = document.getElementById('esc-pack-controls'); if(host) host.innerHTML='';
  if(!caseRef){ return; }
  if(!resolveMaintainerAccess().allowed){ escSetOutput(''); escStatus(maintainerAccessMessage(resolveMaintainerAccess()), 'warn'); return; }
  if(typeof SUPA_ON === 'undefined' || !SUPA_ON){ return; }
  try{
    var rows = await supaGet('escalation_packs?case_ref=eq.' + encodeURIComponent(caseRef) + '&select=id,pack_type,content,status,created_at&order=created_at.desc');
    escCurrentPacks = rows || [];
    if(escCurrentPacks.length){
      var p = escCurrentPacks[0];
      escSetOutput(p.content || '');
      var badge = document.getElementById('esc-badge'); if(badge) badge.textContent = 'ai_generated \u00b7 ' + escStatusLabel(p.status);
      escRenderPackControls(p);
      escStatus('Loaded a saved ' + escPackLabel(p.pack_type) + ' (' + escStatusLabel(p.status) + ').', 'ok');
    } else {
      escStatus('No saved pack for this case yet.', '');
    }
  }catch(e){ /* anon only sees approved; maintainer sees all */ }
}

// Maintainer-only controls shown under a pack: mark reviewed (publish) / seal case.
function escRenderPackControls(p){
  var host = document.getElementById('esc-pack-controls'); if(!host) return;
  if(!p || !resolveMaintainerAccess().allowed){ host.innerHTML=''; return; }
  var approved = (p.status === 'approved');
  host.innerHTML =
    (approved
      ? '<span class="esc-okline">\u2713 Reviewed \u00b7 eligible for Public Case Records</span>'
      : '<button class="esc-mini ok" type="button" onclick="escApprovePack(\'' + p.id + '\')">Mark reviewed (publish pack)</button>')
    + '<button class="esc-mini" type="button" onclick="escSealCase()">Seal this case</button>';
}

async function escApprovePack(packId){
  if(!requireMaintainerAccess('Approve escalation pack')){ escStatus(maintainerAccessMessage(resolveMaintainerAccess()), 'warn'); return; }
  var _packCaseRef = (typeof escCurrentPacks!=='undefined' && escCurrentPacks) ? ((escCurrentPacks.find(function(p){ return String(p.id)===String(packId); })||{}).case_ref||'') : '';
  osiSignEvent({ eventType:'ESCALATION_PACK_APPROVED', actionLabel:'Approve escalation pack', reportId:_packCaseRef, itemType:'report', itemId: packId, sensitive:true, onSuccess: async (sig)=>{
  try{
    await supaPatch('escalation_packs?id=eq.' + encodeURIComponent(packId), { status:'approved' });
    escStatus('Pack marked reviewed. It can now appear in Public Case Records.', 'ok');
    var sel = document.getElementById('esc-case'); if(sel) await escLoadPacksForCase(sel.value);
    if(typeof renderCaseRecords === 'function') renderCaseRecords();
  }catch(e){ escStatus('Could not update the pack. Check you are signed in as a maintainer.', 'warn'); }
  }});
}

async function escSealCase(){
  if(!requireMaintainerAccess('Seal case')){ escStatus(maintainerAccessMessage(resolveMaintainerAccess()), 'warn'); return; }
  var sel = document.getElementById('esc-case'); var caseRef = sel ? sel.value : '';
  if(!caseRef){ escStatus('Pick a case first.', 'warn'); return; }
  osiSignEvent({ eventType:'RECORD_SEALED', actionLabel:'Seal case', reportId: caseRef, itemType:'report', itemId: caseRef, publicLabel:'Record sealed', onSuccess: async (sig)=>{
  try{
    await supaPatch('reports?id=eq.' + encodeURIComponent(caseRef), { sealed:true });
    escStatus('Case sealed. It now shows as Sealed in Public Case Records.', 'ok');
    if(typeof renderCaseRecords === 'function') renderCaseRecords();
  }catch(e){ escStatus('Could not seal the case. Check you are signed in as a maintainer.', 'warn'); }
  }});
}

// ---- Public Case Records (premium intelligence archive + drawer) ----
window.__crRecords = {};
window.__crPacks = {};

function crAttr(s){ return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
function osiCaseId(id){ var s=String(id==null?'':id).replace(/[^a-zA-Z0-9]/g,'').toUpperCase(); return 'OSI-' + (s ? s.slice(0,6) : '000000'); }
function crCountTokens(v){ if(!v) return 0; return String(v).split(/[\s,;\n]+/).filter(function(x){ return x && x.length>3; }).length; }
function crStatus(r){
  if(r && r.sealed) return { txt:'Sealed', cls:'cr-sealed' };
  if(r && r.approved !== false) return { txt:'Reviewed', cls:'cr-reviewed' };
  return { txt:'Under review', cls:'cr-pending' };
}
function crDate(v){ return v ? new Date(v).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : ''; }
function crTxSig(r){
  var raw = String((r && r.tx) || '').trim();
  if(!raw) return '';
  return (raw.split(/[\s,;\n]+/).filter(function(x){ return x && x.length > 6; })[0] || '');
}
function crHasMemo(r){ return !!crTxSig(r); }
function crChallengeCount(id){ return (window.__crChallengeCounts || {})[String(id)] || 0; }

var crState = { filter:'all', q:'', sort:'newest', page:1 };
var CR_PER = 6;
function crEvidenceCount(r){ return crCountTokens(r.tx) + crCountTokens(r.onchain) + crCountTokens(r.offchain); }
function crAnalystReviews(r){
  if(window.__crVouchesLoaded !== true || typeof vouchTally !== 'function') return null;
  var t = vouchTally('report', String(r.id));
  return (t.approve||[]).length + (t.reject||[]).length;
}
async function renderCaseRecords(){
  var host = document.getElementById('case-records'); if(!host) return;
  if(typeof SUPA_ON === 'undefined' || !SUPA_ON){
    window.__crList = []; window.__crRecords = {}; window.__crPacks = {};
    window.__crChallenged = {}; window.__crChallengeCounts = {}; window.__crOpenChallengeCount = 0;
    window.__crSourceState = 'unavailable'; window.__crVouchesLoaded = false;
    crPaint(); return;
  }
  try{
    var reports = await supaGet('reports?select=id,company,summary,onchain,offchain,tx,wallet,sealed,approved,created_at,updated_at&approved=eq.true&order=created_at.desc&limit=48') || [];
    var packs = [];
    if(reports.length){
      // Metadata only (no content). Full pack content is never anon-readable;
      // downloads go through the secure osi-ai-pack "get" path.
      try{ packs = await osiAiPackPublicMeta() || []; }catch(_e){}
    }
    var byCase = {}; packs.forEach(function(p){ (byCase[p.case_ref] = byCase[p.case_ref] || []).push(p); });
    window.__crPacks = byCase;
    var recMap = {}; reports.forEach(function(r){ recMap[r.id] = r; });
    window.__crRecords = recMap; window.__crList = reports; window.__crSourceState = reports.length ? 'loaded' : 'empty';
    try{ await loadVouches(); window.__crVouchesLoaded = true; }catch(_e){ window.__crVouchesLoaded = false; }
    try{
      var ch = await supaGet('challenges?select=item_id&item_type=eq.report&status=eq.open') || [];
      var chSet = {}, chCounts = {};
      ch.forEach(function(c){
        var key = String(c.item_id);
        chSet[key] = 1;
        chCounts[key] = (chCounts[key] || 0) + 1;
      });
      window.__crChallenged = chSet; window.__crChallengeCounts = chCounts; window.__crOpenChallengeCount = ch.length;
    }catch(_e){ window.__crChallenged = {}; window.__crChallengeCounts = {}; window.__crOpenChallengeCount = 0; }
    crState.page = 1;
    crPaint();
  }catch(e){
    window.__crList = []; window.__crRecords = {}; window.__crPacks = {};
    window.__crChallenged = {}; window.__crChallengeCounts = {}; window.__crOpenChallengeCount = 0;
    window.__crSourceState = 'error'; window.__crVouchesLoaded = false;
    crPaint();
  }
}
function crFilter(f){
  crState.filter=f; crState.page=1;
  document.querySelectorAll('#cr-fils .rf-tab').forEach(function(b){ b.classList.toggle('active', b.dataset.f===f); });
  crPaint();
}
function crSearch(v){ crState.q=(v||'').trim().toLowerCase(); crState.page=1; crPaint(); }
function crSortChange(v){ crState.sort=v; crPaint(); }
function crPage(p){
  crState.page=p|0; crPaint();
  var h=document.getElementById('case-records'); if(h){ try{ h.scrollIntoView({behavior:'smooth',block:'start'}); }catch(e){} }
}
function crRenderStats(){
  var host=document.getElementById('cr-stats'); if(!host) return;
  var reports=window.__crList||[];
  var sourceOk = (window.__crSourceState === 'loaded' || window.__crSourceState === 'empty');
  var publicRecords = sourceOk ? reports.length : null;
  var reviewed = sourceOk ? reports.filter(function(r){ return r && r.approved === true; }).length : null;
  var memo = sourceOk ? reports.filter(crHasMemo).length : null;
  var openCh = sourceOk ? (window.__crOpenChallengeCount||0) : null;
  var val = function(v, cls){ return '<div class="fo-op-n'+(cls?(' '+cls):'')+'">'+(v==null ? 'Not available yet' : v)+'</div>'; };
  host.innerHTML =
      '<div class="fo-op"><div class="fo-op-ic">ARC</div>'+val(publicRecords, publicRecords==null?'cr-stat-na':'')+'<div class="fo-op-l">Public Records</div></div>'
    + '<div class="fo-op"><div class="fo-op-ic sol">REV</div>'+val(reviewed, reviewed==null?'cr-stat-na':'sol')+'<div class="fo-op-l">Reviewed Reports</div></div>'
    + '<div class="fo-op"><div class="fo-op-ic">MEM</div>'+val(memo, memo==null?'cr-stat-na':'')+'<div class="fo-op-l">Memo-linked</div></div>'
    + '<div class="fo-op"><div class="fo-op-ic warn">CHL</div>'+val(openCh, openCh==null?'cr-stat-na':(openCh>0?'warn':''))+'<div class="fo-op-l">Open Challenges</div></div>'
    + '<div class="fo-op"><div class="fo-op-ic sol">SOL</div><div class="fo-op-n sol">Solana</div><div class="fo-op-l">Mainnet</div></div>';
}
function crPaint(){
  var host = document.getElementById('case-records'); if(!host) return;
  crRenderStats();
  var reports = (window.__crList || []).slice();
  var chSet = window.__crChallenged || {};
  var q = crState.q;
  if(q){
    reports = reports.filter(function(r){
      var hay=[r.company,r.summary,r.wallet,r.id,r.tx,r.onchain,osiCaseId(r.id)].map(function(x){ return String(x||'').toLowerCase(); }).join(' ');
      return hay.indexOf(q)!==-1;
    });
  }
  if(crState.filter==='sealed') reports = reports.filter(function(r){ return !!r.sealed; });
  else if(crState.filter==='reviewed') reports = reports.filter(function(r){ return !r.sealed; });
  else if(crState.filter==='memo') reports = reports.filter(crHasMemo);
  else if(crState.filter==='challenged') reports = reports.filter(function(r){ return !!chSet[String(r.id)]; });
  if(crState.sort==='reviewed') reports.sort(function(a,b){ return (crAnalystReviews(b)||-1)-(crAnalystReviews(a)||-1) || (new Date(b.created_at||0)-new Date(a.created_at||0)); });
  else if(crState.sort==='challenged') reports.sort(function(a,b){ return crChallengeCount(b.id)-crChallengeCount(a.id) || (new Date(b.created_at||0)-new Date(a.created_at||0)); });
  else if(crState.sort==='updated') reports.sort(function(a,b){ return new Date(b.updated_at||b.created_at||0)-new Date(a.updated_at||a.created_at||0); });
  else reports.sort(function(a,b){ return new Date(b.created_at||0)-new Date(a.created_at||0); });
  var totalPages=Math.max(1, Math.ceil(reports.length/CR_PER));
  if(crState.page>totalPages) crState.page=totalPages; if(crState.page<1) crState.page=1;
  var from=(crState.page-1)*CR_PER, page=reports.slice(from, from+CR_PER);
  var sourceState = window.__crSourceState || 'empty';
  var emptyHtml = (sourceState === 'error' || sourceState === 'unavailable')
    ? '<div class="cr-noyet"><div class="cr-noyet-ic">SRC</div><b>Public records source unavailable.</b><span>Unable to load reviewed records right now.</span></div>'
    : '<div class="cr-noyet"><div class="cr-noyet-ic">ARC</div><b>No public records have been sealed yet.</b><span>Reviewed OSI records will appear here after analyst review and publication.</span></div>';
  host.innerHTML = page.length
    ? page.map(function(r){ return crCard(r, (window.__crPacks||{})[r.id] || []); }).join('')
    : ((window.__crList||[]).length
        ? '<div class="fd-empty mono" style="grid-column:1/-1;padding:22px 4px">No public records match this search or filter.</div>'
        : emptyHtml);
  var cnt=document.getElementById('cr-count');
  if(cnt) cnt.textContent = reports.length ? ('Showing '+(from+1)+'-'+(from+page.length)+' of '+reports.length+' record'+(reports.length===1?'':'s')) : '';
  var pn=document.getElementById('cr-pnav');
  if(pn){
    if(totalPages<=1){ pn.innerHTML=''; }
    else{
      var ph='<button class="fo-pg" type="button" '+(crState.page<=1?'disabled':'')+' onclick="crPage('+(crState.page-1)+')" aria-label="Previous page">&lsaquo;</button>';
      for(var pi=1; pi<=totalPages; pi++){ ph+='<button class="fo-pg n'+(pi===crState.page?' active':'')+'" type="button" onclick="crPage('+pi+')">'+pi+'</button>'; }
      ph+='<button class="fo-pg" type="button" '+(crState.page>=totalPages?'disabled':'')+' onclick="crPage('+(crState.page+1)+')" aria-label="Next page">&rsaquo;</button>';
      pn.innerHTML=ph;
    }
  }
}
function crCopyFallback(text, done){
  try{
    var ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta); done();
  }catch(e){ showToast('Could not copy automatically \u00b7 tx: '+text); }
}
function crCopyTx(hash){
  if(!hash) return;
  var full=String(hash);
  var done=function(){ showToast('Transaction signature copied.'); };
  if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(full).then(done).catch(function(){ crCopyFallback(full, done); }); }
  else{ crCopyFallback(full, done); }
}

function openCaseRecord(id){
  var r = (window.__crRecords||{})[id]; if(!r) return;
  var packs = (window.__crPacks||{})[id] || [];
  var drawer = document.getElementById('cr-drawer'), body = document.getElementById('cr-drawer-body');
  if(!drawer || !body) return;
  body.innerHTML = crDrawerHtml(r, packs);
  drawer.classList.add('open'); drawer.setAttribute('aria-hidden','false');
  document.body.classList.add('cr-drawer-lock');
}
function closeCaseDrawer(){ var d=document.getElementById('cr-drawer'); if(d){ d.classList.remove('open'); d.setAttribute('aria-hidden','true'); } document.body.classList.remove('cr-drawer-lock'); }

function crShort(v){
  v = String(v || '');
  if(!v) return '';
  if(typeof short === 'function') return short(v);
  return v.length > 10 ? (v.slice(0,4) + '...' + v.slice(-4)) : v;
}
function crCard(r, packs){
  var st = crStatus(r);
  var cid = osiCaseId(r.id);
  var titleRaw = r.company || ('Case ' + String(r.id).slice(0,6));
  var title = escapeHtml(titleRaw);
  var date = crDate(r.created_at);
  var updated = r.updated_at ? crDate(r.updated_at) : '';
  var txSig = crTxSig(r);
  var evCount = crEvidenceCount(r);
  var revCount = crAnalystReviews(r);
  var challengeCount = crChallengeCount(r.id);
  var challenged = challengeCount > 0;
  var wallet = r.wallet ? escapeHtml(crShort(r.wallet)) : 'Wallet unavailable';
  var cls = 'cr-card' + (r.sealed ? ' sealed' : '') + (challenged ? ' challenged' : '');
  var copyBtn = txSig ? ('<button class="cr-copy" type="button" title="Copy transaction signature" onclick="event.stopPropagation();crCopyTx(&quot;'+crAttr(txSig)+'&quot;)">Copy</button>') : '';
  var verifyBtn = txSig ? ('<button class="cr-btn outline" type="button" onclick="event.stopPropagation();crVerify(&quot;'+crAttr(txSig)+'&quot;)">Verify on Solana</button>') : '';
  var evValue = evCount ? String(evCount) : '<span class="cr-meta-v na">Evidence not indexed</span>';
  var evSub = evCount ? ('Public reference' + (evCount===1?'':'s')) : 'No indexed evidence count';
  var revValue = revCount==null ? '<span class="cr-meta-v na">Review data unavailable</span>' : String(revCount);
  var revSub = revCount==null ? 'Analyst tally unavailable' : ('Analyst review' + (revCount===1?'':'s'));
  var chValue = challengeCount ? String(challengeCount) : '<span class="cr-meta-v na">No open challenges</span>';
  var chSub = challengeCount ? ('Open challenge' + (challengeCount===1?'':'s')) : 'Challenge status clear';
  return '<div class="'+cls+'" data-cid="'+crAttr(r.id)+'" role="button" tabindex="0" onclick="openCaseRecord(&quot;'+crAttr(r.id)+'&quot;)" onkeydown="if(event.key===&quot;Enter&quot;){openCaseRecord(&quot;'+crAttr(r.id)+'&quot;);}" aria-label="Open public record '+cid+'">'
    + '<div class="cr-card-main">'
      + '<span class="cr-record-id">'+cid+'</span>'
      + '<div class="cr-title">'+title+'</div>'
      + '<div class="cr-wallet mono">'+wallet+'</div>'
      + '<div class="cr-summary">'+escapeHtml(String(r.summary || 'No public summary provided.').slice(0,220))+'</div>'
      + '<div class="cr-date mono">'+(date ? ('Published '+date) : 'Published date unavailable')+(updated ? (' <span class="sep">|</span> Updated '+updated) : '')+'</div>'
    + '</div>'
    + '<div class="cr-card-meta">'
      + '<div class="cr-meta-cell"><div class="cr-meta-k">Status</div><div class="cr-meta-v"><span class="cr-status '+st.cls+'">'+st.txt+'</span></div><div class="cr-meta-sub">Approved public record</div></div>'
      + '<div class="cr-meta-cell"><div class="cr-meta-k">Evidence</div><div class="cr-meta-v">'+evValue+'</div><div class="cr-meta-sub">'+evSub+'</div></div>'
      + '<div class="cr-meta-cell"><div class="cr-meta-k">Reviews</div><div class="cr-meta-v">'+revValue+'</div><div class="cr-meta-sub">'+revSub+'</div></div>'
      + '<div class="cr-meta-cell"><div class="cr-meta-k">Challenges</div><div class="cr-meta-v '+(challengeCount?'warn':'')+'">'+chValue+'</div><div class="cr-meta-sub">'+chSub+'</div></div>'
    + '</div>'
    + '<div class="cr-card-proof">'
      + '<div><div class="cr-meta-k">Proof Log</div>' + (txSig
        ? '<div class="cr-proof-state ok">Memo-linked</div><div class="cr-meta-sub">Tx '+escapeHtml(String(txSig).slice(0,5)+'...'+String(txSig).slice(-5))+' '+copyBtn+'</div>'
        : '<div class="cr-proof-state mut">No linked proof event</div><div class="cr-meta-sub">No transaction link</div>') + '</div>'
      + '<div class="cr-actions"><button class="cr-btn primary" type="button" onclick="event.stopPropagation();openCaseRecord(&quot;'+crAttr(r.id)+'&quot;)">View Record</button>'+verifyBtn+'</div>'
      + '<div class="cr-actions secondary"><button class="cr-btn chx" type="button" onclick="event.stopPropagation();chxOpen(&quot;report&quot;,&quot;'+crAttr(r.id)+'&quot;,&quot;'+crAttr(cid)+'&quot;)">Challenge</button></div>'
    + '</div>'
  + '</div>';
}
function crVerify(hash){
  if(!hash) return;
  var url = (typeof solscanTx === 'function') ? solscanTx(hash) : ('https://solscan.io/tx/' + encodeURIComponent(hash));
  window.open(url, '_blank', 'noopener');
}
function crDrawerHtml(r, packs){
  var st = crStatus(r);
  var cid = osiCaseId(r.id);
  var title = escapeHtml(r.company || ('Case ' + String(r.id).slice(0,6)));
  var date = crDate(r.created_at);
  var updated = r.updated_at ? crDate(r.updated_at) : '';
  var txSig = crTxSig(r);
  var solUrl = txSig ? ((typeof solscanTx === 'function') ? solscanTx(txSig) : ('https://solscan.io/tx/' + encodeURIComponent(txSig))) : '';
  var verifyRow = txSig
    ? '<div class="crd-verify"><span class="crd-vk">Memo-linked proof</span><a class="crd-vlink" href="' + escapeHtml(solUrl) + '" target="_blank" rel="noopener">' + escapeHtml(String(txSig).slice(0,16)) + '... View on Solana</a></div>'
    : '<div class="crd-verify"><span class="crd-vk">No linked proof event</span><span class="mono" style="color:var(--ink-faint);font-size:11px">No transaction link</span></div>';
  var packRows = packs.length
    ? packs.map(function(p,i){ return '<div class="crd-pack"><div><div class="crd-pack-t">' + escapeHtml(escPackLabel(p.pack_type)) + '</div><div class="crd-pack-d">Approved public escalation pack</div></div><button class="crd-dl" type="button" onclick="crDownloadPack(&quot;' + crAttr(r.id) + '&quot;,' + i + ')">Download</button></div>'; }).join('')
    : '<div class="crd-empty">No reviewed packs published for this record yet.</div>';
  var evCount = crEvidenceCount(r);
  var revCount = crAnalystReviews(r);
  var challengeCount = crChallengeCount(r.id);
  var ev = evCount ? (evCount + ' public evidence reference' + (evCount===1?'':'s') + ' indexed from record fields.') : 'Evidence not indexed.';
  var rev = revCount==null ? 'Review data unavailable.' : (revCount + ' analyst review' + (revCount===1?'':'s') + ' indexed.');
  var ch = challengeCount ? (challengeCount + ' open challenge' + (challengeCount===1?'':'s') + '.') : 'No open challenges.';
  return ''
    + '<div class="crd-head"><span class="cr-cid mono">' + cid + '</span><span class="cr-status ' + st.cls + '">' + st.txt + '</span></div>'
    + '<h3 class="crd-title">' + title + '</h3>'
    + '<div class="crd-meta mono">' + (date ? ('Published ' + date) : 'Published date unavailable') + (updated ? (' | Updated ' + updated) : '') + '</div>'
    + '<div class="crd-block"><div class="crd-h">VERIFICATION</div>' + verifyRow + '</div>'
    + '<div class="crd-block"><div class="crd-h">SUMMARY</div><p class="crd-sum">' + escapeHtml(r.summary || 'No public summary provided.') + '</p></div>'
    + '<div class="crd-block"><div class="crd-h">EVIDENCE</div><div class="crd-ev">' + escapeHtml(ev) + '</div></div>'
    + '<div class="crd-block"><div class="crd-h">ANALYST REVIEW</div><div class="crd-rev"><span class="crd-rev-dot"></span>' + escapeHtml(rev) + '</div></div>'
    + '<div class="crd-block"><div class="crd-h">CHALLENGE STATUS</div><div class="crd-ev">' + escapeHtml(ch) + '</div></div>'
    + '<div class="crd-block"><div class="crd-h">ESCALATION PACKS <span class="crd-h-sub">Approved records only</span></div>' + packRows + '</div>'
    + '<div class="crd-actions">'
      + (txSig ? '<a class="crd-act primary" href="' + escapeHtml(solUrl) + '" target="_blank" rel="noopener">Verify on Solana</a>' : '')
      + '<button class="crd-act" type="button" onclick="crCopySummary(&quot;' + crAttr(r.id) + '&quot;)">Copy summary</button>'
    + '</div>'
    + '<div class="crd-disc">OSI records are informational only. No legal certainty, no recovery promise, and no custody of funds or private keys.</div>';
}
function crCopySummary(id){
  var r = (window.__crRecords||{})[id]; if(!r) return; var t = r.summary || '';
  if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(t).then(function(){ if(typeof showToast==='function') showToast('Summary copied.'); }); }
}
function crDownloadPack(caseRef, idx){
  var packs = (window.__crPacks||{})[caseRef] || []; var p = packs[idx]; if(!p) return;
  // Content is not held client-side; fetch it securely on demand (authorized only).
  osiAiPackDownload(caseRef, p.pack_type);
}

// ---- Profile: "My case records" (the wallet owner's cases + reviewed packs) ----
async function pfRenderCases(addr){
  var host = document.getElementById('pf-cases-body'); if(!host) return;
  if(typeof SUPA_ON === 'undefined' || !SUPA_ON){ host.innerHTML = '<div class="pf-empty mono">Connect Supabase to load your case records.</div>'; return; }
  try{
    var rows = await supaGet('reports?select=id,company,summary,tx,onchain,sealed,approved,created_at&wallet=eq.' + encodeURIComponent(addr) + '&order=created_at.desc&limit=50') || [];
    var nEl = document.getElementById('pf-cases-n'); if(nEl) nEl.textContent = rows.length;
    if(!rows.length){ host.innerHTML = '<div class="pf-empty mono">No cases yet. Open a case to start your public record.</div>'; return; }
    // Metadata only (no content). Downloads go through the secure osi-ai-pack path.
    var packs = []; try{ packs = await osiAiPackPublicMeta() || []; }catch(_e){}
    var byCase = {}; packs.forEach(function(p){ (byCase[p.case_ref] = byCase[p.case_ref] || []).push(p); }); window.__pfPacks = byCase;
    host.innerHTML = rows.map(function(r){
      var st = r.sealed ? 'Sealed' : (r.approved ? 'Reviewed' : 'Under review');
      var stc = r.sealed ? 'cr-sealed' : (r.approved ? 'cr-reviewed' : 'cr-pending');
      var ps = byCase[r.id] || [];
      var chips = ps.length
        ? '<div class="cr-packs">' + ps.map(function(p,i){ return '<button class="cr-pack" type="button" onclick="pfDownloadPack(\'' + r.id + '\',' + i + ')">\u2193 ' + escapeHtml(escPackLabel(p.pack_type)) + '</button>'; }).join('') + '</div>'
        : '';
      return '<div class="pf-case"><div class="pf-case-top"><span class="cr-status ' + stc + '">' + st + '</span></div>'
        + '<div class="pf-case-t">' + escapeHtml(r.company || ('Case ' + String(r.id).slice(0,6))) + '</div>'
        + '<div class="pf-case-s">' + escapeHtml(String(r.summary || '').slice(0,120)) + '</div>' + chips + '</div>';
    }).join('');
  }catch(e){ host.innerHTML = '<div class="pf-empty mono">Could not load your case records.</div>'; }
}
function pfDownloadPack(caseRef, idx){
  var packs = (window.__pfPacks || {})[caseRef] || []; var p = packs[idx]; if(!p) return;
  // Authorized fetch via the secure osi-ai-pack "get" path (verified analyst or
  // maintainer only; a wallet appearing on the report is not sufficient).
  osiAiPackDownload(caseRef, p.pack_type);
}

