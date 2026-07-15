/* Native V2 Case Report intake and private immutable history. */
(function(){
  'use strict';

  var WRITE_URL=SUPABASE_URL+'/functions/v1/osi-v2-report-write';
  var READ_URL=SUPABASE_URL+'/functions/v1/osi-v2-report-read';
  var state={
    caseRef:'',isRevision:false,idempotency:'',pending:null,returnFocus:null,
    cacheWallet:'',myReports:[],sectionContext:null,busy:false,
    reviewPending:{},publicationPending:{},queueMode:''
  };

  function clearSessionState(){
    state.cacheWallet='';state.myReports=[];state.pending=null;state.idempotency='';
    state.reviewPending={};state.publicationPending={};state.queueMode='';
    state.returnFocus=null;
    var form=document.getElementById('osi-report-form');if(form)form.reset();
    var modal=document.getElementById('osi-report-modal');if(modal)modal.classList.remove('open');
    syncBodyLock();status('');
    if(document.body&&document.body.dataset.view==='field'){
      var host=document.getElementById('field-cases');
      if(host)host.innerHTML='<div class="osi-v2-empty"><b>Report workspace locked</b><span>Reconnect and sign a fresh read authorization for this wallet.</span></div>';
    }
  }

  function esc(value){
    return String(value==null?'':value).replace(/[&<>"']/g,function(char){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char];
    });
  }
  function short(value){value=String(value||'');return value.length>18?value.slice(0,8)+'...'+value.slice(-6):value;}
  function label(value){return String(value||'').replace(/_/g,' ').replace(/\b\w/g,function(char){return char.toUpperCase();});}
  function dateText(value){var date=new Date(value||'');return isNaN(date.getTime())?'Not recorded':date.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});}
  function randomKey(){var id=crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(36).slice(2);return'report:'+id.replace(/[^A-Za-z0-9.-]/g,'');}
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
      rpc_unavailable:'Solana confirmation is temporarily unavailable. Retry safely with the same transaction.',
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
    var provider=typeof getProvider==='function'?getProvider():null;
    if(!provider||typeof provider.signMessage!=='function')throw new Error('This wallet does not support signMessage.');
    var signed=await provider.signMessage(new TextEncoder().encode(message),'utf8');
    var bytes=signed&&signed.signature?signed.signature:signed;
    if(!(bytes instanceof Uint8Array))bytes=new Uint8Array(bytes||[]);
    return bytesToBase64(bytes);
  }
  async function signedRead(scope,op){
    var wallet=await ensureWallet();
    var issue=await api(READ_URL,{op:'issue_read_challenge',scope:scope,wallet:wallet});
    var signature=await signMessage(issue.challenge);
    return await api(READ_URL,{op:op,wallet:wallet,challenge:issue.challenge,signature:signature});
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
    var result=await signedRead('my_reports','list_my_reports');
    state.cacheWallet=wallet;state.myReports=result.reports||[];
    return state.myReports;
  }

  async function openReportForm(caseRef){
    state.returnFocus=document.activeElement;
    try{
      var wallet=await ensureWallet();
      var capability=await api(WRITE_URL,{op:'capabilities',wallet:wallet,case_ref:caseRef});
      if(capability.report_writes_enabled!==true)throw new Error('report_writes_disabled');
      if(capability.case_eligible!==true)throw new Error('case_not_available');
      status('Authorizing access to your private Report lineage...');
      var rows=state.cacheWallet===wallet?state.myReports:await loadMyReports();
      var existing=rows.find(function(report){return report.case_public_ref===caseRef;});
      state.caseRef=caseRef;state.isRevision=!!existing;
      if(!state.pending||state.pending.caseRef!==caseRef||state.pending.wallet!==wallet){state.idempotency=randomKey();state.pending=null;}
      var revision=document.getElementById('osi-report-revision-wrap');
      var reason=document.getElementById('osi-report-revision-reason');
      revision.hidden=!state.isRevision;reason.required=state.isRevision;
      var context=document.getElementById('osi-report-context');
      context.textContent=state.isRevision
        ? caseRef+' · Revision of '+existing.report_public_ref+' · Next version '+(Number(existing.current_version_no)+1)
        : caseRef+' · Initial immutable version 1';
      var modal=document.getElementById('osi-report-modal');modal.classList.add('open');syncBodyLock();status('');
      setTimeout(function(){document.getElementById('osi-report-narrative').focus();},40);
    }catch(error){status('');if(typeof showToast==='function')showToast(userError(error));if(state.returnFocus&&document.contains(state.returnFocus))state.returnFocus.focus();state.returnFocus=null;}
  }
  function closeReportForm(){
    var modal=document.getElementById('osi-report-modal');if(modal)modal.classList.remove('open');syncBodyLock();
    if(state.returnFocus&&document.contains(state.returnFocus))state.returnFocus.focus();state.returnFocus=null;
  }

  async function commitWithConfirmation(body){
    var lastError;
    for(var attempt=0;attempt<5;attempt++){
      try{return await api(WRITE_URL,body);}catch(error){
        lastError=error;
        if(['transaction_not_confirmed','rpc_unavailable'].indexOf(String(error.message))<0)throw error;
        status('Waiting for Solana RPC confirmation. Retry '+(attempt+1)+' of 5...');
        await new Promise(function(resolve){setTimeout(resolve,1600+attempt*900);});
      }
    }
    throw lastError;
  }

  async function submitReport(event){
    if(event)event.preventDefault();
    var form=document.getElementById('osi-report-form');
    if(!form||!form.reportValidity()||state.busy)return;
    var report=payload();
    if(report.evidence.length<1){status('Add at least one wallet, transaction, or HTTPS evidence reference.','error');return;}
    if(report.evidence.length>12){status('A Report version can include at most 12 evidence references.','error');return;}
    state.busy=true;var button=document.getElementById('osi-report-submit');button.disabled=true;button.setAttribute('aria-busy','true');
    try{
      var wallet=await ensureWallet();
      var key=payloadKey(report);
      if(state.pending&&state.pending.payloadKey!==key){
        state.pending=null;state.idempotency=randomKey();
      }
      if(!state.idempotency)state.idempotency=randomKey();
      if(!state.pending){
        status('Preparing the exact Case, version, evidence manifest, nonce, and payload hash...');
        var prepared=await api(WRITE_URL,{op:'prepare_report',wallet:wallet,case_ref:state.caseRef,report:report,idempotency_key:state.idempotency});
        if(prepared.already_committed){
          status('This exact version was already committed. Opening My Reports.','success');
          await loadMyReports();setTimeout(function(){closeReportForm();openReportWorkspace('mine');},450);return;
        }
        state.pending={caseRef:state.caseRef,wallet:wallet,payloadKey:key,prepared:prepared,txSig:''};
      }
      if(!state.pending.txSig){
        status('Approve the exact CASE_REPORT_VERSION_SUBMITTED Memo in Phantom. OSI receives no funds.');
        state.pending.txSig=await castOnchainVote(state.pending.prepared.memo);
      }
      status('Confirming mainnet, signer, exact Memo, freshness, nonce, and payload hash...');
      var committed=await commitWithConfirmation({
        op:'commit_report',wallet:wallet,report:report,nonce:state.pending.prepared.nonce,
        memo:state.pending.prepared.memo,tx_sig:state.pending.txSig
      });
      status('Version '+committed.version_no+' is submitted with a server-verified Solana Memo receipt.','success');
      if(typeof showToast==='function')showToast(committed.report_public_ref+' version '+committed.version_no+' is Memo-anchored on Solana.');
      state.pending=null;state.idempotency='';form.reset();state.cacheWallet='';state.myReports=[];
      setTimeout(function(){closeReportForm();openReportWorkspace('mine');},650);
    }catch(error){
      status(userError(error),'error');
      if(['proof_binding_rejected','lineage_changed_retry','transaction_failed','wrong_cluster','wrong_signer','wrong_memo'].indexOf(String(error.message))>=0){state.pending=null;state.idempotency=randomKey();}
    }finally{state.busy=false;button.disabled=false;button.removeAttribute('aria-busy');}
  }

  function publicReviewTimeline(rows){
    if(!rows||!rows.length)return'';
    return'<div class="osi-report-timeline"><h4>Review timeline</h4>'+rows.map(function(review){
      return'<div class="osi-report-timeline-item"><div><b>'+esc(review.reviewer_handle||short(review.reviewer_wallet))+'</b><span>'+esc(label(review.decision))+' · '+esc(Number(review.weight).toFixed(2))+' weight · '+esc(label(review.tier_snapshot))+'</span></div><p>'+esc(review.public_rationale)+'</p><small>'+esc(review.actor_role)+' · '+esc(review.proof_type==='wallet_signed_server_verified'?'Wallet-signed and server-verified':'Proof recorded')+' · '+esc(dateText(review.created_at))+(review.is_active?' · active':' · superseded')+'</small></div>';
    }).join('')+'</div>';
  }
  function publicEvidence(rows){
    if(!rows||!rows.length)return'';
    return'<div class="osi-report-public-evidence"><h4>Publishable evidence</h4>'+rows.map(function(item){
      var value=item.kind==='url'?'<a href="'+esc(item.ref)+'" target="_blank" rel="noopener">'+esc(item.ref)+'</a>':'<span>'+esc(item.ref)+'</span>';
      return'<div><b>#'+esc(item.ordinal)+' '+esc(label(item.kind))+'</b>'+value+'</div>';
    }).join('')+'</div>';
  }
  function publishedRows(rows){
    if(!rows.length)return'<div class="osi-v2-empty"><b>No public Report activity</b><span>A Report stays private until its first counted approval. Full content appears only after publication.</span></div>';
    return'<div class="osi-report-public-list">'+rows.map(function(row){
      var q=row.quorum||{};
      var progress='<div class="osi-report-quorum" aria-label="Publication quorum"><span><b>'+esc(q.approve_count||0)+'</b> / '+esc(q.required_count||0)+' analysts</span><span><b>'+esc(Number(q.approve_weight||0).toFixed(2))+'</b> / '+esc(Number(q.required_weight||0).toFixed(2))+' weight</span></div>';
      var content=row.state==='published'
        ? '<p class="osi-report-public-body">'+esc(row.body||'')+'</p>'+(row.content_public_safe?'<p><b>Public-safe summary:</b> '+esc(row.content_public_safe)+'</p>':'')+publicEvidence(row.evidence)
        : '<p class="osi-report-under-review">The exact version is under independent review. Narrative, evidence, author identity, internal references and restricted notes remain private.</p>';
      var proof=row.publication_proof&&row.publication_proof.tx_sig?'<a class="osi-report-chain-link" href="https://solscan.io/tx/'+esc(row.publication_proof.tx_sig)+'" target="_blank" rel="noopener">Verify REPORT_PUBLISHED on Solscan ↗</a>':'';
      return'<article class="osi-report-public-card"><div class="osi-list-item-head"><div><b>'+esc(row.report_public_ref)+'</b><small>'+esc(row.version_public_ref)+' · version '+esc(row.version_no)+'</small></div><span class="osi-proof-label">'+esc(row.state==='published'?'Published':'Under review')+'</span></div>'+progress+content+publicReviewTimeline(row.review_timeline)+proof+'<p class="osi-report-process-note">'+esc(row.process_notice)+'</p></article>';
    }).join('')+'</div>';
  }
  async function refreshPublicReports(item){
    var host=document.getElementById('osi-public-reports');if(!host)return;
    try{
      var result=await api(READ_URL,{op:'list_public_reports',case_ref:item.public_ref});
      host.innerHTML=publishedRows(result.reports||[]);
    }catch(error){
      host.innerHTML='<div class="osi-v2-empty osi-v2-error"><b>Public Report status unavailable</b><span>'+esc(userError(error))+'</span><button class="osi-report-action" type="button" onclick="osiV2RefreshPublicReports()">Try again</button></div>';
    }
  }
  async function refreshSectionAction(item){
    var button=document.getElementById('osi-report-submit-action');
    var copy=document.getElementById('osi-report-action-copy');
    if(!button||!copy)return;
    var wallet=String(walletPubkey||'');
    try{
      var capability=await api(WRITE_URL,{op:'capabilities',wallet:wallet,case_ref:item.public_ref});
      button.disabled=capability.report_writes_enabled!==true||capability.case_eligible!==true||!wallet;
      copy.textContent=capability.prerequisite||'Submit an exact private Report version with a confirmed mainnet Memo. Review and publication are separate future transitions.';
      button.title=capability.prerequisite||'Submit Report';
    }catch(error){button.disabled=true;copy.textContent='Report capability is temporarily unavailable.';button.title=copy.textContent;}
  }
  function renderSection(item){
    state.sectionContext=item;
    setTimeout(function(){refreshSectionAction(item);refreshPublicReports(item);},0);
    return'<section class="osi-case-section"><div class="osi-report-action-row"><div><h3>Reports</h3><div class="osi-report-action-copy" id="osi-report-action-copy">Checking exact submission prerequisites...</div></div><button class="osi-report-action" id="osi-report-submit-action" type="button" disabled onclick="osiV2OpenReportForm(\''+esc(item.public_ref)+'\')">Submit Report</button></div><div id="osi-public-reports" aria-live="polite"><div class="osi-v2-skeleton"></div></div></section>';
  }

  function evidenceHtml(items){
    if(!items||!items.length)return'';
    return'<div class="osi-report-evidence-list">'+items.map(function(item){return'<div class="osi-report-evidence-item"><span>#'+esc(item.ordinal)+'</span><span>'+esc(label(item.kind))+'</span><span>'+esc(item.ref)+'</span></div>';}).join('')+'</div>';
  }
  function proofHtml(proof){
    if(!proof)return'<span>Proof unavailable</span>';
    var link=/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(String(proof.tx_sig||''))?'<a href="https://solscan.io/tx/'+esc(proof.tx_sig)+'" target="_blank" rel="noopener">Verify on Solscan ↗</a>':'';
    return'<div class="osi-report-proof"><b>'+esc(proof.proof_type==='solana_memo'?'Memo-anchored on Solana':'Proof recorded')+'</b><span>'+esc(dateText(proof.occurred_at))+'</span>'+link+'</div>';
  }
  function queueStatus(versionRef,text,kind){
    var node=document.getElementById('osi-review-status-'+versionRef);if(!node)return;
    node.textContent=text||'';node.className='osi-review-status '+(kind||'');
  }
  function quorumHtml(version){
    var q=version.quorum||{};
    return'<div class="osi-report-quorum"><span><b>'+esc(q.approve_count||0)+'</b> / '+esc(q.required_count||0)+' approving analysts</span><span><b>'+esc(Number(q.approve_weight||0).toFixed(2))+'</b> / '+esc(Number(q.required_weight||0).toFixed(2))+' approve weight</span></div>';
  }
  function reviewHistoryHtml(version,privateAccess){
    var reviews=(version.reviews||[]).slice().sort(function(a,b){return new Date(b.created_at)-new Date(a.created_at);});
    if(!reviews.length)return'<div class="osi-report-card-meta">No analyst reviews have been cast for this exact version.</div>';
    return'<div class="osi-report-review-history">'+reviews.map(function(review){
      var note=privateAccess&&review.private_note?'<p class="osi-report-private-note"><b>Restricted analyst note:</b> '+esc(review.private_note)+'</p>':'';
      return'<div class="osi-report-review-row"><div><b>'+esc(review.reviewer_handle||short(review.reviewer_wallet))+'</b><span>'+esc(label(review.decision))+' · '+esc(Number(review.weight).toFixed(2))+' · '+esc(label(review.tier_snapshot))+(review.is_active?' · active':' · superseded')+'</span></div><p>'+esc(review.public_rationale||'No public-safe rationale recorded.')+'</p>'+note+'<small>'+esc(review.proof&&review.proof.proof_type==='wallet_signed_server_verified'?'Wallet-signed and server-verified':'Proof unavailable')+' · '+esc(dateText(review.created_at))+'</small></div>';
    }).join('')+'</div>';
  }
  function reviewControls(report,version){
    var current=version.version_ref===report.current_version_ref;
    var mutations=state.queueMode==='queue'&&report.review_mutations_enabled===true&&current&&['submitted','in_review'].indexOf(version.lifecycle_state)>=0;
    var mine=(version.reviews||[]).find(function(review){return review.is_active&&review.reviewer_wallet===String(walletPubkey||'');});
    var canPublish=mutations&&version.lifecycle_state==='in_review'&&version.quorum&&version.quorum.approve_ready&&mine&&mine.decision==='approve';
    var disabled=mutations?'':' disabled';
    var copy=mutations
      ? 'Your decision is bound to this exact immutable version. A revision appends history and supersedes only your prior active review.'
      : state.queueMode==='queue'&&report.access==='maintainer'
      ? 'Full maintainers may inspect restricted material, but cannot cast or replace analyst quorum.'
      : 'Review controls are unavailable for this wallet or version.';
    return'<section class="osi-report-review-controls"><h4>Analyst review</h4>'+quorumHtml(version)+'<p>'+esc(copy)+'</p><form onsubmit="osiV2SubmitReportReview(event,\''+esc(version.version_ref)+'\')"><div class="osi-report-review-grid"><label>Decision<select id="osi-review-decision-'+esc(version.version_ref)+'"'+disabled+'><option value="approve">Approve for publication</option><option value="reject">Reject</option><option value="request_revision">Request revision</option><option value="abstain">Abstain</option></select></label><label>Reason code<input id="osi-review-reason-'+esc(version.version_ref)+'" value="'+esc(mine&&mine.reason_code||'evidence_reviewed')+'" pattern="[a-z][a-z0-9_:-]{0,95}" required'+disabled+'></label></div><label>Public-safe rationale<textarea id="osi-review-rationale-'+esc(version.version_ref)+'" minlength="10" maxlength="2000" required'+disabled+'>'+esc(mine&&mine.public_rationale||'')+'</textarea></label><label>Restricted analyst note <span>optional, authorized analysts and full maintainer only</span><textarea id="osi-review-note-'+esc(version.version_ref)+'" maxlength="4000"'+disabled+'>'+esc(mine&&mine.private_note||'')+'</textarea></label><div class="osi-report-review-actions"><button class="osi-report-action" type="submit"'+disabled+'>'+(mine?'Revise my review':'Sign and cast review')+'</button><button class="osi-report-publish" type="button" onclick="osiV2PublishReport(\''+esc(version.version_ref)+'\')"'+(canPublish?'':' disabled')+'>Publish exact version</button></div><div id="osi-review-status-'+esc(version.version_ref)+'" class="osi-review-status" role="status" aria-live="polite"></div></form>'+reviewHistoryHtml(version,true)+'</section>';
  }
  async function submitReportReview(event,versionRef){
    if(event)event.preventDefault();if(state.busy)return;
    var decision=document.getElementById('osi-review-decision-'+versionRef);
    var reason=document.getElementById('osi-review-reason-'+versionRef);
    var rationale=document.getElementById('osi-review-rationale-'+versionRef);
    var note=document.getElementById('osi-review-note-'+versionRef);
    if(!decision||!reason||!rationale||!rationale.value.trim())return;
    var review={version_public_ref:versionRef,decision:decision.value,reason_code:reason.value.trim(),public_rationale:rationale.value.trim(),private_note:note.value.trim()||null};
    var key=JSON.stringify(review),pending=state.reviewPending[versionRef];
    if(pending&&pending.key!==key){delete state.reviewPending[versionRef];pending=null;}
    state.busy=true;
    try{
      var wallet=await ensureWallet();
      if(!pending){
        queueStatus(versionRef,'Preparing exact version, analyst snapshot, nonce and payload hash...');
        var prepared=await api(WRITE_URL,{op:'prepare_review',wallet:wallet,review:review,idempotency_key:'report-review:'+(crypto.randomUUID?crypto.randomUUID():Date.now()+Math.random().toString(36).slice(2))});
        if(prepared.already_committed){queueStatus(versionRef,'This exact review was already committed. Reloading...','success');setTimeout(function(){openReportWorkspace('queue');},350);return;}
        pending={key:key,prepared:prepared,signature:''};state.reviewPending[versionRef]=pending;
      }
      if(!pending.signature){queueStatus(versionRef,'Approve the exact review message in Phantom. This is not an on-chain transaction.');pending.signature=await signMessage(pending.prepared.message);}
      queueStatus(versionRef,'Verifying signer, eligibility, immutable target, weight snapshot and replay binding...');
      var committed=await api(WRITE_URL,{op:'commit_review',wallet:wallet,review:review,nonce:pending.prepared.nonce,message:pending.prepared.message,signature:pending.signature});
      delete state.reviewPending[versionRef];queueStatus(versionRef,'Review recorded at '+Number(committed.weight).toFixed(2)+' weight.','success');
      if(typeof showToast==='function')showToast(committed.decision+' review is wallet-signed and server-verified.');
      setTimeout(function(){openReportWorkspace('queue');},500);
    }catch(error){queueStatus(versionRef,userError(error),'error');if(['proof_binding_rejected','bad_signature','lineage_changed_retry'].indexOf(String(error.message))>=0)delete state.reviewPending[versionRef];}
    finally{state.busy=false;}
  }
  async function publishReport(versionRef){
    if(state.busy)return;state.busy=true;
    try{
      var wallet=await ensureWallet();var pending=state.publicationPending[versionRef];
      if(!pending){
        queueStatus(versionRef,'Freezing the exact active quorum snapshot and preparing REPORT_PUBLISHED...');
        var prepared=await api(WRITE_URL,{op:'prepare_publication',wallet:wallet,version_public_ref:versionRef,idempotency_key:'report-publish:'+(crypto.randomUUID?crypto.randomUUID():Date.now()+Math.random().toString(36).slice(2))});
        if(prepared.already_committed){queueStatus(versionRef,'This exact version is already published.','success');setTimeout(function(){openReportWorkspace('queue');},350);return;}
        pending={prepared:prepared,txSig:''};state.publicationPending[versionRef]=pending;
      }
      if(!pending.txSig){queueStatus(versionRef,'Approve the exact REPORT_PUBLISHED Memo in Phantom. OSI receives no funds.');pending.txSig=await castOnchainVote(pending.prepared.memo);}
      queueStatus(versionRef,'Confirming mainnet, signer, exact version, quorum hash, nonce and Memo...');
      var committed=await commitWithConfirmation({op:'commit_publication',wallet:wallet,version_public_ref:versionRef,nonce:pending.prepared.nonce,memo:pending.prepared.memo,tx_sig:pending.txSig});
      delete state.publicationPending[versionRef];queueStatus(versionRef,'Exact version published. The parent Case remains open and unchanged.','success');
      if(typeof showToast==='function')showToast(committed.version_public_ref+' is Memo-anchored and public.');
      setTimeout(function(){openReportWorkspace('queue');},650);
    }catch(error){queueStatus(versionRef,userError(error),'error');if(['proof_binding_rejected','lineage_changed_retry','transaction_failed','wrong_cluster','wrong_signer','wrong_memo'].indexOf(String(error.message))>=0)delete state.publicationPending[versionRef];}
    finally{state.busy=false;}
  }
  function reportCard(report,mode){
    var versions=(report.versions||[]).slice().sort(function(a,b){return Number(b.version_no)-Number(a.version_no);});
    var revision=mode==='mine'&&report.revision_eligible?'<button class="osi-report-action" type="button" onclick="osiV2OpenReportForm(\''+esc(report.case_public_ref)+'\')">Create revision</button>':'';
    return'<article class="osi-report-card"><div class="osi-report-card-head"><div><div class="osi-report-card-kicker"><span>'+esc(report.case_public_ref)+'</span><span>'+esc(report.report_public_ref)+'</span></div><h3>Exact version '+esc(report.current_version_no)+'</h3><div class="osi-report-card-meta">'+(mode==='queue'?'Author '+esc(short(report.author_wallet))+' · ':'')+'Submitted '+esc(dateText(versions[0]&&versions[0].submitted_at))+' · '+esc(report.current_version_ref)+'</div></div><span class="osi-report-state">'+esc(mode==='queue'?'Awaiting review':label(versions[0]&&versions[0].lifecycle_state))+'</span></div><div class="osi-report-card-head"><div class="osi-report-card-meta">'+(mode==='queue'?'Count and weight gates apply independently. Publication does not resolve the Case or certify truth or guilt.':(report.revision_eligible?'This active Case accepts a new immutable revision.':'Revision is unavailable because the Case or Report is not eligible.'))+'</div>'+revision+'</div><details'+(mode==='queue'?' open':'')+'><summary>Version history ('+versions.length+')</summary>'+versions.map(function(version){return'<section class="osi-report-version"><div class="osi-report-version-head"><div><div class="osi-report-version-ref">'+esc(version.version_ref)+' · version '+esc(version.version_no)+'</div><small>'+esc(label(version.lifecycle_state))+' · '+esc(dateText(version.submitted_at))+'</small></div><span class="mono">sha256 '+esc(short(version.evidence_snapshot_hash))+'</span></div><p>'+esc(version.body_private)+'</p>'+(version.content_public_safe?'<p><b>Public-safe summary:</b> '+esc(version.content_public_safe)+'</p>':'')+evidenceHtml(version.evidence)+proofHtml(version.proof)+(mode==='queue'?reviewControls(report,version):reviewHistoryHtml(version,false))+'</section>';}).join('')+'</details></article>';
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
    var enabled=mode==='queue'&&reports.some(function(report){return report.review_mutations_enabled===true;});
    var stats=document.getElementById('field-stats');if(stats)stats.innerHTML='<div class="osi-stat"><span>Visible</span><b>'+reports.length+'</b></div><div class="osi-stat"><span>Immutable versions</span><b>'+reports.reduce(function(sum,report){return sum+(report.versions||[]).length;},0)+'</b></div><div class="osi-stat"><span>Review controls</span><b>'+esc(mode==='queue'?(enabled?'Eligible':'Eligible analyst required'):'N/A')+'</b></div>';
    var deck=document.getElementById('fo-deck');if(deck)deck.hidden=true;
    var nav=document.getElementById('fo-pnav');if(nav)nav.innerHTML='';
  }
  async function openReportWorkspace(mode){
    state.queueMode=mode;
    if(typeof showView==='function')showView('field');
    var host=document.getElementById('field-cases');if(host)host.innerHTML='<div class="osi-v2-skeleton"></div><div class="osi-v2-skeleton"></div>';
    try{
      var result=mode==='mine'?await signedRead('my_reports','list_my_reports'):await signedRead('review_queue','list_review_queue');
      if(mode==='mine'){state.cacheWallet=String(walletPubkey||'');state.myReports=result.reports||[];}
      drawWorkspace(result.reports||[],mode,result.next_prerequisite||'');
    }catch(error){setWorkspaceCopy(mode,0);if(host)host.innerHTML='<div class="osi-v2-empty osi-v2-error"><b>Report workspace locked</b><span>'+esc(userError(error))+'</span><button class="osi-report-action" type="button" onclick="'+(mode==='mine'?'osiV2OpenMyReports()':'osiV2OpenReportQueue()')+'">Try again</button></div>';}
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
  window.osiV2ReportClearSession=clearSessionState;
  window.osiV2RefreshPublicReports=function(){if(state.sectionContext)refreshPublicReports(state.sectionContext);};
  window.osiV2OpenMyReports=function(){openReportWorkspace('mine');};
  window.osiV2OpenReportQueue=function(){openReportWorkspace('queue');};
})();
