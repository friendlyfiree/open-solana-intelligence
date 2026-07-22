/* Native V2 Case lifecycle for the mature OSI root experience. */
(function(){
  'use strict';

  var READ_URL = SUPABASE_URL + '/functions/v1/osi-v2-case-read';
  var WRITE_URL = SUPABASE_URL + '/functions/v1/osi-v2-case-write';
  var GOVERNANCE_URL = SUPABASE_URL + '/functions/v1/osi-v2-governance-write';
  var PAYMENT_URL = SUPABASE_URL + '/functions/v1/osi-v2-payment';
  var AI_PACK_URL = SUPABASE_URL + '/functions/v1/osi-v2-ai-pack';
  var PAGE_SIZE = 12;
  var state = {
    cases: [], mode: 'public', actorRole: 'public', query: '', stage: 'open_public',
    sort: 'newest', page: 1, loadToken: 0, current: null, tab: 'overview',
    capabilities: null, caseIdempotency: '', reviewBusy: false, reviewTasks: {},
    modalReturnFocus: null, drawerReturnFocus: null, governanceBusy: false,
    paymentBusy: false, paymentPending: null, paymentWallet: ''
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
  function sasSlot(wallet,role){
    role=String(role||'').toLowerCase();
    if(['analyst','verified_analyst','senior_analyst','probationary_analyst'].indexOf(role)<0)return'';
    return'<span data-sas-wallet="'+esc(wallet)+'" data-sas-role="'+esc(role)+'"></span>';
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
      ,read_session_disabled_or_unavailable:'Private read sessions are safely disabled or temporarily unavailable.'
      ,read_session_required:'Unlock private views with one wallet signature.'
      ,read_session_expired:'Your five-minute private read session expired. Refresh it explicitly to continue.'
      ,read_session_wrong_origin:'This private session belongs to a different site origin.'
      ,read_session_wrong_wallet:'This private session belongs to a different wallet.'
      ,read_session_wrong_scope:'Refresh private access explicitly for this role.'
      ,read_session_tampered:'The private session token failed server verification.'
      ,resolution_lifecycle_writes_disabled:'Resolution and challenge writes are safely disabled while rollout checks are incomplete.'
      ,resolution_lifecycle_writes_disabled_or_unavailable:'Resolution and challenge writes are safely disabled or temporarily unavailable.'
      ,not_authorized_or_conflicted:'This wallet is not eligible for this exact action or has a Case, Report, or challenge conflict.'
      ,not_eligible_analyst:'This action requires an eligible server-derived analyst.'
      ,active_challenge_exists:'This wallet already has an active challenge for the exact resolution.'
      ,rate_limited_or_cooldown:'Challenge rate or cooldown limit is active. Wait before trying again.'
      ,governance_state_changed_retry:'The exact governance state changed. Review the latest tally and start again.'
      ,challenge_maintenance_unavailable:'Challenge deadline maintenance is temporarily unavailable, so writes remain fail-closed.'
      ,payment_writes_disabled:'Native SOL reward and support writes are safely disabled while rollout checks are incomplete.'
      ,payment_writes_disabled_or_unavailable:'Native SOL reward and support writes are safely disabled or temporarily unavailable.'
      ,payment_not_authorized_or_not_ready:'This wallet, Case, winner, or support target is not eligible for this exact transfer.'
      ,payment_binding_rejected:'The exact payment intent expired or changed. Prepare a fresh intent.'
      ,payment_state_changed_retry:'Payment state changed concurrently. Reload and prepare again.'
      ,transaction_already_used:'This Solana transaction was already used for another OSI payment receipt.'
      ,awaiting_finality:'The transaction exists but is not finalized yet. Retry verification with the same signature.'
      ,wrong_cluster:'The trusted RPC did not identify Solana mainnet. No payment was recorded.'
      ,wrong_payer:'The finalized transaction payer does not match the prepared wallet.'
      ,wrong_recipient:'The finalized transfer recipients do not match the server-derived manifest.'
      ,wrong_amount:'The finalized transfer amount does not match the exact integer lamports.'
      ,wrong_memo:'The finalized transaction Memo does not match the exact prepared payment intent.'
      ,unexpected_instruction:'The transaction contains an instruction outside the exact transfers and Memo.'
      ,transaction_failed:'The Solana transaction failed. No confirmed payment was recorded.'
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
    if(typeof window.osiV2ApproveMessage==='function')return await window.osiV2ApproveMessage(message);
    var provider=typeof getProvider==='function' ? getProvider() : null;
    if(!provider||typeof provider.signMessage!=='function') throw new Error('This wallet does not support signMessage.');
    var signed=await provider.signMessage(new TextEncoder().encode(message),'utf8');
    var bytes=signed&&signed.signature?signed.signature:signed;
    if(!(bytes instanceof Uint8Array)) bytes=new Uint8Array(bytes||[]);
    return bytesToBase64(bytes);
  }
  async function sessionRead(scope,op,extra){
    if(typeof window.osiV2ReadSession!=='function')throw new Error('read_session_disabled_or_unavailable');
    var session=await window.osiV2ReadSession([scope],{allowUnlock:true});
    return await api(READ_URL,Object.assign({op:op,wallet:session.wallet,read_session:session.token},extra||{}));
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
        var rewardState=item.money&&item.money.reward&&item.money.reward.status;
        return '<button class="osi-v2-row" type="button" data-case-ref="'+esc(item.public_ref)+'">'
          +'<span class="osi-v2-id">'+esc(item.public_ref)+'</span>'
          +'<span class="osi-v2-title"><b>'+esc(item.title)+'</b><span>'+esc(item.summary)+'</span>'+(rewardState?'<em class="osi-reward-chip">'+esc(label(rewardState))+'</em>':'')+'</span>'
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
        ? await sessionRead('case:mine','list_my_cases')
        : await sessionRead('case:review','list_reviewable_cases');
      if(token!==state.loadToken) return;
      state.actorRole=result.actor_role||(mode==='mine'?'owner':'analyst');
      state.cases=result.cases||[];state.reviewTasks=result.review_tasks||{};drawCases();
      await refreshCapabilities();
    }catch(error){
      if(token!==state.loadToken) return;
      var host=document.getElementById('field-cases');
      if(host){
        var refresh=/^read_session_(expired|wrong_scope)$/.test(String(error&&error.message||''));
        host.innerHTML='<div class="osi-v2-empty osi-v2-error"><b>Authorized workspace locked</b><span>'+esc(userError(error))+'</span>'+(refresh?'<button class="osi-action" type="button" onclick="osiV2RefreshCaseWorkspace(\''+esc(mode)+'\')">Refresh private access</button>':'')+'</div>';
      }
    }
  }

  async function refreshCapabilities(){
    if(!walletPubkey){state.capabilities=null;setAdminVisibility(false);setReviewNavigationVisibility(false);return null;}
    try{
      var results=await Promise.all([
        api(WRITE_URL,{op:'actor_capabilities',wallet:walletPubkey}),
        api(GOVERNANCE_URL,{op:'actor_capabilities',wallet:walletPubkey}),
        api(PAYMENT_URL,{op:'capabilities',wallet:walletPubkey})
      ]);
      var aiPackCapabilities={ai_pack_writes_enabled:false,ai_pack_review_writes_enabled:false,can_generate:false,generation_prerequisite:'AI Pack capabilities are safely unavailable.'};
      try{aiPackCapabilities=await api(AI_PACK_URL,{
        op:'capabilities',
        wallet:walletPubkey,
        case_ref:state.current&&state.current.public_ref||undefined
      });}catch(aiPackError){}
      state.capabilities=Object.assign({},results[0],results[1],results[2],aiPackCapabilities);
      if(typeof setMaintainerServerGate==='function') setMaintainerServerGate(state.capabilities.maintainer_access===true,state.capabilities.maintainer_gate||'denied');
      setAdminVisibility(state.capabilities.maintainer_access===true);
      setReviewNavigationVisibility(state.capabilities.analyst_eligible===true||state.capabilities.maintainer_access===true);
      return state.capabilities;
    }catch(error){state.capabilities=null;if(typeof setMaintainerServerGate==='function')setMaintainerServerGate(false,'unavailable');setAdminVisibility(false);setReviewNavigationVisibility(false);return null;}
  }
  function setAdminVisibility(allowed){
    var button=document.getElementById('admLockBtn')||document.getElementById('adminBtn')||document.getElementById('admin-btn');
    if(button) button.style.display=allowed?'':'none';
  }
  function setReviewNavigationVisibility(allowed){
    document.querySelectorAll('.field-review-nav').forEach(function(button){button.hidden=!allowed;});
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

  var tabs=[['overview','Overview'],['evidence','Evidence'],['reports','Reports'],['ai_pack','AI Pack'],['resolution','Resolution'],['challenges','Challenges'],['reward','Rewards & Support'],['proof','Proof Log']];
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
  function wipeCaseDrawerContent(){
    if(typeof window.osiV2AiPackClear==='function')window.osiV2AiPackClear();
    var content=document.getElementById('osi-case-content');
    if(content){
      if(typeof content.replaceChildren==='function')content.replaceChildren();
      else content.innerHTML='';
    }
  }
  function closeCase(){
    var drawer=document.getElementById('osi-case-drawer');
    if(drawer)drawer.hidden=true;
    document.body.classList.remove('osi-case-open');
    syncBodyLock();
    wipeCaseDrawerContent();
    state.current=null;
    restoreFocus(state.drawerReturnFocus);
    state.drawerReturnFocus=null;
  }
  function drawTabs(){
    var host=document.getElementById('osi-case-tabs');
    host.setAttribute('role','tablist');
    host.innerHTML=tabs.map(function(tab){
      var active=tab[0]===state.tab;
      return'<button class="osi-case-tab '+(active?'active':'')+'" id="osi-case-tab-'+tab[0]+
        '" type="button" role="tab" aria-controls="osi-case-content" aria-selected="'+active+
        '" tabindex="'+(active?'0':'-1')+'" data-tab="'+tab[0]+'">'+esc(tab[1])+'</button>';
    }).join('');
    var selected=host.querySelector('[aria-selected="true"]');if(selected&&typeof selected.scrollIntoView==='function')selected.scrollIntoView({block:'nearest',inline:'nearest'});
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
    var list=rows.length?'<div class="osi-list">'+rows.map(function(row){return'<div class="osi-list-item"><div class="osi-list-item-head"><b>'+esc(short(row.reviewer_wallet))+sasSlot(row.reviewer_wallet,row.reviewer_role)+' &middot; '+esc(label(row.decision))+'</b><span class="osi-proof-label">'+esc(row.proof_label)+'</span></div><p>'+esc(label(row.reviewer_role))+' &middot; weight '+esc(row.weight)+' &middot; '+esc(dateText(row.created_at))+'</p>'+(row.reason_code?'<p>Reason code: '+esc(row.reason_code)+'</p>':'')+'</div>';}).join('')+'</div>':'<div class="osi-v2-empty"><b>Awaiting initial review</b><span>No eligible reviewer has recorded a decision yet.</span></div>';
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
    return '<div class="osi-governance-timeline">'+rows.map(function(row){var role=row.reviewer_role||row.actor_role||'';return'<div class="osi-governance-event"><span class="osi-proof-label">'+esc(row.proof_label||'Wallet-signed & server-verified')+'</span><b>'+esc(short(row.reviewer_wallet))+sasSlot(row.reviewer_wallet,role)+' &middot; '+esc(label(row.decision))+'</b><p>'+esc(row.target_version_ref||label(row.phase))+' &middot; weight '+esc(Number(row.weight||0).toFixed(2))+' &middot; '+esc(dateText(row.created_at))+'</p><p>'+esc(row.public_rationale||'No public rationale recorded.')+'</p></div>';}).join('')+'</div>';
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
    return '<section class="osi-case-section"><h3>Proof Log</h3><div class="osi-list">'+rows.map(function(row){var good=row.label!=='Legacy / not server-verified';var link=row.solscan_url&&/^https:\/\/solscan\.io\/tx\/[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(row.solscan_url)?'<a class="osi-proof-link" href="'+esc(row.solscan_url)+'" target="_blank" rel="noopener">Verify on Solscan</a>':'';var ref=row.public_ref?' / '+esc(row.public_ref):'';var payment=row.payment_proof;var paymentDetail=payment?'<dl class="osi-payment-proof"><div><dt>Payer</dt><dd>'+esc(short(payment.payer_wallet))+'</dd></div><div><dt>Exact amount</dt><dd>'+esc(solFromLamports(payment.total_lamports))+' SOL / '+esc(payment.total_lamports)+' lamports</dd></div><div><dt>Target</dt><dd>'+esc(payment.target_public_ref)+'</dd></div><div><dt>Finality</dt><dd>'+esc(payment.finality)+' / slot '+esc(payment.slot)+'</dd></div><div><dt>Block time</dt><dd>'+esc(dateText(payment.block_time))+'</dd></div><div><dt>Server verification</dt><dd>'+(payment.memo_verified&&payment.transfers_verified?'Memo and transfers verified':'Unavailable')+'</dd></div></dl><div class="osi-evidence-ref">Memo: '+esc(row.memo||'Canonical Memo verified')+'</div><ul class="osi-payment-proof-recipients">'+(payment.recipient_manifest||[]).map(function(recipient){return'<li>'+esc(short(recipient.wallet))+' / '+esc(solFromLamports(recipient.amount_lamports))+' SOL / '+esc(label(recipient.recipient_type))+'</li>';}).join('')+'</ul>':'';return'<div class="osi-list-item"><div class="osi-list-item-head"><b>'+esc(label(row.event_type))+ref+'</b><span class="osi-proof-label '+(good?'':'legacy')+'">'+esc(row.label)+'</span></div><p>Actor '+esc(short(row.actor_wallet))+sasSlot(row.actor_wallet,row.actor_role)+' / '+esc(label(row.actor_role))+' / '+esc(row.decision||'recorded')+' / '+esc(dateText(row.occurred_at))+'</p>'+paymentDetail+link+'</div>';}).join('')+'</div><div class="osi-case-note">A wallet-signed receipt is server-verified but is not on-chain. A payment receipt is labeled SOL transfer verified on Solana only after the exact System Program transfers and canonical Memo are finalized and server-verified.</div></section>';
  }
  function solFromLamports(value){
    var text=String(value==null?'0':value);if(!/^\d+$/.test(text))return'0';
    text=text.replace(/^0+(?=\d)/,'');var padded=text.padStart(10,'0');
    var whole=padded.slice(0,-9),fraction=padded.slice(-9).replace(/0+$/,'');
    return whole+(fraction?'.'+fraction:'');
  }
  function validSolInput(value){var text=String(value||'').trim();if(!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,9})?$/.test(text)||/^0(?:\.0+)?$/.test(text))return false;var parts=text.split('.'),whole=Number(parts[0]);return whole<100||(whole===100&&(!parts[1]||/^0+$/.test(parts[1])));}
  function paymentProofLink(row){return row&&row.solscan_url?'<a class="osi-proof-link" href="'+esc(row.solscan_url)+'" target="_blank" rel="noopener">Verify on Solscan</a>':'';}
  function reward(item){
    var money=item.money||{},pledge=money.reward,caps=state.capabilities||{};
    var owner=String(item.submitted_by_wallet||'')===String(walletPubkey||'');
    var canPledge=owner&&caps.payment_writes_enabled===true&&(!pledge||pledge.state==='pledged')&&['draft','submitted','initial_review','open_public','in_review','ready_for_finalization','resolution_proposed','in_challenge_window','resolved','reopened'].indexOf(item.stage)>=0;
    var pledgeAction=pledge?'revise':'create';
    var pledgeControls=canPledge?'<div class="osi-payment-compose"><h4>'+(pledge?'Revise reward pledge':'Create reward pledge')+'</h4><label>Exact SOL amount<input id="osi-pledge-amount" type="text" inputmode="decimal" autocomplete="off" placeholder="1.25" value="'+esc(pledge?solFromLamports(pledge.amount_lamports):'')+'"></label><div class="osi-payment-actions"><button class="osi-action primary" type="button" onclick="osiV2Pledge(\''+pledgeAction+'\')">Sign '+pledgeAction+'</button>'+(pledge&&item.visibility==='private'?'<button class="osi-action" type="button" onclick="osiV2Pledge(\'withdraw\')">Withdraw pledge</button>':'')+'</div><div id="osi-payment-status" class="osi-form-status mono" role="status"></div></div>':'';
    var payReady=owner&&caps.payment_writes_enabled===true&&pledge&&['payment_ready','partially_fulfilled','verification_failed'].indexOf(pledge.status)>=0&&String(pledge.outstanding_lamports)!=='0';
    var unpaidPledge=owner&&pledge&&String(pledge.outstanding_lamports)!=='0';
    var payReason=item.stage==='in_challenge_window'?'Challenge window must end and the Case must be sealed before the winner can be paid.':caps.payment_writes_enabled!==true?'Native SOL payments remain disabled until rollout checks pass.':'The exact winning Report version and sealed recipient are not final yet.';
    var payControl=payReady?'<div class="osi-payment-compose"><h4>Pay sealed winner</h4><p>Server-derived recipient <span class="mono">'+esc(short(pledge.winning_report_author_wallet))+'</span> for exact winning version <span class="mono">'+esc(pledge.winning_report_version_ref)+'</span>.</p><label>Partial or full SOL amount<input id="osi-reward-pay-amount" type="text" inputmode="decimal" autocomplete="off" value="'+esc(solFromLamports(pledge.outstanding_lamports))+'"></label><button class="osi-action primary" type="button" onclick="osiV2PayReward()">Review direct transfer</button></div>':unpaidPledge?'<div class="osi-payment-compose"><h4>Pay sealed winner</h4><p>'+esc(payReason)+'</p><button class="osi-action" type="button" disabled title="'+esc(payReason)+'">Payment unavailable</button></div>':'';
    var supportOptions=(money.support_options||[]).filter(function(option){return option.wallet!==String(walletPubkey||'');});var supportGroups={};supportOptions.forEach(function(option){(supportGroups[option.target_ref]||(supportGroups[option.target_ref]=[])).push(option);});
    var support=Object.keys(supportGroups).length&&caps.payment_writes_enabled===true?'<div class="osi-payment-compose"><h4>Support contributors</h4><p>Select up to four recipients for one atomic System Program transaction. Each amount is exact native SOL.</p>'+Object.keys(supportGroups).map(function(versionRef,groupIndex){return'<fieldset class="osi-support-group"><legend>'+esc(versionRef)+'</legend>'+supportGroups[versionRef].map(function(option,index){var key=groupIndex+'-'+index;return'<label class="osi-support-recipient"><input type="checkbox" data-support-check="'+key+'" data-target-type="'+esc(option.target_type)+'" data-target-ref="'+esc(option.target_ref)+'" data-wallet="'+esc(option.wallet)+'"><span>'+esc(option.label)+' / '+esc(short(option.wallet))+'</span><input type="text" inputmode="decimal" autocomplete="off" data-support-amount="'+key+'" placeholder="0.1 SOL" aria-label="SOL amount for '+esc(option.label)+'"></label>';}).join('')+'<button class="osi-action primary" type="button" onclick="osiV2SupportContributors(\''+esc(versionRef)+'\')">Review atomic support</button></fieldset>';}).join('')+'</div>':'';
    var summary=pledge?'<div class="osi-case-meta"><div><span>Pledge</span><b>'+esc(solFromLamports(pledge.amount_lamports))+' SOL</b></div><div><span>Server-derived status</span><b>'+esc(label(pledge.status))+'</b></div><div><span>Confirmed</span><b>'+esc(solFromLamports(pledge.confirmed_lamports))+' SOL</b></div><div><span>Outstanding</span><b>'+esc(solFromLamports(pledge.outstanding_lamports))+' SOL</b></div></div>':'<div class="osi-state-message"><b>No reward pledge</b><span>A Case intake reward intent is not a pledge and cannot be paid.</span></div>';
    var rows=(pledge&&pledge.payments||[]).concat(money.confirmed_support||[]);var history=rows.length?'<div class="osi-list">'+rows.map(function(row){return'<div class="osi-list-item"><div class="osi-list-item-head"><b>'+esc(row.support_type?'Voluntary support':'Reward payment')+' / '+esc(solFromLamports(row.amount_lamports))+' SOL</b><span class="osi-proof-label">'+esc(label(row.state))+'</span></div><p>'+esc(dateText(row.confirmed_at))+'</p>'+paymentProofLink(row)+'</div>';}).join('')+'</div>':'';
    var retry=state.paymentPending&&state.paymentPending.caseRef===item.public_ref?'<div class="osi-state-message warning"><b>Awaiting finality</b><span>The signed transaction is not marked paid. Retry trusted server verification with the same signature.</span><button class="osi-action" type="button" onclick="osiV2RetryPayment()">Retry verification</button></div>':'';
    return '<section class="osi-case-section"><div class="osi-section-heading"><div><span class="osi-eyebrow">Native SOL / mainnet</span><h3>Rewards & Support</h3></div><span class="osi-chip">Pledged, not escrowed</span></div>'+summary+retry+pledgeControls+payControl+support+history+'<div class="osi-case-note">A pledge records intent only and never moves SOL. All transfers are voluntary, direct wallet-to-wallet native SOL. OSI never holds funds, provides escrow, or takes commission. A payment or support receipt does not affect ranking, review weight, governance, truth, guilt, legal certainty, or recovery.</div></section>';
  }
  function renderTab(){
    var item=state.current;if(!item)return;
    if(state.tab!=='ai_pack'&&typeof window.osiV2AiPackClear==='function')window.osiV2AiPackClear();
    var aiPackAvailable=typeof window.osiV2AiPackRender==='function';
    var html=state.tab==='overview'?overview(item)
      :state.tab==='evidence'?evidence(item)
      :state.tab==='reports'?reports(item)
      :state.tab==='ai_pack'&&aiPackAvailable?window.osiV2AiPackRender(item,state.capabilities||{},state.mode)
      :state.tab==='ai_pack'?'<section class="osi-case-section"><h3>AI Pack</h3><div class="osi-v2-empty osi-v2-error"><b>AI Pack view unavailable</b><span>The AI Pack interface did not load. Reload the page to retry safely.</span><button class="osi-action" id="osi-ai-pack-script-retry" type="button">Reload page</button></div></section>'
      :state.tab==='resolution'?resolution(item)
      :state.tab==='challenges'?challenges(item)
      :state.tab==='reward'?reward(item)
      :proof(item);
    var content=document.getElementById('osi-case-content');
    content.setAttribute('role','tabpanel');
    content.setAttribute('tabindex','0');
    content.setAttribute('aria-labelledby','osi-case-tab-'+state.tab);
    content.innerHTML=html;
    var retry=document.getElementById('osi-ai-pack-script-retry');
    if(retry)retry.addEventListener('click',function(){window.location.reload();});
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

  function clearPaymentState(){
    state.paymentPending=null;state.paymentBusy=false;state.paymentWallet='';
    var modal=document.getElementById('osi-payment-review');if(modal)modal.remove();
  }
  function paymentStatus(text,kind){var node=document.getElementById('osi-payment-status');if(node){node.textContent=text||'';node.className='osi-form-status mono '+(kind||'');}}
  function paymentReview(prepared){
    return new Promise(function(resolve){
      var old=document.getElementById('osi-payment-review');if(old)old.remove();
      var modal=document.createElement('div');modal.id='osi-payment-review';modal.className='osi-payment-review';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','osi-payment-review-title');
      var recipients=(prepared.recipient_manifest||[]).map(function(row){return'<li><span>'+esc(label(row.recipient_type))+' / '+esc(short(row.wallet))+'</span><b>'+esc(row.amount_sol)+' SOL</b></li>';}).join('');
      modal.innerHTML='<div class="osi-payment-review-card"><span class="osi-eyebrow">Before Phantom opens</span><h3 id="osi-payment-review-title">Review exact mainnet transfer</h3><dl><div><dt>Network</dt><dd>Solana mainnet-beta</dd></div><div><dt>Type</dt><dd>'+esc(label(prepared.payment_kind))+'</dd></div><div><dt>Total</dt><dd>'+esc(prepared.total_sol)+' SOL</dd></div><div><dt>Reference</dt><dd class="mono">'+esc(prepared.target_public_ref)+'</dd></div></dl><ul>'+recipients+'</ul><div class="osi-case-note">This transaction is irreversible. Phantom sends native SOL directly from your wallet to the exact server-derived recipients. OSI receives no funds, has no custody or escrow, and takes no commission.</div><div class="osi-payment-actions"><button type="button" class="osi-action" data-payment-cancel>Cancel</button><button type="button" class="osi-action primary" data-payment-confirm>Open Phantom</button></div></div>';
      document.body.appendChild(modal);var prior=document.activeElement;
      function finish(value){modal.remove();if(prior&&document.contains(prior)&&prior.focus)prior.focus();resolve(value);}
      modal.querySelector('[data-payment-cancel]').addEventListener('click',function(){finish(false);});
      modal.querySelector('[data-payment-confirm]').addEventListener('click',function(){finish(true);});
      modal.addEventListener('click',function(event){if(event.target===modal)finish(false);});
      modal.querySelector('[data-payment-confirm]').focus();
    });
  }
  async function sendPreparedPayment(prepared){
    var provider=typeof getProvider==='function'?getProvider():null;
    if(!provider||!walletPubkey||!provider.publicKey||provider.isConnected===false)throw new Error('Connect Phantom to continue.');
    var web3=window.solanaWeb3;if(!web3)throw new Error('Solana transaction library is unavailable.');
    var from=new web3.PublicKey(walletPubkey);var tx=new web3.Transaction();
    (prepared.recipient_manifest||[]).forEach(function(row){
      if(!/^\d+$/.test(String(row.amount_lamports||'')))throw new Error('wrong_amount');
      var amount=Number(row.amount_lamports);if(!Number.isSafeInteger(amount)||amount<=0)throw new Error('wrong_amount');
      tx.add(web3.SystemProgram.transfer({fromPubkey:from,toPubkey:new web3.PublicKey(row.wallet),lamports:amount}));
    });
    tx.add(new web3.TransactionInstruction({keys:[{pubkey:from,isSigner:true,isWritable:false}],programId:new web3.PublicKey(MEMO_PROGRAM_ID),data:new TextEncoder().encode(prepared.memo)}));
    tx.feePayer=from;var blockhash=await fetchRecentBlockhash();if(!blockhash)throw new Error('rpc_unavailable');tx.recentBlockhash=blockhash;
    var bytes=tx.serialize({requireAllSignatures:false,verifySignatures:false});if(bytes.length>1232)throw new Error('Transaction exceeds Solana packet size.');
    var submit=function(){return provider.signAndSendTransaction(tx);};
    var result=typeof window.osiV2ApproveTransaction==='function'?await window.osiV2ApproveTransaction(prepared.memo,submit):await submit();
    if(!result||!result.signature)throw new Error('Transaction submission was cancelled.');return result.signature;
  }
  async function reloadPaymentCase(caseRef){
    if(state.mode==='public'){await loadPublicCases();await openCase(caseRef);return;}
    await openSignedCollection(state.mode);await openCase(caseRef);
  }
  function showPaymentReceipt(receipt){
    var old=document.getElementById('osi-payment-receipt');if(old)old.remove();var modal=document.createElement('div');modal.id='osi-payment-receipt';modal.className='osi-payment-review';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');
    modal.innerHTML='<div class="osi-payment-review-card"><span class="osi-eyebrow">SOL transfer verified on Solana</span><h3>Finalized payment receipt</h3><dl><div><dt>Transaction</dt><dd class="mono">'+esc(short(receipt.tx_sig))+'</dd></div><div><dt>Finality</dt><dd>'+esc(receipt.finality)+'</dd></div><div><dt>Total</dt><dd>'+esc(receipt.total_sol)+' SOL / '+esc(receipt.total_lamports)+' lamports</dd></div><div><dt>Slot</dt><dd>'+esc(receipt.slot)+'</dd></div><div><dt>Block time</dt><dd>'+esc(dateText(receipt.block_time))+'</dd></div><div><dt>Server verification</dt><dd>Signer, transfers, Memo and mainnet verified</dd></div></dl><div class="osi-payment-actions"><a class="osi-action" href="'+esc(receipt.solscan_url)+'" target="_blank" rel="noopener">Open Solscan</a><button class="osi-action primary" type="button" data-receipt-close>Done</button></div><div class="osi-case-note">This receipt records a direct wallet-to-wallet transfer. It is not an endorsement, truth vote, guilt decision, legal finding, custody service, or governance weight.</div></div>';
    document.body.appendChild(modal);modal.querySelector('[data-receipt-close]').addEventListener('click',function(){modal.remove();});modal.querySelector('[data-receipt-close]').focus();
  }
  async function verifyPreparedPayment(pending){
    var result=await api(PAYMENT_URL,{op:'commit_payment',wallet:pending.wallet,nonce:pending.prepared.nonce,tx_sig:pending.txSig});
    if(result.state==='awaiting_finality'){
      state.paymentPending=pending;paymentStatus('Transaction submitted. Awaiting finalized trusted RPC verification; not marked paid.','warning');
      if(state.current){state.tab='reward';renderTab();}return result;
    }
    state.paymentPending=null;showToast('Finalized direct SOL transfer verified. Receipt '+result.receipt.id+' is available in the Proof Log.');showPaymentReceipt(result.receipt);
    if(pending.caseRef)await reloadPaymentCase(pending.caseRef);
    else if(pending.wireVersionRef&&typeof window.osiV2OpenWireReport==='function')await window.osiV2OpenWireReport(pending.wireVersionRef);
    return result;
  }
  async function prepareAndSendPayment(kind,targetRef,recipients,amountSol){
    if(state.paymentBusy)return;state.paymentBusy=true;
    try{
      var wallet=await ensureWallet();var caps=state.capabilities||await refreshCapabilities()||{};
      if(caps.payment_writes_enabled!==true)throw new Error('payment_writes_disabled');
      var body={op:'prepare_payment',payment_kind:kind,wallet:wallet,target_ref:targetRef,idempotency_key:randomKey('payment')};
      if(kind==='reward')body.amount_sol=amountSol;else body.recipients=recipients;
      paymentStatus('Deriving exact recipients and canonical Memo on the server...');
      var prepared=await api(PAYMENT_URL,body);if(!await paymentReview(prepared)){paymentStatus('Transfer cancelled before Phantom opened.');return;}
      var txSig=await sendPreparedPayment(prepared);var pending={wallet:wallet,caseRef:state.current&&state.current.public_ref||'',prepared:prepared,txSig:txSig};
      state.paymentPending=pending;paymentStatus('Transaction submitted. Verifying mainnet finality, signer, transfers, Memo, freshness, and replay binding...');
      await verifyPreparedPayment(pending);
    }catch(error){paymentStatus(userError(error),'error');showToast(userError(error));}
    finally{state.paymentBusy=false;}
  }
  async function pledge(action){
    if(state.paymentBusy||!state.current)return;var amountNode=document.getElementById('osi-pledge-amount');var amount=amountNode?String(amountNode.value||'').trim():'1';
    if(action!=='withdraw'&&!validSolInput(amount)){paymentStatus('Enter a positive SOL amount with at most 9 decimals.','error');return;}
    state.paymentBusy=true;
    try{
      var wallet=await ensureWallet();paymentStatus('Preparing an exact single-use pledge message...');
      var prepared=await api(PAYMENT_URL,{op:'prepare_pledge',action:action,wallet:wallet,case_ref:state.current.public_ref,amount_sol:amount,idempotency_key:randomKey('pledge')});
      paymentStatus('Sign the pledge message. This is not a transfer and is not on-chain.');var signature=await signMessage(prepared.proof_text);
      await api(PAYMENT_URL,{op:'commit_pledge',action:action,wallet:wallet,nonce:prepared.nonce,proof_text:prepared.proof_text,signature:signature});
      paymentStatus('Reward pledge '+(action==='withdraw'?'withdrawn':action+'d')+' with wallet-signed server proof.','success');showToast('Reward pledge updated. No SOL moved.');
      await reloadPaymentCase(state.current.public_ref);
    }catch(error){paymentStatus(userError(error),'error');}finally{state.paymentBusy=false;}
  }
  function payReward(){var value=fieldValue('osi-reward-pay-amount');if(!validSolInput(value)){paymentStatus('Enter a positive SOL amount with at most 9 decimals.','error');return;}prepareAndSendPayment('reward',state.current.public_ref,null,value);}
  function supportContributors(versionRef){
    var checks=Array.prototype.filter.call(document.querySelectorAll('[data-support-check]'),function(node){return node.checked&&node.dataset.targetRef===versionRef;});
    if(!checks.length||checks.length>4){paymentStatus('Select between one and four contributors for this exact Report version.','error');return;}
    var recipients=[];for(var index=0;index<checks.length;index++){var node=checks[index],amountNode=document.querySelector('[data-support-amount="'+node.dataset.supportCheck+'"]'),value=String(amountNode&&amountNode.value||'').trim();if(!validSolInput(value)){paymentStatus('Every selected recipient needs a positive SOL amount with at most 9 decimals.','error');return;}var recipient={target_type:node.dataset.targetType,target_ref:node.dataset.targetRef,amount_sol:value};if(recipient.target_type==='counted_reviewer')recipient.reviewer_wallet=node.dataset.wallet;recipients.push(recipient);}
    prepareAndSendPayment('support',versionRef,recipients);
  }
  function supportExternal(targetType,targetRef,reviewerWallet){
    var amount=window.prompt('Exact native SOL amount (maximum 9 decimals). This voluntary direct transfer has no governance effect.','0.1');if(amount===null)return;amount=String(amount).trim();if(!validSolInput(amount)){showToast('Enter a positive SOL amount with at most 9 decimals.');return;}
    var recipient={target_type:targetType,target_ref:targetRef,amount_sol:amount};if(targetType==='counted_reviewer')recipient.reviewer_wallet=reviewerWallet;
    prepareAndSendPayment('support',targetRef,[recipient]);
  }
  async function supportWireAuthor(versionRef,authorWallet){
    if(!/^OSI-WV-[0-9A-F]{16}$/.test(String(versionRef||''))||state.paymentBusy)return;
    var amount=window.prompt('Exact native SOL amount (maximum 9 decimals). This voluntary direct transfer has no governance or ranking effect.','0.1');
    if(amount===null)return;amount=String(amount).trim();
    if(!validSolInput(amount)){showToast('Enter a positive SOL amount with at most 9 decimals.');return;}
    state.paymentBusy=true;
    try{
      var wallet=await ensureWallet();
      if(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(authorWallet||''))&&wallet===authorWallet){showToast('You cannot support your own Wire Report.');return;}
      var prepared=await api(PAYMENT_URL,{op:'prepare_wire_support',wallet:wallet,version_public_ref:versionRef,amount_sol:amount,idempotency_key:randomKey('wire-support')});
      if(!await paymentReview(prepared))return;
      var txSig=await sendPreparedPayment(prepared);
      var pending={wallet:wallet,caseRef:'',wireVersionRef:versionRef,prepared:prepared,txSig:txSig};
      state.paymentPending=pending;
      await verifyPreparedPayment(pending);
    }catch(error){showToast(userError(error));}
    finally{state.paymentBusy=false;}
  }
  function retryPayment(){if(state.paymentPending)verifyPreparedPayment(state.paymentPending).catch(function(error){paymentStatus(userError(error),'error');});}

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
    return sessionRead('case:maintainer','maintainer_case_overview');
  };
  window.osiV2RefreshCaseWorkspace=function(mode){
    var scope=mode==='review'?'case:review':'case:mine';
    if(typeof window.osiV2RefreshReadSession!=='function')return Promise.reject(new Error('read_session_disabled_or_unavailable'));
    return window.osiV2RefreshReadSession([scope]).then(function(){return openSignedCollection(mode==='review'?'review':'mine');});
  };
  window.osiV2SubmitCase=submitCase;
  window.osiV2OpenCase=openCase;
  window.osiV2CloseCase=closeCase;
  window.osiV2ShowTab=function(tab){state.tab=tab;drawTabs();renderTab();};
  window.osiV2ComposeReview=composeReview;
  window.osiV2AnchorOpen=anchorOpen;
  window.osiV2Pledge=pledge;
  window.osiV2PayReward=payReward;
  window.osiV2SupportContributors=supportContributors;
  window.osiV2SupportReportAuthor=function(versionRef){supportExternal('report_author',versionRef);};
  window.osiV2SupportAnalyst=function(wallet){supportExternal('analyst',wallet);};
  window.osiV2SupportCountedReviewer=function(versionRef,wallet){supportExternal('counted_reviewer',versionRef,wallet);};
  window.osiV2SupportWireAuthor=supportWireAuthor;
  window.osiV2RetryPayment=retryPayment;
  window.osiV2ClearPaymentState=clearPaymentState;

  function clearPrivateCaseCache(){
    if(state.mode!=='public'){state.cases=[];state.reviewTasks={};state.current=null;state.actorRole='public';state.mode='public';}
    state.capabilities=null;state.governanceBusy=false;clearPaymentState();setAdminVisibility(false);setReviewNavigationVisibility(false);
    wipeCaseDrawerContent();
    var drawer=document.getElementById('osi-case-drawer');if(drawer)drawer.hidden=true;
  }
  if(typeof window.osiV2RegisterPrivateCache==='function')window.osiV2RegisterPrivateCache('cases',clearPrivateCaseCache);

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
  setReviewNavigationVisibility(false);
  window.addEventListener('load',function(){
    var provider=typeof getProvider==='function'?getProvider():null;if(!provider||!provider.on)return;
    provider.on('disconnect',clearPaymentState);
    provider.on('disconnect',function(){setReviewNavigationVisibility(false);});
    provider.on('accountChanged',function(){clearPaymentState();state.capabilities=null;setReviewNavigationVisibility(false);});
  });
})();
