/* Native V2 AI Pack behavior, composed inside the existing Case drawer. */
(function(){
  'use strict';

  var API_URL=SUPABASE_URL+'/functions/v1/osi-v2-ai-pack';
  var COMPONENTS=[
    ['public_verifiability','Public verifiability'],
    ['onchain_reproducibility','On-chain reproducibility'],
    ['evidence_coverage','Evidence coverage'],
    ['source_consistency','Source consistency'],
    ['analyst_attestation','Count-gated analyst attestation']
  ];
  var AI_CAPABILITY_KEYS=[
    'ai_pack_writes_enabled','ai_pack_review_writes_enabled','wallet_connected',
    'viewer_role','analyst_eligible','maintainer_access','can_generate',
    'generation_prerequisite'
  ];
  var STATUS_IDS={
    generation:'osi-ai-pack-generation-status',
    review:'osi-ai-review-status',
    feedback:'osi-ai-feedback-status',
    approval:'osi-ai-approval-status'
  };
  var state={
    caseItem:null,capabilities:null,mode:'public',result:null,versionRef:'',layer:'',
    busy:false,busyAction:'',loadToken:0,operationKeys:Object.create(null),
    notices:Object.create(null)
  };

  function esc(value){
    return String(value==null?'':value).replace(/[&<>"']/g,function(char){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char];
    });
  }
  function text(value){return esc(value).replace(/\r?\n/g,'<br>');}
  function label(value){
    var result=String(value||'').replace(/_/g,' ').trim();
    return result?result.charAt(0).toUpperCase()+result.slice(1):'';
  }
  function dateText(value){
    var date=new Date(value||'');
    return isNaN(date.getTime())?'Not recorded':date.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
  }
  function wallet(){
    var value=typeof walletPubkey==='undefined'?window.walletPubkey:walletPubkey;
    return String(value||'');
  }
  function caseRef(){return String(state.caseItem&&state.caseItem.public_ref||'');}
  function host(){return document.getElementById('osi-ai-pack-root');}
  function randomKey(prefix){
    var id=crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(36).slice(2);
    return prefix+':'+id.replace(/[^A-Za-z0-9.-]/g,'');
  }
  function headers(){
    var token=typeof SUPA_AUTH_TOKEN==='string'&&SUPA_AUTH_TOKEN?SUPA_AUTH_TOKEN:SUPABASE_ANON_KEY;
    return{'Content-Type':'application/json','apikey':SUPABASE_ANON_KEY,'Authorization':'Bearer '+token};
  }
  async function api(body){
    var response=await fetch(API_URL,{method:'POST',headers:headers(),body:JSON.stringify(body)});
    var payload={};
    try{payload=await response.json();}catch(error){payload={ok:false,error:'invalid_server_response'};}
    if(!response.ok||payload.ok!==true){
      var failure=new Error(payload.error||('request_failed_'+response.status));
      failure.details=payload&&payload.details||{};
      failure.retryWithNewIdempotencyKey=payload.retry_with_new_idempotency_key===true;
      failure.status=response.status;
      throw failure;
    }
    return payload;
  }
  function bytesToBase64(bytes){
    var binary='';
    for(var i=0;i<bytes.length;i++)binary+=String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  async function signMessage(message){
    if(typeof window.osiV2ApproveMessage==='function')return await window.osiV2ApproveMessage(message);
    var provider=typeof window.getProvider==='function'?window.getProvider():window.solana;
    if(!provider||typeof provider.signMessage!=='function')throw new Error('wallet_message_unsupported');
    var signed=await provider.signMessage(new TextEncoder().encode(message),'utf8');
    var bytes=signed&&signed.signature?signed.signature:signed;
    if(!(bytes instanceof Uint8Array))bytes=new Uint8Array(bytes||[]);
    return bytesToBase64(bytes);
  }
  function stableValue(value){
    if(Array.isArray(value))return value.map(stableValue);
    if(value&&typeof value==='object'){
      var result={};
      Object.keys(value).sort().forEach(function(key){result[key]=stableValue(value[key]);});
      return result;
    }
    return value;
  }
  function operationRecord(operation,target,payload){
    var slot=operation+':'+String(target||'');
    var payloadSignature=JSON.stringify(stableValue(payload||{}));
    var current=state.operationKeys[slot];
    if(!current||current.payloadSignature!==payloadSignature){
      current={idempotencyKey:randomKey('ai-pack'),payloadSignature:payloadSignature};
      state.operationKeys[slot]=current;
    }
    return{slot:slot,idempotencyKey:current.idempotencyKey};
  }
  function clearOperation(slot){delete state.operationKeys[slot];}
  async function exactWrite(prepareOp,commitOp,target,payload){
    var actor=wallet();
    if(!actor)throw new Error('wallet_required');
    var operation=operationRecord(prepareOp,target,payload);
    var prepared;
    try{
      prepared=await api(Object.assign({
        op:prepareOp,wallet:actor,idempotency_key:operation.idempotencyKey
      },payload||{}));
    }catch(error){
      if(error&&error.retryWithNewIdempotencyKey)clearOperation(operation.slot);
      throw error;
    }
    if(prepared.already_committed){
      clearOperation(operation.slot);
      return prepared;
    }
    var signature=await signMessage(prepared.message);
    var committed=await api({
      op:commitOp,wallet:actor,nonce:prepared.nonce,message:prepared.message,signature:signature
    });
    clearOperation(operation.slot);
    return committed;
  }

  function waitText(error){
    var details=error&&error.details||{};
    var seconds=Number(
      details.retry_after_seconds!=null?details.retry_after_seconds:
      details.cooldown_remaining_seconds!=null?details.cooldown_remaining_seconds:
      details.reset_in_seconds
    );
    if(!Number.isFinite(seconds)||seconds<=0)return'';
    if(seconds<60)return'Try again in '+Math.ceil(seconds)+' seconds.';
    if(seconds<3600)return'Try again in '+Math.ceil(seconds/60)+' minutes.';
    return'Try again in '+Math.ceil(seconds/3600)+' hours.';
  }
  function errorText(error){
    var code=String(error&&error.message||error||'request_failed');
    var messages={
      ai_pack_writes_disabled:'AI Pack generation and feedback are safely disabled until the dedicated rollout flag is enabled.',
      ai_pack_writes_disabled_or_unavailable:'AI Pack writes are safely disabled or temporarily unavailable.',
      ai_pack_review_writes_disabled:'AI Pack review and approval are production-disabled in this release.',
      ai_pack_review_writes_disabled_or_unavailable:'AI Pack review and approval are safely disabled or temporarily unavailable.',
      not_eligible_generator:'This release allows generation only for a verified analyst or full double-gated maintainer.',
      case_owner_generation_deferred:'Case-owner generation is deferred until a separate budget and quota release.',
      ai_pack_prepare_wallet_rate_limited:'Too many AI Pack signing challenges were requested for this wallet. No provider call was made.',
      ai_pack_prepare_fingerprint_rate_limited:'Too many AI Pack signing challenges were requested from this source. No provider call was made.',
      ai_pack_wallet_rate_limited:'The per-wallet generation limit is active. No provider call was made.',
      ai_pack_fingerprint_rate_limited:'The request-source generation limit is active. No provider call was made.',
      ai_pack_case_cooldown_active:'This Case is inside its generation cooldown. No provider call was made.',
      ai_pack_daily_quota_exhausted:'The global daily generation budget is exhausted. No provider call was made.',
      ai_pack_input_too_large:'The approved evidence payload exceeds the configured input cap. No provider call was made.',
      ai_pack_generation_in_progress:'This exact generation is still in progress. No duplicate provider call was made.',
      ai_pack_generation_already_failed:'The previous generation attempt ended without a Pack. A retry will start a new signed attempt.',
      prohibited_secret_material:'Approved evidence still contains prohibited secret material and was not sent to the provider.',
      prohibited_personal_data:'Approved evidence contains prohibited personal data and was not sent to the provider.',
      prohibited_illegal_access_material:'Approved evidence contains illegal-access material and was not sent to the provider.',
      layer_isolation_rejected:'The generated layers did not remain isolated, so no Pack version was stored.',
      self_review_denied:'The creator and Case owner cannot cast a counted review on this exact Pack version.',
      analyst_quorum_not_met:'Approval requires at least two independent analysts and 2.50 total server-derived weight.',
      half_maintainer_wallet_only:'Maintainer finalization also requires the configured Supabase identity.',
      half_maintainer_auth_only:'Maintainer finalization also requires the configured admin wallet.',
      read_session_disabled_or_unavailable:'Private AI Pack layers are locked because read sessions are disabled or unavailable.',
      read_session_wrong_scope:'Refresh private access for the AI Pack detail scope.',
      read_session_expired:'Refresh private access to view authorized AI Pack layers.',
      wallet_required:'Connect a Solana wallet to continue.',
      wallet_message_unsupported:'This wallet does not support signMessage.',
      wallet_transaction_unsupported:'This wallet does not support the required Solana Memo transaction.'
    };
    var message=messages[code]||(code.indexOf(' ')>=0?code:code.replace(/_/g,' '));
    var wait=waitText(error);
    return wait?message+' '+wait:message;
  }
  function prerequisite(value,fallback){
    if(value==null||String(value).trim()==='')return fallback;
    return errorText(String(value));
  }
  function statusMarkup(action){
    var notice=state.notices[action]||{};
    return'<div class="osi-form-status mono '+esc(notice.kind||'')+'" id="'+STATUS_IDS[action]+'" role="status" aria-live="polite">'+esc(notice.message||'')+'</div>';
  }
  function setStatus(action,message,kind){
    state.notices[action]={message:String(message||''),kind:String(kind||'')};
    var node=document.getElementById(STATUS_IDS[action]);
    if(node){
      node.textContent=message||'';
      node.className='osi-form-status mono '+(kind||'');
    }
  }
  function beginAction(action){
    if(state.busy)return false;
    state.busy=true;
    state.busyAction=action;
    var root=host();
    if(root){
      root.setAttribute('aria-busy','true');
      Array.prototype.forEach.call(root.querySelectorAll('button,input,select,textarea'),function(control){
        if(!control.disabled){
          control.disabled=true;
          control.setAttribute('data-ai-busy-disabled','true');
        }
      });
    }
    var actionRoot=document.querySelector('[data-ai-action="'+action+'"]');
    if(actionRoot)actionRoot.setAttribute('aria-busy','true');
    return true;
  }
  function endAction(){
    var root=host();
    if(root){
      root.setAttribute('aria-busy','false');
      Array.prototype.forEach.call(root.querySelectorAll('[data-ai-busy-disabled="true"]'),function(control){
        control.disabled=false;
        control.removeAttribute('data-ai-busy-disabled');
      });
    }
    var actionRoot=document.querySelector('[data-ai-action="'+state.busyAction+'"]');
    if(actionRoot)actionRoot.removeAttribute('aria-busy');
    state.busy=false;
    state.busyAction='';
  }

  function mergeAiCapabilities(base,incoming){
    var result=Object.assign({},base||{});
    AI_CAPABILITY_KEYS.forEach(function(key){
      if(incoming&&Object.prototype.hasOwnProperty.call(incoming,key))result[key]=incoming[key];
    });
    return result;
  }
  function viewerRole(){
    var value=state.result&&state.result.viewer_role||state.capabilities&&state.capabilities.viewer_role||'public';
    return ['owner','analyst','senior','maintainer'].indexOf(value)>=0?value:'public';
  }
  function analystViewer(role){return role==='analyst'||role==='senior';}
  function restrictedViewer(role){return analystViewer(role)||role==='maintainer';}
  function publicLifecycle(version){
    return !!version&&['approved','attached_to_resolution'].indexOf(String(version.lifecycle_state||''))>=0;
  }
  function allVersions(){
    var rows=[];
    var role=viewerRole();
    (state.result&&state.result.packs||[]).forEach(function(pack){
      (pack.versions||[]).forEach(function(version){
        if(role==='public'&&!publicLifecycle(version))return;
        rows.push(Object.assign({
          pack_public_ref:pack.public_ref,pack_type:pack.pack_type
        },version));
      });
    });
    return rows.sort(function(a,b){
      var versionDelta=Number(b.version_no||0)-Number(a.version_no||0);
      if(versionDelta)return versionDelta;
      return new Date(b.created_at||0).getTime()-new Date(a.created_at||0).getTime();
    });
  }
  function selectedVersion(){
    var rows=allVersions();
    return rows.find(function(row){return row.version_ref===state.versionRef;})||rows[0]||null;
  }
  function availableLayers(version){
    if(!version)return[];
    var role=viewerRole();
    var rows=[];
    if(Object.prototype.hasOwnProperty.call(version,'content_public_brief')&&version.content_public_brief!=null){
      rows.push(['public','Public brief','content_public_brief']);
    }
    if(role!=='public'&&Object.prototype.hasOwnProperty.call(version,'content_owner_safe')&&version.content_owner_safe!=null){
      rows.push(['owner_safe','Owner-safe','content_owner_safe']);
    }
    if(restrictedViewer(role)&&Object.prototype.hasOwnProperty.call(version,'content_analyst_restricted')&&version.content_analyst_restricted!=null){
      rows.push(['analyst_restricted','Analyst-restricted','content_analyst_restricted']);
    }
    return rows;
  }
  function staleInfo(version,layer){
    var map=version&&version.staleness;
    if(!map||!Object.prototype.hasOwnProperty.call(map,layer)||!map[layer]||typeof map[layer].stale!=='boolean'){
      return'<span class="osi-chip warning">'+esc(label(layer))+' staleness unavailable</span>';
    }
    var row=map[layer];
    if(row.stale===true){
      return'<span class="osi-chip warning">'+esc(label(layer))+' stale'+
        (row.stale_at?' since '+esc(dateText(row.stale_at)):'')+'</span>'+
        (row.reason?'<p class="osi-action-help">'+esc(row.reason)+'</p>':'');
    }
    return'<span class="osi-chip">'+esc(label(layer))+' current at last server check</span>';
  }
  function profileValue(component){
    if(component==null)return'Not assessed';
    if(typeof component==='string'||typeof component==='number'||typeof component==='boolean')return String(component);
    if(typeof component==='object'){
      if(component.label)return String(component.label);
      if(component.status)return label(component.status);
      if(component.value!=null&&component.denominator!=null)return String(component.value)+' / '+String(component.denominator);
      if(component.value!=null)return String(component.value);
    }
    return'Not assessed';
  }
  function confidenceProfile(version){
    var profile=version&&version.confidence_profile||{};
    return'<div class="osi-list">'+COMPONENTS.map(function(component){
      var value=profile[component[0]];
      return'<div class="osi-list-item"><div class="osi-list-item-head"><b>'+esc(component[1])+
        '</b><span class="osi-chip">'+esc(profileValue(value))+'</span></div><p>'+
        esc(value&&value.basis||'Component evidence is not yet independently assessed.')+'</p></div>';
    }).join('')+'</div><div class="osi-case-note">Components remain separate. OSI does not calculate an accuracy, guilt, legal-certainty, truth-probability, or headline confidence score.</div>';
  }

  function generationReason(){
    var caps=state.capabilities||{};
    var role=viewerRole();
    if(caps.ai_pack_writes_enabled!==true){
      return prerequisite(caps.generation_prerequisite,'AI Pack generation is safely disabled until rollout and budget monitoring are ready.');
    }
    if(role==='owner')return'Case-owner generation is deferred until a separate quota and budget release.';
    if(caps.can_generate!==true){
      return prerequisite(caps.generation_prerequisite,'Requires a verified analyst or full double-gated maintainer for this Case.');
    }
    return'';
  }
  function generationPanel(){
    var caps=state.capabilities||{};
    var reason=generationReason();
    var canGenerate=!reason&&caps.can_generate===true&&caps.ai_pack_writes_enabled===true;
    return'<div class="osi-governance-compose" data-ai-action="generation"><h4>Generate an immutable draft</h4>'+
      '<p>Generation summarizes only server-approved Case evidence into three isolated layers. It is an artifact-creation action, not a truth decision or publication.</p>'+
      '<label>Pack type<select id="osi-ai-pack-type" '+(canGenerate?'':'disabled')+'>'+
      '<option value="victim">Victim brief</option><option value="exchange">Exchange brief</option>'+
      '<option value="law_enforcement">Law-enforcement brief</option></select></label>'+
      '<button class="osi-action primary" id="osi-ai-pack-generate" type="button" aria-describedby="osi-ai-pack-generation-help" '+
      (canGenerate?'':'disabled')+'>Generate draft</button>'+
      '<p class="osi-action-help" id="osi-ai-pack-generation-help">'+esc(reason||'Creates a private, immutable, review-required version.')+'</p>'+
      statusMarkup('generation')+'</div>';
  }
  function historyPanel(rows){
    if(!rows.length){
      return'<div class="osi-v2-empty"><b>No AI Pack versions</b><span>No model output is invented or shown. Generation remains subject to the dedicated flag, eligibility, evidence safety checks, rate limits, Case cooldown, global quota, and input cap.</span></div>';
    }
    var selected=selectedVersion();
    return'<div class="osi-list" aria-label="AI Pack version history">'+rows.map(function(version){
      var active=selected&&selected.version_ref===version.version_ref;
      return'<button class="osi-list-item osi-ai-version" type="button" data-ai-version="'+esc(version.version_ref)+
        '" aria-pressed="'+active+'" '+(active?'aria-current="true"':'')+'>'+
        '<div class="osi-list-item-head"><b class="osi-evidence-ref">'+esc(version.version_ref)+' / v'+esc(version.version_no)+
        '</b><span class="osi-chip">'+esc(label(version.lifecycle_state))+'</span></div>'+
        '<p>'+esc(label(version.pack_type))+' / created '+esc(dateText(version.created_at))+
        (active?' / selected':'')+'</p></button>';
    }).join('')+'</div>';
  }
  function proofLabel(row){
    if(row&&row.proof_label){
      return'<span class="osi-proof-label">'+esc(row.proof_label)+'</span>';
    }
    return'<span class="osi-proof-label legacy">Proof unavailable</span>';
  }
  function countText(value){
    var number=Number(value);
    return Number.isFinite(number)?String(number):'Unavailable';
  }
  function weightText(value){
    var number=Number(value);
    return Number.isFinite(number)?number.toFixed(2):'Unavailable';
  }
  function reviewPanel(version){
    var caps=state.capabilities||{};
    var role=viewerRole();
    if(!restrictedViewer(role))return'';
    var quorum=version.quorum||{};
    var reviewEnabled=caps.ai_pack_review_writes_enabled===true;
    var reviews=(version.reviews||[]).map(function(row){
      return'<div class="osi-list-item"><div class="osi-list-item-head"><b>'+
        esc(row.review_public_ref||'Attributable review')+' / '+esc(label(row.decision))+'</b>'+
        proofLabel(row)+'</div><p>'+esc(row.reviewer_wallet||'Reviewer unavailable')+' / weight '+
        esc(weightText(row.weight))+' / '+esc(dateText(row.created_at))+'</p><p>'+
        text(row.public_rationale||'No public rationale recorded.')+'</p></div>';
    }).join('');
    var form='';
    if(analystViewer(role)&&caps.analyst_eligible===true){
      var reviewReason=!reviewEnabled
        ?'AI Pack review and approval are production-disabled in this release.'
        :version.can_review_exact_version===true
          ?''
          :prerequisite(version.review_prerequisite,'This exact version is not reviewable by the connected analyst.');
      var canReview=!reviewReason&&version.can_review_exact_version===true&&reviewEnabled;
      form='<div class="osi-governance-compose" data-ai-action="review"><h4>Exact-version review</h4>'+
        '<label>Decision<select id="osi-ai-review-decision" '+(canReview?'':'disabled')+'>'+
        '<option value="approve">Approve</option><option value="support">Support</option>'+
        '<option value="dispute">Dispute</option><option value="request_revision">Request revision</option></select></label>'+
        '<label>Public rationale<textarea id="osi-ai-review-rationale" maxlength="2000" '+(canReview?'':'disabled')+
        ' placeholder="Explain the evidence-bound process decision."></textarea></label>'+
        '<label>Restricted analyst note<textarea id="osi-ai-review-note" maxlength="4000" '+(canReview?'':'disabled')+
        ' placeholder="Optional. Never returned to the Case owner or public."></textarea></label>'+
        '<button class="osi-action" id="osi-ai-review-submit" type="button" aria-describedby="osi-ai-review-help" '+
        (canReview?'':'disabled')+'>Sign exact-version review</button>'+
        '<p class="osi-action-help" id="osi-ai-review-help">'+esc(reviewReason||'The exact immutable version and server-derived analyst weight will be bound before signing.')+'</p>'+
        statusMarkup('review')+'</div>';
    }
    var finalize='';
    if(role==='maintainer'&&caps.maintainer_access===true){
      var finalizeReason=!reviewEnabled
        ?'AI Pack review and approval are production-disabled in this release.'
        :version.can_finalize===true
          ?''
          :prerequisite(version.finalize_prerequisite,'Requires two independent analysts, 2.50 weight, and a full non-creator maintainer.');
      var canFinalize=!finalizeReason&&version.can_finalize===true&&reviewEnabled;
      finalize='<div data-ai-action="approval"><button class="osi-action primary" id="osi-ai-approve" type="button" '+
        'aria-describedby="osi-ai-approval-help" '+(canFinalize?'':'disabled')+'>Memo-anchor analyst-ready approval</button>'+
        '<p class="osi-action-help" id="osi-ai-approval-help">'+esc(finalizeReason||'Finalizes only the analyst-ready outcome and cannot replace quorum.')+'</p>'+
        statusMarkup('approval')+'</div>';
    }
    return'<div class="osi-case-meta"><div><span>Independent approvals</span><b>'+
      esc(countText(quorum.approve_count))+' / '+esc(countText(quorum.required_count==null?2:quorum.required_count))+
      '</b></div><div><span>Counted weight</span><b>'+esc(weightText(quorum.approve_weight))+' / '+
      esc(weightText(quorum.required_weight==null?2.5:quorum.required_weight))+'</b></div></div>'+
      (reviews?'<div class="osi-list">'+reviews+'</div>':'<div class="osi-v2-empty"><b>No counted reviews</b><span>The creator and Case owner are excluded. A maintainer cannot substitute for analyst quorum.</span></div>')+
      form+finalize;
  }
  function feedbackPanel(){
    if(viewerRole()!=='owner')return'';
    var enabled=(state.capabilities||{}).ai_pack_writes_enabled===true;
    var reason=enabled?'':'AI Pack owner feedback is safely disabled until the dedicated rollout flag is enabled.';
    return'<div class="osi-governance-compose" data-ai-action="feedback"><h4>Owner advisory feedback</h4>'+
      '<p>Feedback is attributable, advisory, uncounted, and contributes zero review weight. It never changes this profile automatically.</p>'+
      '<label>Feedback type<select id="osi-ai-feedback-type" '+(enabled?'':'disabled')+'>'+
      '<option value="correction_request">Correction request</option><option value="clarification">Clarification</option>'+
      '<option value="evidence_note">Evidence note</option></select></label>'+
      '<label>Public-safe summary<textarea id="osi-ai-feedback-public" maxlength="4000" '+(enabled?'':'disabled')+'></textarea></label>'+
      '<label>Owner-restricted detail<textarea id="osi-ai-feedback-restricted" maxlength="20000" '+(enabled?'':'disabled')+'></textarea></label>'+
      '<button class="osi-action" id="osi-ai-feedback-submit" type="button" aria-describedby="osi-ai-feedback-help" '+
      (enabled?'':'disabled')+'>Sign advisory feedback</button>'+
      '<p class="osi-action-help" id="osi-ai-feedback-help">'+esc(reason||'This feedback remains advisory and never becomes an analyst vote.')+'</p>'+
      statusMarkup('feedback')+'</div>';
  }
  function versionPanel(version){
    if(!version)return'';
    var layers=availableLayers(version);
    if(!state.layer||!layers.some(function(row){return row[0]===state.layer;})){
      state.layer=layers.length?layers[layers.length-1][0]:'';
    }
    var selected=layers.find(function(row){return row[0]===state.layer;});
    var content=selected?version[selected[2]]:'';
    var chooser=layers.length>1?'<label>Authorized layer<select id="osi-ai-layer">'+layers.map(function(row){
      return'<option value="'+row[0]+'" '+(row[0]===state.layer?'selected':'')+'>'+esc(row[1])+'</option>';
    }).join('')+'</select></label>':'';
    var review=reviewPanel(version);
    return'<div class="osi-governance-compose"><div class="osi-section-heading"><div>'+
      '<span class="osi-eyebrow">Immutable evidence-bound version</span><h4 class="osi-evidence-ref">'+
      esc(version.version_ref)+'</h4></div><span class="osi-chip">'+esc(label(version.lifecycle_state))+'</span></div>'+
      chooser+(selected?staleInfo(version,selected[0])+
        '<div class="osi-case-note"><b>'+esc(selected[1])+'</b><p class="osi-evidence-ref">'+
        text(content||'This authorized layer is empty.')+'</p></div>':
        '<div class="osi-v2-empty"><b>No authorized content layer</b><span>The gateway did not return Pack content authorized for this viewer.</span></div>')+
      '<h4>Evidence Confidence Profile</h4>'+confidenceProfile(version)+
      (review?'<h4>Review history and approval gate</h4>'+review:'')+feedbackPanel(version)+'</div>';
  }
  function focusAfterRender(id){
    setTimeout(function(){
      var target=id&&document.getElementById(id);
      if(!target||target.disabled){
        target=document.querySelector('[data-ai-version][aria-current="true"]');
      }
      if(target&&typeof target.focus==='function')target.focus();
    },0);
  }
  function renderResult(options){
    var root=host();
    if(!root)return;
    var rows=allVersions();
    var version=selectedVersion();
    if(version&&!state.versionRef)state.versionRef=version.version_ref;
    root.innerHTML=generationPanel()+
      '<div class="osi-section-heading"><div><span class="osi-eyebrow">Version history</span>'+
      '<h4>AI Pack artifacts</h4></div><span class="osi-chip">'+esc(rows.length)+' versions</span></div>'+
      historyPanel(rows)+versionPanel(selectedVersion());
    root.setAttribute('aria-busy','false');
    bind();
    if(options&&options.focusId)focusAfterRender(options.focusId);
  }
  function loadingMarkup(){
    return'<div class="osi-v2-skeleton" aria-hidden="true"></div><div class="osi-v2-skeleton" aria-hidden="true"></div>'+
      '<span class="sr-only">Loading AI Pack data.</span>';
  }
  function loadIsCurrent(token,ref){
    return token===state.loadToken&&ref===caseRef()&&!!state.caseItem;
  }
  function shouldUsePrivate(caps,ref){
    if(!wallet()||typeof window.osiV2ReadSession!=='function')return false;
    var role=String(caps&&caps.viewer_role||'');
    if(['owner','analyst','senior','maintainer'].indexOf(role)>=0)return true;
    if(caps&&(caps.analyst_eligible===true||caps.maintainer_access===true))return true;
    return String(state.caseItem&&state.caseItem.submitted_by_wallet||'')===wallet()&&ref===caseRef();
  }
  async function performLoad(token,ref,options){
    var root=host();
    if(!root||!loadIsCurrent(token,ref))return;
    root.setAttribute('aria-busy','true');
    root.innerHTML=loadingMarkup();
    try{
      if(window.OSI_WALLET_READY)await window.OSI_WALLET_READY;
      if(!loadIsCurrent(token,ref))return;
      var caps=state.capabilities||{};
      if(wallet()){
        try{
          var exactCaps=await api({op:'capabilities',wallet:wallet(),case_ref:ref});
          if(!loadIsCurrent(token,ref))return;
          caps=mergeAiCapabilities(caps,exactCaps);
        }catch(capabilityError){
          caps=mergeAiCapabilities(caps,{
            ai_pack_writes_enabled:false,ai_pack_review_writes_enabled:false,can_generate:false,
            generation_prerequisite:'AI Pack capabilities are safely unavailable for this Case.'
          });
        }
      }
      if(!loadIsCurrent(token,ref))return;
      state.capabilities=caps;
      var result;
      if(shouldUsePrivate(caps,ref)){
        try{
          var session=await window.osiV2ReadSession(['aipack:detail'],{allowUnlock:true});
          result=await api({op:'get_case_packs',case_ref:ref,wallet:session.wallet,read_session:session.token});
        }catch(privateError){
          if(state.caseItem.visibility!=='public')throw privateError;
          result=await api({op:'list_public_case_packs',case_ref:ref});
          result=Object.assign({},result,{viewer_role:'public'});
          if(!state.notices.generation){
            state.notices.generation={message:errorText(privateError),kind:'warning'};
          }
        }
      }else{
        result=await api({op:'list_public_case_packs',case_ref:ref});
        result=Object.assign({},result,{viewer_role:'public'});
      }
      if(!loadIsCurrent(token,ref))return;
      state.result=result;
      var previous=state.versionRef;
      var versions=allVersions();
      state.versionRef=versions.some(function(row){return row.version_ref===previous;})
        ?previous:(versions[0]&&versions[0].version_ref||'');
      state.layer='';
      renderResult(options);
    }catch(error){
      if(!loadIsCurrent(token,ref))return;
      root.setAttribute('aria-busy','false');
      root.innerHTML='<div class="osi-v2-empty osi-v2-error"><b>AI Pack view unavailable</b><span>'+
        esc(errorText(error))+'</span><button class="osi-action" id="osi-ai-pack-retry" type="button">Retry</button></div>';
      var retry=document.getElementById('osi-ai-pack-retry');
      if(retry)retry.addEventListener('click',function(){reload({focusId:'osi-ai-pack-retry'});});
    }
  }
  function reload(options){
    var ref=caseRef();
    var token=++state.loadToken;
    return performLoad(token,ref,options||{});
  }

  async function generate(){
    var ref=caseRef();
    if(!ref||!beginAction('generation'))return;
    var completed=false;
    try{
      setStatus('generation','Preparing an exact single-use generation authorization...');
      var packType=document.getElementById('osi-ai-pack-type').value;
      setStatus('generation','Approve the wallet-signature request. This is not an on-chain transaction.');
      await exactWrite('prepare_generation','commit_generation',ref,{case_ref:ref,pack_type:packType});
      if(ref!==caseRef())return;
      setStatus('generation','Immutable draft generated from approved evidence. It remains unpublished and review-required.','success');
      endAction();
      completed=true;
      await reload({focusId:''});
    }catch(error){
      if(ref===caseRef())setStatus('generation',errorText(error),'error');
    }finally{
      if(!completed&&state.busyAction==='generation')endAction();
    }
  }
  async function review(){
    var version=selectedVersion();
    var ref=caseRef();
    if(!version||!beginAction('review'))return;
    var completed=false;
    try{
      var rationale=String(document.getElementById('osi-ai-review-rationale').value||'').trim();
      if(rationale.length<10)throw new Error('Add a public rationale of at least 10 characters.');
      var payload={
        version_ref:version.version_ref,
        decision:document.getElementById('osi-ai-review-decision').value,
        public_rationale:rationale,
        private_note:String(document.getElementById('osi-ai-review-note').value||'').trim()||null
      };
      setStatus('review','Approve the exact-version analyst review in your wallet.');
      await exactWrite('prepare_review','commit_review',version.version_ref,payload);
      if(ref!==caseRef())return;
      setStatus('review','Exact-version review recorded with its server-verified receipt.','success');
      endAction();
      completed=true;
      await reload({focusId:'osi-ai-review-submit'});
    }catch(error){
      if(ref===caseRef())setStatus('review',errorText(error),'error');
    }finally{
      if(!completed&&state.busyAction==='review')endAction();
    }
  }
  async function feedback(){
    var version=selectedVersion();
    var ref=caseRef();
    if(!version||!beginAction('feedback'))return;
    var completed=false;
    try{
      var publicSummary=String(document.getElementById('osi-ai-feedback-public').value||'').trim();
      var restricted=String(document.getElementById('osi-ai-feedback-restricted').value||'').trim();
      if(!publicSummary&&!restricted)throw new Error('Add public-safe or owner-restricted feedback.');
      var payload={
        version_ref:version.version_ref,
        feedback_type:document.getElementById('osi-ai-feedback-type').value,
        public_safe_summary:publicSummary||null,
        feedback_restricted:restricted||null
      };
      setStatus('feedback','Approve the advisory owner feedback in your wallet.');
      await exactWrite('prepare_owner_feedback','commit_owner_feedback',version.version_ref,payload);
      if(ref!==caseRef())return;
      setStatus('feedback','Advisory owner feedback recorded with zero review weight.','success');
      endAction();
      completed=true;
      await reload({focusId:'osi-ai-feedback-submit'});
    }catch(error){
      if(ref===caseRef())setStatus('feedback',errorText(error),'error');
    }finally{
      if(!completed&&state.busyAction==='feedback')endAction();
    }
  }
  async function approve(){
    var version=selectedVersion();
    var ref=caseRef();
    if(!version||!beginAction('approval'))return;
    var completed=false;
    var payload={version_ref:version.version_ref};
    var operation=operationRecord('prepare_approval',version.version_ref,payload);
    try{
      setStatus('approval','Preparing the exact AI_PACK_APPROVED Memo authorization...');
      var prepared=await api({
        op:'prepare_approval',wallet:wallet(),version_ref:version.version_ref,
        idempotency_key:operation.idempotencyKey
      });
      if(prepared.already_committed){
        clearOperation(operation.slot);
      }else{
        if(typeof window.castOnchainVote!=='function')throw new Error('wallet_transaction_unsupported');
        setStatus('approval','Approve the exact Solana Memo transaction. OSI receives no funds.');
        var txSig=await window.castOnchainVote(prepared.memo);
        setStatus('approval','Confirming the signer, exact Memo, target, freshness, and mainnet transaction...');
        await api({
          op:'commit_approval',wallet:wallet(),version_ref:version.version_ref,
          nonce:prepared.nonce,memo:prepared.memo,tx_sig:txSig
        });
        clearOperation(operation.slot);
      }
      if(ref!==caseRef())return;
      setStatus('approval','Analyst-ready approval Memo confirmed. The exact version is now approved.','success');
      endAction();
      completed=true;
      await reload({focusId:'osi-ai-approve'});
    }catch(error){
      if(ref===caseRef())setStatus('approval',errorText(error),'error');
    }finally{
      if(!completed&&state.busyAction==='approval')endAction();
    }
  }
  function bind(){
    var generateButton=document.getElementById('osi-ai-pack-generate');
    if(generateButton&&!generateButton.disabled)generateButton.addEventListener('click',generate);
    Array.prototype.forEach.call(document.querySelectorAll('[data-ai-version]'),function(button){
      button.addEventListener('click',function(){
        state.versionRef=button.dataset.aiVersion;
        state.layer='';
        renderResult({focusId:''});
      });
    });
    var layer=document.getElementById('osi-ai-layer');
    if(layer)layer.addEventListener('change',function(){state.layer=layer.value;renderResult({focusId:'osi-ai-layer'});});
    var reviewButton=document.getElementById('osi-ai-review-submit');
    if(reviewButton&&!reviewButton.disabled)reviewButton.addEventListener('click',review);
    var feedbackButton=document.getElementById('osi-ai-feedback-submit');
    if(feedbackButton&&!feedbackButton.disabled)feedbackButton.addEventListener('click',feedback);
    var approveButton=document.getElementById('osi-ai-approve');
    if(approveButton&&!approveButton.disabled)approveButton.addEventListener('click',approve);
  }
  function render(caseItem,capabilities,mode){
    state.loadToken++;
    var previousRef=caseRef();
    var nextRef=String(caseItem&&caseItem.public_ref||'');
    state.caseItem=caseItem;
    state.capabilities=mergeAiCapabilities({},capabilities||{});
    state.mode=mode||'public';
    state.result=null;
    state.versionRef='';
    state.layer='';
    state.busy=false;
    state.busyAction='';
    state.notices=Object.create(null);
    if(previousRef!==nextRef)state.operationKeys=Object.create(null);
    setTimeout(function(){
      if(nextRef===caseRef())reload();
    },0);
    return'<section class="osi-case-section"><div class="osi-section-heading"><div>'+
      '<span class="osi-eyebrow">Three evidence scopes</span><h3>AI Pack</h3></div>'+
      '<span class="osi-chip">Artifact, not verdict</span></div>'+
      '<div id="osi-ai-pack-root" aria-busy="true">'+loadingMarkup()+'</div>'+
      '<div class="osi-case-note">AI Pack content is model-generated and treated as untrusted text. It is never auto-published and never establishes truth, guilt, legal certainty, recovery, custody, or payment.</div></section>';
  }
  function clear(){
    state.loadToken++;
    state.caseItem=null;
    state.capabilities=null;
    state.result=null;
    state.versionRef='';
    state.layer='';
    state.busy=false;
    state.busyAction='';
    state.operationKeys=Object.create(null);
    state.notices=Object.create(null);
    var root=host();
    if(root){
      root.removeAttribute('aria-busy');
      if(typeof root.replaceChildren==='function')root.replaceChildren();
      else root.innerHTML='';
    }
  }

  window.osiV2AiPackRender=render;
  window.osiV2AiPackReload=reload;
  window.osiV2AiPackClear=clear;
  if(typeof window.osiV2RegisterPrivateCache==='function'){
    window.osiV2RegisterPrivateCache('ai-packs',clear);
  }
})();
