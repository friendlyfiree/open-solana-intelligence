

// ---- Maintainer moderation console (open with the lock icon, or the #admin URL) ----
function admEsc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function maintainerShortWallet(addr){
  addr = String(addr || '');
  return addr.length > 10 ? addr.slice(0,4) + '...' + addr.slice(-4) : addr;
}
var OSI_MAINTAINER_SERVER_GATE = false;
var OSI_MAINTAINER_GATE_REASON = 'checking';
var OSI_MAINTAINER_GATE_REQUEST = null;

function setMaintainerServerGate(allowed,reason){
  OSI_MAINTAINER_SERVER_GATE = allowed === true;
  OSI_MAINTAINER_GATE_REASON = reason || (allowed ? 'full' : 'denied');
  updateMaintainerAccessUI();
}

function updateMaintainerAccessUI(){
  var badge=document.getElementById('maintainerAccessBadge');
  var ctx=resolveMaintainerAccess();
  if(badge){
    badge.textContent=ctx.allowed?'unlocked':(ctx.passwordAuthenticated?'1 of 2':'2 gates');
    badge.classList.toggle('ready',ctx.allowed);
  }
  if(document.body && document.body.dataset.view==='admin'){
    try{ renderAdminAccess(); }catch(_){ }
  }
}

async function refreshMaintainerGate(){
  var ctx=resolveMaintainerAccess();
  if(!ctx.walletConnected){ setMaintainerServerGate(false,'no_wallet'); return false; }
  if(!ctx.isMaintainerWallet){ setMaintainerServerGate(false,'wrong_wallet'); return false; }
  if(!ctx.passwordAuthenticated){ setMaintainerServerGate(false,'login_required'); return false; }
  if(OSI_MAINTAINER_GATE_REQUEST) return OSI_MAINTAINER_GATE_REQUEST;
  OSI_MAINTAINER_GATE_REASON='checking'; updateMaintainerAccessUI();
  OSI_MAINTAINER_GATE_REQUEST=fetch(SUPABASE_URL+'/functions/v1/osi-v2-case-write',{
    method:'POST',
    headers:{'Content-Type':'application/json','apikey':SUPABASE_ANON_KEY,'Authorization':'Bearer '+SUPA_AUTH_TOKEN},
    body:JSON.stringify({op:'actor_capabilities',wallet:ctx.wallet})
  }).then(async function(response){
    var data={}; try{data=await response.json();}catch(_){ }
    var allowed=response.ok && data.ok===true && data.maintainer_access===true;
    setMaintainerServerGate(allowed,allowed?'full':(data.maintainer_gate||'auth_rejected'));
    return allowed;
  }).catch(function(){ setMaintainerServerGate(false,'unavailable'); return false; })
    .finally(function(){ OSI_MAINTAINER_GATE_REQUEST=null; });
  return OSI_MAINTAINER_GATE_REQUEST;
}

function resolveMaintainerAccess(){
  var wallet = walletPubkey || null;
  var walletConnected = !!wallet;
  var adminWallet = (typeof OSI_ADMIN_WALLET !== 'undefined' && OSI_ADMIN_WALLET) ? String(OSI_ADMIN_WALLET).trim() : '';
  var isMaintainerWallet = !!(walletConnected && adminWallet && String(wallet) === adminWallet);
  var passwordAuthenticated = !!(typeof SUPA_AUTH_TOKEN !== 'undefined' && SUPA_AUTH_TOKEN && typeof SUPA_AUTH_USER !== 'undefined' && SUPA_AUTH_USER);
  var state = 'no_wallet';
  if(walletConnected && !isMaintainerWallet) state = 'wrong_wallet';
  else if(isMaintainerWallet && !passwordAuthenticated) state = 'login_required';
  else if(isMaintainerWallet && passwordAuthenticated && OSI_MAINTAINER_SERVER_GATE) state = 'allowed';
  else if(isMaintainerWallet && passwordAuthenticated && OSI_MAINTAINER_GATE_REASON === 'checking') state = 'checking';
  else if(isMaintainerWallet && passwordAuthenticated) state = 'auth_rejected';
  return {
    walletConnected: walletConnected,
    wallet: wallet,
    isMaintainerWallet: isMaintainerWallet,
    passwordAuthenticated: passwordAuthenticated,
    allowed: state === 'allowed',
    state: state,
    serverGate: OSI_MAINTAINER_SERVER_GATE,
    serverGateReason: OSI_MAINTAINER_GATE_REASON
  };
}
function maintainerAccessMessage(ctx, actionName){
  ctx = ctx || (typeof resolveMaintainerAccess === 'function' ? resolveMaintainerAccess() : {});
  var prefix = actionName ? (String(actionName) + ': ') : '';
  if(ctx.state === 'no_wallet') return prefix + 'Connect maintainer wallet.';
  if(ctx.state === 'wrong_wallet') return prefix + 'Maintainer wallet required.';
  if(ctx.state === 'login_required') return prefix + 'Authority login required.';
  if(ctx.state === 'checking') return prefix + 'Authority identity is being verified.';
  if(ctx.state === 'auth_rejected') return prefix + 'The signed-in Supabase identity is not the configured maintainer.';
  return prefix + 'Maintainer access required.';
}
function admGateRows(ctx){
  var walletOk=ctx.isMaintainerWallet;
  var authOk=ctx.passwordAuthenticated;
  var full=ctx.allowed;
  return '<div class="adm-gates" aria-label="Maintainer access status">'
    +'<div class="adm-gate '+(walletOk?'ok':'')+'"><span>1</span><div><b>Admin wallet</b><small>'+(walletOk?'Connected and matched':(ctx.walletConnected?'Connected wallet is not authorized':'Connect the configured wallet'))+'</small></div></div>'
    +'<div class="adm-gate '+(authOk?'ok':'')+'"><span>2</span><div><b>Supabase maintainer sign-in</b><small>'+(full?'Identity verified by the server':(authOk?'Session restored, server verification required':'Sign in with the authority account'))+'</small></div></div>'
    +'</div>';
}
function admLockedHtml(ctx){
  var title = ctx.state === 'checking' ? 'Verifying both gates' : (ctx.state === 'auth_rejected' ? 'Authority identity denied' : (ctx.state === 'wrong_wallet' ? 'Access denied' : 'Maintainer Access Required'));
  var body = ctx.state === 'no_wallet'
    ? 'Both independent gates are required. Start by connecting the configured admin wallet.'
    : ctx.state === 'auth_rejected'
    ? 'The wallet matches, but the server did not accept this Supabase identity. Sign out and use the configured authority account.'
    : ctx.state === 'checking'
    ? 'OSI is asking the server to independently verify the wallet and current Supabase session.'
    : 'This wallet is not authorized for maintainer operations.';
  var note = ctx.wallet ? '<div class="adm-lock-note">Connected wallet<br><b>' + admEsc(maintainerShortWallet(ctx.wallet)) + '</b></div>' : '';
  var action = ctx.state === 'no_wallet'
    ? '<button class="adm-go" type="button" onclick="toggleWallet().then(function(){if(typeof renderAdminAccess===\'function\')renderAdminAccess({clear:true});})">Connect maintainer wallet</button>'
    : ctx.state === 'checking'
    ? '<button class="adm-go" type="button" disabled>Checking server</button>'
    : ctx.state === 'auth_rejected'
    ? '<button class="adm-out" type="button" onclick="admLogout()">Sign out</button><button class="adm-go" type="button" onclick="refreshMaintainerGate()">Retry</button>'
    : '<button class="adm-out" type="button" onclick="disconnectWallet()">Disconnect wallet</button>';
  return '<div class="adm-card locked"><div class="adm-access-tag">Double gate</div><h3>' + title + '</h3><p>' + body + '</p>' + admGateRows(ctx) + note + '<div class="adm-lock-actions">' + action + '</div></div>';
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
  var analystQueue = document.getElementById('osi-analyst-ops');
  if(analystQueue) analystQueue.innerHTML = '<div class="moc-loading">Unlock both maintainer gates to load exact application versions.</div>';
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
      var gateHost=document.getElementById('admGateStatus'); if(gateHost) gateHost.innerHTML=admGateRows(ctx);
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
function admOpen(){
  showView('admin');
  refreshMaintainerGate().then(function(){
    var access=renderAdminAccess();
    if(access.allowed && typeof osiAnalystLoadMaintainerQueue==='function') osiAnalystLoadMaintainerQueue();
  });
}
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
    await refreshMaintainerGate();
    if(!resolveMaintainerAccess().allowed){ msg.textContent=maintainerAccessMessage(resolveMaintainerAccess()); renderAdminAccess({clear:true}); return; }
    msg.textContent='';
    try{ localStorage.setItem('stw_maint_dev','1'); }catch(_){}
    if(typeof updateAdminButton==='function') updateAdminButton();
    renderAdminAccess({refresh:true});
    if(typeof osiAnalystLoadMaintainerQueue==='function') osiAnalystLoadMaintainerQueue();
  }catch(e){ msg.textContent='Sign-in failed: '+e.message; }
}
async function admLogout(){
  await supaSignOut();
  setMaintainerServerGate(false,'signed_out');
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
