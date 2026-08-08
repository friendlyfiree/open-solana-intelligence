/* Native V2 analyst identity, application, review, and probation activation. */
(function(){
  'use strict';

  var API_URL=SUPABASE_URL+'/functions/v1/osi-v2-analyst';
  var AVATAR_PREFIX=SUPABASE_URL+'/storage/v1/object/public/osi-analyst-avatars/';
  // maintainerAccess is pushed in by the Case module after the server answers
  // who this browser is. This module has no capability fetch of its own, and an
  // earlier version read `state.capabilities` here, a key nothing in this file
  // ever set, so the operator's own edit control could never appear.
  var state={profiles:[],profilesPromise:null,profileIntent:'',profileReturnFocus:null,workspace:null,workspaceWallet:'',workspaceTab:'profile',queue:[],busy:false,returnFocus:null,receipt:null,maintainerAccess:false,maintainerProfile:null};

  function esc(value){
    return String(value==null?'':value).replace(/[&<>"']/g,function(char){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char];
    });
  }
  function short(value){value=String(value||'');return value.length>18?value.slice(0,8)+'...'+value.slice(-6):value;}
  function label(value){return String(value||'').replace(/_/g,' ').replace(/\b\w/g,function(char){return char.toUpperCase();});}
  function t(key,variables){return typeof window.osiT==='function'?window.osiT(key,variables):String(key||'').replace(/\{([a-zA-Z0-9_]+)\}/g,function(_,name){return variables&&Object.prototype.hasOwnProperty.call(variables,name)?String(variables[name]):'{'+name+'}';});}
  function dateText(value){var date=new Date(value||'');return isNaN(date.getTime())?'Not recorded':date.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});}
  function randomKey(prefix){var id=crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(36).slice(2);return prefix+':'+id.replace(/[^A-Za-z0-9.-]/g,'');}
  function privateGeneration(){return typeof window.osiV2PrivateCacheGeneration==='function'?window.osiV2PrivateCacheGeneration():0;}
  function assertPrivateGeneration(generation){if(generation!==privateGeneration())throw new Error('private_session_changed');}
  function headers(){var token=(typeof SUPA_AUTH_TOKEN==='string'&&SUPA_AUTH_TOKEN)?SUPA_AUTH_TOKEN:SUPABASE_ANON_KEY;return {'Content-Type':'application/json','apikey':SUPABASE_ANON_KEY,'Authorization':'Bearer '+token};}
  var ANALYST_NON_MUTATING_OPS={capabilities:1,list_public_profiles:1,my_workspace:1};
  async function api(body){
    var response=await fetch(API_URL,{method:'POST',headers:headers(),body:JSON.stringify(body)});
    var payload={};try{payload=await response.json();}catch(_){payload={ok:false,error:'invalid_server_response'};}
    if(!response.ok||payload.ok!==true){var failure=new Error(payload.error||('request_failed_'+response.status));failure.status=response.status;throw failure;}
    // Application and activation writes change the public analyst roster.
    if(ANALYST_NON_MUTATING_OPS[body&&body.op]!==1&&typeof window.osiPublicReadInvalidate==='function'){
      window.osiPublicReadInvalidate();
    }
    return payload;
  }
  function userError(error){
    var code=String(error&&error.message||'request_failed');
    var messages={
      analyst_writes_disabled:'Analyst applications are safely disabled while rollout checks are incomplete.',
      analyst_writes_disabled_or_unavailable:'Analyst writes are safely disabled or temporarily unavailable.',
      half_maintainer_wallet_only:'The admin wallet is valid, but the Supabase maintainer session is still required.',
      half_maintainer_auth_only:'The Supabase session is valid, but the configured admin wallet is still required.',
      not_maintainer:'Both maintainer gates are required for this operation.',
      self_review_denied:'An applicant cannot review or activate their own application.',
      bad_signature:'The wallet signature could not be verified.',
      proof_binding_rejected:'The proof expired or no longer matches this exact action. Start again.',
      unknown_or_wrong_nonce:'The single-use proof is missing, expired, or bound to another action.',
      transaction_not_confirmed:'The probation Memo is not confirmed yet. Keep this window open and retry.',
      rpc_unavailable:'Solana confirmation is temporarily unavailable. This transaction can be retried safely.',
      replayed_or_expired:'This read authorization was already used or expired.',
      handle_unavailable:'That analyst handle is already in use.',
      prohibited_secret_material:'Remove every seed phrase, recovery phrase, mnemonic, private key, or secret-key reference.',
      not_found_or_not_reviewable:'This exact application version is no longer reviewable.',
      not_ready_for_probation:'This exact version needs an active maintainer approval before probation activation.',
      rate_limited:'Too many proof requests. Wait a few minutes and try again.',
      concurrent_retry:'Another operation changed this record. Refresh and try again.',
      application_under_review:'Your current application is already under review. Open My Applications to check its status.',
      active_analyst_cannot_apply:'Your wallet already has an active analyst profile. Open My Profile instead.',
      application_state_changed:'Your application changed while this proof was prepared. Open My Applications and try the exact available action again.'
      ,read_session_disabled_or_unavailable:'Private read sessions are safely disabled or temporarily unavailable.'
      ,read_session_required:'Unlock private views with one wallet signature.'
      ,read_session_scope_denied:'This view is open to verified analysts, and this wallet does not hold that standing yet. Nothing is wrong with your session: the surfaces your wallet can reach stay open, and no further signature will be asked for this one.'
      ,read_session_expired:'Your private working session genuinely lapsed. Sign once to unlock a new bounded session; your draft is preserved.'
      ,read_session_wrong_origin:'This private session belongs to a different site origin.'
      ,read_session_wrong_wallet:'This private session belongs to a different wallet.'
      ,read_session_wrong_scope:'Refresh private access explicitly for this role.'
      ,read_session_tampered:'The private session token failed server verification.'
      ,private_session_changed:'Private access changed while this action was running. Reopen the exact task.'
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
    if(!walletPubkey&&typeof toggleWallet==='function')await toggleWallet();
    if(!walletPubkey)throw new Error('Connect a Solana wallet to continue.');
    return String(walletPubkey);
  }
  function bytesToBase64(bytes){var binary='';for(var i=0;i<bytes.length;i++)binary+=String.fromCharCode(bytes[i]);return btoa(binary);}
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
    var result=await api({op:op,wallet:session.wallet,read_session:session.token});
    assertPrivateGeneration(generation);return result;
  }
  function trustedAvatar(url){url=String(url||'');return url.indexOf(AVATAR_PREFIX)===0?url:'';}
  function safeHttps(url){
    try{var parsed=new URL(String(url||''));return parsed.protocol==='https:'&&!parsed.username&&!parsed.password?parsed.toString():'';}catch(_){return '';}
  }
  function avatar(profile,size){
    var url=trustedAvatar(profile&&profile.avatar_url);
    if(url)return '<img class="osi-an-avatar" src="'+esc(url)+'" alt="" width="'+size+'" height="'+size+'" loading="lazy">';
    var wallet=profile&&profile.wallet||'',identity=profile&&profile.display_name||profile&&profile.handle||short(wallet)||'?';
    return typeof osiAvatarSvg==='function'?osiAvatarSvg(wallet,size,identity,''):'<span class="osi-an-avatar fallback">'+esc(String(identity).charAt(0).toUpperCase())+'</span>';
  }
  function proofLabel(type){return type==='solana_memo'?'Memo-anchored on Solana':type==='wallet_signed_server_verified'?'Wallet-signed and server-verified':'Legacy, not server-verified';}
  function solFromLamports(value){var text=String(value==null?'0':value);if(!/^\d+$/.test(text))return'0';text=text.replace(/^0+(?=\d)/,'');var padded=text.padStart(10,'0'),whole=padded.slice(0,-9),fraction=padded.slice(-9).replace(/0+$/,'');return whole+(fraction?'.'+fraction:'');}
  function statusBadge(status){return '<span class="osi-status '+esc(status)+'">'+esc(label(status))+'</span>';}
  function sasSlot(wallet,status){return '<span data-sas-wallet="'+esc(wallet)+'" data-sas-role="'+esc(status||'analyst_profile')+'"></span>';}
  function empty(title,body){return '<div class="osi-activation-empty"><b>'+esc(title)+'</b><span>'+esc(body)+'</span></div>';}
  // Loading, locked and failed states keep the workspace chrome. Dropping the
  // header left a bare notice floating on an otherwise empty page, which reads
  // as a broken render rather than a state the product intends.
  function workspaceShell(bodyHtml){
    return '<div class="osi-analyst-workspace"><header class="osi-workspace-head"><div><span class="mono">MY OSI / ANALYST</span><h2>Analyst workspace</h2><p>Your server-derived analyst profile and immutable application history.</p></div></header><main>'+bodyHtml+'</main></div>';
  }

  function syncAnalystMaps(rows){
    var profiles={},weights={};
    rows.forEach(function(row){profiles[String(row.wallet)]={handle:row.handle,name:row.display_name,avatar_url:trustedAvatar(row.avatar_url),status:row.status,tier_code:row.tier_code,weight:Number(row.weight||0)};weights[String(row.wallet)]=Number(row.weight||0);});
    window.VERIFIED_ANALYSTS=profiles;window.ANALYST_WEIGHT=weights;
  }
  // The roster's work column and the profile's summary must never disagree, so
  // both read the record's own count. A response from before the record existed
  // falls back to the contribution list rather than showing a blank column.
  function publicWorkCount(profile){
    var summary=profile&&profile.record&&profile.record.summary;
    if(summary&&typeof summary.public_entries==='number')return summary.public_entries;
    return ((profile&&profile.contributions)||[]).length;
  }
  function publicRow(profile){
    var expertise=(profile.expertise||[]).map(function(item){return '<span>'+esc(label(item))+'</span>';}).join('');
    var contributions=publicWorkCount(profile);
    var proofs=(profile.proof_history||[]).length;
    var identity=profile.handle?'@'+profile.handle:short(profile.wallet);
    return '<button class="osi-analyst-row" type="button" data-analyst-wallet="'+esc(profile.wallet)+'">'
      +'<span class="osi-analyst-person">'+avatar(profile,38)+'<span><b data-osi-user-content>'+esc(profile.display_name||profile.handle||short(profile.wallet))+'</b><em class="mono">'+esc(identity)+'</em></span></span>'
      +'<span>'+statusBadge(profile.status)+'</span><span class="osi-expertise-list">'+(expertise||'<em>Not listed</em>')+'</span>'
      +'<span class="mono">'+contributions+'</span><span class="mono osi-weight">'+Number(profile.weight||0).toFixed(2)+'</span><span class="mono">'+proofs+'</span></button>';
  }
  function renderPublicProfiles(){
    var host=document.getElementById('lb-body'),count=document.getElementById('lb-count'),pager=document.getElementById('lb-pnav');
    if(!host)return;
    host.removeAttribute('aria-busy');
    if(pager)pager.innerHTML='';
    if(!state.profiles.length){
      host.innerHTML='<div class="osi-activation-empty"><b>No activated analysts yet</b><span>Approved probationary analysts will appear here with server-derived status, weight, contributions, and proof.</span><button class="osi-empty-cta" type="button" onclick="apxOpen()">Start analyst application</button></div>';
      if(count)count.textContent=t('{count} analysts',{count:0});
      return;
    }
    host.innerHTML=state.profiles.map(publicRow).join('');if(count)count.textContent=state.profiles.length===1?t('{count} analyst',{count:1}):t('{count} analysts',{count:state.profiles.length});
    host.querySelectorAll('[data-analyst-wallet]').forEach(function(button){button.addEventListener('click',function(){openPublicProfile(button.dataset.analystWallet);});});
  }
  async function loadPublicProfiles(options){
    options=options||{};
    if(state.profilesPromise)return state.profilesPromise;
    var host=document.getElementById('lb-body');
    if(host){host.setAttribute('aria-busy','true');host.innerHTML='<div class="osi-activation-loading" role="status">'+esc(t('Loading verified server-derived profiles...'))+'</div>';}
    state.profilesPromise=(async function(){
      try{
        var body={op:'list_public_profiles'};
        var result=typeof window.osiPublicRead==='function'
          ? await window.osiPublicRead('osi-v2-analyst',body)
          : await api(body);
        state.profiles=Array.isArray(result.analysts)?result.analysts:[];
        syncAnalystMaps(state.profiles);renderPublicProfiles();
        loadMaintainerProfile();
        return state.profiles;
      }catch(error){
        state.profiles=[];syncAnalystMaps([]);
        if(host){host.removeAttribute('aria-busy');host.innerHTML=empty(t('Analyst directory unavailable'),userError(error))+'<button class="osi-empty-cta" type="button" data-analyst-directory-retry>'+esc(t('Retry'))+'</button>';var retry=host.querySelector('[data-analyst-directory-retry]');if(retry)retry.addEventListener('click',function(){loadPublicProfiles();});}
        if(options.throwOnError)throw error;
        return state.profiles;
      }finally{state.profilesPromise=null;}
    })();
    return state.profilesPromise;
  }
  // The operator's public identity, rendered above the roster and kept visibly
  // apart from it. The maintainer is not an analyst: no status, no tier, no
  // weight, no vote. The card says so in words rather than leaving the reader
  // to infer it from a missing column, and the endpoint says so in its payload
  // too, so a third-party consumer carries the same disclaimer.
  //
  // Absent until a profile is published. An operator who has not written one
  // gets no card, not a placeholder.
  // The maintainer used to render as a full-width block above the roster with
  // its own layout, its own headings and its own facts grid. Nothing else on
  // the page looked like it, so the one record a reader most needs to place in
  // context was the one record that read as foreign to it. It is now a roster
  // peer: the same row shape as an analyst, opening the same profile modal,
  // marked MAINTAINER rather than given a separate visual language. The
  // separation that actually matters is a governance fact, not a layout, and
  // the modal states it in the same facts row every analyst uses.
  function maintainerRow(profile){
    var name=String(profile.display_name||'').trim()||short(profile.wallet);
    var expertise=(profile.expertise_public||[]).filter(function(v){return typeof v==='string'&&v;})
      .map(function(item){return '<span>'+esc(label(item))+'</span>';}).join('');
    return '<button class="osi-analyst-row osi-analyst-row-maintainer" type="button" data-maintainer-wallet="'+esc(profile.wallet)+'">'
      +'<span class="osi-analyst-person">'+avatar({avatar_url:profile.avatar_url,wallet:profile.wallet,display_name:name},38)
      +'<span><b data-osi-user-content>'+esc(name)+'</b><em class="mono">'+esc(short(profile.wallet))+'</em></span></span>'
      +'<span><span class="osi-status maintainer">'+esc(t('Maintainer'))+'</span></span>'
      +'<span class="osi-expertise-list">'+(expertise||'<em>'+esc(t('Not listed'))+'</em>')+'</span>'
      +'<span class="mono">'+String(publicWorkCount(profile))+'</span>'
      +'<span class="mono osi-weight osi-weight-none">'+esc(t('None'))+'</span>'
      +'<span class="mono">'+String((profile.proof_history||[]).length)+'</span></button>';
  }
  function renderMaintainerProfile(profile){
    var host=document.getElementById('osi-maintainer-profile');
    if(!host)return;
    state.maintainerProfile=profile&&profile.wallet?profile:null;
    if(!profile||!profile.wallet){host.hidden=true;host.innerHTML='';return;}
    host.hidden=false;
    host.innerHTML=
      '<h3 id="osi-maintainer-profile-title" class="osi-maintainer-kicker">'+esc(t('Maintainer'))+'</h3>'
      +'<div class="osi-maintainer-rows">'+maintainerRow(profile)+'</div>'
      // One line, not a card. It answers what the maintainer does; the modal
      // carries the three governance facts stating what they do not hold.
      +'<p class="osi-maintainer-notice">'+esc(t('Operates the deployment: schema migrations, function rollouts and configuration. What gets published is decided by independent analyst quorum.'))+'</p>';
    var row=host.querySelector('[data-maintainer-wallet]');
    if(row)row.addEventListener('click',function(){openPublicProfile(row.dataset.maintainerWallet);});
  }
  async function loadMaintainerProfile(){
    var host=document.getElementById('osi-maintainer-profile');
    if(!host)return null;
    try{
      var body={op:'get_maintainer_profile'};
      var result=typeof window.osiPublicRead==='function'
        ? await window.osiPublicRead('osi-v2-analyst',body)
        : await api(body);
      renderMaintainerProfile(result&&result.profile);
      attachMaintainerEditor(result&&result.profile);
      return result&&result.profile;
    }catch(_){
      // An unavailable operator card is not worth an error banner over the
      // roster, and inventing one would be worse. Stay absent.
      host.hidden=true;host.innerHTML='';
      attachMaintainerEditor(null);
      return null;
    }
  }

  // Editing is the operator's own surface and is offered only when the server
  // has already said this browser holds both maintainer gates. The button is a
  // convenience, not the authorization: save_maintainer_profile re-derives the
  // configured admin wallet and the authenticated identity on every write, so a
  // stale flag in this page buys nothing.
  function maintainerEditorMarkup(profile){
    profile=profile||{};
    var links=(profile.links_public||[]).map(function(link){
      return String(link.label||'')+' | '+String(link.url||'');
    }).join('\n');
    return '<form class="osi-maintainer-editor" data-maintainer-editor>'
      +'<label><span>'+esc(t('Display name'))+'</span><input type="text" maxlength="80" data-mp-name value="'+esc(profile.display_name||'')+'"></label>'
      +'<label><span>'+esc(t('Bio'))+'</span><textarea rows="3" maxlength="1000" data-mp-bio>'+esc(profile.bio||'')+'</textarea></label>'
      +'<label><span>'+esc(t('Profile image'))+'</span><input type="file" accept="image/png,image/jpeg" data-mp-avatar-file>'
      +'<small>'+esc(t('PNG or JPEG only, 64 to 1024 px, maximum 512 KB. Stored by this deployment: a remote image URL cannot be used, because the page only loads images it owns.'))+'</small></label>'
      +(trustedAvatar(profile.avatar_url)?'<label><span>'+esc(t('Current image'))+'</span>'
        +'<span class="osi-maintainer-current-avatar">'+avatar({avatar_url:profile.avatar_url,wallet:profile.wallet},40)
        +'<button class="osi-action" type="button" data-mp-avatar-clear>'+esc(t('Remove image'))+'</button></span></label>':'')
      +'<input type="hidden" data-mp-avatar value="'+esc(profile.avatar_url||'')+'">'
      +'<label><span>'+esc(t('Proof of work URL'))+'</span><input type="url" data-mp-proof placeholder="https://" value="'+esc(profile.proof_of_work_url||'')+'"></label>'
      +'<label><span>'+esc(t('Expertise, comma separated'))+'</span><input type="text" data-mp-expertise value="'+esc((profile.expertise_public||[]).join(', '))+'"></label>'
      +'<label><span>'+esc(t('Links, one per line as label | https://url'))+'</span><textarea rows="3" data-mp-links>'+esc(links)+'</textarea></label>'
      +'<div class="osi-maintainer-editor-actions">'
      +'<button class="osi-action primary" type="submit">'+esc(t('Save profile'))+'</button>'
      +'<button class="osi-action" type="button" data-mp-cancel>'+esc(t('Cancel'))+'</button>'
      +'</div><p class="osi-maintainer-editor-status" role="status" data-mp-status></p></form>';
  }
  // The file is read here rather than in the submit handler so the payload the
  // server sees is assembled in exactly one place.
  async function maintainerAvatarPayload(form){
    var input=form.querySelector('[data-mp-avatar-file]'),file=input&&input.files&&input.files[0];
    if(!file)return null;
    if(['image/png','image/jpeg'].indexOf(file.type)===-1)throw new Error('Profile image must be PNG or JPEG.');
    if(file.size>524288)throw new Error('Profile image must be 512 KB or smaller.');
    return {mime:file.type,data_base64:bytesToBase64(new Uint8Array(await file.arrayBuffer()))};
  }
  async function readMaintainerEditor(form){
    function value(selector){var node=form.querySelector(selector);return node?String(node.value||'').trim():'';}
    var image=await maintainerAvatarPayload(form);
    return {
      avatar:image,
      display_name:value('[data-mp-name]'),
      bio:value('[data-mp-bio]'),
      avatar_url:value('[data-mp-avatar]'),
      proof_of_work_url:value('[data-mp-proof]'),
      expertise_public:value('[data-mp-expertise]').split(',').map(function(item){return item.trim();}).filter(Boolean),
      links_public:value('[data-mp-links]').split('\n').map(function(line){
        var parts=String(line).split('|');
        if(parts.length<2)return {label:'',url:String(parts[0]||'').trim()};
        return {label:parts[0].trim(),url:parts.slice(1).join('|').trim()};
      }).filter(function(link){return link.url;})
    };
  }
  async function openMaintainerEditor(profile){
    var host=document.getElementById('osi-maintainer-profile');
    if(!host)return;
    var panel=document.createElement('div');
    panel.className='osi-maintainer-editor-host';
    panel.innerHTML=maintainerEditorMarkup(profile);
    host.appendChild(panel);
    var form=panel.querySelector('[data-maintainer-editor]');
    var status=panel.querySelector('[data-mp-status]');
    panel.querySelector('[data-mp-cancel]').addEventListener('click',function(){panel.remove();});
    // Removing clears the stored URL and any pending file, so saving after this
    // genuinely publishes a profile with no image rather than keeping the old
    // one because the field was left untouched.
    var clear=panel.querySelector('[data-mp-avatar-clear]');
    if(clear)clear.addEventListener('click',function(){
      var stored=panel.querySelector('[data-mp-avatar]');if(stored)stored.value='';
      var file=panel.querySelector('[data-mp-avatar-file]');if(file)file.value='';
      var current=panel.querySelector('.osi-maintainer-current-avatar');if(current)current.remove();
      status.textContent=t('Image will be removed when you save.');
    });
    form.addEventListener('submit',async function(event){
      event.preventDefault();
      status.textContent=t('Saving...');
      try{
        var saved=await api({op:'save_maintainer_profile',wallet:walletPubkey,profile:await readMaintainerEditor(form)});
        // Rendering replaces the container's contents, so the edit control has
        // to be put back or a successful save would leave the operator with no
        // way to make a second one.
        renderMaintainerProfile(saved&&saved.profile);
        panel.remove();
        attachMaintainerEditor(saved&&saved.profile);
        if(typeof window.osiPublicReadInvalidate==='function')window.osiPublicReadInvalidate();
      }catch(error){
        // The card stays as it was. A failed save never leaves a half-written
        // profile on screen pretending to be published.
        status.textContent=userError(error);
      }
    });
  }
  function attachMaintainerEditor(profile){
    var host=document.getElementById('osi-maintainer-profile');
    if(!host)return;
    if(state.maintainerAccess!==true)return;
    if(host.querySelector('[data-maintainer-edit]'))return;
    // With nothing published yet there is no card to hang the control on, so
    // the operator gets a minimal frame to publish the first profile. Without
    // it the only way to create a profile would be to already have one, and
    // the "Publish" wording below would be unreachable.
    if(!profile||!profile.wallet){
      host.innerHTML=
        '<h3 id="osi-maintainer-profile-title" class="osi-maintainer-kicker">'+esc(t('Maintainer'))+'</h3>'
        +'<p class="osi-maintainer-empty">'+esc(t('No maintainer profile is published yet.'))+'</p>';
    }
    var button=document.createElement('button');
    button.className='osi-action osi-maintainer-edit';
    button.type='button';
    button.setAttribute('data-maintainer-edit','');
    button.textContent=t(profile&&profile.wallet?'Edit maintainer profile':'Publish maintainer profile');
    button.addEventListener('click',function(){
      if(host.querySelector('[data-maintainer-editor]'))return;
      openMaintainerEditor(profile);
    });
    host.hidden=false;
    host.appendChild(button);
  }
  window.osiV2LoadMaintainerProfile=loadMaintainerProfile;
  // The Case module is the one surface that already asks the server who this
  // browser is, and it only knows after a wallet connects. It pushes the answer
  // here rather than this module asking again, so the operator's own card can
  // never disagree with the rest of the interface about whether the maintainer
  // gates are held. The flag only decides whether a button is drawn:
  // save_maintainer_profile re-derives the configured admin wallet and the
  // authenticated identity on every write, so a stale true buys nothing.
  window.osiV2SetMaintainerCapability=function(allowed){
    var next=allowed===true;
    if(state.maintainerAccess===next)return;
    state.maintainerAccess=next;
    loadMaintainerProfile();
  };

  function publicProof(row){
    var tx=row.proof_type==='solana_memo'&&/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(String(row.tx_sig||''))?'<a href="https://solscan.io/tx/'+encodeURIComponent(row.tx_sig)+'" target="_blank" rel="noopener noreferrer">Verify on Solscan</a>':'';
    var payment=row.payment_proof&&row.event_type==='SUPPORT_PAYMENT_CONFIRMED'?'<span>'+esc(solFromLamports(row.payment_proof.recipient_amount_lamports))+' SOL / '+esc(row.payment_proof.recipient_amount_lamports)+' lamports / '+esc(label(row.payment_proof.finality))+'</span>':'';
    return '<div class="osi-history-row"><div><b>'+esc(label(row.event_type))+'</b><span>'+esc(row.payment_proof?'SOL transfer verified on Solana':proofLabel(row.proof_type))+' / actor '+esc(label(row.actor_role))+'</span>'+payment+'</div><time>'+esc(dateText(row.occurred_at))+'</time>'+tx+'</div>';
  }
  // ---------------------------------------------------------------------------
  // The verified work record: the part of a profile that is a track record
  // rather than a self-description.
  //
  // Every row here is the intersection of two facts the reader can check
  // separately: a receipt this wallet signed, and the current public state of
  // the subject it points at. So a row is never a claim about whether the
  // analysis was right. It says a wallet did an exact thing to an exact record
  // that anyone can open, and where the chain proof for it is.
  // ---------------------------------------------------------------------------

  // Neutral, and deliberately so. An outcome describes where the process
  // reached, never whether a conclusion is true. "Sealed" means the challenge
  // window closed, not that the finding is correct.
  var OUTCOME_LABELS={
    sealed:'Sealed record',
    resolved:'Resolved',
    in_challenge_window:'In challenge window',
    resolution_proposed:'Resolution proposed',
    in_review:'In review',
    open:'Open investigation',
    halted:'Halted',
    archived:'Archived',
    published:'Published'
  };
  var ROLE_LABELS={
    author:'Author',
    submitter:'Submitted by this wallet',
    reviewer:'Reviewer',
    proposer:'Proposed the resolution',
    challenger:'Challenger'
  };
  function recordEntryHref(entry){
    // A Report is read inside its Case, so both point at the one canonical
    // shareable Case route. A Wire Report has no public per-record route yet,
    // so it gets no link rather than a broken one.
    var ref=String(entry&&entry.case_ref||'');
    return /^OSI-[0-9A-Z]{6,20}$/.test(ref)?'#case/'+encodeURIComponent(ref):'';
  }
  function recordAct(act){
    var tx=act.proof_type==='solana_memo'&&/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(String(act.tx_sig||''))
      ?'<a class="osi-cv-act-proof" href="https://solscan.io/tx/'+encodeURIComponent(act.tx_sig)+'" target="_blank" rel="noopener noreferrer">'+esc(t('Verify on Solana'))+'</a>'
      :'<span class="osi-cv-act-proof osi-cv-act-offchain">'+esc(t('Wallet-signed, server-verified'))+'</span>';
    return '<li><span class="osi-cv-act-name">'+esc(label(act.event_type))+'</span>'
      +'<time>'+esc(dateText(act.occurred_at))+'</time>'+tx+'</li>';
  }
  function recordEntry(entry){
    var href=recordEntryHref(entry);
    var ref=String(entry.public_ref||'');
    var reference=href
      ?'<a class="osi-cv-ref mono" href="'+esc(href)+'">'+esc(ref)+'</a>'
      :'<span class="osi-cv-ref mono">'+esc(ref)+'</span>';
    var outcome=String(entry.outcome||'');
    var title=String(entry.title||'').trim();
    return '<li class="osi-cv-entry">'
      +'<div class="osi-cv-entry-head">'+reference
      +'<span class="osi-cv-outcome" data-outcome="'+esc(outcome)+'">'+esc(t(OUTCOME_LABELS[outcome]||label(outcome)))+'</span></div>'
      +(title?'<b class="osi-cv-title" data-osi-user-content>'+esc(title)+'</b>':'')
      +'<span class="osi-cv-role">'+esc(t(ROLE_LABELS[String(entry.role||'')]||label(entry.role)))
      +' / '+esc(t(label(entry.subject_type)))+'</span>'
      +'<ul class="osi-cv-acts">'+(entry.acts||[]).map(recordAct).join('')+'</ul></li>';
  }
  function recordSummary(summary){
    if(!summary)return '';
    var cells=[
      ['Public records',summary.public_entries],
      ['Cases',summary.cases],
      ['Sealed',summary.cases_sealed],
      ['Reports published',summary.reports_published],
      ['Wire published',summary.wire_reports_published],
      ['Reviews cast',summary.reviews],
      ['Memo-anchored acts',summary.memo_anchored_acts]
    ];
    return '<div class="osi-cv-summary">'+cells.map(function(cell){
      return '<div><span>'+esc(t(cell[0]))+'</span><b class="mono">'+esc(String(Number(cell[1]||0)))+'</b></div>';
    }).join('')+'</div>';
  }
  function recordSection(record){
    record=record||{};
    var entries=Array.isArray(record.entries)?record.entries:[];
    var unlisted=Array.isArray(record.unlisted)?record.unlisted:[];
    var unlistedTotal=unlisted.reduce(function(sum,row){return sum+Number(row.count||0);},0);
    // Work whose subject is not public is stated as a number and never as a
    // reference. Hiding it would understate the record; naming it would
    // announce a private Case. The count is the honest middle.
    var footnote=unlistedTotal
      ?'<p class="osi-cv-unlisted">'+esc(unlistedTotal===1
        ?t('One further signed act is on a subject that is not public yet. It is counted here and deliberately not named.')
        :t('{count} further signed acts are on subjects that are not public yet. They are counted here and deliberately not named.',{count:unlistedTotal}))+'</p>'
      :'';
    var body=entries.length
      ?recordSummary(record.summary)+'<ol class="osi-cv-entries">'+entries.map(recordEntry).join('')+'</ol>'
      :empty(t('No public record yet'),t('Work appears here once the Case, Report or Wire Report it belongs to is public.'));
    return '<section class="osi-cv-record"><h4>'+esc(t('Verified work record'))+'</h4>'
      +'<p class="osi-cv-note">'+esc(t('Each row is a signed act on a record anyone can open. An outcome states where the process reached, never that a finding is true.'))+'</p>'
      +body+footnote+'</section>';
  }

  async function openPublicProfile(wallet,options){
    options=options||{};
    wallet=String(wallet||'');if(!wallet)return;
    if(options.preserveReturnFocus!==true)state.profileReturnFocus=document.activeElement;
    state.profileIntent=wallet;
    var body=document.getElementById('ap-modal-body'),modal=document.getElementById('ap-modal');if(!body||!modal)return;
    modal.classList.add('open');modal.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';body.setAttribute('aria-busy','true');body.innerHTML='<div class="osi-activation-loading" role="status">'+esc(t('Loading the selected analyst profile...'))+'</div>';
    if(options.preserveFocus!==true)setTimeout(function(){var close=modal.querySelector('.ap-modal-x');if(close)close.focus();},0);
    // The maintainer is not in the analyst directory and never will be, so it
    // is resolved from its own record. Everything after this point is the same
    // path an analyst takes: same modal, same sections, same escaping.
    var maintainer=state.maintainerProfile;
    if(maintainer&&String(maintainer.wallet)===wallet){
      adoptProfileRoute('maintainer');
      renderProfileModal(body,maintainerModalProfile(maintainer),{maintainer:true});
      return;
    }
    var profile=state.profiles.find(function(row){return String(row.wallet)===wallet;});
    if(!profile){
      try{await loadPublicProfiles({throwOnError:true});}catch(error){
        if(state.profileIntent!==wallet)return;
        body.removeAttribute('aria-busy');body.innerHTML=empty(t('Analyst profile unavailable'),userError(error))+'<button class="osi-primary-action" type="button" data-profile-retry>'+esc(t('Retry'))+'</button>';
        var retry=body.querySelector('[data-profile-retry]');if(retry)retry.addEventListener('click',function(){openPublicProfile(wallet,{preserveReturnFocus:true});});return;
      }
      if(state.profileIntent!==wallet)return;
      profile=state.profiles.find(function(row){return String(row.wallet)===wallet;});
    }
    if(!profile){
      body.removeAttribute('aria-busy');body.innerHTML=empty(t('Analyst profile unavailable'),t('This wallet is not in the current verified analyst directory.'))+'<button class="osi-primary-action" type="button" data-profile-retry>'+esc(t('Retry'))+'</button>';
      var missingRetry=body.querySelector('[data-profile-retry]');if(missingRetry)missingRetry.addEventListener('click',function(){openPublicProfile(wallet,{preserveReturnFocus:true});});return;
    }
    // A profile with no public handle has no shareable address, so the page
    // keeps the address it was already on rather than inventing one that would
    // put a wallet in the URL.
    var handle=String(profile.handle||'').toLowerCase();
    if(/^[a-z0-9_]{2,32}$/.test(handle))adoptProfileRoute('analyst/'+handle);
    renderProfileModal(body,profile,{maintainer:false});
  }

  // The maintainer record uses the *_public field names of its own endpoint.
  // Mapping it onto the analyst profile shape here is what lets one renderer
  // serve both, so the two can never drift into different presentations of the
  // same facts.
  function maintainerModalProfile(profile){
    return {
      wallet:profile.wallet,
      handle:'',
      display_name:profile.display_name||'',
      bio:profile.bio||'',
      status:'maintainer',
      tier_code:'',
      weight:0,
      expertise:profile.expertise_public||[],
      links:(profile.links_public||[]).slice(),
      contributions:profile.contributions||[],
      proof_history:profile.proof_history||[],
      record:profile.record||null,
      proof_of_work_url:profile.proof_of_work_url||'',
    };
  }

  // One renderer for every public profile the page can open. An analyst and the
  // maintainer differ in exactly two places: the badge, and the facts row that
  // states governance standing. Everything else - expertise, safe links,
  // voluntary support, contributions, proof history - is identical, because the
  // guarantees behind them are identical.
  function renderProfileModal(body,profile,options){
    options=options||{};
    var isMaintainer=options.maintainer===true;
    var links=(profile.links||[]).map(function(link){var url=safeHttps(link.url);return url?'<a data-osi-user-content href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+esc(link.label||url)+'</a>':'';}).join('');
    var proofOfWork=safeHttps(profile.proof_of_work_url);
    if(proofOfWork)links+='<a href="'+esc(proofOfWork)+'" target="_blank" rel="noopener noreferrer">'+esc(t('Verifiable proof of work'))+'</a>';
    // A public reference is the thing a reader looks the work up by, so it is
    // printed whole. Only opaque internal ids are shortened.
    var proofs=(profile.proof_history||[]).map(publicProof).join('');
    var identity=profile.handle?'@'+profile.handle:short(profile.wallet);
    var displayName=profile.display_name||profile.handle||short(profile.wallet);
    // The maintainer holds no analyst standing, no review weight and no quorum
    // vote. Stating that in the same three cells an analyst uses for status,
    // weight and tier makes the difference legible at a glance instead of
    // leaving a reader to infer it from an absence.
    var facts=isMaintainer
      ? '<div><span>'+esc(t('Analyst standing'))+'</span><b>'+esc(t('None'))+'</b></div>'
        +'<div><span>'+esc(t('Review weight'))+'</span><b>'+esc(t('None'))+'</b></div>'
        +'<div><span>'+esc(t('Quorum vote'))+'</span><b>'+esc(t('None'))+'</b></div>'
      : '<div><span>'+esc(t('Status'))+'</span>'+statusBadge(profile.status)+'</div>'
        +'<div><span>'+esc(t('Server-derived weight'))+'</span><b>'+Number(profile.weight||0).toFixed(2)+'</b></div>'
        +'<div><span>'+esc(t('Tier'))+'</span><b>'+esc(label(profile.tier_code))+'</b></div>';
    var badge=isMaintainer
      ? '<span class="osi-status maintainer">'+esc(t('Maintainer'))+'</span>'
      : sasSlot(profile.wallet,profile.status);
    var role=isMaintainer
      ? '<p class="osi-profile-role-note">'+esc(t('Operates the deployment: schema migrations, function rollouts and configuration. What gets published is decided by independent analyst quorum.'))+'</p>'
      : '';
    var expertise=(profile.expertise||[]).map(function(item){return '<span>'+esc(label(item))+'</span>';}).join('');
    // The shareable address for this exact profile, so the page a reader lands
    // on is the page they can send on. A profile with no public handle keeps
    // the wallet as its address; the maintainer has its own single route.
    var route=profileRoute(profile,isMaintainer);
    // Printing needs no address. Two of the three live analysts have never set
    // a public handle, and gating the whole row on a permalink took their
    // save-as-PDF away for a reason that has nothing to do with printing.
    // The address is what a handle buys; the document is not.
    var shareRow='<div class="osi-cv-share">'
      +(route
        ?'<a class="osi-cv-permalink mono" href="'+esc(route)+'" data-cv-permalink>'+esc(route)+'</a>'
          +'<button class="osi-action" type="button" data-cv-copy>'+esc(t('Copy link'))+'</button>'
        // Stated rather than left as a silent absence, and it names the exact
        // unmet prerequisite the way every other unavailable control here does.
        :'<span class="osi-cv-no-permalink">'+esc(t('This profile has no public handle, so it has no shareable address. A wallet is never used as one.'))+'</span>')
      +'<button class="osi-action" type="button" data-cv-print>'+esc(t('Print or save as PDF'))+'</button>'
      +'</div>';
    body.removeAttribute('aria-busy');
    body.innerHTML='<div class="osi-public-profile'+(isMaintainer?' osi-public-profile-maintainer':'')+'"><header>'+avatar(profile,64)+'<div><span class="mono">'+esc(identity)+'</span><h3 data-osi-user-content>'+esc(displayName)+badge+'</h3><p data-osi-user-content>'+esc(profile.bio||'')+'</p></div></header>'
      +'<div class="osi-profile-facts">'+facts+'</div>'+role+shareRow
      +(expertise?'<section><h4>'+esc(t('Expertise'))+'</h4><div class="osi-tag-list">'+expertise+'</div></section>':'')
      +(links?'<section><h4>'+esc(t('Safe public links'))+'</h4><div class="osi-safe-links">'+links+'</div></section>':'')
      +recordSection(profile.record)
      +'<section class="osi-cv-hide-in-print"><h4>'+esc(t('Voluntary support'))+'</h4><p>'+esc(t('Send native SOL directly through Phantom or Solana Pay. Support does not change weight, ranking, eligibility, or governance.'))+'</p><button class="osi-primary-action" type="button" onclick="osiV2SupportAnalyst(\''+esc(profile.wallet)+'\')">'+esc(t('Support with SOL via Phantom or Solana Pay'))+'</button></section>'
      // Proof history stays because it carries what the work record deliberately
      // leaves out: receipts with no public subject at all, such as the
      // credential grant itself. The old "Public contributions" section is gone
      // because the work record is the same facts with the outcome attached, and
      // two lists of one thing that count it differently is how a page stops
      // being believable.
      +'<section><h4>'+esc(t('Proof history'))+'</h4>'+(proofs||empty(t('No public proof recorded'),t('Verified receipts will appear here.')))+'</section></div>';
    bindShareControls(body,route);
  }

  // A CV that cannot be sent is not a CV. These are the two things a reader
  // does with one: copy its address, or put it in a document.
  function profileRoute(profile,isMaintainer){
    var origin=String(window.location.origin||'')+String(window.location.pathname||'');
    if(isMaintainer)return origin+'#maintainer';
    var handle=String(profile&&profile.handle||'').toLowerCase();
    return /^[a-z0-9_]{2,32}$/.test(handle)?origin+'#analyst/'+handle:'';
  }
  function bindShareControls(body,route){
    var copy=route?body.querySelector('[data-cv-copy]'):null,print=body.querySelector('[data-cv-print]');
    // osiCopyText resolves false rather than rejecting when both the clipboard
    // API and the execCommand fallback are refused, so the result is checked
    // instead of assumed: a copy button that silently does nothing is worse
    // than one that says it failed.
    if(copy)copy.addEventListener('click',function(){
      var report=function(copied){
        showToast(copied?t('Profile link copied.'):t('Copy failed. Select the link and copy it manually.'));
      };
      if(typeof window.osiCopyText==='function')Promise.resolve(window.osiCopyText(route)).then(report,function(){report(false);});
      else if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(route).then(function(){report(true);},function(){report(false);});
      else report(false);
    });
    if(print)print.addEventListener('click',function(){window.print();});
  }

  function latestApplication(){return state.workspace&&state.workspace.applications&&state.workspace.applications[0]||null;}
  function latestVersion(application){return application&&application.versions&&application.versions.slice().sort(function(a,b){return Number(b.version_no)-Number(a.version_no);})[0]||null;}
  function workspaceNav(){
    return '<div class="osi-workspace-tabs" role="tablist" aria-label="Analyst workspace sections">'
      +'<button type="button" role="tab" id="osi-workspace-tab-profile" aria-controls="osi-workspace-panel-profile" aria-selected="'+(state.workspaceTab==='profile'?'true':'false')+'" tabindex="'+(state.workspaceTab==='profile'?'0':'-1')+'" class="'+(state.workspaceTab==='profile'?'active':'')+'" data-workspace-tab="profile">My Profile</button>'
      +'<button type="button" role="tab" id="osi-workspace-tab-applications" aria-controls="osi-workspace-panel-applications" aria-selected="'+(state.workspaceTab==='applications'?'true':'false')+'" tabindex="'+(state.workspaceTab==='applications'?'0':'-1')+'" class="'+(state.workspaceTab==='applications'?'active':'')+'" data-workspace-tab="applications">My Applications</button></div>'
      +'<nav class="osi-workspace-tabs" aria-label="Related private work"><button type="button" onclick="osiV2OpenMyCases()">My Cases</button><button type="button" onclick="osiV2OpenMyReports()">My Reports</button><button type="button" onclick="osiV2OpenReviewQueue()">My Reviews</button></nav>';
  }
  function profilePane(){
    var profile=state.workspace&&state.workspace.profile,application=latestApplication();
    if(!profile)return empty('No analyst profile yet','Create an immutable wallet-signed application version to begin.')+'<button class="osi-primary-action" type="button" onclick="apxOpen()">Start analyst application</button>';
    var links=(profile.links_public||[]).map(function(link){var url=safeHttps(link.url);return url?'<a data-osi-user-content href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+esc(link.label)+'</a>':'';}).join(''),identity=profile.handle?'@'+profile.handle:short(profile.wallet);
    var applicationAction=application&&application.status==='revision_requested'
      ?'<button class="osi-primary-action" type="button" onclick="apxOpen()">Submit requested revision</button>'
      :(application?'<div class="osi-callout"><b>Application '+esc(label(application.status))+'</b><span>No new version is needed now. Open My Applications for the exact status and review history.</span></div><button class="osi-secondary-action" type="button" onclick="osiAnalystOpenWorkspace(\'applications\')">Open My Applications</button>':'');
    return '<div class="osi-workspace-profile"><header>'+avatar(profile,58)+'<div><span class="mono">'+esc(identity)+'</span><h3 data-osi-user-content>'+esc(profile.display_name||profile.handle||short(profile.wallet))+'</h3><p data-osi-user-content>'+esc(profile.bio||'')+'</p></div></header>'
      +'<div class="osi-profile-facts"><div><span>Profile status</span>'+statusBadge(profile.status)+'</div><div><span>Tier</span><b>'+esc(label(profile.tier_code))+'</b></div><div><span>Server-derived weight</span><b>'+Number(profile.weight_cached||0).toFixed(2)+'</b></div></div>'
      +'<section><h4>Expertise</h4><div class="osi-tag-list">'+(profile.expertise_public||[]).map(function(item){return '<span>'+esc(label(item))+'</span>';}).join('')+'</div></section>'
      +(links?'<section><h4>Public links</h4><div class="osi-safe-links">'+links+'</div></section>':'')
      +applicationAction+'</div>';
  }
  function reviewHistory(review){return '<div class="osi-review-history"><b>'+esc(label(review.decision))+'</b><span>'+esc(label(review.reason_code))+' / weight '+Number(review.weight||0).toFixed(2)+'</span><time>'+esc(dateText(review.created_at))+'</time></div>';}
  function applicationPane(){
    var applications=state.workspace&&state.workspace.applications||[];
    if(!applications.length)return empty('No applications yet','Start an analyst application to create version 1 with exact wallet proof.')+'<button class="osi-primary-action" type="button" onclick="apxOpen()">Start analyst application</button>';
    return applications.map(function(application){
      var versions=(application.versions||[]).slice().sort(function(a,b){return Number(b.version_no)-Number(a.version_no);});
      var history=versions.map(function(version){var details=version.details_restricted||{};return '<article class="osi-version-card"><header><div><span class="mono">'+esc(version.version_ref)+'</span><h4>Version '+Number(version.version_no)+'</h4></div><span class="osi-proof-badge signed">Wallet-signed and server-verified</span></header><p><b>Motivation:</b> '+esc(details.motivation||'Not recorded')+'</p><p><b>Experience:</b> '+esc(details.experience||'Not recorded')+'</p><div class="osi-tag-list">'+(version.expertise_public||[]).map(function(item){return '<span>'+esc(label(item))+'</span>';}).join('')+'</div><div class="osi-version-meta"><span>Submitted '+esc(dateText(version.submitted_at||version.created_at))+'</span>'+(version.supersedes_version_id?'<span>Supersedes '+esc(short(version.supersedes_version_id))+'</span>':'')+'</div>'+((version.reviews||[]).length?'<div class="osi-review-list">'+version.reviews.map(reviewHistory).join('')+'</div>':'')+'</article>';}).join('');
      var revision=application.status==='revision_requested'?'<div class="osi-callout warning"><b>Revision requested</b><span>Submit a new immutable version. Prior versions and decisions stay visible.</span></div>':'';
      return '<section class="osi-application-card"><header><div><span class="mono">Application '+esc(short(application.id))+'</span><h3>Current version '+Number(latestVersion(application).version_no)+'</h3></div>'+statusBadge(application.status)+'</header>'+revision+history+(application.status==='revision_requested'?'<button class="osi-primary-action" type="button" onclick="apxOpen()">Submit revision</button>':'')+'</section>';
    }).join('');
  }
  function setWorkspaceTab(tab,focusTab){
    if(tab!=='profile'&&tab!=='applications')return;
    state.workspaceTab=tab;
    var host=document.getElementById('identity-body');if(!host)return;
    var activeTab=null;
    host.querySelectorAll('[data-workspace-tab]').forEach(function(button){
      var on=button.dataset.workspaceTab===tab;
      button.classList.toggle('active',on);
      button.setAttribute('aria-selected',on?'true':'false');
      button.setAttribute('tabindex',on?'0':'-1');
      if(on)activeTab=button;
    });
    host.querySelectorAll('[data-workspace-panel]').forEach(function(panel){panel.hidden=panel.dataset.workspacePanel!==tab;});
    if(focusTab&&activeTab)activeTab.focus();
  }
  function workspaceTabKeydown(event){
    if(['ArrowLeft','ArrowRight','Home','End'].indexOf(event.key)===-1)return;
    var list=event.currentTarget.closest('[role="tablist"]');if(!list)return;
    var tabs=Array.prototype.slice.call(list.querySelectorAll('[role="tab"]')),current=tabs.indexOf(event.currentTarget);if(current<0||!tabs.length)return;
    event.preventDefault();
    var next=event.key==='Home'?0:(event.key==='End'?tabs.length-1:(current+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length);
    setWorkspaceTab(tabs[next].dataset.workspaceTab,true);
  }
  function renderWorkspace(){
    var host=document.getElementById('identity-body');if(!host)return;
    host.innerHTML='<div class="osi-analyst-workspace"><header class="osi-workspace-head"><div><span class="mono">MY OSI / ANALYST</span><h2>Analyst workspace</h2><p>One wallet signature starts a bounded private working session that renews silently while you are active.</p></div><button type="button" class="osi-secondary-action" onclick="osiAnalystOpenWorkspace(\''+esc(state.workspaceTab)+'\')">Refresh data</button></header>'+workspaceNav()+'<main><section id="osi-workspace-panel-profile" role="tabpanel" aria-labelledby="osi-workspace-tab-profile" data-workspace-panel="profile"'+(state.workspaceTab==='profile'?'':' hidden')+'>'+profilePane()+'</section><section id="osi-workspace-panel-applications" role="tabpanel" aria-labelledby="osi-workspace-tab-applications" data-workspace-panel="applications"'+(state.workspaceTab==='applications'?'':' hidden')+'>'+applicationPane()+'</section></main></div>';
    host.querySelectorAll('[data-workspace-tab]').forEach(function(button){button.addEventListener('click',function(){setWorkspaceTab(button.dataset.workspaceTab,false);});button.addEventListener('keydown',workspaceTabKeydown);});
  }
  function showNativeWorkspaceView(){
    if(typeof window.osiNavigate==='function')window.osiNavigate('identity',{render:false,focus:false});
    else{document.body.dataset.view='identity';window.scrollTo({top:0,behavior:'auto'});}
  }
  async function openWorkspace(tab){
    state.workspaceTab=tab==='applications'?'applications':'profile';showNativeWorkspaceView();
    var host=document.getElementById('identity-body');if(host)host.innerHTML=workspaceShell('<div class="osi-activation-loading">Unlocking the shared private read session...</div>');
    try{var wallet=await ensureWallet();var result=await sessionRead('analyst:workspace','my_workspace');state.workspace=result;state.workspaceWallet=wallet;renderWorkspace();}
    catch(error){if(host){var refresh=/^read_session_(expired|wrong_scope)$/.test(String(error&&error.message||''));host.innerHTML=workspaceShell(empty('Analyst workspace unavailable',userError(error))+'<div class="osi-workspace-recover"><button class="osi-secondary-action" type="button" onclick="'+(refresh?'osiAnalystRefreshWorkspace(\''+esc(state.workspaceTab)+'\')':'osiAnalystOpenWorkspace(\''+esc(state.workspaceTab)+'\')')+'">'+(refresh?'Refresh private access':'Try again')+'</button></div>');}}
  }

  function setApplicationStatus(text,kind){var node=document.getElementById('an-status');if(node){node.textContent=text||'';node.className='osi-form-status mono '+(kind||'');}}
  function applicationDraftKey(wallet){return'analyst-application:'+String(wallet||'');}
  function applicationDraft(){
    var checked=Array.prototype.map.call(document.querySelectorAll('input[name="an-expertise"]:checked'),function(box){return box.value;});
    return{handle:(document.getElementById('an-handle')||{}).value||'',x_handle:(document.getElementById('an-x-handle')||{}).value||'',display_name:(document.getElementById('an-name')||{}).value||'',bio:(document.getElementById('an-bio')||{}).value||'',motivation:(document.getElementById('an-motivation')||{}).value||'',experience:(document.getElementById('an-experience')||{}).value||'',proof:(document.getElementById('an-proof')||{}).value||'',link_label:(document.getElementById('an-link-label')||{}).value||'',link_url:(document.getElementById('an-link-url')||{}).value||'',expertise:checked,safety:!!(document.getElementById('an-safety')||{}).checked};
  }
  function hasOptionalApplicationData(draft){
    return !!(draft&&(draft.handle||draft.x_handle||draft.display_name||draft.motivation||draft.experience||draft.proof||draft.link_label||draft.link_url||(draft.expertise||[]).length));
  }
  function saveApplicationDraft(){if(walletPubkey&&typeof window.osiV2SaveDraft==='function')window.osiV2SaveDraft(applicationDraftKey(walletPubkey),applicationDraft());}
  function restoreApplicationDraft(wallet){
    if(typeof window.osiV2LoadDraft!=='function')return false;var draft=window.osiV2LoadDraft(applicationDraftKey(wallet));if(!draft)return false;
    var values={'an-handle':draft.handle,'an-x-handle':draft.x_handle,'an-name':draft.display_name,'an-bio':draft.bio,'an-motivation':draft.motivation,'an-experience':draft.experience,'an-proof':draft.proof,'an-link-label':draft.link_label,'an-link-url':draft.link_url};
    Object.keys(values).forEach(function(id){var node=document.getElementById(id);if(node&&values[id]!=null)node.value=values[id];});
    document.querySelectorAll('input[name="an-expertise"]').forEach(function(box){box.checked=(draft.expertise||[]).indexOf(box.value)!==-1;});var safety=document.getElementById('an-safety');if(safety)safety.checked=draft.safety===true;return true;
  }
  function prefillApplication(){
    var profile=state.workspace&&state.workspace.profile,application=latestApplication(),version=latestVersion(application),details=version&&version.details_restricted||{};
    var xLink=(profile&&profile.links_public||[]).find(function(item){return item&&item.label==='X / Twitter';});
    var xHandle=details.x_handle||(xLink&&String(xLink.url||'').split('/').filter(Boolean).pop())||'';
    var values={'an-x-handle':xHandle?'@'+String(xHandle).replace(/^@/,''):'','an-handle':profile&&profile.handle,'an-name':profile&&profile.display_name,'an-bio':profile&&profile.bio,'an-motivation':details.motivation,'an-experience':details.experience,'an-proof':(details.proof_urls||[]).join('\n')};
    Object.keys(values).forEach(function(id){var node=document.getElementById(id);if(node)node.value=values[id]||'';});
    var link=(profile&&profile.links_public||[]).find(function(item){return item&&item.label!=='X / Twitter';});var ll=document.getElementById('an-link-label'),lu=document.getElementById('an-link-url');if(ll)ll.value=link&&link.label||'';if(lu)lu.value=link&&link.url||'';
    var expertise=profile&&profile.expertise_public||version&&version.expertise_public||[];document.querySelectorAll('input[name="an-expertise"]').forEach(function(box){box.checked=expertise.indexOf(box.value)!==-1;});
    var title=document.getElementById('osi-application-title');if(title)title.textContent=application?'Submit immutable application version '+(Number(version&&version.version_no||0)+1):'Create your analyst profile';
  }
  async function openApplication(){
    var generation;
    if(!walletPubkey&&typeof window.osiConnectForIntent==='function'){
      await window.osiConnectForIntent('analyst-application','Analyst application',openApplication);
      return;
    }
    try{
      var wallet=await ensureWallet();
      generation=privateGeneration();
      assertPrivateGeneration(generation);
      var form=document.getElementById('analyst-form');if(form)form.reset();prefillApplication();var restored=restoreApplicationDraft(wallet),optional=document.getElementById('analyst-optional-details');if(optional)optional.open=!!latestApplication()||(restored&&hasOptionalApplicationData(applicationDraft()));state.receipt=null;if(typeof window.osiV2ClearSubmissionReceipt==='function')window.osiV2ClearSubmissionReceipt('osi-analyst-receipt');setApplicationStatus('');
      var modal=document.getElementById('apx-modal');state.returnFocus=document.activeElement;modal.classList.add('open');modal.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';if(typeof showToast==='function')showToast('Application ready. Only the final exact message needs one wallet signature.');setTimeout(function(){var target=document.getElementById('an-bio');var host=document.getElementById('apx-modal');if(!target)return;if(host&&document.activeElement&&host.contains(document.activeElement))return;target.focus();},50);
    }catch(error){if((generation==null||generation===privateGeneration())&&typeof showToast==='function')showToast(userError(error));}
  }
  function closeApplication(){var modal=document.getElementById('apx-modal');if(modal){modal.classList.remove('open');modal.setAttribute('aria-hidden','true');}document.body.style.overflow='';if(state.receipt){state.receipt=null;var form=document.getElementById('analyst-form');if(form)form.reset();if(typeof window.osiV2ClearSubmissionReceipt==='function')window.osiV2ClearSubmissionReceipt('osi-analyst-receipt');}if(state.returnFocus&&typeof state.returnFocus.focus==='function')state.returnFocus.focus();state.returnFocus=null;}
  function inputLines(id){var node=document.getElementById(id);return String(node&&node.value||'').split(/[\n,]+/).map(function(value){return value.trim();}).filter(Boolean);}
  async function avatarPayload(){
    var input=document.getElementById('an-avatar'),file=input&&input.files&&input.files[0];if(!file)return null;
    if(['image/png','image/jpeg'].indexOf(file.type)===-1)throw new Error('Profile image must be PNG or JPEG.');
    if(file.size>524288)throw new Error('Profile image must be 512 KB or smaller.');
    return {mime:file.type,data_base64:bytesToBase64(new Uint8Array(await file.arrayBuffer()))};
  }
  function showApplicationReceipt(committed){
    var application=committed&&committed.application||{};
    state.receipt=application;
    var access=typeof resolveMaintainerAccess==='function'?resolveMaintainerAccess():{allowed:false};
    if(typeof window.osiV2RenderSubmissionReceipt==='function')window.osiV2RenderSubmissionReceipt('osi-analyst-receipt',{
      title:'Analyst application version saved',publicRef:application.version_ref,
      copyValue:application.version_ref||application.id,stage:label(application.status||'submitted'),visibility:'Private',
      where:'My Applications, in the immutable application version history.',
      reviewers:'Full double-gated maintainers. The applicant cannot review or activate their own application.',
      next:'A full maintainer reviews this exact version. Approval does not activate an analyst until a separate confirmed ANALYST_PROBATION Memo is finalized.',
      openLabel:'Open My Applications',
      onOpen:function(){closeApplication();openWorkspace('applications');},
      canOpenQueue:access.allowed===true,
      onQueue:function(){closeApplication();if(typeof window.osiV2OpenReviewQueue==='function')window.osiV2OpenReviewQueue();},
      onDismiss:closeApplication
    });
  }
  async function submitApplication(event){
    if(event)event.preventDefault();var form=document.getElementById('analyst-form');if(!form||!form.reportValidity()||state.busy)return;
    var generation=privateGeneration();
    state.busy=true;var button=document.getElementById('an-submit');if(button){button.disabled=true;button.setAttribute('aria-busy','true');}
    try{
      var wallet=await ensureWallet();var expertise=Array.prototype.map.call(document.querySelectorAll('input[name="an-expertise"]:checked'),function(box){return box.value;});
      assertPrivateGeneration(generation);
      var linkLabel=String(document.getElementById('an-link-label').value||'').trim(),linkUrl=String(document.getElementById('an-link-url').value||'').trim();if((linkLabel&&!linkUrl)||(!linkLabel&&linkUrl))throw new Error('Provide both the public link label and HTTPS URL.');
      var proofUrls=inputLines('an-proof');if(proofUrls.length>5)throw new Error('Use at most five public proof links.');
      var xHandle=String(document.getElementById('an-x-handle').value||'').trim(),handle=String(document.getElementById('an-handle').value||'').trim();
      var application={x_handle:xHandle,handle:handle,display_name:document.getElementById('an-name').value,bio:document.getElementById('an-bio').value,expertise:expertise,links:linkUrl?[{label:linkLabel,url:linkUrl}]:[],motivation:document.getElementById('an-motivation').value,experience:document.getElementById('an-experience').value,proof_urls:proofUrls,safety_acknowledged:document.getElementById('an-safety').checked===true};
      var image=await avatarPayload();assertPrivateGeneration(generation);if(image)application.avatar=image;
      setApplicationStatus('Preparing an exact single-use application message...');
      var prepared=await api({op:'prepare_application',wallet:wallet,application:application,idempotency_key:randomKey('application')});
      assertPrivateGeneration(generation);
      setApplicationStatus('Sign exact '+prepared.version_ref+'. This is not an on-chain transaction.');
      var signature=await signMessage(prepared.message);
      assertPrivateGeneration(generation);
      var committed=await api({op:'commit_application',wallet:wallet,application:application,nonce:prepared.nonce,message:prepared.message,signature:signature});
      assertPrivateGeneration(generation);
      setApplicationStatus('Version '+committed.application.version_no+' recorded as wallet-signed and server-verified.','success');
      if(typeof window.osiV2RemoveDraft==='function')window.osiV2RemoveDraft(applicationDraftKey(wallet));
      state.workspace=null;state.workspaceWallet='';if(typeof showToast==='function')showToast('Immutable analyst application version submitted.');
      showApplicationReceipt(committed);
    }catch(error){if(generation===privateGeneration())setApplicationStatus(userError(error),'error');}
    finally{if(generation===privateGeneration()){state.busy=false;if(button){button.removeAttribute('aria-busy');button.disabled=!!state.receipt;}}}
  }

  function queueReview(app,wallet){return (app.reviews||[]).find(function(review){return review.is_active===true&&review.decision==='approve'&&String(review.reviewer_wallet)===String(wallet);});}
  function queueCard(app){
    var profile=app.profile||{},version=app.version||{},details=version.details_restricted||{},waiting=app.status==='revision_requested',approved=queueReview(app,walletPubkey);
    var proofLinks=(details.proof_urls||[]).map(function(value){var url=safeHttps(value);return url?'<a data-osi-user-content href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+esc(url)+'</a>':'';}).join('');
    return '<article class="osi-ops-application" data-application-id="'+esc(app.id)+'" tabindex="-1"><header>'+avatar(profile,46)+'<div><span class="mono">'+esc(version.version_ref||short(version.id))+'</span><h4 data-osi-user-content>'+esc(profile.display_name||profile.handle||short(app.applicant_wallet))+'</h4><p>'+esc(short(app.applicant_wallet))+' / version '+Number(version.version_no||0)+'</p></div>'+statusBadge(app.status)+'</header>'
      +'<div class="osi-ops-grid"><section><h5>Public profile</h5><p data-osi-user-content>'+esc(profile.bio||'')+'</p><div class="osi-tag-list">'+(version.expertise_public||[]).map(function(item){return '<span>'+esc(label(item))+'</span>';}).join('')+'</div></section><section><h5>Restricted application evidence</h5><p data-osi-user-content><b>Motivation:</b> '+esc(details.motivation||'Not recorded')+'</p><p data-osi-user-content><b>Experience:</b> '+esc(details.experience||'Not recorded')+'</p><div class="osi-safe-links">'+proofLinks+'</div></section></div>'
      +((app.reviews||[]).length?'<div class="osi-review-list">'+app.reviews.map(reviewHistory).join('')+'</div>':'')
      +(waiting?'<div class="osi-callout warning"><b>Waiting for applicant revision</b><span>Review controls stay locked until a new exact version is submitted.</span></div>':'<div class="osi-ops-decision"><label>Reason code<select data-analyst-reason><option value="meets_probationary_baseline">Meets probationary baseline</option><option value="insufficient_public_work">Insufficient public work</option><option value="more_public_work_samples">More public work samples needed</option><option value="unsafe_or_prohibited">Unsafe or prohibited</option></select></label><div><button type="button" data-analyst-decision="approve">Approve</button><button type="button" data-analyst-decision="request_revision">Request revision</button><button type="button" data-analyst-decision="reject">Reject</button></div><p>Abstain is unavailable because it is not in the canonical application decision set.</p></div>')
      +(approved&&!waiting?'<button class="osi-primary-action" type="button" data-analyst-activate>Anchor probation activation</button>':'')+'<div class="osi-form-status mono" data-analyst-status role="status"></div></article>';
  }
  function renderQueue(){
    var host=document.getElementById('osi-analyst-ops');if(!host)return;
    if(!state.queue.length){host.innerHTML=empty('No applications await action','New exact application versions will appear here after server authorization.');return;}
    host.innerHTML=state.queue.map(queueCard).join('');
    host.querySelectorAll('[data-application-id]').forEach(function(card){card.querySelectorAll('[data-analyst-decision]').forEach(function(button){button.addEventListener('click',function(){reviewApplication(card.dataset.applicationId,button.dataset.analystDecision);});});var activate=card.querySelector('[data-analyst-activate]');if(activate)activate.addEventListener('click',function(){activateProbation(card.dataset.applicationId);});});
  }
  async function loadMaintainerQueueData(){
    var access=typeof resolveMaintainerAccess==='function'?resolveMaintainerAccess():{allowed:false};
    if(!access.allowed){state.queue=[];return{authorized:false,applications:[],reason:'full_maintainer_required'};}
    var result=await sessionRead('analyst:maintainer','maintainer_queue');state.queue=Array.isArray(result.applications)?result.applications:[];
    return{authorized:true,applications:state.queue,result:result};
  }
  async function loadQueue(){
    var host=document.getElementById('osi-analyst-ops');if(!host)return;
    var access=typeof resolveMaintainerAccess==='function'?resolveMaintainerAccess():{allowed:false};if(!access.allowed){host.innerHTML=empty('Both maintainer gates are required','Connect the configured admin wallet and restore the authorized Supabase maintainer session.');return{authorized:false,applications:[],reason:'full_maintainer_required'};}
    host.innerHTML='<div class="osi-activation-loading">Unlocking the double-gated Operations read session...</div>';
    try{var loaded=await loadMaintainerQueueData();renderQueue();return loaded;}
    catch(error){state.queue=[];var refresh=/^read_session_(expired|wrong_scope)$/.test(String(error&&error.message||''));host.innerHTML=empty('Application queue unavailable',userError(error))+(refresh?'<button class="osi-primary-action" type="button" onclick="osiAnalystRefreshMaintainerQueue()">Refresh private access</button>':'');return{authorized:false,applications:[],error:String(error&&error.message||'request_failed')};}
  }
  async function openMaintainerApplication(id,expectedVersionRef){
    var loaded=await loadMaintainerQueueData();if(!loaded||loaded.authorized!==true)return loaded;
    var application=state.queue.find(function(item){return String(item.id)===String(id);});
    if(!application||!application.version||String(application.version.version_ref)!==String(expectedVersionRef||'')){
      if(typeof showToast==='function')showToast(t('This exact application task changed. Refresh My Reviews before acting.'));
      return{authorized:true,stale:true,applications:state.queue};
    }
    if(typeof window.osiNavigate==='function')window.osiNavigate('admin',{render:true,focus:false});
    renderQueue();
    var card=document.querySelector('[data-application-id="'+String(id||'').replace(/[^A-Za-z0-9-]/g,'')+'"]');
    if(card){card.scrollIntoView({block:'center',behavior:'smooth'});setTimeout(function(){card.focus();},0);}
    return loaded;
  }
  function queueStatus(appId,text,kind){var card=document.querySelector('[data-application-id="'+String(appId).replace(/[^A-Za-z0-9-]/g,'')+'"]'),node=card&&card.querySelector('[data-analyst-status]');if(node){node.textContent=text;node.className='osi-form-status mono '+(kind||'');}}
  function queueApplication(id){return state.queue.find(function(app){return String(app.id)===String(id);});}
  async function reviewApplication(id,decision){
    if(state.busy)return;var app=queueApplication(id),card=document.querySelector('[data-application-id="'+String(id).replace(/[^A-Za-z0-9-]/g,'')+'"]');if(!app||!app.version||!card)return;
    var generation=privateGeneration();
    state.busy=true;card.querySelectorAll('button,select').forEach(function(node){node.disabled=true;});
    try{
      var wallet=await ensureWallet(),reason=card.querySelector('[data-analyst-reason]').value,review={application_version_id:app.version.id,version_ref:app.version.version_ref,decision:decision,reason_code:reason};
      assertPrivateGeneration(generation);
      queueStatus(id,'Preparing exact '+label(decision)+' review...');var prepared=await api({op:'prepare_review',wallet:wallet,review:review,idempotency_key:randomKey('application-review')});
      assertPrivateGeneration(generation);
      queueStatus(id,'Sign the exact review message. Review weight is 0.');var signature=await signMessage(prepared.message);
      assertPrivateGeneration(generation);
      var committed=await api({op:'commit_review',wallet:wallet,review:review,nonce:prepared.nonce,message:prepared.message,signature:signature});
      assertPrivateGeneration(generation);
      queueStatus(id,'Decision recorded as wallet-signed and server-verified.','success');
      if(committed.activation_ready&&confirm('Approval is recorded. Anchor the exact ANALYST_PROBATION Memo now? Only the standard Solana fee applies.'))await activateProbation(id);
      else await loadQueue();
      assertPrivateGeneration(generation);
    }catch(error){if(generation===privateGeneration())queueStatus(id,userError(error),'error');}
    finally{if(generation===privateGeneration()){state.busy=false;if(card&&document.body.contains(card))card.querySelectorAll('button,select').forEach(function(node){node.disabled=false;});}}
  }
  async function commitActivationWithConfirmation(body,generation){var last;for(var attempt=0;attempt<5;attempt++){assertPrivateGeneration(generation);try{var result=await api(body);assertPrivateGeneration(generation);return result;}catch(error){last=error;if(String(error.message)!=='transaction_not_confirmed')throw error;assertPrivateGeneration(generation);await new Promise(function(resolve){setTimeout(resolve,1600+attempt*900);});assertPrivateGeneration(generation);}}throw last;}
  async function activateProbation(id){
    if(state.busy&&!(document.querySelector('[data-application-id="'+String(id).replace(/[^A-Za-z0-9-]/g,'')+'"]')))return;
    var app=queueApplication(id);if(!app||!app.version)return;var generation=privateGeneration(),previouslyBusy=state.busy;state.busy=true;
    try{
      var wallet=await ensureWallet(),activation={analyst_wallet:app.applicant_wallet,application_version_id:app.version.id,version_ref:app.version.version_ref};
      assertPrivateGeneration(generation);
      queueStatus(id,'Preparing exact ANALYST_PROBATION Memo...');var prepared=await api({op:'prepare_activation',wallet:wallet,activation:activation,idempotency_key:randomKey('analyst-probation')});
      assertPrivateGeneration(generation);
      queueStatus(id,'Approve the probation Memo. Tier probationary and weight 0.50 are server-derived.');var txSig=await castOnchainVote(prepared.memo);
      assertPrivateGeneration(generation);
      queueStatus(id,'Confirming exact signer, Memo, target, payload hash, and mainnet transaction...');var committed=await commitActivationWithConfirmation({op:'commit_activation',wallet:wallet,activation:activation,nonce:prepared.nonce,memo:prepared.memo,tx_sig:txSig},generation);
      assertPrivateGeneration(generation);
      queueStatus(id,'Probation activated at server-derived weight '+Number(committed.analyst.weight).toFixed(2)+'.','success');if(typeof showToast==='function')showToast('Analyst probation is Memo-anchored on Solana.');await Promise.all([loadQueue(),loadPublicProfiles()]);
      assertPrivateGeneration(generation);
    }catch(error){if(generation===privateGeneration())queueStatus(id,userError(error),'error');}
    finally{if(generation===privateGeneration())state.busy=previouslyBusy;}
  }

  var legacyCloseProfile=window.closeAnalystProfile;
  window.closeAnalystProfile=function(){var returnFocus=state.profileReturnFocus;state.profileIntent='';state.profileReturnFocus=null;var modal=document.getElementById('ap-modal');if(modal){modal.classList.remove('open');modal.setAttribute('aria-hidden','true');}document.body.style.overflow='';clearProfileRoute();if(typeof legacyCloseProfile==='function'&&legacyCloseProfile!==window.closeAnalystProfile)legacyCloseProfile();if(returnFocus&&document.contains(returnFocus)&&typeof returnFocus.focus==='function')setTimeout(function(){returnFocus.focus();},0);};

  // ---------------------------------------------------------------------------
  // Shareable profile addresses.
  //
  // #analyst/<handle> and #maintainer are canonical public routes in the same
  // sense #case/<public_ref> is: they carry a public identifier and nothing
  // else. No wallet, no token, no nonce. A profile opened from the roster
  // adopts its address so the thing on screen is the thing that can be sent,
  // and a cold load of that address resolves the one profile it names rather
  // than downloading the whole roster to find it.
  // ---------------------------------------------------------------------------

  function analystRouteHandle(hash){
    var match=/^analyst\/([A-Za-z0-9_]{2,32})$/.exec(String(hash||''));
    return match?match[1].toLowerCase():'';
  }
  function profileRouteOpen(){
    var hash=String(window.location.hash||'').replace(/^#/,'');
    return hash==='maintainer'||!!analystRouteHandle(hash);
  }
  function adoptProfileRoute(hash){
    if(String(window.location.hash||'').replace(/^#/,'')===hash)return;
    // replaceState, not push: opening a profile is a deeper address inside the
    // page the reader is already on, and Back should return them to that page
    // rather than walking back through every profile they glanced at.
    try{window.history.replaceState({osiProfile:hash},'','#'+hash);}catch(_){}
  }
  // Releasing the address cannot go through osiSyncRouteForView: that function
  // now refuses to touch a profile route, which is exactly what makes the
  // address survive a view change, and would make it survive the close too.
  // The hash is set here directly to the view the reader is actually on.
  var VIEW_HASHES={registry:'home',field:'field-office',wire:'wire',records:'public-records',analysts:'analyst-network',prooflog:'proof-log',methodology:'about',identity:'identity',workspace:'workspace',admin:'admin'};
  function clearProfileRoute(){
    if(!profileRouteOpen())return;
    var view=document.body&&document.body.dataset?String(document.body.dataset.view||''):'';
    var target=VIEW_HASHES[view]||'analyst-network';
    try{window.history.replaceState({osiView:view||'analysts'},'','#'+target);}catch(_){}
  }
  // The one-profile read. Used when a handle is addressed directly, so a
  // shared link does not depend on the full roster being loadable.
  async function openProfileByHandle(handle){
    handle=String(handle||'').toLowerCase();
    if(!/^[a-z0-9_]{2,32}$/.test(handle))return null;
    var known=state.profiles.find(function(row){return String(row.handle||'').toLowerCase()===handle;});
    if(known)return openPublicProfile(known.wallet,{route:'analyst/'+handle});
    var body=document.getElementById('ap-modal-body'),modal=document.getElementById('ap-modal');
    if(!body||!modal)return null;
    state.profileIntent='handle:'+handle;
    modal.classList.add('open');modal.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';
    body.setAttribute('aria-busy','true');
    body.innerHTML='<div class="osi-activation-loading" role="status">'+esc(t('Loading the selected analyst profile...'))+'</div>';
    setTimeout(function(){var close=modal.querySelector('.ap-modal-x');if(close)close.focus();},0);
    try{
      var request={op:'get_public_profile',handle:handle};
      var result=typeof window.osiPublicRead==='function'
        ? await window.osiPublicRead('osi-v2-analyst',request)
        : await api(request);
      if(state.profileIntent!=='handle:'+handle)return null;
      var profile=result&&result.analyst;
      if(!profile||!profile.wallet)throw new Error('profile_not_found');
      // Cached so the roster and the modal agree, and so a second open of the
      // same handle does not repeat the read.
      if(!state.profiles.some(function(row){return String(row.wallet)===String(profile.wallet);}))state.profiles.push(profile);
      adoptProfileRoute('analyst/'+handle);
      renderProfileModal(body,profile,{maintainer:false});
      return profile;
    }catch(error){
      if(state.profileIntent!=='handle:'+handle)return null;
      body.removeAttribute('aria-busy');
      body.innerHTML=empty(t('Analyst profile unavailable'),userError(error))
        +'<button class="osi-primary-action" type="button" data-profile-retry>'+esc(t('Retry'))+'</button>';
      var retry=body.querySelector('[data-profile-retry]');
      if(retry)retry.addEventListener('click',function(){openProfileByHandle(handle);});
      return null;
    }
  }
  function routeProfileFromLocation(){
    var hash=String(window.location.hash||'').replace(/^#/,'');
    if(hash==='maintainer'){
      var maintainer=state.maintainerProfile;
      if(maintainer&&maintainer.wallet)return openPublicProfile(maintainer.wallet,{route:'maintainer'});
      return loadMaintainerProfile().then(function(profile){
        if(profile&&profile.wallet&&String(window.location.hash||'').replace(/^#/,'')==='maintainer'){
          return openPublicProfile(profile.wallet,{route:'maintainer'});
        }
        return null;
      });
    }
    var handle=analystRouteHandle(hash);
    if(handle)return openProfileByHandle(handle);
    // Navigating away from a profile address closes the profile it addressed,
    // so Back does what a reader expects instead of leaving a stale panel open.
    var modal=document.getElementById('ap-modal');
    if(modal&&modal.classList.contains('open')&&state.profileIntent)window.closeAnalystProfile();
    return null;
  }
  window.addEventListener('popstate',routeProfileFromLocation);
  window.addEventListener('hashchange',routeProfileFromLocation);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',routeProfileFromLocation,{once:true});
  else setTimeout(routeProfileFromLocation,0);
  window.osiOpenAnalystByHandle=openProfileByHandle;
  window.loadAnalysts=loadPublicProfiles;
  window.renderAnalysts=renderPublicProfiles;
  window.renderLeaderboard=renderPublicProfiles;
  window.openAnalystProfile=function(id){return openPublicProfile(id);};
  window.openRosterProfile=function(id){return openPublicProfile(id);};
  window.osiAnalystOpenWorkspace=openWorkspace;
  window.apxOpen=openApplication;
  window.apxClose=closeApplication;
  window.osiAnalystSubmit=submitApplication;
  window.osiAnalystLoadMaintainerQueue=loadQueue;
  window.osiAnalystLoadReviewTasks=loadMaintainerQueueData;
  window.osiAnalystOpenMaintainerApplication=function(id,expectedVersionRef){return openMaintainerApplication(id,expectedVersionRef).catch(function(error){if(typeof showToast==='function')showToast(userError(error));throw error;});};
  window.osiAnalystRefreshWorkspace=function(tab){return window.osiV2RefreshReadSession(['analyst:workspace']).then(function(){return openWorkspace(tab);});};
  window.osiAnalystRefreshMaintainerQueue=function(){return window.osiV2RefreshReadSession(['analyst:maintainer']).then(loadQueue);};
  window.osiAnalystDecision=reviewApplication;
  window.osiAnalystActivate=activateProbation;

  function clearPrivateAnalystCache(){
    state.workspace=null;state.workspaceWallet='';state.queue=[];state.busy=false;state.receipt=null;state.returnFocus=null;
    if(typeof window.osiV2ClearSubmissionReceipt==='function')window.osiV2ClearSubmissionReceipt('osi-analyst-receipt');
    var form=document.getElementById('analyst-form');if(form)form.reset();
    var modal=document.getElementById('apx-modal');if(modal){modal.classList.remove('open');modal.setAttribute('aria-hidden','true');}
    setApplicationStatus('');
    var submit=document.querySelector('#analyst-form button[type="submit"]');if(submit){submit.disabled=false;submit.removeAttribute('aria-busy');}
    var profileModal=document.getElementById('ap-modal');document.body.style.overflow=profileModal&&profileModal.classList.contains('open')?'hidden':'';
    var host=document.getElementById('identity-body');if(host&&document.body&&document.body.dataset.view==='identity')host.innerHTML=workspaceShell(empty('Analyst workspace locked','Sign once to unlock a bounded private working session. Any application draft in this tab is preserved.')+'<div class="osi-workspace-recover"><button class="osi-secondary-action" type="button" onclick="osiAnalystOpenWorkspace(\''+esc(state.workspaceTab)+'\')">Unlock workspace</button></div>');
    var queueHost=document.getElementById('osi-analyst-ops');if(queueHost)queueHost.innerHTML=empty('Application queue locked','Restore the bounded double-gated private session to continue.');
  }
  if(typeof window.osiV2RegisterPrivateCache==='function')window.osiV2RegisterPrivateCache('analyst',clearPrivateAnalystCache);
  var analystDraftForm=document.getElementById('analyst-form');
  if(analystDraftForm){analystDraftForm.addEventListener('input',saveApplicationDraft);analystDraftForm.addEventListener('change',saveApplicationDraft);}

  function trapModalFocus(event,modal){
    if(event.key!=='Tab'||!modal)return;
    var nodes=Array.prototype.filter.call(modal.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'),function(node){return node.offsetParent!==null;});
    if(!nodes.length)return;
    var first=nodes[0],last=nodes[nodes.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
  document.addEventListener('keydown',function(event){
    var applicationModal=document.getElementById('apx-modal'),profileModal=document.getElementById('ap-modal');
    if(event.key==='Escape'){
      if(applicationModal&&applicationModal.classList.contains('open'))closeApplication();
      else if(profileModal&&profileModal.classList.contains('open'))window.closeAnalystProfile();
      return;
    }
    if(applicationModal&&applicationModal.classList.contains('open'))trapModalFocus(event,applicationModal);
    else if(profileModal&&profileModal.classList.contains('open'))trapModalFocus(event,profileModal);
  });
  window.addEventListener('osi:localechange',function(){
    var profileModal=document.getElementById('ap-modal');
    if(profileModal&&profileModal.classList.contains('open')&&state.profileIntent){
      openPublicProfile(state.profileIntent,{preserveReturnFocus:true,preserveFocus:true});
    }
    if(state.workspace)renderWorkspace();
    if(state.queue.length)renderQueue();
  });
})();
