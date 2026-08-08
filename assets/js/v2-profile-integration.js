/* Owner-controlled V2 wallet profile and public Case attribution UI. */
(function(){
  'use strict';

  var API_URL=SUPABASE_URL+'/functions/v1/osi-v2-profile';
  var AVATAR_PREFIX=SUPABASE_URL+'/storage/v1/object/public/osi-profile-avatars/';
  var state={profile:null,writesEnabled:false,busy:false,loadToken:0,publicLoadToken:0,wallet:'',session:null};

  function esc(value){
    return String(value==null?'':value).replace(/[&<>"']/g,function(char){
      return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char];
    });
  }
  function t(key,variables){
    return typeof window.osiT==='function'?window.osiT(key,variables):String(key||'').replace(/\{([a-zA-Z0-9_]+)\}/g,function(_,name){return variables&&Object.prototype.hasOwnProperty.call(variables,name)?String(variables[name]):'{'+name+'}';});
  }
  function headers(){
    var token=typeof SUPA_AUTH_TOKEN==='string'&&SUPA_AUTH_TOKEN?SUPA_AUTH_TOKEN:SUPABASE_ANON_KEY;
    return{'Content-Type':'application/json','apikey':SUPABASE_ANON_KEY,'Authorization':'Bearer '+token};
  }
  async function api(body){
    var response=await fetch(API_URL,{method:'POST',headers:headers(),body:JSON.stringify(body)}),payload={};
    try{payload=await response.json();}catch(_){payload={ok:false,error:'invalid_server_response'};}
    if(!response.ok||payload.ok!==true){var failure=new Error(payload.error||('request_failed_'+response.status));failure.status=response.status;throw failure;}
    return payload;
  }
  function randomKey(){
    var id=crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(36).slice(2);
    return'profile:'+id.replace(/[^A-Za-z0-9.-]/g,'');
  }
  function privateGeneration(){return typeof window.osiV2PrivateCacheGeneration==='function'?window.osiV2PrivateCacheGeneration():0;}
  function connectedWallet(){return String(typeof walletPubkey==='undefined'?'':walletPubkey||'');}
  function assertPrivateGeneration(generation){if(generation!==privateGeneration())throw new Error('private_session_changed');}
  function trustedAvatar(url){url=String(url||'');return url.indexOf(AVATAR_PREFIX)===0?url:'';}
  function bytesToBase64(bytes){var binary='';for(var i=0;i<bytes.length;i++)binary+=String.fromCharCode(bytes[i]);return btoa(binary);}
  function userError(error){
    var code=String(error&&error.message||'request_failed');
    var messages={
      owner_session_required:'Unlock My Profile with one wallet message signature.',
      owner_profile_unavailable:'Your profile could not be loaded. Try again in a moment.',
      profile_writes_disabled_or_unavailable:'Profile updates are safely disabled while rollout checks are incomplete.',
      handle_unavailable:'That handle is already in use. Choose another.',
      profile_revision_changed:'This profile changed in another session. Reload it before saving.',
      proof_binding_rejected:'The single-use profile proof expired or no longer matches. Save again.',
      bad_signature:'The wallet signature could not be verified.',
      avatar_upload_failed:'The profile image could not be stored. Your profile was not changed.',
      prohibited_secret_material:'Remove every seed phrase, recovery phrase, mnemonic, private key, or secret-key reference.',
      rate_limited:'Too many profile proof requests. Wait a few minutes and try again.',
      read_session_disabled_or_unavailable:'Private profile reads are safely disabled or temporarily unavailable.',
      read_session_required:'Unlock My Profile with one wallet message signature.',
      read_session_scope_denied:'This wallet session cannot read the owner profile scope.',
      read_session_expired:'Your private working session expired. Refresh access to continue.',
      read_session_wrong_origin:'This private session belongs to a different site origin.',
      read_session_wrong_wallet:'This private session belongs to a different wallet.',
      read_session_wrong_scope:'Refresh private access for My Profile.',
      read_session_tampered:'The private session token failed server verification.',
      private_session_changed:'The connected wallet or private session changed. Reopen My Profile.'
    };
    if(messages[code])return t(messages[code]);
    var walletDetail=typeof walletErrorDetail==='function'?walletErrorDetail(error):'';
    return walletDetail||code.replace(/_/g,' ');
  }
  function host(){return document.getElementById('identity-body');}
  function showProfileView(){
    if(typeof window.osiNavigate==='function')window.osiNavigate('identity',{render:false,focus:false});
    else if(document.body){document.body.dataset.view='identity';window.scrollTo({top:0,behavior:'auto'});}
  }
  function shell(body){
    return '<div class="osi-profile-workspace" data-osi-profile-workspace>'
      +'<header class="osi-profile-head"><div><span class="mono">'+esc(t('MY OSI / PROFILE'))+'</span><h1>'+esc(t('My Profile'))+'</h1><p>'+esc(t('Owner-controlled wallet profile. Its visibility does not replace analyst or maintainer identity.'))+'</p></div>'
      +'<button class="osi-profile-secondary" type="button" data-profile-refresh>'+esc(t('Refresh profile'))+'</button></header>'+body+'</div>';
  }
  function publicShell(body){
    return '<div class="osi-profile-workspace" data-osi-public-profile>'
      +'<header class="osi-profile-head"><div><span class="mono">'+esc(t('PUBLIC PROFILE'))+'</span><h1>'+esc(t('Community profile'))+'</h1><p>'+esc(t('Owner-published identity for attributable public Case records.'))+'</p></div>'
      +'<button class="osi-profile-secondary" type="button" data-public-profile-back>'+esc(t('Back to public Cases'))+'</button></header>'+body+'</div>';
  }
  function bindRefresh(container){
    var button=container&&container.querySelector('[data-profile-refresh]');
    if(button)button.addEventListener('click',function(){openProfile({refresh:true});});
  }
  function renderLocked(){
    var node=host();if(!node)return;
    node.innerHTML=shell('<section class="osi-profile-state"><span class="osi-profile-state-mark" aria-hidden="true">ID</span><h2>'+esc(t('Connect a wallet to open My Profile'))+'</h2><p>'+esc(t('Opening this page never connects or signs automatically. Use the control below when you are ready.'))+'</p><button class="osi-profile-primary" type="button" data-profile-connect>'+esc(t('Connect Wallet'))+'</button></section>');
    bindRefresh(node);var connect=node.querySelector('[data-profile-connect]');if(connect)connect.addEventListener('click',connectProfile);
  }
  function renderLoading(){
    var node=host();if(!node)return;
    node.innerHTML=shell('<section class="osi-profile-loading" role="status" aria-live="polite" aria-busy="true"><span class="sr-only">'+esc(t('Loading My Profile'))+'</span><div class="osi-profile-skeleton avatar"></div><div class="osi-profile-loading-lines"><div class="osi-profile-skeleton line"></div><div class="osi-profile-skeleton line short"></div><div class="osi-profile-skeleton block"></div></div></section>');
    bindRefresh(node);
  }
  function renderError(error){
    var node=host();if(!node)return;
    var refresh=/^read_session_(expired|wrong_scope)$/.test(String(error&&error.message||''));
    node.innerHTML=shell('<section class="osi-profile-state error" role="alert"><span class="osi-profile-state-mark" aria-hidden="true">!</span><h2>'+esc(t('My Profile is unavailable'))+'</h2><p>'+esc(userError(error))+'</p><button class="osi-profile-secondary" type="button" data-profile-retry>'+esc(t(refresh?'Refresh private access':'Try again'))+'</button></section>');
    bindRefresh(node);var retry=node.querySelector('[data-profile-retry]');if(retry)retry.addEventListener('click',function(){openProfile({refresh:refresh});});
  }
  function bindPublicBack(container){
    var button=container&&container.querySelector('[data-public-profile-back]');
    if(button)button.addEventListener('click',function(){if(typeof window.osiNavigate==='function')window.osiNavigate('field');});
  }
  function renderPublicLoading(){
    var node=host();if(!node)return;
    node.innerHTML=publicShell('<section class="osi-profile-loading" role="status" aria-live="polite" aria-busy="true"><span class="sr-only">'+esc(t('Loading public profile'))+'</span><div class="osi-profile-skeleton avatar"></div><div class="osi-profile-loading-lines"><div class="osi-profile-skeleton line"></div><div class="osi-profile-skeleton line short"></div><div class="osi-profile-skeleton block"></div></div></section>');
    bindPublicBack(node);
  }
  function renderPublicError(error){
    var node=host();if(!node)return;
    var missing=String(error&&error.message||'')==='profile_not_found';
    node.innerHTML=publicShell('<section class="osi-profile-state error" role="alert"><span class="osi-profile-state-mark" aria-hidden="true">!</span><h2>'+esc(t(missing?'Public profile not found':'Public profile is unavailable'))+'</h2><p>'+esc(t(missing?'This profile is private, no longer published, or the public address is invalid.':'The public profile could not be loaded. Try again in a moment.'))+'</p><button class="osi-profile-secondary" type="button" data-public-profile-retry>'+esc(t('Try again'))+'</button></section>');
    bindPublicBack(node);var retry=node.querySelector('[data-public-profile-retry]');if(retry)retry.addEventListener('click',function(){openPublicProfile(window.location.hash.replace(/^#profile\//,''),{history:true});});
  }
  function publicDate(value){
    try{return new Date(value).toLocaleDateString(document.documentElement.lang==='tr'?'tr-TR':'en-US',{year:'numeric',month:'short',day:'numeric',timeZone:'UTC'});}catch(_){return'';}
  }
  function renderPublicProfile(profile){
    var node=host();if(!node)return;
    var name=profile.display_name||(profile.handle?'@'+profile.handle:t('Community profile'));
    var handle=profile.handle?'@'+profile.handle:'';
    node.innerHTML=publicShell('<div class="osi-profile-public-layout"><main><section class="osi-profile-card osi-profile-public-card"><header class="osi-profile-summary">'+avatar(profile)+'<div><span class="osi-profile-eyebrow">'+esc(t('Public Case submitter'))+'</span><h2 data-osi-user-content>'+esc(name)+'</h2>'+(handle&&handle!==name?'<p class="osi-profile-handle" data-osi-user-content>'+esc(handle)+'</p>':'')+'<div class="osi-profile-ref"><span class="mono">'+esc(profile.public_ref)+'</span><span>'+esc(t('Updated {date}',{date:publicDate(profile.updated_at)}))+'</span></div></div></header>'+(profile.bio?'<div class="osi-profile-public-bio" data-osi-user-content>'+esc(profile.bio)+'</div>':'<div class="osi-profile-public-bio muted">'+esc(t('No public bio provided.'))+'</div>')+'</section></main><aside class="osi-profile-side"><section><b>'+esc(t('Identity boundary'))+'</b><p>'+esc(t('This identity was published by its controlling wallet. A wallet signature proves control, not a real-world identity or the truth of any Case.'))+'</p></section><section><b>'+esc(t('Privacy boundary'))+'</b><p>'+esc(t('Only owner-selected public identity fields appear here. OSI does not expose the profile wallet or private Case data.'))+'</p></section></aside></div>');
    bindPublicBack(node);
  }
  function avatar(profile){
    var name=String(profile&&profile.display_name||profile&&profile.handle||t('Profile owner'));
    var url=trustedAvatar(profile&&profile.avatar_url);
    if(url)return'<img class="osi-profile-avatar" src="'+esc(url)+'" alt="" width="72" height="72">';
    return'<span class="osi-profile-avatar fallback" aria-hidden="true">'+esc((name.charAt(0)||'O').toUpperCase())+'</span>';
  }
  function authorityNote(profile,ctx){
    ctx=ctx||{};
    if(profile&&profile.source==='analyst_fallback'||ctx.isVerifiedAnalyst){
      return'<aside class="osi-profile-boundary" role="note"><b>'+esc(t('Analyst authority stays separate'))+'</b><p>'+esc(t('General identity fields saved here also update your separate public analyst profile, even when this wallet profile is private. Analyst status, tier, review weight, expertise and public links remain server-derived and cannot be changed here.'))+'</p><button class="osi-profile-secondary" type="button" onclick="osiAnalystOpenWorkspace(\'profile\')">'+esc(t('View analyst authority'))+'</button></aside>';
    }
    if(ctx.isMaintainer){
      return'<aside class="osi-profile-boundary" role="note"><b>'+esc(t('Maintainer operator profile stays separate'))+'</b><p>'+esc(t('This owner profile does not grant, replace or edit double-gated maintainer authority.'))+'</p></aside>';
    }
    return'';
  }
  function renderForm(){
    var node=host();if(!node)return;
    var profile=state.profile||{},isPublic=profile.visibility==='public',canWrite=state.writesEnabled===true;
    var ctx=typeof resolveWorkspaceContext==='function'?resolveWorkspaceContext():{};
    var analystIdentityPublic=profile.source==='analyst_fallback'||ctx.isVerifiedAnalyst;
    var privateCopy=analystIdentityPublic?'Your wallet profile stays owner-only. General identity fields you save also update your separate public analyst profile.':'Only you can read this profile through a wallet-authorized session.';
    var defaultPrivacyCopy=analystIdentityPublic?'The wallet profile and Case attribution stay private by default. Saved general identity fields also update the separate public analyst profile.':'Creating a profile does not publish it and does not attribute any Case unless you make both choices explicitly.';
    var handle=profile.handle||'',displayName=profile.display_name||'',bio=profile.bio||'',handleLocked=profile.handle_locked===true;
    var disabled=canWrite?'':' disabled';
    var rollout=canWrite?'':'<div class="osi-profile-rollout" role="note"><b>'+esc(t('Profile updates are currently disabled'))+'</b><span>'+esc(t('You can inspect your saved identity, but no control on this page will claim that a disabled write succeeded.'))+'</span></div>';
    var existing=profile.public_ref?'<span class="mono">'+esc(profile.public_ref)+'</span><span>'+esc(t('Revision {revision}',{revision:Number(profile.revision||0)}))+'</span>':'<span>'+esc(t('No wallet profile has been saved yet.'))+'</span>';
    node.innerHTML=shell('<div class="osi-profile-layout"><main><form id="osi-profile-form" class="osi-profile-form" novalidate>'
      +rollout+'<section class="osi-profile-card"><header class="osi-profile-summary">'+avatar(profile)+'<div><span class="osi-profile-eyebrow">'+esc(t(isPublic?'Public identity':'Private identity'))+'</span><h2 data-osi-user-content>'+esc(displayName||handle||t('New wallet profile'))+'</h2><div class="osi-profile-ref">'+existing+'</div></div></header></section>'
      +'<fieldset class="osi-profile-card"'+disabled+'><legend>'+esc(t('Identity'))+'</legend>'
      +'<label class="osi-profile-field" for="osi-profile-handle"><span>'+esc(t('Username'))+'</span><input id="osi-profile-handle" name="handle" type="text" value="'+esc(handle)+'" minlength="2" maxlength="32" pattern="[A-Za-z0-9_]{2,32}" autocomplete="username" spellcheck="false" aria-describedby="osi-profile-handle-help osi-profile-handle-error"'+(handleLocked?' disabled':'')+'><small id="osi-profile-handle-help">'+esc(t(handleLocked?'This username cannot be renamed after its first publication.':'2 to 32 letters, numbers or underscores. Saved in lowercase.'))+'</small><small class="osi-profile-field-error" id="osi-profile-handle-error"></small></label>'
      +'<label class="osi-profile-field" for="osi-profile-name"><span>'+esc(t('Display name'))+'</span><input id="osi-profile-name" name="display_name" type="text" value="'+esc(displayName)+'" minlength="2" maxlength="80" autocomplete="name" aria-describedby="osi-profile-name-help osi-profile-name-error"><small id="osi-profile-name-help">'+esc(t('Shown with your username when the profile is public.'))+'</small><small class="osi-profile-field-error" id="osi-profile-name-error"></small></label>'
      +'<label class="osi-profile-field" for="osi-profile-bio"><span>'+esc(t('Bio'))+'</span><textarea id="osi-profile-bio" name="bio" rows="5" maxlength="600" aria-describedby="osi-profile-bio-help">'+esc(bio)+'</textarea><small id="osi-profile-bio-help">'+esc(t('Up to 600 characters. Never include seed phrases, private keys or private personal data.'))+'</small></label></fieldset>'
      +'<fieldset class="osi-profile-card"'+disabled+'><legend>'+esc(t('Profile image'))+'</legend><label class="osi-profile-field" for="osi-profile-avatar"><span>'+esc(t('PNG or JPEG'))+'</span><input id="osi-profile-avatar" type="file" accept="image/png,image/jpeg" aria-describedby="osi-profile-avatar-help osi-profile-avatar-retention osi-profile-avatar-error"><small id="osi-profile-avatar-help">'+esc(t('64 to 1024 pixels on each side, 512 KB maximum.'))+'</small><small id="osi-profile-avatar-retention">'+esc(t('Replacing or removing an image stops its current display. A previously shared public image URL may remain reachable because profile images use content-addressed retention.'))+'</small><small class="osi-profile-field-error" id="osi-profile-avatar-error"></small></label>'
      +(trustedAvatar(profile.avatar_url)?'<label class="osi-profile-check" for="osi-profile-avatar-remove"><input id="osi-profile-avatar-remove" type="checkbox"><span>'+esc(t('Remove current profile image when I save'))+'</span></label>':'')+'</fieldset>'
      +'<fieldset class="osi-profile-card"'+disabled+'><legend>'+esc(t('Privacy and Case attribution'))+'</legend><div class="osi-profile-choice"><label for="osi-profile-private"><input id="osi-profile-private" name="profile_visibility" type="radio" value="private"'+(isPublic?'':' checked')+'><span><b>'+esc(t('Private'))+'</b><small>'+esc(t(privateCopy))+'</small></span></label><label for="osi-profile-public"><input id="osi-profile-public" name="profile_visibility" type="radio" value="public"'+(isPublic?' checked':'')+'><span><b>'+esc(t('Public'))+'</b><small>'+esc(t('Anyone can read your chosen identity fields. Wallet proof is not identity verification.'))+'</small></span></label></div>'
      +'<label class="osi-profile-check attribution" for="osi-profile-attribution"><input id="osi-profile-attribution" type="checkbox"'+(profile.attribute_public_cases===true?' checked':'')+(isPublic?'':' disabled')+'><span><b>'+esc(t('Attribute my current and future public Cases to this profile'))+'</b><small>'+esc(t('Explicit consent applies retroactively to public Cases you already submitted and to public Cases you submit later. Turning it off removes profile attribution without deleting Case history.'))+'</small></span></label></fieldset>'
      +authorityNote(profile,ctx)+'<div class="osi-profile-actions"><div id="osi-profile-status" class="osi-profile-status" role="status" aria-live="polite"></div><button class="osi-profile-primary" id="osi-profile-save" type="submit"'+(canWrite?'':' disabled')+'>'+esc(t(canWrite?'Review and sign update':'Profile updates disabled'))+'</button></div></form></main>'
      +'<aside class="osi-profile-side"><section><b>'+esc(t('Proof boundary'))+'</b><p>'+esc(t('Saving uses one wallet message signature. It is wallet-signed and server-verified, not an on-chain transaction.'))+'</p></section><section><b>'+esc(t('Default private'))+'</b><p>'+esc(t(defaultPrivacyCopy))+'</p></section></aside></div>');
    bindRefresh(node);bindForm(node);
  }
  function status(text,kind){var node=document.getElementById('osi-profile-status');if(node){node.textContent=text||'';node.className='osi-profile-status '+(kind||'');}}
  function clearErrors(){
    ['handle','name','avatar'].forEach(function(name){var input=document.getElementById('osi-profile-'+name),error=document.getElementById('osi-profile-'+name+'-error');if(input)input.removeAttribute('aria-invalid');if(error)error.textContent='';});
  }
  function fieldError(name,message){
    var input=document.getElementById('osi-profile-'+name),error=document.getElementById('osi-profile-'+name+'-error');
    if(input){input.setAttribute('aria-invalid','true');input.focus();}if(error)error.textContent=message;
  }
  async function imageSize(file){
    if(typeof createImageBitmap==='function'){
      var bitmap=await createImageBitmap(file);var size={width:bitmap.width,height:bitmap.height};if(typeof bitmap.close==='function')bitmap.close();return size;
    }
    return await new Promise(function(resolve,reject){var url=URL.createObjectURL(file),image=new Image();image.onload=function(){var size={width:image.naturalWidth,height:image.naturalHeight};URL.revokeObjectURL(url);resolve(size);};image.onerror=function(){URL.revokeObjectURL(url);reject(new Error('Profile image could not be read.'));};image.src=url;});
  }
  async function avatarPayload(){
    var input=document.getElementById('osi-profile-avatar'),file=input&&input.files&&input.files[0];if(!file)return null;
    if(['image/png','image/jpeg'].indexOf(file.type)===-1)throw new Error('Profile image must be PNG or JPEG.');
    if(file.size>524288)throw new Error('Profile image must be 512 KB or smaller.');
    var dimensions=await imageSize(file);
    if(dimensions.width<64||dimensions.height<64||dimensions.width>1024||dimensions.height>1024)throw new Error('Profile image dimensions must be between 64 and 1024 pixels.');
    return{mime:file.type,data_base64:bytesToBase64(new Uint8Array(await file.arrayBuffer()))};
  }
  function visibility(){var selected=document.querySelector('input[name="profile_visibility"]:checked');return selected?selected.value:'private';}
  async function formPayload(){
    var remove=document.getElementById('osi-profile-avatar-remove'),image=await avatarPayload();
    var profile={
      handle:String(document.getElementById('osi-profile-handle').value||'').trim().toLowerCase(),
      display_name:String(document.getElementById('osi-profile-name').value||'').trim(),
      bio:String(document.getElementById('osi-profile-bio').value||'').trim(),
      visibility:visibility(),
      attribute_public_cases:visibility()==='public'&&document.getElementById('osi-profile-attribution').checked===true,
      avatar_action:image?'replace':(remove&&remove.checked?'remove':'keep')
    };
    if(image)profile.avatar=image;
    return profile;
  }
  function syncPrivacy(){
    var publicMode=visibility()==='public',attribution=document.getElementById('osi-profile-attribution');
    if(attribution){attribution.disabled=!publicMode||state.writesEnabled!==true;if(!publicMode)attribution.checked=false;}
  }
  async function validateAvatar(){
    var input=document.getElementById('osi-profile-avatar');if(!input||!input.files||!input.files[0])return true;
    try{await avatarPayload();var remove=document.getElementById('osi-profile-avatar-remove');if(remove)remove.checked=false;return true;}
    catch(error){fieldError('avatar',t(error.message));return false;}
  }
  function bindForm(container){
    var form=container.querySelector('#osi-profile-form');if(!form)return;
    form.addEventListener('submit',saveProfile);
    form.querySelectorAll('input[name="profile_visibility"]').forEach(function(input){input.addEventListener('change',syncPrivacy);});
    var file=form.querySelector('#osi-profile-avatar');if(file)file.addEventListener('change',function(){clearErrors();validateAvatar();});
    syncPrivacy();
  }
  async function saveProfile(event){
    if(event)event.preventDefault();if(state.busy||state.writesEnabled!==true)return;
    var form=document.getElementById('osi-profile-form');if(!form)return;clearErrors();
    if(!form.reportValidity())return;
    if(visibility()==='public'&&!String(document.getElementById('osi-profile-handle').value||'').trim()&&!String(document.getElementById('osi-profile-name').value||'').trim()){
      fieldError('name',t('Add a username or display name before publishing.'));return;
    }
    if(!await validateAvatar())return;
    var generation=privateGeneration(),button=document.getElementById('osi-profile-save');state.busy=true;
    if(button){button.disabled=true;button.setAttribute('aria-busy','true');button.textContent=t('Preparing update');}
    try{
      var wallet=connectedWallet();if(!wallet||wallet!==state.wallet)throw new Error('private_session_changed');
      var profile=await formPayload();assertPrivateGeneration(generation);
      status(t('Preparing an exact single-use profile message...'));
      var prepared=await api({op:'prepare_profile_update',wallet:wallet,profile:profile,idempotency_key:randomKey()});assertPrivateGeneration(generation);
      status(t('Approve the exact WALLET_PROFILE_UPDATED message. This is not an on-chain transaction.'));
      var signature;
      if(typeof window.osiV2ApproveMessage==='function')signature=await window.osiV2ApproveMessage(prepared.message);
      else throw new Error('wallet_sign_message_unavailable');
      assertPrivateGeneration(generation);if(button)button.textContent=t('Saving profile');
      var committed=await api({op:'commit_profile_update',wallet:wallet,profile:profile,nonce:prepared.nonce,signature:signature});assertPrivateGeneration(generation);
      if(typeof window.osiPublicReadInvalidate==='function')window.osiPublicReadInvalidate();
      var refreshed;
      try{refreshed=await api({op:'get_my_profile',wallet:wallet,read_session:state.session&&state.session.token});assertPrivateGeneration(generation);}catch(_){refreshed=null;}
      state.profile=refreshed&&refreshed.profile?refreshed.profile:Object.assign({},state.profile||{},profile,{public_ref:committed.public_ref,revision:committed.revision,source:'wallet_profile'});
      renderForm();status(t('Profile saved. Your visibility and Case attribution choices are now current.'),'success');
      if(typeof showToast==='function')showToast(t('Profile saved.'));
    }catch(error){
      if(generation!==privateGeneration())return;
      if(String(error&&error.message)==='handle_unavailable')fieldError('handle',t('That handle is already in use. Choose another.'));
      status(userError(error),'error');
    }finally{
      state.busy=false;button=document.getElementById('osi-profile-save');if(button){button.disabled=state.writesEnabled!==true;button.removeAttribute('aria-busy');button.textContent=t(state.writesEnabled?'Review and sign update':'Profile updates disabled');}
    }
  }
  async function connectProfile(){
    if(typeof toggleWallet!=='function')return;
    try{await toggleWallet();if(connectedWallet())openProfile();}catch(error){renderError(error);}
  }
  async function openProfile(options){
    options=options||{};showProfileView();var token=++state.loadToken,wallet=connectedWallet();
    if(!wallet){state.profile=null;state.wallet='';state.session=null;renderLocked();return;}
    state.wallet=wallet;renderLoading();var generation=privateGeneration();
    var rollout=api({op:'rollout_status'}).catch(function(){return{profile_writes_enabled:false};});
    try{
      if(typeof window.osiV2ReadSession!=='function')throw new Error('read_session_disabled_or_unavailable');
      var session=options.refresh&&typeof window.osiV2RefreshReadSession==='function'
        ?await window.osiV2RefreshReadSession(['profile:self'])
        :await window.osiV2ReadSession(['profile:self'],{allowUnlock:true});
      assertPrivateGeneration(generation);if(token!==state.loadToken||session.wallet!==wallet)throw new Error('private_session_changed');
      var result=await api({op:'get_my_profile',wallet:session.wallet,read_session:session.token});assertPrivateGeneration(generation);
      var flags=await rollout;if(token!==state.loadToken)return;
      state.session=session;state.profile=result.profile||null;state.writesEnabled=flags.profile_writes_enabled===true;renderForm();
    }catch(error){if(token===state.loadToken&&generation===privateGeneration())renderError(error);}
  }
  function publicProfileReference(value){
    value=decodeURIComponent(String(value||'').trim());
    if(/^OSI-PRF-[A-F0-9]{16}$/.test(value.toUpperCase()))return{public_ref:value.toUpperCase(),route:value.toUpperCase()};
    if(/^[A-Za-z0-9_]{2,32}$/.test(value))return{handle:value.toLowerCase(),route:value.toLowerCase()};
    return null;
  }
  async function openPublicProfile(reference,options){
    options=options||{};var parsed=publicProfileReference(reference),token=++state.publicLoadToken;
    showProfileView();
    if(!parsed){renderPublicError(new Error('profile_not_found'));return;}
    if(!options.history){try{window.history.pushState({osiProfile:parsed.route},'','#profile/'+encodeURIComponent(parsed.route));}catch(_){}}
    renderPublicLoading();
    try{var result=await api(Object.assign({op:'get_public_profile'},parsed));if(token!==state.publicLoadToken)return;renderPublicProfile(result.profile);}
    catch(error){if(token===state.publicLoadToken)renderPublicError(error);}
  }
  function clearPrivateProfileCache(){
    ++state.loadToken;state.profile=null;state.session=null;state.wallet='';state.busy=false;state.writesEnabled=false;
    var node=host();if(node&&node.querySelector('[data-osi-profile-workspace]')&&document.body&&document.body.dataset.view==='identity')renderLocked();
  }

  window.osiV2OpenMyProfile=openProfile;
  window.osiV2OpenPublicProfile=openPublicProfile;
  window.osiV2ConnectProfile=connectProfile;
  window.osiV2SaveMyProfile=saveProfile;
  if(typeof window.osiV2RegisterPrivateCache==='function')window.osiV2RegisterPrivateCache('wallet-profile',clearPrivateProfileCache);
})();
