/* Native V2 Case Report intake and private immutable history. */
(function(){
  'use strict';

  var WRITE_URL=SUPABASE_URL+'/functions/v1/osi-v2-report-write';
  var READ_URL=SUPABASE_URL+'/functions/v1/osi-v2-report-read';
  var state={
    caseRef:'',isRevision:false,idempotency:'',pending:null,returnFocus:null,
    cacheWallet:'',myReports:[],sectionContext:null,busy:false
  };

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

  function publishedRows(item){
    var rows=item.reports||[];
    if(!rows.length)return'<div class="osi-v2-empty"><b>No published Reports</b><span>Unpublished Report existence and activity are private.</span></div>';
    return'<div class="osi-list">'+rows.map(function(row){
      return'<div class="osi-list-item"><div class="osi-list-item-head"><b>'+esc(row.public_ref||'Published Report')+'</b><span class="osi-proof-label">Published</span></div><p>'+esc(row.content_public_safe||'No public-safe summary was recorded.')+'</p></div>';
    }).join('')+'</div>';
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
    setTimeout(function(){refreshSectionAction(item);},0);
    return'<section class="osi-case-section"><div class="osi-report-action-row"><div><h3>Reports</h3><div class="osi-report-action-copy" id="osi-report-action-copy">Checking exact submission prerequisites...</div></div><button class="osi-report-action" id="osi-report-submit-action" type="button" disabled onclick="osiV2OpenReportForm(\''+esc(item.public_ref)+'\')">Submit Report</button></div>'+publishedRows(item)+'</section>';
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
  function reportCard(report,mode){
    var versions=(report.versions||[]).slice().sort(function(a,b){return Number(b.version_no)-Number(a.version_no);});
    var revision=mode==='mine'&&report.revision_eligible?'<button class="osi-report-action" type="button" onclick="osiV2OpenReportForm(\''+esc(report.case_public_ref)+'\')">Create revision</button>':'';
    return'<article class="osi-report-card"><div class="osi-report-card-head"><div><div class="osi-report-card-kicker"><span>'+esc(report.case_public_ref)+'</span><span>'+esc(report.report_public_ref)+'</span></div><h3>Exact version '+esc(report.current_version_no)+'</h3><div class="osi-report-card-meta">'+(mode==='queue'?'Author '+esc(short(report.author_wallet))+' · ':'')+'Submitted '+esc(dateText(versions[0]&&versions[0].submitted_at))+' · '+esc(report.current_version_ref)+'</div></div><span class="osi-report-state">'+esc(mode==='queue'?'Awaiting review':label(versions[0]&&versions[0].lifecycle_state))+'</span></div><div class="osi-report-card-head"><div class="osi-report-card-meta">'+(mode==='queue'?'Review controls stay disabled until counted review and publication quorum ship.':(report.revision_eligible?'This active Case accepts a new immutable revision.':'Revision is unavailable because the Case or Report is not eligible.'))+'</div>'+revision+'</div><details><summary>Version history ('+versions.length+')</summary>'+versions.map(function(version){return'<section class="osi-report-version"><div class="osi-report-version-head"><div><div class="osi-report-version-ref">'+esc(version.version_ref)+' · version '+esc(version.version_no)+'</div><small>'+esc(label(version.lifecycle_state))+' · '+esc(dateText(version.submitted_at))+'</small></div><span class="mono">sha256 '+esc(short(version.evidence_snapshot_hash))+'</span></div><p>'+esc(version.body_private)+'</p>'+(version.content_public_safe?'<p><b>Public-safe summary:</b> '+esc(version.content_public_safe)+'</p>':'')+evidenceHtml(version.evidence)+proofHtml(version.proof)+'</section>';}).join('')+'</details></article>';
  }
  function setWorkspaceCopy(mode,count){
    var eyebrow=document.getElementById('fo-eyebrow'),title=document.getElementById('fo-title'),sub=document.getElementById('fo-sub'),counter=document.getElementById('fo-count');
    if(eyebrow)eyebrow.textContent=mode==='mine'?'Private author workspace':'Authorized Report review queue';
    if(title)title.textContent=mode==='mine'?'My Reports':'Awaiting Report Review';
    if(sub)sub.textContent=mode==='mine'?'Your exact immutable Report versions, evidence manifests, and Solana proof.':'Read-only submitted versions for an eligible analyst or full maintainer. Review mutations are not enabled.';
    if(counter)counter.textContent=count+' '+(count===1?'Report':'Reports');
  }
  function drawWorkspace(reports,mode,notice){
    var host=document.getElementById('field-cases');if(!host)return;
    setWorkspaceCopy(mode,reports.length);
    host.innerHTML=(notice?'<div class="osi-case-note">'+esc(notice)+'</div>':'')+(reports.length?'<div class="osi-report-workspace">'+reports.map(function(report){return reportCard(report,mode);}).join('')+'</div>':'<div class="osi-report-empty"><b>'+esc(mode==='mine'?'No Reports for this wallet':'No Reports currently await this wallet')+'</b><p>'+esc(mode==='mine'?'Open an eligible public Case and use Submit Report.':'Only server-authorized, non-self Report versions appear here.')+'</p></div>');
    var stats=document.getElementById('field-stats');if(stats)stats.innerHTML='<div class="osi-stat"><span>Visible</span><b>'+reports.length+'</b></div><div class="osi-stat"><span>Immutable versions</span><b>'+reports.reduce(function(sum,report){return sum+(report.versions||[]).length;},0)+'</b></div><div class="osi-stat"><span>Review controls</span><b>'+esc(mode==='queue'?'Off':'N/A')+'</b></div>';
    var deck=document.getElementById('fo-deck');if(deck)deck.hidden=true;
    var nav=document.getElementById('fo-pnav');if(nav)nav.innerHTML='';
  }
  async function openReportWorkspace(mode){
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
  window.osiV2OpenMyReports=function(){openReportWorkspace('mine');};
  window.osiV2OpenReportQueue=function(){openReportWorkspace('queue');};
})();
