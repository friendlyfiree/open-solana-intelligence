/* Native V2 analyst identity, application, review, and probation activation. */
(function(){
  'use strict';

  var API_URL=SUPABASE_URL+'/functions/v1/osi-v2-analyst';
  var AVATAR_PREFIX=SUPABASE_URL+'/storage/v1/object/public/osi-analyst-avatars/';
  var state={profiles:[],workspace:null,workspaceWallet:'',workspaceTab:'profile',queue:[],busy:false,returnFocus:null};

  function esc(value){
    return String(value==null?'':value).replace(/[&<>"']/g,function(char){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char];
    });
  }
  function short(value){value=String(value||'');return value.length>18?value.slice(0,8)+'...'+value.slice(-6):value;}
  function label(value){return String(value||'').replace(/_/g,' ').replace(/\b\w/g,function(char){return char.toUpperCase();});}
  function dateText(value){var date=new Date(value||'');return isNaN(date.getTime())?'Not recorded':date.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});}
  function randomKey(prefix){var id=crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(36).slice(2);return prefix+':'+id.replace(/[^A-Za-z0-9.-]/g,'');}
  function headers(){var token=(typeof SUPA_AUTH_TOKEN==='string'&&SUPA_AUTH_TOKEN)?SUPA_AUTH_TOKEN:SUPABASE_ANON_KEY;return {'Content-Type':'application/json','apikey':SUPABASE_ANON_KEY,'Authorization':'Bearer '+token};}
  async function api(body){
    var response=await fetch(API_URL,{method:'POST',headers:headers(),body:JSON.stringify(body)});
    var payload={};try{payload=await response.json();}catch(_){payload={ok:false,error:'invalid_server_response'};}
    if(!response.ok||payload.ok!==true){var failure=new Error(payload.error||('request_failed_'+response.status));failure.status=response.status;throw failure;}
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
      concurrent_retry:'Another operation changed this record. Refresh and try again.'
      ,read_session_disabled_or_unavailable:'Private read sessions are safely disabled or temporarily unavailable.'
      ,read_session_required:'Unlock private views with one wallet signature.'
      ,read_session_expired:'Your five-minute private read session expired. Refresh it explicitly to continue.'
      ,read_session_wrong_origin:'This private session belongs to a different site origin.'
      ,read_session_wrong_wallet:'This private session belongs to a different wallet.'
      ,read_session_wrong_scope:'Refresh private access explicitly for this role.'
      ,read_session_tampered:'The private session token failed server verification.'
    };
    return messages[code]||code.replace(/_/g,' ');
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
    return await api({op:op,wallet:session.wallet,read_session:session.token});
  }
  function trustedAvatar(url){url=String(url||'');return url.indexOf(AVATAR_PREFIX)===0?url:'';}
  function safeHttps(url){
    try{var parsed=new URL(String(url||''));return parsed.protocol==='https:'&&!parsed.username&&!parsed.password?parsed.toString():'';}catch(_){return '';}
  }
  function avatar(profile,size){
    var url=trustedAvatar(profile&&profile.avatar_url);
    if(url)return '<img class="osi-an-avatar" src="'+esc(url)+'" alt="" width="'+size+'" height="'+size+'" loading="lazy">';
    return typeof osiAvatarSvg==='function'?osiAvatarSvg(profile.wallet,size,profile.display_name||profile.handle,''):'<span class="osi-an-avatar fallback">'+esc((profile.display_name||profile.handle||'?').charAt(0).toUpperCase())+'</span>';
  }
  function proofLabel(type){return type==='solana_memo'?'Memo-anchored on Solana':type==='wallet_signed_server_verified'?'Wallet-signed and server-verified':'Legacy, not server-verified';}
  function solFromLamports(value){var text=String(value==null?'0':value);if(!/^\d+$/.test(text))return'0';text=text.replace(/^0+(?=\d)/,'');var padded=text.padStart(10,'0'),whole=padded.slice(0,-9),fraction=padded.slice(-9).replace(/0+$/,'');return whole+(fraction?'.'+fraction:'');}
  function statusBadge(status){return '<span class="osi-status '+esc(status)+'">'+esc(label(status))+'</span>';}
  function empty(title,body){return '<div class="osi-activation-empty"><b>'+esc(title)+'</b><span>'+esc(body)+'</span></div>';}

  function syncAnalystMaps(rows){
    var profiles={},weights={};
    rows.forEach(function(row){profiles[String(row.wallet)]={handle:row.handle,name:row.display_name,avatar_url:trustedAvatar(row.avatar_url),status:row.status,tier_code:row.tier_code,weight:Number(row.weight||0)};weights[String(row.wallet)]=Number(row.weight||0);});
    window.VERIFIED_ANALYSTS=profiles;window.ANALYST_WEIGHT=weights;
  }
  function publicRow(profile){
    var expertise=(profile.expertise||[]).map(function(item){return '<span>'+esc(label(item))+'</span>';}).join('');
    var contributions=(profile.contributions||[]).length;
    var proofs=(profile.proof_history||[]).length;
    return '<button class="osi-analyst-row" type="button" data-analyst-wallet="'+esc(profile.wallet)+'">'
      +'<span class="osi-analyst-person">'+avatar(profile,38)+'<span><b>'+esc(profile.display_name||profile.handle||short(profile.wallet))+'</b><em>@'+esc(profile.handle||short(profile.wallet))+'</em></span></span>'
      +'<span>'+statusBadge(profile.status)+'</span><span class="osi-expertise-list">'+(expertise||'<em>Not listed</em>')+'</span>'
      +'<span class="mono">'+contributions+'</span><span class="mono osi-weight">'+Number(profile.weight||0).toFixed(2)+'</span><span class="mono">'+proofs+'</span></button>';
  }
  function renderPublicProfiles(){
    var host=document.getElementById('lb-body'),count=document.getElementById('lb-count'),pager=document.getElementById('lb-pnav');
    if(!host)return;
    if(pager)pager.innerHTML='';
    if(!state.profiles.length){
      host.innerHTML='<div class="osi-activation-empty"><b>No activated analysts yet</b><span>Approved probationary analysts will appear here with server-derived status, weight, contributions, and proof.</span><button class="osi-empty-cta" type="button" onclick="apxOpen()">Start analyst application</button></div>';
      if(count)count.textContent='0 analysts';
      return;
    }
    host.innerHTML=state.profiles.map(publicRow).join('');if(count)count.textContent=state.profiles.length+' analyst'+(state.profiles.length===1?'':'s');
    host.querySelectorAll('[data-analyst-wallet]').forEach(function(button){button.addEventListener('click',function(){openPublicProfile(button.dataset.analystWallet);});});
  }
  async function loadPublicProfiles(){
    var host=document.getElementById('lb-body');if(host)host.innerHTML='<div class="osi-activation-loading">Loading verified server-derived profiles...</div>';
    try{var result=await api({op:'list_public_profiles'});state.profiles=Array.isArray(result.analysts)?result.analysts:[];syncAnalystMaps(state.profiles);renderPublicProfiles();}
    catch(error){state.profiles=[];syncAnalystMaps([]);if(host)host.innerHTML=empty('Analyst directory unavailable',userError(error));}
    return state.profiles;
  }
  function publicProof(row){
    var tx=row.proof_type==='solana_memo'&&/^[1-9A-HJ-NP-Za-km-z]{64,96}$/.test(String(row.tx_sig||''))?'<a href="https://solscan.io/tx/'+encodeURIComponent(row.tx_sig)+'" target="_blank" rel="noopener noreferrer">Verify on Solscan</a>':'';
    var payment=row.payment_proof&&row.event_type==='SUPPORT_PAYMENT_CONFIRMED'?'<span>'+esc(solFromLamports(row.payment_proof.recipient_amount_lamports))+' SOL / '+esc(row.payment_proof.recipient_amount_lamports)+' lamports / '+esc(label(row.payment_proof.finality))+'</span>':'';
    return '<div class="osi-history-row"><div><b>'+esc(label(row.event_type))+'</b><span>'+esc(row.payment_proof?'SOL transfer verified on Solana':proofLabel(row.proof_type))+' / actor '+esc(label(row.actor_role))+'</span>'+payment+'</div><time>'+esc(dateText(row.occurred_at))+'</time>'+tx+'</div>';
  }
  function openPublicProfile(wallet){
    var profile=state.profiles.find(function(row){return String(row.wallet)===String(wallet);});if(!profile)return;
    var links=(profile.links||[]).map(function(link){var url=safeHttps(link.url);return url?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+esc(link.label||url)+'</a>':'';}).join('');
    var contributions=(profile.contributions||[]).map(function(row){return '<div class="osi-history-row"><div><b>'+esc(label(row.kind))+'</b><span>'+esc(label(row.subject_type))+' / '+esc(short(row.subject_id))+'</span></div><time>'+esc(dateText(row.created_at))+'</time></div>';}).join('');
    var proofs=(profile.proof_history||[]).map(publicProof).join('');
    var body=document.getElementById('ap-modal-body');if(!body)return;
    body.innerHTML='<div class="osi-public-profile"><header>'+avatar(profile,64)+'<div><span class="mono">@'+esc(profile.handle)+'</span><h3>'+esc(profile.display_name||profile.handle)+'</h3><p>'+esc(profile.bio)+'</p></div></header>'
      +'<div class="osi-profile-facts"><div><span>Status</span>'+statusBadge(profile.status)+'</div><div><span>Server-derived weight</span><b>'+Number(profile.weight||0).toFixed(2)+'</b></div><div><span>Tier</span><b>'+esc(label(profile.tier_code))+'</b></div></div>'
      +'<section><h4>Expertise</h4><div class="osi-tag-list">'+(profile.expertise||[]).map(function(item){return '<span>'+esc(label(item))+'</span>';}).join('')+'</div></section>'
      +(links?'<section><h4>Safe public links</h4><div class="osi-safe-links">'+links+'</div></section>':'')
      +'<section><h4>Voluntary support</h4><p>Send native SOL directly to this verified analyst wallet. Support does not change weight, ranking, eligibility, or governance.</p><button class="osi-primary-action" type="button" onclick="osiV2SupportAnalyst(\''+esc(profile.wallet)+'\')">Support analyst with SOL</button></section>'
      +'<section><h4>Public contributions</h4>'+(contributions||empty('No public contributions recorded','Contribution history appears after attributable public work.'))+'</section>'
      +'<section><h4>Proof history</h4>'+(proofs||empty('No public proof recorded','Verified receipts will appear here.'))+'</section></div>';
    var modal=document.getElementById('ap-modal');modal.classList.add('open');modal.setAttribute('aria-hidden','false');
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
    var links=(profile.links_public||[]).map(function(link){var url=safeHttps(link.url);return url?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+esc(link.label)+'</a>':'';}).join('');
    return '<div class="osi-workspace-profile"><header>'+avatar(profile,58)+'<div><span class="mono">@'+esc(profile.handle)+'</span><h3>'+esc(profile.display_name)+'</h3><p>'+esc(profile.bio)+'</p></div></header>'
      +'<div class="osi-profile-facts"><div><span>Profile status</span>'+statusBadge(profile.status)+'</div><div><span>Tier</span><b>'+esc(label(profile.tier_code))+'</b></div><div><span>Server-derived weight</span><b>'+Number(profile.weight_cached||0).toFixed(2)+'</b></div></div>'
      +'<section><h4>Expertise</h4><div class="osi-tag-list">'+(profile.expertise_public||[]).map(function(item){return '<span>'+esc(label(item))+'</span>';}).join('')+'</div></section>'
      +(links?'<section><h4>Public links</h4><div class="osi-safe-links">'+links+'</div></section>':'')
      +'<button class="osi-primary-action" type="button" onclick="apxOpen()">'+(application&&application.status==='revision_requested'?'Submit requested revision':'Submit a new application version')+'</button></div>';
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
    host.innerHTML='<div class="osi-analyst-workspace"><header class="osi-workspace-head"><div><span class="mono">MY OSI / ANALYST</span><h2>Analyst workspace</h2><p>Private application history uses the shared five-minute wallet-authenticated read session.</p></div><button type="button" class="osi-secondary-action" onclick="osiAnalystOpenWorkspace(\''+esc(state.workspaceTab)+'\')">Refresh data</button></header>'+workspaceNav()+'<main><section id="osi-workspace-panel-profile" role="tabpanel" aria-labelledby="osi-workspace-tab-profile" data-workspace-panel="profile"'+(state.workspaceTab==='profile'?'':' hidden')+'>'+profilePane()+'</section><section id="osi-workspace-panel-applications" role="tabpanel" aria-labelledby="osi-workspace-tab-applications" data-workspace-panel="applications"'+(state.workspaceTab==='applications'?'':' hidden')+'>'+applicationPane()+'</section></main></div>';
    host.querySelectorAll('[data-workspace-tab]').forEach(function(button){button.addEventListener('click',function(){setWorkspaceTab(button.dataset.workspaceTab,false);});button.addEventListener('keydown',workspaceTabKeydown);});
  }
  function showNativeWorkspaceView(){
    if(typeof window.osiNavigate==='function')window.osiNavigate('identity',{render:false,focus:false});
    else{document.body.dataset.view='identity';window.scrollTo({top:0,behavior:'auto'});}
  }
  async function openWorkspace(tab){
    state.workspaceTab=tab==='applications'?'applications':'profile';showNativeWorkspaceView();
    var host=document.getElementById('identity-body');if(host)host.innerHTML='<div class="osi-activation-loading">Unlocking the shared private read session...</div>';
    try{var wallet=await ensureWallet();var result=await sessionRead('analyst:workspace','my_workspace');state.workspace=result;state.workspaceWallet=wallet;renderWorkspace();}
    catch(error){if(host){var refresh=/^read_session_(expired|wrong_scope)$/.test(String(error&&error.message||''));host.innerHTML=empty('Analyst workspace unavailable',userError(error))+'<button class="osi-primary-action" type="button" onclick="'+(refresh?'osiAnalystRefreshWorkspace(\''+esc(state.workspaceTab)+'\')':'osiAnalystOpenWorkspace(\''+esc(state.workspaceTab)+'\')')+'">'+(refresh?'Refresh private access':'Try again')+'</button>';}}
  }

  function setApplicationStatus(text,kind){var node=document.getElementById('an-status');if(node){node.textContent=text||'';node.className='osi-form-status mono '+(kind||'');}}
  function prefillApplication(){
    var profile=state.workspace&&state.workspace.profile,application=latestApplication(),version=latestVersion(application),details=version&&version.details_restricted||{};
    var values={'an-handle':profile&&profile.handle,'an-name':profile&&profile.display_name,'an-bio':profile&&profile.bio,'an-motivation':details.motivation,'an-experience':details.experience,'an-proof':(details.proof_urls||[]).join('\n')};
    Object.keys(values).forEach(function(id){var node=document.getElementById(id);if(node)node.value=values[id]||'';});
    var link=profile&&profile.links_public&&profile.links_public[0];var ll=document.getElementById('an-link-label'),lu=document.getElementById('an-link-url');if(ll)ll.value=link&&link.label||'';if(lu)lu.value=link&&link.url||'';
    var expertise=profile&&profile.expertise_public||version&&version.expertise_public||[];document.querySelectorAll('input[name="an-expertise"]').forEach(function(box){box.checked=expertise.indexOf(box.value)!==-1;});
    var title=document.getElementById('osi-application-title');if(title)title.textContent=application?'Submit immutable application version '+(Number(version&&version.version_no||0)+1):'Create your analyst profile';
  }
  async function openApplication(){
    try{
      var wallet=await ensureWallet();
      if(!state.workspace||state.workspaceWallet!==wallet){state.workspace=await sessionRead('analyst:workspace','my_workspace');state.workspaceWallet=wallet;}
      var form=document.getElementById('analyst-form');if(form)form.reset();prefillApplication();setApplicationStatus('');
      var modal=document.getElementById('apx-modal');state.returnFocus=document.activeElement;modal.classList.add('open');document.body.style.overflow='hidden';setTimeout(function(){var target=document.getElementById('an-handle');if(target)target.focus();},50);
    }catch(error){if(typeof showToast==='function')showToast(userError(error));}
  }
  function closeApplication(){var modal=document.getElementById('apx-modal');if(modal)modal.classList.remove('open');document.body.style.overflow='';if(state.returnFocus&&typeof state.returnFocus.focus==='function')state.returnFocus.focus();state.returnFocus=null;}
  function inputLines(id){var node=document.getElementById(id);return String(node&&node.value||'').split(/[\n,]+/).map(function(value){return value.trim();}).filter(Boolean);}
  async function avatarPayload(){
    var input=document.getElementById('an-avatar'),file=input&&input.files&&input.files[0];if(!file)return null;
    if(['image/png','image/jpeg'].indexOf(file.type)===-1)throw new Error('Profile image must be PNG or JPEG.');
    if(file.size>524288)throw new Error('Profile image must be 512 KB or smaller.');
    return {mime:file.type,data_base64:bytesToBase64(new Uint8Array(await file.arrayBuffer()))};
  }
  async function submitApplication(event){
    if(event)event.preventDefault();var form=document.getElementById('analyst-form');if(!form||!form.reportValidity()||state.busy)return;
    state.busy=true;var button=document.getElementById('an-submit');if(button)button.disabled=true;
    try{
      var wallet=await ensureWallet();var expertise=Array.prototype.map.call(document.querySelectorAll('input[name="an-expertise"]:checked'),function(box){return box.value;});if(!expertise.length)throw new Error('Choose at least one expertise category.');
      var linkLabel=String(document.getElementById('an-link-label').value||'').trim(),linkUrl=String(document.getElementById('an-link-url').value||'').trim();if((linkLabel&&!linkUrl)||(!linkLabel&&linkUrl))throw new Error('Provide both the public link label and HTTPS URL.');
      var proofUrls=inputLines('an-proof');if(proofUrls.length>5)throw new Error('Use at most five public proof links.');
      var application={handle:document.getElementById('an-handle').value,display_name:document.getElementById('an-name').value,bio:document.getElementById('an-bio').value,expertise:expertise,links:linkUrl?[{label:linkLabel,url:linkUrl}]:[],motivation:document.getElementById('an-motivation').value,experience:document.getElementById('an-experience').value,proof_urls:proofUrls};
      var image=await avatarPayload();if(image)application.avatar=image;
      setApplicationStatus('Preparing an exact single-use application message...');
      var prepared=await api({op:'prepare_application',wallet:wallet,application:application,idempotency_key:randomKey('application')});
      setApplicationStatus('Sign exact '+prepared.version_ref+'. This is not an on-chain transaction.');
      var signature=await signMessage(prepared.message);
      var committed=await api({op:'commit_application',wallet:wallet,application:application,nonce:prepared.nonce,message:prepared.message,signature:signature});
      setApplicationStatus('Version '+committed.application.version_no+' recorded as wallet-signed and server-verified.','success');
      state.workspace=null;state.workspaceWallet='';if(typeof showToast==='function')showToast('Immutable analyst application version submitted.');
      setTimeout(function(){closeApplication();openWorkspace('applications');},700);
    }catch(error){setApplicationStatus(userError(error),'error');}
    finally{state.busy=false;if(button)button.disabled=false;}
  }

  function queueReview(app,wallet){return (app.reviews||[]).find(function(review){return review.is_active===true&&review.decision==='approve'&&String(review.reviewer_wallet)===String(wallet);});}
  function queueCard(app){
    var profile=app.profile||{},version=app.version||{},details=version.details_restricted||{},waiting=app.status==='revision_requested',approved=queueReview(app,walletPubkey);
    var proofLinks=(details.proof_urls||[]).map(function(value){var url=safeHttps(value);return url?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+esc(url)+'</a>':'';}).join('');
    return '<article class="osi-ops-application" data-application-id="'+esc(app.id)+'"><header>'+avatar(profile,46)+'<div><span class="mono">'+esc(version.version_ref||short(version.id))+'</span><h4>'+esc(profile.display_name||profile.handle||short(app.applicant_wallet))+'</h4><p>'+esc(short(app.applicant_wallet))+' / version '+Number(version.version_no||0)+'</p></div>'+statusBadge(app.status)+'</header>'
      +'<div class="osi-ops-grid"><section><h5>Public profile</h5><p>'+esc(profile.bio||'No bio')+'</p><div class="osi-tag-list">'+(version.expertise_public||[]).map(function(item){return '<span>'+esc(label(item))+'</span>';}).join('')+'</div></section><section><h5>Restricted application evidence</h5><p><b>Motivation:</b> '+esc(details.motivation||'Not recorded')+'</p><p><b>Experience:</b> '+esc(details.experience||'Not recorded')+'</p><div class="osi-safe-links">'+proofLinks+'</div></section></div>'
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
  async function loadQueue(){
    var host=document.getElementById('osi-analyst-ops');if(!host)return;
    var access=typeof resolveMaintainerAccess==='function'?resolveMaintainerAccess():{allowed:false};if(!access.allowed){host.innerHTML=empty('Both maintainer gates are required','Connect the configured admin wallet and restore the authorized Supabase maintainer session.');return;}
    host.innerHTML='<div class="osi-activation-loading">Unlocking the double-gated Operations read session...</div>';
    try{var result=await sessionRead('analyst:maintainer','maintainer_queue');state.queue=Array.isArray(result.applications)?result.applications:[];renderQueue();}
    catch(error){state.queue=[];var refresh=/^read_session_(expired|wrong_scope)$/.test(String(error&&error.message||''));host.innerHTML=empty('Application queue unavailable',userError(error))+(refresh?'<button class="osi-primary-action" type="button" onclick="osiAnalystRefreshMaintainerQueue()">Refresh private access</button>':'');}
  }
  function queueStatus(appId,text,kind){var card=document.querySelector('[data-application-id="'+String(appId).replace(/[^A-Za-z0-9-]/g,'')+'"]'),node=card&&card.querySelector('[data-analyst-status]');if(node){node.textContent=text;node.className='osi-form-status mono '+(kind||'');}}
  function queueApplication(id){return state.queue.find(function(app){return String(app.id)===String(id);});}
  async function reviewApplication(id,decision){
    if(state.busy)return;var app=queueApplication(id),card=document.querySelector('[data-application-id="'+String(id).replace(/[^A-Za-z0-9-]/g,'')+'"]');if(!app||!app.version||!card)return;
    state.busy=true;card.querySelectorAll('button,select').forEach(function(node){node.disabled=true;});
    try{
      var wallet=await ensureWallet(),reason=card.querySelector('[data-analyst-reason]').value,review={application_version_id:app.version.id,version_ref:app.version.version_ref,decision:decision,reason_code:reason};
      queueStatus(id,'Preparing exact '+label(decision)+' review...');var prepared=await api({op:'prepare_review',wallet:wallet,review:review,idempotency_key:randomKey('application-review')});
      queueStatus(id,'Sign the exact review message. Review weight is 0.');var signature=await signMessage(prepared.message);
      var committed=await api({op:'commit_review',wallet:wallet,review:review,nonce:prepared.nonce,message:prepared.message,signature:signature});
      queueStatus(id,'Decision recorded as wallet-signed and server-verified.','success');
      if(committed.activation_ready&&confirm('Approval is recorded. Anchor the exact ANALYST_PROBATION Memo now? Only the standard Solana fee applies.'))await activateProbation(id);
      else await loadQueue();
    }catch(error){queueStatus(id,userError(error),'error');}
    finally{state.busy=false;if(card&&document.body.contains(card))card.querySelectorAll('button,select').forEach(function(node){node.disabled=false;});}
  }
  async function commitActivationWithConfirmation(body){var last;for(var attempt=0;attempt<5;attempt++){try{return await api(body);}catch(error){last=error;if(String(error.message)!=='transaction_not_confirmed')throw error;await new Promise(function(resolve){setTimeout(resolve,1600+attempt*900);});}}throw last;}
  async function activateProbation(id){
    if(state.busy&&!(document.querySelector('[data-application-id="'+String(id).replace(/[^A-Za-z0-9-]/g,'')+'"]')))return;
    var app=queueApplication(id);if(!app||!app.version)return;var previouslyBusy=state.busy;state.busy=true;
    try{
      var wallet=await ensureWallet(),activation={analyst_wallet:app.applicant_wallet,application_version_id:app.version.id,version_ref:app.version.version_ref};
      queueStatus(id,'Preparing exact ANALYST_PROBATION Memo...');var prepared=await api({op:'prepare_activation',wallet:wallet,activation:activation,idempotency_key:randomKey('analyst-probation')});
      queueStatus(id,'Approve the probation Memo. Tier probationary and weight 0.50 are server-derived.');var txSig=await castOnchainVote(prepared.memo);
      queueStatus(id,'Confirming exact signer, Memo, target, payload hash, and mainnet transaction...');var committed=await commitActivationWithConfirmation({op:'commit_activation',wallet:wallet,activation:activation,nonce:prepared.nonce,memo:prepared.memo,tx_sig:txSig});
      queueStatus(id,'Probation activated at server-derived weight '+Number(committed.analyst.weight).toFixed(2)+'.','success');if(typeof showToast==='function')showToast('Analyst probation is Memo-anchored on Solana.');await Promise.all([loadQueue(),loadPublicProfiles()]);
    }catch(error){queueStatus(id,userError(error),'error');}
    finally{state.busy=previouslyBusy;}
  }

  var legacyCloseProfile=window.closeAnalystProfile;
  window.closeAnalystProfile=function(){var modal=document.getElementById('ap-modal');if(modal){modal.classList.remove('open');modal.setAttribute('aria-hidden','true');}if(typeof legacyCloseProfile==='function'&&legacyCloseProfile!==window.closeAnalystProfile)legacyCloseProfile();};
  window.loadAnalysts=loadPublicProfiles;
  window.renderAnalysts=renderPublicProfiles;
  window.renderLeaderboard=renderPublicProfiles;
  window.openAnalystProfile=function(id){openPublicProfile(id);};
  window.openRosterProfile=function(id){openPublicProfile(id);};
  window.osiAnalystOpenWorkspace=openWorkspace;
  window.apxOpen=openApplication;
  window.apxClose=closeApplication;
  window.osiAnalystSubmit=submitApplication;
  window.osiAnalystLoadMaintainerQueue=loadQueue;
  window.osiAnalystRefreshWorkspace=function(tab){return window.osiV2RefreshReadSession(['analyst:workspace']).then(function(){return openWorkspace(tab);});};
  window.osiAnalystRefreshMaintainerQueue=function(){return window.osiV2RefreshReadSession(['analyst:maintainer']).then(loadQueue);};
  window.osiAnalystDecision=reviewApplication;
  window.osiAnalystActivate=activateProbation;

  function clearPrivateAnalystCache(){state.workspace=null;state.workspaceWallet='';state.queue=[];state.busy=false;}
  if(typeof window.osiV2RegisterPrivateCache==='function')window.osiV2RegisterPrivateCache('analyst',clearPrivateAnalystCache);

  document.addEventListener('keydown',function(event){if(event.key==='Escape'&&document.getElementById('apx-modal')&&document.getElementById('apx-modal').classList.contains('open'))closeApplication();});
})();
