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
  return{catalog:catalog,run:run};
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
  // SAS status is read-only here. The live reconcile control stays out of the
  // console until it is separately approved; this panel only shows what the
  // protected status endpoint reports, with the time of each check.
  var SAS_STATES={verified:'Verified',pending:'Verification pending',expired:'Expired',invalid:'Invalid',revoked:'Revoked',unavailable:'Unavailable'};
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
    section.appendChild(make('p','osi-native-note',opsText('Read-only. The server derives each intended credential and never overwrites a mismatched credential, schema, issuer or program.')));
    if(!credentials.length){
      section.appendChild(make('div','moc-loading',opsText('No SAS credential ledger rows exist.')));
    }else{
      var profiles=Array.isArray(status.profiles)?status.profiles:[];
      var list=make('div','moc-feed');
      credentials.forEach(function(row){
        var profile=profiles.find(function(item){return item.wallet===row.wallet;})||{};
        var line=make('div','moc-feed-row');line.appendChild(make('i','moc-dot'));
        var detail=make('div','');
        var heading=make('b','');heading.appendChild(make('code','osi-native-ref',shortWallet(row.wallet)));
        heading.appendChild(make('span','osi-native-title',opsText(SAS_STATES[row.verification_state]||'')||humanCode(row.verification_state||'unavailable')));
        detail.appendChild(heading);
        var parts=[opsText('Analyst status: {status}',{status:profile.status?humanCode(profile.status):opsText('No profile')}),opsText('Checked: {time}',{time:row.last_checked_at?opsDate(row.last_checked_at):opsText('Never')})];
        if(row.last_error)parts.push(opsText('Last error: {error}',{error:humanCode(row.last_error)}));
        detail.appendChild(make('span','',parts.join('. ')));
        line.appendChild(detail);list.appendChild(line);
      });
      section.appendChild(list);
    }
    host.appendChild(section);
  }
  var lastRender=null;
  function renderNativeOperations(overview,aiPackStatus,sasStatus,updatedAt){
    var host=document.getElementById('osi-native-ops-overview');if(!host)return;
    lastRender={overview:overview,ai:aiPackStatus,sas:sasStatus,updatedAt:updatedAt};
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
  }
  async function refreshNativeOperations(){
    var access=typeof window.resolveMaintainerAccess==='function'?window.resolveMaintainerAccess():{allowed:false};
    if(!access.allowed){clearNativeOperations(typeof window.maintainerAccessMessage==='function'?window.maintainerAccessMessage(access):'Both maintainer gates are required.');return null;}
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
      if(!(typeof window.resolveMaintainerAccess==='function'&&window.resolveMaintainerAccess().allowed)){clearNativeOperations('Maintainer access locked.');return null;}
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
  if(typeof window.osiV2RegisterPrivateCache==='function')window.osiV2RegisterPrivateCache('operations',function(){clearNativeOperations('Private Operations data cleared. Unlock both maintainer gates to continue.');});

})();
