

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
function plNavigate(view){ if(typeof window.osiNavigate==='function') window.osiNavigate(view); else showView(view); }
// zengin timeline kartı (Proof Log'a özel; kompakt raSignedItem ayrı kalır)
function plGoCase(id, canonicalRef){
  if(canonicalRef && typeof osiV2OpenCase==='function'){
    plNavigate('field');
    setTimeout(function(){ osiV2OpenCase(canonicalRef); },120);
    return;
  }
  var rec = (window.__crRecords||{})[id];
  if(rec && typeof openCaseRecord==='function'){ plNavigate('records'); setTimeout(function(){ openCaseRecord(id); },120); return; }
  plNavigate('records');
}
function plGoWire(versionRef){
  if(!/^OSI-WV-[0-9A-F]{16}$/.test(String(versionRef||''))) return;
  plNavigate('wire');
  setTimeout(function(){ if(typeof window.osiV2OpenWireReport==='function') window.osiV2OpenWireReport(versionRef); },120);
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
  var seals=(window.__plEvents||[]).filter(function(e){
    var type=String(e&&e.event_type||'').toLowerCase();
    return (type==='record_sealed'||type==='maintainer_seal') && plProofState(e).key==='memo';
  });
  if(!seals.length){ card.style.display='none'; return; }
  var s=seals[0];
  var cid = plCanonicalCaseRef(s) || (s.item_id ? osiCaseId(s.item_id) : 'OSI-000000');
  var name = s.label ? escapeHtml(String(s.label).replace(/^sealed /,'').slice(0,40)) : '';
  card.style.display='';
  host.innerHTML = '<div class="pl-sl-top"><span class="pl-sl-id mono">'+cid+'</span>'+(name?('<span class="pl-sl-nm">'+name+'</span>'):'')+'</div>'
    + '<div class="pl-sl-meta mono">Sealed by '+escapeHtml(raShortW(s.actor_wallet))+' \u00b7 '+raTimeAgo(s.created_at)+'</div>'
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
  if(t==='analyst_vouch' || t==='review_signed' || t==='analyst_review' || t==='wire_report_review_cast' || t==='wire_report_review_revised') return 'vote';
  if(t==='report_submitted' || t==='wire_dispatch' || t==='wire_report_version_submitted' || t==='wire_report_published' || t==='wire_promoted') return 'report';
  if(t==='demand_signal' || t==='support' || t==='support_signal' || t==='support_payment_confirmed') return 'support';
  if(t==='maintainer_seal' || t==='record_sealed' || t==='public_record_sealed') return 'seal';
  if(t==='case_opened' || t==='case_created' || t==='bounty_opened') return 'case';
  if(t.indexOf('challenge') !== -1) return 'challenge';
  return 'other';
}
function plMemo(ev){
  var exact={
    wire_report_version_submitted:{tag:'OSI_WIRE_SUBMITTED',title:'Wire Version Submitted',cls:'report'},
    wire_report_review_cast:{tag:'OSI_WIRE_REVIEW',title:'Wire Review Cast',cls:'review'},
    wire_report_review_revised:{tag:'OSI_WIRE_REVIEW',title:'Wire Review Revised',cls:'review'},
    wire_report_published:{tag:'OSI_WIRE_PUBLISHED',title:'Wire Report Published',cls:'report'},
    wire_promoted:{tag:'OSI_WIRE_PROMOTED',title:'Wire Promoted to Case',cls:'case'},
    support_payment_confirmed:{tag:'OSI_SUPPORT_CONFIRMED',title:'Support Transfer Confirmed',cls:'support'},
    challenge_submitted:{tag:'OSI_CHALLENGE_SUBMITTED',title:'Challenge Submitted',cls:'challenge'},
    challenge_admissibility_accepted:{tag:'OSI_CHALLENGE_ADMITTED',title:'Challenge Admitted',cls:'challenge'},
    challenge_admissibility_rejected:{tag:'OSI_CHALLENGE_REJECTED',title:'Challenge Not Admitted',cls:'challenge'},
    challenge_review_cast:{tag:'OSI_CHALLENGE_REVIEW',title:'Challenge Review Cast',cls:'challenge'},
    challenge_review_revised:{tag:'OSI_CHALLENGE_REVIEW',title:'Challenge Review Revised',cls:'challenge'},
    challenge_accepted:{tag:'OSI_CHALLENGE_ACCEPTED',title:'Challenge Accepted',cls:'challenge'},
    challenge_rejected:{tag:'OSI_CHALLENGE_REJECTED',title:'Challenge Rejected',cls:'challenge'},
    challenge_withdrawn:{tag:'OSI_CHALLENGE_WITHDRAWN',title:'Challenge Withdrawn',cls:'challenge'}
  };
  var eventType=String(ev&&ev.event_type||'').toLowerCase();
  if(exact[eventType]) return exact[eventType];
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
  var proof=plProofState(ev);
  if(proof.key==='legacy') return 'Unverified actor';
  var role=String((ev&&ev.actor_role)||'').trim().toLowerCase();
  var labels={
    analyst:'Analyst',
    probationary_analyst:'Probationary analyst',
    case_owner:'Case owner',
    report_author:'Report author',
    challenger:'Challenger',
    supporter:'Supporter',
    wire_author:'Wire author',
    maintainer:'Maintainer',
    system:'System'
  };
  if(labels[role]) return labels[role];
  return proof.key==='system' ? 'System' : 'Verified actor';
}
function plSasSlot(ev){
  var proof=plProofState(ev),role=String((ev&&ev.actor_role)||'').trim().toLowerCase();
  if(proof.key==='legacy'||['analyst','verified_analyst','senior_analyst','probationary_analyst'].indexOf(role)<0)return'';
  return'<span data-sas-wallet="'+escapeHtml(ev&&ev.actor_wallet||'')+'" data-sas-role="'+escapeHtml(role)+'"></span>';
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
function plValidTxSig(sig){ return /^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(String(sig||'')); }
function plProofMetadata(ev){
  var raw=(ev&&ev.verification_metadata)||{};
  if(typeof raw==='string'){ try{ raw=JSON.parse(raw); }catch(e){ raw={}; } }
  return raw&&typeof raw==='object'?raw:{};
}
function plProofState(ev){
  ev=ev||{};
  var publicLabel=String(ev.label||'').trim();
  if(ev.proof_source==='native_public_dto'){
    var publicPayment=ev.payment_proof&&typeof ev.payment_proof==='object'?ev.payment_proof:{};
    var paymentVerified=publicPayment.cluster==='mainnet-beta'
      && publicPayment.finality==='finalized'
      && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(publicPayment.payer_wallet||''))
      && Array.isArray(publicPayment.recipient_manifest)
      && publicPayment.recipient_manifest.length>0
      && /^[1-9][0-9]*$/.test(String(publicPayment.total_lamports||''));
    if(publicLabel==='SOL transfer verified on Solana'&&plValidTxSig(ev.tx_sig)&&paymentVerified){
      return {key:'transfer',label:'SOL transfer verified on Solana',tx_sig:String(ev.tx_sig),onchain:true};
    }
    if(publicLabel==='Memo-anchored on Solana'&&plValidTxSig(ev.tx_sig)){
      return {key:'memo',label:'Memo-anchored on Solana',tx_sig:String(ev.tx_sig),onchain:true};
    }
    if(publicLabel==='Wallet-signed & server-verified'||publicLabel==='Wallet-signed and server-verified'){
      return {key:'wallet',label:'Wallet-signed and server-verified',tx_sig:'',onchain:false};
    }
    if(publicLabel==='System event'){
      return {key:'system',label:'System event',tx_sig:'',onchain:false};
    }
    return {key:'legacy',label:'Legacy / not server-verified',tx_sig:'',legacy_tx_sig:'',onchain:false};
  }
  var type=String(ev.proof_type||'').toLowerCase();
  var verified=ev.server_verified===true;
  var sig=plValidTxSig(ev.tx_sig)?String(ev.tx_sig):'';
  var metadata=plProofMetadata(ev);
  var payment=ev.payment_proof&&typeof ev.payment_proof==='object'?ev.payment_proof:{};
  var memoVerified=payment.memo_verified===true||metadata.memo_verified===true;
  var transfersVerified=payment.transfers_verified===true||payment.system_program_transfers_verified===true||metadata.transfers_verified===true||metadata.system_program_transfers_verified===true;
  if(type==='solana_memo'&&verified&&sig&&memoVerified&&transfersVerified){
    return {key:'transfer',label:'SOL transfer verified on Solana',tx_sig:sig,onchain:true};
  }
  if(type==='solana_memo'&&verified&&sig){
    return {key:'memo',label:'Memo-anchored on Solana',tx_sig:sig,onchain:true};
  }
  if(type==='wallet_signed_server_verified'&&verified){
    return {key:'wallet',label:'Wallet-signed and server-verified',tx_sig:'',onchain:false};
  }
  if(type==='system_event'&&verified){
    return {key:'system',label:'System event',tx_sig:'',onchain:false};
  }
  return {key:'legacy',label:'Legacy / not server-verified',tx_sig:'',legacy_tx_sig:plValidTxSig(ev.tx_sig)?String(ev.tx_sig):'',onchain:false};
}
function plMemoStatus(ev){ return plProofState(ev).label; }
function plCanonicalCaseRef(ev){
  var values=[ev&&ev.case_public_ref,ev&&ev.case_ref,ev&&ev.target_public_ref,ev&&ev.public_ref,ev&&ev.item_id];
  for(var i=0;i<values.length;i++){
    var ref=String(values[i]||'').toUpperCase();
    if(/^OSI-[A-Z0-9]{8,32}$/.test(ref)) return ref;
  }
  return '';
}
function plCanonicalWireRef(ev){
  var values=[ev&&ev.version_public_ref,ev&&ev.target_public_ref,ev&&ev.public_ref,ev&&ev.item_id];
  for(var i=0;i<values.length;i++){
    var ref=String(values[i]||'').toUpperCase();
    if(/^OSI-WV-[0-9A-F]{16}$/.test(ref)) return ref;
  }
  return '';
}
function plReferenceHtml(ev){
  var raw = ev && ev.item_id != null ? String(ev.item_id) : '';
  if(!raw) return 'Reference unavailable';
  var group = plGroup(ev);
  var wireRef=plCanonicalWireRef(ev);
  if(wireRef) return '<button class="plc-ref-link" type="button" onclick="plGoWire(\''+plJsString(wireRef)+'\')">'+escapeHtml(wireRef)+'</button>';
  var canonical=plCanonicalCaseRef(ev);
  var display = canonical || ((group==='case' || group==='vote' || group==='challenge' || group==='seal' || group==='support') ? osiCaseId(raw) : raw);
  return '<button class="plc-ref-link" type="button" onclick="plGoCase(\''+plJsString(raw)+'\',\''+plJsString(canonical)+'\')">'+escapeHtml(display)+'</button>';
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
  var proof=plProofState(ev);
  var sig=proof.tx_sig||proof.legacy_tx_sig||'';
  var wallet = ev.actor_wallet ? String(ev.actor_wallet) : '';
  var walletCell = wallet
    ? '<span title="'+escapeHtml(wallet)+'">'+escapeHtml(raShortW(wallet))+'</span>'+plSasSlot(ev)+'<button class="plc-copy" type="button" title="Copy wallet" onclick="plCopyProofValue(\''+plJsString(wallet)+'\',\'Wallet\')">copy</button>'
    : '<span>Wallet unavailable</span>';
  var label = plCleanLabel(ev);
  var when = plFullDate(ev.created_at);
  var ago = plAgo(ev.created_at);
  var txHtml = sig
    ? '<div class="plc-tx-row"><code class="mono" title="'+escapeHtml(sig)+'">Tx '+escapeHtml(plShortSig(sig))+'</code><button class="plc-copy" type="button" title="Copy signature" onclick="plCopyProofValue(\''+plJsString(sig)+'\',\'Transaction signature\')">copy</button><a class="plc-verify" href="'+solscanTx(sig)+'" target="_blank" rel="noopener">'+(proof.onchain?'Verify on Solana':'Inspect transaction')+'</a></div>'
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
        + '<div><div class="plc-meta-k">Proof status</div><div class="plc-meta-v '+(proof.key!=='legacy'?'ok':'')+'">'+escapeHtml(proof.label)+'</div></div>'
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
  var proofs=evs.map(plProofState);
  function proofCount(key){ return proofs.filter(function(proof){ return proof.key===key; }).length; }
  host.innerHTML =
      stat('signed','ALL','Proof Events',val(total),'Explicitly classified receipts')
    + stat('review','SIG','Wallet verified',val(proofCount('wallet')),'Server-verified, not on-chain')
    + stat('memo','MEM','Memo anchored',val(proofCount('memo')),'Confirmed Solana Memo receipts')
    + stat('seal','SOL','SOL transfers',val(proofCount('transfer')),'Memo and transfers verified')
    + stat('case','SYS','System events',val(proofCount('system')),'Server-originated process events')
    + stat('challenge','LEG','Legacy / unverified',val(proofCount('legacy')),'No native verification claim')
    + stat('net','SOL','Network','Solana','Mainnet');
}
function plSchemaRender(){
  var host=document.getElementById('pl-schema'); if(!host) return;
  var rows=[
    ['OSI_CASE_OPENED','cy'],
    ['OSI_REPORT_SUBMITTED','vio'],
    ['OSI_WIRE_PUBLISHED','vio'],
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
  var stateCls=''; var title='No proof events yet'; var body='Explicitly classified OSI proof events will appear here after they are recorded.';
  if(src==='loaded' && evs.length){ stateCls='ok'; title='Live proof source connected'; body=evs.length+' classified proof event'+(evs.length===1?'':'s')+' loaded from the OSI proof index.'; }
  else if(src==='error'){ stateCls='err'; title='Proof source unavailable'; body='Unable to load proof events right now.'; }
  else if(src==='unavailable'){ stateCls='err'; title='Proof source unavailable'; body='The proof source is not connected in this environment.'; }
  else if(src==='demo'){ title='Sample mode enabled'; body='Sample proof events are visible because the explicit sample-data switch is enabled.'; }
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
      var hay=[e.actor_wallet,e.item_id,e.event_type,e.label,e.vote,e.tx_sig,e.proof_type,plProofState(e).label,e.item_id?osiCaseId(e.item_id):''].map(function(x){ return String(x||'').toLowerCase(); }).join(' ');
      return hay.indexOf(q)!==-1;
    });
  }
  if(plState.filter!=='all') evs=evs.filter(function(e){ return plGroup(e)===plState.filter; });
  var stripCls = (src==='loaded' && all.length) ? ' ok' : ((src==='error'||src==='unavailable') ? ' err' : '');
  var stripTitle = (src==='loaded' && all.length) ? 'Live proof source connected' : (src==='error'||src==='unavailable' ? 'Proof source unavailable' : (src==='demo' ? 'Sample mode enabled' : 'No proof events yet'));
  var stripBody = (src==='loaded' && all.length) ? (all.length+' public proof event'+(all.length===1?'':'s')+' loaded and classified by explicit receipt fields.')
    : (src==='error' ? 'Unable to load proof events right now.'
    : (src==='unavailable' ? 'Proof source is not connected in this environment.'
    : (src==='demo' ? 'Sample rows are visible only because the explicit sample-data switch is enabled.' : 'Explicitly classified OSI proof events will appear here after they are recorded.')));
  var strip = '<div class="pl-strip'+stripCls+'"><span class="pl-strip-dot"></span><div class="pl-strip-t"><b>'+stripTitle+'</b><span>'+stripBody+'</span></div></div>';
  var totalPages=Math.max(1, Math.ceil(evs.length/PL_PER));
  if(plState.page>totalPages) plState.page=totalPages; if(plState.page<1) plState.page=1;
  var from=(plState.page-1)*PL_PER, page=evs.slice(from, from+PL_PER);
  var emptyTitle = (src==='error'||src==='unavailable') ? 'Proof source unavailable.' : (all.length ? 'No matching proof events found.' : 'No proof events found yet.');
  var emptyBody = (src==='error') ? 'Unable to load proof events right now.'
    : (src==='unavailable' ? 'The proof source is not connected in this environment.'
    : (all.length ? 'Try another filter or search term.' : 'Explicitly classified OSI proof events will appear here after they are recorded.'));
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
  host.innerHTML = '<div class="pl-note">Loading proof events...</div>';
  var nativeEvents = [];
  var legacyEvents = [];
  var source = 'unavailable';
  var supabaseAvailable=typeof SUPA_ON!=='undefined'&&SUPA_ON;
  var nativeAvailable=typeof window.osiPublicApi==='function'||typeof window.osiV2ListPublicWireReports==='function';
  if(supabaseAvailable||nativeAvailable){
    var attempts=0, failures=0;
    if(typeof window.osiPublicApi==='function'){
      attempts++;
      try{
        var publicResult=await window.osiPublicApi('osi-v2-case-read',{op:'list_public_cases'});
        var publicCases=Array.isArray(publicResult&&publicResult.cases)?publicResult.cases:[];
        publicCases.forEach(function(item){
          var caseRef=String(item&&item.public_ref||'');
          (Array.isArray(item&&item.proof_log)?item.proof_log:[]).forEach(function(receipt){
            nativeEvents.push(Object.assign({},receipt,{
              proof_source:'native_public_dto',
              item_type:'case',
              item_id:caseRef,
              case_public_ref:caseRef,
              created_at:receipt.occurred_at
            }));
          });
        });
      }catch(e){ failures++; }
    }
    if(typeof window.osiV2ListPublicWireReports==='function'){
      attempts++;
      try{
        var wireResult=await window.osiV2ListPublicWireReports();
        (Array.isArray(wireResult&&wireResult.reports)?wireResult.reports:[]).forEach(function(item){
          var versionRef=String(item&&item.version_public_ref||'');
          (Array.isArray(item&&item.proof_log)?item.proof_log:[]).forEach(function(receipt){
            nativeEvents.push(Object.assign({},receipt,{
              proof_source:'native_public_dto',
              item_type:'wire',
              item_id:versionRef,
              version_public_ref:versionRef,
              wire_report_public_ref:String(item&&item.wire_report_public_ref||''),
              created_at:receipt.occurred_at
            }));
          });
        });
      }catch(e){ failures++; }
    }
    if(supabaseAvailable){
      attempts++;
      try{
        legacyEvents = await supaGet('onchain_events?select=event_type,actor_wallet,item_type,item_id,vote,amount,token,label,tx_sig,created_at&order=created_at.desc&limit=100') || [];
        legacyEvents=legacyEvents.map(function(event){ return Object.assign({},event,{proof_source:'legacy_public_projection',actor_role:''}); });
      }catch(e){ failures++; legacyEvents=[]; }
    }
    var seen={};
    var events=nativeEvents.concat(legacyEvents).filter(function(event){
      var key=[event.event_type,event.item_id,event.actor_wallet,event.tx_sig,event.created_at].map(function(value){return String(value||'');}).join('|');
      if(seen[key]) return false;
      seen[key]=true;
      return true;
    }).sort(function(a,b){return new Date(b.created_at||0)-new Date(a.created_at||0);});
    source = events.length ? 'loaded' : (attempts>0&&failures===attempts?'error':(failures?'error':'empty'));
  }
  if(typeof events==='undefined') events=[];
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
    + '<div class="cf-sec-l">Escalation packs</div><div class="cf-packs">AI briefs for the victim, the exchange desk, and law enforcement are prepared after a case is reviewed and published. <a class="cv-a" onclick="closeCaseFile();plNavigate(\'records\')">See reviewed packs \u2192</a></div>'
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
      return '<div class="fd-it"><span class="fd-ic sol">\u26d3</span><div class="fd-tx"><b>'+escapeHtml(String(ev.event_type||'SIGNED_ACTION'))+'</b><span>by '+escapeHtml(raShortW(ev.actor_wallet))+' \u00b7 '+fdAgo(ev.created_at)+'</span></div>'+right+'</div>';
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
      return '<div class="fd-it"><span class="fd-ic vio">\u25ce</span><div class="fd-tx"><b>'+nm+'</b><span class="mono">'+escapeHtml(raShortW(w))+'</span></div><span class="fd-ago mono">\u2605 verified</span></div>';
    }).join('') + '<div class="fd-count mono">'+ws.length+' verified analyst'+(ws.length===1?'':'s')+' on the roster</div>';
  }catch(e){ host.innerHTML='<div class="fd-empty mono">Roster unavailable right now.</div>'; }
}
function foDeckRender(){ try{ foDeckActivity(); }catch(e){} try{ foDeckProof(); }catch(e){} try{ foDeckAnalysts(); }catch(e){} }

function fieldOpenForm(){ var m=document.getElementById('fo-modal'); if(!m) return; m.classList.add('open'); document.body.style.overflow='hidden'; var t=document.getElementById('bf-target'); if(t) setTimeout(function(){ try{t.focus();}catch(e){} },60); }
function fieldCloseForm(){ var m=document.getElementById('fo-modal'); if(m) m.classList.remove('open'); document.body.style.overflow=''; }
document.addEventListener('keydown', function(e){ if(e.key==='Escape'){ var m=document.getElementById('fo-modal'); if(m && m.classList.contains('open')) fieldCloseForm(); var x=document.getElementById('apx-modal'); if(x && x.classList.contains('open')) apxClose(); var c=document.getElementById('chx-modal'); if(c && c.classList.contains('open')) chxClose(); var rv=document.getElementById('rv-drawer'); if(rv && rv.classList.contains('open')) rvClose(); } });

// Multiple CORS-friendly public RPCs so one flaky endpoint never blocks signing.
// Phantom itself broadcasts the transaction; these are only used to fetch a recent blockhash.
const RPC_FALLBACKS = [
  "https://solana-rpc.publicnode.com",
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
