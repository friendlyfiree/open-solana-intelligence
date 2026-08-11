/* Native V2 Case lifecycle for the mature OSI root experience. */
(function(){
  'use strict';

  var READ_URL = SUPABASE_URL + '/functions/v1/osi-v2-case-read';
  var WRITE_URL = SUPABASE_URL + '/functions/v1/osi-v2-case-write';
  var GOVERNANCE_URL = SUPABASE_URL + '/functions/v1/osi-v2-governance-write';
  var PAYMENT_URL = SUPABASE_URL + '/functions/v1/osi-v2-payment';
  var AI_PACK_URL = SUPABASE_URL + '/functions/v1/osi-v2-ai-pack';
  var PAGE_SIZE = 12;
  var PAYMENT_RECOVERY_KEY = 'osi:v2:payment-recovery:1';
  var PAYMENT_RECOVERY_PREFIX = 'osi:v2:payment-recovery:2:';
  var state = {
    cases: [], challenges: [], mode: 'public', locked: null, actorRole: 'public', currentActorRole: '', query: '', stage: 'open_public',
    sort: 'newest', page: 1, loadToken: 0, drawerLoadToken: 0, current: null, tab: 'overview',
    capabilities: null, caseIdempotency: '', reviewBusy: false, reviewTasks: {},
    reviewLanes: {}, reviewUpdatedAt: null, reviewLoadToken: 0, caseReceipt: null,
    submissionReceipts: {},
    activeReviewTask: null,
    modalReturnFocus: null, drawerReturnFocus: null, drawerReturnHash: '', governanceBusy: false,
    paymentBusy: false, paymentPending: null, paymentWallet: '', paymentCleanup: null,
    challengeTimer: 0
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
  function t(key,variables){
    return typeof window.osiT==='function'?window.osiT(key,variables):String(key||'').replace(/\{([a-zA-Z0-9_]+)\}/g,function(_,name){return variables&&Object.prototype.hasOwnProperty.call(variables,name)?String(variables[name]):'{'+name+'}';});
  }
  function fallbackCopyText(value){
    return new Promise(function(resolve){
      var field=document.createElement('textarea');field.value=String(value||'');field.setAttribute('readonly','');field.style.position='fixed';field.style.opacity='0';document.body.appendChild(field);field.select();
      var copied=false;try{copied=document.execCommand('copy');}catch(_){}
      field.remove();resolve(copied);
    });
  }
  function copyText(value){
    value=String(value||'');
    if(typeof window.osiCopyText==='function')return Promise.resolve(window.osiCopyText(value)).then(function(result){return result===true;}).catch(function(){return fallbackCopyText(value);});
    if(navigator.clipboard&&typeof navigator.clipboard.writeText==='function')return navigator.clipboard.writeText(value).then(function(){return true;}).catch(function(){return fallbackCopyText(value);});
    return fallbackCopyText(value);
  }
  // ---------------------------------------------------------------------
  // Structured reference rendering.
  //
  // Addresses, transaction signatures and links are the substance of an OSI
  // record, not decoration. They render in their own labelled sections, in
  // monospace, truncated for layout but never for the clipboard: the full exact
  // value is always what gets copied and what a screen reader announces.
  // ---------------------------------------------------------------------
  var EVIDENCE_SECTION_ORDER=[
    ['wallets','Wallet Addresses'],
    ['transactions','Transactions'],
    ['links','Evidence and Sources'],
    ['other','Additional References']
  ];
  // Older projections carry only the flat evidence array. Grouping the same way
  // the server does keeps a pre-upgrade response readable instead of empty.
  function evidenceSectionsOf(item){
    if(item&&item.evidence_sections&&typeof item.evidence_sections==='object')return item.evidence_sections;
    var rows=(item&&item.evidence)||[];
    var kindOf=function(row){
      var kind=String(row&&row.kind||'').trim();
      if(kind==='wallet'||kind==='onchain_tx'||kind==='url')return kind;
      var ref=String(row&&row.ref||'').trim();
      if(/^https:\/\//i.test(ref))return'url';
      if(/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(ref))return'onchain_tx';
      if(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ref))return'wallet';
      return kind||'other';
    };
    var pick=function(kind){return rows.filter(function(row){return kindOf(row)===kind;});};
    var sections={
      wallets:pick('wallet'),transactions:pick('onchain_tx'),links:pick('url'),
      other:rows.filter(function(row){return['wallet','onchain_tx','url'].indexOf(kindOf(row))<0;})
    };
    sections.networks=sections.wallets.length||sections.transactions.length?['Solana mainnet-beta']:[];
    return sections;
  }
  function safeExternalUrl(value){
    var url=String(value||'');
    return /^https:\/\/[^\s"'<>]+$/.test(url)?url:'';
  }
  function submitterIdentity(item,interactive){
    var profile=item&&item.submitter_profile&&typeof item.submitter_profile==='object'?item.submitter_profile:null;
    var publicRef=profile&&/^OSI-PRF-[A-F0-9]{16}$/.test(String(profile.public_ref||''))?String(profile.public_ref):'';
    var displayName=profile&&(String(profile.display_name||'').trim()||(profile.handle?'@'+String(profile.handle).trim():''));
    var name=displayName||t('Community submitter');
    var avatarUrl=String(profile&&profile.avatar_url||'');
    var trustedPrefix=SUPABASE_URL+'/storage/v1/object/public/osi-profile-avatars/';
    if(avatarUrl.indexOf(trustedPrefix)!==0)avatarUrl='';
    var image=avatarUrl
      ?'<img class="osi-case-submitter-avatar" src="'+esc(avatarUrl)+'" alt="" width="26" height="26">'
      :'<span class="osi-case-submitter-avatar fallback" aria-hidden="true">'+esc((name.charAt(0)||'C').toUpperCase())+'</span>';
    var body=image+'<span class="osi-case-submitter-copy"><small>'+esc(t('Case submitter'))+'</small><b data-osi-user-content>'+esc(name)+'</b></span>';
    if(interactive&&publicRef)return'<button class="osi-case-submitter osi-case-submitter-detail" type="button" data-public-wallet-profile="'+esc(publicRef)+'" aria-label="'+esc(t('Open public profile for {name}',{name:name}))+'">'+body+'</button>';
    return'<span class="osi-case-submitter'+(interactive?' osi-case-submitter-detail':'')+'">'+body+'</span>';
  }
  // One reference row. The visible text is elided so a 88-character signature
  // cannot push the drawer sideways on a phone; the title, the copy button and
  // the link all carry the exact untruncated value.
  function referenceRow(row){
    var ref=String(row&&row.ref||'');
    var link=safeExternalUrl(row&&row.link_url);
    var meta=[];
    if(row&&row.network)meta.push(String(row.network));
    if(row&&row.sha256)meta.push('sha256 '+short(String(row.sha256)));
    if(row&&row.ordinal)meta.unshift('#'+String(row.ordinal));
    return'<li class="osi-ref-item">'
      +'<div class="osi-ref-value mono" data-osi-user-content title="'+esc(ref)+'">'+esc(ref)+'</div>'
      +(meta.length?'<div class="osi-ref-meta">'+esc(meta.join(' · '))+'</div>':'')
      +'<div class="osi-ref-actions">'
      +'<button class="osi-ref-copy" type="button" data-osi-copy="'+esc(ref)+'">'+esc(t('Copy'))+'</button>'
      +(link?'<a class="osi-ref-link" href="'+esc(link)+'" target="_blank" rel="noopener noreferrer">'+esc(t('Open'))+'</a>':'')
      +'</div></li>';
  }
  // Empty groups produce no markup at all, so a Case with only links never
  // shows an empty "Wallet Addresses" box.
  function evidenceSectionsHtml(item,options){
    options=options||{};
    var sections=evidenceSectionsOf(item);
    var blocks=EVIDENCE_SECTION_ORDER.map(function(entry){
      var rows=sections[entry[0]]||[];
      if(!rows.length)return'';
      return'<section class="osi-ref-group"><h4>'+esc(t(entry[1]))+' <span class="osi-ref-count">'+rows.length+'</span></h4>'
        +'<ul class="osi-ref-list">'+rows.map(referenceRow).join('')+'</ul></section>';
    }).filter(Boolean);
    var networks=sections.networks||[];
    if(networks.length){
      blocks.unshift('<section class="osi-ref-group"><h4>'+esc(t('Networks'))+'</h4><ul class="osi-ref-list plain">'
        +networks.map(function(network){return'<li class="osi-ref-item"><div class="osi-ref-value mono">'+esc(network)+'</div></li>';}).join('')
        +'</ul></section>');
    }
    if(!blocks.length)return options.emptyHtml||'';
    return'<div class="osi-ref-sections">'+blocks.join('')+'</div>';
  }
  window.osiV2EvidenceSectionsHtml=evidenceSectionsHtml;
  // Copy buttons are delegated once so every re-render keeps working without
  // rebinding, and the exact value travels in the data attribute rather than in
  // an inline handler.
  // An attributed reviewer opens their public analyst profile, so a governance
  // decision leads to the record of who made it. Delegated once, so every
  // re-render keeps working.
  document.addEventListener('click',function(event){
    var actor=event.target&&event.target.closest?event.target.closest('[data-analyst-profile]'):null;
    if(!actor)return;
    var wallet=actor.getAttribute('data-analyst-profile')||'';
    if(wallet&&typeof window.openAnalystProfile==='function')window.openAnalystProfile(wallet);
  });
  document.addEventListener('click',function(event){
    var profile=event.target&&event.target.closest?event.target.closest('[data-public-wallet-profile]'):null;
    if(!profile)return;
    var publicRef=profile.getAttribute('data-public-wallet-profile')||'';
    if(publicRef&&typeof window.osiV2OpenPublicProfile==='function')window.osiV2OpenPublicProfile(publicRef);
  });
  document.addEventListener('click',function(event){
    var button=event.target&&event.target.closest?event.target.closest('[data-osi-copy]'):null;
    if(!button)return;
    var value=button.getAttribute('data-osi-copy')||'';
    var original=button.textContent;
    copyText(value).then(function(copied){
      button.textContent=copied?t('Copied'):t('Select to copy');
      setTimeout(function(){button.textContent=original;},1600);
    });
  });
  // ---------------------------------------------------------------------
  // Long-form field counters.
  //
  // A raised maxlength is still a silent truncation the moment someone pastes
  // a finished research note into it: the browser keeps the prefix and drops
  // the rest with no message at all. The counter states the exact remaining
  // budget, and an over-length paste is refused outright with the exact
  // numbers rather than quietly clipped, so nothing a contributor wrote can
  // disappear between the clipboard and the request.
  // ---------------------------------------------------------------------
  function counterNodes(){
    return Array.prototype.slice.call(document.querySelectorAll('[data-osi-counter-for]'));
  }
  function paintCounter(node,field){
    var limit=Number(field.getAttribute('maxlength')||0);
    var used=String(field.value||'').length;
    if(!limit){node.textContent='';return;}
    node.textContent=t('{used} of {limit} characters',{used:used.toLocaleString(),limit:limit.toLocaleString()});
    node.classList.toggle('near-limit',used>=limit*0.9);
  }
  function bindLongFormCounters(){
    counterNodes().forEach(function(node){
      if(node.getAttribute('data-osi-counter-bound')==='true')return;
      var field=document.getElementById(node.getAttribute('data-osi-counter-for')||'');
      if(!field)return;
      node.setAttribute('data-osi-counter-bound','true');
      var repaint=function(){paintCounter(node,field);};
      field.addEventListener('input',repaint);
      field.addEventListener('paste',function(event){
        var limit=Number(field.getAttribute('maxlength')||0);
        if(!limit||!event.clipboardData)return;
        var pasted=String(event.clipboardData.getData('text')||'');
        var selected=Math.abs(Number(field.selectionEnd||0)-Number(field.selectionStart||0));
        var next=String(field.value||'').length-selected+pasted.length;
        if(next<=limit)return;
        event.preventDefault();
        node.textContent=t(
          'Not inserted. That paste would make this field {next} characters and the limit is {limit}. Shorten it or split it across the structured sections; nothing was truncated.',
          {next:next.toLocaleString(),limit:limit.toLocaleString()}
        );
        node.classList.add('over-limit');
        setTimeout(function(){node.classList.remove('over-limit');repaint();},6000);
      });
      repaint();
    });
  }
  window.osiV2BindLongFormCounters=bindLongFormCounters;
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',bindLongFormCounters);
  }else{
    bindLongFormCounters();
  }

  function clearSubmissionReceipt(hostId){
    delete state.submissionReceipts[hostId];
    var host=document.getElementById(hostId);if(!host)return;
    host.hidden=true;host.innerHTML='';
  }
  function renderSubmissionReceipt(hostId,options,focusReceipt){
    var host=document.getElementById(hostId);if(!host)return null;options=options||{};
    state.submissionReceipts[hostId]=options;
    var exact=[options.publicRef,options.versionRef].filter(Boolean).join(' / ');
    host.innerHTML='<div class="osi-receipt-head"><div><span>'+esc(t('Saved successfully'))+'</span><h3>'+esc(t(options.title||'Submission saved'))+'</h3></div><div class="osi-receipt-ref">'+esc(exact)+'</div></div>'
      +'<dl class="osi-receipt-grid"><div><dt>'+esc(t('Current stage'))+'</dt><dd>'+esc(t(options.stage||'Submitted'))+'</dd></div><div><dt>'+esc(t('Visibility'))+'</dt><dd>'+esc(t(options.visibility||'Private'))+'</dd></div>'
      +'<div class="wide"><dt>'+esc(t('Where to find it'))+'</dt><dd>'+esc(t(options.where||''))+'</dd></div><div class="wide"><dt>'+esc(t('Who can review it'))+'</dt><dd>'+esc(t(options.reviewers||''))+'</dd></div><div class="wide"><dt>'+esc(t('What happens next'))+'</dt><dd>'+esc(t(options.next||''))+'</dd></div></dl>'
      +'<div class="osi-receipt-copy-state" data-receipt-copy-state aria-live="polite"></div><div class="osi-receipt-actions"><button class="osi-action" type="button" data-receipt-copy>'+esc(t('Copy reference'))+'</button>'
      +(typeof options.onOpen==='function'?'<button class="osi-action primary" type="button" data-receipt-open>'+esc(t(options.openLabel||'Open workspace'))+'</button>':'')
      +(options.canOpenQueue&&typeof options.onQueue==='function'?'<button class="osi-action" type="button" data-receipt-queue>'+esc(t('Open review queue'))+'</button>':'')
      +(typeof options.onDismiss==='function'?'<button class="osi-action" type="button" data-receipt-dismiss>'+esc(t('Done'))+'</button>':'')+'</div>';
    host.hidden=false;
    var copy=host.querySelector('[data-receipt-copy]');if(copy)copy.addEventListener('click',async function(){
      var copied=await copyText(options.copyValue||options.publicRef||options.versionRef||'');var node=host.querySelector('[data-receipt-copy-state]');if(node)node.textContent=copied?t('Reference copied.'):t('Copy unavailable. Select the reference above.');
    });
    var open=host.querySelector('[data-receipt-open]');if(open)open.addEventListener('click',options.onOpen);
    var queue=host.querySelector('[data-receipt-queue]');if(queue)queue.addEventListener('click',options.onQueue);
    var dismiss=host.querySelector('[data-receipt-dismiss]');if(dismiss)dismiss.addEventListener('click',options.onDismiss);
    if(focusReceipt!==false)setTimeout(function(){host.focus();},0);return host;
  }
  function sasSlot(wallet,role){
    role=String(role||'').toLowerCase();
    if(['analyst','verified_analyst','senior_analyst','probationary_analyst'].indexOf(role)<0)return'';
    return'<span data-sas-wallet="'+esc(wallet)+'" data-sas-role="'+esc(role)+'"></span>';
  }
  function sasAuthority(review){
    var a=review&&review.sas_authority;
    if(!a||a.enforced!==true)return'';
    if(a.counted===true)return' <span class="osi-proof-label" data-sas-authority="counted">Authority verified on Solana</span>';
    var pending=String(a.state||'')==='pending_verification';
    return' <span class="osi-chip warning" data-sas-authority="excluded">'+
      (pending?'Not counted: SAS credential not confirmed':'Not counted: no valid SAS credential')+'</span>';
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
      initial_rejected:'Initial review rejected',
      open_public:'Public investigation',in_review:'Reports under review',
      ready_for_finalization:'Resolution selection',resolution_proposed:'Resolution selection',
      in_challenge_window:'Challenge window',resolved:'Seal ready',sealed:'Sealed',
      reopened:'Resolution selection'})[value]||label(value);
  }
  function dateText(value){
    var date=new Date(value||'');
    var selected=window.OSI_I18N&&typeof window.OSI_I18N.getLocale==='function'
      ?window.OSI_I18N.getLocale():(typeof document!=='undefined'&&document.documentElement?document.documentElement.lang:'');
    var locale=String(selected||'en').toLowerCase()==='tr'?'tr-TR':'en-US';
    return isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleString(locale,{dateStyle:'medium',timeStyle:'short'});
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
    if(item.stage==='initial_rejected')return'The owner may appeal once new evidence is ready. The original submission and rejection proof remain immutable.';
    if(item.visibility==='private')return'Await an eligible analyst or full double-gated maintainer initial-open review, or the independent normal-rejection quorum.';
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
  function privateGeneration(){return typeof window.osiV2PrivateCacheGeneration==='function'?window.osiV2PrivateCacheGeneration():0;}
  function assertPrivateGeneration(generation){if(generation!==privateGeneration())throw new Error('private_session_changed');}
  function headers(){
    var token=(typeof SUPA_AUTH_TOKEN==='string'&&SUPA_AUTH_TOKEN)?SUPA_AUTH_TOKEN:SUPABASE_ANON_KEY;
    return {'Content-Type':'application/json','apikey':SUPABASE_ANON_KEY,'Authorization':'Bearer '+token};
  }
  // Public projections go through the shared reader (single flight plus a
  // short list cache); everything wallet-bound or authorized keeps its own
  // direct request and is never cached.
  function publicRead(body,options){
    if(typeof window.osiPublicRead==='function')return window.osiPublicRead('osi-v2-case-read',body,options);
    return api(READ_URL,body);
  }
  // Ops that only read state. Anything else may change a public projection,
  // so the shared public cache is dropped after it succeeds and the next
  // read comes from the server.
  var NON_MUTATING_OPS={
    actor_capabilities:1,capabilities:1,issue_read_challenge:1,
    issue_read_session_challenge:1,create_read_session:1,renew_read_session:1,
    list_public_cases:1,get_public_case:1,list_my_cases:1,
    list_reviewable_cases:1,get_authorized_case:1,maintainer_case_overview:1
  };
  async function api(url,body){
    var response=await fetch(url,{method:'POST',headers:headers(),body:JSON.stringify(body)});
    var payload={};
    try{payload=await response.json();}catch(error){payload={ok:false,error:'invalid_server_response'};}
    if(!response.ok||payload.ok!==true){
      var failure=new Error(payload.error||('request_failed_'+response.status));
      failure.status=response.status;
      throw failure;
    }
    if(NON_MUTATING_OPS[body&&body.op]!==1&&typeof window.osiPublicReadInvalidate==='function'){
      window.osiPublicReadInvalidate();
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
      ,analyst_required:'Normal Case rejection requires an eligible analyst. Maintainer authority cannot replace this quorum.'
      ,owner_required:'Only the Case owner can submit this appeal.'
      ,not_found_or_not_appealable:'This Case is no longer in the exact rejected state required for an appeal.'
      ,appeal_requires_new_evidence:'Add one new evidence reference before appealing.'
      ,read_failed:'The public Case registry could not be loaded. Retry when the service is available.'
      // One message for both cases on purpose: an anonymous caller must not be
      // able to tell a missing Case apart from a private one.
      ,not_found_or_private:'This Case reference is not available in the public registry.'
      ,bad_public_ref:'That Case reference is not a valid public reference.'
      ,read_session_disabled_or_unavailable:'Private read sessions are safely disabled or temporarily unavailable.'
      ,read_session_required:'Unlock private views with one wallet signature.'
      ,read_session_scope_denied:'This view is open to verified analysts, and this wallet does not hold that standing yet. Nothing is wrong with your session: the surfaces your wallet can reach stay open, and no further signature will be asked for this one.'
      ,read_session_expired:'Your private working session genuinely lapsed. Sign once to unlock a new bounded session; typed drafts stay in this browser tab.'
      ,read_session_wrong_origin:'This private session belongs to a different site origin.'
      ,read_session_wrong_wallet:'This private session belongs to a different wallet.'
      ,read_session_wrong_scope:'Refresh private access explicitly for this role.'
      ,read_session_tampered:'The private session token failed server verification.'
      ,private_session_changed:'Private access changed while this action was running. Reopen the exact task.'
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
      ,solana_pay_disabled_or_unavailable:'Solana Pay is safely unavailable. Use the reviewed Phantom route for this exact intent.'
      ,unknown_solana_pay_reference:'This Solana Pay reference is unknown or does not belong to the connected payer.'
      ,solana_pay_intent_expired:'The single-use Solana Pay request expired. No payment was recorded.'
      ,solana_pay_binding_invalid:'The finalized transaction did not contain the exact bound Solana Pay reference.'
      ,solana_pay_reference_not_readonly:'The Solana Pay reference was not attached as the required read-only non-signer account.'
      ,solana_pay_memo_position_invalid:'The canonical Memo was not immediately before the Solana Pay transfer.'
      ,solana_pay_transfer_binding_mismatch:'The finalized Solana Pay transfer does not match the exact payer, recipient, amount, and reference.'
      ,solana_pay_reference_reused:'The reference appeared outside the one exact transfer instruction.'
      ,payment_wallet_changed:'The connected payer changed. No wallet was opened; review the transfer again from the intended wallet.'
      ,payment_recovery_unavailable:'This browser cannot durably save the wallet-bound recovery record. No wallet was opened.'
      ,payment_recovery_poll_only:'A restored payment record can only be checked against the server. It cannot reopen a wallet or construct a transfer.'
    };
    if(messages[code])return messages[code];
    // A wallet failure carries free text or a numeric provider code, never a
    // server code, so the step that opens Phantom explains itself instead of
    // printing a raw provider string.
    var walletDetail=typeof walletErrorDetail==='function'?walletErrorDetail(error):'';
    if(walletDetail)return walletDetail;
    return code.replace(/_/g,' ');
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
    var generation=privateGeneration();
    var result=await api(READ_URL,Object.assign({op:op,wallet:session.wallet,read_session:session.token},extra||{}));
    assertPrivateGeneration(generation);return result;
  }
  // One shared active marker for the Field Office rail and its mobile tab row,
  // so the highlighted item always matches the surface actually rendered.
  function setFieldRailActive(key){
    Array.prototype.forEach.call(document.querySelectorAll('[data-fo-nav]'),function(node){
      var active=node.getAttribute('data-fo-nav')===String(key||'');
      node.classList.toggle('active',active);
      if(active)node.setAttribute('aria-current','true');else node.removeAttribute('aria-current');
    });
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
    }else if(mode==='challenges'){
      if(eyebrow) eyebrow.textContent=t('Private challenger workspace');
      if(title) title.textContent=t('My Challenges');
      if(sub) sub.textContent=t('Your own challenge state, exact target, deadlines, and available next action.');
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
  var reviewLaneDefinitions=[
    ['initial_open','Case initial reviews','case'],
    ['report_publication','Report publication reviews','report'],
    ['analyst_applications','Analyst applications','application'],
    ['wire_reviews','Wire reviews','wire'],
    ['resolution_selection','Resolution selection','case'],
    ['challenge_admissibility','Challenge admissibility','case'],
    ['challenge_adjudication','Challenge adjudication','case'],
    ['seal_reviews','Seal reviews','case']
  ];
  // The Field Office toolbar searches, filters and sorts the public Case list,
  // and the head row labels that list's columns. Both belong to the Case list
  // and to nothing else. A surface that renders something other than Cases
  // into #field-cases (the review queue, the Report workspace) passes true, so
  // the Case controls are not left standing above content they cannot act on.
  function setReviewChrome(active){
    var toolbar=document.querySelector('#field-view .fo-toolbar'),head=document.querySelector('#field-view .fq-head');
    if(toolbar)toolbar.hidden=active;if(head)head.hidden=active;
  }
  function resetReviewLanes(){
    state.reviewLanes={};
    reviewLaneDefinitions.forEach(function(definition){state.reviewLanes[definition[0]]={status:'loading',tasks:[],error:'',updatedAt:null};});
    state.reviewUpdatedAt=null;
  }
  function updateReviewLane(id,status,tasks,error,errorCode){
    state.reviewLanes[id]={status:status,tasks:Array.isArray(tasks)?tasks:[],error:error||'',errorCode:errorCode||'',updatedAt:new Date().toISOString()};
    var host=document.getElementById('field-cases');if(host&&state.mode==='review')drawReviewTasks(host);
  }
  function taskValue(task,names,fallback){
    for(var index=0;index<names.length;index++){if(task&&task[names[index]]!=null&&task[names[index]]!=='')return task[names[index]];}
    return fallback;
  }
  function normalizeReviewTask(lane,row,kind){
    row=row||{};var exact=taskValue(row,['exact_target','version_public_ref','version_ref','current_version_ref','target_ref','public_ref','id'],'');
    var publicRef=taskValue(row,['public_ref','report_public_ref','wire_report_public_ref','case_ref','case_public_ref','version_ref'],exact);
    return{
      lane:lane,targetKind:row.target_kind||kind,publicRef:String(publicRef||''),caseRef:String(taskValue(row,['case_ref','case_public_ref'],'')||''),
      exactTarget:String(exact||''),stage:String(taskValue(row,['stage','lifecycle_state','status'],'submitted')||'submitted'),
      routeTarget:String(taskValue(row,['route_target','application_id'],exact)||''),
      conflict:taskValue(row,['submitter_conflict','conflict'],false)===true,
      nextAction:String(taskValue(row,['next_action','prerequisite'],'Open the exact authorized task')||'Open the exact authorized task'),
      nextActionCode:String(taskValue(row,['next_action_code'],'')||''),
      finalizationCapability:row.finalization_capability||null,
      deadline:taskValue(row,['deadline','deadline_at','review_deadline_at','admissibility_deadline_at'],null),
      currentVote:taskValue(row,['current_vote','current_active_vote'],null),
      weight:taskValue(row,['weight_snapshot','weight'],null)
    };
  }
  function activeTaskConflict(lane,exactTarget){
    var task=state.activeReviewTask;
    if(!task||task.conflict!==true||!activeTaskMatches(lane,exactTarget))return false;
    return true;
  }
  function activeTaskMatches(lane,exactTarget){
    var task=state.activeReviewTask;
    if(!task||String(task.lane||'')!==String(lane||''))return false;
    if(!task.exactTarget)return false;
    return !exactTarget||String(task.exactTarget)===String(exactTarget);
  }
  function conflictMessage(){
    return t('This wallet is excluded from the exact task by a server-derived conflict rule.');
  }
  function reviewTaskRequiredMessage(){
    return t('Open the exact server-authorized task from My Reviews to act. Direct Case views are read-only.');
  }
  function requireActiveReviewTask(lane,exactTarget){
    if(activeTaskMatches(lane,exactTarget)&&!activeTaskConflict(lane,exactTarget))return true;
    showToast(activeTaskConflict(lane,exactTarget)?conflictMessage():reviewTaskRequiredMessage());
    return false;
  }
  function reportReviewTasks(result){
    return (result&&result.reports||[]).map(function(report){
      var versions=(report.versions||[]).slice().sort(function(a,b){return Number(b.version_no)-Number(a.version_no);});
      var version=versions.find(function(row){return row.version_ref===report.current_version_ref;})||versions[0]||{};
      var bootstrap=report.can_publish_via_maintainer_bootstrap===true||version.can_publish_via_maintainer_bootstrap===true;
      var standard=report.can_publish_via_standard_quorum===true||version.can_publish_via_standard_quorum===true;
      var analyst=report.can_cast_analyst_review===true||version.can_cast_analyst_review===true;
      return normalizeReviewTask('report_publication',{
        target_kind:'report',case_public_ref:report.case_public_ref,report_public_ref:report.report_public_ref,
        version_ref:version.version_ref||report.current_version_ref,lifecycle_state:version.lifecycle_state,
        submitter_conflict:report.submitter_conflict===true,
        next_action:bootstrap?'Publish via maintainer bootstrap':standard?'Publish exact Report version from completed analyst quorum':analyst?'Review exact immutable Report version':'Inspect publication prerequisites',
        deadline_at:version.review_deadline_at,current_active_vote:version.my_active_review&&version.my_active_review.decision,
        weight_snapshot:version.my_active_review&&version.my_active_review.weight
      },'report');
    });
  }
  function applicationReviewTasks(result){
    return (result&&result.applications||[]).map(function(application){
      var version=application.version||(application.versions||[])[0]||{};
      return normalizeReviewTask('analyst_applications',{
        target_kind:'application',public_ref:version.version_ref||application.public_ref||application.id,
        exact_target:version.version_ref,route_target:application.id,stage:application.status,submitter_conflict:application.submitter_conflict===true,
        next_action:application.status==='revision_requested'?'Await applicant revision':'Review exact analyst application version',
        deadline_at:application.review_deadline_at
      },'application');
    }).filter(function(task){return !!task.exactTarget&&!!task.routeTarget;});
  }
  function wireReviewTasks(result){
    return (result&&result.reports||[]).map(function(report){
      return normalizeReviewTask('wire_reviews',{
        target_kind:'wire',public_ref:report.wire_report_public_ref,version_public_ref:report.version_public_ref,
        lifecycle_state:report.lifecycle_state,submitter_conflict:report.submitter_conflict===true,
        next_action:report.can_publish_via_maintainer_bootstrap===true?'Publish Wire via maintainer bootstrap':'Review exact Wire version',
        deadline_at:report.review_deadline_at,current_active_vote:report.my_active_review&&report.my_active_review.decision,
        weight_snapshot:report.my_active_review&&report.my_active_review.weight
      },'wire');
    });
  }
  function laneStateMarkup(lane){
    if(lane.status==='loading')return'<div class="osi-review-lane-state" role="status"><span>'+esc(t('Loading authorized tasks...'))+'</span></div>';
    if(lane.status==='unauthorized')return'<div class="osi-review-lane-state"><span>'+esc(lane.error||t('This lane is not available to the current role.'))+'</span></div>';
    if(lane.status==='error'){var refresh=/^read_session_(expired|wrong_scope)$/.test(String(lane.errorCode||''));return'<div class="osi-review-lane-state error" role="alert"><span>'+esc(lane.error||t('This lane could not be loaded.'))+'</span><button class="osi-action" type="button" data-review-lane-retry>'+esc(t(refresh?'Refresh private access':'Try again'))+'</button></div>';}
    return'<div class="osi-review-lane-empty">'+esc(t('No authorized tasks in this lane.'))+'</div>';
  }
  function reviewLaneError(error){
    var code=String(error&&error.message||'');
    return code==='read_failed'||/^request_failed(?:_|$)/.test(code)?'':userError(error);
  }
  // A lane can be refused for a reason the server names with a code. Turn the
  // known codes into the same plain sentences the rest of the queue uses, and
  // fall back to the generic authorization sentence for anything unknown.
  function laneReasonMessage(reason){
    var code=String(reason||'');
    if(!code)return t('This lane is not available to the current role.');
    var known={
      full_maintainer_required:t('Both maintainer gates are required for this lane. Connect the configured admin wallet and sign in from the Operations Center.'),
      analyst_required:t('This lane requires an eligible server-derived analyst.'),
      not_eligible_reviewer:t('This wallet is not an eligible V2 analyst and does not have full maintainer access.'),
      analyst_writes_disabled:t('Analyst application review is safely disabled while rollout checks are incomplete.')
    };
    if(known[code])return known[code];
    // An unmapped code is still a code. Show the neutral sentence instead.
    return /^[a-z0-9_]+$/.test(code)?t('This lane is not available to the current role.'):code;
  }
  function reviewTaskMarkup(task){
    return'<button class="osi-review-task" type="button" data-review-kind="'+esc(task.targetKind)+'" data-review-target="'+esc(task.exactTarget)+'" data-review-route="'+esc(task.routeTarget||task.exactTarget)+'" data-review-lane="'+esc(task.lane)+'" data-case-ref="'+esc(task.caseRef)+'"><div><span>'+esc(task.publicRef)+'</span>'+(task.exactTarget&&task.exactTarget!==task.publicRef?'<span>'+esc(task.exactTarget)+'</span>':'')+'<b>'+esc(t(task.nextAction))+'</b></div><dl>'
      +'<div><dt>'+esc(t('Stage'))+'</dt><dd>'+esc(t(label(task.stage)))+'</dd></div><div><dt>'+esc(t('Deadline'))+'</dt><dd>'+esc(task.deadline?dateText(task.deadline):t('No separate deadline'))+'</dd></div><div><dt>'+esc(t('Conflict'))+'</dt><dd class="'+(task.conflict?'warn':'ok')+'">'+esc(task.conflict?t('Excluded'):t('Clear'))+'</dd></div>'
      +'<div><dt>'+esc(t('Current vote'))+'</dt><dd>'+esc(task.currentVote?t(label(task.currentVote)):t('None'))+'</dd></div><div><dt>'+esc(t('Weight'))+'</dt><dd>'+esc(task.weight==null?t('Not counted'):Number(task.weight).toFixed(2))+'</dd></div><div><dt>'+esc(t('Target'))+'</dt><dd>'+esc(t(label(task.targetKind)))+'</dd></div></dl></button>';
  }
  function drawReviewTasks(host){
    var total=reviewLaneDefinitions.reduce(function(sum,definition){var lane=state.reviewLanes[definition[0]]||{};return sum+(lane.status==='success'?(lane.tasks||[]).length:0);},0);
    var updated=state.reviewUpdatedAt?dateText(state.reviewUpdatedAt):t('Refresh in progress');
    host.innerHTML='<div class="osi-review-queue-tools"><div><p>'+esc(t('One queue, eight server-authorized lanes. Errors never become empty results.'))+'</p><time>'+esc(t('Last refreshed: {time}',{time:updated}))+'</time></div><button class="osi-action" type="button" data-review-refresh>'+esc(t('Refresh queue'))+'</button></div><div class="osi-review-lanes">'+reviewLaneDefinitions.map(function(definition){
      var lane=state.reviewLanes[definition[0]]||{status:'loading',tasks:[]},tasks=lane.tasks||[];
      var count=lane.status==='success'?String(tasks.length):lane.status==='loading'?'…':'-';
      return'<section class="osi-review-lane" data-review-lane-section="'+esc(definition[0])+'"><header><h3>'+esc(t(definition[1]))+'</h3><span>'+esc(count)+'</span></header>'+(lane.status==='success'&&tasks.length?tasks.map(reviewTaskMarkup).join(''):laneStateMarkup(lane))+'</section>';
    }).join('')+'</div>';
    var refresh=host.querySelector('[data-review-refresh]');if(refresh)refresh.addEventListener('click',loadUnifiedReviewQueue);
    Array.prototype.forEach.call(host.querySelectorAll('[data-review-lane-retry]'),function(button){button.addEventListener('click',function(){var section=button.closest('[data-review-lane-section]');if(section)retryReviewLane(section.getAttribute('data-review-lane-section'));});});
    Array.prototype.forEach.call(host.querySelectorAll('[data-review-kind]'),function(button){button.addEventListener('click',function(){
      var laneId=button.getAttribute('data-review-lane'),target=button.getAttribute('data-review-target');
      var lane=state.reviewLanes[laneId]||{},task=(lane.tasks||[]).find(function(row){return String(row.exactTarget)===String(target);});
      openReviewTask(task||{targetKind:button.getAttribute('data-review-kind'),exactTarget:target,routeTarget:button.getAttribute('data-review-route'),lane:laneId,caseRef:button.getAttribute('data-case-ref'),conflict:false});
    });});
    var count=document.getElementById('fo-count');if(count)count.textContent=total+' real '+(total===1?'task':'tasks');
    var nav=document.getElementById('fo-pnav');if(nav)nav.innerHTML='';
    var stats=document.getElementById('field-stats');if(stats){
      var loaded=reviewLaneDefinitions.filter(function(definition){return (state.reviewLanes[definition[0]]||{}).status==='success';}).length;
      var errors=reviewLaneDefinitions.filter(function(definition){return (state.reviewLanes[definition[0]]||{}).status==='error';}).length;
      stats.innerHTML='<div class="osi-stat"><span>'+esc(t('Authorized tasks'))+'</span><b>'+total+'</b></div><div class="osi-stat"><span>'+esc(t('Loaded lanes'))+'</span><b>'+loaded+' / '+reviewLaneDefinitions.length+'</b></div><div class="osi-stat"><span>'+esc(t('Lane errors'))+'</span><b>'+errors+'</b></div>';
    }
    var deck=document.getElementById('fo-deck');if(deck)deck.hidden=true;
  }
  // A navigation click into a private workspace never touches the wallet API.
  // The user has to ask for it with an explicit, clearly labelled action.
  var workspaceLockCopy={
    mine:{
      title:'My Cases is a private workspace',
      body:'Your own Cases stay private. Public Cases and published Reports are readable here without a wallet.',
      cta:'Connect wallet and authorize private read'
    },
    review:{
      title:'My Reviews is an authorized workspace',
      body:'Review tasks are limited to eligible analysts and full maintainers. Public Cases and published Reports are readable here without a wallet.',
      cta:'Connect wallet and authorize review access'
    },
    challenges:{
      title:'My Challenges is a private workspace',
      body:'Only the connected challenger wallet can read its restricted detail and active deadlines.',
      cta:'Connect wallet and authorize challenge history'
    }
  };
  function drawWorkspaceLock(host,mode){
    var copy=workspaceLockCopy[mode]||workspaceLockCopy.mine;
    // Public registry counters must not sit under a private workspace heading.
    var stats=document.getElementById('field-stats');if(stats)stats.innerHTML='';
    var count=document.getElementById('fo-count');if(count)count.textContent='';
    var nav=document.getElementById('fo-pnav');if(nav)nav.innerHTML='';
    var deck=document.getElementById('fo-deck');if(deck)deck.hidden=true;
    host.innerHTML='<div class="osi-workspace-lock" data-workspace-lock="'+esc(mode)+'">'
      +'<b>'+esc(t(copy.title))+'</b>'
      +'<span>'+esc(t(copy.body))+'</span>'
      +'<button class="osi-action" type="button" data-workspace-unlock="'+esc(mode)+'">'+esc(t(copy.cta))+'</button>'
      +'<small>'+esc(t('One wallet message signature. No Solana transaction, no transfer, and no network fee.'))+'</small>'
      +'</div>';
    var button=host.querySelector('[data-workspace-unlock]');
    if(button)button.addEventListener('click',function(){
      if(mode==='challenges')openMyChallenges({authorize:true});
      else openSignedCollection(mode,{authorize:true});
    });
  }

  function challengeDeadline(row){
    if(row.state==='submitted'||row.state==='admissibility_review')return row.admissibility_deadline_at;
    if(row.state==='open'||row.state==='under_review')return row.review_deadline_at;
    return row.terminal_at;
  }
  function challengeCountdown(value){
    var target=new Date(value||'').getTime();if(!Number.isFinite(target))return t('No active deadline');
    var remaining=target-Date.now();if(remaining<=0)return t('Deadline reached; refresh for server state.');
    var minutes=Math.max(1,Math.ceil(remaining/60000)),days=Math.floor(minutes/1440),hours=Math.floor((minutes%1440)/60),mins=minutes%60;
    if(days)return t('{days}d {hours}h remaining',{days:days,hours:hours});
    if(hours)return t('{hours}h {minutes}m remaining',{hours:hours,minutes:mins});
    return t('{minutes}m remaining',{minutes:mins});
  }
  function updateChallengeCountdowns(){
    if(state.mode!=='challenges'){clearInterval(state.challengeTimer);state.challengeTimer=0;return;}
    Array.prototype.forEach.call(document.querySelectorAll('[data-my-challenge-deadline]'),function(node){
      node.textContent=challengeCountdown(node.getAttribute('datetime'));
    });
  }
  function drawMyChallenges(){
    var host=document.getElementById('field-cases');if(!host)return;
    var rows=state.challenges||[];
    if(!rows.length){host.innerHTML='<div class="osi-v2-empty"><b>'+esc(t('No challenges submitted by this wallet'))+'</b><span>'+esc(t('A challenge appears here only after the existing evidence-bound submission succeeds.'))+'</span></div>';}
    else{
      host.innerHTML='<div class="osi-review-queue-tools"><div><p>'+esc(t('Only your wallet-bound challenge rows are shown. Server state remains authoritative.'))+'</p><time>'+esc(t('Deadlines update locally; refresh before acting.'))+'</time></div><button class="osi-action" type="button" data-my-challenges-refresh>'+esc(t('Refresh challenges'))+'</button></div><div class="osi-review-lanes"><section class="osi-review-lane"><header><h3>'+esc(t('Challenge history'))+'</h3><span>'+rows.length+'</span></header>'+rows.map(function(row){
        var deadline=challengeDeadline(row),detail=row.restricted_detail?'<p class="osi-my-challenge-detail" data-osi-user-content>'+esc(row.restricted_detail)+'</p>':'';
        var actions=(row.case_public_ref?'<button class="osi-action" type="button" data-challenge-case="'+esc(row.case_public_ref)+'">'+esc(t('Open public Case'))+'</button>':'')+(row.can_withdraw?'<button class="osi-action danger" type="button" data-challenge-withdraw="'+esc(row.public_ref)+'">'+esc(t('Withdraw challenge'))+'</button>':'');
        return'<article class="osi-review-task osi-my-challenge"><div><span>'+esc(row.public_ref)+'</span>'+(row.target_public_ref?'<span>'+esc(row.target_public_ref)+'</span>':'')+'<b data-osi-user-content>'+esc(row.public_safe_summary)+'</b>'+detail+'</div><dl><div><dt>'+esc(t('State'))+'</dt><dd class="'+(row.blocking?'warn':'')+'">'+esc(t(label(row.state)))+'</dd></div><div><dt>'+esc(t('Target'))+'</dt><dd>'+esc(t(label(row.target_kind)))+'</dd></div><div><dt>'+esc(t('Deadline'))+'</dt><dd><time datetime="'+esc(deadline||'')+'" data-my-challenge-deadline>'+esc(challengeCountdown(deadline))+'</time></dd></div><div><dt>'+esc(t('Submitted'))+'</dt><dd>'+esc(dateText(row.created_at))+'</dd></div><div><dt>'+esc(t('Sealing effect'))+'</dt><dd>'+esc(row.blocking?t('Blocks sealing while active'):t('Does not block sealing'))+'</dd></div><div><dt>'+esc(t('Withdraw'))+'</dt><dd>'+esc(row.can_withdraw?t('Available; server rechecks state'):t('Unavailable in this state'))+'</dd></div></dl>'+(actions?'<div class="osi-my-challenge-actions">'+actions+'</div>':'')+'</article>';
      }).join('')+'</section></div>';
      var refresh=host.querySelector('[data-my-challenges-refresh]');if(refresh)refresh.addEventListener('click',function(){openMyChallenges({authorize:true});});
      Array.prototype.forEach.call(host.querySelectorAll('[data-challenge-case]'),function(button){button.addEventListener('click',function(){if(typeof window.osiOpenPublicCase==='function')window.osiOpenPublicCase(button.getAttribute('data-challenge-case'));});});
      Array.prototype.forEach.call(host.querySelectorAll('[data-challenge-withdraw]'),function(button){button.addEventListener('click',function(){
        if(!confirm(t('Withdraw this active challenge? The withdrawal is permanent and wallet-signed.')))return;
        button.disabled=true;withdrawMyChallenge(button.getAttribute('data-challenge-withdraw'));
      });});
    }
    var count=document.getElementById('fo-count');if(count)count.textContent=rows.length+' '+t(rows.length===1?'challenge':'challenges');
    var nav=document.getElementById('fo-pnav');if(nav)nav.innerHTML='';
    var stats=document.getElementById('field-stats');if(stats)stats.innerHTML='';
    var deck=document.getElementById('fo-deck');if(deck)deck.hidden=true;
    clearInterval(state.challengeTimer);state.challengeTimer=setInterval(updateChallengeCountdowns,30000);
  }

  async function openMyChallenges(options){
    options=options||{};++state.drawerLoadToken;var drawer=document.getElementById('osi-case-drawer');if(drawer&&!drawer.hidden)closeCase();
    showView('field');var token=++state.loadToken;state.mode='challenges';state.locked=null;setFieldRailActive('');setFieldCopy('challenges');setReviewChrome(true);setLoading();
    if(!walletPubkey&&options.authorize!==true){try{if(window.OSI_WALLET_READY)await window.OSI_WALLET_READY;}catch(_){}if(token!==state.loadToken)return;if(!walletPubkey){state.locked='challenges';drawWorkspaceLock(document.getElementById('field-cases'),'challenges');return;}}
    try{
      var result=await sessionRead('challenge:mine','list_my_challenges');if(token!==state.loadToken)return;
      state.challenges=result.challenges||[];drawMyChallenges();
    }catch(error){if(token!==state.loadToken)return;var host=document.getElementById('field-cases');if(host){var refresh=/^read_session_(expired|wrong_scope)$/.test(String(error&&error.message||''));host.innerHTML='<div class="osi-v2-empty osi-v2-error"><b>'+esc(t('Challenge workspace locked'))+'</b><span>'+esc(userError(error))+'</span>'+(refresh?'<button class="osi-action" type="button" data-challenge-access-refresh>'+esc(t('Refresh private access'))+'</button>':'')+'</div>';var retry=host.querySelector('[data-challenge-access-refresh]');if(retry)retry.addEventListener('click',function(){window.osiV2RefreshReadSession(['challenge:mine']).then(function(){openMyChallenges({authorize:true});});});}}
  }
  function drawCases(){
    var host=document.getElementById('field-cases');
    if(!host) return;
    if(state.locked){drawWorkspaceLock(host,state.locked);return;}
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
      // A filtered-out list is not an empty registry. Saying "No public V2
      // Cases yet" while real Cases sit behind a stage filter or a search term
      // states something untrue about the record, so the two are separated and
      // the filtered case offers one control back to the full list.
      var filtered=!!query||state.stage!=='all';
      var emptyTitle;
      var emptyBody;
      var emptyAction='';
      if(filtered&&state.cases.length){
        emptyTitle='No Cases match this view';
        emptyBody=state.cases.length+' '+(state.cases.length===1?'Case is':'Cases are')+' available here. None of them '+(query?'matches this search':'is at this stage')+' right now.';
        emptyAction='<button class="osi-action" type="button" onclick="osiV2ClearCaseFilters()">Show all Cases</button>';
      }else{
        emptyTitle=state.mode==='public'?'No public V2 Cases yet':(state.mode==='mine'?'No Cases for this wallet':'No Cases currently await this wallet');
        emptyBody=state.mode==='public'?'The registry is live and reads production data. A Case appears only after an eligible analyst threshold or full maintainer approval, plus a confirmed CASE_OPENED Memo.':(state.mode==='mine'?'Open a Case to create a private, wallet-anchored record.':'Only private initial-review Cases available under server-derived authorization appear here.');
      }
      host.innerHTML='<div class="osi-v2-empty"><b>'+esc(emptyTitle)+'</b><span>'+esc(emptyBody)+'</span>'+emptyAction+'</div>';
    }else{
      host.innerHTML=visible.map(function(item){
        var proof=hasOpenProof(item)?'Memo anchored':((item.proof_log||[]).length?'Proof recorded':'Awaiting proof');
        var rewardState=item.money&&item.money.reward&&item.money.reward.status;
        var published=(item.reports||[]).filter(function(report){return report&&report.published===true;}).length;
        var rowLabel=t('Open Case detail')+': '+String(item.public_ref)+', '+String(item.title||'')
          +' ('+stageLabel(item.stage,item)+', '+(published?published+' '+t('published Reports'):t('no published Report'))+')';
        return '<button class="osi-v2-row" type="button" data-case-ref="'+esc(item.public_ref)+'" aria-label="'+esc(rowLabel)+'">'
          +'<span class="osi-v2-id">'+esc(item.public_ref)+'</span>'
          +'<span class="osi-v2-title"><b data-osi-user-content>'+esc(item.title)+'</b><span data-osi-user-content>'+esc(item.summary)+'</span>'+submitterIdentity(item,false)+(published?'<em class="osi-published-chip">'+esc(published+' '+(published===1?t('published Report'):t('published Reports')))+'</em>':'')+(rewardState?'<em class="osi-reward-chip">'+esc(label(rewardState))+'</em>':'')+'</span>'
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
  async function loadCaseReviewLanes(token){
    var laneIds=['initial_open','resolution_selection','challenge_admissibility','challenge_adjudication','seal_reviews'];
    try{
      var result=await sessionRead('case:review','list_reviewable_cases');if(token!==state.reviewLoadToken)return;
      state.actorRole=result.actor_role||'analyst';state.cases=result.cases||[];state.reviewTasks=result.review_tasks||{};
      laneIds.forEach(function(id){
        var rows=state.reviewTasks[id];
        if(id==='initial_open'&&!Array.isArray(rows)){
          rows=(state.cases||[]).filter(function(item){return item&&item.visibility==='private'&&['draft','submitted','initial_review'].indexOf(String(item.stage||''))>=0;}).map(function(item){
            return{target_kind:'case',case_ref:item.public_ref,exact_target:item.public_ref,stage:item.stage,submitter_conflict:item.submitter_conflict===true,next_action:item.next_action||'Review private Case for public opening',deadline_at:item.review_deadline_at};
          });
        }
        if(!Array.isArray(rows)){updateReviewLane(id,'error',[],t('The server did not return this lane.'));return;}
        updateReviewLane(id,'success',rows.map(function(row){return normalizeReviewTask(id,row,'case');}));
      });
    }catch(error){
      if(token!==state.reviewLoadToken)return;var code=String(error&&error.message||'');laneIds.forEach(function(id){updateReviewLane(id,'error',[],reviewLaneError(error),code);});
    }
  }
  async function loadReportReviewLane(token){
    try{
      if(typeof window.osiV2LoadReportReviewTasks!=='function')throw new Error('Report review module unavailable');
      var result=await window.osiV2LoadReportReviewTasks();if(token!==state.reviewLoadToken)return;
      if(result&&result.authorized===false){updateReviewLane('report_publication','unauthorized',[],result.reason||t('Eligible analyst or full maintainer access is required.'));return;}
      updateReviewLane('report_publication','success',reportReviewTasks(result));
    }catch(error){if(token===state.reviewLoadToken)updateReviewLane('report_publication','error',[],reviewLaneError(error),String(error&&error.message||''));}
  }
  async function loadApplicationReviewLane(token){
    try{
      if(typeof window.osiAnalystLoadReviewTasks!=='function')throw new Error('Analyst application module unavailable');
      var result=await window.osiAnalystLoadReviewTasks();if(token!==state.reviewLoadToken)return;
      // result.reason is a machine code. Never print it: every other lane in
      // this queue explains itself in a sentence, and a raw code reads as a
      // crash rather than an authorization boundary.
      if(result&&result.authorized===false){updateReviewLane('analyst_applications','unauthorized',[],laneReasonMessage(result.reason));return;}
      updateReviewLane('analyst_applications','success',applicationReviewTasks(result));
    }catch(error){if(token===state.reviewLoadToken)updateReviewLane('analyst_applications','error',[],reviewLaneError(error),String(error&&error.message||''));}
  }
  async function loadWireReviewLane(token){
    try{
      if(typeof window.osiV2LoadWireReviewTasks!=='function')throw new Error('Wire review module unavailable');
      var result=await window.osiV2LoadWireReviewTasks();if(token!==state.reviewLoadToken)return;
      if(result&&result.authorized===false){updateReviewLane('wire_reviews','unauthorized',[],result.reason||t('Eligible analyst or full maintainer access is required.'));return;}
      updateReviewLane('wire_reviews','success',wireReviewTasks(result));
    }catch(error){if(token===state.reviewLoadToken)updateReviewLane('wire_reviews','error',[],reviewLaneError(error),String(error&&error.message||''));}
  }
  async function retryReviewLane(id){
    var token=state.reviewLoadToken;if(!token)return loadUnifiedReviewQueue();
    var lane=state.reviewLanes[id]||{},refresh=/^read_session_(expired|wrong_scope)$/.test(String(lane.errorCode||'')),scope=id==='report_publication'?'report:review':id==='analyst_applications'?'analyst:maintainer':id==='wire_reviews'?'wire:queue':'case:review';
    updateReviewLane(id,'loading',[]);
    try{
      if(refresh&&typeof window.osiV2RefreshReadSession==='function'){
        await window.osiV2RefreshReadSession([scope]);
        return await loadUnifiedReviewQueue();
      }
      if(id==='report_publication')return await loadReportReviewLane(token);
      if(id==='analyst_applications')return await loadApplicationReviewLane(token);
      if(id==='wire_reviews')return await loadWireReviewLane(token);
      return await loadCaseReviewLanes(token);
    }catch(error){if(token===state.reviewLoadToken)updateReviewLane(id,'error',[],userError(error),String(error&&error.message||''));}
  }
  async function openReviewTask(task){
    if(task.targetKind==='report'&&typeof window.osiV2OpenReportQueueTarget==='function'){await window.osiV2OpenReportQueueTarget(task.exactTarget);return;}
    if(task.targetKind==='application'&&typeof window.osiAnalystOpenMaintainerApplication==='function'){await window.osiAnalystOpenMaintainerApplication(task.routeTarget,task.exactTarget);return;}
    if(task.targetKind==='wire'&&typeof window.osiV2OpenWireQueueTarget==='function'){await window.osiV2OpenWireQueueTarget(task.exactTarget);return;}
    var opened=await openCase(task.caseRef||task.exactTarget,task);if(!opened)return;
    var tab=task.lane==='initial_open'?'reviews':task.lane==='resolution_selection'||task.lane==='seal_reviews'?'resolution':task.lane.indexOf('challenge_')===0?'challenges':'overview';
    state.tab=tab;drawTabs();renderTab();
    var active=document.querySelector('#osi-case-tabs [data-tab="'+tab+'"]');if(active)active.focus();
  }
  async function loadUnifiedReviewQueue(){
    var token=++state.reviewLoadToken;state.locked=null;setFieldRailActive('review');state.mode='review';state.page=1;state.stage='all';setFieldCopy('review');setReviewChrome(true);resetReviewLanes();
    var host=document.getElementById('field-cases');if(host)drawReviewTasks(host);
    await Promise.allSettled([loadCaseReviewLanes(token),loadReportReviewLane(token),loadApplicationReviewLane(token),loadWireReviewLane(token)]);
    if(token!==state.reviewLoadToken)return;
    state.reviewUpdatedAt=new Date().toISOString();if(host)drawReviewTasks(host);
    await refreshCapabilities();
  }
  async function loadPublicCases(){
    var token=++state.loadToken;
    state.locked=null;setFieldRailActive(railKeyForStage(state.stage));
    state.mode='public';state.actorRole='public';state.page=1;setFieldCopy('public');setReviewChrome(false);setLoading();
    try{
      var result=await publicRead({op:'list_public_cases'});
      if(token!==state.loadToken) return;
      state.cases=result.cases||[];state.reviewTasks={};drawCases();
    }catch(error){
      if(token!==state.loadToken) return;
      var host=document.getElementById('field-cases');
      if(host) host.innerHTML='<div class="osi-v2-empty osi-v2-error"><b>Public registry unavailable</b><span>'+esc(userError(error))+'</span></div>';
    }
  }
  async function openSignedCollection(mode,options){
    options=options||{};
    // keepDrawer is used by post-mutation refreshes that intend to reopen the
    // same Case. They must not consume the drawer token, so a user close during
    // the refresh still wins.
    if(options.keepDrawer!==true){
      ++state.drawerLoadToken;
      var drawer=document.getElementById('osi-case-drawer');
      if(drawer&&!drawer.hidden)closeCase();
    }
    showView('field');
    if(!walletPubkey&&options.authorize!==true){
      var lockToken=++state.loadToken;
      state.locked=null;setFieldRailActive(mode==='review'?'review':'');setFieldCopy(mode);setReviewChrome(false);setLoading();
      // A trusted Phantom reconnect never prompts, so waiting for it avoids
      // showing the lock to a wallet that is about to restore itself.
      try{if(window.OSI_WALLET_READY)await window.OSI_WALLET_READY;}catch(_){}
      if(lockToken!==state.loadToken)return;
      if(!walletPubkey){
        state.locked=mode==='review'?'review':'mine';
        var lockHost=document.getElementById('field-cases');
        if(lockHost)drawWorkspaceLock(lockHost,state.locked);
        return;
      }
    }
    state.locked=null;
    if(mode==='review'){++state.loadToken;return loadUnifiedReviewQueue();}
    var token=++state.loadToken;
    setFieldRailActive('');
    state.mode=mode;state.page=1;state.stage='all';setFieldCopy(mode);setReviewChrome(false);setLoading();
    try{
      var result=await sessionRead('case:mine','list_my_cases');
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
    var generation=privateGeneration(),wallet=String(walletPubkey);
    try{
      var results=await Promise.all([
        api(WRITE_URL,{op:'actor_capabilities',wallet:wallet}),
        api(GOVERNANCE_URL,{op:'actor_capabilities',wallet:wallet}),
        api(PAYMENT_URL,{op:'capabilities',wallet:wallet})
      ]);
      assertPrivateGeneration(generation);if(wallet!==String(walletPubkey||''))throw new Error('private_session_changed');
      var aiPackCapabilities={ai_pack_writes_enabled:false,ai_pack_review_writes_enabled:false,can_generate:false,generation_prerequisite:'AI Pack capabilities are safely unavailable.'};
      var aiPackCaseRef=String(state.current&&state.current.public_ref||'');
      if(aiPackCaseRef){
        try{
          var aiPackRequest={op:'capabilities',wallet:wallet,case_ref:aiPackCaseRef};
          if(typeof window.osiV2ReadSession==='function'){
            try{
              var aiPackSession=await window.osiV2ReadSession(['aipack:detail'],{allowUnlock:false});
              if(aiPackSession&&aiPackSession.wallet===wallet&&aiPackSession.token)aiPackRequest.read_session=aiPackSession.token;
            }catch(aiPackSessionError){}
          }
          aiPackCapabilities=await api(AI_PACK_URL,aiPackRequest);
          aiPackCapabilities.ai_pack_maintainer_access=aiPackCapabilities.maintainer_access===true;
          delete aiPackCapabilities.wallet_connected;
          delete aiPackCapabilities.viewer_role;
          delete aiPackCapabilities.analyst_eligible;
          delete aiPackCapabilities.maintainer_access;
          delete aiPackCapabilities.maintainer_gate;
        }catch(aiPackError){}
      }
      assertPrivateGeneration(generation);if(wallet!==String(walletPubkey||''))throw new Error('private_session_changed');
      state.capabilities=Object.assign({},results[0],results[1],results[2],aiPackCapabilities);
      restorePaymentPending(wallet);
      maybeResumePendingVerification(generation);
      if(typeof setMaintainerServerGate==='function') setMaintainerServerGate(state.capabilities.maintainer_access===true,state.capabilities.maintainer_gate||'denied');
      setAdminVisibility(state.capabilities.maintainer_access===true);
      if(typeof window.osiV2SetMaintainerCapability==='function') window.osiV2SetMaintainerCapability(state.capabilities.maintainer_access===true);
      setReviewNavigationVisibility(state.capabilities.analyst_eligible===true||state.capabilities.maintainer_access===true);
      return state.capabilities;
    }catch(error){if(generation!==privateGeneration()||wallet!==String(walletPubkey||''))return null;state.capabilities=null;if(typeof setMaintainerServerGate==='function')setMaintainerServerGate(false,'unavailable');setAdminVisibility(false);setReviewNavigationVisibility(false);if(typeof window.osiV2SetMaintainerCapability==='function')window.osiV2SetMaintainerCapability(false);return null;}
  }
  function setAdminVisibility(allowed){
    var button=document.getElementById('admLockBtn')||document.getElementById('adminBtn')||document.getElementById('admin-btn');
    if(button) button.style.display=allowed?'':'none';
  }
  function setReviewNavigationVisibility(allowed){
    document.querySelectorAll('.field-review-nav').forEach(function(button){button.hidden=!allowed;});
  }

  async function fieldOpenFormV2(){
    var generation;
    state.modalReturnFocus=document.activeElement;
    if(!walletPubkey&&typeof window.osiConnectForIntent==='function'){
      await window.osiConnectForIntent('open-case','Open a Case',fieldOpenFormV2);
      return;
    }
    try{
      var wallet=await ensureWallet();
      generation=privateGeneration();
      var capabilities=await refreshCapabilities();
      assertPrivateGeneration(generation);
      if(!capabilities||capabilities.case_writes_enabled!==true)throw new Error('case_writes_disabled');
      if(state.caseReceipt){state.caseReceipt=null;clearSubmissionReceipt('v2-case-receipt');var staleForm=document.getElementById('field-form');if(staleForm)staleForm.reset();}
      restoreCaseDraft(wallet);
      var modal=document.getElementById('fo-modal'); if(modal) modal.classList.add('open');
      syncBodyLock();
      // Take focus only if the person has not already put it inside this form.
      // The delay lets the surface settle, but during it someone can click
      // straight into the field they actually want and start typing, and pulling
      // the cursor back to the first field mid-sentence loses what they wrote.
      // Anything outside the form, including the control that opened it or a
      // button that has since been re-rendered away, is not a person typing, so
      // the convenience of landing in the first field is kept.
      setTimeout(function(){
        var target=document.getElementById('v2-case-title');
        var host=document.getElementById('field-form');
        if(!target)return;
        if(host&&document.activeElement&&host.contains(document.activeElement))return;
        target.focus();
      },80);
    }catch(error){if(generation==null||generation===privateGeneration()){showToast(userError(error));restoreFocus(state.modalReturnFocus);state.modalReturnFocus=null;}}
  }
  function syncBodyLock(){
    var modal=document.getElementById('fo-modal');
    var drawer=document.getElementById('osi-case-drawer');
    document.body.style.overflow=(modal&&modal.classList.contains('open'))||(drawer&&!drawer.hidden)?'hidden':'';
  }
  function restoreFocus(node){if(node&&document.contains(node)&&typeof node.focus==='function')setTimeout(function(){node.focus();},0);}
  function fieldCloseFormV2(){
    var modal=document.getElementById('fo-modal');if(modal)modal.classList.remove('open');
    if(state.caseReceipt){var form=document.getElementById('field-form');if(form)form.reset();state.caseReceipt=null;clearSubmissionReceipt('v2-case-receipt');formStatus('');var submit=document.getElementById('v2-case-submit');if(submit){submit.disabled=false;submit.removeAttribute('aria-busy');}}
    syncBodyLock();restoreFocus(state.modalReturnFocus);state.modalReturnFocus=null;
  }
  function lines(id,kind){
    var input=document.getElementById(id);if(!input)return[];
    return String(input.value||'').split(/[\n,]+/).map(function(value){return value.trim();}).filter(Boolean).map(function(ref){return{kind:kind,ref:ref};});
  }
  var CASE_DRAFT_FIELDS=['v2-case-category','v2-case-title','v2-case-summary','v2-case-details','v2-case-wallets','v2-case-transactions','v2-case-urls','v2-case-reward'];
  function caseDraftKey(wallet){return'case-intake:'+String(wallet||'');}
  function saveCaseDraft(){
    var wallet=String(walletPubkey||'');if(!wallet||typeof window.osiV2SaveDraft!=='function')return;
    var values={};CASE_DRAFT_FIELDS.forEach(function(id){var field=document.getElementById(id);if(field)values[id]=field.value;});
    window.osiV2SaveDraft(caseDraftKey(wallet),values);
  }
  // A restore may only fill a field that is still blank. It may never replace
  // something the person has already typed.
  //
  // fieldOpenFormV2 reaches this call after two awaits, and on the
  // connect-at-intent path it is invoked later still, as the callback handed to
  // osiConnectForIntent. Someone who starts typing while the form is opening
  // therefore races a restore that used to overwrite every field it had a saved
  // value for, including with the empty string. Losing what a person typed into
  // a Case intake is data loss, not a cosmetic glitch.
  //
  // Restoring only into blank fields keeps the feature intact: every field in
  // CASE_DRAFT_FIELDS is blank on an untouched form, including the category
  // select, whose default option carries an empty value, and the numeric reward
  // input, which starts empty. A returning author still gets their draft back.
  function restoreCaseDraft(wallet){
    if(typeof window.osiV2LoadDraft!=='function')return;
    var values=window.osiV2LoadDraft(caseDraftKey(wallet))||{};
    CASE_DRAFT_FIELDS.forEach(function(id){
      var field=document.getElementById(id);
      if(!field||!Object.prototype.hasOwnProperty.call(values,id))return;
      if(String(field.value||'')!=='')return;
      field.value=String(values[id]||'');
    });
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
  async function commitWithConfirmation(body,url,generation){
    var lastError;
    for(var attempt=0;attempt<5;attempt++){
      assertPrivateGeneration(generation);
      try{var result=await api(url||WRITE_URL,body);assertPrivateGeneration(generation);return result;}catch(error){lastError=error;if(String(error.message)!=='transaction_not_confirmed')throw error;assertPrivateGeneration(generation);await new Promise(function(resolve){setTimeout(resolve,1600+attempt*900);});assertPrivateGeneration(generation);}
    }
    throw lastError;
  }
  async function submitCase(event){
    if(event)event.preventDefault();
    var form=document.getElementById('field-form');if(!form||!form.reportValidity())return;
    var generation=privateGeneration();
    var button=document.getElementById('v2-case-submit');button.disabled=true;button.setAttribute('aria-busy','true');
    try{
      var wallet=await ensureWallet();
      assertPrivateGeneration(generation);
      var payload=casePayload();
      if(payload.evidence.length>12) throw new Error('A Case can include at most 12 structured evidence references.');
      if(!state.caseIdempotency)state.caseIdempotency=randomKey('case');
      formStatus('Preparing an exact, single-use submission proof...');
      var prepared=await api(WRITE_URL,{op:'prepare_case',wallet:wallet,case:payload,idempotency_key:state.caseIdempotency});
      assertPrivateGeneration(generation);
      formStatus('Approve the CASE_SUBMITTED Memo in your wallet. OSI receives no funds.');
      var txSig=await castOnchainVote(prepared.memo);
      assertPrivateGeneration(generation);
      formStatus('Confirming the exact signer, Memo, target, payload hash, and mainnet transaction...');
      var committed=await commitWithConfirmation({op:'commit_case',wallet:wallet,case:payload,nonce:prepared.nonce,memo:prepared.memo,tx_sig:txSig},WRITE_URL,generation);
      assertPrivateGeneration(generation);
      formStatus('Private Case created with an immutable submission receipt.','success');
      showToast('Case '+committed.case.public_ref+' is private and awaiting eligible analyst or full maintainer review.');
      state.caseIdempotency='';state.caseReceipt=committed.case;
      if(typeof window.osiV2RemoveDraft==='function')window.osiV2RemoveDraft(caseDraftKey(wallet));
      var canQueue=!!(state.capabilities&&(state.capabilities.analyst_eligible===true||state.capabilities.maintainer_access===true));
      renderSubmissionReceipt('v2-case-receipt',{
        title:'Private Case saved',publicRef:committed.case.public_ref,copyValue:committed.case.public_ref,
        stage:stageLabel(committed.case.stage||'initial_review',committed.case),visibility:label(committed.case.visibility||'private'),
        where:'My Cases, using a fresh wallet-authorized private read.',
        reviewers:'Eligible independent analysts and full double-gated maintainers. The Case owner cannot self-review.',
        next:'An authorized reviewer records an initial-open decision. A confirmed CASE_OPENED Memo is still required before the Case becomes public.',
        openLabel:'Open My Cases',canOpenQueue:canQueue,
        onOpen:function(){fieldCloseFormV2();window.osiV2OpenMyCases();},
        onQueue:function(){fieldCloseFormV2();window.osiV2OpenReviewQueue();},
        onDismiss:fieldCloseFormV2
      });
    }catch(error){if(generation===privateGeneration())formStatus(userError(error),'error');}
    finally{if(generation===privateGeneration()){button.disabled=!!state.caseReceipt;button.removeAttribute('aria-busy');}}
  }

  var tabs=[['overview','Overview'],['evidence','Evidence'],['reports','Reports'],['ai_pack','AI Pack'],['resolution','Resolution'],['challenges','Challenges'],['reward','Rewards & Support'],['proof','Proof Log']];
  function visibleTabs(){
    var aiVisible=state.capabilities&&state.capabilities.maintainer_access===true&&state.capabilities.ai_pack_access_mode==='maintainer_only';
    var authorized=!!(state.capabilities&&(state.capabilities.analyst_eligible===true||state.capabilities.maintainer_access===true));
    var rows=tabs.filter(function(tab){return tab[0]!=='ai_pack'||aiVisible;})
      // Anonymous and ordinary visitors only ever see published Reports here,
      // so name the section for what it actually contains.
      .map(function(tab){return tab[0]==='reports'&&!authorized?['reports','Published Reports']:tab;});
    // The initial-review record is the proof that a Case was approved for
    // public investigation. It is already in the anonymous projection, so it
    // stays reachable for every visitor once any review exists, not only for
    // an authorized reviewer working a private intake.
    var reviewing=state.mode==='review'&&state.current&&state.current.visibility==='private';
    var hasReviews=!!(state.current&&(state.current.reviews||[]).length);
    if(reviewing||hasReviews)return rows.slice(0,1).concat([['reviews','Initial Review']],rows.slice(1));
    return rows;
  }
  // A public Case reference is the canonical, shareable route segment. It is
  // never a token, nonce, wallet or any other private value.
  var CASE_ROUTE_PREFIX='#case/';
  function isCaseRef(value){return /^OSI-[0-9A-Z]{6,20}$/.test(String(value||''));}
  function pushCaseRoute(publicRef){
    if(!isCaseRef(publicRef))return;
    var next=CASE_ROUTE_PREFIX+publicRef;
    if(window.location.hash===next)return;
    try{window.history.pushState({osiView:'field',osiCase:publicRef},'',next);}catch(_){}
  }
  function clearCaseRoute(){
    if(String(window.location.hash||'').indexOf(CASE_ROUTE_PREFIX)!==0)return;
    try{window.history.pushState({osiView:'field'},'','#field-office');}catch(_){}
  }
  function paintCaseHeader(publicRef,item){
    var refNode=document.getElementById('osi-case-ref');
    var titleNode=document.getElementById('osi-case-title');
    var stateNode=document.getElementById('osi-case-state');
    if(refNode)refNode.textContent=(item&&item.public_ref)||publicRef||'';
    if(titleNode)titleNode.textContent=item&&item.title?item.title:t('Opening Case detail');
    if(!stateNode)return;
    stateNode.innerHTML=item
      ?'<span class="osi-chip '+esc(item.visibility)+'">'+esc(t(label(item.visibility)))+'</span><span class="osi-chip">'+esc(t(stageLabel(item.stage,item)))+'</span><span class="osi-chip">'+esc(t(label(item.category)))+'</span>'
      :'<span class="osi-chip">'+esc(t('Loading'))+'</span>';
  }
  // The drawer is revealed before any network call so a Case row click always
  // produces immediate, visible feedback instead of looking like a dead button.
  function revealCaseDrawer(){
    var drawer=document.getElementById('osi-case-drawer');
    if(!drawer)return null;
    if(drawer.hidden)state.drawerReturnFocus=document.activeElement;
    drawer.hidden=false;document.body.classList.add('osi-case-open');syncBodyLock();
    return drawer;
  }
  function caseDrawerLoading(){
    var tabs=document.getElementById('osi-case-tabs');if(tabs)tabs.innerHTML='';
    var actions=document.getElementById('osi-case-actions');if(actions)actions.innerHTML='';
    var content=document.getElementById('osi-case-content');
    if(content)content.innerHTML='<section class="osi-case-section" data-case-loading aria-busy="true"><h3>'+esc(t('Opening Case detail'))+'</h3><div class="osi-v2-skeleton"></div><div class="osi-v2-skeleton"></div><div class="osi-v2-skeleton"></div></section>';
  }
  function caseDrawerError(publicRef,error){
    var tabs=document.getElementById('osi-case-tabs');if(tabs)tabs.innerHTML='';
    var actions=document.getElementById('osi-case-actions');if(actions)actions.innerHTML='';
    var content=document.getElementById('osi-case-content');
    if(!content)return;
    content.innerHTML='<section class="osi-case-section"><div class="osi-v2-empty osi-v2-error"><b>'+esc(t('Case detail unavailable'))+'</b><span>'+esc(userError(error))+'</span><button class="osi-action" type="button" data-case-retry="'+esc(publicRef)+'">'+esc(t('Try again'))+'</button></div></section>';
    var retry=content.querySelector('[data-case-retry]');
    if(retry)retry.addEventListener('click',function(){openCase(publicRef,null,{fromRoute:true});});
  }
  // Best-effort authorized Case detail. It is attempted only when a wallet is
  // connected and a live read session already carries the case:detail scope, so
  // it can never open a wallet prompt for a visitor who just clicked a public
  // Case. Any failure resolves to null and the caller falls back to the
  // anonymous projection.
  async function authorizedCaseRead(ref){
    if(!walletPubkey||!isCaseRef(ref))return null;
    if(typeof window.osiV2ReadSession!=='function')return null;
    try{
      var session=await window.osiV2ReadSession(['case:detail'],{allowUnlock:false});
      if(!session||!session.token)return null;
      var generation=privateGeneration();
      var result=await api(READ_URL,{op:'get_authorized_case',wallet:session.wallet,read_session:session.token,case_ref:ref});
      assertPrivateGeneration(generation);
      return result&&result.case?result:null;
    }catch(_){return null;}
  }
  async function openCase(publicRef,reviewTask,options){
    options=options||{};
    var ref=String(publicRef||'');
    var drawerToken=++state.drawerLoadToken;
    state.activeReviewTask=reviewTask||null;
    // list_public_cases and get_public_case share one server projection, so a
    // cached row renders the identical canonical detail with no extra wait.
    var cached=state.cases.find(function(entry){return entry.public_ref===ref;})||null;
    var drawer=revealCaseDrawer();
    if(!drawer){state.activeReviewTask=null;return null;}
    state.drawerReturnHash=/^#[a-z0-9-]+$/.test(String(options.returnHash||''))
      ?String(options.returnHash):'';
    if(options.fromRoute!==true)pushCaseRoute(ref);
    paintCaseHeader(ref,cached);
    if(cached){state.current=cached;state.tab='overview';drawTabs();renderTab();renderActions();}
    else caseDrawerLoading();
    setTimeout(function(){
      if(drawerToken!==state.drawerLoadToken)return;
      var close=drawer.querySelector('.osi-case-close');if(close)close.focus();
    },30);
    var item=cached;
    try{
      // The drawer used to read only the anonymous projection whenever the row
      // was not already cached, or whenever Field Office was in public mode.
      // That meant an owner, an eligible analyst or a full maintainer opening a
      // Case from Field Office, Public Records or a shared #case/ link saw the
      // public DTO and none of the fields they are entitled to: no restricted
      // detail, no private evidence manifest, no unpublished Report. Ask for the
      // authorized projection first whenever a private read session already
      // exists. It never prompts for a wallet, and the server still decides what
      // the caller is allowed to see.
      // Both reads start at once rather than one after the other. Awaiting the
      // authorized read first added its full round trip to the wait before the
      // public read even began, which is exactly the delay a reader notices
      // when the evidence sections arrive late. A visitor with no wallet or no
      // live session resolves the authorized attempt locally with no request at
      // all, so this costs an extra call only for an actor who may be entitled
      // to more than the anonymous projection.
      var needsPublic=!cached||state.mode==='public';
      var authorizedPending=authorizedCaseRead(ref);
      var publicPending=needsPublic
        ? publicRead({op:'get_public_case',public_ref:ref}).catch(function(error){return {error:error};})
        : null;
      var authorized=await authorizedPending;
      if(drawerToken!==state.drawerLoadToken)return null;
      if(authorized&&authorized.case){
        item=authorized.case;
        state.currentActorRole=String(authorized.actor_role||'');
      }else if(needsPublic){
        var result=await publicPending;
        if(drawerToken!==state.drawerLoadToken)return null;
        if(result&&result.error)throw result.error;
        item=result.case;
        state.currentActorRole='public';
      }
      state.current=item;
      var capabilitiesRefreshed=false;
      if(walletPubkey){await refreshCapabilities();capabilitiesRefreshed=true;}
      if(drawerToken!==state.drawerLoadToken)return null;
      paintCaseHeader(ref,item);
      // Re-render only when the refreshed projection or the actor capabilities
      // actually differ, so an unchanged refresh cannot reset the open tab.
      var unchanged=!!cached&&!capabilitiesRefreshed&&JSON.stringify(item)===JSON.stringify(cached);
      if(!unchanged){drawTabs();renderTab();renderActions();}
      return item;
    }catch(error){
      if(drawerToken!==state.drawerLoadToken)return null;
      if(cached){showToast(userError(error));return cached;}
      state.activeReviewTask=null;state.current=null;
      paintCaseHeader(ref,null);
      caseDrawerError(ref,error);
      return null;
    }
  }
  function wipeCaseDrawerContent(){
    if(typeof window.osiV2AiPackClear==='function')window.osiV2AiPackClear();
    var content=document.getElementById('osi-case-content');
    if(content){
      if(typeof content.replaceChildren==='function')content.replaceChildren();
      else content.innerHTML='';
    }
  }
  function closeCase(options){
    options=options||{};
    ++state.drawerLoadToken;
    var drawer=document.getElementById('osi-case-drawer');
    if(drawer)drawer.hidden=true;
    document.body.classList.remove('osi-case-open');
    syncBodyLock();
    wipeCaseDrawerContent();
    state.current=null;
    state.activeReviewTask=null;
    var returnHash=state.drawerReturnHash;
    state.drawerReturnHash='';
    if(options.fromRoute!==true){
      if(returnHash&&String(window.location.hash||'').indexOf(CASE_ROUTE_PREFIX)===0){
        try{window.history.pushState({osiView:'records'},'',returnHash);}catch(_){clearCaseRoute();}
      }else clearCaseRoute();
    }
    restoreFocus(state.drawerReturnFocus);
    state.drawerReturnFocus=null;
  }
  // Marks the tab strip when it genuinely scrolls, so the trailing fade that
  // signals "there are more tabs" appears only when there are.
  function syncTabOverflow(host){
    host=host||document.getElementById('osi-case-tabs');
    if(!host)return;
    host.setAttribute('data-osi-overflow',host.scrollWidth>host.clientWidth+1?'true':'false');
  }
  function drawTabs(){
    var host=document.getElementById('osi-case-tabs');
    var rows=visibleTabs();
    host.setAttribute('role','tablist');
    host.innerHTML=rows.map(function(tab){
      var active=tab[0]===state.tab;
      return'<button class="osi-case-tab '+(active?'active':'')+'" id="osi-case-tab-'+tab[0]+
        '" type="button" role="tab" aria-controls="osi-case-content" aria-selected="'+active+
        '" tabindex="'+(active?'0':'-1')+'" data-tab="'+tab[0]+'">'+esc(t(tab[1]))+'</button>';
    }).join('');
    var selected=host.querySelector('[aria-selected="true"]');if(selected&&typeof selected.scrollIntoView==='function')selected.scrollIntoView({block:'nearest',inline:'nearest'});
    syncTabOverflow(host);
    Array.prototype.forEach.call(host.querySelectorAll('[data-tab]'),function(button){
      button.addEventListener('click',function(){state.tab=button.dataset.tab;drawTabs();renderTab();});
      button.addEventListener('keydown',function(event){
        var keys=['ArrowLeft','ArrowRight','Home','End'];if(keys.indexOf(event.key)<0)return;
        event.preventDefault();var current=rows.findIndex(function(tab){return tab[0]===state.tab;});
        var next=event.key==='Home'?0:event.key==='End'?rows.length-1:event.key==='ArrowLeft'?(current-1+rows.length)%rows.length:(current+1)%rows.length;
        state.tab=rows[next][0];drawTabs();renderTab();
        var target=host.querySelector('[data-tab="'+state.tab+'"]');if(target)target.focus();
      });
    });
  }
  function emptySection(title,text){return'<section class="osi-case-section"><h3>'+esc(t(title))+'</h3><div class="osi-v2-empty"><b>'+esc(t('Nothing recorded'))+'</b><span>'+esc(t(text))+'</span></div></section>';}
  // Long intake prose keeps its paragraphs. Every chunk is escaped; only the
  // structure is markup.
  function caseProse(value){
    var text=String(value==null?'':value).replace(/\r\n?/g,'\n').trim();
    if(!text)return'';
    return text.split(/\n{2,}/).map(function(block){
      return'<p data-osi-user-content>'+block.split('\n').map(function(line){
        return esc(line.trim());
      }).join('<br>')+'</p>';
    }).join('');
  }
  function overview(item){
    var summary=item.summary?'<div class="osi-case-block"><h4>'+esc(t('Summary'))+'</h4>'+caseProse(item.summary)+'</div>':'';
    // details_restricted is only ever present on an authorized projection. The
    // anonymous DTO does not carry the field at all, so this cannot leak.
    var restricted=item.details_restricted
      ?'<div class="osi-case-block restricted"><h4>'+esc(t('Description'))+' <span class="osi-restricted-chip">'+esc(t('Restricted'))+'</span></h4>'+caseProse(item.details_restricted)
        +'<p class="osi-case-note">'+esc(t('Visible to the Case owner, an eligible analyst and a full maintainer. It is never returned by the anonymous API.'))+'</p></div>'
      :'';
    var references=evidenceSectionsHtml(item);
    var referenceBlock=references?'<div class="osi-case-block"><h4>'+esc(t('Structured References'))+'</h4>'+references+'</div>':'';
    var reward=item.reward_intent_lamports
      ?'<div class="osi-case-block"><h4>'+esc(t('Additional Details'))+'</h4><dl class="osi-detail-grid"><div><dt>'+esc(t('Reward intent'))+'</dt><dd class="mono">'+esc(String(item.reward_intent_lamports))+' lamports</dd></div></dl>'
        +'<p class="osi-case-note">'+esc(t('Reward intent is non-binding display intent only. It is not a pledge, transfer, escrow or payment.'))+'</p></div>'
      :'';
    var cycle=reviewCycleStartedAt(item);
    var active=(item.reviews||[]).filter(function(review){return review.is_active===true&&new Date(review.created_at).getTime()>cycle;});
    var initialKey=active.length===1?'{count} active attributable review':'{count} active attributable reviews';
    var initial=active.length?'<div class="osi-governance-mini"><b>'+esc(t('Initial review'))+'</b><span>'+esc(t(initialKey,{count:active.length}))+'</span></div>':'';
    return '<section class="osi-case-section"><h3>'+esc(t('Case overview'))+'</h3>'+submitterIdentity(item,true)+'<div class="osi-case-meta"><div><span>'+esc(t('Reference'))+'</span><b>'+esc(item.public_ref)+'</b></div><div><span>'+esc(t('Created'))+'</span><b>'+esc(dateText(item.created_at))+'</b></div><div><span>'+esc(t('Stage'))+'</span><b>'+esc(t(stageLabel(item.stage,item)))+'</b></div><div><span>'+esc(t('Visibility'))+'</span><b>'+esc(t(label(item.visibility)))+'</b></div></div>'
      +summary+'<div class="osi-governance-mini"><b>'+esc(t('Exact next step'))+'</b><span>'+esc(t(nextStepText(item)))+'</span></div>'+initial+restricted+referenceBlock+reward
      +'<div class="osi-case-note">'+esc(t('OSI records attributable, human-reviewed and challengeable process. It does not determine guilt, legal certainty, truth, custody, recovery, or guaranteed payment.'))+'</div></section>';
  }
  function evidence(item){
    var html=evidenceSectionsHtml(item);
    if(!html)return emptySection('Evidence','No evidence reference is public in this projection. Private pending evidence never leaks through the anonymous API.');
    var pending=String(item.visibility||'')!=='public'
      ?'<div class="osi-case-note">'+esc(t('This manifest is private intake evidence. It becomes public only through the confirmed CASE_OPENED transition.'))+'</div>'
      :'';
    return '<section class="osi-case-section"><h3>'+esc(t('Evidence and Sources'))+'</h3>'+html+pending
      +'<div class="osi-case-note">'+esc(t('A reference is evidence material, not automatic proof of a claim. Public items require their own moderation state.'))+'</div></section>';
  }
  function reports(item){
    if(typeof window.osiReportRenderSection==='function')return window.osiReportRenderSection(item,{mode:state.mode,actorRole:state.currentActorRole||state.actorRole,capabilities:state.capabilities||{}});
    var rows=item.reports||[];if(!rows.length)return emptySection('Reports','Report data is temporarily unavailable.');
    return '<section class="osi-case-section"><h3>'+esc(t('Reports'))+'</h3><div class="osi-list">'+rows.map(function(row){return'<div class="osi-list-item"><b>'+esc(t(label(row.status)))+'</b><p>'+esc(t(row.published?'Published exact version':'No published version'))+'</p></div>';}).join('')+'</div></section>';
  }
  // The approval that moved a Case from private intake to public investigation
  // is a first-class public fact. Say who approved it, in what role, and which
  // confirmed Memo anchored the opening; never infer an opening that has no
  // recorded receipt.
  function openingOutcome(item){
    var cycle=reviewCycleStartedAt(item);
    var approvals=(item.reviews||[]).filter(function(row){return row.is_active===true&&row.decision==='approve_open'&&new Date(row.created_at).getTime()>cycle;});
    var maintainer=approvals.some(function(row){return row.reviewer_role==='maintainer';});
    var analysts=approvals.filter(function(row){return row.reviewer_role==='analyst';});
    var opened=(item.proof_log||[]).find(function(row){return row.event_type==='CASE_OPENED';});
    if(!approvals.length){
      return String(item.visibility||'')==='public'
        ? '<div class="osi-state-message" role="note"><b>'+esc(t('Opened for public investigation'))+'</b><span>'+esc(t('No attributable initial-review row is exposed for this Case. OSI shows no reviewer it cannot prove.'))+'</span></div>'
        : '<div class="osi-state-message warning" role="note"><b>'+esc(t('Awaiting initial review'))+'</b><span>'+esc(t('This Case stays private until an eligible analyst or a full maintainer records an approve-open decision.'))+'</span></div>';
    }
    var who=[];
    if(maintainer)who.push(t('a full maintainer'));
    if(analysts.length)who.push(analysts.length+' '+(analysts.length===1?t('eligible analyst'):t('eligible analysts')));
    var weight=analysts.reduce(function(sum,row){return sum+Number(row.weight||0);},0);
    var anchor=opened&&opened.solscan_url&&/^https:\/\/solscan\.io\/tx\/[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(opened.solscan_url)
      ?'<a class="osi-proof-link" href="'+esc(opened.solscan_url)+'" target="_blank" rel="noopener">'+esc(t('Verify CASE_OPENED on Solscan'))+'</a>'
      :'<span class="osi-case-note">'+esc(t('No confirmed CASE_OPENED Memo is public for this Case yet.'))+'</span>';
    return '<div class="osi-state-message success" role="note"><b>'+esc(t('Approved for public investigation'))+'</b>'
      +'<span>'+esc(t('Approved by')+' '+who.join(' '+t('and')+' ')+(analysts.length?' · '+t('counted analyst weight')+' '+weight.toFixed(2):'')+'.')+'</span>'
      +'<span>'+esc(t('Approval authorizes public investigation only. It is not a truth, guilt or recovery decision.'))+'</span>'
      +anchor+'</div>';
  }
  // Constitution §8: a public governance decision is publicly attributed, and
  // attribution means the analyst's public profile as well as their wallet. The
  // list used to print a shortened wallet and nothing else, so a reader could
  // see that someone decided but not who, and had no way to reach the record of
  // their other work. The handle comes from the public analyst directory the
  // Analyst Network already publishes; when it is not loaded the wallet still
  // stands on its own, and nothing is invented for a wallet that is not in it.
  function reviewerIdentity(wallet){
    var address=String(wallet||'');
    var directory=window.VERIFIED_ANALYSTS&&window.VERIFIED_ANALYSTS[address];
    var handle=directory&&(directory.handle?'@'+directory.handle:directory.name)||'';
    var label=handle?esc(handle)+' <span class="osi-review-wallet mono">'+esc(short(address))+'</span>'
      :'<span class="osi-review-wallet mono">'+esc(short(address))+'</span>';
    if(!directory)return '<span class="osi-review-actor" title="'+esc(address)+'">'+label+'</span>';
    return '<button class="osi-review-actor osi-review-actor-link" type="button" title="'+esc(address)
      +'" data-analyst-profile="'+esc(address)+'">'+label+'</button>';
  }
  function reviews(item){
    var rows=item.reviews||[],cycle=reviewCycleStartedAt(item);
    var list=rows.length?'<div class="osi-list">'+rows.map(function(row){var prior=new Date(row.created_at).getTime()<=cycle;return'<div class="osi-list-item"><div class="osi-list-item-head"><b>'+reviewerIdentity(row.reviewer_wallet)+sasSlot(row.reviewer_wallet,row.reviewer_role)+' &middot; '+esc(label(row.decision))+'</b><span class="osi-proof-label">'+esc(prior?'Previous review cycle':row.proof_label)+'</span></div><p>'+esc(label(row.reviewer_role))+' &middot; weight '+esc(row.weight)+(prior?'':sasAuthority(row))+' &middot; '+esc(dateText(row.created_at))+'</p>'+(row.reason_code?'<p>Reason code: '+esc(row.reason_code)+'</p>':'')+'</div>';}).join('')+'</div>':'<div class="osi-v2-empty"><b>Awaiting initial review</b><span>No eligible reviewer has recorded a decision yet.</span></div>';
    return '<section class="osi-case-section"><h3>Initial reviews</h3>'+openingOutcome(item)+list+'<div id="osi-review-compose"></div></section>';
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
    return '<div class="osi-governance-timeline">'+rows.map(function(row){var role=row.reviewer_role||row.actor_role||'';return'<div class="osi-governance-event"><span class="osi-proof-label">'+esc(row.proof_label||'Wallet-signed & server-verified')+'</span><b>'+esc(short(row.reviewer_wallet))+sasSlot(row.reviewer_wallet,role)+' &middot; '+esc(label(row.decision))+'</b><p>'+esc(row.target_version_ref||label(row.phase))+' &middot; weight '+esc(Number(row.weight||0).toFixed(2))+sasAuthority(row)+' &middot; '+esc(dateText(row.created_at))+'</p><p data-osi-user-content>'+esc(row.public_rationale||'No public rationale recorded.')+'</p></div>';}).join('')+'</div>';
  }
  function bootstrapReason(code){
    var reasons={
      governance_writes_disabled:'Resolution lifecycle writes are disabled.',
      full_maintainer_gate_required:'Both the configured maintainer wallet and maintainer sign-in are required.',
      resolution_not_selection_ready:'This Case is not in a server-approved Resolution selection state.',
      standard_quorum_ready:'The standard analyst quorum is ready; use the standard finalization control.',
      standard_quorum_exists:'A standard analyst quorum already exists for another exact candidate; D17 cannot replace it.',
      standard_quorum_tie_unresolved:'The standard analyst quorum is tied; more independent review is required and D17 cannot choose between candidates.',
      bootstrap_candidate_not_current:'D17 can select only an exact version that is still the current published Report version.',
      bootstrap_disabled:'The D17 maintainer-bootstrap flag is disabled.',
      bootstrap_retired:'D17 is retired at 50 or more eligible analysts.',
      actor_conflict:'The maintainer owns this Case, authored the candidate, or cast an active counted review.',
      bootstrap_support_count_required:'More independent analyst support is required for the current D17 tier.',
      bootstrap_support_weight_required:'More independent analyst support weight is required for the current D17 tier.',
      blocking_challenge_active:'An admitted open or under-review challenge blocks sealing.',
      challenge_window_not_ended:'The seven-day challenge window has not ended.',
      ready:'All server-derived D17 prerequisites are met.'
    };return t(reasons[String(code||'')]||'The server-derived bootstrap prerequisite is not met.');
  }
  function resolution(item){
    var governance=item.governance||{};var row=governance.resolution;var candidates=publishedCandidates(item);var caps=state.capabilities||{};
    if(!candidates.length&&!row)return emptySection('Resolution','A published exact Report version is required before resolution selection can begin.');
    var quorum=row&&row.selection_quorum||{leader_count:0,leader_weight:0,required_count:item.risk_tier==='high'?3:2,required_weight:item.risk_tier==='high'?4.5:2.5};
    var selectionTask=activeTaskMatches('resolution_selection'),sealTask=activeTaskMatches('seal_reviews');
    var selectionCapability=selectionTask&&state.activeReviewTask?state.activeReviewTask.finalizationCapability:null;
    var selectionStandard=selectionCapability&&selectionCapability.standard||{};
    var selectionBootstrap=selectionCapability&&selectionCapability.bootstrap||{};
    var exactSelection=selectionTask&&state.activeReviewTask&&String(state.activeReviewTask.exactTarget||'');
    var actionableCandidates=exactSelection&&candidates.some(function(candidate){return String(candidate.version_ref)===exactSelection;})
      ?candidates.filter(function(candidate){return String(candidate.version_ref)===exactSelection;}):candidates;
    var candidateOptions=actionableCandidates.map(function(candidate){return'<option value="'+esc(candidate.version_ref)+'">'+esc(candidate.version_ref)+' &middot; '+esc(candidate.report_ref)+'</option>';}).join('');
    var selectionConflict=activeTaskConflict('resolution_selection');
    var sealConflict=activeTaskConflict('seal_reviews');
    var selectionForm=caps.resolution_lifecycle_writes_enabled===true&&caps.analyst_eligible===true&&selectionTask&&!selectionConflict&&(!row||row.state==='selection_open')
      ? '<div class="osi-governance-compose"><h4>Resolution selection review</h4><label>Exact published version<select id="osi-resolution-version">'+candidateOptions+'</select></label><label>Decision<select id="osi-resolution-decision"><option value="select">Select as primary</option><option value="object">Object</option><option value="abstain">Abstain</option></select></label><label>Public rationale<textarea id="osi-resolution-rationale" maxlength="10000" placeholder="Explain the process-based selection in public-safe language."></textarea></label><label>Restricted analyst note<textarea id="osi-resolution-note" maxlength="10000" placeholder="Optional. Never returned in the public DTO."></textarea></label><button class="osi-action primary" type="button" onclick="osiV2GovernanceResolutionReview()">Sign and record review</button></div>'
      : '';
    var leader=quorum.leader_version_ref;
    var standardFinalize=selectionStandard.can_finalize===true
      ? '<button class="osi-action primary" type="button" onclick="osiV2GovernanceFinalizeResolution(\'standard\')">'+esc(t('Finalize standard quorum leader'))+'</button>'
      : '<button class="osi-action" type="button" disabled title="'+esc(!selectionTask?reviewTaskRequiredMessage():t('Requires a unique server-derived analyst quorum leader and the full maintainer double-gate'))+'">'+esc(t('Standard finalization unavailable'))+'</button>';
    var bootstrapPanel='';
    if(selectionCapability){
      bootstrapPanel='<div class="osi-governance-seal"><h4>'+esc(t('Maintainer bootstrap (D17)'))+'</h4><p>'+esc(t('Tier'))+' '+esc(label(selectionBootstrap.tier||'disabled'))+' &middot; '+esc(selectionBootstrap.eligible_analyst_count==null?t('unavailable'):selectionBootstrap.eligible_analyst_count)+' '+esc(t('eligible analysts. This channel is not an independent analyst quorum.'))+'</p>'
        +progress(selectionBootstrap.actual_support_count||0,selectionBootstrap.actual_support_weight||0,selectionBootstrap.required_support_count||0,selectionBootstrap.required_support_weight||0)
        +(selectionBootstrap.can_finalize===true?'<button class="osi-action primary" type="button" onclick="osiV2GovernanceFinalizeResolution(\'bootstrap\')">'+esc(t('Finalize exact version via D17'))+'</button>':'<button class="osi-action" type="button" disabled title="'+esc(bootstrapReason(selectionBootstrap.reason_code))+'">'+esc(t('D17 finalization unavailable'))+'</button>')+'</div>';
    }
    var finalize=standardFinalize+bootstrapPanel;
    var seal='',sealStandard={},sealBootstrap={};
    if(row&&row.state==='in_challenge_window'){
      var ended=new Date(row.challenge_window_closes_at).getTime()<=Date.now();var blocking=(governance.challenges||[]).some(function(challenge){return challenge.blocking;});
      var sq=row.seal_quorum||{};var sealCapability=sealTask&&state.activeReviewTask?state.activeReviewTask.finalizationCapability:null;
      sealStandard=sealCapability&&sealCapability.standard||{};sealBootstrap=sealCapability&&sealCapability.bootstrap||{};
      seal='<div class="osi-governance-seal"><h4>'+esc(t('Process seal'))+'</h4>'+progress(sq.approve_count||0,sq.approve_weight||0,sq.required_count||2,sq.required_weight||2.5)
        +(ended&&!blocking&&caps.analyst_eligible===true&&sealTask&&!sealConflict?'<button class="osi-action" type="button" onclick="osiV2GovernanceSealReview()">'+esc(t('Sign seal review'))+'</button>':'<button class="osi-action" disabled title="'+esc(sealConflict?conflictMessage():!sealTask?reviewTaskRequiredMessage():t('Requires an ended seven-day window, no active challenge and eligible analyst'))+'">'+esc(t('Seal review unavailable'))+'</button>')
        +(sealStandard.can_finalize===true?'<button class="osi-action primary" type="button" onclick="osiV2GovernanceFinalizeSeal(\'standard\')">'+esc(t('Memo-anchor standard process seal'))+'</button>':'<button class="osi-action" disabled title="'+esc(t('Standard analyst seal quorum is not ready.'))+'">'+esc(t('Standard seal unavailable'))+'</button>')
        +(sealCapability?'<div class="osi-case-note">D17 '+esc(label(sealBootstrap.tier||'disabled'))+' &middot; '+esc(sealBootstrap.actual_support_count||0)+' / '+esc(sealBootstrap.required_support_count||0)+' '+esc(t('analysts'))+' &middot; '+esc(Number(sealBootstrap.actual_support_weight||0).toFixed(2))+' / '+esc(Number(sealBootstrap.required_support_weight||0).toFixed(2))+' '+esc(t('weight'))+'</div>'+(sealBootstrap.can_finalize===true?'<button class="osi-action primary" type="button" onclick="osiV2GovernanceFinalizeSeal(\'bootstrap\')">'+esc(t('Memo-anchor seal via D17'))+'</button>':'<button class="osi-action" disabled title="'+esc(bootstrapReason(sealBootstrap.reason_code))+'">'+esc(t('D17 seal unavailable'))+'</button>'):'')+'</div>';
    }
    var conflictNotice=(selectionConflict&&selectionStandard.can_finalize!==true)||(sealConflict&&sealStandard.can_finalize!==true)?'<div class="osi-state-message warning" role="status"><b>'+esc(t('Conflict: this exact governance review is unavailable to this wallet.'))+'</b><span>'+esc(conflictMessage())+'</span></div>':'';
    var taskNotice=!conflictNotice&&(caps.analyst_eligible===true||caps.maintainer_access===true)&&(((!row||row.state==='selection_open')&&!selectionTask)||(row&&row.state==='in_challenge_window'&&!sealTask))
      ?'<div class="osi-state-message" role="status"><b>'+esc(t('Review actions open from My Reviews'))+'</b><span>'+esc(reviewTaskRequiredMessage())+'</span></div>':'';
    return '<section class="osi-case-section"><div class="osi-section-heading"><div><span class="osi-eyebrow">Exact-version governance</span><h3>Resolution</h3></div><span class="osi-chip">'+esc(row?label(row.state):'Selection not started')+'</span></div>'
      +'<div class="osi-resolution-primary"><span>Primary Report version</span><b>'+esc(row&&row.winning_report_version_ref||leader||'Awaiting a unique quorum leader')+'</b></div>'
      +progress(quorum.leader_count||0,quorum.leader_weight||0,quorum.required_count||2,quorum.required_weight||2.5)
      +(quorum.tie_unresolved?'<div class="osi-state-message warning"><b>Tie unresolved</b><span>More independent review is required. A maintainer cannot choose between tied candidates.</span></div>':'')
      +governanceTimeline(row&&row.reviews?row.reviews.filter(function(review){return review.phase==='selection';}):[])
      +conflictNotice+taskNotice+selectionForm+'<div class="osi-governance-actions">'+finalize+'</div>'+seal
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
    var eligibleEvidence=(item.challenge_evidence||item.evidence||[]).filter(function(evidence){return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(evidence.challenge_evidence_id||''));});
    var evidenceOptions=eligibleEvidence.map(function(evidence){return'<option value="'+esc(evidence.challenge_evidence_id)+'">'+esc(label(evidence.kind))+' &middot; '+esc(evidence.ref)+'</option>';}).join('');
    var targetCopy='<div class="osi-case-note">'+esc(t('Target: Resolution {resolution} and its bound winning Report version {version}.',{resolution:resolution.public_ref,version:resolution.winning_report_version_ref||t('unavailable')}))+'</div>';
    var submit=active&&walletPubkey&&caps.resolution_lifecycle_writes_enabled===true&&eligibleEvidence.length
      ? '<div class="osi-governance-compose"><h4>'+esc(t('Submit a challenge'))+'</h4>'+targetCopy+'<label>'+esc(t('Public-safe summary'))+'<textarea id="osi-challenge-summary" minlength="20" maxlength="10000" placeholder="'+esc(t('Describe the challenge without restricted material.'))+'"></textarea></label><label>'+esc(t('Existing public evidence'))+'<select id="osi-challenge-evidence">'+evidenceOptions+'</select></label><label>'+esc(t('Restricted detail'))+'<textarea id="osi-challenge-detail" maxlength="10000" placeholder="'+esc(t('Optional restricted context.'))+'"></textarea></label><button class="osi-action primary" type="button" onclick="osiV2GovernanceSubmitChallenge()">'+esc(t('Sign and submit challenge'))+'</button></div>'
      : active&&walletPubkey&&caps.resolution_lifecycle_writes_enabled===true
      ? '<div class="osi-state-message"><b>'+esc(t('Challenge submission unavailable'))+'</b><span>'+esc(t('No public, approved evidence is linked to this Case or its winning Report version. Challenge intake cannot accept a typed internal ID; add/evaluate evidence through the separately governed evidence workflow first.'))+'</span></div>'+targetCopy
      : '<div class="osi-state-message"><b>'+esc(t(active?'Challenge intake requires a connected wallet':'Challenge intake is closed'))+'</b><span>'+esc(t('Submission alone does not block sealing. Only admitted open or under-review challenges block.'))+'</span></div>';
    var list=rows.length?'<div class="osi-challenge-list">'+rows.map(function(row){
      var controls='';var route=caps.analyst_eligible?'analyst':'maintainer';var q=row.outcome_quorum||{};
      var admissibilityTask=activeTaskMatches('challenge_admissibility',row.public_ref);
      var adjudicationTask=activeTaskMatches('challenge_adjudication',row.public_ref);
      var conflicted=activeTaskConflict('challenge_admissibility',row.public_ref)||activeTaskConflict('challenge_adjudication',row.public_ref);
      if(!conflicted&&admissibilityTask&&(row.state==='submitted'||row.state==='admissibility_review')&&(caps.analyst_eligible||caps.maintainer_access))controls='<button class="osi-action" onclick="osiV2GovernanceAdmitChallenge(\''+esc(row.public_ref)+'\',\'accept\',\''+route+'\')">Admit</button><button class="osi-action" onclick="osiV2GovernanceAdmitChallenge(\''+esc(row.public_ref)+'\',\'reject\',\''+route+'\')">Reject admission</button>';
      if(!conflicted&&adjudicationTask&&(row.state==='open'||row.state==='under_review')&&caps.analyst_eligible)controls+='<button class="osi-action" onclick="osiV2GovernanceReviewChallenge(\''+esc(row.public_ref)+'\',\'accept\')">Accept review</button><button class="osi-action" onclick="osiV2GovernanceReviewChallenge(\''+esc(row.public_ref)+'\',\'reject\')">Reject review</button>';
      if(row.challenger_wallet===walletPubkey&&['submitted','admissibility_review','open','under_review'].indexOf(row.state)>=0)controls+='<button class="osi-action" onclick="osiV2GovernanceWithdrawChallenge(\''+esc(row.public_ref)+'\')">Withdraw</button>';
      if(!conflicted&&adjudicationTask&&row.state==='under_review'&&caps.analyst_eligible&&challengeOutcome(row.outcome_quorum))controls+='<button class="osi-action primary" onclick="osiV2GovernanceFinalizeChallenge(\''+esc(row.public_ref)+'\')">Memo-anchor quorum outcome</button>';
      var conflictNotice=conflicted?'<div class="osi-state-message warning" role="status"><b>'+esc(t('Conflict: this exact governance action is unavailable to this wallet.'))+'</b><span>'+esc(conflictMessage())+'</span></div>':'';
      var taskNotice=!conflicted&&(caps.analyst_eligible||caps.maintainer_access)&&(((row.state==='submitted'||row.state==='admissibility_review')&&!admissibilityTask)||((row.state==='open'||row.state==='under_review')&&!adjudicationTask))
        ?'<div class="osi-state-message" role="status"><b>'+esc(t('Review actions open from My Reviews'))+'</b><span>'+esc(reviewTaskRequiredMessage())+'</span></div>':'';
      return'<article class="osi-challenge-record"><div class="osi-list-item-head"><b>'+esc(row.public_ref)+'</b><span class="osi-chip '+(row.blocking?'warning':'')+'">'+esc(label(row.state))+' &middot; '+(row.blocking?'Blocking':'Non-blocking')+'</span></div><p data-osi-user-content>'+esc(row.public_safe_summary)+'</p><div class="osi-case-meta"><div><span>Admissibility deadline</span><b>'+esc(dateText(row.admissibility_deadline_at))+'</b></div><div><span>Review deadline</span><b>'+esc(dateText(row.review_deadline_at))+'</b></div></div>'+governanceTimeline(row.reviews)+progress(q.accept_count||0,q.accept_weight||0,q.required_count||2,q.required_weight||2.5)+conflictNotice+taskNotice+'<div class="osi-governance-actions">'+controls+'</div></article>';
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
    var pendingRecovery=state.paymentPending&&state.paymentPending.caseRef===item.public_ref;
    var payReady=owner&&!pendingRecovery&&caps.payment_writes_enabled===true&&pledge&&['payment_ready','partially_fulfilled','verification_failed'].indexOf(pledge.status)>=0&&String(pledge.outstanding_lamports)!=='0';
    var unpaidPledge=owner&&pledge&&String(pledge.outstanding_lamports)!=='0';
    var payReason=pendingRecovery?(state.paymentPending.method==='solana_pay'?'Resume the exact bound Solana Pay request before preparing another payment.':'Re-verify the already submitted signature before preparing another payment.'):item.stage==='in_challenge_window'?'Challenge window must end and the Case must be sealed before the winner can be paid.':caps.payment_writes_enabled!==true?'Native SOL payments remain disabled until rollout checks pass.':'The exact winning Report version and sealed recipient are not final yet.';
    var payControl=payReady?'<div class="osi-payment-compose"><h4>Pay sealed winner</h4><p>Server-derived recipient <span class="mono">'+esc(short(pledge.winning_report_author_wallet))+'</span> for exact winning version <span class="mono">'+esc(pledge.winning_report_version_ref)+'</span>.</p><label>Partial or full SOL amount<input id="osi-reward-pay-amount" type="text" inputmode="decimal" autocomplete="off" value="'+esc(solFromLamports(pledge.outstanding_lamports))+'"></label><button class="osi-action primary" type="button" onclick="osiV2PayReward()">Review direct transfer</button></div>':unpaidPledge?'<div class="osi-payment-compose"><h4>Pay sealed winner</h4><p>'+esc(payReason)+'</p><button class="osi-action" type="button" disabled title="'+esc(payReason)+'">Payment unavailable</button></div>':'';
    var supportOptions=(money.support_options||[]).filter(function(option){return option.wallet!==String(walletPubkey||'');});var supportGroups={};supportOptions.forEach(function(option){(supportGroups[option.target_ref]||(supportGroups[option.target_ref]=[])).push(option);});
    var support=!pendingRecovery&&Object.keys(supportGroups).length&&caps.payment_writes_enabled===true?'<div class="osi-payment-compose"><h4>Support contributors</h4><p>Select up to four recipients for one atomic System Program transaction. Each amount is exact native SOL.</p>'+Object.keys(supportGroups).map(function(versionRef,groupIndex){return'<fieldset class="osi-support-group"><legend>'+esc(versionRef)+'</legend>'+supportGroups[versionRef].map(function(option,index){var key=groupIndex+'-'+index;return'<label class="osi-support-recipient"><input type="checkbox" data-support-check="'+key+'" data-target-type="'+esc(option.target_type)+'" data-target-ref="'+esc(option.target_ref)+'" data-wallet="'+esc(option.wallet)+'"><span>'+esc(option.label)+' / '+esc(short(option.wallet))+'</span><input type="text" inputmode="decimal" autocomplete="off" data-support-amount="'+key+'" placeholder="0.1 SOL" aria-label="SOL amount for '+esc(option.label)+'"></label>';}).join('')+'<button class="osi-action primary" type="button" onclick="osiV2SupportContributors(\''+esc(versionRef)+'\')">Review atomic support</button></fieldset>';}).join('')+'</div>':'';
    var summary=pledge?'<div class="osi-case-meta"><div><span>Pledge</span><b>'+esc(solFromLamports(pledge.amount_lamports))+' SOL</b></div><div><span>Server-derived status</span><b>'+esc(label(pledge.status))+'</b></div><div><span>Confirmed</span><b>'+esc(solFromLamports(pledge.confirmed_lamports))+' SOL</b></div><div><span>Outstanding</span><b>'+esc(solFromLamports(pledge.outstanding_lamports))+' SOL</b></div></div>':'<div class="osi-state-message"><b>No reward pledge</b><span>A Case intake reward intent is not a pledge and cannot be paid.</span></div>';
    var rows=(pledge&&pledge.payments||[]).concat(money.confirmed_support||[]);var history=rows.length?'<div class="osi-list">'+rows.map(function(row){return'<div class="osi-list-item"><div class="osi-list-item-head"><b>'+esc(row.support_type?'Voluntary support':'Reward payment')+' / '+esc(solFromLamports(row.amount_lamports))+' SOL</b><span class="osi-proof-label">'+esc(label(row.state))+'</span></div><p>'+esc(dateText(row.confirmed_at))+'</p>'+paymentProofLink(row)+'</div>';}).join('')+'</div>':'';
    var retry=pendingRecovery?'<div class="osi-state-message warning" role="status" aria-live="polite"><b>Do not start a second payment</b><span>'+(state.paymentPending.method==='solana_pay'?'A single-use Solana Pay request is already bound to this exact intent. Resume it; OSI still shows unpaid until finalized RPC verification succeeds.':'SOL was already submitted with signature <span class="mono">'+esc(short(state.paymentPending.txSig))+'</span>, but OSI has not confirmed its receipt. Re-run trusted verification of this same signature before preparing any replacement payment.')+'</span><button class="osi-action primary" type="button" onclick="osiV2RetryPayment()">'+(state.paymentPending.method==='solana_pay'?'Resume Solana Pay':'Re-verify existing signature')+'</button></div>':'';
    return '<section class="osi-case-section"><div class="osi-section-heading"><div><span class="osi-eyebrow">Native SOL / mainnet</span><h3>Rewards & Support</h3></div><span class="osi-chip">Pledged, not escrowed</span></div>'+summary+retry+pledgeControls+payControl+support+history+'<div class="osi-case-note">A pledge records intent only and never moves SOL. All transfers are voluntary, direct wallet-to-wallet native SOL. OSI never holds funds, provides escrow, or takes commission. A payment or support receipt does not affect ranking, review weight, governance, truth, guilt, legal certainty, or recovery.</div></section>';
  }
  function renderTab(){
    var item=state.current;if(!item)return;
    if(state.tab!=='ai_pack'&&typeof window.osiV2AiPackClear==='function')window.osiV2AiPackClear();
    var aiPackAvailable=typeof window.osiV2AiPackRender==='function';
    var html=state.tab==='overview'?overview(item)
      :state.tab==='evidence'?evidence(item)
      :state.tab==='reports'?reports(item)
      :state.tab==='reviews'?reviews(item)
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
  // Exact reason text for a control the server says this wallet may not use.
  // A disabled control has to name its unmet prerequisite; it must never sit
  // there inert.
  var OPENING_REASON_TEXT={
    case_writes_disabled:'Case writes are safely disabled while rollout checks are incomplete.',
    case_not_in_initial_review:'This Case is not in private initial review, so there is no public-open transition to anchor.',
    case_owner_conflict:'A Case owner cannot review or open their own Case.',
    not_eligible_reviewer:'This wallet is not an eligible analyst and does not hold full maintainer access.',
    no_active_approve_open_review:'Record an approve-open review from this wallet first.',
    approval_not_counted:'This wallet’s approval is not counted. Its Solana Attestation credential did not verify.',
    analyst_open_quorum_not_ready:'The analyst opening threshold is not met yet: at least one counted analyst and total weight 0.50.',
    maintainer_open_path_not_ready:'The full maintainer opening path is not active for this Case.',
    rejection_quorum_ready:'An independent analyst rejection quorum is ready, so public opening is blocked.',
    open_path_unavailable:'No authorized opening path is available to this wallet for this Case.'
  };
  function openingReasonText(code){
    return OPENING_REASON_TEXT[String(code||'')]||t('This publication path is not available to this wallet yet.');
  }
  // The server-derived opening capability is authoritative when present. It is
  // computed by osi_v2_case_opening_capabilities(), the read-only mirror of the
  // same gate the write path enforces, so it is SAS-aware in exactly the way the
  // old client-side weight arithmetic below was not. The legacy derivation stays
  // only as a fallback for a projection served before the capability RPC exists.
  function openingCapability(item){
    var capability=item&&item.opening_capability;
    return capability&&typeof capability==='object'?capability:null;
  }
  function activeOpeningRoute(item){
    var capability=openingCapability(item);
    if(capability){
      if(capability.can_anchor_public_open!==true)return'';
      return capability.decision_channel==='maintainer_bootstrap'?'maintainer':'analyst';
    }
    var wallet=String(walletPubkey||'');var caps=state.capabilities||{};
    var cycle=reviewCycleStartedAt(item);
    var rejects=(item.reviews||[]).filter(function(row){return row.is_active===true&&row.reviewer_role==='analyst'&&row.decision==='reject'&&new Date(row.created_at).getTime()>cycle;});
    if(rejects.length>=2&&rejects.reduce(function(sum,row){return sum+Number(row.weight||0);},0)>=2)return'';
    var own=(item.reviews||[]).find(function(row){return row.is_active===true&&row.decision==='approve_open'&&new Date(row.created_at).getTime()>cycle&&String(row.reviewer_wallet)===wallet;});
    if(!own)return'';
    if(own.reviewer_role==='maintainer')return caps.maintainer_access===true?'maintainer':'';
    var approvals=(item.reviews||[]).filter(function(row){return row.is_active===true&&row.reviewer_role==='analyst'&&row.decision==='approve_open'&&new Date(row.created_at).getTime()>cycle;});
    return caps.analyst_eligible===true&&approvals.length>=1&&approvals.reduce(function(sum,row){return sum+Number(row.weight||0);},0)>=0.5?'analyst':'';
  }
  function reviewCycleStartedAt(item){
    return (item.proof_log||[]).filter(function(row){return row.event_type==='CASE_APPEAL_SUBMITTED';})
      .reduce(function(latest,row){return Math.max(latest,new Date(row.occurred_at).getTime()||0);},0);
  }
  function activeRejectionReady(item){
    var wallet=String(walletPubkey||''),cycle=reviewCycleStartedAt(item),caps=state.capabilities||{};
    var reviews=(item.reviews||[]).filter(function(row){return row.is_active===true&&row.reviewer_role==='analyst'&&row.decision==='reject'&&new Date(row.created_at).getTime()>cycle;});
    var own=reviews.some(function(row){return String(row.reviewer_wallet)===wallet;});
    var approvals=(item.reviews||[]).filter(function(row){return row.is_active===true&&row.reviewer_role==='analyst'&&row.decision==='approve_open'&&new Date(row.created_at).getTime()>cycle;});
    return caps.analyst_eligible===true&&own&&reviews.length>=2
      &&reviews.reduce(function(sum,row){return sum+Number(row.weight||0);},0)>=2
      &&!(approvals.length>=1&&approvals.reduce(function(sum,row){return sum+Number(row.weight||0);},0)>=0.5);
  }
  // A Case shows the review surface when the server says this wallet has a real
  // initial-review or public-open capability on it, or when the reader is in the
  // review queue looking at a private intake. Mode alone is no longer the gate.
  function reviewSurfaceAvailable(item){
    if(String(item&&item.visibility||'')!=='private')return false;
    var capability=openingCapability(item);
    if(capability){
      return capability.can_cast_initial_review===true
        ||capability.can_anchor_public_open===true
        ||(capability.actor_is_eligible_analyst===true||capability.actor_is_full_maintainer===true);
    }
    return state.mode==='review';
  }
  function renderActions(){
    var host=document.getElementById('osi-case-actions');var item=state.current;if(!host||!item)return;
    if(item.stage==='initial_rejected'&&state.mode==='mine'){
      host.innerHTML='<span class="osi-action-help">The rejection is retained with its Memo proof. Appeal only with a new evidence reference; the original submission is never rewritten.</span><button class="osi-action primary" type="button" onclick="osiV2ComposeCaseAppeal()">Appeal with new evidence</button>';
    }else if(reviewSurfaceAvailable(item)){
      // Review and publication controls follow the server-derived capability,
      // not the surface the reader happened to arrive from. An eligible analyst
      // who opens the same Case from a shared link now sees the same authorized
      // actions the review queue offers, and a wallet the write path would
      // refuse sees a disabled control that names the exact prerequisite.
      var capability=openingCapability(item);
      var openingRoute=activeOpeningRoute(item);
      var rejectionReady=activeRejectionReady(item);
      var conflicted=activeTaskConflict('initial_open');
      var canReview=capability?capability.can_cast_initial_review===true:!conflicted;
      var reviewReason=capability&&capability.initial_review_reason_code
        ?openingReasonText(capability.initial_review_reason_code):conflictMessage();
      var openBlocked=!openingRoute&&capability&&capability.public_open_reason_code
        &&['case_owner_conflict','case_not_in_initial_review'].indexOf(capability.public_open_reason_code)<0;
      host.innerHTML='<span class="osi-action-help">'+esc(conflicted?conflictMessage():'Reviews use signMessage. Public opening requires either the analyst threshold or a full double-gated maintainer approval, then a separate confirmed Solana Memo. It authorizes public investigation only; it does not determine truth or guilt.')+'</span>'
        +(canReview&&!conflicted?'<button class="osi-action" type="button" onclick="osiV2ComposeReview()">Record review</button>':'<button class="osi-action" type="button" disabled title="'+esc(reviewReason)+'">'+esc(t('Review unavailable'))+'</button>')
        +(openingRoute&&!conflicted
          ?'<button class="osi-action primary" type="button" onclick="osiV2AnchorOpen()">Anchor public open</button>'
          :(openBlocked?'<button class="osi-action" type="button" disabled title="'+esc(openingReasonText(capability.public_open_reason_code))+'">'+esc(t('Anchor public open'))+'</button>':''))
        +(rejectionReady&&!conflicted?'<button class="osi-action" type="button" onclick="osiV2AnchorCaseRejection()">Anchor normal rejection</button>':'')
        +(openBlocked?'<span class="osi-action-help">'+esc(openingReasonText(capability.public_open_reason_code))+'</span>':'');
    }else if(item.visibility==='private'){
      host.innerHTML='<span class="osi-action-help">Private and awaiting an eligible analyst or full maintainer review. Case owners cannot self-review.</span><button class="osi-action" disabled title="Requires an eligible analyst or full maintainer">Awaiting review</button>';
    }else{
      // Report intake accepts exactly these stages server-side. Offering the
      // action outside them opened a wallet prompt only to fail on the
      // capability check, which is the dormant-control problem in its most
      // expensive form.
      var intakeOpen=['open_public','in_review','reopened'].indexOf(String(item.stage||''))>=0;
      var intakeHelp=intakeOpen
        ? t('Contribute findings to this public investigation. Reports remain private until reviewed publication.')
        : t('This Case is past Report intake at stage {stage}. Its record stays readable and its proof stays verifiable.',{stage:t(stageLabel(item.stage,item))});
      var submit=intakeOpen
        ? '<button class="osi-action primary" type="button" onclick="osiV2OpenReportForm(\''+esc(item.public_ref)+'\')">'+esc(t('Submit Report'))+'</button>'
        : '<button class="osi-action" type="button" disabled title="'+esc(t('Report intake is open only while a Case is in public investigation, under Report review, or reopened.'))+'">'+esc(t('Report intake closed'))+'</button>';
      // The four Inspect buttons that used to sit here only switched tabs, and
      // the tab bar they duplicated is always on screen directly above, with a
      // horizontal scroll on narrow viewports. What the bar cannot say is how
      // many Reports a Case actually holds, and Reports is where a person goes
      // next after reading the intake or filing one, so the shortcut carries the
      // count and the rest go.
      var reportCount=(item.reports||[]).length;
      var reportsAuthorized=!!(state.capabilities&&(state.capabilities.analyst_eligible===true||state.capabilities.maintainer_access===true));
      var reportsLabel=(reportsAuthorized?t('Reports'):t('Published Reports'))+' ('+reportCount+')';
      host.innerHTML='<span class="osi-action-help">'+esc(intakeHelp)+'</span>'+submit
        +'<button class="osi-action" type="button" onclick="osiV2ShowTab(\'reports\')">'+esc(reportsLabel)+'</button>';
    }
  }
  async function composeReview(){
    var generation=privateGeneration();
    state.tab='reviews';drawTabs();renderTab();
    var caps=state.capabilities||await refreshCapabilities()||{};
    assertPrivateGeneration(generation);
    var host=document.getElementById('osi-review-compose');if(!host)return;
    if(activeTaskConflict('initial_open')){
      host.innerHTML='<div class="osi-state-message warning" role="status"><b>'+esc(t('Conflict: this exact governance action is unavailable to this wallet.'))+'</b><span>'+esc(conflictMessage())+'</span></div>';
      return;
    }
    if(caps.analyst_eligible!==true&&caps.maintainer_access!==true){
      host.innerHTML='<div class="osi-state-message warning" role="status"><b>'+esc(t('Review unavailable'))+'</b><span>'+esc(t('Eligible analyst or full maintainer access is required.'))+'</span></div>';
      return;
    }
    var route=caps.analyst_eligible?'analyst':'maintainer';
    var routeChoices=caps.analyst_eligible&&caps.maintainer_access?'<label>Credential route<select id="osi-review-route"><option value="analyst">Counted analyst review</option><option value="maintainer">Full maintainer initial-open review</option></select></label>':'<input id="osi-review-route" type="hidden" value="'+route+'">';
    host.innerHTML='<div class="osi-review-form"><div class="osi-review-route">'+(route==='analyst'?'Analyst decisions use server-derived SAS-valid weight. Normal rejection needs at least 2 independent analysts and total weight 2.00.':'The full maintainer path has analyst weight 0 and independently authorizes initial open after both maintainer gates pass.')+' This records process authority; it is not a truth or guilt decision.</div>'+routeChoices+'<label>Decision<select id="osi-review-decision"><option value="approve_open">Approve public open</option><option value="needs_more">Needs more evidence</option><option value="reject" data-analyst-only="true">Reject normal investigation</option></select></label><label>Reason code<select id="osi-review-reason"><option value="public_scope_clear">Public scope clear</option><option value="needs_more_evidence">Needs more evidence</option><option value="unsafe_or_prohibited">Unsafe or prohibited</option><option value="duplicate_or_out_of_scope">Duplicate or out of scope</option></select></label><p class="osi-action-help">A reject vote is wallet-signed. The terminal rejection is a separate Solana Memo after the full analyst quorum; maintainers cannot replace it.</p><button class="osi-action primary" id="osi-review-submit" type="button">Sign and record review</button><div class="osi-form-status mono" id="osi-review-status" role="status"></div></div>';
    var routeSelect=document.getElementById('osi-review-route');
    function syncReviewRoute(){var decision=document.getElementById('osi-review-decision');var reject=decision&&decision.querySelector('[value="reject"]');var maintainer=routeSelect&&routeSelect.value==='maintainer';if(reject)reject.disabled=maintainer;if(maintainer&&decision.value==='reject')decision.value='approve_open';}
    if(routeSelect&&routeSelect.tagName==='SELECT')routeSelect.addEventListener('change',syncReviewRoute);syncReviewRoute();
    document.getElementById('osi-review-submit').addEventListener('click',submitReview);
  }
  function reviewStatus(text,kind){var node=document.getElementById('osi-review-status');if(node){node.textContent=text;node.className='osi-form-status mono '+(kind||'');}}
  async function submitReview(){
    if(state.reviewBusy||!state.current)return;
    var generation=privateGeneration(),anchorAfter=false,rejectAfter=false;
    state.reviewBusy=true;var button=document.getElementById('osi-review-submit');if(button)button.disabled=true;
    try{
      var wallet=await ensureWallet();var route=document.getElementById('osi-review-route').value;
      assertPrivateGeneration(generation);
      var review={case_ref:state.current.public_ref,decision:document.getElementById('osi-review-decision').value,reason_code:document.getElementById('osi-review-reason').value};
      if(route==='maintainer'&&review.decision!=='approve_open')throw new Error('The full maintainer path can only record approve_open.');
      reviewStatus('Preparing an exact single-use review message...');
      var prepared=await api(WRITE_URL,{op:'prepare_review',wallet:wallet,route:route,review:review,idempotency_key:randomKey('review')});
      assertPrivateGeneration(generation);
      reviewStatus('Sign the review message. This is not an on-chain transaction.');
      var signature=await signMessage(prepared.message);
      assertPrivateGeneration(generation);
      var committed=await api(WRITE_URL,{op:'commit_review',wallet:wallet,route:route,review:review,nonce:prepared.nonce,message:prepared.message,signature:signature});
      assertPrivateGeneration(generation);
      reviewStatus('Review recorded as wallet-signed and server-verified.','success');
      showToast('Initial review recorded.');
      var reviewDrawerToken=state.drawerLoadToken;
      await openSignedCollection('review',{keepDrawer:true,authorize:true});
      assertPrivateGeneration(generation);
      var refreshed=state.cases.find(function(item){return item.public_ref===review.case_ref;});
      // Skip the reopen when a newer drawer intent (a close, or another Case)
      // landed while the authorized queue reloaded.
      if(refreshed&&reviewDrawerToken===state.drawerLoadToken)await openCase(refreshed.public_ref);
      assertPrivateGeneration(generation);
      anchorAfter=committed.actor_open_ready&&review.decision==='approve_open'&&confirm('This initial-open path is ready. Anchor CASE_OPENED on Solana now? This uses only the standard network fee.');
      rejectAfter=committed.actor_reject_ready&&review.decision==='reject'&&confirm('The independent rejection quorum is ready. Anchor CASE_INITIAL_REVIEW_REJECTED on Solana now? This uses only the standard network fee.');
    }catch(error){if(generation===privateGeneration())reviewStatus(userError(error),'error');}
    finally{if(generation===privateGeneration()){state.reviewBusy=false;if(button)button.disabled=false;}}
    if(anchorAfter&&generation===privateGeneration())await anchorOpen(route);
    if(rejectAfter&&generation===privateGeneration())await anchorCaseRejection();
  }
  async function anchorOpen(route){
    if(state.reviewBusy||!state.current)return;
    var generation=privateGeneration();
    state.reviewBusy=true;
    try{
      var wallet=await ensureWallet();var ref=state.current.public_ref;
      assertPrivateGeneration(generation);
      route=route||activeOpeningRoute(state.current);
      if(!route)throw new Error('not_eligible_reviewer');
      showToast('Preparing the canonical CASE_OPENED Memo...');
      var prepared=await api(WRITE_URL,{op:'prepare_open',wallet:wallet,route:route,case_ref:ref,idempotency_key:randomKey('open')});
      assertPrivateGeneration(generation);
      var txSig=await castOnchainVote(prepared.memo);
      assertPrivateGeneration(generation);
      var committed=await commitWithConfirmation({op:'commit_open',wallet:wallet,route:route,case_ref:ref,nonce:prepared.nonce,memo:prepared.memo,tx_sig:txSig},WRITE_URL,generation);
      assertPrivateGeneration(generation);
      showToast('Case '+committed.case.public_ref+' is now public with confirmed Memo proof.');
      closeCase();
      var anchorDrawerToken=state.drawerLoadToken;
      await loadPublicCases();assertPrivateGeneration(generation);
      if(anchorDrawerToken===state.drawerLoadToken)await openCase(ref);
      assertPrivateGeneration(generation);
    }catch(error){if(generation===privateGeneration())showToast(userError(error));}
    finally{if(generation===privateGeneration())state.reviewBusy=false;}
  }

  async function anchorCaseRejection(){
    if(state.reviewBusy||!state.current)return;
    var generation=privateGeneration();state.reviewBusy=true;
    try{
      var wallet=await ensureWallet(),ref=state.current.public_ref;assertPrivateGeneration(generation);
      showToast('Preparing the canonical CASE_INITIAL_REVIEW_REJECTED Memo...');
      var prepared=await api(WRITE_URL,{op:'prepare_rejection',wallet:wallet,case_ref:ref,idempotency_key:randomKey('case-reject')});
      assertPrivateGeneration(generation);var txSig=await castOnchainVote(prepared.memo);assertPrivateGeneration(generation);
      await commitWithConfirmation({op:'commit_rejection',wallet:wallet,case_ref:ref,nonce:prepared.nonce,memo:prepared.memo,tx_sig:txSig},WRITE_URL,generation);
      assertPrivateGeneration(generation);showToast('Case rejected by independent analyst quorum with confirmed Memo proof.');
      closeCase();await openSignedCollection('review',{authorize:true});
    }catch(error){if(generation===privateGeneration())showToast(userError(error));}
    finally{if(generation===privateGeneration())state.reviewBusy=false;}
  }

  function composeCaseAppeal(){
    var host=document.getElementById('osi-case-actions'),item=state.current;if(!host||!item||item.stage!=='initial_rejected')return;
    host.innerHTML='<div class="osi-review-form"><div class="osi-review-route">Appeal starts a fresh review cycle and appends one new private evidence reference. It does not erase the rejection or rewrite the original Case.</div><label>Appeal reason<select id="osi-appeal-reason"><option value="new_evidence">New evidence</option><option value="scope_clarified">Scope clarified</option><option value="submission_corrected">Submission corrected</option></select></label><label>Evidence type<select id="osi-appeal-evidence-kind"><option value="url">HTTPS URL</option><option value="onchain_tx">Solana transaction</option><option value="wallet">Wallet address</option></select></label><label>New evidence reference<input id="osi-appeal-evidence-ref" type="text" maxlength="4096" autocomplete="off" placeholder="https://..." required></label><button class="osi-action primary" id="osi-appeal-submit" type="button">Sign and submit appeal</button><button class="osi-action" id="osi-appeal-cancel" type="button">Cancel</button><div class="osi-form-status mono" id="osi-appeal-status" role="status"></div></div>';
    document.getElementById('osi-appeal-submit').addEventListener('click',submitCaseAppeal);
    document.getElementById('osi-appeal-cancel').addEventListener('click',renderActions);
    document.getElementById('osi-appeal-evidence-ref').focus();
  }
  function appealStatus(text,kind){var node=document.getElementById('osi-appeal-status');if(node){node.textContent=text;node.className='osi-form-status mono '+(kind||'');}}
  async function submitCaseAppeal(){
    if(state.reviewBusy||!state.current)return;var generation=privateGeneration();state.reviewBusy=true;
    var button=document.getElementById('osi-appeal-submit');if(button)button.disabled=true;
    try{
      var wallet=await ensureWallet(),ref=String(document.getElementById('osi-appeal-evidence-ref').value||'').trim();assertPrivateGeneration(generation);
      if(!ref)throw new Error('appeal_requires_new_evidence');
      var appeal={case_ref:state.current.public_ref,reason_code:document.getElementById('osi-appeal-reason').value,evidence:[{kind:document.getElementById('osi-appeal-evidence-kind').value,ref:ref}]};
      appealStatus('Preparing one exact owner appeal message...');
      var prepared=await api(WRITE_URL,{op:'prepare_appeal',wallet:wallet,appeal:appeal,idempotency_key:randomKey('case-appeal')});
      assertPrivateGeneration(generation);appealStatus('Sign the appeal message. This is not an on-chain transaction.');
      var signature=await signMessage(prepared.message);assertPrivateGeneration(generation);
      await api(WRITE_URL,{op:'commit_appeal',wallet:wallet,appeal:appeal,nonce:prepared.nonce,message:prepared.message,signature:signature});
      assertPrivateGeneration(generation);appealStatus('Appeal submitted. A fresh initial-review cycle is open.','success');showToast('Appeal submitted with new evidence.');
      var caseRef=state.current.public_ref;await openSignedCollection('mine',{keepDrawer:true,authorize:true});assertPrivateGeneration(generation);
      var refreshed=state.cases.find(function(item){return item.public_ref===caseRef;});if(refreshed)await openCase(caseRef);
    }catch(error){if(generation===privateGeneration())appealStatus(userError(error),'error');}
    finally{if(generation===privateGeneration()){state.reviewBusy=false;if(button)button.disabled=false;}}
  }

  async function reloadGovernanceCase(caseRef){
    var activeTask=state.activeReviewTask;
    var drawerToken=state.drawerLoadToken;
    if(state.mode==='public')await loadPublicCases();
    else await openSignedCollection(state.mode,{keepDrawer:true,authorize:true});
    // A close or another Case opened during the reload is a newer intent.
    if(drawerToken!==state.drawerLoadToken)return;
    await openCase(caseRef,activeTask);
  }
  async function governanceMutation(action,targetRef,payload,options){
    options=options||{};
    if(state.governanceBusy||(!state.current&&options.allowDetached!==true))return;
    var generation=privateGeneration();
    state.governanceBusy=true;
    var caseRef=options.caseRef||state.current&&state.current.public_ref||'';
    try{
      var wallet=await ensureWallet();
      assertPrivateGeneration(generation);
      var prepared=await api(GOVERNANCE_URL,{op:'prepare',action:action,wallet:wallet,target_ref:targetRef,payload:payload,idempotency_key:randomKey('governance')});
      assertPrivateGeneration(generation);
      if(prepared.already_committed){showToast('This exact governance action was already committed.');if(typeof options.afterCommit==='function')await options.afterCommit();else if(caseRef)await reloadGovernanceCase(caseRef);assertPrivateGeneration(generation);return;}
      var body={op:'commit',action:action,wallet:wallet,nonce:prepared.nonce,payload:payload,proof_text:prepared.proof_text};
      if(prepared.proof_type==='solana_memo'){
        showToast('Approve the exact '+prepared.purpose+' Memo. Only the network fee is requested.');
        body.tx_sig=await castOnchainVote(prepared.proof_text);
        assertPrivateGeneration(generation);
        await commitWithConfirmation(body,GOVERNANCE_URL,generation);
      }else{
        showToast('Sign the exact '+prepared.purpose+' message. This is not an on-chain transaction.');
        body.signature=await signMessage(prepared.proof_text);
        assertPrivateGeneration(generation);
        await api(GOVERNANCE_URL,body);
      }
      assertPrivateGeneration(generation);
      showToast(label(prepared.purpose)+' recorded with '+(prepared.proof_type==='solana_memo'?'Memo proof.':'wallet-signed proof.'));
      if(typeof options.afterCommit==='function')await options.afterCommit();else if(caseRef)await reloadGovernanceCase(caseRef);
      assertPrivateGeneration(generation);
    }catch(error){if(generation===privateGeneration())showToast(userError(error));}
    finally{if(generation===privateGeneration())state.governanceBusy=false;}
  }
  function resolutionRow(){return state.current&&state.current.governance&&state.current.governance.resolution;}
  function fieldValue(id){var node=document.getElementById(id);return node?String(node.value||'').trim():'';}
  function governanceResolutionReview(){
    if(!requireActiveReviewTask('resolution_selection'))return;
    var version=fieldValue('osi-resolution-version'),decision=fieldValue('osi-resolution-decision');
    var rationale=fieldValue('osi-resolution-rationale');if(rationale.length<10){showToast('Add a public-safe rationale of at least 10 characters.');return;}
    governanceMutation('resolution_review',state.current.public_ref,{phase:'selection',report_version_ref:version,decision:decision,reason_code:'primary_report_assessment',public_rationale:rationale,private_note:fieldValue('osi-resolution-note')||null});
  }
  function governanceFinalizeResolution(channel){
    if(!requireActiveReviewTask('resolution_selection'))return;
    var capability=state.activeReviewTask&&state.activeReviewTask.finalizationCapability;if(!capability)return;
    var bootstrap=String(channel||'')==='bootstrap';var allowed=bootstrap?capability.bootstrap&&capability.bootstrap.can_finalize:capability.standard&&capability.standard.can_finalize;
    if(!allowed){showToast(t('The server-derived finalization prerequisite is no longer met. Refresh My Reviews.'));return;}
    governanceMutation('resolution_finalize',capability.target_public_ref,bootstrap?{report_version_ref:capability.report_version_ref}:{});
  }
  function governanceSealReview(){
    if(!requireActiveReviewTask('seal_reviews'))return;
    var row=resolutionRow();if(!row)return;
    var rationale=window.prompt('Public-safe seal rationale. Explain why the exact process is complete; do not claim truth or guilt.','The exact resolution completed its challenge window with no active blocking challenge.');
    if(rationale===null)return;rationale=String(rationale).trim();if(rationale.length<10){showToast('The public-safe rationale must be at least 10 characters.');return;}
    governanceMutation('resolution_review',state.current.public_ref,{phase:'seal',report_version_ref:row.winning_report_version_ref,decision:'select',reason_code:'process_window_complete',public_rationale:rationale,private_note:null});
  }
  function governanceFinalizeSeal(channel){
    if(!requireActiveReviewTask('seal_reviews'))return;
    var capability=state.activeReviewTask&&state.activeReviewTask.finalizationCapability;if(!capability)return;
    var bootstrap=String(channel||'')==='bootstrap';var allowed=bootstrap?capability.bootstrap&&capability.bootstrap.can_finalize:capability.standard&&capability.standard.can_finalize;
    if(!allowed){showToast(t('The server-derived seal prerequisite is no longer met. Refresh My Reviews.'));return;}
    governanceMutation('seal_finalize',capability.target_public_ref,{});
  }
  function governanceSubmitChallenge(){
    var row=resolutionRow();if(!row)return;
    var summary=fieldValue('osi-challenge-summary'),evidence=fieldValue('osi-challenge-evidence');
    if(summary.length<20){showToast('The public-safe challenge summary must be at least 20 characters.');return;}
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(evidence)){showToast(t('Select public, approved evidence linked to this Case or its winning Report version.'));return;}
    governanceMutation('challenge_submit',row.public_ref,{reason_code:'material_evidence_challenge',public_safe_summary:summary,restricted_detail:fieldValue('osi-challenge-detail')||null,evidence_item_id:evidence});
  }
  function governanceAdmitChallenge(ref,decision,route){if(!requireActiveReviewTask('challenge_admissibility',ref))return;governanceMutation('challenge_admit',ref,{decision:decision,route:route});}
  function governanceReviewChallenge(ref,decision){
    if(!requireActiveReviewTask('challenge_adjudication',ref))return;
    var rationale=window.prompt('Public-safe challenge review rationale.','The submitted evidence was reviewed against the exact selected Report version.');
    if(rationale===null)return;rationale=String(rationale).trim();if(rationale.length<10){showToast('The public-safe rationale must be at least 10 characters.');return;}
    governanceMutation('challenge_review',ref,{decision:decision,reason_code:decision==='accept'?'material_issue_confirmed':'selected_report_preserved',public_rationale:rationale,private_note:null});
  }
  function governanceWithdrawChallenge(ref){governanceMutation('challenge_withdraw',ref,{});}
  function withdrawMyChallenge(ref){return governanceMutation('challenge_withdraw',ref,{}, {allowDetached:true,afterCommit:function(){return openMyChallenges({authorize:true});}});}
  function governanceFinalizeChallenge(ref){if(!requireActiveReviewTask('challenge_adjudication',ref))return;governanceMutation('challenge_finalize',ref,{});}

  function paymentRecoveryKey(wallet){return PAYMENT_RECOVERY_PREFIX+String(wallet||'');}
  function forgetPaymentRecovery(wallet){
    if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(wallet||'')))return;
    try{localStorage.removeItem(paymentRecoveryKey(wallet));}catch(error){}
  }
  function clearPaymentState(settings){
    settings=settings&&typeof settings==='object'?settings:{};
    var pendingWallet=String(settings.wallet||state.paymentPending&&state.paymentPending.wallet||'');
    var cleanup=state.paymentCleanup;state.paymentCleanup=null;if(typeof cleanup==='function'){try{cleanup(true);}catch(error){}}
    state.paymentPending=null;state.paymentBusy=false;state.paymentWallet='';
    if(settings.forgetRecovery===true)forgetPaymentRecovery(pendingWallet);
    var modal=document.getElementById('osi-payment-review');if(modal)modal.remove();
    var payModal=document.getElementById('osi-solana-pay');if(payModal)payModal.remove();
    var receiptModal=document.getElementById('osi-payment-receipt');if(receiptModal)receiptModal.remove();
  }
  function restorePaymentPending(wallet){
    wallet=String(wallet||'');state.paymentPending=null;state.paymentWallet='';
    if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet))return null;
    try{
      var raw=localStorage.getItem(paymentRecoveryKey(wallet));
      if(!raw){
        var legacy=JSON.parse(localStorage.getItem(PAYMENT_RECOVERY_KEY)||'null');
        if(legacy&&String(legacy.wallet||'')===wallet){
          raw=JSON.stringify(legacy);
          localStorage.setItem(paymentRecoveryKey(wallet),raw);
          localStorage.removeItem(PAYMENT_RECOVERY_KEY);
        }
      }
      var pending=JSON.parse(raw||'null');
      if(!pending||typeof pending!=='object'||!pending.prepared
        ||String(pending.wallet||'')!==wallet
        ||String(pending.prepared.payer_wallet||'')!==wallet
        ||!/^[A-Za-z0-9_-]{32,128}$/.test(String(pending.prepared.nonce||''))
        ||!(pending.method==='solana_pay'
          ?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(pending.prepared.solana_pay&&pending.prepared.solana_pay.reference||''))
          :(/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(String(pending.txSig||''))
            ||(pending.recovery_state==='awaiting_wallet'&&!pending.txSig)))){
        localStorage.removeItem(paymentRecoveryKey(wallet));return null;
      }
      pending.restored_from_storage=true;
      state.paymentPending=pending;state.paymentWallet=wallet;return pending;
    }catch(error){return null;}
  }
  function persistPaymentPending(pending,settings){
    settings=settings||{};var wallet=String(pending&&pending.wallet||'');
    if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)
      ||String(pending&&pending.prepared&&pending.prepared.payer_wallet||'')!==wallet)throw new Error('payment_wallet_changed');
    var serialized=JSON.stringify(pending);
    try{
      localStorage.setItem(paymentRecoveryKey(wallet),serialized);
      if(localStorage.getItem(paymentRecoveryKey(wallet))!==serialized)throw new Error('payment_recovery_unavailable');
    }catch(error){throw new Error('payment_recovery_unavailable');}
    if(settings.expose!==false&&wallet===String(walletPubkey||'')){state.paymentPending=pending;state.paymentWallet=wallet;}
  }
  function paymentStatus(text,kind){var node=document.getElementById('osi-payment-status');if(node){node.textContent=text||'';node.className='osi-form-status mono '+(kind||'');}}
  function trapModalKeys(modal,onClose){
    return function(event){
      if(event.key==='Escape'){
        event.preventDefault();event.stopPropagation();
        if(typeof event.stopImmediatePropagation==='function')event.stopImmediatePropagation();
        onClose();return;
      }
      if(event.key!=='Tab')return;
      var nodes=Array.prototype.filter.call(modal.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])'),function(node){return node.offsetParent!==null;});
      if(!nodes.length){event.preventDefault();return;}
      var first=nodes[0],last=nodes[nodes.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    };
  }
  function solanaPayUnavailableMessage(prepared){
    var count=(prepared.recipient_manifest||[]).length;
    if(count!==1)return t('Solana Pay QR requires exactly one recipient. Use Phantom to keep this multi-recipient transfer atomic.');
    var reason=String(prepared.solana_pay&&prepared.solana_pay.reason||'');
    if(reason==='solana_pay_disabled_or_already_committed')return t('Solana Pay QR is not enabled for this intent. Use Phantom or re-open an existing prepared payment.');
    if(reason==='solana_pay_reference_collision')return t('A unique Solana Pay reference could not be reserved. Use Phantom or prepare the transfer again.');
    return t('The server could not bind a single-use Solana Pay reference. Use Phantom; this transfer is not marked paid.');
  }
  function paymentReview(prepared,preferredMethod){
    return new Promise(function(resolve){
      var old=document.getElementById('osi-payment-review');if(old)old.remove();
      var modal=document.createElement('div');modal.id='osi-payment-review';modal.className='osi-payment-review';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','osi-payment-review-title');
      var recipients=(prepared.recipient_manifest||[]).map(function(row){return'<li><span>'+esc(label(row.recipient_type))+' / '+esc(short(row.wallet))+'</span><b>'+esc(row.amount_sol)+' SOL</b></li>';}).join('');
      var payReady=prepared.solana_pay&&prepared.solana_pay.enabled===true&&(prepared.recipient_manifest||[]).length===1;
      var unavailable=payReady?'':solanaPayUnavailableMessage(prepared);
      var phantomClass=preferredMethod==='solana_pay'?'osi-action':'osi-action primary';
      var payClass=preferredMethod==='solana_pay'?'osi-action primary':'osi-action';
      var alternative='<button type="button" class="'+payClass+'" data-payment-solana-pay'+(payReady?'':' disabled aria-describedby="osi-solana-pay-unavailable" title="'+esc(unavailable)+'"')+'>'+esc(t('Solana Pay QR'))+'</button>';
      var routeNote=!payReady?'<div class="osi-state-message warning" id="osi-solana-pay-unavailable"><b>'+esc(t('Solana Pay QR unavailable'))+'</b><span>'+esc(unavailable)+'</span></div>':'';
      modal.innerHTML='<div class="osi-payment-review-card"><span class="osi-eyebrow">Before any wallet opens</span><h3 id="osi-payment-review-title">Review exact mainnet transfer</h3><dl><div><dt>Network</dt><dd>Solana mainnet-beta</dd></div><div><dt>Payer</dt><dd class="mono">'+esc(prepared.payer_wallet)+'</dd></div><div><dt>Purpose</dt><dd>'+esc(label(prepared.payment_kind))+'</dd></div><div><dt>Total</dt><dd>'+esc(prepared.total_sol)+' SOL / '+esc(prepared.total_lamports)+' lamports</dd></div><div><dt>Target</dt><dd class="mono">'+esc(prepared.target_public_ref)+'</dd></div><div><dt>Canonical Memo</dt><dd class="mono" data-payment-memo>'+esc(prepared.memo)+'</dd></div></dl><ul>'+recipients+'</ul>'+routeNote+'<div class="osi-case-note">This transaction is irreversible. Native SOL goes directly from your wallet to the exact server-derived recipient'+((prepared.recipient_manifest||[]).length===1?'':'s')+'. OSI receives no funds, has no custody or escrow, takes no commission, and support never changes governance, ranking, or review priority.</div><div class="osi-payment-actions"><button type="button" class="osi-action" data-payment-cancel>Cancel</button><button type="button" class="osi-action" data-payment-copy-memo>Copy Memo</button><button type="button" class="'+phantomClass+'" data-payment-phantom>'+esc(t('Pay with Phantom'))+'</button>'+alternative+'</div></div>';
      document.body.appendChild(modal);var prior=document.activeElement,settled=false;
      function finish(value,fromClear){if(settled)return;settled=true;document.removeEventListener('keydown',keyHandler,true);modal.remove();if(state.paymentCleanup===cancelFromClear)state.paymentCleanup=null;if(fromClear!==true&&prior&&document.contains(prior)&&prior.focus)prior.focus();resolve(value);}
      function cancelFromClear(){finish('',true);}
      var previousCleanup=state.paymentCleanup;state.paymentCleanup=cancelFromClear;if(typeof previousCleanup==='function')previousCleanup(true);
      var keyHandler=trapModalKeys(modal,function(){finish('');});
      document.addEventListener('keydown',keyHandler,true);
      modal.querySelector('[data-payment-cancel]').addEventListener('click',function(){finish('');});
      modal.querySelector('[data-payment-copy-memo]').addEventListener('click',async function(){
        try{await navigator.clipboard.writeText(String(prepared.memo||''));}
        catch(error){var memo=modal.querySelector('[data-payment-memo]');if(memo){var range=document.createRange();range.selectNodeContents(memo);var selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);}}
      });
      modal.querySelector('[data-payment-phantom]').addEventListener('click',function(){finish('phantom');});
      var payButton=modal.querySelector('[data-payment-solana-pay]');if(payButton)payButton.addEventListener('click',function(){finish('solana_pay');});
      modal.addEventListener('click',function(event){if(event.target===modal)finish('');});
      ((preferredMethod==='solana_pay'&&payReady?payButton:null)||modal.querySelector('[data-payment-phantom]')).focus();
    });
  }
  function exactPaymentProvider(prepared,expectedWallet,generation){
    assertPrivateGeneration(generation);
    var provider=typeof getProvider==='function'?getProvider():null;
    var activeWallet=String(walletPubkey||'');
    var providerWallet=provider&&provider.publicKey&&typeof provider.publicKey.toString==='function'
      ?provider.publicKey.toString():'';
    if(!provider||provider.isConnected===false||!expectedWallet
      ||String(prepared&&prepared.payer_wallet||'')!==expectedWallet
      ||activeWallet!==expectedWallet||providerWallet!==expectedWallet){
      throw new Error('payment_wallet_changed');
    }
    return provider;
  }
  async function sendPreparedPayment(prepared,expectedWallet,generation,onBroadcast){
    var provider=exactPaymentProvider(prepared,expectedWallet,generation);
    var web3=window.solanaWeb3;if(!web3)throw new Error('Solana transaction library is unavailable.');
    var from=new web3.PublicKey(expectedWallet);var tx=new web3.Transaction();
    (prepared.recipient_manifest||[]).forEach(function(row){
      if(!/^\d+$/.test(String(row.amount_lamports||'')))throw new Error('wrong_amount');
      var amount=Number(row.amount_lamports);if(!Number.isSafeInteger(amount)||amount<=0)throw new Error('wrong_amount');
      tx.add(web3.SystemProgram.transfer({fromPubkey:from,toPubkey:new web3.PublicKey(row.wallet),lamports:amount}));
    });
    tx.add(new web3.TransactionInstruction({keys:[{pubkey:from,isSigner:true,isWritable:false}],programId:new web3.PublicKey(MEMO_PROGRAM_ID),data:new TextEncoder().encode(prepared.memo)}));
    tx.feePayer=from;var blockhash=await fetchRecentBlockhash();if(!blockhash)throw new Error('rpc_unavailable');tx.recentBlockhash=blockhash;
    var bytes=tx.serialize({requireAllSignatures:false,verifySignatures:false});if(bytes.length>1232)throw new Error('Transaction exceeds Solana packet size.');
    var submit=function(){exactPaymentProvider(prepared,expectedWallet,generation);return provider.signAndSendTransaction(tx);};
    var result=typeof window.osiV2ApproveTransaction==='function'?await window.osiV2ApproveTransaction(prepared.memo,submit):await submit();
    if(result&&result.signature&&typeof onBroadcast==='function')onBroadcast(result.signature);
    exactPaymentProvider(prepared,expectedWallet,generation);
    if(!result||!result.signature)throw new Error('Transaction submission was cancelled.');return result.signature;
  }
  async function sendPreparedSolanaPay(prepared,expectedWallet,generation,onBroadcast){
    var provider=exactPaymentProvider(prepared,expectedWallet,generation);
    var web3=window.solanaWeb3,recipient=prepared&&prepared.recipient_manifest&&prepared.recipient_manifest[0];
    if(!web3||!recipient||!/^\d+$/.test(String(recipient.amount_lamports||'')))throw new Error('wrong_amount');
    var amount=Number(recipient.amount_lamports);if(!Number.isSafeInteger(amount)||amount<=0)throw new Error('wrong_amount');
    var from=new web3.PublicKey(expectedWallet),reference=new web3.PublicKey(prepared.solana_pay.reference),tx=new web3.Transaction();
    tx.add(new web3.TransactionInstruction({keys:[],programId:new web3.PublicKey(MEMO_PROGRAM_ID),data:new TextEncoder().encode(prepared.memo)}));
    var transfer=web3.SystemProgram.transfer({fromPubkey:from,toPubkey:new web3.PublicKey(recipient.wallet),lamports:amount});
    transfer.keys.push({pubkey:reference,isSigner:false,isWritable:false});tx.add(transfer);
    tx.feePayer=from;var blockhash=await fetchRecentBlockhash();if(!blockhash)throw new Error('rpc_unavailable');tx.recentBlockhash=blockhash;
    var bytes=tx.serialize({requireAllSignatures:false,verifySignatures:false});if(bytes.length>1232)throw new Error('Transaction exceeds Solana packet size.');
    var submit=function(){exactPaymentProvider(prepared,expectedWallet,generation);return provider.signAndSendTransaction(tx);};
    var result=typeof window.osiV2ApproveTransaction==='function'?await window.osiV2ApproveTransaction(prepared.memo+':'+prepared.solana_pay.reference,submit):await submit();
    if(result&&result.signature&&typeof onBroadcast==='function')onBroadcast(result.signature);
    exactPaymentProvider(prepared,expectedWallet,generation);
    if(!result||!result.signature)throw new Error('Transaction submission was cancelled.');return result.signature;
  }
  function openSolanaPay(pending){
    var generation=privateGeneration();
    var prepared=pending&&pending.prepared;
    if(!window.osiSolanaPay)throw new Error('Solana Pay is unavailable.');
    if(pending&&pending.restored_from_storage===true)throw new Error('payment_recovery_poll_only');
    if(!pending||String(prepared&&prepared.payer_wallet||'')!==String(pending.wallet||''))throw new Error('payment_wallet_changed');
    exactPaymentProvider(prepared,pending.wallet,generation);
    var url=window.osiSolanaPay.buildUrl(prepared);
    var old=document.getElementById('osi-solana-pay');if(old)old.remove();
    var modal=document.createElement('div');modal.id='osi-solana-pay';modal.className='osi-payment-review';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','osi-solana-pay-title');
    var recipient=prepared.recipient_manifest[0];var mobile=window.osiSolanaPay.isMobileDevice();
    var provider=typeof getProvider==='function'?getProvider():null;var connected=!!(provider&&provider.publicKey&&provider.isConnected!==false&&walletPubkey);
    var phantom=connected?'<button class="osi-action primary" type="button" data-solana-pay-phantom>'+esc(t('Use connected Phantom'))+'</button>':'';
    modal.innerHTML='<div class="osi-payment-review-card osi-solana-pay-card"><span class="osi-eyebrow">'+esc(t('Single-use · mainnet-beta'))+'</span><h3 id="osi-solana-pay-title">'+esc(t('Pay with Solana Pay'))+'</h3><div class="osi-solana-pay-grid"><div class="osi-solana-pay-qr" data-solana-pay-qr></div><div><dl><div><dt>'+esc(t('Payer'))+'</dt><dd class="mono">'+esc(prepared.payer_wallet)+'</dd></div><div><dt>'+esc(t('Exact amount'))+'</dt><dd>'+esc(recipient.amount_sol)+' SOL / '+esc(recipient.amount_lamports)+' lamports</dd></div><div><dt>'+esc(t('Recipient'))+'</dt><dd class="mono">'+esc(recipient.wallet)+'</dd></div><div><dt>'+esc(t('Target'))+'</dt><dd class="mono">'+esc(prepared.target_public_ref)+'</dd></div><div><dt>'+esc(t('Reference'))+'</dt><dd class="mono">'+esc(prepared.solana_pay.reference)+'</dd></div><div><dt>'+esc(t('Canonical Memo'))+'</dt><dd class="mono" data-solana-pay-memo>'+esc(prepared.memo)+'</dd></div></dl><p class="osi-solana-pay-timer mono" data-solana-pay-timer></p></div></div><div class="osi-state-message" data-solana-pay-state role="status" aria-live="polite"><b>'+esc(t('Ready'))+'</b><span>'+esc(t('Scan the QR code or explicitly open a compatible wallet. Verify the recipient, amount, network and Memo before approving.'))+'</span></div><div class="osi-payment-actions"><button class="osi-action" type="button" data-solana-pay-close>'+esc(t('Close'))+'</button>'+phantom+'<button class="osi-action" type="button" data-solana-pay-copy>'+esc(t('Copy link'))+'</button><button class="osi-action" type="button" data-solana-pay-copy-memo>'+esc(t('Copy Memo'))+'</button><button class="osi-action" type="button" data-solana-pay-retry>'+esc(t('Check payment'))+'</button><a class="osi-action" data-solana-pay-open href="'+esc(url)+'">'+esc(t(mobile?'Open compatible wallet':'Open compatible wallet app'))+'</a></div><div class="osi-case-note">'+esc(t('The connected Phantom button reuses this exact prepared intent. A QR, copied link, or deep link only offers it to a compatible wallet; OSI does not claim an app was detected. Nothing is marked paid until finalized server verification succeeds.'))+'</div></div>';
    document.body.appendChild(modal);
    window.osiSolanaPay.renderQr(modal.querySelector('[data-solana-pay-qr]'),url);
    var prior=document.activeElement;var stopped=false;var polling=false;var timerId=0;var countdownId=0;
    var stateNode=modal.querySelector('[data-solana-pay-state]'),timerNode=modal.querySelector('[data-solana-pay-timer]');
    function setPayState(title,message,kind){
      if(!stateNode)return;stateNode.className='osi-state-message '+(kind||'');stateNode.innerHTML='<b>'+esc(title)+'</b><span>'+esc(message)+'</span>';
    }
    function close(fromClear){
      stopped=true;clearTimeout(timerId);clearInterval(countdownId);document.removeEventListener('keydown',keyHandler,true);
      modal.remove();if(state.paymentCleanup===close)state.paymentCleanup=null;if(!fromClear&&prior&&document.contains(prior)&&prior.focus)prior.focus();
      if(!fromClear)paymentStatus(t('Solana Pay request closed. Resume the same bound request before starting any replacement payment.'),'warning');
    }
    var previousCleanup=state.paymentCleanup;state.paymentCleanup=close;if(typeof previousCleanup==='function')previousCleanup(true);
    var keyHandler=trapModalKeys(modal,close);document.addEventListener('keydown',keyHandler,true);
    modal.addEventListener('click',function(event){if(event.target===modal)close(false);});
    modal.querySelector('[data-solana-pay-close]').addEventListener('click',function(){close(false);});
    modal.querySelector('[data-solana-pay-copy]').addEventListener('click',async function(){
      if(generation!==privateGeneration())return;
      try{await navigator.clipboard.writeText(url);setPayState(t('Link copied'),t('Paste it only into a compatible Solana wallet and verify every field.'),'success');}
      catch(error){setPayState(t('Copy unavailable'),t('Use the QR code or the explicit wallet link.'),'warning');}
    });
    modal.querySelector('[data-solana-pay-copy-memo]').addEventListener('click',async function(){
      if(generation!==privateGeneration())return;
      try{await navigator.clipboard.writeText(String(prepared.memo||''));setPayState(t('Memo copied'),t('Verify this exact Memo in the wallet before approving.'),'success');}
      catch(error){var memo=modal.querySelector('[data-solana-pay-memo]');if(memo){var range=document.createRange();range.selectNodeContents(memo);var selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);}setPayState(t('Copy unavailable'),t('The exact Memo is selected for manual copying.'),'warning');}
    });
    var phantomButton=modal.querySelector('[data-solana-pay-phantom]');if(phantomButton)phantomButton.addEventListener('click',async function(){
      if(polling||stopped)return;phantomButton.disabled=true;phantomButton.setAttribute('aria-busy','true');
      setPayState(t('Approve in connected Phantom'),t('The transaction contains the exact Memo, recipient, amount, and single-use Solana Pay reference.'),'');
      try{
        pending.txSig=await sendPreparedSolanaPay(prepared,pending.wallet,generation,function(signature){
          pending.txSig=signature;
          persistPaymentPending(pending,{expose:generation===privateGeneration()&&pending.wallet===String(walletPubkey||'')});
        });assertPrivateGeneration(generation);persistPaymentPending(pending);
        setPayState(t('Transaction submitted'),t('Waiting for finalized server verification of this same reference.'),'success');await poll();
      }catch(error){if(generation===privateGeneration())setPayState(t('Phantom transfer not submitted'),userError(error),'warning');}
      finally{if(generation===privateGeneration()){phantomButton.removeAttribute('aria-busy');if(!stopped)phantomButton.disabled=false;}}
    });
    function updateCountdown(){
      var expires=new Date(prepared.solana_pay.expires_at||prepared.expires_at).getTime();var left=expires-Date.now();
      if(!Number.isFinite(expires)||left<=0){timerNode.textContent=t('Intent expired');return false;}
      timerNode.textContent=t('Expires in {seconds} seconds',{seconds:Math.max(1,Math.ceil(left/1000))});return true;
    }
    async function poll(){
      if(stopped||polling)return;if(generation!==privateGeneration()){close(true);return;}polling=true;
      if(!updateCountdown()){setPayState(t('Expired'),t('This bound request can no longer be used. No payment was recorded.'),'warning');stopped=true;document.removeEventListener('keydown',keyHandler,true);clearPaymentState({forgetRecovery:!pending.txSig,wallet:pending.wallet});return;}
      setPayState(t('Verifying'),t('Checking finalized mainnet history for the exact single-use reference.'),'');
      try{
        var result=await api(PAYMENT_URL,{op:'poll_solana_pay',wallet:pending.wallet,reference:prepared.solana_pay.reference});
        assertPrivateGeneration(generation);
        if(result.paid===true&&result.receipt){
          stopped=true;clearTimeout(timerId);clearInterval(countdownId);document.removeEventListener('keydown',keyHandler,true);modal.remove();
          clearPaymentState({forgetRecovery:true,wallet:pending.wallet});showToast(t('Finalized Solana Pay transfer verified. Receipt {receipt} is available in the Proof Log.',{receipt:result.receipt.id}));showPaymentReceipt(result.receipt);
          if(pending.caseRef)await reloadPaymentCase(pending.caseRef);
          else if(pending.wireVersionRef&&typeof window.osiV2OpenWireReport==='function')await window.osiV2OpenWireReport(pending.wireVersionRef);
          assertPrivateGeneration(generation);
          return;
        }
        setPayState(t('Awaiting payment'),t('No exact finalized transfer is recorded yet. Keep this single request; do not create a second payment.'),'warning');
      }catch(error){
        if(generation!==privateGeneration()){close(true);return;}
        if(error.status===410||String(error.message)==='solana_pay_intent_expired'){
          setPayState(t('Expired'),t('The server-confirmed intent expired. No payment was recorded.'),'warning');stopped=true;document.removeEventListener('keydown',keyHandler,true);clearPaymentState({forgetRecovery:!pending.txSig,wallet:pending.wallet});return;
        }
        setPayState(t('Verification unavailable'),userError(error)+' '+t('The request remains unpaid; retry this same reference.'),'warning');
      }finally{
        polling=false;if(!stopped&&updateCountdown())timerId=setTimeout(poll,3500);
      }
    }
    modal.querySelector('[data-solana-pay-retry]').addEventListener('click',poll);
    countdownId=setInterval(updateCountdown,1000);updateCountdown();
    (phantomButton||modal.querySelector('[data-solana-pay-open]')).focus();
    setPayState(t('Ready'),t('Use one compatible wallet. OSI will verify the exact finalized transfer automatically.'),'success');
    timerId=setTimeout(poll,1500);
  }
  async function reloadPaymentCase(caseRef){
    var drawerToken=state.drawerLoadToken;
    if(state.mode==='public')await loadPublicCases();
    else await openSignedCollection(state.mode,{keepDrawer:true,authorize:true});
    if(drawerToken!==state.drawerLoadToken)return;
    await openCase(caseRef);
  }
  function showPaymentReceipt(receipt){
    var old=document.getElementById('osi-payment-receipt');if(old)old.remove();var modal=document.createElement('div');modal.id='osi-payment-receipt';modal.className='osi-payment-review';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');
    modal.setAttribute('aria-labelledby','osi-payment-receipt-title');
    modal.innerHTML='<div class="osi-payment-review-card"><span class="osi-eyebrow">'+esc(t('SOL transfer verified on Solana'))+'</span><h3 id="osi-payment-receipt-title">'+esc(t('Finalized payment receipt'))+'</h3><dl><div><dt>'+esc(t('Transaction'))+'</dt><dd class="mono">'+esc(short(receipt.tx_sig))+'</dd></div><div><dt>'+esc(t('Finality'))+'</dt><dd>'+esc(receipt.finality)+'</dd></div><div><dt>'+esc(t('Total'))+'</dt><dd>'+esc(receipt.total_sol)+' SOL / '+esc(receipt.total_lamports)+' lamports</dd></div><div><dt>'+esc(t('Slot'))+'</dt><dd>'+esc(receipt.slot)+'</dd></div><div><dt>'+esc(t('Block time'))+'</dt><dd>'+esc(dateText(receipt.block_time))+'</dd></div><div><dt>'+esc(t('Server verification'))+'</dt><dd>'+esc(t('Signer, transfers, Memo and mainnet verified'))+'</dd></div></dl><div class="osi-payment-actions"><a class="osi-action" href="'+esc(receipt.solscan_url)+'" target="_blank" rel="noopener">'+esc(t('Open Solscan'))+'</a><button class="osi-action primary" type="button" data-receipt-close>'+esc(t('Done'))+'</button></div><div class="osi-case-note">'+esc(t('This receipt records a direct wallet-to-wallet transfer. It is not an endorsement, truth vote, guilt decision, legal finding, custody service, or governance weight.'))+'</div></div>';
    document.body.appendChild(modal);modal.querySelector('[data-receipt-close]').addEventListener('click',function(){modal.remove();});modal.querySelector('[data-receipt-close]').focus();
  }
  // A transfer is broadcast seconds before Solana finalizes it, so the first
  // trusted verification almost always answers "awaiting_finality". Asking
  // once and stopping left a real, confirmed transfer with no receipt: the
  // wallet had paid, the single-use intent expired a couple of minutes later,
  // and nothing in the Proof Log ever showed the support. The exact same
  // signature is now re-verified on a bounded schedule until the server can
  // reach a finalized answer. Nothing is ever marked paid by waiting; only a
  // successful server verification produces the receipt.
  var FINALITY_RETRY_DELAY_MS=4000;
  var FINALITY_RETRY_BUDGET_MS=180000;
  // A signature that was broadcast in an earlier visit is re-verified once,
  // automatically, as soon as the wallet is known again. This opens no wallet
  // and sends nothing: it only asks the server to check the exact existing
  // signature, which is what recovers a transfer whose page was closed before
  // Solana finalized it.
  var resumedPaymentNonces={};
  function maybeResumePendingVerification(generation){
    var pending=state.paymentPending;
    if(!pending||pending.method==='solana_pay')return;
    if(!/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(String(pending.txSig||'')))return;
    var nonce=String(pending.prepared&&pending.prepared.nonce||'');
    if(!nonce||resumedPaymentNonces[nonce])return;
    resumedPaymentNonces[nonce]=1;
    verifyPreparedPayment(pending,false,generation,{automatic:true}).then(function(result){
      if(result&&result.state==='awaiting_finality')awaitFinality(pending,generation,Date.now());
    }).catch(function(){ /* the manual re-verify control stays available */ });
  }
  function paymentPendingMatches(pending){
    return !!(state.paymentPending&&state.paymentPending.prepared
      &&String(state.paymentPending.prepared.nonce||'')===String(pending.prepared.nonce||''));
  }
  function awaitFinality(pending,generation,startedAt){
    var deadline=startedAt+FINALITY_RETRY_BUDGET_MS;
    function attempt(){
      if(generation!==privateGeneration()||!paymentPendingMatches(pending))return;
      if(Date.now()>=deadline){
        paymentStatus('The transfer is still not finalized on Solana. It is not marked paid and nothing was lost. Use Re-verify existing signature in a moment; do not send a second payment.','warning');
        return;
      }
      var secondsLeft=Math.max(1,Math.round((deadline-Date.now())/1000));
      paymentStatus('Transaction submitted. Waiting for Solana finality, then trusted server verification. Checking again automatically for up to '+secondsLeft+' seconds. Do not send another payment.','warning');
      verifyPreparedPayment(pending,false,generation,{automatic:true}).then(function(result){
        if(result&&result.state==='awaiting_finality')window.setTimeout(attempt,FINALITY_RETRY_DELAY_MS);
      }).catch(function(error){
        if(generation!==privateGeneration())return;
        paymentStatus(userError(error)+' The exact signature stays available; use Re-verify existing signature rather than paying again.','error');
      });
    }
    window.setTimeout(attempt,FINALITY_RETRY_DELAY_MS);
  }
  async function verifyPreparedPayment(pending,recovery,generation,options){
    options=options||{};
    assertPrivateGeneration(generation);
    var result=await api(PAYMENT_URL,{op:recovery?'recover_payment':'commit_payment',wallet:pending.wallet,nonce:pending.prepared.nonce,tx_sig:pending.txSig});
    assertPrivateGeneration(generation);
    if(result.state==='awaiting_finality'){
      persistPaymentPending(pending);
      if(options.automatic!==true){
        var waiting='Transaction submitted. Waiting for Solana finality, then trusted server verification. This checks again automatically; do not send another payment.';
        paymentStatus(waiting,'warning');
        // The Wire support flow has no inline payment status line, so the
        // same honest message is surfaced as a toast instead.
        if(!document.getElementById('osi-payment-status'))showToast(waiting);
        if(state.current){state.tab='reward';renderTab();}
        awaitFinality(pending,generation,Date.now());
      }
      return result;
    }
    // Paid means the server said paid and handed back a receipt. Any other
    // answer keeps the recovery record: dropping it on an ambiguous response
    // would remove the do-not-pay-twice warning and the re-verify control
    // while the transfer is still unresolved.
    if(result.paid!==true||!result.receipt||!result.receipt.id){
      persistPaymentPending(pending);
      paymentStatus('The server did not return a confirmed receipt for this signature. It is not marked paid. Re-verify the same signature and do not send a second payment.','warning');
      return result;
    }
    clearPaymentState({forgetRecovery:true,wallet:pending.wallet});
    showToast((result.historical_reverification?t('Existing signature re-verified. ') : '')+t('Finalized direct SOL transfer verified. Receipt {receipt} is available in the Proof Log.',{receipt:result.receipt.id}));
    // An automatic background re-verification must not take over the screen.
    // The receipt modal belongs to an action the person just took.
    if(options.automatic!==true)showPaymentReceipt(result.receipt);
    if(pending.restored_from_storage!==true){
      if(pending.caseRef)await reloadPaymentCase(pending.caseRef);
      else if(pending.wireVersionRef&&typeof window.osiV2OpenWireReport==='function')await window.osiV2OpenWireReport(pending.wireVersionRef);
    }
    assertPrivateGeneration(generation);
    return result;
  }
  async function prepareAndSendPayment(kind,targetRef,recipients,amountSol,preferredMethod){
    if(state.paymentBusy)return;
    if(state.paymentPending){paymentStatus('Finish or re-verify the existing wallet-bound payment before preparing another transfer. Do not pay twice.','warning');return;}
    var generation=privateGeneration();state.paymentBusy=true;
    try{
      var wallet=await ensureWallet();restorePaymentPending(wallet);
      if(state.paymentPending){paymentStatus('Finish or re-verify the existing wallet-bound payment before preparing another transfer. Do not pay twice.','warning');return;}
      var caps=state.capabilities||await refreshCapabilities()||{};
      assertPrivateGeneration(generation);
      if(caps.payment_writes_enabled!==true)throw new Error('payment_writes_disabled');
      var body={op:'prepare_payment',payment_kind:kind,wallet:wallet,target_ref:targetRef,idempotency_key:randomKey('payment')};
      if(kind==='reward')body.amount_sol=amountSol;else body.recipients=recipients;
      paymentStatus('Deriving exact recipients and canonical Memo on the server...');
      var prepared=await api(PAYMENT_URL,body);assertPrivateGeneration(generation);exactPaymentProvider(prepared,wallet,generation);var method=await paymentReview(prepared,preferredMethod);assertPrivateGeneration(generation);exactPaymentProvider(prepared,wallet,generation);if(!method){paymentStatus('Transfer cancelled before any wallet opened.');return;}
      var pending={wallet:wallet,caseRef:state.current&&state.current.public_ref||'',prepared:prepared,method:method,recovery_state:method==='solana_pay'?'prepared':'awaiting_wallet'};
      if(method==='solana_pay'){
        persistPaymentPending(pending);paymentStatus('Single-use Solana Pay request ready. It remains unpaid until exact finalized server verification.','warning');openSolanaPay(pending);return;
      }
      persistPaymentPending(pending);
      var txSig=await sendPreparedPayment(prepared,wallet,generation,function(signature){
        pending.txSig=signature;pending.recovery_state='broadcast';
        persistPaymentPending(pending,{expose:generation===privateGeneration()&&wallet===String(walletPubkey||'')});
      });assertPrivateGeneration(generation);pending.txSig=txSig;pending.recovery_state='broadcast';
      persistPaymentPending(pending);paymentStatus('Transaction submitted. Verifying mainnet finality, signer, transfers, Memo, freshness, and replay binding...');
      await verifyPreparedPayment(pending,false,generation);
    }catch(error){if(generation===privateGeneration()){paymentStatus(userError(error)+(state.paymentPending?(state.paymentPending.method==='solana_pay'?' Resume the same Solana Pay request; do not start another.':' Do not pay again; use Re-verify existing signature.') :''),'error');showToast(userError(error));if(state.current&&state.paymentPending){state.tab='reward';renderTab();}}}
    finally{if(generation===privateGeneration())state.paymentBusy=false;}
  }
  async function pledge(action){
    if(state.paymentBusy||!state.current)return;var amountNode=document.getElementById('osi-pledge-amount');var amount=amountNode?String(amountNode.value||'').trim():'1';
    if(action!=='withdraw'&&!validSolInput(amount)){paymentStatus('Enter a positive SOL amount with at most 9 decimals.','error');return;}
    var generation=privateGeneration();state.paymentBusy=true;
    try{
      var wallet=await ensureWallet();paymentStatus('Preparing an exact single-use pledge message...');
      assertPrivateGeneration(generation);
      var prepared=await api(PAYMENT_URL,{op:'prepare_pledge',action:action,wallet:wallet,case_ref:state.current.public_ref,amount_sol:amount,idempotency_key:randomKey('pledge')});
      assertPrivateGeneration(generation);
      paymentStatus('Sign the pledge message. This is not a transfer and is not on-chain.');var signature=await signMessage(prepared.proof_text);
      assertPrivateGeneration(generation);
      await api(PAYMENT_URL,{op:'commit_pledge',action:action,wallet:wallet,nonce:prepared.nonce,proof_text:prepared.proof_text,signature:signature});
      assertPrivateGeneration(generation);
      paymentStatus('Reward pledge '+(action==='withdraw'?'withdrawn':action+'d')+' with wallet-signed server proof.','success');showToast('Reward pledge updated. No SOL moved.');
      await reloadPaymentCase(state.current.public_ref);
      assertPrivateGeneration(generation);
    }catch(error){if(generation===privateGeneration())paymentStatus(userError(error),'error');}finally{if(generation===privateGeneration())state.paymentBusy=false;}
  }
  function payReward(){var value=fieldValue('osi-reward-pay-amount');if(!validSolInput(value)){paymentStatus('Enter a positive SOL amount with at most 9 decimals.','error');return;}prepareAndSendPayment('reward',state.current.public_ref,null,value);}
  function supportContributors(versionRef){
    var checks=Array.prototype.filter.call(document.querySelectorAll('[data-support-check]'),function(node){return node.checked&&node.dataset.targetRef===versionRef;});
    if(!checks.length||checks.length>4){paymentStatus('Select between one and four contributors for this exact Report version.','error');return;}
    var recipients=[];for(var index=0;index<checks.length;index++){var node=checks[index],amountNode=document.querySelector('[data-support-amount="'+node.dataset.supportCheck+'"]'),value=String(amountNode&&amountNode.value||'').trim();if(!validSolInput(value)){paymentStatus('Every selected recipient needs a positive SOL amount with at most 9 decimals.','error');return;}var recipient={target_type:node.dataset.targetType,target_ref:node.dataset.targetRef,amount_sol:value};if(recipient.target_type==='counted_reviewer')recipient.reviewer_wallet=node.dataset.wallet;recipients.push(recipient);}
    prepareAndSendPayment('support',versionRef,recipients);
  }
  // Ask for an amount through the styled picker, falling back to the browser
  // prompt if that module is absent so a missing script never removes the
  // ability to support someone.
  function askSolAmount(options){
    if(typeof window.osiAskSolAmount==='function')return window.osiAskSolAmount(options);
    var typed=window.prompt(t('Exact native SOL amount (maximum 9 decimals). This voluntary direct transfer has no governance effect.'),'0.1');
    return Promise.resolve(typed===null?null:String(typed).trim());
  }
  function supportLabel(targetType){
    if(targetType==='analyst')return 'this analyst';
    if(targetType==='maintainer')return 'the OSI maintainer';
    if(targetType==='counted_reviewer')return 'this counted reviewer';
    if(targetType==='report_author')return 'the author of this published Report version';
    return 'this recipient';
  }
  // The anonymous projection never carries a Report author wallet, so the
  // address slot must stay empty for that route instead of rendering the
  // version reference as if it were a payable Solana address. The server
  // resolves and proves the real recipient when the transfer is prepared.
  function supportAddress(targetType,targetRef,reviewerWallet){
    if(targetType==='counted_reviewer')return reviewerWallet;
    if(targetType==='report_author')return '';
    return targetRef;
  }
  async function supportExternal(targetType,targetRef,reviewerWallet,preferredMethod){
    var generation=privateGeneration();
    var address=supportAddress(targetType,targetRef,reviewerWallet);
    var amount=await askSolAmount({
      title:'◎ Voluntary support',
      label:supportLabel(targetType),
      address:address,
      action:'Review transfer →',
      note:targetType==='report_author'
        ?'Recipient: the wallet that authored '+String(targetRef||'')+'. OSI never publishes that wallet, so the server derives the exact recipient and Memo when the transfer is prepared and you approve one transaction in your wallet. Direct wallet-to-wallet in native SOL. No custody. Support never changes review, ranking, weight, eligibility, or publication.'
        :undefined
    });
    if(generation!==privateGeneration())return;
    if(amount===null)return;
    if(!validSolInput(amount)){showToast(t('Enter a positive SOL amount with at most 9 decimals.'));return;}
    var recipient={target_type:targetType,target_ref:targetRef,amount_sol:amount};if(targetType==='counted_reviewer')recipient.reviewer_wallet=reviewerWallet;
    prepareAndSendPayment('support',targetRef,[recipient],undefined,preferredMethod);
  }
  async function supportWireAuthor(versionRef,authorWallet){
    if(!/^OSI-WV-[0-9A-F]{16}$/.test(String(versionRef||''))||state.paymentBusy)return;
    if(state.paymentPending){showToast('Finish or re-verify the existing wallet-bound payment before preparing another transfer. Do not pay twice.');return;}
    var generation=privateGeneration();
    var amount=await askSolAmount({
      title:'◎ Support the Wire author',
      label:'this Wire Report author',
      address:authorWallet,
      action:'Review transfer →'
    });
    if(generation!==privateGeneration())return;
    if(amount===null)return;
    if(!validSolInput(amount)){showToast(t('Enter a positive SOL amount with at most 9 decimals.'));return;}
    state.paymentBusy=true;
    try{
      var wallet=await ensureWallet();
      restorePaymentPending(wallet);
      if(state.paymentPending){showToast('Finish or re-verify the existing wallet-bound payment before preparing another transfer. Do not pay twice.');return;}
      assertPrivateGeneration(generation);
      if(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(authorWallet||''))&&wallet===authorWallet){showToast('You cannot support your own Wire Report.');return;}
      var prepared=await api(PAYMENT_URL,{op:'prepare_wire_support',wallet:wallet,version_public_ref:versionRef,amount_sol:amount,idempotency_key:randomKey('wire-support')});
      assertPrivateGeneration(generation);exactPaymentProvider(prepared,wallet,generation);var method=await paymentReview(prepared);assertPrivateGeneration(generation);exactPaymentProvider(prepared,wallet,generation);if(!method)return;
      var pending={wallet:wallet,caseRef:'',wireVersionRef:versionRef,prepared:prepared,method:method,recovery_state:method==='solana_pay'?'prepared':'awaiting_wallet'};
      if(method==='solana_pay'){persistPaymentPending(pending);openSolanaPay(pending);return;}
      persistPaymentPending(pending);
      var txSig=await sendPreparedPayment(prepared,wallet,generation,function(signature){
        pending.txSig=signature;pending.recovery_state='broadcast';
        persistPaymentPending(pending,{expose:generation===privateGeneration()&&wallet===String(walletPubkey||'')});
      });assertPrivateGeneration(generation);pending.txSig=txSig;pending.recovery_state='broadcast';
      persistPaymentPending(pending);
      await verifyPreparedPayment(pending,false,generation);
    }catch(error){if(generation===privateGeneration())showToast(userError(error));}
    finally{if(generation===privateGeneration())state.paymentBusy=false;}
  }
  async function pollRestoredSolanaPay(pending,generation){
    assertPrivateGeneration(generation);
    if(!pending||pending.restored_from_storage!==true
      ||String(pending.wallet||'')!==String(walletPubkey||''))throw new Error('payment_wallet_changed');
    paymentStatus('Checking the server for a finalized transfer bound to this restored reference. No wallet will open.');
    try{
      var result=await api(PAYMENT_URL,{op:'poll_solana_pay',wallet:pending.wallet,reference:String(pending.prepared&&pending.prepared.solana_pay&&pending.prepared.solana_pay.reference||'')});
      assertPrivateGeneration(generation);
      if(result.paid===true&&result.receipt){
        clearPaymentState({forgetRecovery:true,wallet:pending.wallet});
        showToast(t('Finalized Solana Pay transfer verified. Receipt {receipt} is available in the Proof Log.',{receipt:result.receipt.id}));
        showPaymentReceipt(result.receipt);return;
      }
      paymentStatus('No exact finalized transfer is recorded yet. Keep this recovery record and do not prepare a replacement payment.','warning');
    }catch(error){
      if(generation!==privateGeneration())return;
      if(error.status===410||['unknown_solana_pay_reference','solana_pay_intent_expired'].indexOf(String(error.message))>=0){
        clearPaymentState({forgetRecovery:true,wallet:pending.wallet});
        paymentStatus(userError(error)+' No wallet was opened from browser storage.','warning');return;
      }
      paymentStatus(userError(error)+' No wallet was opened; retry this same server check.','error');
    }
  }
  function retryPayment(){
    if(!state.paymentPending)return;
    var generation=privateGeneration();
    if(state.paymentPending.method==='solana_pay'&&state.paymentPending.restored_from_storage===true){
      pollRestoredSolanaPay(state.paymentPending,generation);return;
    }
    try{exactPaymentProvider(state.paymentPending.prepared,state.paymentPending.wallet,generation);}
    catch(error){clearPaymentState();paymentStatus(userError(error),'error');return;}
    if(state.paymentPending.method==='solana_pay'){
      try{openSolanaPay(state.paymentPending);}catch(error){paymentStatus(userError(error)+' The bound reference remains available until its exact expiry.','error');}
      return;
    }
    if(!state.paymentPending.txSig){paymentStatus('The wallet did not return a transaction signature. Do not start a replacement payment until you have checked the intended payer wallet history.','warning');return;}
    verifyPreparedPayment(state.paymentPending,true,generation).catch(function(error){if(generation===privateGeneration())paymentStatus(userError(error)+' The existing signature remains available for another verification attempt; do not send a replacement payment.','error');});
  }

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
  window.fieldMine=function(mine){return mine?openSignedCollection('mine'):loadPublicCases();};
  window.fieldSearch=function(value){state.query=String(value||'');state.page=1;drawCases();};
  // Resolutions and Challenges are stage filters over the same public Case
  // list, so the rail marker follows the stage rather than the click that set
  // it. Both entry points then agree: the rail says the same thing whether the
  // reader used the rail item or the status dropdown, and only one item is
  // ever marked current.
  function railKeyForStage(stage){
    if(stage==='resolution_selection')return 'resolutions';
    if(stage==='challenge_active')return 'challenges';
    return 'cases';
  }
  function markStageRail(){
    if(state.mode!=='public')return;
    setFieldRailActive(railKeyForStage(state.stage));
  }
  window.fieldFilter=function(value){state.stage=String(value||'all');state.page=1;markStageRail();drawCases();};
  // Offered by the filtered-empty state so a stage filter or search term is
  // never a dead end.
  window.osiV2ClearCaseFilters=function(){
    state.query='';state.stage='all';state.page=1;
    var search=document.querySelector('#field-view input[oninput*="fieldSearch"],#field-view input[onchange*="fieldSearch"]');
    if(search)search.value='';
    var select=document.querySelector('#field-view select[onchange*="fieldFilter"]');
    if(select)select.value='all';
    document.querySelectorAll('#field-view .fo-fil').forEach(function(button){
      button.classList.toggle('active',button.dataset.f==='all');
    });
    markStageRail();
    drawCases();
  };
  window.fieldSort=function(value){state.sort=String(value||'newest');drawCases();};
  window.osiV2OpenMyCases=function(options){return openSignedCollection('mine',options);};
  window.osiV2OpenMyChallenges=function(options){return openMyChallenges(options);};
  window.osiV2OpenReviewQueue=function(options){return openSignedCollection('review',options);};
  window.osiV2RefreshUnifiedReviewQueue=loadUnifiedReviewQueue;
  window.osiV2CanOpenReviewQueue=function(){return !!(state.capabilities&&(state.capabilities.analyst_eligible===true||state.capabilities.maintainer_access===true));};
  window.osiV2SetFieldReviewChrome=setReviewChrome;
  window.osiV2RenderSubmissionReceipt=renderSubmissionReceipt;
  window.osiV2ClearSubmissionReceipt=clearSubmissionReceipt;
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
  window.osiV2OpenAiPack=async function(publicRef){
    await openCase(publicRef);
    if(visibleTabs().some(function(tab){return tab[0]==='ai_pack';})){
      state.tab='ai_pack';drawTabs();renderTab();
    }
  };
  window.osiV2CloseCase=function(options){return closeCase(options);};
  // The shared hash router owns URL state; these hooks let it open or close the
  // canonical Case drawer without pushing a second history entry.
  window.osiV2OpenCaseFromRoute=function(publicRef){return openCase(publicRef,null,{fromRoute:true});};
  window.osiV2CloseCaseFromRoute=function(){
    var drawer=document.getElementById('osi-case-drawer');
    if(drawer&&!drawer.hidden)closeCase({fromRoute:true});
  };
  // Another module is taking over #field-cases. Invalidate any in-flight Case
  // list render so a late public read cannot overwrite the new owner's content.
  window.osiSetFieldOfficeNav=setFieldRailActive;
  window.osiV2CancelFieldListRender=function(){
    ++state.loadToken;++state.reviewLoadToken;state.locked=null;
  };
  window.osiV2ActiveCaseRef=function(){
    var drawer=document.getElementById('osi-case-drawer');
    if(!drawer||drawer.hidden)return '';
    return String(state.current&&state.current.public_ref||document.getElementById('osi-case-ref').textContent||'');
  };
  window.osiV2ShowTab=function(tab){state.tab=tab;drawTabs();renderTab();};
  window.addEventListener('resize',function(){syncTabOverflow();});
  window.osiV2ComposeReview=composeReview;
  window.osiV2AnchorOpen=anchorOpen;
  window.osiV2AnchorCaseRejection=anchorCaseRejection;
  window.osiV2ComposeCaseAppeal=composeCaseAppeal;
  window.osiV2Pledge=pledge;
  window.osiV2PayReward=payReward;
  window.osiV2SupportContributors=supportContributors;
  window.osiV2SupportReportAuthor=function(versionRef){supportExternal('report_author',versionRef);};
  window.osiV2SupportAnalyst=function(wallet,preferredMethod){supportExternal('analyst',wallet,undefined,preferredMethod);};
  window.osiV2SupportMaintainer=function(wallet,preferredMethod){supportExternal('maintainer',wallet,undefined,preferredMethod);};
  window.osiV2SupportCountedReviewer=function(versionRef,wallet){supportExternal('counted_reviewer',versionRef,wallet);};
  window.osiV2SupportWireAuthor=supportWireAuthor;
  window.osiV2RetryPayment=retryPayment;
  window.osiV2ClearPaymentState=clearPaymentState;

  function clearPrivateCaseCache(reason){
    if(reason==='expiry'||reason==='explicit_refresh')saveCaseDraft();
    state.loadToken+=1;state.reviewLoadToken+=1;state.drawerLoadToken+=1;state.locked=null;
    if(state.mode!=='public'){state.cases=[];state.reviewTasks={};state.reviewLanes={};state.reviewUpdatedAt=null;state.current=null;state.activeReviewTask=null;state.actorRole='public';state.currentActorRole='';state.mode='public';}
    state.capabilities=null;state.reviewBusy=false;state.governanceBusy=false;state.paymentBusy=false;state.caseReceipt=null;state.caseIdempotency='';clearPaymentState();setAdminVisibility(false);setReviewNavigationVisibility(false);
    clearSubmissionReceipt('v2-case-receipt');
    var form=document.getElementById('field-form');if(form)form.reset();
    var modal=document.getElementById('fo-modal');if(modal)modal.classList.remove('open');
    formStatus('');
    var submit=document.getElementById('v2-case-submit');if(submit){submit.disabled=false;submit.removeAttribute('aria-busy');}
    state.modalReturnFocus=null;
    wipeCaseDrawerContent();
    var drawer=document.getElementById('osi-case-drawer');if(drawer)drawer.hidden=true;
    document.body.classList.remove('osi-case-open');syncBodyLock();
    // The drawer is gone, so the canonical Case route must not linger and
    // reopen it on the next history event.
    clearCaseRoute();
  }
  if(typeof window.osiV2RegisterPrivateCache==='function')window.osiV2RegisterPrivateCache('cases',clearPrivateCaseCache);
  var caseDraftForm=document.getElementById('field-form');
  if(caseDraftForm){caseDraftForm.addEventListener('input',saveCaseDraft);caseDraftForm.addEventListener('change',saveCaseDraft);}

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
  window.addEventListener('osi:localechange',function(){
    Object.keys(state.submissionReceipts).forEach(function(hostId){
      renderSubmissionReceipt(hostId,state.submissionReceipts[hostId],false);
    });
    var host=document.getElementById('field-cases');
    if(host&&state.mode==='review')drawReviewTasks(host);
    if(state.current){drawTabs();renderTab();renderActions();}
  });
  setAdminVisibility(false);
  setReviewNavigationVisibility(false);
  window.addEventListener('load',function(){
    function attach(provider){
      if(!provider||!provider.on)return;
      provider.on('disconnect',clearPaymentState);
      provider.on('disconnect',function(){setReviewNavigationVisibility(false);});
      provider.on('accountChanged',function(){clearPaymentState();state.capabilities=null;setReviewNavigationVisibility(false);});
    }
    // The wallet extension can inject after load; attach to the real provider.
    if(typeof waitForProvider==='function')waitForProvider().then(attach);
    else attach(typeof getProvider==='function'?getProvider():null);
  });
})();
