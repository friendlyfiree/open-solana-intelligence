/* Native V2 Case lifecycle for the mature OSI root experience. */
(function(){
  'use strict';

  var READ_URL = SUPABASE_URL + '/functions/v1/osi-v2-case-read';
  var WRITE_URL = SUPABASE_URL + '/functions/v1/osi-v2-case-write';
  var PAGE_SIZE = 12;
  var state = {
    cases: [], mode: 'public', actorRole: 'public', query: '', stage: 'open_public',
    sort: 'newest', page: 1, loadToken: 0, current: null, tab: 'overview',
    capabilities: null, caseIdempotency: '', reviewBusy: false,
    modalReturnFocus: null, drawerReturnFocus: null
  };

  function esc(value){
    return String(value == null ? '' : value).replace(/[&<>"']/g,function(char){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char];
    });
  }
  function short(value){
    value=String(value||'');
    return value.length>18 ? value.slice(0,8)+'...'+value.slice(-6) : value;
  }
  function label(value){
    return String(value||'').replace(/_/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase();});
  }
  function dateText(value){
    var date=new Date(value||'');
    return isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
  }
  function randomKey(prefix){
    var id=crypto.randomUUID ? crypto.randomUUID() : String(Date.now())+Math.random().toString(36).slice(2);
    return prefix+':'+id.replace(/[^A-Za-z0-9.-]/g,'');
  }
  function headers(){
    var token=(typeof SUPA_AUTH_TOKEN==='string'&&SUPA_AUTH_TOKEN)?SUPA_AUTH_TOKEN:SUPABASE_ANON_KEY;
    return {'Content-Type':'application/json','apikey':SUPABASE_ANON_KEY,'Authorization':'Bearer '+token};
  }
  async function api(url,body){
    var response=await fetch(url,{method:'POST',headers:headers(),body:JSON.stringify(body)});
    var payload={};
    try{payload=await response.json();}catch(error){payload={ok:false,error:'invalid_server_response'};}
    if(!response.ok||payload.ok!==true){
      var failure=new Error(payload.error||('request_failed_'+response.status));
      failure.status=response.status;
      throw failure;
    }
    return payload;
  }
  function userError(error){
    var code=String(error&&error.message||'request_failed');
    var messages={
      case_writes_disabled:'Case intake is safely disabled while rollout checks are incomplete.',
      case_writes_disabled_or_unavailable:'Case intake is safely disabled or temporarily unavailable.',
      not_eligible_reviewer:'This wallet is not an eligible V2 analyst and does not have full maintainer access.',
      half_maintainer_wallet_only:'Maintainer access also requires the configured Supabase identity.',
      half_maintainer_auth_only:'Maintainer access also requires the configured admin wallet.',
      self_review_denied:'A Case owner cannot review their own Case.',
      bad_signature:'The wallet signature could not be verified.',
      proof_binding_rejected:'The proof expired or no longer matches this exact action. Start again.',
      transaction_not_confirmed:'The Memo transaction is not confirmed yet. Keep this window open and retry.',
      rpc_unavailable:'Solana confirmation is temporarily unavailable. Your transaction can be retried safely.',
      replayed_or_expired:'This read authorization was already used or expired.',
      prohibited_secret_material:'Remove any seed phrase, recovery phrase, mnemonic, private key, or secret key reference.',
      prohibited_illegal_access_material:'Illegal-access material cannot be submitted.',
      rate_limited:'Too many proof requests. Wait a few minutes and try again.'
    };
    return messages[code]||code.replace(/_/g,' ');
  }
  async function ensureWallet(){
    if(!walletPubkey&&typeof toggleWallet==='function') await toggleWallet();
    if(!walletPubkey) throw new Error('Connect a Solana wallet to continue.');
    return walletPubkey;
  }
  function bytesToBase64(bytes){
    var binary='';
    for(var i=0;i<bytes.length;i++) binary+=String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  async function signMessage(message){
    var provider=typeof getProvider==='function' ? getProvider() : null;
    if(!provider||typeof provider.signMessage!=='function') throw new Error('This wallet does not support signMessage.');
    var signed=await provider.signMessage(new TextEncoder().encode(message),'utf8');
    var bytes=signed&&signed.signature?signed.signature:signed;
    if(!(bytes instanceof Uint8Array)) bytes=new Uint8Array(bytes||[]);
    return bytesToBase64(bytes);
  }
  async function signedRead(purpose,op,extra){
    var wallet=await ensureWallet();
    var issue=await api(READ_URL,Object.assign({op:'issue_read_challenge',purpose:purpose,wallet:wallet},extra||{}));
    var signature=await signMessage(issue.challenge);
    return await api(READ_URL,Object.assign({op:op,wallet:wallet,challenge:issue.challenge,signature:signature},extra||{}));
  }
  function setLoading(){
    var host=document.getElementById('field-cases');
    if(host) host.innerHTML='<div class="osi-v2-skeleton"></div><div class="osi-v2-skeleton"></div><div class="osi-v2-skeleton"></div>';
  }
  function setFieldCopy(mode){
    var title=document.getElementById('fo-title');
    var sub=document.getElementById('fo-sub');
    var eyebrow=document.getElementById('fo-eyebrow');
    if(mode==='mine'){
      if(eyebrow) eyebrow.textContent='Private owner workspace';
      if(title) title.textContent='My Cases';
      if(sub) sub.textContent='Wallet-authorized private Cases, status, proof, and exact next action.';
    }else if(mode==='review'){
      if(eyebrow) eyebrow.textContent='Authorized review queue';
      if(title) title.textContent='My Reviews';
      if(sub) sub.textContent='Private Cases available to this eligible analyst or full maintainer.';
    }else{
      if(eyebrow) eyebrow.textContent='Public Case registry';
      if(title) title.textContent='The Field Office';
      if(sub) sub.textContent='Only approved, Memo-anchored V2 Cases appear in this public registry.';
    }
  }
  function countActiveReviews(item){
    return (item.reviews||[]).filter(function(review){return review.is_active===true;}).length;
  }
  function hasOpenProof(item){
    return (item.proof_log||[]).some(function(row){return row.event_type==='CASE_OPENED'&&row.label==='Memo-anchored on Solana';});
  }
  function stageClass(item){return item.visibility==='private'?'private':'';}
  function drawCases(){
    var host=document.getElementById('field-cases');
    if(!host) return;
    var rows=state.cases.slice();
    var query=state.query.toLowerCase();
    if(query) rows=rows.filter(function(item){return [item.public_ref,item.title,item.summary,item.category].join(' ').toLowerCase().includes(query);});
    if(state.mode==='public'&&state.stage!=='all'){
      rows=rows.filter(function(item){return state.stage==='resolved'?item.stage==='resolved':item.stage===state.stage;});
    }
    rows.sort(function(a,b){
      var delta=new Date(a.created_at||0)-new Date(b.created_at||0);
      return state.sort==='oldest'?delta:-delta;
    });
    var pages=Math.max(1,Math.ceil(rows.length/PAGE_SIZE));
    state.page=Math.min(state.page,pages);
    var visible=rows.slice((state.page-1)*PAGE_SIZE,state.page*PAGE_SIZE);
    if(!visible.length){
      var emptyTitle=state.mode==='public'?'No public V2 Cases yet':(state.mode==='mine'?'No Cases for this wallet':'No Cases currently await this wallet');
      var emptyBody=state.mode==='public'?'The registry is live and reads production data. A Case appears only after an eligible analyst threshold or full maintainer approval, plus a confirmed CASE_OPENED Memo.':(state.mode==='mine'?'Open a Case to create a private, wallet-anchored record.':'Only private initial-review Cases available under server-derived authorization appear here.');
      host.innerHTML='<div class="osi-v2-empty"><b>'+esc(emptyTitle)+'</b><span>'+esc(emptyBody)+'</span></div>';
    }else{
      host.innerHTML=visible.map(function(item){
        var proof=hasOpenProof(item)?'Memo anchored':((item.proof_log||[]).length?'Proof recorded':'Awaiting proof');
        return '<button class="osi-v2-row" type="button" data-case-ref="'+esc(item.public_ref)+'">'
          +'<span class="osi-v2-id">'+esc(item.public_ref)+'</span>'
          +'<span class="osi-v2-title"><b>'+esc(item.title)+'</b><span>'+esc(item.summary)+'</span></span>'
          +'<span class="osi-v2-stage '+stageClass(item)+'">'+esc(label(item.stage))+'</span>'
          +'<span class="osi-v2-category">'+esc(label(item.category))+'</span>'
          +'<span class="osi-v2-reviews">'+countActiveReviews(item)+'</span>'
          +'<span class="osi-v2-proof">'+esc(proof)+'</span><span class="osi-v2-arrow">›</span></button>';
      }).join('');
      Array.prototype.forEach.call(host.querySelectorAll('[data-case-ref]'),function(button){
        button.addEventListener('click',function(){osiV2OpenCase(button.getAttribute('data-case-ref'));});
      });
    }
    var count=document.getElementById('fo-count');
    if(count) count.textContent=rows.length+' real '+(rows.length===1?'Case':'Cases');
    var nav=document.getElementById('fo-pnav');
    if(nav){
      nav.innerHTML=pages>1?'<button type="button" data-page="prev">Prev</button><span class="mono">'+state.page+' / '+pages+'</span><button type="button" data-page="next">Next</button>':'';
      Array.prototype.forEach.call(nav.querySelectorAll('button'),function(button){button.addEventListener('click',function(){state.page+=button.dataset.page==='next'?1:-1;state.page=Math.max(1,Math.min(pages,state.page));drawCases();});});
    }
    drawStats(rows);
  }
  function drawStats(rows){
    var stats=document.getElementById('field-stats');
    if(!stats) return;
    var proofCount=rows.reduce(function(total,item){return total+(item.proof_log||[]).length;},0);
    var openCount=rows.filter(function(item){return item.stage==='open_public';}).length;
    stats.innerHTML='<div class="osi-stat"><span>Visible</span><b>'+rows.length+'</b></div><div class="osi-stat"><span>Open public</span><b>'+openCount+'</b></div><div class="osi-stat"><span>Proof entries</span><b>'+proofCount+'</b></div>';
    var deck=document.getElementById('fo-deck'); if(deck) deck.hidden=true;
    var preview=document.getElementById('fo-preview');
    if(preview) preview.innerHTML='<div class="fo-prev-empty mono">Select a Case for evidence, reviews, Proof Log, and lifecycle prerequisites.</div>';
  }
  async function loadPublicCases(){
    var token=++state.loadToken;
    state.mode='public';state.actorRole='public';state.page=1;setFieldCopy('public');setLoading();
    try{
      var result=await api(READ_URL,{op:'list_public_cases'});
      if(token!==state.loadToken) return;
      state.cases=result.cases||[];drawCases();
    }catch(error){
      if(token!==state.loadToken) return;
      var host=document.getElementById('field-cases');
      if(host) host.innerHTML='<div class="osi-v2-empty osi-v2-error"><b>Public registry unavailable</b><span>'+esc(userError(error))+'</span></div>';
    }
  }
  async function openSignedCollection(mode){
    showView('field');
    var token=++state.loadToken;
    state.mode=mode;state.page=1;state.stage='all';setFieldCopy(mode);setLoading();
    try{
      var result=mode==='mine'
        ? await signedRead('CASE_READ_MY_CASES','list_my_cases')
        : await signedRead('CASE_READ_REVIEW_QUEUE','list_reviewable_cases');
      if(token!==state.loadToken) return;
      state.actorRole=result.actor_role||(mode==='mine'?'owner':'analyst');
      state.cases=result.cases||[];drawCases();
      await refreshCapabilities();
    }catch(error){
      if(token!==state.loadToken) return;
      var host=document.getElementById('field-cases');
      if(host) host.innerHTML='<div class="osi-v2-empty osi-v2-error"><b>Authorized workspace locked</b><span>'+esc(userError(error))+'</span></div>';
    }
  }

  async function refreshCapabilities(){
    if(!walletPubkey){state.capabilities=null;setAdminVisibility(false);return null;}
    try{
      state.capabilities=await api(WRITE_URL,{op:'actor_capabilities',wallet:walletPubkey});
      setAdminVisibility(state.capabilities.maintainer_access===true);
      return state.capabilities;
    }catch(error){state.capabilities=null;setAdminVisibility(false);return null;}
  }
  function setAdminVisibility(allowed){
    var button=document.getElementById('admLockBtn')||document.getElementById('adminBtn')||document.getElementById('admin-btn');
    if(button) button.style.display=allowed?'':'none';
  }

  async function fieldOpenFormV2(){
    state.modalReturnFocus=document.activeElement;
    try{
      await ensureWallet();
      var capabilities=await refreshCapabilities();
      if(!capabilities||capabilities.case_writes_enabled!==true)throw new Error('case_writes_disabled');
      var modal=document.getElementById('fo-modal'); if(modal) modal.classList.add('open');
      syncBodyLock();
      setTimeout(function(){var title=document.getElementById('v2-case-title');if(title)title.focus();},80);
    }catch(error){showToast(userError(error));restoreFocus(state.modalReturnFocus);state.modalReturnFocus=null;}
  }
  function syncBodyLock(){
    var modal=document.getElementById('fo-modal');
    var drawer=document.getElementById('osi-case-drawer');
    document.body.style.overflow=(modal&&modal.classList.contains('open'))||(drawer&&!drawer.hidden)?'hidden':'';
  }
  function restoreFocus(node){if(node&&document.contains(node)&&typeof node.focus==='function')setTimeout(function(){node.focus();},0);}
  function fieldCloseFormV2(){
    var modal=document.getElementById('fo-modal');if(modal)modal.classList.remove('open');
    syncBodyLock();restoreFocus(state.modalReturnFocus);state.modalReturnFocus=null;
  }
  function lines(id,kind){
    var input=document.getElementById(id);if(!input)return[];
    return String(input.value||'').split(/[\n,]+/).map(function(value){return value.trim();}).filter(Boolean).map(function(ref){return{kind:kind,ref:ref};});
  }
  function casePayload(){
    var sol=Number(document.getElementById('v2-case-reward').value||0);
    return {
      category:document.getElementById('v2-case-category').value,
      title:document.getElementById('v2-case-title').value,
      summary_public:document.getElementById('v2-case-summary').value,
      details_restricted:document.getElementById('v2-case-details').value,
      reward_intent_lamports:sol>0?Math.round(sol*1000000000):null,
      evidence:lines('v2-case-wallets','wallet').concat(lines('v2-case-transactions','onchain_tx'),lines('v2-case-urls','url'))
    };
  }
  function formStatus(text,kind){var node=document.getElementById('v2-case-form-status');if(node){node.textContent=text||'';node.className='osi-form-status mono '+(kind||'');}}
  async function commitWithConfirmation(body){
    var lastError;
    for(var attempt=0;attempt<5;attempt++){
      try{return await api(WRITE_URL,body);}catch(error){lastError=error;if(String(error.message)!=='transaction_not_confirmed')throw error;await new Promise(function(resolve){setTimeout(resolve,1600+attempt*900);});}
    }
    throw lastError;
  }
  async function submitCase(event){
    if(event)event.preventDefault();
    var form=document.getElementById('field-form');if(!form||!form.reportValidity())return;
    var button=document.getElementById('v2-case-submit');button.disabled=true;
    try{
      var wallet=await ensureWallet();
      var payload=casePayload();
      if(payload.evidence.length>12) throw new Error('A Case can include at most 12 structured evidence references.');
      if(!state.caseIdempotency)state.caseIdempotency=randomKey('case');
      formStatus('Preparing an exact, single-use submission proof...');
      var prepared=await api(WRITE_URL,{op:'prepare_case',wallet:wallet,case:payload,idempotency_key:state.caseIdempotency});
      formStatus('Approve the CASE_SUBMITTED Memo in your wallet. OSI receives no funds.');
      var txSig=await castOnchainVote(prepared.memo);
      formStatus('Confirming the exact signer, Memo, target, payload hash, and mainnet transaction...');
      var committed=await commitWithConfirmation({op:'commit_case',wallet:wallet,case:payload,nonce:prepared.nonce,memo:prepared.memo,tx_sig:txSig});
      formStatus('Private Case created with an immutable submission receipt.','success');
      showToast('Case '+committed.case.public_ref+' is private and awaiting eligible analyst or full maintainer review.');
      state.caseIdempotency='';form.reset();
      setTimeout(function(){fieldCloseFormV2();osiV2OpenMyCases();},650);
    }catch(error){formStatus(userError(error),'error');}
    finally{button.disabled=false;}
  }

  var tabs=[['overview','Overview'],['evidence','Evidence'],['reports','Reports'],['reviews','Reviews'],['resolution','Resolution & Challenges'],['proof','Proof Log'],['reward','Reward & Support']];
  async function openCase(publicRef){
    var item=state.cases.find(function(entry){return entry.public_ref===publicRef;});
    try{
      if(!item||state.mode==='public'){
        var result=await api(READ_URL,{op:'get_public_case',public_ref:publicRef});item=result.case;
      }
      state.current=item;state.tab='overview';
      var drawer=document.getElementById('osi-case-drawer');
      if(drawer.hidden)state.drawerReturnFocus=document.activeElement;
      drawer.hidden=false;document.body.classList.add('osi-case-open');syncBodyLock();
      document.getElementById('osi-case-ref').textContent=item.public_ref;
      document.getElementById('osi-case-title').textContent=item.title;
      document.getElementById('osi-case-state').innerHTML='<span class="osi-chip '+esc(item.visibility)+'">'+esc(label(item.visibility))+'</span><span class="osi-chip">'+esc(label(item.stage))+'</span><span class="osi-chip">'+esc(label(item.category))+'</span>';
      drawTabs();renderTab();renderActions();
      setTimeout(function(){var close=drawer.querySelector('.osi-case-close');if(close)close.focus();},30);
    }catch(error){showToast(userError(error));}
  }
  function closeCase(){var drawer=document.getElementById('osi-case-drawer');if(drawer)drawer.hidden=true;document.body.classList.remove('osi-case-open');syncBodyLock();state.current=null;restoreFocus(state.drawerReturnFocus);state.drawerReturnFocus=null;}
  function drawTabs(){
    var host=document.getElementById('osi-case-tabs');
    host.setAttribute('role','tablist');
    host.innerHTML=tabs.map(function(tab){var active=tab[0]===state.tab;return'<button class="osi-case-tab '+(active?'active':'')+'" type="button" role="tab" aria-selected="'+active+'" tabindex="'+(active?'0':'-1')+'" data-tab="'+tab[0]+'">'+esc(tab[1])+'</button>';}).join('');
    Array.prototype.forEach.call(host.querySelectorAll('[data-tab]'),function(button){
      button.addEventListener('click',function(){state.tab=button.dataset.tab;drawTabs();renderTab();});
      button.addEventListener('keydown',function(event){
        var keys=['ArrowLeft','ArrowRight','Home','End'];if(keys.indexOf(event.key)<0)return;
        event.preventDefault();var current=tabs.findIndex(function(tab){return tab[0]===state.tab;});
        var next=event.key==='Home'?0:event.key==='End'?tabs.length-1:event.key==='ArrowLeft'?(current-1+tabs.length)%tabs.length:(current+1)%tabs.length;
        state.tab=tabs[next][0];drawTabs();renderTab();
        var target=host.querySelector('[data-tab="'+state.tab+'"]');if(target)target.focus();
      });
    });
  }
  function emptySection(title,text){return'<section class="osi-case-section"><h3>'+esc(title)+'</h3><div class="osi-v2-empty"><b>Nothing recorded</b><span>'+esc(text)+'</span></div></section>';}
  function overview(item){
    var restricted=item.details_restricted?'<div class="osi-case-note"><b>Restricted intake detail</b><br>'+esc(item.details_restricted)+'</div>':'';
    return '<section class="osi-case-section"><h3>Case overview</h3><div class="osi-case-meta"><div><span>Reference</span><b>'+esc(item.public_ref)+'</b></div><div><span>Created</span><b>'+esc(dateText(item.created_at))+'</b></div><div><span>Stage</span><b>'+esc(label(item.stage))+'</b></div><div><span>Visibility</span><b>'+esc(label(item.visibility))+'</b></div></div><p>'+esc(item.summary)+'</p>'+restricted+'<div class="osi-case-note">OSI records attributable process. It does not determine guilt, legal certainty, truth, custody, recovery, or guaranteed payment.</div></section>';
  }
  function evidence(item){
    var rows=item.evidence||[];if(!rows.length)return emptySection('Evidence','No evidence reference is public in this projection. Private pending evidence never leaks through the anonymous API.');
    return '<section class="osi-case-section"><h3>Evidence</h3><div class="osi-list">'+rows.map(function(row){return'<div class="osi-list-item"><div class="osi-list-item-head"><b>'+esc(label(row.kind))+'</b><span class="mono">sha256 '+esc(short(row.sha256))+'</span></div><div class="osi-evidence-ref">'+esc(row.ref)+'</div></div>';}).join('')+'</div><div class="osi-case-note">A reference is evidence material, not automatic proof of a claim. Public items require their own moderation state.</div></section>';
  }
  function reports(item){
    var rows=item.reports||[];if(!rows.length)return emptySection('Reports','Case Report intake is the next gated V2 slice. No placeholder Report is shown as functional.');
    return '<section class="osi-case-section"><h3>Reports</h3><div class="osi-list">'+rows.map(function(row){return'<div class="osi-list-item"><b>'+esc(label(row.status))+'</b><p>'+(row.published?'Published exact version':'No published version')+'</p></div>';}).join('')+'</div></section>';
  }
  function reviews(item){
    var rows=item.reviews||[];
    var list=rows.length?'<div class="osi-list">'+rows.map(function(row){return'<div class="osi-list-item"><div class="osi-list-item-head"><b>'+esc(short(row.reviewer_wallet))+' · '+esc(label(row.decision))+'</b><span class="osi-proof-label">'+esc(row.proof_label)+'</span></div><p>'+esc(label(row.reviewer_role))+' · weight '+esc(row.weight)+' · '+esc(dateText(row.created_at))+'</p>'+(row.reason_code?'<p>Reason code: '+esc(row.reason_code)+'</p>':'')+'</div>';}).join('')+'</div>':'<div class="osi-v2-empty"><b>Awaiting initial review</b><span>No eligible reviewer has recorded a decision yet.</span></div>';
    return '<section class="osi-case-section"><h3>Initial reviews</h3>'+list+'<div id="osi-review-compose"></div></section>';
  }
  function resolution(){return'<section class="osi-case-section"><h3>Resolution & Challenges</h3><div class="osi-case-meta"><div><span>Resolution</span><b>Not proposed</b></div><div><span>Challenge window</span><b>Not opened</b></div></div><div class="osi-case-note">Report review, exact-version resolution, seven-day challenge handling, and sealing are later gated slices. Controls remain disabled until their real typed endpoints exist.</div></section>';}
  function proof(item){
    var rows=item.proof_log||[];if(!rows.length)return emptySection('Proof Log','No verified receipt has been recorded for this Case.');
    return '<section class="osi-case-section"><h3>Proof Log</h3><div class="osi-list">'+rows.map(function(row){var good=row.label!=='Legacy / not server-verified';var link=row.solscan_url&&/^https:\/\/solscan\.io\/tx\/[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(row.solscan_url)?'<a class="osi-proof-link" href="'+esc(row.solscan_url)+'" target="_blank" rel="noopener">Verify on Solscan ↗</a>':'';return'<div class="osi-list-item"><div class="osi-list-item-head"><b>'+esc(label(row.event_type))+'</b><span class="osi-proof-label '+(good?'':'legacy')+'">'+esc(row.label)+'</span></div><p>Actor '+esc(short(row.actor_wallet))+' · '+esc(label(row.actor_role))+' · '+esc(row.decision||'recorded')+' · '+esc(dateText(row.occurred_at))+'</p>'+link+'</div>';}).join('')+'</div><div class="osi-case-note">A wallet-signed receipt is server-verified but is not on-chain. Only rows with a confirmed transaction link are labeled Memo-anchored on Solana.</div></section>';
  }
  function reward(item){
    var intent=item.reward_intent_lamports?Number(item.reward_intent_lamports)/1000000000:null;
    return '<section class="osi-case-section"><h3>Reward & Support</h3><div class="osi-case-meta"><div><span>Non-binding owner intent</span><b>'+(intent?esc(intent+' SOL'):'None recorded')+'</b></div><div><span>Confirmed payment</span><b>None</b></div></div><div class="osi-case-note">Reward intent is not a pledge or payment. OSI never takes custody. A paid state requires a resolved winner and RPC-confirmed direct wallet-to-wallet transfer. Voluntary support is separate and cannot affect ranking or governance.</div></section>';
  }
  function renderTab(){
    var item=state.current;if(!item)return;
    var html=state.tab==='overview'?overview(item):state.tab==='evidence'?evidence(item):state.tab==='reports'?reports(item):state.tab==='reviews'?reviews(item):state.tab==='resolution'?resolution(item):state.tab==='proof'?proof(item):reward(item);
    var content=document.getElementById('osi-case-content');content.setAttribute('role','tabpanel');content.innerHTML=html;
  }
  function activeOpeningRoute(item){
    var wallet=String(walletPubkey||'');var caps=state.capabilities||{};
    var own=(item.reviews||[]).find(function(row){return row.is_active===true&&row.decision==='approve_open'&&String(row.reviewer_wallet)===wallet;});
    if(!own)return'';
    if(own.reviewer_role==='maintainer')return caps.maintainer_access===true?'maintainer':'';
    var approvals=(item.reviews||[]).filter(function(row){return row.is_active===true&&row.reviewer_role==='analyst'&&row.decision==='approve_open';});
    return caps.analyst_eligible===true&&approvals.length>=1&&approvals.reduce(function(sum,row){return sum+Number(row.weight||0);},0)>=0.5?'analyst':'';
  }
  function renderActions(){
    var host=document.getElementById('osi-case-actions');var item=state.current;if(!host||!item)return;
    if(state.mode==='review'&&item.visibility==='private'){
      var openingRoute=activeOpeningRoute(item);
      host.innerHTML='<span class="osi-action-help">Reviews use signMessage. Public opening requires either the analyst threshold or a full double-gated maintainer approval, then a separate confirmed Solana Memo. It authorizes public investigation only; it does not determine truth or guilt.</span><button class="osi-action" type="button" onclick="osiV2ComposeReview()">Record review</button>'+(openingRoute?'<button class="osi-action primary" type="button" onclick="osiV2AnchorOpen()">Anchor public open</button>':'');
    }else if(item.visibility==='private'){
      host.innerHTML='<span class="osi-action-help">Private and awaiting an eligible analyst or full maintainer review. Case owners cannot self-review.</span><button class="osi-action" disabled title="Requires an eligible analyst or full maintainer">Awaiting review</button>';
    }else{
      host.innerHTML='<span class="osi-action-help">Public because the open outcome has a confirmed canonical Memo receipt.</span><button class="osi-action" type="button" onclick="osiV2ShowTab(\'proof\')">Inspect proof</button>';
    }
  }
  async function composeReview(){
    state.tab='reviews';drawTabs();renderTab();
    var caps=state.capabilities||await refreshCapabilities()||{};
    var host=document.getElementById('osi-review-compose');if(!host)return;
    var route=caps.analyst_eligible?'analyst':'maintainer';
    var routeChoices=caps.analyst_eligible&&caps.maintainer_access?'<label>Credential route<select id="osi-review-route"><option value="analyst">Counted analyst review</option><option value="maintainer">Full maintainer initial-open review</option></select></label>':'<input id="osi-review-route" type="hidden" value="'+route+'">';
    host.innerHTML='<div class="osi-review-form"><div class="osi-review-route">'+(route==='analyst'?'This decision uses the server-derived analyst weight.':'The full maintainer path has analyst weight 0 but independently authorizes initial open after both maintainer gates pass.')+' Opening starts a public investigation; it is not a truth or guilt decision.</div>'+routeChoices+'<label>Decision<select id="osi-review-decision"><option value="approve_open">Approve public open</option><option value="needs_more">Needs more evidence</option></select></label><label>Reason code<select id="osi-review-reason"><option value="public_scope_clear">Public scope clear</option><option value="needs_more_evidence">Needs more evidence</option><option value="unsafe_or_prohibited">Unsafe or prohibited</option><option value="duplicate_or_out_of_scope">Duplicate or out of scope</option></select></label><p class="osi-action-help">A rejection outcome is unavailable until its separate quorum transition is implemented.</p><button class="osi-action primary" id="osi-review-submit" type="button">Sign and record review</button><div class="osi-form-status mono" id="osi-review-status" role="status"></div></div>';
    document.getElementById('osi-review-submit').addEventListener('click',submitReview);
  }
  function reviewStatus(text,kind){var node=document.getElementById('osi-review-status');if(node){node.textContent=text;node.className='osi-form-status mono '+(kind||'');}}
  async function submitReview(){
    if(state.reviewBusy||!state.current)return;
    state.reviewBusy=true;var button=document.getElementById('osi-review-submit');if(button)button.disabled=true;
    try{
      var wallet=await ensureWallet();var route=document.getElementById('osi-review-route').value;
      var review={case_ref:state.current.public_ref,decision:document.getElementById('osi-review-decision').value,reason_code:document.getElementById('osi-review-reason').value};
      if(route==='maintainer'&&review.decision!=='approve_open')throw new Error('The full maintainer path can only record approve_open.');
      reviewStatus('Preparing an exact single-use review message...');
      var prepared=await api(WRITE_URL,{op:'prepare_review',wallet:wallet,route:route,review:review,idempotency_key:randomKey('review')});
      reviewStatus('Sign the review message. This is not an on-chain transaction.');
      var signature=await signMessage(prepared.message);
      var committed=await api(WRITE_URL,{op:'commit_review',wallet:wallet,route:route,review:review,nonce:prepared.nonce,message:prepared.message,signature:signature});
      reviewStatus('Review recorded as wallet-signed and server-verified.','success');
      showToast('Initial review recorded.');
      await openSignedCollection('review');
      var refreshed=state.cases.find(function(item){return item.public_ref===review.case_ref;});
      if(refreshed)await openCase(refreshed.public_ref);
      if(committed.actor_open_ready&&review.decision==='approve_open'&&confirm('This initial-open path is ready. Anchor CASE_OPENED on Solana now? This uses only the standard network fee.')) await anchorOpen(route);
    }catch(error){reviewStatus(userError(error),'error');}
    finally{state.reviewBusy=false;if(button)button.disabled=false;}
  }
  async function anchorOpen(route){
    if(state.reviewBusy||!state.current)return;
    state.reviewBusy=true;
    try{
      var wallet=await ensureWallet();var ref=state.current.public_ref;
      route=route||activeOpeningRoute(state.current);
      if(!route)throw new Error('not_eligible_reviewer');
      showToast('Preparing the canonical CASE_OPENED Memo...');
      var prepared=await api(WRITE_URL,{op:'prepare_open',wallet:wallet,route:route,case_ref:ref,idempotency_key:randomKey('open')});
      var txSig=await castOnchainVote(prepared.memo);
      var committed=await commitWithConfirmation({op:'commit_open',wallet:wallet,route:route,case_ref:ref,nonce:prepared.nonce,memo:prepared.memo,tx_sig:txSig});
      showToast('Case '+committed.case.public_ref+' is now public with confirmed Memo proof.');
      closeCase();await loadPublicCases();await openCase(ref);
    }catch(error){showToast(userError(error));}
    finally{state.reviewBusy=false;}
  }

  var legacyAdminUpdate=window.updateAdminButton;
  window.updateAdminButton=function(){
    if(location.pathname.toLowerCase().endsWith('/legacy.html')){if(typeof legacyAdminUpdate==='function')legacyAdminUpdate();return;}
    setAdminVisibility(false);refreshCapabilities();
  };
  window.renderFieldOffice=loadPublicCases;
  window.fieldOpenForm=fieldOpenFormV2;
  window.fieldCloseForm=fieldCloseFormV2;
  window.fieldMine=function(mine){if(mine)openSignedCollection('mine');else loadPublicCases();};
  window.fieldSearch=function(value){state.query=String(value||'');state.page=1;drawCases();};
  window.fieldFilter=function(value){state.stage=String(value||'all');state.page=1;drawCases();};
  window.fieldSort=function(value){state.sort=String(value||'newest');drawCases();};
  window.osiV2OpenMyCases=function(){openSignedCollection('mine');};
  window.osiV2OpenReviewQueue=function(){openSignedCollection('review');};
  window.osiV2SubmitCase=submitCase;
  window.osiV2OpenCase=openCase;
  window.osiV2CloseCase=closeCase;
  window.osiV2ShowTab=function(tab){state.tab=tab;drawTabs();renderTab();};
  window.osiV2ComposeReview=composeReview;
  window.osiV2AnchorOpen=anchorOpen;

  function trapFocus(event,root){
    if(event.key!=='Tab'||!root)return;
    var nodes=Array.prototype.filter.call(root.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'),function(node){return node.offsetParent!==null;});
    if(!nodes.length)return;
    var first=nodes[0],last=nodes[nodes.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
  document.addEventListener('keydown',function(event){
    var modal=document.getElementById('fo-modal');var drawer=document.getElementById('osi-case-drawer');
    if(event.key==='Escape'){
      if(modal&&modal.classList.contains('open'))fieldCloseFormV2();
      else if(drawer&&!drawer.hidden)closeCase();
      return;
    }
    if(modal&&modal.classList.contains('open'))trapFocus(event,modal);
    else if(drawer&&!drawer.hidden)trapFocus(event,drawer);
  });
  setAdminVisibility(false);
})();
