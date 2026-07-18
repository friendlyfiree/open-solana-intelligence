/* Native V2 Wire intake, review, publication and public detail. */
(function(){
  'use strict';

  var WIRE_URL=SUPABASE_URL+'/functions/v1/osi-v2-wire';
  var state={
    reportRef:null,isRevision:false,idempotency:'',pending:null,returnFocus:null,
    cacheWallet:'',reports:[],busy:false,queue:[],current:null,tab:'overview',
    detailFocus:null,capabilities:null,governanceBusy:false,reviewBusy:false
  };

  function esc(value){
    return String(value==null?'':value).replace(/[&<>"']/g,function(char){
      return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char];
    });
  }
  function short(value){value=String(value||'');return value.length>18?value.slice(0,8)+'...'+value.slice(-6):value;}
  function label(value){return String(value||'').replace(/_/g,' ').replace(/\b\w/g,function(char){return char.toUpperCase();});}
  function dateText(value){var date=new Date(value||'');return isNaN(date.getTime())?'Not recorded':date.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});}
  function randomKey(){var id=crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(36).slice(2);return'wire:'+id.replace(/[^A-Za-z0-9.-]/g,'');}
  function headers(){var token=typeof SUPA_AUTH_TOKEN==='string'&&SUPA_AUTH_TOKEN?SUPA_AUTH_TOKEN:SUPABASE_ANON_KEY;return{'Content-Type':'application/json','apikey':SUPABASE_ANON_KEY,'Authorization':'Bearer '+token};}
  async function api(body){
    var response=await fetch(WIRE_URL,{method:'POST',headers:headers(),body:JSON.stringify(body)}),payload={};
    try{payload=await response.json();}catch(_){payload={ok:false,error:'invalid_server_response'};}
    if(!response.ok||payload.ok!==true){var failure=new Error(payload.error||('request_failed_'+response.status));failure.status=response.status;throw failure;}
    return payload;
  }
  function userError(error){
    var code=String(error&&error.message||'request_failed');
    var messages={
      wire_writes_disabled:'Wire submission is safely disabled while rollout checks are incomplete.',
      wire_writes_disabled_or_unavailable:'Wire submission is safely disabled or temporarily unavailable.',
      wire_report_not_available:'This Wire Report is not available to this wallet.',
      proof_binding_rejected:'The proof expired or no longer matches this exact Wire version. Prepare again.',
      lineage_changed_retry:'Another version advanced this Wire Report. Reload and prepare a fresh revision.',
      transaction_not_confirmed:'The Memo transaction is not confirmed yet. Retry safely with the same proof.',
      rpc_unavailable:'Solana confirmation is temporarily unavailable. Retry safely with the same transaction.',
      wrong_cluster:'The RPC did not identify Solana mainnet. No Wire version was created.',
      wrong_signer:'The confirmed transaction signer is not the Wire author wallet.',
      wrong_memo:'The confirmed transaction does not contain the exact prepared Memo.',
      transaction_failed:'The Solana transaction failed. No Wire version was created.',
      rate_limited:'Wire proof requests are rate limited. Wait, then try again.',
      prohibited_secret_material:'Remove any seed phrase, private key, access token, or other secret material.',
      prohibited_illegal_access_material:'Illegal-access material cannot be submitted.',
      prohibited_personal_data:'Remove doxxing, payment-card numbers, or government identity numbers.',
      read_session_disabled_or_unavailable:'Private read sessions are safely disabled or temporarily unavailable.',
      read_session_required:'Unlock private views with one wallet signature.',
      read_session_expired:'Your five-minute private read session expired. Refresh it explicitly to continue.',
      read_session_wrong_origin:'This private session belongs to a different site origin.',
      read_session_wrong_wallet:'This private session belongs to a different wallet.',
      read_session_wrong_scope:'Refresh private access explicitly for this role.',
      read_session_tampered:'The private session token failed server verification.'
      ,not_eligible_analyst:'Only an eligible analyst can take this action.'
      ,not_authorized_or_conflicted:'This wallet is not authorized or is conflicted from the exact action.'
      ,case_writes_disabled:'Case writes are safely disabled, so promotion is unavailable.'
      ,wire_and_payment_writes_required:'Wire support is safely disabled until both rollout gates are enabled.'
      ,active_challenge_exists:'This wallet already has an active challenge against the exact version.'
      ,challenge_maintenance_unavailable:'Challenge timeout maintenance is temporarily unavailable, so this action failed closed.'
      ,not_eligible_or_full_maintainer:'Only an eligible analyst or full double-gated maintainer can take this action.'
      ,not_eligible_for_wire_queue:'This wallet is not authorized for the restricted Wire queue.'
      ,bad_signature:'The wallet signature did not verify for this exact action.'
    };
    return messages[code]||code.replace(/_/g,' ');
  }
  async function ensureWallet(){
    if(!walletPubkey&&typeof toggleWallet==='function')await toggleWallet();
    if(!walletPubkey)throw new Error('Connect a Solana wallet to continue.');
    return walletPubkey;
  }
  async function sessionRead(){
    if(typeof window.osiV2ReadSession!=='function')throw new Error('read_session_disabled_or_unavailable');
    var session=await window.osiV2ReadSession(['wire:mine'],{allowUnlock:true});
    return await api({op:'list_my_wire_reports',wallet:session.wallet,read_session:session.token});
  }
  function status(text,kind){var node=document.getElementById('osi-wire-form-status');if(node){node.textContent=text||'';node.className='osi-form-status mono '+(kind||'');}}
  function lines(id,kind){var node=document.getElementById(id);if(!node)return[];return String(node.value||'').split(/[\n,]+/).map(function(value){return value.trim();}).filter(Boolean).map(function(ref){return{kind:kind,ref:ref};});}
  function payload(){
    return{
      title_public_safe:document.getElementById('osi-wire-title').value,
      content_public_safe:document.getElementById('osi-wire-summary').value,
      body_private:document.getElementById('osi-wire-analysis').value,
      uncertainties_private:document.getElementById('osi-wire-uncertainties').value,
      revision_reason_code:state.isRevision?document.getElementById('osi-wire-revision-reason').value:null,
      evidence:lines('osi-wire-wallets','wallet').concat(lines('osi-wire-transactions','onchain_tx'),lines('osi-wire-urls','url'))
    };
  }
  function setEvidence(items){
    var by={wallet:[],onchain_tx:[],url:[]};(items||[]).forEach(function(item){if(by[item.kind])by[item.kind].push(item.ref);});
    document.getElementById('osi-wire-wallets').value=by.wallet.join('\n');
    document.getElementById('osi-wire-transactions').value=by.onchain_tx.join('\n');
    document.getElementById('osi-wire-urls').value=by.url.join('\n');
  }
  async function loadMine(){var wallet=await ensureWallet(),result=await sessionRead();state.cacheWallet=wallet;state.reports=result.reports||[];return state.reports;}
  function syncBodyLock(){var modal=document.getElementById('osi-wire-modal');document.body.style.overflow=modal&&modal.classList.contains('open')?'hidden':'';}

  async function openWireForm(reportRef){
    state.returnFocus=document.activeElement;
    try{
      var wallet=await ensureWallet();
      var capability=await api({op:'capabilities',wallet:wallet});
      if(capability.wire_writes_enabled!==true)throw new Error('wire_writes_disabled');
      var form=document.getElementById('osi-wire-form');form.reset();
      state.reportRef=reportRef||null;state.isRevision=!!reportRef;state.pending=null;state.idempotency=randomKey();
      var revision=document.getElementById('osi-wire-revision-wrap'),reason=document.getElementById('osi-wire-revision-reason');
      revision.hidden=!state.isRevision;reason.required=state.isRevision;
      var context=document.getElementById('osi-wire-context');
      if(state.isRevision){
        var reports=state.cacheWallet===wallet?state.reports:await loadMine();
        var report=reports.find(function(row){return row.wire_report_public_ref===reportRef;});
        if(!report||report.revision_eligible!==true)throw new Error('wire_report_not_available');
        var current=(report.versions||[]).find(function(version){return version.version_ref===report.current_version_ref;})||(report.versions||[]).slice(-1)[0];
        document.getElementById('osi-wire-title').value=current.title_public_safe||'';
        document.getElementById('osi-wire-summary').value=current.content_public_safe||'';
        document.getElementById('osi-wire-analysis').value=current.body_private||'';
        document.getElementById('osi-wire-uncertainties').value=current.uncertainties_private||'';
        setEvidence(current.evidence||[]);
        context.textContent=reportRef+' | Revision | Next version '+(Number(report.current_version_no)+1);
      }else context.textContent='New standalone finding | Initial immutable version 1';
      var modal=document.getElementById('osi-wire-modal');modal.classList.add('open');syncBodyLock();status('');
      setTimeout(function(){document.getElementById('osi-wire-title').focus();},40);
    }catch(error){status('');if(typeof showToast==='function')showToast(userError(error));if(state.returnFocus&&document.contains(state.returnFocus))state.returnFocus.focus();state.returnFocus=null;}
  }
  function closeWireForm(){var modal=document.getElementById('osi-wire-modal');if(modal)modal.classList.remove('open');syncBodyLock();if(state.returnFocus&&document.contains(state.returnFocus))state.returnFocus.focus();state.returnFocus=null;}
  async function commitWithConfirmation(body){
    var lastError;
    for(var attempt=0;attempt<5;attempt++){
      try{return await api(body);}catch(error){lastError=error;if(['transaction_not_confirmed','rpc_unavailable'].indexOf(String(error.message))<0)throw error;status('Waiting for Solana RPC confirmation. Retry '+(attempt+1)+' of 5...');await new Promise(function(resolve){setTimeout(resolve,1600+attempt*900);});}
    }
    throw lastError;
  }
  async function submitWire(event){
    if(event)event.preventDefault();var form=document.getElementById('osi-wire-form');if(!form||!form.reportValidity()||state.busy)return;
    var wire=payload();if(wire.evidence.length<1){status('Add at least one wallet, transaction, or HTTPS evidence reference.','error');return;}if(wire.evidence.length>12){status('A Wire version can include at most 12 evidence references.','error');return;}
    state.busy=true;var button=document.getElementById('osi-wire-submit');button.disabled=true;button.setAttribute('aria-busy','true');
    try{
      var wallet=await ensureWallet(),key=JSON.stringify(wire);
      if(state.pending&&state.pending.payloadKey!==key){state.pending=null;state.idempotency=randomKey();}
      if(!state.pending){
        status('Preparing the exact private version, evidence manifest, nonce, and payload hash...');
        var prepared=await api({op:'prepare_wire',wallet:wallet,wire_report_public_ref:state.reportRef,wire:wire,idempotency_key:state.idempotency});
        if(prepared.already_committed){status('This exact version was already committed. Opening My Wire Reports.','success');setTimeout(function(){closeWireForm();openWorkspace();},450);return;}
        state.pending={wallet:wallet,payloadKey:key,prepared:prepared,txSig:''};
      }
      if(!state.pending.txSig){status('Approve the exact WIRE_REPORT_VERSION_SUBMITTED Memo in Phantom. OSI receives no funds.');state.pending.txSig=await castOnchainVote(state.pending.prepared.memo);}
      status('Confirming mainnet, signer, exact Memo, freshness, nonce, and payload hash...');
      var committed=await commitWithConfirmation({op:'commit_wire',wallet:wallet,wire:wire,nonce:state.pending.prepared.nonce,memo:state.pending.prepared.memo,tx_sig:state.pending.txSig});
      status('Version '+committed.version_no+' is submitted with a server-verified Solana Memo receipt.','success');
      if(typeof showToast==='function')showToast(committed.wire_report_public_ref+' version '+committed.version_no+' is Memo-anchored on Solana.');
      state.pending=null;state.idempotency='';form.reset();state.cacheWallet='';state.reports=[];
      setTimeout(function(){closeWireForm();openWorkspace();},650);
    }catch(error){status(userError(error),'error');if(['proof_binding_rejected','lineage_changed_retry','transaction_failed','wrong_cluster','wrong_signer','wrong_memo'].indexOf(String(error.message))>=0){state.pending=null;state.idempotency=randomKey();}}
    finally{state.busy=false;button.disabled=false;button.removeAttribute('aria-busy');}
  }
  function evidenceHtml(items){if(!items||!items.length)return'';return'<div class="osi-report-evidence-list">'+items.map(function(item){return'<div class="osi-report-evidence-item"><span>#'+esc(item.ordinal)+'</span><span>'+esc(label(item.kind))+'</span><span>'+esc(item.ref)+'</span></div>';}).join('')+'</div>';}
  function proofHtml(proof){
    if(!proof)return'<span>Proof unavailable</span>';
    var sig=String(proof.tx_sig||''),link=/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(sig)?'<a href="https://solscan.io/tx/'+esc(sig)+'" target="_blank" rel="noopener">Verify on Solscan</a>':'';
    return'<div class="osi-report-proof"><b>'+esc(proof.proof_type==='solana_memo'?'Memo-anchored on Solana':'Proof recorded')+'</b><span>'+esc(dateText(proof.occurred_at))+'</span>'+link+'</div>';
  }
  function reportCard(report){
    var versions=(report.versions||[]).slice().sort(function(a,b){return Number(b.version_no)-Number(a.version_no);});
    var revision=report.revision_eligible?'<button class="osi-report-action" type="button" onclick="osiV2OpenWireForm(\''+esc(report.wire_report_public_ref)+'\')">Create revision</button>':'';
    var published=report.current_published_version_ref?'<button class="osi-report-action" type="button" onclick="osiV2OpenWireReport(\''+esc(report.current_published_version_ref)+'\')">Open published version</button>':'';
    return'<article class="osi-report-card"><div class="osi-report-card-head"><div><div class="osi-report-card-kicker"><span>'+esc(report.wire_report_public_ref)+'</span></div><h3>'+esc(versions[0]&&versions[0].title_public_safe||'Wire Report')+'</h3><div class="osi-report-card-meta">Exact current version '+esc(report.current_version_no)+' | '+esc(report.current_version_ref)+'</div></div><span class="osi-report-state">'+esc(label(versions[0]&&versions[0].lifecycle_state))+'</span></div><div class="osi-report-card-head"><div class="osi-report-card-meta">Private author view. Published content is exposed only through the public allowlist for its exact version.</div><div>'+published+revision+'</div></div><details><summary>Version history ('+versions.length+')</summary>'+versions.map(function(version){return'<section class="osi-report-version"><div class="osi-report-version-head"><div><div class="osi-report-version-ref">'+esc(version.version_ref)+' | version '+esc(version.version_no)+'</div><small>'+esc(label(version.lifecycle_state))+' | '+esc(dateText(version.submitted_at))+'</small></div><span class="mono">sha256 '+esc(short(version.evidence_snapshot_hash))+'</span></div><p><b>'+esc(version.title_public_safe)+'</b></p><p>'+esc(version.content_public_safe)+'</p><p>'+esc(version.body_private)+'</p><p><b>Uncertainties and limits:</b> '+esc(version.uncertainties_private)+'</p>'+evidenceHtml(version.evidence)+proofHtml(version.proof)+'</section>';}).join('')+'</details></article>';
  }
  function workspaceMarkup(reports){return reports.length?'<div class="osi-case-note"><button class="osi-report-action" type="button" onclick="wireOpenPublic()">Back to public Wire</button><span>Private author workspace. Unpublished existence and content are not public.</span></div><div class="osi-report-workspace">'+reports.map(reportCard).join('')+'</div>':'<div class="osi-report-empty"><b>No Wire Reports for this wallet</b><p>Use Submit a Wire Report to create an exact private version.</p></div>';}
  function drawWorkspace(reports){
    var host=document.getElementById('wire-cases');if(!host)return;host.innerHTML=workspaceMarkup(reports);
    var stats=document.getElementById('wire-stats'),published=reports.filter(function(report){return!!report.current_published_version_ref;}).length;if(stats)stats.innerHTML='<div class="wire-op"><div class="wire-op-n cy">'+reports.length+'</div><div class="wire-op-l">My reports</div></div><div class="wire-op"><div class="wire-op-n">'+reports.reduce(function(sum,report){return sum+(report.versions||[]).length;},0)+'</div><div class="wire-op-l">Immutable versions</div></div><div class="wire-op"><div class="wire-op-n">'+published+'</div><div class="wire-op-l">Published</div></div>';
  }
  async function openWorkspace(){
    if(typeof showView==='function')showView('wire');if(typeof wireEnterPrivateMode==='function')wireEnterPrivateMode();var host=document.getElementById('wire-cases');if(host)host.innerHTML='<div class="osi-v2-skeleton"></div><div class="osi-v2-skeleton"></div>';
    try{var reports=await loadMine();drawWorkspace(reports);}catch(error){if(host){var refresh=/^read_session_(expired|wrong_scope)$/.test(String(error&&error.message||''));host.innerHTML='<div class="osi-v2-empty osi-v2-error"><b>Wire workspace locked</b><span>'+esc(userError(error))+'</span><button class="osi-report-action" type="button" onclick="'+(refresh?'osiV2RefreshWireWorkspace()':'osiV2OpenMyWireReports()')+'">'+(refresh?'Refresh private access':'Try again')+'</button></div>';}}
  }
  function safeHttpsUrl(value){
    try{var url=new URL(String(value||''));return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch(_){return'';}
  }
  function validTx(value){return/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(String(value||''));}
  function validWallet(value){return/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(value||''));}
  function validVersion(value){return/^OSI-WV-[0-9A-F]{16}$/.test(String(value||''));}
  function validChallenge(value){return/^OSI-CHL-[0-9A-F]{16}$/.test(String(value||''));}
  async function signMessage(message){
    var provider=typeof getConnectedProvider==='function'?getConnectedProvider():null;
    if(!provider)throw new Error('Connect Phantom to continue.');
    var bytes=new TextEncoder().encode(message),result=await provider.signMessage(bytes,'utf8');
    var signature=result&&result.signature;if(!signature)throw new Error('Signature was not returned.');
    var binary='';new Uint8Array(signature).forEach(function(byte){binary+=String.fromCharCode(byte);});return btoa(binary);
  }
  function publicEvidenceItem(item){
    var ref=String(item&&item.ref||''),href='';
    if(item.kind==='url')href=safeHttpsUrl(ref);
    else if(item.kind==='onchain_tx'&&validTx(ref))href='https://solscan.io/tx/'+ref;
    else if(item.kind==='wallet'&&validWallet(ref))href='https://solscan.io/account/'+ref;
    var value=href?'<a href="'+esc(href)+'" target="_blank" rel="noopener">'+esc(ref)+'</a>':'<span>'+esc(ref)+'</span>';
    return'<div class="osi-report-evidence-item"><span>#'+esc(item.ordinal)+'</span><span>'+esc(label(item.kind))+'</span>'+value+'<code class="mono">sha256 '+esc(short(item.sha256))+'</code></div>';
  }
  function attribution(actor,role){
    actor=actor||{};var handle=actor.handle?'@'+actor.handle:'';
    return'<div class="osi-report-proof"><b>'+esc(actor.display_name||handle||'Wallet contributor')+'</b><span class="mono">'+esc(actor.wallet||'Wallet unavailable')+'</span><span>'+esc(label(role||''))+(handle?' | '+esc(handle):'')+'</span></div>';
  }
  function verifiedPaymentProof(value){
    value=value&&typeof value==='object'?value:{};var manifest=Array.isArray(value.recipient_manifest)?value.recipient_manifest:[];
    return value.cluster==='mainnet-beta'&&value.finality==='finalized'&&validWallet(value.payer_wallet)
      &&manifest.length>=1&&manifest.length<=4&&manifest.every(function(row){return validWallet(row.wallet)&&/^[1-9][0-9]*$/.test(String(row.amount_lamports||''));})
      &&/^[1-9][0-9]*$/.test(String(value.total_lamports||''))&&value.memo_verified===true&&value.system_program_transfers_verified===true;
  }
  function totalLamports(rows){
    try{return(rows||[]).reduce(function(sum,row){var value=String(row&&row.amount_lamports||'0');return/^[0-9]+$/.test(value)?sum+BigInt(value):sum;},0n).toString();}
    catch(_){return'Unavailable';}
  }
  function publicProof(proof){
    proof=proof||{};var type=String(proof.proof_type||''),transfer=type==='solana_memo'&&proof.event_type==='SUPPORT_PAYMENT_CONFIRMED'&&verifiedPaymentProof(proof.payment_proof),text=transfer?'SOL transfer verified on Solana':type==='solana_memo'?'Memo-anchored on Solana':type==='wallet_signed_server_verified'?'Wallet-signed and server-verified':type==='system_event'?'System event':'Proof unavailable';
    var link=type==='solana_memo'&&validTx(proof.tx_sig)?'<a href="https://solscan.io/tx/'+esc(proof.tx_sig)+'" target="_blank" rel="noopener">Verify on Solscan</a>':'';
    var channel=proof.decision_channel==='maintainer_bootstrap'?'<span class="osi-chip">Maintainer bootstrap</span>':'';
    return'<div class="osi-report-proof"><b>'+esc(text)+'</b><span>'+esc(dateText(proof.occurred_at||proof.created_at))+'</span>'+channel+link+'</div>';
  }
  function tabs(){return[['overview','Overview'],['evidence','Evidence'],['reviews','Reviews'],['challenges','Challenges'],['support','Support'],['proof','Proof Log']];}
  function drawDetailTabs(){
    var host=document.getElementById('osi-wire-detail-tabs');if(!host)return;
    host.setAttribute('role','tablist');
    host.innerHTML=tabs().map(function(row){var active=state.tab===row[0];return'<button type="button" role="tab" aria-selected="'+active+'" tabindex="'+(active?'0':'-1')+'" class="osi-case-tab '+(active?'active':'')+'" data-wire-tab="'+row[0]+'">'+row[1]+'</button>';}).join('');
  }
  function overviewTab(item){
    return'<section class="osi-case-section"><div class="osi-section-heading"><div><span class="osi-eyebrow">Standalone finding</span><h3>'+esc(item.title)+'</h3></div><span class="osi-chip">Version '+esc(item.version_no)+'</span></div>'+attribution(item.author,'author')+'<p>'+esc(item.summary)+'</p><h4>Analysis</h4><p>'+esc(item.analysis)+'</p><h4>Uncertainties and limits</h4><p>'+esc(item.uncertainties)+'</p><div class="osi-case-note">Publication records a review process. It is not automatic truth, guilt, legal certainty, recovery, custody, or guaranteed payment.</div></section>';
  }
  function evidenceTab(item){return'<section class="osi-case-section"><div class="osi-section-heading"><div><span class="osi-eyebrow">Exact immutable version</span><h3>Evidence</h3></div><span class="osi-chip">'+esc((item.evidence||[]).length)+' references</span></div><div class="osi-report-evidence-list">'+((item.evidence||[]).map(publicEvidenceItem).join('')||'<p>No public evidence references were recorded.</p>')+'</div></section>';}
  function reviewsTab(item){
    var rows=(item.reviews||[]).map(function(review){return'<article class="osi-report-version">'+attribution(review.reviewer,review.actor_role)+'<p><b>'+esc(label(review.decision))+'</b> | Weight snapshot '+esc(review.weight)+' | '+esc(label(review.tier_snapshot))+'</p><p>'+esc(review.public_rationale)+'</p>'+publicProof({proof_type:review.proof_type,occurred_at:review.created_at})+'</article>';}).join('');
    return'<section class="osi-case-section"><div class="osi-section-heading"><div><span class="osi-eyebrow">D16 public attribution</span><h3>Reviews</h3></div></div>'+(rows||'<p>No public reviews were recorded.</p>')+'</section>';
  }
  function challengeButtons(challenge){
    var caps=state.capabilities||{},ref=String(challenge.challenge_public_ref||''),challengeState=String(challenge.state||''),wallet=String(walletPubkey||''),author=String(state.current&&state.current.author&&state.current.author.wallet||''),conflicted=!!wallet&&(wallet===String(challenge.challenger_wallet||'')||wallet===author);if(!validChallenge(ref))return'';
    if(caps.challenge_enabled!==true)return'';
    var pending=['submitted','admissibility_review'].indexOf(challengeState)>=0,merit=['open','under_review'].indexOf(challengeState)>=0,html='';
    if(wallet&&wallet===String(challenge.challenger_wallet||'')&&(pending||merit))html+='<button class="osi-action" type="button" data-wire-governance="withdraw" data-challenge-ref="'+ref+'">Withdraw my challenge</button>';
    if(pending&&!conflicted&&(caps.analyst_eligible||caps.maintainer_access))html+='<button class="osi-action" type="button" data-wire-governance="admit" data-decision="accept" data-challenge-ref="'+ref+'">Admit</button><button class="osi-action" type="button" data-wire-governance="admit" data-decision="reject" data-challenge-ref="'+ref+'">Reject as inadmissible</button>';
    if(merit&&!conflicted&&caps.analyst_eligible)html+='<button class="osi-action" type="button" data-wire-governance="review" data-decision="accept" data-challenge-ref="'+ref+'">Review accept</button><button class="osi-action" type="button" data-wire-governance="review" data-decision="reject" data-challenge-ref="'+ref+'">Review reject</button>';
    if(challengeState==='under_review'&&!conflicted&&caps.analyst_eligible)html+='<button class="osi-action primary" type="button" data-wire-governance="finalize" data-challenge-ref="'+ref+'">Finalize analyst quorum</button>';
    return html;
  }
  function challengesTab(item){
    var options=(item.evidence||[]).filter(function(row){return Number.isInteger(Number(row.ordinal))&&Number(row.ordinal)>=1&&Number(row.ordinal)<=12&&/^[0-9a-f]{64}$/.test(String(row.sha256||''));}).map(function(row){return'<option value="'+esc(String(Number(row.ordinal))+':'+String(row.sha256))+'">#'+esc(row.ordinal)+' '+esc(label(row.kind))+' | '+esc(short(row.ref))+'</option>';}).join('');
    var caps=state.capabilities||{},compose=item.is_current_published===true&&options&&caps.challenge_enabled===true?'<div class="osi-payment-compose"><h4>Challenge this exact published version</h4><label>Public-safe summary<textarea id="osi-wire-challenge-summary" minlength="20" maxlength="2000"></textarea></label><label>Linked evidence<select id="osi-wire-challenge-evidence">'+options+'</select></label><label>Restricted detail<textarea id="osi-wire-challenge-detail" maxlength="8000"></textarea></label><button class="osi-action primary" type="button" data-wire-governance="submit">Submit wallet-signed challenge</button></div>':'<div class="osi-case-note">New challenges require the current published version, public approved evidence, and the Wire write gate.</div>';
    var rows=(item.challenges||[]).map(function(challenge){return'<article class="osi-report-version"><div class="osi-report-version-head"><b>'+esc(challenge.challenge_public_ref)+'</b><span class="osi-chip">'+esc(label(challenge.state))+'</span></div><p>'+esc(challenge.public_safe_summary)+'</p><p class="mono">Challenger '+esc(challenge.challenger_wallet)+'</p>'+((challenge.reviews||[]).map(function(review){return attribution(review.reviewer,review.actor_role)+'<p><b>'+esc(label(review.decision))+'</b> | Weight '+esc(review.weight)+'</p><p>'+esc(review.public_rationale)+'</p>';}).join(''))+'<div class="osi-case-actions">'+challengeButtons(challenge)+'</div></article>';}).join('');
    return'<section class="osi-case-section"><div class="osi-section-heading"><div><span class="osi-eyebrow">Exact typed target</span><h3>Challenges</h3></div></div>'+compose+(rows||'<p>No challenges have been submitted.</p>')+'<div class="osi-case-note">Challenge accept or reject always requires the independent analyst count and weight gates. Maintainer bootstrap is unavailable.</div></section>';
  }
  function supportTab(item){
    var total=totalLamports(item.support),rows=(item.support||[]).map(function(row){return'<article class="osi-report-version"><p><b>'+esc(row.amount_lamports)+' lamports</b> from <span class="mono">'+esc(row.from_wallet)+'</span></p>'+publicProof({event_type:'SUPPORT_PAYMENT_CONFIRMED',proof_type:row.proof_type,payment_proof:row.payment_proof,tx_sig:row.tx_sig,occurred_at:row.confirmed_at})+'</article>';}).join('');
    return'<section class="osi-case-section"><div class="osi-section-heading"><div><span class="osi-eyebrow">Voluntary direct SOL</span><h3>Support</h3></div><span class="osi-chip">'+esc(total)+' lamports</span></div>'+(rows||'<p>No finalized support transfer is recorded.</p>')+'<div class="osi-case-note">Support is non-custodial and has zero influence on ranking, recommendation, review priority, reputation, voting power, or governance.</div></section>';
  }
  function proofTab(item){return'<section class="osi-case-section"><div class="osi-section-heading"><div><span class="osi-eyebrow">Honest transport labels</span><h3>Proof Log</h3></div></div>'+((item.proof_log||[]).map(function(row){return'<article class="osi-report-version"><div class="osi-report-version-head"><b>'+esc(label(row.event_type))+'</b><span class="mono">'+esc(row.receipt_id)+'</span></div><p>Actor <span class="mono">'+esc(row.actor_wallet||'System')+'</span> | '+esc(label(row.actor_role))+(row.weight!=null?' | Weight '+esc(row.weight):'')+'</p>'+publicProof(row)+'</article>';}).join('')||'<p>No public proof events were recorded.</p>')+'</section>';}
  function renderDetail(){
    var item=state.current,host=document.getElementById('osi-wire-detail-content');if(!item||!host)return;
    drawDetailTabs();var html=state.tab==='evidence'?evidenceTab(item):state.tab==='reviews'?reviewsTab(item):state.tab==='challenges'?challengesTab(item):state.tab==='support'?supportTab(item):state.tab==='proof'?proofTab(item):overviewTab(item);host.innerHTML=html;
    var footer=document.getElementById('osi-wire-detail-actions'),caps=state.capabilities||{};if(footer){var current=item.is_current_published===true,author=String(item.author&&item.author.wallet||''),connected=String(walletPubkey||''),own=validWallet(connected)&&connected===author,support=current&&caps.support_enabled===true&&!own,supportCopy=own?'You cannot support your own Wire Report.':'Support requires the current published version plus the Wire and payment write gates.',promote=current&&caps.promotion_enabled===true&&item.promoted!==true,promotionCopy=item.promoted===true?'<span class="osi-case-note">This exact version was already promoted. The new Case follows the normal private initial-review path.</span>':'';footer.innerHTML=(support?'<button class="osi-action" type="button" data-wire-support>Support current author</button>':'<span class="osi-case-note">'+supportCopy+'</span>')+(promote?'<button class="osi-action primary" type="button" data-wire-promote>Promote to private Case</button>':promotionCopy)+'<span id="osi-wire-payment-status" class="osi-form-status mono" role="status" aria-live="polite"></span>';}
  }
  async function openPublicWireReport(versionRef){
    if(!validVersion(versionRef))throw new Error('wire_report_not_available');var drawer=document.getElementById('osi-wire-drawer');if(drawer&&drawer.hidden)state.detailFocus=document.activeElement;
    var result=await api({op:'get_public_wire_report',version_public_ref:versionRef});state.current=result.report;state.tab='overview';
    try{state.capabilities=await api({op:'capabilities',wallet:String(walletPubkey||'')});}catch(_){state.capabilities={};}
    document.getElementById('osi-wire-detail-ref').textContent=state.current.version_public_ref;document.getElementById('osi-wire-detail-title').textContent=state.current.title;document.getElementById('osi-wire-detail-state').textContent=state.current.challenge_state==='challenge_upheld_under_re_review'?'Challenge upheld, under re-review':state.current.is_current_published!==true?(state.current.publication&&state.current.publication.decision_channel==='maintainer_bootstrap'?'Superseded maintainer bootstrap publication':'Superseded publication record'):state.current.publication&&state.current.publication.decision_channel==='maintainer_bootstrap'?'Maintainer bootstrap publication':'Reviewed publication';renderDetail();if(drawer){drawer.hidden=false;requestAnimationFrame(function(){drawer.classList.add('open');});setTimeout(function(){var close=drawer.querySelector('.osi-case-close');if(close)close.focus();},30);}document.body.classList.add('cr-drawer-lock');return result;
  }
  function closePublicWireReport(){var drawer=document.getElementById('osi-wire-drawer');if(drawer){drawer.classList.remove('open');drawer.hidden=true;}document.body.classList.remove('cr-drawer-lock');state.current=null;if(state.detailFocus&&document.contains(state.detailFocus))state.detailFocus.focus();state.detailFocus=null;}
  async function wireGovernance(action,targetRef,payload){
    if(state.governanceBusy)return;state.governanceBusy=true;
    try{var wallet=await ensureWallet(),promotion=action==='wire_promote',prepareOp=promotion?'prepare_wire_promotion':'prepare_wire_challenge',commitOp=promotion?'commit_wire_promotion':'commit_wire_challenge';var prepared=await api({op:prepareOp,action:action,wallet:wallet,target_ref:targetRef,payload:payload,idempotency_key:randomKey()});if(prepared.already_committed){showToast('This exact action was already committed.');return;}var body={op:commitOp,action:action,wallet:wallet,nonce:prepared.nonce,payload:payload,proof_text:prepared.proof_text};if(prepared.proof_type==='solana_memo'){body.tx_sig=await castOnchainVote(prepared.proof_text);await commitWithConfirmation(body);}else{body.signature=await signMessage(prepared.proof_text);await api(body);}showToast(label(prepared.purpose)+' recorded with '+(prepared.proof_type==='solana_memo'?'Memo proof.':'wallet-signed proof.'));if(state.current)await openPublicWireReport(state.current.version_public_ref);}
    catch(error){showToast(userError(error));}finally{state.governanceBusy=false;}
  }
  async function submitWireReview(versionRef){
    if(state.reviewBusy||!validVersion(versionRef))return;var root=document.querySelector('[data-wire-queue-card="'+versionRef+'"]');if(!root)return;var decision=root.querySelector('[data-wire-review-decision]').value,rationale=String(root.querySelector('[data-wire-review-rationale]').value||'').trim(),note=String(root.querySelector('[data-wire-review-note]').value||'').trim();if(rationale.length<10){showToast('Add a public-safe rationale of at least 10 characters.');return;}state.reviewBusy=true;try{var wallet=await ensureWallet(),review={version_public_ref:versionRef,decision:decision,reason_code:'wire_evidence_assessment',public_rationale:rationale,private_note:note||null},prepared=await api({op:'prepare_wire_review',wallet:wallet,review:review,idempotency_key:randomKey()});if(!prepared.already_committed){var signature=await signMessage(prepared.message);await api({op:'commit_wire_review',wallet:wallet,nonce:prepared.nonce,message:prepared.message,signature:signature,review:review});}showToast('Wire review recorded with wallet-signed server proof.');await openWireQueue();}catch(error){showToast(userError(error));}finally{state.reviewBusy=false;}
  }
  async function publishWire(versionRef){
    if(!validVersion(versionRef)||state.governanceBusy)return;state.governanceBusy=true;try{var wallet=await ensureWallet(),prepared=await api({op:'prepare_wire_publication',wallet:wallet,version_public_ref:versionRef,idempotency_key:randomKey()});if(!prepared.already_committed){var txSig=await castOnchainVote(prepared.memo);await commitWithConfirmation({op:'commit_wire_publication',wallet:wallet,version_public_ref:versionRef,nonce:prepared.nonce,memo:prepared.memo,tx_sig:txSig});}showToast('Wire Report published with a confirmed Memo receipt.');await openWireQueue();}catch(error){showToast(userError(error));}finally{state.governanceBusy=false;}
  }
  function queueCard(item){var ref=String(item.version_public_ref||'');if(!validVersion(ref))return'';var q=item.quorum||{},caps=state.capabilities||{},review=caps.review_enabled===true?'<label>Decision<select data-wire-review-decision><option value="approve">Approve</option><option value="reject">Reject</option><option value="request_revision">Request revision</option><option value="abstain">Abstain</option></select></label><label>Public-safe rationale<textarea data-wire-review-rationale minlength="10" maxlength="2000"></textarea></label><label>Restricted analyst note<textarea data-wire-review-note maxlength="4000"></textarea></label><button class="osi-action primary" type="button" data-wire-review="'+ref+'">Sign review</button>':caps.wire_writes_enabled!==true?'<div class="osi-case-note">Wire reviews require the dedicated Wire write gate.</div>':'<div class="osi-case-note">A full maintainer may inspect this queue, but only an independently eligible analyst may cast a weighted review.</div>',standardReady=caps.analyst_eligible===true&&q.approve_ready===true&&item.my_active_review&&item.my_active_review.decision==='approve',bootstrapCheck=caps.maintainer_access===true,publish=caps.publication_enabled===true&&(standardReady||bootstrapCheck)?'<button class="osi-action" type="button" data-wire-publish="'+ref+'">'+(standardReady?'Publish approved version':'Check bootstrap gates and publish')+'</button>':'<div class="osi-case-note">Publication is unavailable until both analyst quorum gates pass and this analyst approved the version, or the full maintainer satisfies the active D17 bootstrap tier.</div>';return'<article class="osi-report-card" data-wire-queue-card="'+ref+'"><div class="osi-report-card-head"><div><div class="osi-report-card-kicker"><span>'+esc(item.wire_report_public_ref)+'</span></div><h3>'+esc(item.title)+'</h3><div class="osi-report-card-meta">'+esc(ref)+' | Author '+esc(item.author_wallet)+'</div></div><span class="osi-report-state">'+esc(label(item.lifecycle_state))+'</span></div><p>'+esc(item.summary)+'</p><p>'+esc(item.analysis)+'</p><p><b>Uncertainties:</b> '+esc(item.uncertainties)+'</p>'+evidenceHtml(item.evidence)+'<div class="osi-payment-compose">'+review+publish+'</div><div class="osi-case-note">Approve quorum '+esc(q.approve_count||0)+' / '+esc(q.required_count||2)+' analysts and '+esc(q.approve_weight||0)+' / '+esc(q.required_weight||2)+' weight. The server chooses standard or maintainer-bootstrap publication.</div></article>';}
  async function openWireQueue(){
    if(typeof showView==='function')showView('wire');if(typeof wireEnterPrivateMode==='function')wireEnterPrivateMode();var wallet=await ensureWallet(),session=await window.osiV2ReadSession(['wire:queue'],{allowUnlock:true}),results=await Promise.all([api({op:'list_wire_review_queue',wallet:wallet,read_session:session.token}),api({op:'capabilities',wallet:wallet})]),result=results[0];state.capabilities=results[1];state.queue=result.reports||[];var host=document.getElementById('wire-cases');if(host)host.innerHTML='<div class="osi-case-note"><button class="osi-report-action" type="button" onclick="wireOpenPublic()">Back to public Wire</button><span>Restricted analyst queue. Author self-review is rejected by the database.</span></div><div class="osi-report-workspace">'+(state.queue.map(queueCard).join('')||'<div class="osi-report-empty"><b>No Wire versions await review</b></div>')+'</div>';return result;
  }
  async function refreshCapability(){
    var button=document.getElementById('osi-wire-intake-action');if(!button)return;
    try{var result=await api({op:'capabilities',wallet:String(walletPubkey||'')});state.capabilities=result;button.disabled=result.wire_writes_enabled!==true;button.textContent=result.wire_writes_enabled===true?'Submit a Wire Report':'Wire intake unavailable';button.title=result.prerequisite||'Create an exact private Wire Report version';var queue=document.getElementById('osi-wire-queue-action');if(queue)queue.hidden=!(result.analyst_eligible||result.maintainer_access);}
    catch(_){button.disabled=true;button.textContent='Wire intake unavailable';button.title='Wire capability is temporarily unavailable';var queue=document.getElementById('osi-wire-queue-action');if(queue)queue.hidden=true;}
  }
  function clearSessionState(){state.cacheWallet='';state.reports=[];state.queue=[];state.current=null;state.pending=null;state.idempotency='';state.capabilities=null;var form=document.getElementById('osi-wire-form');if(form)form.reset();var modal=document.getElementById('osi-wire-modal');if(modal)modal.classList.remove('open');var drawer=document.getElementById('osi-wire-drawer');if(drawer){drawer.classList.remove('open');drawer.hidden=true;}var queue=document.getElementById('osi-wire-queue-action');if(queue)queue.hidden=true;document.body.classList.remove('cr-drawer-lock');syncBodyLock();status('');if(typeof wireClearPrivateMode==='function')wireClearPrivateMode();}
  function trapFocus(event,root){if(event.key!=='Tab'||!root)return;var nodes=Array.prototype.filter.call(root.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'),function(node){return node.offsetParent!==null;});if(!nodes.length)return;var first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
  document.addEventListener('click',function(event){
    var target=event.target&&event.target.closest?event.target.closest('[data-wire-tab],[data-wire-review],[data-wire-publish],[data-wire-governance],[data-wire-support],[data-wire-promote]'):null;if(!target)return;
    if(target.dataset.wireTab){state.tab=target.dataset.wireTab;renderDetail();return;}
    if(target.dataset.wireReview){submitWireReview(target.dataset.wireReview);return;}
    if(target.dataset.wirePublish){publishWire(target.dataset.wirePublish);return;}
    if(target.hasAttribute('data-wire-support')){if(state.current&&typeof window.osiV2SupportWireAuthor==='function')window.osiV2SupportWireAuthor(state.current.version_public_ref,state.current.author&&state.current.author.wallet);return;}
    if(target.hasAttribute('data-wire-promote')){if(state.current)wireGovernance('wire_promote',state.current.version_public_ref,{});return;}
    var action=target.dataset.wireGovernance;if(!action||!state.current)return;
    if(action==='submit'){var summary=String((document.getElementById('osi-wire-challenge-summary')||{}).value||'').trim(),evidence=String((document.getElementById('osi-wire-challenge-evidence')||{}).value||''),detail=String((document.getElementById('osi-wire-challenge-detail')||{}).value||'').trim(),match=evidence.match(/^([1-9]|1[0-2]):([0-9a-f]{64})$/);if(summary.length<20){showToast('The public-safe challenge summary must be at least 20 characters.');return;}if(!match){showToast('Select one exact published evidence item.');return;}wireGovernance('challenge_submit',state.current.version_public_ref,{reason_code:'material_evidence_challenge',public_safe_summary:summary,restricted_detail:detail||null,evidence_ordinal:Number(match[1]),evidence_sha256:match[2]});return;}
    var ref=String(target.dataset.challengeRef||'');if(!validChallenge(ref))return;
    if(action==='admit'){wireGovernance('challenge_admit',ref,{decision:target.dataset.decision});}
    else if(action==='withdraw'){wireGovernance('challenge_withdraw',ref,{});}
    else if(action==='finalize'){wireGovernance('challenge_finalize',ref,{});}
    else if(action==='review'){var decision=target.dataset.decision,rationale=window.prompt('Public-safe challenge review rationale.','The linked evidence was reviewed against the exact published Wire version.');if(rationale===null)return;rationale=String(rationale).trim();if(rationale.length<10){showToast('The rationale must be at least 10 characters.');return;}wireGovernance('challenge_review',ref,{decision:decision,reason_code:decision==='accept'?'material_issue_confirmed':'published_version_preserved',public_rationale:rationale,private_note:null});}
  });
  document.addEventListener('keydown',function(event){var modal=document.getElementById('osi-wire-modal'),drawer=document.getElementById('osi-wire-drawer');if(modal&&modal.classList.contains('open')){if(event.key==='Escape'){event.preventDefault();closeWireForm();return;}trapFocus(event,modal);return;}if(!drawer||drawer.hidden)return;if(event.key==='Escape'){event.preventDefault();closePublicWireReport();return;}var tab=event.target&&event.target.closest?event.target.closest('[data-wire-tab]'):null;if(tab&&(event.key==='ArrowRight'||event.key==='ArrowLeft')){event.preventDefault();var nodes=Array.prototype.slice.call(document.querySelectorAll('#osi-wire-detail-tabs [data-wire-tab]')),index=nodes.indexOf(tab),next=(index+(event.key==='ArrowRight'?1:-1)+nodes.length)%nodes.length,key=nodes[next].dataset.wireTab;state.tab=key;renderDetail();var fresh=document.querySelector('#osi-wire-detail-tabs [data-wire-tab="'+key+'"]');if(fresh)fresh.focus();return;}trapFocus(event,drawer);});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',refreshCapability);else setTimeout(refreshCapability,0);

  window.OSIWireUI={escapeHtml:esc,reportCard:reportCard,workspaceMarkup:workspaceMarkup,safeHttpsUrl:safeHttpsUrl,validTransactionSignature:validTx,publicEvidenceItem:publicEvidenceItem,verifiedPaymentProof:verifiedPaymentProof,proofHtml:publicProof};
  window.osiV2OpenWireForm=openWireForm;
  window.osiV2CloseWireForm=closeWireForm;
  window.osiV2SubmitWire=submitWire;
  window.osiV2OpenMyWireReports=openWorkspace;
  window.osiV2OpenWireQueue=function(){return openWireQueue().catch(function(error){showToast(userError(error));});};
  window.osiV2ListPublicWireReports=function(){return api({op:'list_public_wire_reports',limit:40});};
  window.osiV2OpenWireReport=function(ref){return openPublicWireReport(ref).catch(function(error){showToast(userError(error));throw error;});};
  window.osiV2CloseWireReport=closePublicWireReport;
  window.osiV2RefreshWireCapability=refreshCapability;
  window.osiV2RefreshWireWorkspace=function(){return window.osiV2RefreshReadSession(['wire:mine']).then(openWorkspace);};
  if(typeof window.osiV2RegisterPrivateCache==='function')window.osiV2RegisterPrivateCache('wire',clearSessionState);
})();
