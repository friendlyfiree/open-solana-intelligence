
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
    body:'The live workflow connects open Cases, signed actions, reviewed Reports, public records, analyst reputation, and Solana Mainnet proof.' },
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
  { view:'field', sel:'#field-stats', dur:11000,
    title:'Verified native SOL',
    body:'Reward and support transfers use an exact server-issued plan that Phantom signs in the browser. OSI marks payment only after trusted mainnet RPC verifies finality, payer, recipients, lamports, Memo, and transaction structure. OSI never holds funds.' },
  { view:'wire', box:'demoBoxWire', sel:'#wire-form', sel2:'#wire-cases', clickSel:'.wire-cta', dur:9000,
    title:'The Wire',
    body:'Found something unprompted? File it here: the subject, the trail, your confidence per address, the links. After review it joins the public record and the community can back it.' },
  { view:'analysts', sel:'#consensus-floor', sel2:'#lb-board', clickSel:'#consensus-floor .rvc-review', mockReview:true, dur:9500,
    title:'Peer review, live',
    body:'This is what an eligible analyst sees: exact-version publication, resolution, challenge, and seal work with server-derived weight. Count and weight gates both apply, and a maintainer cannot replace analyst quorum.' },
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
