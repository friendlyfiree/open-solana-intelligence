

// ---- Public Case Records (premium intelligence archive + drawer) ----
window.__crRecords = {};
window.__crPacks = {};

// Escapes a value for use inside a JS string that is itself inside a
// double-quoted HTML on* attribute (e.g. onclick="f(&quot;VALUE&quot;)" or
// onclick="f('VALUE')"). Must neutralise BOTH the JS-string delimiters (' and ")
// and the surrounding HTML attribute delimiter ("); a raw " would otherwise
// close the attribute and allow handler injection. Order: JS-escape backslash
// and both quotes, flatten newlines, then HTML-escape so the escaped " becomes
// \&quot; (safe in the attribute) and </>/& cannot start markup/entities.
function crAttr(s){
  return String(s==null?'':s)
    .replace(/\\/g,'\\\\')
    .replace(/'/g,"\\'")
    .replace(/"/g,'\\"')
    .replace(/\r?\n/g,' ')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
function osiCaseId(id){ var s=String(id==null?'':id).replace(/[^a-zA-Z0-9]/g,'').toUpperCase(); return 'OSI-' + (s ? s.slice(0,6) : '000000'); }
function crCountTokens(v){ if(!v) return 0; return String(v).split(/[\s,;\n]+/).filter(function(x){ return x && x.length>3; }).length; }
function crValidTxSig(sig){ return /^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(String(sig||'')); }
function crProofFields(r){
  if(!r||typeof r!=='object') return {};
  var proof=r.publication_proof||r.proof||r.receipt;
  return proof&&typeof proof==='object'?proof:r;
}
function crProofMetadata(r){
  var proof=crProofFields(r);
  var raw=proof.verification_metadata||{};
  if(typeof raw==='string'){ try{ raw=JSON.parse(raw); }catch(e){ raw={}; } }
  return raw&&typeof raw==='object'?raw:{};
}
function crProofState(r){
  var proof=crProofFields(r);
  if(proof.proof_source==='native_public_dto'){
    var publicLabel=String(proof.label||'').trim();
    var publicSig=crValidTxSig(proof.tx_sig)?String(proof.tx_sig):'';
    var publicPayment=proof.payment_proof&&typeof proof.payment_proof==='object'?proof.payment_proof:{};
    var paymentVerified=publicPayment.cluster==='mainnet-beta'
      && publicPayment.finality==='finalized'
      && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(publicPayment.payer_wallet||''))
      && Array.isArray(publicPayment.recipient_manifest)
      && publicPayment.recipient_manifest.length>0
      && /^[1-9][0-9]*$/.test(String(publicPayment.total_lamports||''));
    if(publicLabel==='SOL transfer verified on Solana'&&publicSig&&paymentVerified) return {key:'transfer',label:'SOL transfer verified on Solana',tx_sig:publicSig,verified:true};
    if(publicLabel==='Memo-anchored on Solana'&&publicSig) return {key:'memo',label:'Memo-anchored on Solana',tx_sig:publicSig,verified:true};
    if(publicLabel==='Wallet-signed & server-verified'||publicLabel==='Wallet-signed and server-verified') return {key:'wallet',label:'Wallet-signed and server-verified',tx_sig:'',verified:true};
    if(publicLabel==='System event') return {key:'system',label:'System event',tx_sig:'',verified:true};
    return {key:'legacy',label:'Legacy / not server-verified',tx_sig:'',verified:false};
  }
  var type=String(proof.proof_type||'').toLowerCase();
  var verified=proof.server_verified===true;
  var sig=crValidTxSig(proof.tx_sig)?String(proof.tx_sig):'';
  var metadata=crProofMetadata(r);
  var payment=proof.payment_proof&&typeof proof.payment_proof==='object'?proof.payment_proof:{};
  var memoVerified=payment.memo_verified===true||metadata.memo_verified===true;
  var transfersVerified=payment.transfers_verified===true||payment.system_program_transfers_verified===true||metadata.transfers_verified===true||metadata.system_program_transfers_verified===true;
  if(type==='solana_memo'&&verified&&sig&&memoVerified&&transfersVerified) return {key:'transfer',label:'SOL transfer verified on Solana',tx_sig:sig,verified:true};
  if(type==='solana_memo'&&verified&&sig) return {key:'memo',label:'Memo-anchored on Solana',tx_sig:sig,verified:true};
  if(type==='wallet_signed_server_verified'&&verified) return {key:'wallet',label:'Wallet-signed and server-verified',tx_sig:'',verified:true};
  if(type==='system_event'&&verified) return {key:'system',label:'System event',tx_sig:'',verified:true};
  return {key:'legacy',label:'Legacy / not server-verified',tx_sig:'',verified:false};
}
function crStatus(r){
  var proof=crProofState(r);
  if(r&&r.record_source==='native_public_dto'){
    var stage=String(r.native_stage||r.stage||'');
    if(stage==='sealed'&&r.native_seal_verified===true&&proof.key==='memo') return { txt:'Sealed', cls:'cr-sealed', detail:'Native Memo-anchored record' };
    if(stage==='sealed') return { txt:'Seal proof unavailable', cls:'cr-pending', detail:'Server stage is sealed; public Memo receipt unavailable' };
    if(['ready_for_finalization','resolution_proposed','in_challenge_window','resolved','archived'].indexOf(stage)!==-1 && Number(r.native_review_count||0)>0){
      return { txt:'Reviewed', cls:'cr-reviewed', detail:'Native reviewed lifecycle state' };
    }
    if(stage==='open_public') return { txt:'Public investigation', cls:'cr-pending', detail:'Public Case; no reviewed outcome yet' };
    if(stage==='in_review') return { txt:'Under review', cls:'cr-pending', detail:'Independent review in progress' };
    if(stage==='reopened') return { txt:'Reopened', cls:'cr-pending', detail:'Returned to investigation' };
    if(stage==='halted') return { txt:'Halted', cls:'cr-pending', detail:'Lifecycle halted by an authorized transition' };
    return { txt:'Public Case', cls:'cr-pending', detail:'Native public lifecycle state' };
  }
  if(proof.key==='legacy') return { txt:'Legacy / unverified', cls:'cr-pending', detail:'Imported status; not native-reviewed' };
  if(r && r.sealed===true && proof.key==='memo') return { txt:'Sealed', cls:'cr-sealed', detail:'Native Memo-anchored record' };
  return { txt:'Under review', cls:'cr-pending' };
}
function crDate(v){ return v ? new Date(v).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : ''; }
function crTxSig(r){
  return crProofState(r).tx_sig||'';
}
function crLegacyTxSig(r){
  var raw = String((r && r.tx) || '').trim();
  if(!raw) return '';
  var candidate=(raw.split(/[\s,;\n]+/).filter(function(x){ return x && x.length > 6; })[0] || '');
  return crValidTxSig(candidate)?candidate:'';
}
function crHasMemo(r){ var key=crProofState(r).key; return key==='memo'||key==='transfer'; }
function crIsNativeReviewed(r){ var status=crStatus(r).txt; return status==='Reviewed'||status==='Sealed'; }
function crIsNativeSealed(r){ return crStatus(r).txt==='Sealed'; }
function crChallengeCount(id){ return (window.__crChallengeCounts || {})[String(id)] || 0; }
function crNativeProofRank(receipt){
  var proof=crProofState({publication_proof:Object.assign({},receipt,{proof_source:'native_public_dto'})});
  return proof.key==='transfer'?5:(proof.key==='memo'?4:(proof.key==='wallet'?3:(proof.key==='system'?2:1)));
}
function crNativeCaseRecord(item){
  item=item||{};
  var receipts=Array.isArray(item.proof_log)?item.proof_log:[];
  var sealReceipt=receipts.filter(function(receipt){
    var eventType=String(receipt&&receipt.event_type||'').toLowerCase();
    var proof=crProofState({publication_proof:Object.assign({},receipt,{proof_source:'native_public_dto'})});
    return eventType==='record_sealed'&&proof.key==='memo';
  })[0]||null;
  var strongest=sealReceipt||receipts.slice().sort(function(a,b){return crNativeProofRank(b)-crNativeProofRank(a);})[0]||{label:'Legacy / not server-verified'};
  var governance=item.governance&&typeof item.governance==='object'?item.governance:{};
  var challenges=Array.isArray(governance.challenges)?governance.challenges:[];
  return {
    id:String(item.public_ref||''),
    public_ref:String(item.public_ref||''),
    company:String(item.title||'Public Case'),
    summary:String(item.summary||''),
    category:String(item.category||''),
    stage:String(item.stage||''),
    native_stage:String(item.stage||''),
    created_at:item.created_at||null,
    sealed_at:item.sealed_at||null,
    record_source:'native_public_dto',
    native_evidence_count:Array.isArray(item.evidence)?item.evidence.length:0,
    native_review_count:Array.isArray(item.reviews)?item.reviews.length:0,
    native_challenge_count:challenges.filter(function(challenge){return ['open','under_review'].indexOf(String(challenge&&challenge.state||''))!==-1;}).length,
    native_seal_verified:!!sealReceipt,
    publication_proof:Object.assign({},strongest,{proof_source:'native_public_dto'})
  };
}
function crNativeChallengeState(nativeReports){
  var state={challenged:{},counts:{},total:0};
  (nativeReports||[]).forEach(function(row){
    var count=Number(row&&row.native_challenge_count||0);
    if(count>0){
      var key=String(row.id);
      state.challenged[key]=1;
      state.counts[key]=count;
      state.total+=count;
    }
  });
  return state;
}
function crAddLegacyChallenges(state,challenges){
  state=state||{challenged:{},counts:{},total:0};
  (challenges||[]).forEach(function(challenge){
    var key=String(challenge.item_id);
    state.challenged[key]=1;
    state.counts[key]=(state.counts[key]||0)+1;
    state.total++;
  });
  return state;
}

var crState = { filter:'all', q:'', sort:'newest', page:1 };
var CR_PER = 6;
function crEvidenceCount(r){ if(r&&r.record_source==='native_public_dto') return Number(r.native_evidence_count||0); return crCountTokens(r.tx) + crCountTokens(r.onchain) + crCountTokens(r.offchain); }
function crAnalystReviews(r){
  if(r&&r.record_source==='native_public_dto') return Number(r.native_review_count||0);
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
    var nativeReports=[],legacyReports=[],sourceFailures=0,sourceAttempts=0;
    if(typeof window.osiPublicApi==='function'){
      sourceAttempts++;
      try{
        var result=await window.osiPublicApi('osi-v2-case-read',{op:'list_public_cases'});
        nativeReports=(Array.isArray(result&&result.cases)?result.cases:[]).map(crNativeCaseRecord);
      }catch(_nativeError){ sourceFailures++; }
    }
    sourceAttempts++;
    try{
      legacyReports = await supaGet('reports?select=id,company,summary,onchain,offchain,tx,wallet,sealed,approved,created_at&approved=eq.true&order=created_at.desc&limit=48') || [];
      legacyReports=legacyReports.map(function(row){return Object.assign({},row,{record_source:'legacy_public_projection'});});
    }catch(_legacyError){ sourceFailures++; legacyReports=[]; }
    var nativeIds={};nativeReports.forEach(function(row){nativeIds[String(row.id)]=true;});
    var reports=nativeReports.concat(legacyReports.filter(function(row){return !nativeIds[String(row.id)];}));
    var packs = [];
    if(reports.length){
      // Metadata only (no content). Full pack content is never anon-readable;
      // downloads go through the secure osi-ai-pack "get" path.
      try{ packs = await osiAiPackPublicMeta() || []; }catch(_e){}
    }
    var byCase = {}; packs.forEach(function(p){ (byCase[p.case_ref] = byCase[p.case_ref] || []).push(p); });
    window.__crPacks = byCase;
    var recMap = {}; reports.forEach(function(r){ recMap[r.id] = r; });
    window.__crRecords = recMap; window.__crList = reports; window.__crSourceState = reports.length ? 'loaded' : (sourceAttempts&&sourceFailures===sourceAttempts?'error':(sourceFailures?'error':'empty'));
    try{ await loadVouches(); window.__crVouchesLoaded = true; }catch(_e){ window.__crVouchesLoaded = false; }
    var challengeState=crNativeChallengeState(nativeReports);
    try{
      var ch = await supaGet('challenges?select=item_id&item_type=eq.report&status=eq.open') || [];
      crAddLegacyChallenges(challengeState,ch);
    }catch(_e){}
    window.__crChallenged=challengeState.challenged;
    window.__crChallengeCounts=challengeState.counts;
    window.__crOpenChallengeCount=challengeState.total;
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
  var reviewed = sourceOk ? reports.filter(crIsNativeReviewed).length : null;
  var memo = sourceOk ? reports.filter(crHasMemo).length : null;
  var openCh = sourceOk ? (window.__crOpenChallengeCount||0) : null;
  var val = function(v, cls){ return '<div class="fo-op-n'+(cls?(' '+cls):'')+'">'+(v==null ? 'Not available yet' : v)+'</div>'; };
  host.innerHTML =
      '<div class="fo-op"><div class="fo-op-ic">ARC</div>'+val(publicRecords, publicRecords==null?'cr-stat-na':'')+'<div class="fo-op-l">Public Records</div></div>'
    + '<div class="fo-op"><div class="fo-op-ic sol">REV</div>'+val(reviewed, reviewed==null?'cr-stat-na':'sol')+'<div class="fo-op-l">Native reviewed</div></div>'
    + '<div class="fo-op"><div class="fo-op-ic">MEM</div>'+val(memo, memo==null?'cr-stat-na':'')+'<div class="fo-op-l">Memo-anchored</div></div>'
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
  if(crState.filter==='sealed') reports = reports.filter(crIsNativeSealed);
  else if(crState.filter==='reviewed') reports = reports.filter(crIsNativeReviewed);
  else if(crState.filter==='memo') reports = reports.filter(crHasMemo);
  else if(crState.filter==='challenged') reports = reports.filter(function(r){ return !!chSet[String(r.id)]; });
  if(crState.sort==='reviewed') reports.sort(function(a,b){ return (crAnalystReviews(b)||-1)-(crAnalystReviews(a)||-1) || (new Date(b.created_at||0)-new Date(a.created_at||0)); });
  else if(crState.sort==='challenged') reports.sort(function(a,b){ return crChallengeCount(b.id)-crChallengeCount(a.id) || (new Date(b.created_at||0)-new Date(a.created_at||0)); });
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
  var proof = crProofState(r);
  var cid = r.public_ref ? String(r.public_ref) : osiCaseId(r.id);
  var titleRaw = r.company || ('Case ' + String(r.id).slice(0,6));
  var title = escapeHtml(titleRaw);
  var date = crDate(r.created_at);
  var updated = r.updated_at ? crDate(r.updated_at) : '';
  var txSig = crTxSig(r);
  var legacyTxSig = proof.key==='legacy' ? crLegacyTxSig(r) : '';
  var evCount = crEvidenceCount(r);
  var revCount = crAnalystReviews(r);
  var challengeCount = crChallengeCount(r.id);
  var challenged = challengeCount > 0;
  var wallet = r.wallet ? escapeHtml(crShort(r.wallet)) : 'Wallet unavailable';
  var cls = 'cr-card' + (crIsNativeSealed(r) ? ' sealed' : '') + (challenged ? ' challenged' : '');
  var displayedSig=txSig||legacyTxSig;
  var copyBtn = displayedSig ? ('<button class="cr-copy" type="button" title="Copy transaction signature" onclick="event.stopPropagation();crCopyTx(&quot;'+crAttr(displayedSig)+'&quot;)">Copy</button>') : '';
  var verifyBtn = txSig ? ('<button class="cr-btn outline" type="button" onclick="event.stopPropagation();crVerify(&quot;'+crAttr(txSig)+'&quot;)">Verify on Solana</button>') : (legacyTxSig?'<button class="cr-btn outline" type="button" onclick="event.stopPropagation();crVerify(&quot;'+crAttr(legacyTxSig)+'&quot;)">Inspect transaction</button>':'');
  var evValue = evCount ? String(evCount) : '<span class="cr-meta-v na">Evidence not indexed</span>';
  var evSub = evCount ? ('Public reference' + (evCount===1?'':'s')) : 'No indexed evidence count';
  var revValue = revCount==null ? '<span class="cr-meta-v na">Review data unavailable</span>' : String(revCount);
  var revSub = revCount==null ? 'Analyst tally unavailable' : ('Analyst review' + (revCount===1?'':'s'));
  var chValue = challengeCount ? String(challengeCount) : '<span class="cr-meta-v na">No open challenges</span>';
  var chSub = challengeCount ? ('Open challenge' + (challengeCount===1?'':'s')) : 'Challenge status clear';
  var recordDateLabel=proof.key==='legacy'?'Legacy record date ':'Published ';
  var proofDetail=proof.key==='legacy'
    ? (legacyTxSig?'Unverified transaction reference '+escapeHtml(String(legacyTxSig).slice(0,5)+'...'+String(legacyTxSig).slice(-5))+' '+copyBtn:'No native proof receipt')
    : (txSig?'Tx '+escapeHtml(String(txSig).slice(0,5)+'...'+String(txSig).slice(-5))+' '+copyBtn:'Server receipt; no on-chain transaction');
  return '<div class="'+cls+'" data-cid="'+crAttr(r.id)+'" role="button" tabindex="0" onclick="openCaseRecord(&quot;'+crAttr(r.id)+'&quot;)" onkeydown="if(event.key===&quot;Enter&quot;){openCaseRecord(&quot;'+crAttr(r.id)+'&quot;);}" aria-label="Open public record '+cid+'">'
    + '<div class="cr-card-main">'
      + '<span class="cr-record-id">'+cid+'</span>'
      + '<div class="cr-title">'+title+'</div>'
      + '<div class="cr-wallet mono">'+wallet+'</div>'
      + '<div class="cr-summary">'+escapeHtml(String(r.summary || 'No public summary provided.').slice(0,220))+'</div>'
      + '<div class="cr-date mono">'+(date ? (recordDateLabel+date) : 'Record date unavailable')+(updated ? (' <span class="sep">|</span> Updated '+updated) : '')+'</div>'
    + '</div>'
    + '<div class="cr-card-meta">'
      + '<div class="cr-meta-cell"><div class="cr-meta-k">Status</div><div class="cr-meta-v"><span class="cr-status '+st.cls+'">'+st.txt+'</span></div><div class="cr-meta-sub">'+escapeHtml(st.detail||'Native lifecycle pending')+'</div></div>'
      + '<div class="cr-meta-cell"><div class="cr-meta-k">Evidence</div><div class="cr-meta-v">'+evValue+'</div><div class="cr-meta-sub">'+evSub+'</div></div>'
      + '<div class="cr-meta-cell"><div class="cr-meta-k">Reviews</div><div class="cr-meta-v">'+revValue+'</div><div class="cr-meta-sub">'+revSub+'</div></div>'
      + '<div class="cr-meta-cell"><div class="cr-meta-k">Challenges</div><div class="cr-meta-v '+(challengeCount?'warn':'')+'">'+chValue+'</div><div class="cr-meta-sub">'+chSub+'</div></div>'
    + '</div>'
    + '<div class="cr-card-proof">'
      + '<div><div class="cr-meta-k">Proof Log</div>' + (proof.verified
        ? '<div class="cr-proof-state ok">'+escapeHtml(proof.label)+'</div><div class="cr-meta-sub">'+proofDetail+'</div>'
        : '<div class="cr-proof-state mut">'+escapeHtml(proof.label)+'</div><div class="cr-meta-sub">'+proofDetail+'</div>') + '</div>'
      + '<div class="cr-actions"><button class="cr-btn primary" type="button" onclick="event.stopPropagation();openCaseRecord(&quot;'+crAttr(r.id)+'&quot;)">View Record</button>'+verifyBtn+'</div>'
      + '<div class="cr-actions secondary"><button class="cr-btn chx" type="button" onclick="event.stopPropagation();osiNavigate(&quot;field&quot;)">Open Case workspace</button></div>'
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
  var proof = crProofState(r);
  var cid = r.public_ref ? String(r.public_ref) : osiCaseId(r.id);
  var title = escapeHtml(r.company || ('Case ' + String(r.id).slice(0,6)));
  var date = crDate(r.created_at);
  var updated = r.updated_at ? crDate(r.updated_at) : '';
  var txSig = crTxSig(r);
  var legacyTxSig = proof.key==='legacy' ? crLegacyTxSig(r) : '';
  var displayedSig=txSig||legacyTxSig;
  var solUrl = displayedSig ? ((typeof solscanTx === 'function') ? solscanTx(displayedSig) : ('https://solscan.io/tx/' + encodeURIComponent(displayedSig))) : '';
  var verifyRow = displayedSig
    ? '<div class="crd-verify"><span class="crd-vk">'+escapeHtml(proof.label)+'</span><a class="crd-vlink" href="' + escapeHtml(solUrl) + '" target="_blank" rel="noopener">' + escapeHtml(String(displayedSig).slice(0,16)) + '... '+(txSig?'Verify on Solana':'Inspect unverified reference')+'</a></div>'
    : '<div class="crd-verify"><span class="crd-vk">'+escapeHtml(proof.label)+'</span><span class="mono" style="color:var(--ink-faint);font-size:11px">No native proof receipt</span></div>';
  var packRows = packs.length
    ? packs.map(function(p,i){ return '<div class="crd-pack"><div><div class="crd-pack-t">' + escapeHtml(escPackLabel(p.pack_type)) + '</div><div class="crd-pack-d">Public escalation pack metadata</div></div><button class="crd-dl" type="button" onclick="crDownloadPack(&quot;' + crAttr(r.id) + '&quot;,' + i + ')">Download</button></div>'; }).join('')
    : '<div class="crd-empty">No public packs published for this record yet.</div>';
  var evCount = crEvidenceCount(r);
  var revCount = crAnalystReviews(r);
  var challengeCount = crChallengeCount(r.id);
  var ev = evCount ? (evCount + ' public evidence reference' + (evCount===1?'':'s') + ' indexed from record fields.') : 'Evidence not indexed.';
  var rev = revCount==null ? 'Review data unavailable.' : (revCount + ' analyst review' + (revCount===1?'':'s') + ' indexed.');
  var ch = challengeCount ? (challengeCount + ' open challenge' + (challengeCount===1?'':'s') + '.') : 'No open challenges.';
  return ''
    + '<div class="crd-head"><span class="cr-cid mono">' + cid + '</span><span class="cr-status ' + st.cls + '">' + st.txt + '</span></div>'
    + '<h3 class="crd-title">' + title + '</h3>'
    + '<div class="crd-meta mono">' + (date ? ((proof.key==='legacy'?'Legacy record date ':'Published ') + date) : 'Record date unavailable') + (updated ? (' | Updated ' + updated) : '') + '</div>'
    + '<div class="crd-block"><div class="crd-h">VERIFICATION</div>' + verifyRow + '</div>'
    + '<div class="crd-block"><div class="crd-h">SUMMARY</div><p class="crd-sum">' + escapeHtml(r.summary || 'No public summary provided.') + '</p></div>'
    + '<div class="crd-block"><div class="crd-h">EVIDENCE</div><div class="crd-ev">' + escapeHtml(ev) + '</div></div>'
    + '<div class="crd-block"><div class="crd-h">ANALYST REVIEW</div><div class="crd-rev"><span class="crd-rev-dot"></span>' + escapeHtml(rev) + '</div></div>'
    + '<div class="crd-block"><div class="crd-h">CHALLENGE STATUS</div><div class="crd-ev">' + escapeHtml(ch) + '</div></div>'
    + '<div class="crd-block"><div class="crd-h">ESCALATION PACKS <span class="crd-h-sub">Public metadata only</span></div>' + packRows + '</div>'
    + '<div class="crd-actions">'
      + (displayedSig ? '<a class="crd-act '+(txSig?'primary':'')+'" href="' + escapeHtml(solUrl) + '" target="_blank" rel="noopener">'+(txSig?'Verify on Solana':'Inspect transaction')+'</a>' : '')
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
      var status = crStatus(r);
      var st = status.txt;
      var stc = status.cls;
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
