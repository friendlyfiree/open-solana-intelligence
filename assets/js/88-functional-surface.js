/* Live product-action routing and native Operations rendering for index.html. */
(function(root,factory){
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.OSIFunctionalSurfaceCore=api;
})(typeof window!=='undefined'?window:null,function(){
  'use strict';
  var catalog=Object.freeze({
    case:Object.freeze({endpoint:'osi-v2-case-write:actor_capabilities',state:'case_writes_enabled',approval:'one_memo_transaction'}),
    report:Object.freeze({endpoint:'osi-v2-report-read:list_my_reports',state:'shared_private_read_session',approval:'one_memo_transaction_per_version'}),
    wire:Object.freeze({endpoint:'osi-v2-wire:list_my_wire_reports',state:'shared_private_read_session',approval:'one_memo_transaction_per_version'}),
    analyst:Object.freeze({endpoint:'osi-v2-analyst:my_workspace',state:'application_version_state',approval:'one_message_per_version'}),
    review:Object.freeze({endpoint:'osi-v2-case-read:list_reviewable_cases',state:'server_derived_eligibility',approval:'one_message_or_memo_per_write'}),
    governance:Object.freeze({endpoint:'osi-v2-governance-write:prepare',state:'exact_case_and_target_state',approval:'one_message_or_memo_per_write'}),
    money:Object.freeze({endpoint:'osi-v2-payment:capabilities',state:'server_derived_recipient_manifest',approval:'one_transaction_per_transfer'}),
    proof:Object.freeze({endpoint:'onchain_events:public_projection',state:'public_recorded_events_only',approval:'none'}),
    operations:Object.freeze({endpoint:'osi-v2-case-read:maintainer_case_overview',state:'wallet_and_auth_double_gate',approval:'shared_private_read_session'})
  });
  function need(env,name){if(!env||typeof env[name]!=='function')throw new Error('action_unavailable:'+name);return env[name];}
  function run(id,env){
    if(!catalog[id])throw new Error('unknown_live_action');
    if(id==='case')return need(env,'openCase')();
    if(id==='report')return need(env,'openMyReports')();
    if(id==='wire')return need(env,'openMyWireReports')();
    if(id==='analyst')return need(env,'openAnalystApplications')();
    if(id==='review')return need(env,'openReviewQueue')();
    if(id==='governance')return need(env,'openFieldStage')('resolution_selection');
    if(id==='money')return need(env,'openFieldStage')('sealed');
    if(id==='proof')return need(env,'navigate')('prooflog');
    return need(env,'openOperations')();
  }

  // SAS reconcile results are read as plain sentences. The server derives the
  // intended credential state from analyst_profiles and decides whether to
  // write; this only names what it reports. A submitted transaction is never
  // described as confirmed, verified or anchored.
  var BASE58=/^[1-9A-HJ-NP-Za-km-z]+$/;
  function isWalletAddress(value){return typeof value==='string'&&value.length>=32&&value.length<=44&&BASE58.test(value);}
  function isTransactionSignature(value){return typeof value==='string'&&value.length>=64&&value.length<=88&&BASE58.test(value);}
  // The exact next_step sentences osi-v2-analyst reconcile_sas can return.
  var SAS_NEXT_STEPS=Object.freeze([
    'Wait for confirmed on-chain state, then run this same idempotent reconciliation again.',
    'Inspect the exact attestation account and use a focused issuer-authority repair; do not overwrite it blindly.',
    'Restore the trusted RPC or issuer secret and retry the same server-derived transition.',
    'No additional on-chain write is required.'
  ]);
  var SAS_REPAIR_REASONS=Object.freeze({
    credential_mismatch:'The live account names a different credential.',
    schema_mismatch:'The live account uses a different schema.',
    issuer_mismatch:'The live account was signed by a different issuer.',
    wrong_program:'The live account belongs to a different program.',
    decode_error:'The live account could not be decoded.',
    expired:'The live credential has expired.',
    not_configured:'SAS is not fully configured on the server.',
    unexpected_attestation_state:'The live account is in an unexpected state.'
  });
  var NO_TRANSACTION='No Solana transaction was sent.';
  var RECHECK_FIRST='Run this check again to read the live state before any repair.';
  function codeText(value){return String(value==null?'':value).replace(/[^A-Za-z0-9_ .:-]/g,'').slice(0,64);}
  function sasReconcileOutcome(result){
    result=result&&typeof result==='object'?result:{};
    var action=String(result.action||''),reason=String(result.reason||'');
    var tx=result.tx_sig==null?'':String(result.tx_sig);
    var submitted=tx.length>0||result.submitted_on_chain===true;
    var serverStep=typeof result.next_step==='string'?result.next_step.trim().slice(0,400):'';
    var out={
      action:action,tone:'neutral',message:'',variables:null,reason:'',
      submitted:submitted,txSig:isTransactionSignature(tx)?tx:'',txSigMalformed:submitted&&!isTransactionSignature(tx),
      nextStep:serverStep,nextStepFromServer:!!serverStep,
      attestation:isWalletAddress(result.attestation)?result.attestation:''
    };
    if(action==='satisfied'){
      out.message=reason==='already_verified'?'The live SAS credential already matches this analyst status. '+NO_TRANSACTION
        :reason==='already_absent'?'No live SAS credential exists, and none is expected for this analyst status. '+NO_TRANSACTION
        :'The live SAS state already matches the server-derived analyst status. '+NO_TRANSACTION;
    }else if((action==='issue'||action==='revoke')&&submitted){
      out.tone='pending';
      out.message=action==='issue'?'The server submitted a transaction to issue this wallet\'s SAS credential.'
        :'The server submitted a transaction to close this wallet\'s SAS credential.';
    }else if(action==='issue'||action==='revoke'){
      // The server tried to write and the submission failed. Its generic
      // "no additional write" sentence does not describe this outcome.
      out.tone='warning';
      out.message=action==='issue'?'The server tried to issue this wallet\'s SAS credential, but the transaction could not be submitted. The ledger records the failure.'
        :'The server tried to close this wallet\'s SAS credential, but the transaction could not be submitted. The ledger records the failure.';
      out.nextStep=RECHECK_FIRST;out.nextStepFromServer=false;
    }else if(action==='repair_required'){
      out.tone='warning';
      out.message='The live SAS account does not match what OSI expects, so the server left it unchanged. '+NO_TRANSACTION;
      out.reason=SAS_REPAIR_REASONS[reason]||'';
    }else if(action==='defer'){
      out.tone='warning';
      out.message=reason==='rpc_unavailable'?'The live SAS state could not be read because the trusted Solana RPC is unavailable. '+NO_TRANSACTION
        :reason==='issuer_secret_absent'?'A change is needed, but the issuer key is not available on the server. '+NO_TRANSACTION
        :'The server postponed this change. '+NO_TRANSACTION;
    }else if(action==='noop_unconfigured'){
      out.message=reason==='issuance_disabled'?'SAS credential issuance is off, so the server made no live check. '+NO_TRANSACTION
        :'SAS is not fully configured on the server, so it made no live check. '+NO_TRANSACTION;
    }else if(action==='noop'){
      out.message='No change is needed for this wallet. '+NO_TRANSACTION;
    }else if(action==='error'){
      out.tone='error';
      out.message='The check stopped on the server with an error. The ledger records it.';
      out.nextStep=RECHECK_FIRST;out.nextStepFromServer=false;
    }else{
      out.tone='warning';
      out.message='The server returned a result this page does not recognize ({action}). Treat the live state as unknown.';
      out.variables={action:codeText(action)||'empty'};
    }
    return out;
  }
  function sasReconcileError(code){
    var value=String(code==null?'':code).trim();
    var lower=value.toLowerCase();
    if(value==='half_maintainer_wallet_only')return{message:'The server accepted the admin wallet but not the Supabase maintainer sign-in. Either credential alone is denied. Sign in again, then retry.',refresh:false};
    if(value==='half_maintainer_auth_only')return{message:'The server accepted the Supabase maintainer sign-in but not this wallet. Either credential alone is denied. Connect the configured admin wallet, then retry.',refresh:false};
    if(value==='maintainer_denied')return{message:'The server denied maintainer access. Nothing was checked.',refresh:false};
    if(value==='maintainer_access_required'||value==='full_maintainer_required')return{message:'Both maintainer gates are required. Nothing was sent.',refresh:false};
    if(value==='analyst_profile_not_found')return{message:'This wallet has no analyst profile, so the server has no status to compare. Nothing was checked.',refresh:false};
    if(value==='bad_wallet')return{message:'The server rejected a wallet address in this request. Nothing was checked.',refresh:false};
    if(value==='wallet_mismatch')return{message:'The server answered for a different wallet, so that answer is not shown. Check again.',refresh:true};
    if(value==='not_configured')return{message:'The analyst service is not configured on the server. Nothing was checked.',refresh:false};
    if(value==='bad_op'||value==='bad_json'||value==='body_too_large'||value==='method_not_allowed')return{message:'The server rejected this request. Nothing was checked.',refresh:false};
    if(!value||/fetch|network|load failed|timeout|timed out|abort|unavailable|^http_(?:0|5\d\d)$/.test(lower)){
      return{message:'The analyst service did not answer. If the request arrived, the server may still have acted. Check again to read the live state.',refresh:true};
    }
    return{message:'The check failed closed: {reason}.',variables:{reason:codeText(value).replace(/_/g,' ')||'unknown'},refresh:true};
  }
  var sas=Object.freeze({
    isWalletAddress:isWalletAddress,
    isTransactionSignature:isTransactionSignature,
    nextSteps:SAS_NEXT_STEPS,
    repairReasons:SAS_REPAIR_REASONS,
    outcome:sasReconcileOutcome,
    error:sasReconcileError
  });
  return{catalog:catalog,run:run,sas:sas};
});

(function(){
  'use strict';
  if(typeof window==='undefined'||!window.OSIFunctionalSurfaceCore)return;

  function actionEnvironment(){
    return{
      openCase:window.osiOpenCase,
      openMyReports:window.osiV2OpenMyReports,
      openMyWireReports:window.osiV2OpenMyWireReports,
      openAnalystApplications:function(){return window.osiAnalystOpenWorkspace('applications');},
      openReviewQueue:window.osiV2OpenReviewQueue,
      openFieldStage:window.osiNavigateFieldStage,
      navigate:window.osiNavigate,
      openOperations:window.admOpen
    };
  }
  window.OSI_LIVE_ACTIONS=window.OSIFunctionalSurfaceCore.catalog;
  window.osiRunLiveAction=function(id){
    try{return window.OSIFunctionalSurfaceCore.run(String(id||''),actionEnvironment());}
    catch(error){
      var message=String(error&&error.message||'action_unavailable').replace(/^action_unavailable:/,'');
      if(typeof window.showToast==='function')window.showToast('This action is unavailable: '+message.replace(/_/g,' ')+'.');
      return null;
    }
  };

  function make(tag,className,text){
    var node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=String(text);return node;
  }
  function opsText(value,variables){return typeof window.osiT==='function'?window.osiT(String(value),variables):String(value).replace(/\{([a-zA-Z0-9_]+)\}/g,function(_,name){return variables&&Object.prototype.hasOwnProperty.call(variables,name)?String(variables[name]):'{'+name+'}';});}
  function opsDate(value){
    var date=new Date(value||'');if(isNaN(date.getTime()))return opsText('Not recorded');
    var selected=window.OSI_I18N&&typeof window.OSI_I18N.getLocale==='function'?window.OSI_I18N.getLocale():'en';
    return date.toLocaleString(String(selected||'en').toLowerCase()==='tr'?'tr-TR':'en-US',{dateStyle:'medium',timeStyle:'short',hourCycle:'h23',timeZone:'UTC'})+' UTC';
  }
  // Lifecycle and verification codes are read as words. An unknown code is
  // still shown, humanised, so nothing the server says is hidden.
  function humanCode(value){
    var text=String(value||'').replace(/_/g,' ').trim();
    return text?opsText(text.charAt(0).toUpperCase()+text.slice(1)):opsText('Not recorded');
  }
  function shortWallet(value){
    value=String(value||'');
    return value.length>10?value.slice(0,4)+'...'+value.slice(-4):value;
  }
  function appendMetric(host,label,value){
    var item=make('div','osi-native-metric');item.appendChild(make('span','',label));item.appendChild(make('strong','',value));host.appendChild(item);
  }
  // Every flag the overview returns gets a plain name. The raw environment
  // name stays beside it in small mono so a maintainer can hold the panel
  // against the public flag table. An absent value fails closed and says so.
  var FLAG_LABELS={
    OSI_V2_WRITES_ENABLED:'Native V2 signed writes',
    OSI_V2_PROOF_ENABLED:'Proof receipts',
    OSI_V2_CASE_WRITES_ENABLED:'Case writes',
    OSI_V2_RESOLUTION_LIFECYCLE_WRITES_ENABLED:'Resolution lifecycle writes',
    OSI_V2_REPORT_WRITES_ENABLED:'Report writes',
    OSI_V2_REPORT_REVIEW_WRITES_ENABLED:'Report review writes',
    OSI_V2_BOOTSTRAP_MAINTAINER_QUORUM_ENABLED:'Maintainer bootstrap quorum',
    OSI_V2_FALLBACK_GOVERNANCE:'Fallback governance',
    OSI_V2_AI_PACK_WRITES_ENABLED:'AI Pack generation',
    OSI_V2_AI_PACK_REVIEW_WRITES_ENABLED:'AI Pack review and publication',
    OSI_V2_SAS_CREDENTIAL_ISSUANCE_ENABLED:'SAS credential issuance',
    OSI_V2_SAS_CREDENTIAL_ENFORCEMENT_ENABLED:'SAS credential enforcement',
    OSI_V2_PROFILE_WRITES_ENABLED:'Wallet profile writes'
  };
  function flagLabel(key){
    if(FLAG_LABELS[key])return opsText(FLAG_LABELS[key]);
    return humanCode(String(key||'').replace(/^OSI_V2_/,'').replace(/_ENABLED$/,'').toLowerCase());
  }
  function flagState(value){
    var text=String(value==null?'':value).trim().toLowerCase();
    if(text==='true')return{cls:'enabled',label:opsText('On')};
    if(text==='false')return{cls:'closed',label:opsText('Off')};
    return{cls:'closed',label:opsText('Not set, treated as off')};
  }
  function renderFlags(host,flags){
    var keys=Object.keys(flags||{}).sort();if(!keys.length)return;
    var section=make('section','osi-native-block');
    section.appendChild(make('h4','',opsText('Feature flags')));
    var list=make('dl','osi-native-flags');
    keys.forEach(function(key){
      var state=flagState(flags[key]);
      var row=make('div','osi-native-flag');
      var term=make('dt','');term.appendChild(make('span','osi-native-flag-name',flagLabel(key)));term.appendChild(make('code','osi-native-flag-key',key));
      var value=make('dd','osi-native-flag-state '+state.cls,state.label);
      row.appendChild(term);row.appendChild(value);list.appendChild(row);
    });
    section.appendChild(list);host.appendChild(section);
  }
  function clearNativeOperations(message){
    var host=document.getElementById('osi-native-ops-overview');if(!host)return;
    lastRender=null;
    host.replaceChildren(make('div','moc-loading',opsText(message||'Maintainer access locked.')));
  }
  function renderAiPackOperations(host,status){
    var section=make('section','osi-native-block osi-native-ai-packs');
    section.appendChild(make('h4','',opsText('Private AI Pack Operations')));
    if(!status||status.ok!==true){
      section.appendChild(make('div','moc-loading',opsText('The protected AI Pack status endpoint is unavailable. Generation and reads remain fail-closed.')));
      host.appendChild(section);return;
    }
    var summary=make('div','osi-native-metrics');
    appendMetric(summary,opsText('AI Pack drafts'),Number(status.private_draft_count||0));
    appendMetric(summary,opsText('Generation in progress'),Number(status.in_progress_generation_count||0));
    appendMetric(summary,opsText('Provider'),opsText(status.provider_configured===true?'Configured':'Missing, provider calls blocked'));
    section.appendChild(summary);
    var cases=Array.isArray(status.eligible_cases)?status.eligible_cases:[];
    if(!cases.length){
      section.appendChild(make('div','moc-loading',opsText('No public Case is currently eligible for a private maintainer draft.')));
    }else{
      var list=make('div','moc-feed');
      cases.forEach(function(item){
        var row=make('div','moc-feed-row');row.appendChild(make('i','moc-dot'));
        var detail=make('div','');
        var heading=make('b','');heading.appendChild(make('code','osi-native-ref',String(item.public_ref||opsText('Case unavailable'))));
        var title=make('span','osi-native-title',String(item.title||opsText('Untitled Case')));if(item.title)title.setAttribute('data-osi-user-content','');
        heading.appendChild(title);detail.appendChild(heading);
        var prerequisite=item.can_generate===true?'Private maintainer draft available.':String(item.generation_prerequisite||'Generation prerequisites are unavailable; action remains disabled.');
        detail.appendChild(make('span','',opsText('Stage: {stage}',{stage:humanCode(item.stage||'unknown')})+'. '+opsText(prerequisite)));
        row.appendChild(detail);
        var button=make('button','moc-action',opsText('Open AI Pack'));button.type='button';button.disabled=item.can_generate!==true;
        if(!button.disabled)button.addEventListener('click',function(){window.osiNavigate('field');window.osiV2OpenAiPack(String(item.public_ref||''));});
        row.appendChild(button);list.appendChild(row);
      });
      section.appendChild(list);
    }
    host.appendChild(section);
  }
  // SAS Authority Operations shows what the protected status endpoint
  // reports, with the time of each check, and offers one approved action per
  // ledger row: an idempotent reconcile_sas request. The server derives the
  // intended state from analyst_profiles, never overwrites a mismatched
  // credential, and may submit an issuer-signed Solana transaction. Nothing
  // is sent until both maintainer gates hold again and the maintainer
  // confirms inside the row. Each row keeps its last answer, keyed by wallet,
  // across refreshes until maintainer access ends or private data is cleared.
  var SAS_STATES={verified:'Verified',pending:'Verification pending',pending_verification:'Verification pending',unchecked:'Not checked yet',expired:'Expired',invalid:'Invalid',revoked:'Revoked',unavailable:'Unavailable'};
  var SAS=window.OSIFunctionalSurfaceCore.sas;
  var sasRuns={},sasGeneration=0,sasRefreshFailedAt=null;
  function sasRun(wallet){return sasRuns[wallet]||(sasRuns[wallet]={phase:'idle',outcome:null});}
  function forgetSasRuns(){sasRuns={};sasGeneration+=1;sasRefreshFailedAt=null;}
  function maintainerAccess(){return typeof window.resolveMaintainerAccess==='function'?window.resolveMaintainerAccess():{allowed:false,state:'unavailable'};}
  function sasGateMessage(state){
    if(state==='no_wallet')return'Connect the configured admin wallet to run this check. Nothing was sent.';
    if(state==='wrong_wallet')return'The connected wallet is not the configured admin wallet. Nothing was sent.';
    if(state==='login_required')return'Sign in with the Supabase maintainer account to run this check. Nothing was sent.';
    if(state==='checking')return'The server is still verifying both maintainer gates. Nothing was sent. Try again in a moment.';
    if(state==='auth_rejected')return'The server did not accept this Supabase sign-in as the maintainer. Nothing was sent.';
    return'Both maintainer gates are required to run this check. Nothing was sent.';
  }
  function sasStateLabel(value){return value?(opsText(SAS_STATES[value]||'')||humanCode(value)):opsText('Not recorded');}
  function sasSection(){var host=document.getElementById('osi-native-ops-overview');return host?host.querySelector('.osi-native-sas'):null;}
  function sasRowNode(scope,wallet){
    if(!scope)return null;
    var rows=scope.querySelectorAll('.osi-sas-row');
    for(var i=0;i<rows.length;i+=1){if(rows[i].getAttribute('data-sas-wallet')===wallet)return rows[i];}
    return null;
  }
  function sasFocusTarget(row,key){
    if(!row)return null;
    var node=row.querySelector('[data-sas-focus="'+key+'"]');
    if(node&&!node.disabled)return node;
    node=row.querySelector('[data-sas-focus="result"]');
    return node;
  }
  // Describe where focus sits inside the SAS section so a redraw can put it
  // back on the same control of the same wallet row.
  function sasFocusDescriptor(){
    var active=document.activeElement,section=sasSection();
    if(!active||!section||!section.contains(active))return null;
    var row=active.closest('.osi-sas-row');var key=active.getAttribute('data-sas-focus');
    return row&&key?{wallet:row.getAttribute('data-sas-wallet'),key:key}:null;
  }
  function restoreSasFocus(descriptor){
    if(!descriptor)return;
    var target=sasFocusTarget(sasRowNode(sasSection(),descriptor.wallet),descriptor.key);
    if(target)target.focus();
  }
  function fillSasResult(node,run){
    node.replaceChildren();node.removeAttribute('data-tone');
    if(run.phase==='running'){
      node.setAttribute('data-tone','running');
      node.appendChild(make('p','osi-sas-result-message',opsText('Checking live SAS state...')));
      return;
    }
    var outcome=run.outcome;if(!outcome)return;
    node.appendChild(make('p','osi-sas-result-time',opsText('Last check: {time}',{time:opsDate(outcome.at)})));
    if(outcome.kind==='gate'){
      node.setAttribute('data-tone','error');
      node.appendChild(make('p','osi-sas-result-message',opsText(sasGateMessage(outcome.state))));
      return;
    }
    if(outcome.kind==='error'){
      var failure=SAS.error(outcome.code);
      node.setAttribute('data-tone','error');
      node.appendChild(make('p','osi-sas-result-message',opsText(failure.message,failure.variables)));
      return;
    }
    var result=outcome.result,view=SAS.outcome(result);
    node.setAttribute('data-tone',view.tone);
    node.appendChild(make('p','osi-sas-result-message',opsText(view.message,view.variables)));
    if(view.reason)node.appendChild(make('p','osi-sas-result-detail',opsText('Reason: {reason}',{reason:opsText(view.reason)})));
    var facts=[opsText('Server-derived analyst status: {status}',{status:result.server_derived_status?humanCode(result.server_derived_status):opsText('Not recorded')})];
    if(result.verification_state)facts.push(opsText('Ledger credential state: {state}',{state:sasStateLabel(result.verification_state)}));
    node.appendChild(make('p','osi-sas-result-detail',facts.join('. ')+'.'));
    if(view.submitted){
      var tx=make('p','osi-sas-result-tx');
      tx.appendChild(make('strong','',opsText('Transaction submitted. Not yet confirmed on Solana.')));
      if(view.txSig){
        tx.appendChild(document.createTextNode(' '));
        var link=make('a','osi-sas-solscan',opsText('View on Solscan'));
        link.href='https://solscan.io/tx/'+encodeURIComponent(view.txSig);link.target='_blank';link.rel='noopener noreferrer';
        link.setAttribute('data-sas-focus','solscan');
        link.appendChild(make('span','sr-only',' '+opsText('(opens in a new tab)')));
        tx.appendChild(link);
      }else{
        tx.appendChild(document.createTextNode(' '+opsText('The transaction signature has an unexpected format, so no explorer link is shown.')));
      }
      node.appendChild(tx);
      if(view.txSig)node.appendChild(make('code','osi-sas-result-sig',view.txSig));
    }
    if(view.attestation)node.appendChild(make('p','osi-sas-result-detail',opsText('Attestation account: {account}',{account:shortWallet(view.attestation)})));
    if(view.nextStep)node.appendChild(make('p','osi-sas-result-next',opsText('Next step: {step}',{step:opsText(view.nextStep)})));
  }
  function buildSasConfirm(wallet){
    var box=make('div','osi-sas-confirm');
    box.setAttribute('role','group');box.tabIndex=-1;box.setAttribute('data-sas-focus','confirm');
    var title=make('p','osi-sas-confirm-title',opsText('Reconcile {wallet} with its live SAS credential?',{wallet:shortWallet(wallet)}));
    title.id='osi-sas-confirm-title-'+wallet;
    var text=make('p','osi-sas-confirm-text',opsText('The server compares this wallet\'s analyst status with its live SAS credential. If they differ, it may submit a Solana transaction signed by the OSI issuer. You cannot choose the result.'));
    text.id='osi-sas-confirm-text-'+wallet;
    box.setAttribute('aria-labelledby',title.id);box.setAttribute('aria-describedby',text.id);
    var actions=make('div','osi-sas-confirm-actions');
    var go=make('button','osi-sas-confirm-go',opsText('Confirm'));go.type='button';go.setAttribute('data-sas-focus','confirm-go');
    go.addEventListener('click',function(){runSasReconcile(wallet);});
    var cancel=make('button','osi-sas-confirm-cancel',opsText('Cancel'));cancel.type='button';cancel.setAttribute('data-sas-focus','cancel');
    cancel.addEventListener('click',function(){cancelSasConfirm(wallet);});
    box.addEventListener('keydown',function(event){
      if(event.key!=='Escape')return;
      event.preventDefault();event.stopPropagation();cancelSasConfirm(wallet);
    });
    actions.appendChild(go);actions.appendChild(cancel);
    box.appendChild(title);box.appendChild(text);box.appendChild(actions);
    return box;
  }
  function buildSasRow(row,profiles,settings){
    var wallet=String(row&&row.wallet||'');
    var valid=SAS.isWalletAddress(wallet);
    var run=valid?sasRun(wallet):{phase:'idle',outcome:null};
    var profile=profiles.find(function(item){return item&&item.wallet===wallet;})||{};
    var line=make('div','moc-feed-row osi-sas-row');
    if(valid)line.setAttribute('data-sas-wallet',wallet);
    if(run.phase==='running')line.setAttribute('aria-busy','true');
    line.appendChild(make('i','moc-dot'));
    var detail=make('div','');
    var heading=make('b','');heading.appendChild(make('code','osi-native-ref',shortWallet(wallet)));
    heading.appendChild(make('span','osi-native-title',sasStateLabel(row.verification_state||'unavailable')));
    detail.appendChild(heading);
    var parts=[opsText('Analyst status: {status}',{status:profile.status?humanCode(profile.status):opsText('No profile')}),opsText('Checked: {time}',{time:row.last_checked_at?opsDate(row.last_checked_at):opsText('Never')})];
    if(row.last_error)parts.push(opsText('Last error: {error}',{error:humanCode(row.last_error)}));
    detail.appendChild(make('span','',parts.join('. ')));
    var prerequisite=!valid?'Reconcile is unavailable because this ledger row has no valid wallet address.'
      :settings.issuance_enabled!==true?'Reconcile is unavailable while SAS credential issuance is off.':'';
    var note=null;
    if(prerequisite){note=make('span','osi-sas-prerequisite',opsText(prerequisite));detail.appendChild(note);}
    line.appendChild(detail);
    var button=make('button','moc-action osi-sas-reconcile',opsText('Reconcile with live SAS'));
    button.type='button';button.setAttribute('data-sas-focus','reconcile');
    button.disabled=!!prerequisite||run.phase==='running';
    if(note&&valid){note.id='osi-sas-prerequisite-'+wallet;button.setAttribute('aria-describedby',note.id);}
    if(valid){
      button.setAttribute('aria-controls','osi-sas-panel-'+wallet);
      button.setAttribute('aria-expanded',run.phase==='confirm'?'true':'false');
      button.addEventListener('click',function(){openSasConfirm(wallet);});
    }
    line.appendChild(button);
    if(valid){
      var panel=make('div','osi-sas-panel');panel.id='osi-sas-panel-'+wallet;
      if(run.phase==='confirm'&&!prerequisite)panel.appendChild(buildSasConfirm(wallet));
      var status=make('div','osi-sas-result');
      status.setAttribute('role','status');status.tabIndex=-1;status.setAttribute('data-sas-focus','result');
      fillSasResult(status,run);
      panel.appendChild(status);line.appendChild(panel);
    }
    return line;
  }
  function currentSasContext(){
    var status=lastRender&&lastRender.sas;
    if(!status||status.ok!==true)return null;
    return{
      credentials:Array.isArray(status.credentials)?status.credentials:[],
      profiles:Array.isArray(status.profiles)?status.profiles:[],
      settings:status.settings||{}
    };
  }
  // Redraw one row in place. Focus moves only when the person acted on this
  // row, or when focus was already inside it and would otherwise be lost.
  function repaintSasRow(wallet,focusKey,forceFocus){
    var context=currentSasContext(),current=sasRowNode(sasSection(),wallet);
    if(!context||!current)return;
    var row=context.credentials.find(function(item){return item&&item.wallet===wallet;});
    if(!row)return;
    var active=document.activeElement;
    var hadFocus=!!(active&&(current.contains(active)||active===document.body));
    var next=buildSasRow(row,context.profiles,context.settings);
    current.replaceWith(next);
    if(focusKey&&(forceFocus||hadFocus)){var target=sasFocusTarget(next,focusKey);if(target)target.focus();}
  }
  function repaintSasSection(){
    var section=sasSection();
    if(!section||!lastRender)return;
    var descriptor=sasFocusDescriptor();
    var holder=document.createDocumentFragment();
    renderSasOperations(holder,lastRender.sas);
    section.replaceWith(holder);
    restoreSasFocus(descriptor);
  }
  function openSasConfirm(wallet){
    var run=sasRun(wallet);
    if(run.phase==='running')return;
    var access=maintainerAccess();
    if(!access.allowed){
      run.phase='idle';run.outcome={kind:'gate',state:access.state||'',at:new Date().toISOString()};
      repaintSasRow(wallet,'result',true);return;
    }
    Object.keys(sasRuns).forEach(function(other){
      if(other!==wallet&&sasRuns[other].phase==='confirm'){sasRuns[other].phase='idle';repaintSasRow(other,null,false);}
    });
    run.phase='confirm';
    repaintSasRow(wallet,'confirm',true);
  }
  function cancelSasConfirm(wallet){
    var run=sasRun(wallet);
    if(run.phase!=='confirm')return;
    run.phase='idle';
    repaintSasRow(wallet,'reconcile',true);
  }
  async function refreshSasStatus(generation){
    var access=maintainerAccess();
    if(!access.allowed||typeof window.admFunctionPost!=='function')return;
    var status=await window.admFunctionPost('osi-v2-analyst',{op:'sas_operations_status',wallet:access.wallet}).catch(function(){return{ok:false};});
    if(generation!==sasGeneration)return;
    if(!maintainerAccess().allowed){forgetSasRuns();clearNativeOperations('Maintainer access locked.');return;}
    if(!lastRender)return;
    if(status&&status.ok===true){lastRender.sas=status;sasRefreshFailedAt=null;}
    else sasRefreshFailedAt=new Date().toISOString();
    repaintSasSection();
  }
  async function runSasReconcile(wallet){
    if(!SAS.isWalletAddress(wallet))return;
    var run=sasRun(wallet);
    if(run.phase==='running')return;
    // Both gates are read again at the moment of the request, not only when
    // the panel was drawn. Either credential alone sends nothing.
    var access=maintainerAccess();
    if(!access.allowed||!SAS.isWalletAddress(String(access.wallet||''))||typeof window.admFunctionPost!=='function'){
      run.phase='idle';run.outcome={kind:'gate',state:access.state||'',at:new Date().toISOString()};
      repaintSasRow(wallet,'result',true);return;
    }
    var generation=sasGeneration;
    run.phase='running';
    repaintSasRow(wallet,'result',true);
    var response;
    try{response=await window.admFunctionPost('osi-v2-analyst',{op:'reconcile_sas',wallet:access.wallet,analyst_wallet:wallet});}
    catch(error){response={ok:false,error:String(error&&error.message||'network_unavailable')};}
    if(generation!==sasGeneration)return;
    var after=maintainerAccess();
    if(!after.allowed||after.wallet!==access.wallet){forgetSasRuns();clearNativeOperations('Maintainer access locked.');return;}
    var at=new Date().toISOString();
    if(response&&response.ok===true){
      run.outcome=response.analyst_wallet===wallet
        ?{kind:'result',at:at,result:{
          action:response.action,reason:response.reason,server_derived_status:response.server_derived_status,
          verification_state:response.verification_state,attestation:response.attestation,
          tx_sig:response.tx_sig,submitted_on_chain:response.submitted_on_chain,next_step:response.next_step
        }}
        :{kind:'error',code:'wallet_mismatch',at:at};
    }else{
      run.outcome={kind:'error',code:String(response&&response.error||'unavailable'),at:at};
    }
    run.phase='idle';
    repaintSasRow(wallet,'result',false);
    var refresh=run.outcome.kind==='result'||SAS.error(run.outcome.code).refresh;
    if(refresh)await refreshSasStatus(generation);
  }
  function renderSasOperations(host,status){
    var section=make('section','osi-native-block osi-native-sas');
    section.appendChild(make('h4','',opsText('SAS Authority Operations')));
    if(!status||status.ok!==true){
      section.appendChild(make('div','moc-loading',opsText('The protected SAS status endpoint is unavailable. Issuance and revocation remain fail-closed.')));
      host.appendChild(section);return;
    }
    var settings=status.settings||{};
    var summary=make('div','osi-native-metrics');
    appendMetric(summary,opsText('Issuance'),opsText(settings.issuance_enabled?'On':'Off'));
    appendMetric(summary,opsText('Enforcement'),opsText(settings.enforcement_enabled?'On':'Off'));
    var credentials=Array.isArray(status.credentials)?status.credentials:[];
    appendMetric(summary,opsText('Verified credentials'),credentials.filter(function(row){return row.verification_state==='verified';}).length);
    section.appendChild(summary);
    var facts=make('dl','osi-native-facts');
    [['Program',settings.program_id],['Credential',settings.credential],['Schema',settings.schema],['Issuer',settings.issuer]].forEach(function(pair){
      var row=make('div','');row.appendChild(make('dt','',opsText(pair[0])));
      row.appendChild(pair[1]?make('dd','mono',String(pair[1])):make('dd','',opsText('Not configured')));
      facts.appendChild(row);
    });
    section.appendChild(facts);
    section.appendChild(make('p','osi-native-note',opsText('The server derives each intended credential and never overwrites a mismatched credential, schema, issuer or program. A reconcile check submits an issuer-signed Solana transaction only when a credential is missing or must be closed.')));
    if(sasRefreshFailedAt)section.appendChild(make('p','osi-native-note osi-sas-refresh-note',opsText('The SAS ledger could not be refreshed after the last check at {time}. The rows below show the previously loaded state.',{time:opsDate(sasRefreshFailedAt)})));
    if(!credentials.length){
      section.appendChild(make('div','moc-loading',opsText('No SAS credential ledger rows exist.')));
    }else{
      var profiles=Array.isArray(status.profiles)?status.profiles:[];
      var list=make('div','moc-feed');
      credentials.forEach(function(row){list.appendChild(buildSasRow(row||{},profiles,settings));});
      section.appendChild(list);
    }
    host.appendChild(section);
  }
  var lastRender=null;
  function renderNativeOperations(overview,aiPackStatus,sasStatus,updatedAt){
    var host=document.getElementById('osi-native-ops-overview');if(!host)return;
    lastRender={overview:overview,ai:aiPackStatus,sas:sasStatus,updatedAt:updatedAt};
    var focus=sasFocusDescriptor();
    host.replaceChildren();
    var totals=overview&&overview.totals||{},flags=overview&&overview.flags||{};
    host.appendChild(make('p','osi-native-updated',opsText('Last refreshed: {time}',{time:opsDate(updatedAt)})));
    var metrics=make('div','osi-native-metrics');
    appendMetric(metrics,opsText('Cases'),Number(totals.cases||0));
    appendMetric(metrics,opsText('Private'),Number(totals.cases_by_visibility&&totals.cases_by_visibility.private||0));
    appendMetric(metrics,opsText('Public'),Number(totals.cases_by_visibility&&totals.cases_by_visibility.public||0));
    appendMetric(metrics,opsText('Migration review queue'),Number(totals.migration_manual_queue_rows||0));
    host.appendChild(metrics);
    renderFlags(host,flags);
    renderAiPackOperations(host,aiPackStatus);
    renderSasOperations(host,sasStatus);
    restoreSasFocus(focus);
  }
  async function refreshNativeOperations(){
    var access=typeof window.resolveMaintainerAccess==='function'?window.resolveMaintainerAccess():{allowed:false};
    if(!access.allowed){forgetSasRuns();clearNativeOperations(typeof window.maintainerAccessMessage==='function'?window.maintainerAccessMessage(access):'Both maintainer gates are required.');return null;}
    clearNativeOperations('Loading the server-derived native Case overview...');
    try{
      var result=await window.osiV2LoadMaintainerOverview();
      var statuses=await Promise.all([
        typeof window.admAiPackOperationsStatus==='function'
          ?window.admAiPackOperationsStatus(access.wallet)
          :Promise.resolve({ok:false,error:'ai_pack_operations_unavailable'}),
        typeof window.admFunctionPost==='function'
          ?window.admFunctionPost('osi-v2-analyst',{op:'sas_operations_status',wallet:access.wallet}).catch(function(){return{ok:false};})
          :Promise.resolve({ok:false,error:'sas_operations_unavailable'})
      ]);
      if(!(typeof window.resolveMaintainerAccess==='function'&&window.resolveMaintainerAccess().allowed)){forgetSasRuns();clearNativeOperations('Maintainer access locked.');return null;}
      if(statuses[1]&&statuses[1].ok===true)sasRefreshFailedAt=null;
      renderNativeOperations(result&&result.overview||{},statuses[0],statuses[1],new Date().toISOString());return result;
    }catch(error){clearNativeOperations(opsText('Native Case overview unavailable: {reason}.',{reason:String(error&&error.message||'request failed').replace(/_/g,' ')}));return null;}
  }
  window.osiNativeOpsRefresh=refreshNativeOperations;
  window.admRefresh=refreshNativeOperations;
  // Composed text above is translated when it is drawn, so a language change
  // redraws the last answer instead of leaving it in the previous language.
  window.addEventListener('osi:localechange',function(){
    if(lastRender&&typeof window.resolveMaintainerAccess==='function'&&window.resolveMaintainerAccess().allowed)renderNativeOperations(lastRender.overview,lastRender.ai,lastRender.sas,lastRender.updatedAt);
  });
  if(typeof window.osiV2RegisterPrivateCache==='function')window.osiV2RegisterPrivateCache('operations',function(){forgetSasRuns();clearNativeOperations('Private Operations data cleared. Unlock both maintainer gates to continue.');});

})();
