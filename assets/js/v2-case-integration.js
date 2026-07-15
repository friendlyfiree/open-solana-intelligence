/* Native V2 Case lifecycle for the mature OSI root experience. */
(function(){
  'use strict';

  var READ_URL = SUPABASE_URL + '/functions/v1/osi-v2-case-read';
  var WRITE_URL = SUPABASE_URL + '/functions/v1/osi-v2-case-write';
  var GOVERNANCE_URL = SUPABASE_URL + '/functions/v1/osi-v2-governance-write';
  var PAGE_SIZE = 12;
  var state = {
    cases: [], mode: 'public', actorRole: 'public', query: '', stage: 'open_public',
    sort: 'newest', page: 1, loadToken: 0, current: null, tab: 'overview',
    capabilities: null, caseIdempotency: '', reviewBusy: false, reviewTasks: {},
    modalReturnFocus: null, drawerReturnFocus: null, governanceBusy: false
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
  function hasBlockingChallenge(item){
    return !!(item&&item.governance&&(item.governance.challenges||[]).some(function(challenge){return challenge.blocking===true;}));
  }
  function isSealReady(item){
    var resolution=item&&item.governance&&item.governance.resolution;
    return !!(resolution&&resolution.state==='in_challenge_window'
      && resolution.seal_quorum&&resolution.seal_quorum.ready===true
      && new Date(resolution.challenge_window_closes_at).getTime()<=Date.now()
      && !hasBlockingChallenge(item));
  }
  function stageLabel(value,item){
    if(hasBlockingChallenge(item))return 'Challenge active';
    if(isSealReady(item))return 'Seal ready';
    return ({draft:'Private intake',submitted:'Private intake',initial_review:'Initial review',
      open_public:'Public investigation',in_review:'Reports under review',
      ready_for_finalization:'Resolution selection',resolution_proposed:'Resolution selection',
      in_challenge_window:'Challenge window',resolved:'Seal ready',sealed:'Sealed',
      reopened:'Resolution selection'})[value]||label(value);
  }
  function dateText(value){
    var date=new Date(value||'');
    return isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
  }
  function countdownText(value){
    var end=new Date(value||'').getTime();if(!Number.isFinite(end))return'Window unavailable';
    var remaining=Math.max(0,end-Date.now());
    if(remaining===0)return'Window ended';
    var days=Math.floor(remaining/86400000);var hours=Math.floor((remaining%86400000)/3600000);
    var minutes=Math.max(1,Math.floor((remaining%3600000)/60000));
    return(days?days+'d ':'')+(hours?hours+'h ':days?'':minutes+'m ')+'remaining';
  }
  function nextStepText(item){
    if(item.visibility==='private')return'Await an eligible analyst or full double-gated maintainer initial-open review.';
    if(hasBlockingChallenge(item))return'Resolve the admitted challenge before any process seal.';
    if(isSealReady(item))return'Collect full maintainer finalization for the analyst-ready process seal.';
    return({open_public:'Submit and publish an exact immutable Case Report.',
      in_review:'Complete independent Report publication and resolution-selection review.',
      ready_for_finalization:'Reach a unique count-and-weight leader, then use full maintainer finalization.',
      resolution_proposed:'Open the server-timed challenge window.',
      in_challenge_window:'Wait for the seven-day window, review challenges, and collect seal quorum.',
      reopened:'Begin a new exact-version resolution selection cycle.',
      sealed:'Inspect the retained resolution, challenge history, and Proof Log.'})[item.stage]||'Inspect the current stage and its authorized action.';
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
      ,resolution_lifecycle_writes_disabled:'Resolution and challenge writes are safely disabled while rollout checks are incomplete.'
      ,resolution_lifecycle_writes_disabled_or_unavailable:'Resolution and challenge writes are safely disabled or temporarily unavailable.'
      ,not_authorized_or_conflicted:'This wallet is not eligible for this exact action or has a Case, Report, or challenge conflict.'
      ,not_eligible_analyst:'This action requires an eligible server-derived analyst.'
      ,active_challenge_exists:'This wallet already has an active challenge for the exact resolution.'
      ,rate_limited_or_cooldown:'Challenge rate or cooldown limit is active. Wait before trying again.'
      ,governance_state_changed_retry:'The exact governance state changed. Review the latest tally and start again.'
      ,challenge_maintenance_unavailable:'Challenge deadline maintenance is temporarily unavailable, so writes remain fail-closed.'
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
  function drawReviewTasks(host){
    var groups=state.reviewTasks||{};
    var lanes=[['report_publication','Report publication reviews'],['resolution_selection','Resolution selection'],['challenge_admissibility','Challenge admissibility'],['challenge_adjudication','Challenge adjudication'],['seal_reviews','Seal reviews']];
    var total=lanes.reduce(function(sum,lane){return sum+(groups[lane[0]]||[]).length;},0);
    host.innerHTML='<div class="osi-review-lanes">'+lanes.map(function(lane){
      var tasks=groups[lane[0]]||[];
      return'<section class="osi-review-lane"><header><h3>'+esc(lane[1])+'</h3><span>'+tasks.length+'</span></header>'+(tasks.length?tasks.map(function(task){
        return'<button class="osi-review-task" type="button" data-case-ref="'+esc(task.case_ref)+'"><div><span>'+esc(task.exact_target)+'</span><b>'+esc(task.next_action)+'</b></div><dl><div><dt>Deadline</dt><dd>'+esc(task.deadline?dateText(task.deadline):'No separate deadline')+'</dd></div><div><dt>Conflict</dt><dd class="'+(task.conflict?'warn':'ok')+'">'+(task.conflict?'Excluded':'Clear')+'</dd></div><div><dt>Current vote</dt><dd>'+esc(task.current_vote||'None')+'</dd></div><div><dt>Weight</dt><dd>'+esc(task.weight_snapshot==null?'Not counted':Number(task.weight_snapshot).toFixed(2))+'</dd></div></dl></button>';
      }).join(''):'<div class="osi-review-lane-empty">No authorized tasks in this lane.</div>')+'</section>';
    }).join('')+'</div>';
    Array.prototype.forEach.call(host.querySelectorAll('[data-case-ref]'),function(button){button.addEventListener('click',function(){osiV2OpenCase(button.getAttribute('data-case-ref'));});});
    var count=document.getElementById('fo-count');if(count)count.textContent=total+' real '+(total===1?'task':'tasks');
    var nav=document.getElementById('fo-pnav');if(nav)nav.innerHTML='';
    drawStats(state.cases);
  }
  function drawCases(){
    var host=document.getElementById('field-cases');
    if(!host) return;
    if(state.mode==='review'){drawReviewTasks(host);return;}
    var rows=state.cases.slice();
    var query=state.query.toLowerCase();
    if(query) rows=rows.filter(function(item){return [item.public_ref,item.title,item.summary,item.category].join(' ').toLowerCase().includes(query);});
    if(state.stage!=='all'){
      rows=rows.filter(function(item){
        if(state.stage==='private_intake')return item.stage==='draft'||item.stage==='submitted';
        if(state.stage==='resolution_selection')return item.stage==='ready_for_finalization'||item.stage==='resolution_proposed'||item.stage==='reopened';
        if(state.stage==='challenge_active')return hasBlockingChallenge(item);
        if(state.stage==='in_challenge_window')return item.stage==='in_challenge_window'&&!hasBlockingChallenge(item)&&!isSealReady(item);
        if(state.stage==='resolved')return item.stage==='resolved'||isSealReady(item);
        return item.stage===state.stage;
      });
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
          +'<span class="osi-v2-stage '+stageClass(item)+'">'+esc(stageLabel(item.stage,item))+'</span>'
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
      state.cases=result.cases||[];state.reviewTasks={};drawCases();
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
      state.cases=result.cases||[];state.reviewTasks=result.review_tasks||{};drawCases();
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
      var results=await Promise.all([
        api(WRITE_URL,{op:'actor_capabilities',wallet:walletPubkey}),
        api(GOVERNANCE_URL,{op:'actor_capabilities',wallet:walletPubkey})
      ]);
      state.capabilities=Object.assign({},results[0],results[1]);
      if(typeof setMaintainerServerGate==='function') setMaintainerServerGate(state.capabilities.maintainer_access===true,state.capabilities.maintainer_gate||'denied');
      setAdminVisibility(state.capabilities.maintainer_access===true);
      return state.capabilities;
    }catch(error){state.capabilities=null;if(typeof setMaintainerServerGate==='function')setMaintainerServerGate(false,'unavailable');setAdminVisibility(false);return null;}
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
  async function commitWithConfirmation(body,url){
    var lastError;
    for(var attempt=0;attempt<5;attempt++){
      try{return await api(url||WRITE_URL,body);}catch(error){lastError=error;if(String(error.message)!=='transaction_not_confirmed')throw error;await new Promise(function(resolve){setTimeout(resolve,1600+attempt*900);});}
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

  var tabs=[['overview','Overview'],['evidence','Evidence'],['reports','Reports'],['resolution','Resolution'],['challenges','Challenges'],['proof','Proof Log']];
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
      document.getElementById('osi-case-state').innerHTML='<span class="osi-chip '+esc(item.visibility)+'">'+esc(label(item.visibility))+'</span><span class="osi-chip">'+esc(stageLabel(item.stage,item))+'</span><span class="osi-chip">'+esc(label(item.category))+'</span>';
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
    var active=(item.reviews||[]).filter(function(review){return review.is_active===true;});
    var initial=active.length?'<div class="osi-governance-mini"><b>Initial review</b><span>'+active.length+' active attributable '+(active.length===1?'review':'reviews')+'</span></div>':'';
    return '<section class="osi-case-section"><h3>Case overview</h3><div class="osi-case-meta"><div><span>Reference</span><b>'+esc(item.public_ref)+'</b></div><div><span>Created</span><b>'+esc(dateText(item.created_at))+'</b></div><div><span>Stage</span><b>'+esc(stageLabel(item.stage,item))+'</b></div><div><span>Visibility</span><b>'+esc(label(item.visibility))+'</b></div></div><p>'+esc(item.summary)+'</p><div class="osi-governance-mini"><b>Exact next step</b><span>'+esc(nextStepText(item))+'</span></div>'+initial+restricted+'<div class="osi-case-note">OSI records attributable, human-reviewed and challengeable process. It does not determine guilt, legal certainty, truth, custody, recovery, or guaranteed payment.</div></section>';
  }
  function evidence(item){
    var rows=item.evidence||[];if(!rows.length)return emptySection('Evidence','No evidence reference is public in this projection. Private pending evidence never leaks through the anonymous API.');
    return '<section class="osi-case-section"><h3>Evidence</h3><div class="osi-list">'+rows.map(function(row){return'<div class="osi-list-item"><div class="osi-list-item-head"><b>'+esc(label(row.kind))+'</b><span class="mono">sha256 '+esc(short(row.sha256))+'</span></div><div class="osi-evidence-ref">'+esc(row.ref)+'</div></div>';}).join('')+'</div><div class="osi-case-note">A reference is evidence material, not automatic proof of a claim. Public items require their own moderation state.</div></section>';
  }
  function reports(item){
    if(typeof window.osiReportRenderSection==='function')return window.osiReportRenderSection(item);
    var rows=item.reports||[];if(!rows.length)return emptySection('Reports','Report data is temporarily unavailable.');
    return '<section class="osi-case-section"><h3>Reports</h3><div class="osi-list">'+rows.map(function(row){return'<div class="osi-list-item"><b>'+esc(label(row.status))+'</b><p>'+(row.published?'Published exact version':'No published version')+'</p></div>';}).join('')+'</div></section>';
  }
  function reviews(item){
    var rows=item.reviews||[];
    var list=rows.length?'<div class="osi-list">'+rows.map(function(row){return'<div class="osi-list-item"><div class="osi-list-item-head"><b>'+esc(short(row.reviewer_wallet))+' · '+esc(label(row.decision))+'</b><span class="osi-proof-label">'+esc(row.proof_label)+'</span></div><p>'+esc(label(row.reviewer_role))+' · weight '+esc(row.weight)+' · '+esc(dateText(row.created_at))+'</p>'+(row.reason_code?'<p>Reason code: '+esc(row.reason_code)+'</p>':'')+'</div>';}).join('')+'</div>':'<div class="osi-v2-empty"><b>Awaiting initial review</b><span>No eligible reviewer has recorded a decision yet.</span></div>';
    return '<section class="osi-case-section"><h3>Initial reviews</h3>'+list+'<div id="osi-review-compose"></div></section>';
  }
  function publishedCandidates(item){
    var rows=[];
    (item.reports||[]).forEach(function(report){
      if(report.current_version&&report.current_version.version_ref)rows.push({report_ref:report.public_ref,version_ref:report.current_version.version_ref});
      (report.versions||[]).forEach(function(version){if(version.lifecycle_state==='published'&&version.version_ref)rows.push({report_ref:report.public_ref,version_ref:version.version_ref});});
    });
    return rows.filter(function(row,index){return rows.findIndex(function(other){return other.version_ref===row.version_ref;})===index;});
  }
  function progress(count,weight,requiredCount,requiredWeight){
    var value=Math.min(100,Math.min(requiredCount?count/requiredCount:0,requiredWeight?weight/requiredWeight:0)*100);
    return '<div class="osi-quorum"><div><span>'+esc(count)+' / '+esc(requiredCount)+' analysts</span><span>'+esc(Number(weight||0).toFixed(2))+' / '+esc(Number(requiredWeight||0).toFixed(2))+' weight</span></div><div class="osi-quorum-track"><i style="width:'+value+'%"></i></div></div>';
  }
  function governanceTimeline(rows){
    if(!rows||!rows.length)return'<div class="osi-v2-empty"><b>No reviews recorded</b><span>Only eligible, independent analyst reviews count.</span></div>';
    return '<div class="osi-governance-timeline">'+rows.map(function(row){return'<div class="osi-governance-event"><span class="osi-proof-label">'+esc(row.proof_label||'Wallet-signed & server-verified')+'</span><b>'+esc(short(row.reviewer_wallet))+' &middot; '+esc(label(row.decision))+'</b><p>'+esc(row.target_version_ref||label(row.phase))+' &middot; weight '+esc(Number(row.weight||0).toFixed(2))+' &middot; '+esc(dateText(row.created_at))+'</p><p>'+esc(row.public_rationale||'No public rationale recorded.')+'</p></div>';}).join('')+'</div>';
  }
  function resolution(item){
    var governance=item.governance||{};var row=governance.resolution;var candidates=publishedCandidates(item);var caps=state.capabilities||{};
    if(!candidates.length&&!row)return emptySection('Resolution','A published exact Report version is required before resolution selection can begin.');
    var quorum=row&&row.selection_quorum||{leader_count:0,leader_weight:0,required_count:item.risk_tier==='high'?3:2,required_weight:item.risk_tier==='high'?4.5:2.5};
    var candidateOptions=candidates.map(function(candidate){return'<option value="'+esc(candidate.version_ref)+'">'+esc(candidate.version_ref)+' &middot; '+esc(candidate.report_ref)+'</option>';}).join('');
    var selectionForm=caps.resolution_lifecycle_writes_enabled===true&&caps.analyst_eligible===true&&(!row||row.state==='selection_open')
      ? '<div class="osi-governance-compose"><h4>Resolution selection review</h4><label>Exact published version<select id="osi-resolution-version">'+candidateOptions+'</select></label><label>Decision<select id="osi-resolution-decision"><option value="select">Select as primary</option><option value="object">Object</option><option value="abstain">Abstain</option></select></label><label>Public rationale<textarea id="osi-resolution-rationale" maxlength="2000" placeholder="Explain the process-based selection in public-safe language."></textarea></label><label>Restricted analyst note<textarea id="osi-resolution-note" maxlength="4000" placeholder="Optional. Never returned in the public DTO."></textarea></label><button class="osi-action primary" type="button" onclick="osiV2GovernanceResolutionReview()">Sign and record review</button></div>'
      : '';
    var leader=quorum.leader_version_ref;
    var finalize=row&&row.state==='selection_open'&&caps.maintainer_access===true&&leader&&!quorum.tie_unresolved
      ? '<button class="osi-action primary" type="button" onclick="osiV2GovernanceFinalizeResolution()">Finalize server-derived leader</button>'
      : '<button class="osi-action" type="button" disabled title="Requires a unique analyst quorum leader and full maintainer double-gate">Finalize unavailable</button>';
    var seal='';
    if(row&&row.state==='in_challenge_window'){
      var ended=new Date(row.challenge_window_closes_at).getTime()<=Date.now();var blocking=(governance.challenges||[]).some(function(challenge){return challenge.blocking;});
      var sq=row.seal_quorum||{};
      seal='<div class="osi-governance-seal"><h4>Process seal</h4>'+progress(sq.approve_count||0,sq.approve_weight||0,sq.required_count||2,sq.required_weight||2.5)
        +(ended&&!blocking&&caps.analyst_eligible===true?'<button class="osi-action" type="button" onclick="osiV2GovernanceSealReview()">Sign seal review</button>':'<button class="osi-action" disabled title="Requires an ended seven-day window, no active challenge and eligible analyst">Seal review unavailable</button>')
        +(ended&&!blocking&&sq.ready&&caps.maintainer_access===true?'<button class="osi-action primary" type="button" onclick="osiV2GovernanceFinalizeSeal()">Memo-anchor process seal</button>':'')+'</div>';
    }
    return '<section class="osi-case-section"><div class="osi-section-heading"><div><span class="osi-eyebrow">Exact-version governance</span><h3>Resolution</h3></div><span class="osi-chip">'+esc(row?label(row.state):'Selection not started')+'</span></div>'
      +'<div class="osi-resolution-primary"><span>Primary Report version</span><b>'+esc(row&&row.winning_report_version_ref||leader||'Awaiting a unique quorum leader')+'</b></div>'
      +progress(quorum.leader_count||0,quorum.leader_weight||0,quorum.required_count||2,quorum.required_weight||2.5)
      +(quorum.tie_unresolved?'<div class="osi-state-message warning"><b>Tie unresolved</b><span>More independent review is required. A maintainer cannot choose between tied candidates.</span></div>':'')
      +governanceTimeline(row&&row.reviews?row.reviews.filter(function(review){return review.phase==='selection';}):[])
      +selectionForm+'<div class="osi-governance-actions">'+finalize+'</div>'+seal
      +'<div class="osi-case-note">Primary Report selected means the reviewed process chose one exact immutable version. It is not a truth, guilt, legal, recovery or payment decision.</div></section>';
  }
  function challengeOutcome(quorum){
    quorum=quorum||{};var count=Number(quorum.required_count||2),weight=Number(quorum.required_weight||2.5);
    var a={ready:Number(quorum.accept_count||0)>=count&&Number(quorum.accept_weight||0)>=weight,count:Number(quorum.accept_count||0),weight:Number(quorum.accept_weight||0)};
    var r={ready:Number(quorum.reject_count||0)>=count&&Number(quorum.reject_weight||0)>=weight,count:Number(quorum.reject_count||0),weight:Number(quorum.reject_weight||0)};
    if(a.ready&&r.ready&&a.count===r.count&&a.weight===r.weight)return'';
    if(a.ready&&(!r.ready||a.weight>r.weight||(a.weight===r.weight&&a.count>r.count)))return'accept';
    if(r.ready)return'reject';return'';
  }
  function challenges(item){
    var governance=item.governance||{};var resolution=governance.resolution;var rows=governance.challenges||[];var caps=state.capabilities||{};
    if(!resolution||resolution.state==='selection_open')return emptySection('Challenges','Challenge intake opens only after an exact primary Report version is Memo-anchored.');
    var opens=new Date(resolution.challenge_window_opens_at).getTime();var closes=new Date(resolution.challenge_window_closes_at).getTime();var active=Date.now()>=opens&&Date.now()<closes&&resolution.state==='in_challenge_window';
    var submit=active&&walletPubkey&&caps.resolution_lifecycle_writes_enabled===true
      ? '<div class="osi-governance-compose"><h4>Submit a challenge</h4><label>Public-safe summary<textarea id="osi-challenge-summary" maxlength="2000" placeholder="Describe the challenge without restricted material."></textarea></label><label>Existing evidence item ID<input id="osi-challenge-evidence" inputmode="text" placeholder="00000000-0000-0000-0000-000000000000"></label><label>Restricted detail<textarea id="osi-challenge-detail" maxlength="8000" placeholder="Optional restricted context."></textarea></label><button class="osi-action primary" type="button" onclick="osiV2GovernanceSubmitChallenge()">Sign and submit challenge</button></div>'
      : '<div class="osi-state-message"><b>Challenge intake '+(active?'requires a connected wallet':'is closed')+'</b><span>Submission alone does not block sealing. Only admitted open or under-review challenges block.</span></div>';
    var list=rows.length?'<div class="osi-challenge-list">'+rows.map(function(row){
      var controls='';var route=caps.analyst_eligible?'analyst':'maintainer';var q=row.outcome_quorum||{};
      if((row.state==='submitted'||row.state==='admissibility_review')&&(caps.analyst_eligible||caps.maintainer_access))controls='<button class="osi-action" onclick="osiV2GovernanceAdmitChallenge(\''+esc(row.public_ref)+'\',\'accept\',\''+route+'\')">Admit</button><button class="osi-action" onclick="osiV2GovernanceAdmitChallenge(\''+esc(row.public_ref)+'\',\'reject\',\''+route+'\')">Reject admission</button>';
      if((row.state==='open'||row.state==='under_review')&&caps.analyst_eligible)controls+='<button class="osi-action" onclick="osiV2GovernanceReviewChallenge(\''+esc(row.public_ref)+'\',\'accept\')">Accept review</button><button class="osi-action" onclick="osiV2GovernanceReviewChallenge(\''+esc(row.public_ref)+'\',\'reject\')">Reject review</button>';
      if(row.challenger_wallet===walletPubkey&&['submitted','admissibility_review','open','under_review'].indexOf(row.state)>=0)controls+='<button class="osi-action" onclick="osiV2GovernanceWithdrawChallenge(\''+esc(row.public_ref)+'\')">Withdraw</button>';
      if(row.state==='under_review'&&caps.analyst_eligible&&challengeOutcome(row.outcome_quorum))controls+='<button class="osi-action primary" onclick="osiV2GovernanceFinalizeChallenge(\''+esc(row.public_ref)+'\')">Memo-anchor quorum outcome</button>';
      return'<article class="osi-challenge-record"><div class="osi-list-item-head"><b>'+esc(row.public_ref)+'</b><span class="osi-chip '+(row.blocking?'warning':'')+'">'+esc(label(row.state))+' &middot; '+(row.blocking?'Blocking':'Non-blocking')+'</span></div><p>'+esc(row.public_safe_summary)+'</p><div class="osi-case-meta"><div><span>Admissibility deadline</span><b>'+esc(dateText(row.admissibility_deadline_at))+'</b></div><div><span>Review deadline</span><b>'+esc(dateText(row.review_deadline_at))+'</b></div></div>'+governanceTimeline(row.reviews)+progress(q.accept_count||0,q.accept_weight||0,q.required_count||2,q.required_weight||2.5)+'<div class="osi-governance-actions">'+controls+'</div></article>';
    }).join('')+'</div>':'<div class="osi-v2-empty"><b>No challenges recorded</b><span>The seven-day window remains independently verifiable.</span></div>';
    return'<section class="osi-case-section"><div class="osi-section-heading"><div><span class="osi-eyebrow">Seven-day window</span><h3>Challenges</h3></div><span class="osi-chip">'+esc(active?countdownText(resolution.challenge_window_closes_at)+' · closes '+dateText(resolution.challenge_window_closes_at):'Window closed')+'</span></div>'+submit+list+'<div class="osi-case-note">A normal rejection or expiry creates no automatic penalty. Bad faith requires its own separate reviewed outcome.</div></section>';
  }
  function proof(item){
    var rows=item.proof_log||[];if(!rows.length)return emptySection('Proof Log','No verified receipt has been recorded for this Case.');
    return '<section class="osi-case-section"><h3>Proof Log</h3><div class="osi-list">'+rows.map(function(row){var good=row.label!=='Legacy / not server-verified';var link=row.solscan_url&&/^https:\/\/solscan\.io\/tx\/[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(row.solscan_url)?'<a class="osi-proof-link" href="'+esc(row.solscan_url)+'" target="_blank" rel="noopener">Verify on Solscan ↗</a>':'';var ref=row.public_ref?' · '+esc(row.public_ref):'';return'<div class="osi-list-item"><div class="osi-list-item-head"><b>'+esc(label(row.event_type))+ref+'</b><span class="osi-proof-label '+(good?'':'legacy')+'">'+esc(row.label)+'</span></div><p>Actor '+esc(short(row.actor_wallet))+' · '+esc(label(row.actor_role))+' · '+esc(row.decision||'recorded')+' · '+esc(dateText(row.occurred_at))+'</p>'+link+'</div>';}).join('')+'</div><div class="osi-case-note">A wallet-signed receipt is server-verified but is not on-chain. Only rows with a confirmed transaction link are labeled Memo-anchored on Solana.</div></section>';
  }
  function reward(item){
    var intent=item.reward_intent_lamports?Number(item.reward_intent_lamports)/1000000000:null;
    return '<section class="osi-case-section"><h3>Reward & Support</h3><div class="osi-case-meta"><div><span>Non-binding owner intent</span><b>'+(intent?esc(intent+' SOL'):'None recorded')+'</b></div><div><span>Confirmed payment</span><b>None</b></div></div><div class="osi-case-note">Reward intent is not a pledge or payment. OSI never takes custody. A paid state requires a resolved winner and RPC-confirmed direct wallet-to-wallet transfer. Voluntary support is separate and cannot affect ranking or governance.</div></section>';
  }
  function renderTab(){
    var item=state.current;if(!item)return;
    var html=state.tab==='overview'?overview(item):state.tab==='evidence'?evidence(item):state.tab==='reports'?reports(item):state.tab==='resolution'?resolution(item):state.tab==='challenges'?challenges(item):proof(item);
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
      var hasGovernance=item.governance&&item.governance.resolution;
      host.innerHTML='<span class="osi-action-help">Public because the open outcome has a confirmed canonical Memo receipt. Later outcomes remain reviewed and challengeable.</span>'+(hasGovernance?'<button class="osi-action" type="button" onclick="osiV2ShowTab(\'resolution\')">Inspect resolution</button><button class="osi-action" type="button" onclick="osiV2ShowTab(\'challenges\')">Inspect challenges</button>':'')+'<button class="osi-action" type="button" onclick="osiV2ShowTab(\'proof\')">Inspect proof</button>';
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

  async function reloadGovernanceCase(caseRef){
    if(state.mode==='public')await loadPublicCases();else await openSignedCollection(state.mode);
    await openCase(caseRef);
  }
  async function governanceMutation(action,targetRef,payload){
    if(state.governanceBusy||!state.current)return;
    state.governanceBusy=true;
    var caseRef=state.current.public_ref;
    try{
      var wallet=await ensureWallet();
      var prepared=await api(GOVERNANCE_URL,{op:'prepare',action:action,wallet:wallet,target_ref:targetRef,payload:payload,idempotency_key:randomKey('governance')});
      if(prepared.already_committed){showToast('This exact governance action was already committed.');await reloadGovernanceCase(caseRef);return;}
      var body={op:'commit',action:action,wallet:wallet,nonce:prepared.nonce,payload:payload,proof_text:prepared.proof_text};
      if(prepared.proof_type==='solana_memo'){
        showToast('Approve the exact '+prepared.purpose+' Memo. Only the network fee is requested.');
        body.tx_sig=await castOnchainVote(prepared.proof_text);
        await commitWithConfirmation(body,GOVERNANCE_URL);
      }else{
        showToast('Sign the exact '+prepared.purpose+' message. This is not an on-chain transaction.');
        body.signature=await signMessage(prepared.proof_text);
        await api(GOVERNANCE_URL,body);
      }
      showToast(label(prepared.purpose)+' recorded with '+(prepared.proof_type==='solana_memo'?'Memo proof.':'wallet-signed proof.'));
      await reloadGovernanceCase(caseRef);
    }catch(error){showToast(userError(error));}
    finally{state.governanceBusy=false;}
  }
  function resolutionRow(){return state.current&&state.current.governance&&state.current.governance.resolution;}
  function fieldValue(id){var node=document.getElementById(id);return node?String(node.value||'').trim():'';}
  function governanceResolutionReview(){
    var version=fieldValue('osi-resolution-version'),decision=fieldValue('osi-resolution-decision');
    var rationale=fieldValue('osi-resolution-rationale');if(rationale.length<10){showToast('Add a public-safe rationale of at least 10 characters.');return;}
    governanceMutation('resolution_review',state.current.public_ref,{phase:'selection',report_version_ref:version,decision:decision,reason_code:'primary_report_assessment',public_rationale:rationale,private_note:fieldValue('osi-resolution-note')||null});
  }
  function governanceFinalizeResolution(){var row=resolutionRow();if(row)governanceMutation('resolution_finalize',row.public_ref,{});}
  function governanceSealReview(){
    var row=resolutionRow();if(!row)return;
    var rationale=window.prompt('Public-safe seal rationale. Explain why the exact process is complete; do not claim truth or guilt.','The exact resolution completed its challenge window with no active blocking challenge.');
    if(rationale===null)return;rationale=String(rationale).trim();if(rationale.length<10){showToast('The public-safe rationale must be at least 10 characters.');return;}
    governanceMutation('resolution_review',state.current.public_ref,{phase:'seal',report_version_ref:row.winning_report_version_ref,decision:'select',reason_code:'process_window_complete',public_rationale:rationale,private_note:null});
  }
  function governanceFinalizeSeal(){var row=resolutionRow();if(row)governanceMutation('seal_finalize',row.public_ref,{});}
  function governanceSubmitChallenge(){
    var row=resolutionRow();if(!row)return;
    var summary=fieldValue('osi-challenge-summary'),evidence=fieldValue('osi-challenge-evidence');
    if(summary.length<20){showToast('The public-safe challenge summary must be at least 20 characters.');return;}
    governanceMutation('challenge_submit',row.public_ref,{reason_code:'material_evidence_challenge',public_safe_summary:summary,restricted_detail:fieldValue('osi-challenge-detail')||null,evidence_item_id:evidence});
  }
  function governanceAdmitChallenge(ref,decision,route){governanceMutation('challenge_admit',ref,{decision:decision,route:route});}
  function governanceReviewChallenge(ref,decision){
    var rationale=window.prompt('Public-safe challenge review rationale.','The submitted evidence was reviewed against the exact selected Report version.');
    if(rationale===null)return;rationale=String(rationale).trim();if(rationale.length<10){showToast('The public-safe rationale must be at least 10 characters.');return;}
    governanceMutation('challenge_review',ref,{decision:decision,reason_code:decision==='accept'?'material_issue_confirmed':'selected_report_preserved',public_rationale:rationale,private_note:null});
  }
  function governanceWithdrawChallenge(ref){governanceMutation('challenge_withdraw',ref,{});}
  function governanceFinalizeChallenge(ref){governanceMutation('challenge_finalize',ref,{});}

  var legacyAdminUpdate=window.updateAdminButton;
  window.updateAdminButton=function(){
    if(location.pathname.toLowerCase().endsWith('/legacy.html')){if(typeof legacyAdminUpdate==='function')legacyAdminUpdate();return;}
    setAdminVisibility(false);refreshCapabilities();
  };
  window.renderFieldOffice=loadPublicCases;
  window.fieldOpenForm=fieldOpenFormV2;
  window.osiV2GovernanceResolutionReview=governanceResolutionReview;
  window.osiV2GovernanceFinalizeResolution=governanceFinalizeResolution;
  window.osiV2GovernanceSealReview=governanceSealReview;
  window.osiV2GovernanceFinalizeSeal=governanceFinalizeSeal;
  window.osiV2GovernanceSubmitChallenge=governanceSubmitChallenge;
  window.osiV2GovernanceAdmitChallenge=governanceAdmitChallenge;
  window.osiV2GovernanceReviewChallenge=governanceReviewChallenge;
  window.osiV2GovernanceWithdrawChallenge=governanceWithdrawChallenge;
  window.osiV2GovernanceFinalizeChallenge=governanceFinalizeChallenge;
  window.fieldCloseForm=fieldCloseFormV2;
  window.fieldMine=function(mine){if(mine)openSignedCollection('mine');else loadPublicCases();};
  window.fieldSearch=function(value){state.query=String(value||'');state.page=1;drawCases();};
  window.fieldFilter=function(value){state.stage=String(value||'all');state.page=1;drawCases();};
  window.fieldSort=function(value){state.sort=String(value||'newest');drawCases();};
  window.osiV2OpenMyCases=function(){openSignedCollection('mine');};
  window.osiV2OpenReviewQueue=function(){openSignedCollection('review');};
  window.osiV2LoadMaintainerOverview=function(){
    return signedRead('CASE_READ_MAINTAINER_OVERVIEW','maintainer_case_overview');
  };
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
