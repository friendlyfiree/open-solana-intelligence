/* Native V2 Case Report intake and private immutable history. */
(function(){
  'use strict';

  var WRITE_URL=SUPABASE_URL+'/functions/v1/osi-v2-report-write';
  var READ_URL=SUPABASE_URL+'/functions/v1/osi-v2-report-read';
  var PUBLICATION_PENDING_PREFIX='osi_report_publication_pending_v1:';
  var state={
    caseRef:'',isRevision:false,idempotency:'',pending:null,returnFocus:null,drawerWasOpen:false,
    cacheWallet:'',myReports:[],sectionContext:null,sectionMode:'public',busy:false,receipt:null,formCapability:null,
    reviewPending:{},publicationPending:{},publicationWallet:'',recoveryCandidates:{},recoveryErrors:{},queueMode:'',sectionLoadToken:0
  };

  function sasAuthority(review){
    var a=review&&review.sas_authority;
    if(!a||a.enforced!==true)return'';
    if(a.counted===true)return' <span class="osi-proof-label" data-sas-authority="counted">Authority verified on Solana</span>';
    var pending=String(a.state||'')==='pending_verification';
    return' <span class="osi-chip warning" data-sas-authority="excluded">'+
      (pending?'Not counted: SAS credential not confirmed':'Not counted: no valid SAS credential')+'</span>';
  }
  function draftKey(wallet,caseRef){return'report:'+String(wallet||'')+':'+String(caseRef||'');}
  function saveDraft(){
    if(!state.caseRef||!walletPubkey||typeof window.osiV2SaveDraft!=='function')return;
    window.osiV2SaveDraft(draftKey(walletPubkey,state.caseRef),{
      report:payload(),safety:!!document.getElementById('osi-report-safety').checked
    });
  }
  function restoreDraft(wallet,caseRef){
    if(typeof window.osiV2LoadDraft!=='function')return false;
    var saved=window.osiV2LoadDraft(draftKey(wallet,caseRef));if(!saved||!saved.report)return false;
    document.getElementById('osi-report-narrative').value=saved.report.body_private||'';
    document.getElementById('osi-report-summary').value=saved.report.content_public_safe||'';
    var by={wallet:[],onchain_tx:[],url:[]};(saved.report.evidence||[]).forEach(function(item){if(by[item.kind])by[item.kind].push(item.ref);});
    document.getElementById('osi-report-wallets').value=by.wallet.join('\n');
    document.getElementById('osi-report-transactions').value=by.onchain_tx.join('\n');
    document.getElementById('osi-report-urls').value=by.url.join('\n');
    document.getElementById('osi-report-revision-reason').value=saved.report.revision_reason_code||'';
    document.getElementById('osi-report-safety').checked=saved.safety===true;return true;
  }
  function workspaceDraftKey(wallet){return'report-review:'+String(wallet||'');}
  function saveWorkspaceDraft(){
    if(state.queueMode!=='queue'||!walletPubkey||typeof window.osiV2SaveDraft!=='function')return;
    var values={};document.querySelectorAll('#field-cases input[id^="osi-review-"],#field-cases select[id^="osi-review-"],#field-cases textarea[id^="osi-review-"]').forEach(function(node){values[node.id]=node.value;});
    if(Object.keys(values).length)window.osiV2SaveDraft(workspaceDraftKey(walletPubkey),values);
  }
  function restoreWorkspaceDraft(){
    if(state.queueMode!=='queue'||typeof window.osiV2LoadDraft!=='function')return;
    var values=window.osiV2LoadDraft(workspaceDraftKey(walletPubkey))||{};
    Object.keys(values).forEach(function(id){var node=document.getElementById(id);if(node)node.value=values[id];});
  }
  function clearSessionState(reason){
    var preserve=reason==='expiry'||reason==='explicit_refresh';
    var privateWorkspace=!!state.queueMode;
    if(!preserve&&state.publicationWallet)clearPublicationPendingForWallet(state.publicationWallet);
    if(preserve&&privateWorkspace)saveWorkspaceDraft();
    state.cacheWallet='';state.myReports=[];state.busy=false;state.sectionLoadToken+=1;
    state.reviewPending={};state.publicationPending={};state.publicationWallet='';state.recoveryCandidates={};state.recoveryErrors={};state.queueMode='';
    state.pending=null;state.idempotency='';state.returnFocus=null;state.receipt=null;
    state.formCapability=null;state.caseRef='';state.isRevision=false;state.drawerWasOpen=false;
    state.sectionContext=null;state.sectionMode='public';
    var form=document.getElementById('osi-report-form');if(form)form.reset();
    var modal=document.getElementById('osi-report-modal');if(modal)modal.classList.remove('open');
    var context=document.getElementById('osi-report-context');if(context)context.textContent='';
    var revision=document.getElementById('osi-report-revision-wrap');if(revision)revision.hidden=true;
    var reasonField=document.getElementById('osi-report-revision-reason');if(reasonField)reasonField.required=false;
    if(typeof window.osiV2ClearSubmissionReceipt==='function')window.osiV2ClearSubmissionReceipt('osi-report-receipt');
    status('');
    var submit=document.getElementById('osi-report-submit');if(submit){submit.disabled=false;submit.removeAttribute('aria-busy');}
    syncBodyLock();
    if(document.body&&document.body.dataset.view==='field'){
      var host=document.getElementById('field-cases');
      if(host&&privateWorkspace)host.innerHTML='<div class="osi-v2-empty"><b>Report workspace locked</b><span>Unlock the bounded private working session to continue. Active sessions renew silently.</span></div>';
    }
  }

  function esc(value){
    return String(value==null?'':value).replace(/[&<>"']/g,function(char){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char];
    });
  }
  function short(value){value=String(value||'');return value.length>18?value.slice(0,8)+'...'+value.slice(-6):value;}
  function label(value){return String(value||'').replace(/_/g,' ').replace(/\b\w/g,function(char){return char.toUpperCase();});}
  function t(key,variables){return typeof window.osiT==='function'?window.osiT(key,variables):String(key||'').replace(/\{([a-zA-Z0-9_]+)\}/g,function(_,name){return variables&&Object.prototype.hasOwnProperty.call(variables,name)?String(variables[name]):'{'+name+'}';});}
  function dateText(value){var date=new Date(value||'');return isNaN(date.getTime())?'Not recorded':date.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});}
  function randomKey(){var id=crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(36).slice(2);return'report:'+id.replace(/[^A-Za-z0-9.-]/g,'');}
  function publicationStorageKey(wallet,versionRef){return PUBLICATION_PENDING_PREFIX+String(wallet||'')+':'+String(versionRef||'');}
  function normalizePublicationPending(raw,wallet,versionRef){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
    var route=raw.route==='maintainer_bootstrap'?'maintainer_bootstrap':raw.route==='standard'?'standard':'';
    var exactVersion=String(raw.versionRef||''),exactWallet=String(raw.wallet||'');
    var nonce=String(raw.nonce||''),memo=String(raw.memo||''),txSig=String(raw.txSig||'');
    var expiresAt=Number(raw.expiresAt),idempotencyKey=String(raw.idempotencyKey||'');
    if(!route||exactWallet!==String(wallet||'')||exactVersion!==String(versionRef||'')
      ||!/^OSI-RV-[0-9A-F]{16}$/.test(exactVersion)||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(exactWallet)
      ||!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)||memo.length<140||memo.length>512
      ||memo.indexOf('OSI2|1|REPORT_PUBLISHED|t=report_version|id='+exactVersion+'|a='+exactWallet+'|')!==0
      ||!Number.isSafeInteger(expiresAt)||expiresAt<=0||!/^report-publish:[A-Za-z0-9.-]{8,128}$/.test(idempotencyKey)
      ||(txSig&&!/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(txSig)))return null;
    if(!txSig&&expiresAt<Math.floor(Date.now()/1000))return null;
    return{route:route,versionRef:exactVersion,wallet:exactWallet,nonce:nonce,memo:memo,txSig:txSig,
      expiresAt:expiresAt,idempotencyKey:idempotencyKey,lastError:String(raw.lastError||''),updatedAt:Number(raw.updatedAt)||Date.now()};
  }
  function savePublicationPending(pending){
    if(!pending)return false;var normalized=normalizePublicationPending(pending,pending.wallet,pending.versionRef);if(!normalized)return false;
    try{sessionStorage.setItem(publicationStorageKey(normalized.wallet,normalized.versionRef),JSON.stringify(normalized));return true;}catch(_){return false;}
  }
  function removePublicationPending(wallet,versionRef){try{sessionStorage.removeItem(publicationStorageKey(wallet,versionRef));}catch(_){};delete state.publicationPending[versionRef];}
  function clearPublicationPendingForWallet(wallet){
    try{for(var i=sessionStorage.length-1;i>=0;i--){var key=sessionStorage.key(i);if(key&&key.indexOf(PUBLICATION_PENDING_PREFIX+String(wallet||'')+':')===0)sessionStorage.removeItem(key);}}catch(_){}
  }
  function loadPublicationPending(wallet,versionRef){
    var key=publicationStorageKey(wallet,versionRef),raw=null;try{raw=JSON.parse(sessionStorage.getItem(key)||'null');}catch(_){}
    var normalized=normalizePublicationPending(raw,wallet,versionRef);if(!normalized){try{sessionStorage.removeItem(key);}catch(_){}return null;}return normalized;
  }
  function restorePublicationPending(reports,wallet){
    state.publicationPending={};state.publicationWallet=String(wallet||'');
    (reports||[]).forEach(function(report){(report.versions||[]).forEach(function(version){var pending=loadPublicationPending(wallet,version.version_ref);if(pending)state.publicationPending[version.version_ref]=pending;});});
  }
  function privateGeneration(){return typeof window.osiV2PrivateCacheGeneration==='function'?window.osiV2PrivateCacheGeneration():0;}
  function assertPrivateGeneration(generation){if(generation!==privateGeneration())throw new Error('private_session_changed');}
  function headers(){
    var token=typeof SUPA_AUTH_TOKEN==='string'&&SUPA_AUTH_TOKEN?SUPA_AUTH_TOKEN:SUPABASE_ANON_KEY;
    return{'Content-Type':'application/json','apikey':SUPABASE_ANON_KEY,'Authorization':'Bearer '+token};
  }
  async function api(url,body){
    var response=await fetch(url,{method:'POST',headers:headers(),body:JSON.stringify(body)});
    var payload={};try{payload=await response.json();}catch(error){payload={ok:false,error:'invalid_server_response'};}
    if(!response.ok||payload.ok!==true){var failure=new Error(payload.error||('request_failed_'+response.status));failure.status=response.status;throw failure;}
    return payload;
  }
  function userError(error){
    var code=String(error&&error.message||'request_failed');
    var messages={
      report_writes_disabled:'Report submission is safely disabled while rollout checks are incomplete.',
      report_writes_disabled_or_unavailable:'Report submission is safely disabled or temporarily unavailable.',
      case_not_available:'This Case is not in an eligible public investigation stage.',
      proof_binding_rejected:'The proof expired or no longer matches this exact Report version. Prepare again.',
      lineage_changed_retry:'Another version advanced this Report. Reload My Reports and prepare a fresh revision.',
      transaction_not_confirmed:'The Memo transaction is not confirmed yet. Retry safely with the same proof.',
      transaction_not_indexed:'Solana has the signature status, but the parsed transaction is not indexed yet. Retry with this same transaction.',
      rpc_unavailable:'Solana confirmation is temporarily unavailable. Retry safely with the same transaction.',
      rpc_invalid_response:'Solana RPC returned an incomplete response. Retry safely with the same transaction.',
      wrong_cluster:'The RPC did not identify Solana mainnet. No Report was created.',
      wrong_signer:'The confirmed transaction signer is not the Report author wallet.',
      wrong_memo:'The confirmed transaction does not contain the exact prepared Memo.',
      transaction_failed:'The Solana transaction failed. No Report was created.',
      rate_limited:'Report proof requests are rate limited. Wait, then try again.',
      replayed_or_expired:'This read authorization was already used or expired.',
      prohibited_secret_material:'Remove any seed phrase, private key, access token, or other secret material.',
      prohibited_illegal_access_material:'Illegal-access material cannot be submitted.',
      prohibited_personal_data:'Remove payment-card or government identity numbers.',
      half_maintainer_wallet_only:'Maintainer access also requires the configured Supabase identity.',
      half_maintainer_auth_only:'Maintainer access also requires the configured admin wallet.',
      maintainer_denied:'This wallet is not an eligible analyst and does not have full maintainer access.'
      ,report_review_writes_disabled:'Report review and publication are safely disabled while rollout checks are incomplete.'
      ,not_eligible_or_self_review:'Only an eligible analyst who is neither the Report author nor the Case owner can take this action.'
      ,report_version_not_available:'This exact Report version is not available for the requested action.'
      ,bad_signature:'The wallet signature did not verify for this exact Report review.'
      ,read_session_disabled_or_unavailable:'Private read sessions are safely disabled or temporarily unavailable.'
      ,read_session_required:'Unlock private views with one wallet signature.'
      ,read_session_expired:'Your private working session genuinely lapsed. Sign once to unlock a new bounded session; your draft is preserved.'
      ,read_session_wrong_origin:'This private session belongs to a different site origin.'
      ,read_session_wrong_wallet:'This private session belongs to a different wallet.'
      ,read_session_wrong_scope:'Refresh private access explicitly for this role.'
      ,read_session_tampered:'The private session token failed server verification.'
      ,private_session_changed:'Private access changed while this action was running. Reopen the exact task.'
      ,publication_transaction_outside_window:'The transaction block time is outside the original proof window. A new prepared transaction is required.'
      ,stale_transaction:'The confirmed transaction occurred outside the original proof window. A new prepared transaction is genuinely required.'
      ,pending_publication_route_mismatch:'An exact publication transaction is already pending on another route. Recover or cancel it before preparing a new one.'
      ,publication_recovery_storage_unavailable:'This browser could not preserve the bounded publication recovery record. No transaction was sent.'
      ,publication_recovery_unavailable:'Existing publication proofs could not be loaded safely. Refresh the exact review task and try again.'
    };
    return messages[code]||code.replace(/_/g,' ');
  }
  async function ensureWallet(){
    if(!walletPubkey&&typeof toggleWallet==='function')await toggleWallet();
    if(!walletPubkey)throw new Error('Connect a Solana wallet to continue.');
    return walletPubkey;
  }
  function bytesToBase64(bytes){var binary='';for(var index=0;index<bytes.length;index++)binary+=String.fromCharCode(bytes[index]);return btoa(binary);}
  async function signMessage(message){
    if(typeof window.osiV2ApproveMessage==='function')return await window.osiV2ApproveMessage(message);
    var provider=typeof getProvider==='function'?getProvider():null;
    if(!provider||typeof provider.signMessage!=='function')throw new Error('This wallet does not support signMessage.');
    var signed=await provider.signMessage(new TextEncoder().encode(message),'utf8');
    var bytes=signed&&signed.signature?signed.signature:signed;
    if(!(bytes instanceof Uint8Array))bytes=new Uint8Array(bytes||[]);
    return bytesToBase64(bytes);
  }
  async function sessionRead(scope,op){
    if(typeof window.osiV2ReadSession!=='function')throw new Error('read_session_disabled_or_unavailable');
    var session=await window.osiV2ReadSession([scope],{allowUnlock:true});
    var generation=privateGeneration();
    var result=await api(READ_URL,{op:op,wallet:session.wallet,read_session:session.token});
    assertPrivateGeneration(generation);return result;
  }
  async function loadReviewQueueData(){
    var result=await sessionRead('report:review','list_review_queue');
    result.reports=(result.reports||[]).map(function(report){
      if(report.can_cast_analyst_review==null)report.can_cast_analyst_review=result.can_cast_analyst_review===true;
      if(report.can_publish_via_maintainer_bootstrap==null)report.can_publish_via_maintainer_bootstrap=result.can_publish_via_maintainer_bootstrap===true;
      return report;
    });
    state.recoveryCandidates={};state.recoveryErrors={};
    var recoveryTargets=[];(result.reports||[]).forEach(function(report){
      if(report.access!=='maintainer'||report.can_publish_via_maintainer_bootstrap!==true)return;
      (report.versions||[]).forEach(function(version){if(version.version_ref===report.current_version_ref&&['submitted','in_review'].indexOf(version.lifecycle_state)>=0)recoveryTargets.push(version.version_ref);});
    });
    await Promise.all(recoveryTargets.map(async function(versionRef){
      try{
        var recovery=await api(WRITE_URL,{op:'list_publication_recovery',wallet:String(walletPubkey||''),version_public_ref:versionRef});
        state.recoveryCandidates[versionRef]=recovery.candidates||[];
      }catch(error){state.recoveryErrors[versionRef]=userError(error);}
    }));
    return result;
  }
  function syncBodyLock(){
    var modal=document.getElementById('osi-report-modal');
    var drawer=document.getElementById('osi-case-drawer');
    document.body.style.overflow=(modal&&modal.classList.contains('open'))||(drawer&&!drawer.hidden)?'hidden':'';
  }
  function status(text,kind){var node=document.getElementById('osi-report-form-status');if(node){node.textContent=text||'';node.className='osi-form-status mono '+(kind||'');}}
  function lines(id,kind){
    var node=document.getElementById(id);if(!node)return[];
    return String(node.value||'').split(/[\n,]+/).map(function(value){return value.trim();}).filter(Boolean).map(function(ref){return{kind:kind,ref:ref};});
  }
  function payload(){
    return{
      body_private:document.getElementById('osi-report-narrative').value,
      content_public_safe:document.getElementById('osi-report-summary').value,
      revision_reason_code:state.isRevision?document.getElementById('osi-report-revision-reason').value:null,
      evidence:lines('osi-report-wallets','wallet').concat(lines('osi-report-transactions','onchain_tx'),lines('osi-report-urls','url'))
    };
  }
  function payloadKey(value){return JSON.stringify(value);}

  async function loadMyReports(){
    var wallet=await ensureWallet();
    var result=await sessionRead('report:mine','list_my_reports');
    state.cacheWallet=wallet;state.myReports=result.reports||[];
    return state.myReports;
  }

  async function openReportForm(caseRef){
    var generation;
    state.returnFocus=document.activeElement;
    try{
      var wallet=await ensureWallet();
      generation=privateGeneration();
      var capability=await api(WRITE_URL,{op:'capabilities',wallet:wallet,case_ref:caseRef});
      assertPrivateGeneration(generation);
      if(capability.report_writes_enabled!==true)throw new Error('report_writes_disabled');
      if(capability.case_eligible!==true)throw new Error('case_not_available');
      state.formCapability=capability;state.receipt=null;if(typeof window.osiV2ClearSubmissionReceipt==='function')window.osiV2ClearSubmissionReceipt('osi-report-receipt');
      status('Authorizing access to your private Report lineage...');
      var rows=state.cacheWallet===wallet?state.myReports:await loadMyReports();
      assertPrivateGeneration(generation);
      var existing=rows.find(function(report){return report.case_public_ref===caseRef;});
      state.caseRef=caseRef;state.isRevision=!!existing;
      if(!state.pending||state.pending.caseRef!==caseRef||state.pending.wallet!==wallet){state.idempotency=randomKey();state.pending=null;}
      var revision=document.getElementById('osi-report-revision-wrap');
      var reason=document.getElementById('osi-report-revision-reason');
      revision.hidden=!state.isRevision;reason.required=state.isRevision;
      restoreDraft(wallet,caseRef);
      var context=document.getElementById('osi-report-context');
      context.textContent=state.isRevision
        ? caseRef+' · Revision of '+existing.report_public_ref+' · Next version '+(Number(existing.current_version_no)+1)
        : caseRef+' · Initial immutable version 1';
      var drawer=document.getElementById('osi-case-drawer');state.drawerWasOpen=!!(drawer&&!drawer.hidden);
      if(state.drawerWasOpen)drawer.hidden=true;
      var modal=document.getElementById('osi-report-modal');modal.classList.add('open');syncBodyLock();status('');
      setTimeout(function(){document.getElementById('osi-report-narrative').focus();},40);
    }catch(error){if(generation==null||generation===privateGeneration()){status('');if(typeof showToast==='function')showToast(userError(error));if(state.returnFocus&&document.contains(state.returnFocus))state.returnFocus.focus();state.returnFocus=null;}}
  }
  function closeReportForm(){
    var modal=document.getElementById('osi-report-modal');if(modal)modal.classList.remove('open');syncBodyLock();
    if(state.receipt){var form=document.getElementById('osi-report-form');if(form)form.reset();state.receipt=null;state.formCapability=null;if(typeof window.osiV2ClearSubmissionReceipt==='function')window.osiV2ClearSubmissionReceipt('osi-report-receipt');status('');var submit=document.getElementById('osi-report-submit');if(submit){submit.disabled=false;submit.removeAttribute('aria-busy');}}
    var drawer=document.getElementById('osi-case-drawer');if(state.drawerWasOpen&&drawer)drawer.hidden=false;state.drawerWasOpen=false;syncBodyLock();
    if(state.returnFocus&&document.contains(state.returnFocus))state.returnFocus.focus();state.returnFocus=null;
  }

  async function commitWithConfirmation(body,generation,onRetry){
    var lastError;
    for(var attempt=0;attempt<5;attempt++){
      assertPrivateGeneration(generation);
      try{var result=await api(WRITE_URL,body);assertPrivateGeneration(generation);return result;}catch(error){
        lastError=error;
        if(['transaction_not_confirmed','transaction_not_indexed','rpc_unavailable','rpc_invalid_response'].indexOf(String(error.message))<0)throw error;
        assertPrivateGeneration(generation);
        var retryText='Waiting for Solana RPC confirmation. Retry '+(attempt+1)+' of 5 with the same transaction...';
        status(retryText);if(typeof onRetry==='function')onRetry(retryText,error);
        await new Promise(function(resolve){setTimeout(resolve,1600+attempt*900);});
        assertPrivateGeneration(generation);
      }
    }
    throw lastError;
  }
  function showReportReceipt(committed){
    state.receipt=committed;
    var canQueue=typeof window.osiV2CanOpenReviewQueue==='function'&&window.osiV2CanOpenReviewQueue();
    if(typeof window.osiV2RenderSubmissionReceipt==='function')window.osiV2RenderSubmissionReceipt('osi-report-receipt',{
      title:'Report version saved',publicRef:committed.report_public_ref,versionRef:committed.version_public_ref,
      copyValue:committed.report_public_ref,stage:reportLifecycleLabel(committed.lifecycle_state||'submitted',{}),visibility:'Private',
      where:'My Reports, under the exact Case and immutable version history.',
      reviewers:'Eligible independent analysts and full double-gated maintainers. The Report author is excluded.',
      next:'The exact submitted version enters authorized review. It remains private until a standard quorum or the clearly labeled maintainer bootstrap path is finalized with a confirmed Memo.',
      openLabel:'Open My Reports',canOpenQueue:canQueue,
      onOpen:function(){closeReportForm();if(typeof window.osiV2CloseCase==='function')window.osiV2CloseCase();openReportWorkspace('mine');},
      onQueue:function(){closeReportForm();if(typeof window.osiV2CloseCase==='function')window.osiV2CloseCase();window.osiV2OpenReviewQueue();},
      onDismiss:closeReportForm
    });
  }

  async function submitReport(event){
    if(event)event.preventDefault();
    var form=document.getElementById('osi-report-form');
    if(!form||!form.reportValidity()||state.busy)return;
    var report=payload();
    if(report.evidence.length>12){status('A Report version can include at most 12 evidence references.','error');return;}
    var generation=privateGeneration();
    state.busy=true;var button=document.getElementById('osi-report-submit');button.disabled=true;button.setAttribute('aria-busy','true');
    try{
      var wallet=await ensureWallet();
      assertPrivateGeneration(generation);
      var key=payloadKey(report);
      if(state.pending&&state.pending.payloadKey!==key){
        state.pending=null;state.idempotency=randomKey();
      }
      if(!state.idempotency)state.idempotency=randomKey();
      if(!state.pending){
        status('Preparing the exact Case, version, evidence manifest, nonce, and payload hash...');
        var prepared=await api(WRITE_URL,{op:'prepare_report',wallet:wallet,case_ref:state.caseRef,report:report,idempotency_key:state.idempotency});
        assertPrivateGeneration(generation);
        if(prepared.already_committed){
          status('This exact version was already committed. Its original receipt is shown below.','success');
          showReportReceipt(Object.assign({lifecycle_state:'submitted'},prepared));return;
        }
        state.pending={caseRef:state.caseRef,wallet:wallet,payloadKey:key,prepared:prepared,txSig:''};
      }
      if(!state.pending.txSig){
        status('Approve the exact CASE_REPORT_VERSION_SUBMITTED Memo in Phantom. OSI receives no funds.');
        state.pending.txSig=await castOnchainVote(state.pending.prepared.memo);
        assertPrivateGeneration(generation);
      }
      status('Confirming mainnet, signer, exact Memo, freshness, nonce, and payload hash...');
      var committed=await commitWithConfirmation({
        op:'commit_report',wallet:wallet,report:report,nonce:state.pending.prepared.nonce,
        memo:state.pending.prepared.memo,tx_sig:state.pending.txSig
      },generation);
      assertPrivateGeneration(generation);
      status('Version '+committed.version_no+' is submitted with a server-verified Solana Memo receipt.','success');
      if(typeof showToast==='function')showToast(committed.report_public_ref+' version '+committed.version_no+' is Memo-anchored on Solana.');
      state.pending=null;state.idempotency='';state.cacheWallet='';state.myReports=[];
      if(typeof window.osiV2RemoveDraft==='function')window.osiV2RemoveDraft(draftKey(wallet,state.caseRef));
      showReportReceipt(committed);
    }catch(error){
      if(generation===privateGeneration()){
        status(userError(error),'error');
        if(['proof_binding_rejected','lineage_changed_retry','transaction_failed','wrong_signer','wrong_memo'].indexOf(String(error.message))>=0){state.pending=null;state.idempotency=randomKey();}
      }
    }finally{if(generation===privateGeneration()){state.busy=false;button.disabled=!!state.receipt;button.removeAttribute('aria-busy');}}
  }

  function publicReviewTimeline(rows){
    if(!rows||!rows.length)return'';
    return'<div class="osi-report-timeline"><h4>Review timeline</h4>'+rows.map(function(review){
      return'<div class="osi-report-timeline-item"><div><b>'+esc(review.reviewer_handle||short(review.reviewer_wallet))+'</b><span>'+esc(label(review.decision))+' · '+esc(Number(review.weight).toFixed(2))+' weight · '+esc(label(review.tier_snapshot))+sasAuthority(review)+'</span></div><p data-osi-user-content>'+esc(review.public_rationale)+'</p><small>'+esc(review.actor_role)+' · '+esc(review.proof_type==='wallet_signed_server_verified'?'Wallet-signed and server-verified':'Proof recorded')+' · '+esc(dateText(review.created_at))+(review.is_active?' · active':' · superseded')+'</small></div>';
    }).join('')+'</div>';
  }
  function publicEvidence(rows){
    if(!rows||!rows.length)return'';
    return'<div class="osi-report-public-evidence"><h4>Publishable evidence</h4>'+rows.map(function(item){
      var value=item.kind==='url'?'<a href="'+esc(item.ref)+'" target="_blank" rel="noopener">'+esc(item.ref)+'</a>':'<span>'+esc(item.ref)+'</span>';
      return'<div><b>#'+esc(item.ordinal)+' '+esc(label(item.kind))+'</b>'+value+'</div>';
    }).join('')+'</div>';
  }
  function publicationChannelHtml(proof){
    proof=proof||{};var channel=String(proof.decision_channel||'');if(!channel)return'';
    var channelLabel=proof.decision_channel_label||label(channel),bootstrap=channel==='maintainer_bootstrap';
    return'<div class="osi-report-publication-channel '+(bootstrap?'bootstrap':'standard')+'"><b>'+esc(t(channelLabel))+'</b><span class="mono">decision_channel='+esc(channel)+'</span>'+(bootstrap?'<p>'+esc(t('This publication used the maintainer bootstrap channel. It is not independent analyst quorum.'))+'</p>':'')+'</div>';
  }
  function publishedRows(rows){
    rows=(rows||[]).filter(function(row){return row&&row.state==='published';});
    if(!rows.length)return'<div class="osi-v2-empty"><b>No published Reports</b><span>Every Report and exact version stays private until publication is finalized.</span></div>';
    return'<div class="osi-report-public-list">'+rows.map(function(row){
      var q=row.quorum||{};
      var progress='<div class="osi-report-quorum" aria-label="Publication quorum"><span><b>'+esc(q.approve_count||0)+'</b> / '+esc(q.required_count||0)+' analysts</span><span><b>'+esc(Number(q.approve_weight||0).toFixed(2))+'</b> / '+esc(Number(q.required_weight||0).toFixed(2))+' weight</span></div>';
      var content='<p class="osi-report-public-body" data-osi-user-content>'+esc(row.body||'')+'</p>'+(row.content_public_safe?'<p data-osi-user-content><b>Public-safe summary:</b> '+esc(row.content_public_safe)+'</p>':'')+publicEvidence(row.evidence);
      var proof=publicationChannelHtml(row.publication_proof)+(row.publication_proof&&row.publication_proof.tx_sig?'<a class="osi-report-chain-link" href="https://solscan.io/tx/'+esc(row.publication_proof.tx_sig)+'" target="_blank" rel="noopener">Verify REPORT_PUBLISHED on Solscan ↗</a>':'');
      var support=row.state==='published'?'<button class="osi-report-action" type="button" onclick="osiV2SupportReportAuthor(\''+esc(row.version_public_ref)+'\')">Support author with SOL</button>':'';
      return'<article class="osi-report-public-card"><div class="osi-list-item-head"><div><b>'+esc(row.report_public_ref)+'</b><small>'+esc(row.version_public_ref)+' · version '+esc(row.version_no)+'</small></div><span class="osi-proof-label">'+esc(row.state==='published'?'Published':'Under review')+'</span></div>'+progress+content+publicReviewTimeline(row.review_timeline)+proof+support+'<p class="osi-report-process-note">'+esc(row.process_notice)+'</p></article>';
    }).join('')+'</div>';
  }
  function sectionIsCurrent(token,caseRef,host){
    return token===state.sectionLoadToken&&!!state.sectionContext
      &&String(state.sectionContext.public_ref||'')===String(caseRef||'')
      &&document.getElementById('osi-public-reports')===host;
  }
  async function refreshPublicReports(item,token,host){
    var caseRef=String(item&&item.public_ref||'');
    host=host||document.getElementById('osi-public-reports');
    if(!host||!sectionIsCurrent(token,caseRef,host))return;
    host.setAttribute('aria-busy','true');
    try{
      var result=await api(READ_URL,{op:'list_public_reports',case_ref:caseRef});
      if(!sectionIsCurrent(token,caseRef,host))return;
      host.innerHTML=publishedRows(result.reports||[]);
    }catch(error){
      if(!sectionIsCurrent(token,caseRef,host))return;
      host.innerHTML='<div class="osi-v2-empty osi-v2-error"><b>Public Report status unavailable</b><span>'+esc(userError(error))+'</span><button class="osi-report-action" type="button" onclick="osiV2RefreshPublicReports()">Try again</button></div>';
    }
    if(sectionIsCurrent(token,caseRef,host))host.removeAttribute('aria-busy');
  }
  async function refreshAuthorizedReports(item,token,host){
    var generation=privateGeneration();
    var caseRef=String(item&&item.public_ref||'');
    host=host||document.getElementById('osi-public-reports');
    if(!host||!sectionIsCurrent(token,caseRef,host))return;host.setAttribute('aria-busy','true');
    var results=await Promise.allSettled([
      api(READ_URL,{op:'list_public_reports',case_ref:caseRef}),
      loadReviewQueueData()
    ]);
    if(generation!==privateGeneration()||!sectionIsCurrent(token,caseRef,host))return;
    var publicHtml=results[0].status==='fulfilled'?publishedRows(results[0].value.reports||[]):'<div class="osi-v2-empty osi-v2-error"><b>Public Report status unavailable</b><span>'+esc(userError(results[0].reason))+'</span><button class="osi-report-action" type="button" onclick="osiV2RefreshCaseReports()">Try again</button></div>';
    var authorizedHtml;
    if(results[1].status==='fulfilled'){
      var reports=(results[1].value.reports||[]).filter(function(report){return String(report.case_public_ref||'')===caseRef;});
      authorizedHtml=reports.length?'<div class="osi-case-note">Restricted authorized view. Submitted content remains hidden from anonymous and conflicted actors.</div><div class="osi-report-workspace">'+reports.map(function(report){return reportCard(report,'queue');}).join('')+'</div>':'<div class="osi-v2-empty"><b>No authorized submitted Reports for this Case</b><span>The restricted Report endpoint returned an empty array for this exact Case.</span></div>';
    }else{
      authorizedHtml='<div class="osi-v2-empty osi-v2-error"><b>Authorized Report view unavailable</b><span>'+esc(userError(results[1].reason))+'</span><button class="osi-report-action" type="button" onclick="osiV2RefreshCaseReports()">Try again</button></div>';
    }
    host.innerHTML='<section class="osi-report-projection"><h4>Published Reports</h4>'+publicHtml+'</section><section class="osi-report-projection restricted"><h4>Authorized submitted Reports</h4>'+authorizedHtml+'</section>';
    if(results[1].status==='fulfilled')restoreWorkspaceDraft();
    host.removeAttribute('aria-busy');
  }
  async function refreshSectionAction(item,token,host){
    var generation=privateGeneration(),requestedWallet=String(walletPubkey||'');
    var caseRef=String(item&&item.public_ref||'');
    host=host||document.getElementById('osi-public-reports');
    if(!host||!sectionIsCurrent(token,caseRef,host))return;
    var button=document.getElementById('osi-report-submit-action');
    var copy=document.getElementById('osi-report-action-copy');
    if(!button||!copy)return;
    var wallet=String(walletPubkey||'');
    try{
      var capability=await api(WRITE_URL,{op:'capabilities',wallet:wallet,case_ref:caseRef});
      if(generation!==privateGeneration()||requestedWallet!==String(walletPubkey||'')||!sectionIsCurrent(token,caseRef,host))return;
      button.disabled=capability.report_writes_enabled!==true||capability.case_eligible!==true||!wallet;
      copy.textContent=capability.prerequisite||'Submit an exact private Report version with a confirmed mainnet Memo. Review and publication are separate future transitions.';
      button.title=capability.prerequisite||'Submit Report';
    }catch(error){if(generation!==privateGeneration()||requestedWallet!==String(walletPubkey||'')||!sectionIsCurrent(token,caseRef,host))return;button.disabled=true;copy.textContent='Report capability is temporarily unavailable.';button.title=copy.textContent;}
  }
  function reloadSection(item,mode,expectedRenderToken){
    var caseRef=String(item&&item.public_ref||'');
    if(expectedRenderToken!=null&&expectedRenderToken!==state.sectionLoadToken)return;
    if(!caseRef||!state.sectionContext||String(state.sectionContext.public_ref||'')!==caseRef)return;
    var token=++state.sectionLoadToken,host=document.getElementById('osi-public-reports');
    if(!host||!sectionIsCurrent(token,caseRef,host))return;
    refreshSectionAction(item,token,host);
    if(mode==='authorized')refreshAuthorizedReports(item,token,host);else refreshPublicReports(item,token,host);
  }
  function renderSection(item,context){
    context=context||{};var capabilities=context.capabilities||{},authorized=capabilities.analyst_eligible===true||capabilities.maintainer_access===true;
    var ownerConflict=!!walletPubkey&&String(item.submitted_by_wallet||'')===String(walletPubkey);
    var mode=authorized&&!ownerConflict?'authorized':'public';
    var renderToken=++state.sectionLoadToken;state.sectionContext=item;state.sectionMode=mode;
    setTimeout(function(){reloadSection(item,mode,renderToken);},0);
    return'<section class="osi-case-section"><div class="osi-report-action-row"><div><h3>Reports</h3><div class="osi-report-action-copy" id="osi-report-action-copy">'+esc(mode==='authorized'?'Loading public and restricted authorized Report projections...':'Checking exact submission prerequisites...')+'</div></div><button class="osi-report-action" id="osi-report-submit-action" type="button" disabled onclick="osiV2OpenReportForm(\''+esc(item.public_ref)+'\')">Submit Report</button></div><div id="osi-public-reports" aria-live="polite" aria-busy="true"><div class="osi-v2-skeleton"></div></div></section>';
  }

  function evidenceHtml(items){
    if(!items||!items.length)return'';
    return'<div class="osi-report-evidence-list">'+items.map(function(item){return'<div class="osi-report-evidence-item"><span>#'+esc(item.ordinal)+'</span><span>'+esc(label(item.kind))+'</span><span>'+esc(item.ref)+'</span></div>';}).join('')+'</div>';
  }
  function proofHtml(proof){
    if(!proof)return'<span>Proof unavailable</span>';
    var link=/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(String(proof.tx_sig||''))?'<a href="https://solscan.io/tx/'+esc(proof.tx_sig)+'" target="_blank" rel="noopener">Verify on Solscan ↗</a>':'';
    return'<div class="osi-report-proof"><b>'+esc(proof.proof_type==='solana_memo'?'Memo-anchored on Solana':'Proof recorded')+'</b><span>'+esc(dateText(proof.occurred_at))+'</span>'+publicationChannelHtml(proof)+link+'</div>';
  }
  function queueStatus(versionRef,text,kind){
    var node=document.getElementById('osi-review-status-'+versionRef);if(!node)return;
    node.textContent=text||'';node.className='osi-review-status '+(kind||'');
  }
  function publicationRecoveryHtml(versionRef){
    var pending=state.publicationPending[versionRef];
    if(pending){
      var hasTx=!!pending.txSig;
      var failure=pending.lastError?'<p class="osi-report-recovery-error">Last confirmation result: '+esc(userError({message:pending.lastError}))+'</p>':'';
      var explorer=hasTx?'<a href="https://solscan.io/tx/'+esc(pending.txSig)+'" target="_blank" rel="noopener">Open existing transaction on Solscan</a>':'';
      return'<section class="osi-report-recovery" data-publication-recovery="'+esc(versionRef)+'"><h4>'+esc(hasTx?'Recoverable pending transaction':'Prepared publication pending')+'</h4><p>'+esc(hasTx?'Recovery uses the existing transaction signature. Phantom will not open again. The backend rechecks mainnet, signer, exact Memo, block time, nonce, lineage and maintainer authority.':'No transaction signature was submitted yet. Continuing will open Phantom for the prepared Memo.')+'</p>'+failure+explorer+'<div class="osi-report-recovery-actions"><button class="osi-report-publish" type="button" onclick="osiV2RecoverReportPublication(\''+esc(versionRef)+'\')">'+esc(hasTx?'Recover publication':'Continue publication')+'</button><button class="osi-report-action" type="button" onclick="osiV2CancelReportPublication(\''+esc(versionRef)+'\')">Cancel pending publication</button></div></section>';
    }
    var candidates=state.recoveryCandidates[versionRef]||[];
    if(candidates.length){
      return'<section class="osi-report-recovery" data-publication-recovery="'+esc(versionRef)+'"><h4>Recover an existing transaction</h4><p>Use one transaction already sent for this exact prepared proof. Recovery does not open Phantom or create another transaction.</p>'+candidates.map(function(candidate,index){return'<div class="osi-report-recovery-candidate"><div><b>Prepared proof '+esc(index+1)+'</b><span>Issued '+esc(new Date(Number(candidate.issued_at)*1000).toLocaleString())+'; original window ended '+esc(new Date(Number(candidate.expires_at)*1000).toLocaleString())+'</span></div><label for="osi-report-recovery-tx-'+esc(index)+'-'+esc(versionRef)+'">Existing Solana transaction signature</label><input id="osi-report-recovery-tx-'+esc(index)+'-'+esc(versionRef)+'" autocomplete="off" inputmode="text" maxlength="96" pattern="[1-9A-HJ-NP-Za-km-z]{64,96}" aria-describedby="osi-report-recovery-help-'+esc(index)+'-'+esc(versionRef)+'"><small id="osi-report-recovery-help-'+esc(index)+'-'+esc(versionRef)+'">The server accepts it only if signer, Memo, target, nonce, payload hash and block time match this prepared proof.</small><button class="osi-report-publish" type="button" onclick="osiV2RecoverExistingReportPublication(\''+esc(versionRef)+'\','+index+')">Recover with existing transaction</button></div>';}).join('')+'</section>';
    }
    if(state.recoveryErrors[versionRef])return'<div class="osi-report-recovery-error">Recoverable transaction lookup failed: '+esc(state.recoveryErrors[versionRef])+'</div>';
    return'';
  }
  function quorumHtml(version){
    var q=version.quorum||{};
    return'<div class="osi-report-quorum"><span><b>'+esc(q.approve_count||0)+'</b> / '+esc(q.required_count||0)+' approving analysts</span><span><b>'+esc(Number(q.approve_weight||0).toFixed(2))+'</b> / '+esc(Number(q.required_weight||0).toFixed(2))+' approve weight</span></div>';
  }
  function reviewHistoryHtml(version,privateAccess){
    var reviews=(version.reviews||[]).slice().sort(function(a,b){return new Date(b.created_at)-new Date(a.created_at);});
    if(!reviews.length)return'<div class="osi-report-card-meta">No analyst reviews have been cast for this exact version.</div>';
    return'<div class="osi-report-review-history">'+reviews.map(function(review){
      var note=privateAccess&&review.private_note?'<p class="osi-report-private-note" data-osi-user-content><b>Restricted analyst note:</b> '+esc(review.private_note)+'</p>':'';
      return'<div class="osi-report-review-row"><div><b>'+esc(review.reviewer_handle||short(review.reviewer_wallet))+'</b><span>'+esc(label(review.decision))+' · '+esc(Number(review.weight).toFixed(2))+' · '+esc(label(review.tier_snapshot))+(review.is_active?' · active':' · superseded')+sasAuthority(review)+'</span></div><p data-osi-user-content>'+esc(review.public_rationale||'No public-safe rationale recorded.')+'</p>'+note+'<small>'+esc(review.proof&&review.proof.proof_type==='wallet_signed_server_verified'?'Wallet-signed and server-verified':'Proof unavailable')+' · '+esc(dateText(review.created_at))+'</small></div>';
    }).join('')+'</div>';
  }
  function publicationCapability(version){return version&&version.publication_capability||{};}
  function bootstrapRequirement(capability){
    var bootstrap=capability&&capability.bootstrap||{};
    var tier=bootstrap.tier||'unavailable',eligible=bootstrap.eligible_analyst_count;
    var required=bootstrap.required_analyst_count,weight=bootstrap.required_analyst_weight;
    var parts=['Tier '+label(tier)];if(eligible!=null)parts.push(eligible+' live eligible analysts');if(required!=null)parts.push(required+' independent required');if(weight!=null)parts.push(Number(weight).toFixed(2)+' weight required');
    return parts.join(' · ');
  }
  function reviewControls(report,version,mode){
    var current=version.version_ref===report.current_version_ref;
    var actionable=mode==='queue'&&current&&['submitted','in_review'].indexOf(version.lifecycle_state)>=0;
    var canAnalyst=actionable&&report.can_cast_analyst_review===true;
    var canBootstrap=actionable&&report.can_publish_via_maintainer_bootstrap===true;
    var mine=(version.reviews||[]).find(function(review){return review.is_active&&review.reviewer_wallet===String(walletPubkey||'');});
    var capability=publicationCapability(version);
    var standardReady=capability.standard_quorum_ready===true||version.quorum&&version.quorum.approve_ready===true;
    var canPublishStandard=canAnalyst&&version.lifecycle_state==='in_review'&&standardReady&&mine&&mine.decision==='approve';
    var disabled=canAnalyst?'':' disabled';
    var copy=canAnalyst
      ? 'Your decision is bound to this exact immutable version. A revision appends history and supersedes only your prior active review.'
      : mode==='queue'&&report.access==='maintainer'
      ? 'Full maintainers may inspect restricted material. They do not cast analyst weight; any cold-start publication uses the separate maintainer bootstrap channel below.'
      : 'Review controls are unavailable for this wallet or version.';
    var standardReason=capability.standard_publication_reason_code||'Standard analyst quorum is not ready for publication.';
    var analyst='<section class="osi-report-review-controls"><h4>Analyst review</h4>'+quorumHtml(version)+'<p>'+esc(copy)+'</p><form onsubmit="osiV2SubmitReportReview(event,\''+esc(version.version_ref)+'\')"><div class="osi-report-review-grid"><label>Decision <span>Required</span><select id="osi-review-decision-'+esc(version.version_ref)+'"'+disabled+'><option value="approve">Approve for publication</option><option value="reject">Reject</option><option value="request_revision">Request revision</option><option value="abstain">Abstain</option></select></label><label>Reason code <span>Required; safe default provided</span><input id="osi-review-reason-'+esc(version.version_ref)+'" value="'+esc(mine&&mine.reason_code||'evidence_reviewed')+'" pattern="[a-z][a-z0-9_:-]{0,95}" required'+disabled+'></label></div><label>Public-safe rationale <span>Required for reject or request revision; optional otherwise</span><textarea id="osi-review-rationale-'+esc(version.version_ref)+'" minlength="10" maxlength="2000"'+disabled+'>'+esc(mine&&mine.public_rationale||'')+'</textarea></label><label>Restricted analyst note <span>Optional; authorized analysts and full maintainer only</span><textarea id="osi-review-note-'+esc(version.version_ref)+'" maxlength="4000"'+disabled+'>'+esc(mine&&mine.private_note||'')+'</textarea></label><div class="osi-report-review-actions"><button class="osi-report-action" type="submit"'+disabled+'>'+(mine?'Revise my review':'Sign and cast review')+'</button><button class="osi-report-publish" type="button" onclick="osiV2PublishReport(\''+esc(version.version_ref)+'\',\'standard\')"'+(canPublishStandard?'':' disabled title="'+esc(standardReason)+'"')+'>Publish analyst-approved version</button></div></form></section>';
    var prerequisite=capability.maintainer_bootstrap_reason_code||report.bootstrap_prerequisite||'The current server-computed bootstrap tier is not satisfied.';
    var bootstrap='<section class="osi-report-bootstrap"><h4>Maintainer bootstrap publication</h4><p>This is not independent analyst quorum. The receipt is permanently labeled <span class="mono">decision_channel=maintainer_bootstrap</span>.</p><div class="osi-report-card-meta">'+esc(bootstrapRequirement(capability))+'</div><button class="osi-report-publish" type="button" onclick="osiV2PublishReport(\''+esc(version.version_ref)+'\',\'maintainer_bootstrap\')"'+(canBootstrap?'':' disabled title="'+esc(prerequisite)+'"')+'>Publish via maintainer bootstrap</button>'+(canBootstrap?'':'<p>'+esc(prerequisite)+'</p>')+'</section>';
    return publicationRecoveryHtml(version.version_ref)+analyst+(mode==='queue'&&(report.access==='maintainer'||canBootstrap||capability.decision_channel==='maintainer_bootstrap')?bootstrap:'')+'<div id="osi-review-status-'+esc(version.version_ref)+'" class="osi-review-status" role="status" aria-live="polite"></div>'+reviewHistoryHtml(version,true);
  }
  function reportReviewDefaults(decision){
    if(decision==='approve')return{reason:'evidence_reviewed',rationale:'The exact report version and its evidence were reviewed.'};
    if(decision==='abstain')return{reason:'analyst_abstained',rationale:'The analyst abstained from a weighted decision on this version.'};
    if(decision==='reject')return{reason:'evidence_insufficient',rationale:''};
    return{reason:'revision_requested',rationale:''};
  }
  async function submitReportReview(event,versionRef){
    if(event)event.preventDefault();if(state.busy)return;
    var generation=privateGeneration();
    var decision=document.getElementById('osi-review-decision-'+versionRef);
    var reason=document.getElementById('osi-review-reason-'+versionRef);
    var rationale=document.getElementById('osi-review-rationale-'+versionRef);
    var note=document.getElementById('osi-review-note-'+versionRef);
    if(!decision||!reason||!rationale||!note)return;
    var defaults=reportReviewDefaults(decision.value),rationaleValue=rationale.value.trim();
    rationale.setCustomValidity('');
    if((decision.value==='reject'||decision.value==='request_revision')&&rationaleValue.length<10){
      rationale.setCustomValidity('Add a public-safe rationale of at least 10 characters for this decision.');
      rationale.reportValidity();
      rationale.focus();
      return;
    }
    if(!rationaleValue)rationaleValue=defaults.rationale;
    var review={version_public_ref:versionRef,decision:decision.value,reason_code:reason.value.trim()||defaults.reason,public_rationale:rationaleValue,private_note:note.value.trim()||null};
    var key=JSON.stringify(review),pending=state.reviewPending[versionRef];
    if(pending&&pending.key!==key){delete state.reviewPending[versionRef];pending=null;}
    state.busy=true;
    try{
      var wallet=await ensureWallet();
      assertPrivateGeneration(generation);
      if(!pending){
        queueStatus(versionRef,'Preparing exact version, analyst snapshot, nonce and payload hash...');
        var prepared=await api(WRITE_URL,{op:'prepare_review',wallet:wallet,review:review,idempotency_key:'report-review:'+(crypto.randomUUID?crypto.randomUUID():Date.now()+Math.random().toString(36).slice(2))});
        assertPrivateGeneration(generation);
        if(prepared.already_committed){queueStatus(versionRef,'This exact review was already committed. Reloading...','success');setTimeout(function(){if(generation===privateGeneration())openReportWorkspace('queue');},350);return;}
        pending={key:key,prepared:prepared,signature:''};state.reviewPending[versionRef]=pending;
      }
      if(!pending.signature){queueStatus(versionRef,'Approve the exact review message in Phantom. This is not an on-chain transaction.');pending.signature=await signMessage(pending.prepared.message);assertPrivateGeneration(generation);}
      queueStatus(versionRef,'Verifying signer, eligibility, immutable target, weight snapshot and replay binding...');
      var committed=await api(WRITE_URL,{op:'commit_review',wallet:wallet,review:review,nonce:pending.prepared.nonce,message:pending.prepared.message,signature:pending.signature});
      assertPrivateGeneration(generation);
      delete state.reviewPending[versionRef];queueStatus(versionRef,'Review recorded at '+Number(committed.weight).toFixed(2)+' weight.','success');
      if(typeof window.osiV2RemoveDraft==='function')window.osiV2RemoveDraft(workspaceDraftKey(wallet));
      if(typeof showToast==='function')showToast(committed.decision+' review is wallet-signed and server-verified.');
      setTimeout(function(){if(generation===privateGeneration())openReportWorkspace('queue');},500);
    }catch(error){if(generation===privateGeneration()){queueStatus(versionRef,userError(error),'error');if(['proof_binding_rejected','bad_signature','lineage_changed_retry'].indexOf(String(error.message))>=0)delete state.reviewPending[versionRef];}}
    finally{if(generation===privateGeneration())state.busy=false;}
  }
  async function publishReport(versionRef,route){
    route=route==='maintainer_bootstrap'?'maintainer_bootstrap':'standard';
    if(state.busy)return;var generation=privateGeneration();state.busy=true;
    try{
      var wallet=await ensureWallet();var pending=state.publicationPending[versionRef]||loadPublicationPending(wallet,versionRef);
      assertPrivateGeneration(generation);state.publicationWallet=wallet;
      if(pending&&pending.route!==route){
        if(pending.txSig)throw new Error('pending_publication_route_mismatch');
        removePublicationPending(wallet,versionRef);pending=null;
      }
      if(!pending){
        queueStatus(versionRef,route==='maintainer_bootstrap'?'Checking the server-computed D17 tier and preparing a maintainer-bootstrap REPORT_PUBLISHED receipt...':'Freezing the exact active analyst quorum snapshot and preparing REPORT_PUBLISHED...');
        var idempotencyKey='report-publish:'+(crypto.randomUUID?crypto.randomUUID():Date.now()+Math.random().toString(36).slice(2));
        var prepareBody={op:'prepare_publication',wallet:wallet,version_public_ref:versionRef,idempotency_key:idempotencyKey};
        if(route==='maintainer_bootstrap')prepareBody.route='maintainer_bootstrap';
        var prepared=await api(WRITE_URL,prepareBody);
        assertPrivateGeneration(generation);
        if(prepared.already_committed){removePublicationPending(wallet,versionRef);queueStatus(versionRef,'This exact version is already published. Inspect its retained publication receipt.','success');return;}
        pending={route:route,versionRef:versionRef,wallet:wallet,nonce:String(prepared.nonce||''),memo:String(prepared.memo||''),txSig:'',expiresAt:Number(prepared.expires_at),idempotencyKey:idempotencyKey,lastError:'',updatedAt:Date.now()};
        if(!savePublicationPending(pending))throw new Error('publication_recovery_storage_unavailable');
        state.publicationPending[versionRef]=pending;
      }
      if(!pending.txSig){
        queueStatus(versionRef,'Approve the exact REPORT_PUBLISHED Memo in Phantom. OSI receives no funds.');
        pending.txSig=await castOnchainVote(pending.memo);assertPrivateGeneration(generation);pending.updatedAt=Date.now();
        if(!savePublicationPending(pending))throw new Error('publication_recovery_storage_unavailable');
      }else queueStatus(versionRef,'Retrying confirmation with the existing transaction. Phantom will not open again.');
      queueStatus(versionRef,'Confirming mainnet, signer, exact version, quorum hash, nonce and Memo...');
      var committed=await commitWithConfirmation({op:'commit_publication',wallet:wallet,version_public_ref:versionRef,nonce:pending.nonce,memo:pending.memo,tx_sig:pending.txSig},generation,function(retryText){queueStatus(versionRef,retryText+' Phantom will not open again.');});
      assertPrivateGeneration(generation);
      removePublicationPending(wallet,versionRef);
      var channel=committed.decision_channel||route;
      queueStatus(versionRef,(channel==='maintainer_bootstrap'?'Published via maintainer bootstrap; this is not independent analyst quorum. decision_channel=maintainer_bootstrap. ':'Published through the standard analyst-quorum route. ')+'The parent Case remains open and unchanged.','success');
      if(typeof showToast==='function')showToast(committed.version_public_ref+' is Memo-anchored and public.');
    }catch(error){if(generation===privateGeneration()){
      var code=String(error.message||'');pending=state.publicationPending[versionRef]||loadPublicationPending(String(walletPubkey||''),versionRef);
      var terminal=['proof_binding_rejected','lineage_changed_retry','transaction_failed','wrong_cluster','wrong_signer','wrong_memo','stale_transaction','publication_transaction_outside_window'].indexOf(code)>=0;
      if(terminal&&pending)removePublicationPending(pending.wallet,versionRef);else if(pending){pending.lastError=code;pending.updatedAt=Date.now();state.publicationPending[versionRef]=pending;savePublicationPending(pending);}
      queueStatus(versionRef,userError(error),terminal?'error':'');
    }}finally{if(generation===privateGeneration())state.busy=false;}
  }
  async function recoverExistingPublication(versionRef,index){
    var candidate=(state.recoveryCandidates[versionRef]||[])[Number(index)];
    var input=document.getElementById('osi-report-recovery-tx-'+Number(index)+'-'+versionRef);if(!candidate||!input)return;
    var txSig=input.value.trim();input.setCustomValidity('');
    if(!/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(txSig)){input.setCustomValidity('Enter the existing Solana transaction signature for this prepared proof.');input.reportValidity();input.focus();return;}
    var wallet=await ensureWallet();var pending={route:'maintainer_bootstrap',versionRef:versionRef,wallet:wallet,nonce:String(candidate.nonce||''),memo:String(candidate.memo||''),txSig:txSig,expiresAt:Number(candidate.expires_at),idempotencyKey:String(candidate.idempotency_key||''),lastError:'',updatedAt:Date.now()};
    if(!savePublicationPending(pending)){queueStatus(versionRef,'The bounded recovery record could not be saved in this browser.','error');return;}
    state.publicationWallet=wallet;state.publicationPending[versionRef]=pending;await publishReport(versionRef,'maintainer_bootstrap');
  }
  function cancelPublication(versionRef){
    var pending=state.publicationPending[versionRef]||loadPublicationPending(String(walletPubkey||''),versionRef);if(pending)removePublicationPending(pending.wallet,versionRef);
    queueStatus(versionRef,'Pending browser recovery was canceled. Any existing Solana transaction remains immutable and can be re-entered while the server still proves every binding.');
    openReportWorkspace('queue');
  }
  function reportLifecycleLabel(value,version){
    value=String(value||'');
    if(value==='published')return'Published';
    if(['rejected','closed','withdrawn'].indexOf(value)>=0)return'Rejected / closed';
    if(value==='revision_requested')return'Revision requested';
    if(['ready_for_publication','approved'].indexOf(value)>=0)return'Ready for publication';
    if(value==='in_review'){
      var capability=publicationCapability(version),quorum=version&&version.quorum||{};
      return capability.standard_quorum_ready===true||quorum.approve_ready===true?'Ready for publication':'In review';
    }
    if(value==='submitted'||value==='active')return'Awaiting analyst / maintainer review';
    return label(value||'submitted');
  }
  function reportNextStep(report,version){
    var status=reportLifecycleLabel(version&&version.lifecycle_state,version);
    if(status==='Revision requested')return'Create a new immutable revision that answers the recorded request.';
    if(status==='Ready for publication')return'The authorized publication route must anchor this exact version with a confirmed Memo.';
    if(status==='Published')return'This exact version is public. Later corrections create a new version and preserve this history.';
    if(status==='Rejected / closed')return'Inspect the retained review history; no silent rewrite or deletion occurs.';
    if(status==='In review')return'Independent count and weight gates continue on this exact version.';
    return'An eligible analyst or full maintainer may inspect this exact version. The author cannot review or publish it.';
  }
  function reportCard(report,mode){
    var versions=(report.versions||[]).slice().sort(function(a,b){return Number(b.version_no)-Number(a.version_no);});
    var current=versions.find(function(version){return version.version_ref===report.current_version_ref;})||versions[0]||{};
    var revision=mode==='mine'&&report.revision_eligible?'<button class="osi-report-action" type="button" onclick="osiV2OpenReportForm(\''+esc(report.case_public_ref)+'\')">Create revision</button>':'';
    return'<article class="osi-report-card" data-report-ref="'+esc(report.report_public_ref)+'" tabindex="-1"><div class="osi-report-card-head"><div><div class="osi-report-card-kicker"><span>'+esc(report.case_public_ref)+'</span><span>'+esc(report.report_public_ref)+'</span></div><h3>Exact version '+esc(report.current_version_no)+'</h3><div class="osi-report-card-meta">'+(mode==='queue'?'Author '+esc(short(report.author_wallet))+' · ':'')+'Submitted '+esc(dateText(current.submitted_at))+' · '+esc(report.current_version_ref)+'</div></div><span class="osi-report-state" data-report-lifecycle="'+esc(current.lifecycle_state)+'">'+esc(reportLifecycleLabel(current.lifecycle_state,current))+'</span></div><div class="osi-report-card-head"><div class="osi-report-card-meta">'+esc(reportNextStep(report,current))+'</div>'+revision+'</div><details'+(mode==='queue'?' open':'')+'><summary>Version history ('+versions.length+')</summary>'+versions.map(function(version){return'<section class="osi-report-version" data-report-version-ref="'+esc(version.version_ref)+'" tabindex="-1"><div class="osi-report-version-head"><div><div class="osi-report-version-ref">'+esc(version.version_ref)+' · version '+esc(version.version_no)+'</div><small>'+esc(reportLifecycleLabel(version.lifecycle_state,version))+' · '+esc(dateText(version.submitted_at))+'</small></div><span class="mono">sha256 '+esc(short(version.evidence_snapshot_hash))+'</span></div><p data-osi-user-content>'+esc(version.body_private)+'</p>'+(version.content_public_safe?'<p data-osi-user-content><b>Public-safe summary:</b> '+esc(version.content_public_safe)+'</p>':'')+evidenceHtml(version.evidence)+proofHtml(version.proof)+(mode==='queue'?reviewControls(report,version,mode):reviewHistoryHtml(version,false))+'</section>';}).join('')+'</details></article>';
  }
  function setWorkspaceCopy(mode,count){
    var eyebrow=document.getElementById('fo-eyebrow'),title=document.getElementById('fo-title'),sub=document.getElementById('fo-sub'),counter=document.getElementById('fo-count');
    if(eyebrow)eyebrow.textContent=mode==='mine'?'Private author workspace':'Authorized Report review queue';
    if(title)title.textContent=mode==='mine'?'My Reports':'Awaiting Report Review';
    if(sub)sub.textContent=mode==='mine'?'Your exact immutable Report versions, evidence manifests, and Solana proof.':'Exact private versions for eligible analyst review or full-maintainer inspection. Only analysts count toward publication quorum.';
    if(counter)counter.textContent=count+' '+(count===1?'Report':'Reports');
  }
  function drawWorkspace(reports,mode,notice){
    var host=document.getElementById('field-cases');if(!host)return;
    setWorkspaceCopy(mode,reports.length);
    host.innerHTML=(notice?'<div class="osi-case-note">'+esc(notice)+'</div>':'')+(reports.length?'<div class="osi-report-workspace">'+reports.map(function(report){return reportCard(report,mode);}).join('')+'</div>':'<div class="osi-report-empty"><b>'+esc(mode==='mine'?'No Reports for this wallet':'No Reports currently await this wallet')+'</b><p>'+esc(mode==='mine'?'Open an eligible public Case and use Submit Report.':'Only server-authorized, non-self Report versions appear here.')+'</p></div>');
    if(mode==='queue')host.querySelectorAll('.osi-report-version').forEach(function(section){
      var controls=section.querySelector('.osi-report-review-controls,.osi-report-bootstrap');if(!controls)return;
      var jump=document.createElement('button');jump.type='button';jump.className='osi-report-action primary osi-report-review-jump';jump.textContent=t('Review this exact version');
      jump.addEventListener('click',function(){
        controls.scrollIntoView({block:'start',behavior:'smooth'});
        var target=controls.querySelector('select:not([disabled]),button:not([disabled]),textarea:not([disabled]),input:not([disabled])');
        if(target)setTimeout(function(){target.focus();},0);else{controls.setAttribute('tabindex','-1');setTimeout(function(){controls.focus();},0);}
      });
      var head=section.querySelector('.osi-report-version-head');if(head)head.insertAdjacentElement('afterend',jump);
    });
    var enabled=mode==='queue'&&reports.some(function(report){return report.can_cast_analyst_review===true||report.can_publish_via_maintainer_bootstrap===true;});
    var stats=document.getElementById('field-stats');if(stats)stats.innerHTML='<div class="osi-stat"><span>Visible</span><b>'+reports.length+'</b></div><div class="osi-stat"><span>Immutable versions</span><b>'+reports.reduce(function(sum,report){return sum+(report.versions||[]).length;},0)+'</b></div><div class="osi-stat"><span>Review controls</span><b>'+esc(mode==='queue'?(enabled?'Authorized route available':'No current action'):'N/A')+'</b></div>';
    var deck=document.getElementById('fo-deck');if(deck)deck.hidden=true;
    var nav=document.getElementById('fo-pnav');if(nav)nav.innerHTML='';
  }
  async function openReportWorkspace(mode){
    state.queueMode=mode;
    if(typeof showView==='function')showView('field');
    if(typeof window.osiV2SetFieldReviewChrome==='function')window.osiV2SetFieldReviewChrome(false);
    var host=document.getElementById('field-cases');if(host)host.innerHTML='<div class="osi-v2-skeleton"></div><div class="osi-v2-skeleton"></div>';
    try{
      var result=mode==='mine'?await sessionRead('report:mine','list_my_reports'):await loadReviewQueueData();
      if(mode==='mine'){state.cacheWallet=String(walletPubkey||'');state.myReports=result.reports||[];}
      if(mode==='queue')restorePublicationPending(result.reports||[],String(walletPubkey||''));
      drawWorkspace(result.reports||[],mode,result.next_prerequisite||'');
      restoreWorkspaceDraft();
    }catch(error){
      setWorkspaceCopy(mode,0);
      if(host){var refresh=/^read_session_(expired|wrong_scope)$/.test(String(error&&error.message||''));host.innerHTML='<div class="osi-v2-empty osi-v2-error"><b>Report workspace locked</b><span>'+esc(userError(error))+'</span><button class="osi-report-action" type="button" onclick="'+(refresh?('osiV2RefreshReportWorkspace(\''+esc(mode)+'\')'):(mode==='mine'?'osiV2OpenMyReports()':'osiV2OpenReportQueue()'))+'">'+(refresh?'Refresh private access':'Try again')+'</button></div>';}
    }
  }
  async function openReportQueueTarget(versionRef){
    await openReportWorkspace('queue');
    var target=Array.prototype.find.call(document.querySelectorAll('[data-report-version-ref]'),function(node){return node.getAttribute('data-report-version-ref')===String(versionRef||'');});
    if(!target){if(typeof showToast==='function')showToast('The exact Report task is no longer in this authorized queue. Refresh My Reviews.');return null;}
    var details=target.closest('details');if(details)details.open=true;target.scrollIntoView({block:'center',behavior:'auto'});target.focus();return target;
  }

  function trapFocus(event,root){
    if(event.key!=='Tab'||!root)return;
    var nodes=Array.prototype.filter.call(root.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'),function(node){return node.offsetParent!==null;});
    if(!nodes.length)return;var first=nodes[0],last=nodes[nodes.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
  document.addEventListener('keydown',function(event){
    var modal=document.getElementById('osi-report-modal');if(!modal||!modal.classList.contains('open'))return;
    if(event.key==='Escape'){event.preventDefault();closeReportForm();return;}
    trapFocus(event,modal);
  });

  window.osiReportRenderSection=renderSection;
  window.osiV2OpenReportForm=openReportForm;
  window.osiV2CloseReportForm=closeReportForm;
  window.osiV2SubmitReport=submitReport;
  window.osiV2SubmitReportReview=submitReportReview;
  window.osiV2PublishReport=publishReport;
  window.osiV2RecoverReportPublication=function(versionRef){
    var pending=state.publicationPending[versionRef]||loadPublicationPending(String(walletPubkey||''),versionRef);
    if(!pending){queueStatus(versionRef,'No bounded browser recovery record is available. Reopen the exact review task.','error');return;}
    return publishReport(versionRef,pending.route);
  };
  window.osiV2RecoverExistingReportPublication=recoverExistingPublication;
  window.osiV2CancelReportPublication=cancelPublication;
  window.osiV2ReportClearSession=clearSessionState;
  window.osiV2RefreshPublicReports=function(){if(state.sectionContext)reloadSection(state.sectionContext,'public');};
  window.osiV2RefreshCaseReports=function(){if(state.sectionContext)reloadSection(state.sectionContext,state.sectionMode);};
  window.osiV2OpenMyReports=function(){openReportWorkspace('mine');};
  window.osiV2OpenReportQueue=function(){openReportWorkspace('queue');};
  window.osiV2OpenReportQueueTarget=openReportQueueTarget;
  window.osiV2LoadReportReviewTasks=loadReviewQueueData;
  window.osiV2RefreshReportWorkspace=function(mode){var scope=mode==='queue'?'report:review':'report:mine';return window.osiV2RefreshReadSession([scope]).then(function(){return openReportWorkspace(mode==='queue'?'queue':'mine');});};
  var reportDraftForm=document.getElementById('osi-report-form');
  if(reportDraftForm){reportDraftForm.addEventListener('input',saveDraft);reportDraftForm.addEventListener('change',saveDraft);}
  var reportWorkspace=document.getElementById('field-cases');
  if(reportWorkspace){reportWorkspace.addEventListener('input',saveWorkspaceDraft);reportWorkspace.addEventListener('change',saveWorkspaceDraft);}
  if(typeof window.osiV2RegisterPrivateCache==='function')window.osiV2RegisterPrivateCache('reports',clearSessionState);
})();
