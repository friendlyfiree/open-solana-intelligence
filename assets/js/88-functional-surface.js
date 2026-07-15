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
  function appendMetric(host,label,value){
    var item=make('div','osi-native-metric');item.appendChild(make('span','',label));item.appendChild(make('strong','mono',value));host.appendChild(item);
  }
  function clearNativeOperations(message){
    var host=document.getElementById('osi-native-ops-overview');if(!host)return;
    host.replaceChildren(make('div','moc-loading',message||'Maintainer access locked.'));
  }
  function renderNativeOperations(overview){
    var host=document.getElementById('osi-native-ops-overview');if(!host)return;
    host.replaceChildren();
    var totals=overview&&overview.totals||{},flags=overview&&overview.flags||{};
    var metrics=make('div','osi-native-metrics');
    appendMetric(metrics,'Cases',Number(totals.cases||0));
    appendMetric(metrics,'Private',Number(totals.cases_by_visibility&&totals.cases_by_visibility.private||0));
    appendMetric(metrics,'Public',Number(totals.cases_by_visibility&&totals.cases_by_visibility.public||0));
    appendMetric(metrics,'Migration review queue',Number(totals.migration_manual_queue_rows||0));
    host.appendChild(metrics);
    var gates=make('div','osi-native-flags');
    Object.keys(flags).sort().forEach(function(key){
      var row=make('div','');row.appendChild(make('span','mono',key));row.appendChild(make('strong',String(flags[key])==='true'?'enabled':'closed',String(flags[key])||'unavailable'));gates.appendChild(row);
    });
    host.appendChild(gates);
    var actions=make('div','osi-native-ops-actions');
    var reviews=make('button','moc-action','Open Case review queue');reviews.type='button';reviews.addEventListener('click',function(){window.osiV2OpenReviewQueue();});actions.appendChild(reviews);
    var applications=make('button','moc-action','Refresh analyst applications');applications.type='button';applications.addEventListener('click',function(){window.osiAnalystLoadMaintainerQueue();});actions.appendChild(applications);
    host.appendChild(actions);
  }
  async function refreshNativeOperations(){
    var access=typeof window.resolveMaintainerAccess==='function'?window.resolveMaintainerAccess():{allowed:false};
    if(!access.allowed){clearNativeOperations(typeof window.maintainerAccessMessage==='function'?window.maintainerAccessMessage(access):'Both maintainer gates are required.');return null;}
    clearNativeOperations('Loading the server-derived native Case overview...');
    try{
      var result=await window.osiV2LoadMaintainerOverview();renderNativeOperations(result&&result.overview||{});return result;
    }catch(error){clearNativeOperations('Native Case overview unavailable: '+String(error&&error.message||'request failed').replace(/_/g,' ')+'.');return null;}
  }
  window.osiNativeOpsRefresh=refreshNativeOperations;
  window.admRefresh=refreshNativeOperations;
  if(typeof window.osiV2RegisterPrivateCache==='function')window.osiV2RegisterPrivateCache('operations',function(){clearNativeOperations('Private Operations data cleared. Unlock both maintainer gates to continue.');});

  function disableWireIntake(){
    document.querySelectorAll('#wire-view .wire-cta,#wire-view .wire-pub-btn').forEach(function(button){
      button.disabled=true;button.textContent='Wire intake unavailable';button.title='Native Wire intake does not yet have an accepted production write path';
    });
  }
  var feedRenderer=window.renderWire;
  if(typeof feedRenderer==='function')window.renderWire=async function(){var result=await feedRenderer();disableWireIntake();return result;};
  window.wireOpenForm=function(){disableWireIntake();if(typeof window.showToast==='function')window.showToast('Native Wire intake is unavailable until its reviewed signed endpoint is enabled.');};
  window.submitIntel=function(){if(typeof window.showToast==='function')window.showToast('Native Wire intake is not enabled. No submission was sent.');return Promise.resolve(null);};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',disableWireIntake);else disableWireIntake();
})();
