
// ============================================================
//  Secure analyst/maintainer intake (Stage 2B)
//  Pending case/report intake is RLS-protected (Stage 2A). Verified analysts
//  prove wallet ownership with an off-chain signed message; the maintainer uses
//  the existing Supabase session. The Edge Function osi-analyst-intake verifies
//  server-side and returns pending rows. The client checks below are UI hints
//  only, never the security boundary.
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
// Gated / unauthorized states: reuse existing empty-state styling, no redesign.
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
      + '<div class="rvc-by mono">Submitted by '+escapeHtml(raShortW(it.creator))+' \u00b7 '+raTimeAgo(it.ts)+'</div>'
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
      + '<div class="rvd-by mono">Submitted by '+escapeHtml(raShortW(creator))+' \u00b7 '+raTimeAgo(row.created_at)+'</div>'
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
