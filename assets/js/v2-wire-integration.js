/* Native V2 Wire Phase 1 intake and private immutable author history. */
(function(){
  'use strict';

  var WIRE_URL=SUPABASE_URL+'/functions/v1/osi-v2-wire';
  var state={
    reportRef:null,isRevision:false,idempotency:'',pending:null,returnFocus:null,
    cacheWallet:'',reports:[],busy:false
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
    return'<article class="osi-report-card"><div class="osi-report-card-head"><div><div class="osi-report-card-kicker"><span>'+esc(report.wire_report_public_ref)+'</span></div><h3>'+esc(versions[0]&&versions[0].title_public_safe||'Wire Report')+'</h3><div class="osi-report-card-meta">Exact current version '+esc(report.current_version_no)+' | '+esc(report.current_version_ref)+'</div></div><span class="osi-report-state">'+esc(label(versions[0]&&versions[0].lifecycle_state))+'</span></div><div class="osi-report-card-head"><div class="osi-report-card-meta">Private author view. Publication, review, challenge, support, and promotion are not enabled in Phase 1.</div>'+revision+'</div><details><summary>Version history ('+versions.length+')</summary>'+versions.map(function(version){return'<section class="osi-report-version"><div class="osi-report-version-head"><div><div class="osi-report-version-ref">'+esc(version.version_ref)+' | version '+esc(version.version_no)+'</div><small>'+esc(label(version.lifecycle_state))+' | '+esc(dateText(version.submitted_at))+'</small></div><span class="mono">sha256 '+esc(short(version.evidence_snapshot_hash))+'</span></div><p><b>'+esc(version.title_public_safe)+'</b></p><p>'+esc(version.content_public_safe)+'</p><p>'+esc(version.body_private)+'</p><p><b>Uncertainties and limits:</b> '+esc(version.uncertainties_private)+'</p>'+evidenceHtml(version.evidence)+proofHtml(version.proof)+'</section>';}).join('')+'</details></article>';
  }
  function workspaceMarkup(reports){return reports.length?'<div class="osi-case-note"><button class="osi-report-action" type="button" onclick="wireOpenPublic()">Back to public Wire</button><span>Private author workspace. Unpublished existence and content are not public.</span></div><div class="osi-report-workspace">'+reports.map(reportCard).join('')+'</div>':'<div class="osi-report-empty"><b>No Wire Reports for this wallet</b><p>Use Submit a Wire Report to create an exact private version.</p></div>';}
  function drawWorkspace(reports){
    var host=document.getElementById('wire-cases');if(!host)return;host.innerHTML=workspaceMarkup(reports);
    var stats=document.getElementById('wire-stats');if(stats)stats.innerHTML='<div class="wire-op"><div class="wire-op-n cy">'+reports.length+'</div><div class="wire-op-l">Private reports</div></div><div class="wire-op"><div class="wire-op-n">'+reports.reduce(function(sum,report){return sum+(report.versions||[]).length;},0)+'</div><div class="wire-op-l">Immutable versions</div></div><div class="wire-op"><div class="wire-op-n">0</div><div class="wire-op-l">Public in Phase 1</div></div>';
  }
  async function openWorkspace(){
    if(typeof showView==='function')showView('wire');if(typeof wireEnterPrivateMode==='function')wireEnterPrivateMode();var host=document.getElementById('wire-cases');if(host)host.innerHTML='<div class="osi-v2-skeleton"></div><div class="osi-v2-skeleton"></div>';
    try{var reports=await loadMine();drawWorkspace(reports);}catch(error){if(host){var refresh=/^read_session_(expired|wrong_scope)$/.test(String(error&&error.message||''));host.innerHTML='<div class="osi-v2-empty osi-v2-error"><b>Wire workspace locked</b><span>'+esc(userError(error))+'</span><button class="osi-report-action" type="button" onclick="'+(refresh?'osiV2RefreshWireWorkspace()':'osiV2OpenMyWireReports()')+'">'+(refresh?'Refresh private access':'Try again')+'</button></div>';}}
  }
  async function refreshCapability(){
    var button=document.getElementById('osi-wire-intake-action');if(!button)return;
    try{var result=await api({op:'capabilities',wallet:String(walletPubkey||'')});button.disabled=result.wire_writes_enabled!==true;button.textContent=result.wire_writes_enabled===true?'Submit a Wire Report':'Wire intake unavailable';button.title=result.prerequisite||'Create an exact private Wire Report version';}
    catch(_){button.disabled=true;button.textContent='Wire intake unavailable';button.title='Wire capability is temporarily unavailable';}
  }
  function clearSessionState(){state.cacheWallet='';state.reports=[];state.pending=null;state.idempotency='';var form=document.getElementById('osi-wire-form');if(form)form.reset();var modal=document.getElementById('osi-wire-modal');if(modal)modal.classList.remove('open');syncBodyLock();status('');if(typeof wireClearPrivateMode==='function')wireClearPrivateMode();}
  function trapFocus(event,root){if(event.key!=='Tab'||!root)return;var nodes=Array.prototype.filter.call(root.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'),function(node){return node.offsetParent!==null;});if(!nodes.length)return;var first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
  document.addEventListener('keydown',function(event){var modal=document.getElementById('osi-wire-modal');if(!modal||!modal.classList.contains('open'))return;if(event.key==='Escape'){event.preventDefault();closeWireForm();return;}trapFocus(event,modal);});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',refreshCapability);else setTimeout(refreshCapability,0);

  window.OSIWireUI={escapeHtml:esc,reportCard:reportCard,workspaceMarkup:workspaceMarkup};
  window.osiV2OpenWireForm=openWireForm;
  window.osiV2CloseWireForm=closeWireForm;
  window.osiV2SubmitWire=submitWire;
  window.osiV2OpenMyWireReports=openWorkspace;
  window.osiV2RefreshWireCapability=refreshCapability;
  window.osiV2RefreshWireWorkspace=function(){return window.osiV2RefreshReadSession(['wire:mine']).then(openWorkspace);};
  if(typeof window.osiV2RegisterPrivateCache==='function')window.osiV2RegisterPrivateCache('wire',clearSessionState);
})();
