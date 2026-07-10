

// ===== ANALYST ROSTER (founder-curated, level earned by verified work) =====
const ANALYST_TIERS = [
  { t:'I',   name:'Apprentice',      min:0,   cls:'pf-l1' },
  { t:'II',  name:'Investigator',    min:60,  cls:'pf-l2' },
  { t:'III', name:'Detective',       min:180, cls:'pf-l3' },
  { t:'IV',  name:'Chief Detective', min:400, cls:'pf-l4' }
];

// verified-analyst lookup (wallet -> {handle,name}); powers the ★ badge across the site
window.VERIFIED_ANALYSTS = window.VERIFIED_ANALYSTS || {};
async function loadAnalysts(){
  if(!SUPA_ON) return;
  try{
    const a = await supaGet('analysts?select=*&approved=eq.true&verified=eq.true') || [];
    const map={}, wmap={};
    a.forEach(function(x){ if(x.wallet){ map[String(x.wallet)] = { handle:x.handle, name:x.name, avatar_url:x.avatar_url||'' }; wmap[String(x.wallet)] = (x.tier_weight==null?1:Number(x.tier_weight)); } });
    window.VERIFIED_ANALYSTS = map; window.ANALYST_WEIGHT = wmap;
  }catch(e){ /* table may not exist yet */ }
}
function isVerifiedAnalyst(wallet){ return !!(wallet && window.VERIFIED_ANALYSTS && window.VERIFIED_ANALYSTS[String(wallet)]); }
function analystStats(wallet, reports, bounties){
  const w = String(wallet);
  const authored = reports.filter(function(r){ return String(r.wallet)===w; }).length;
  const won = bounties.filter(function(b){ return String(b.winner_wallet)===w; }).length;
  const xp = authored*15 + won*60;
  let idx=0; for(let i=0;i<ANALYST_TIERS.length;i++){ if(xp>=ANALYST_TIERS[i].min) idx=i; }
  return { authored:authored, won:won, xp:xp, tier:ANALYST_TIERS[idx] };
}
function analystCard(a){
  const handle = String(a.handle||'').replace(/^@/,'').replace(/[^A-Za-z0-9_]/g,'').slice(0,30);
  const name = escapeHtml(a.name || (handle ? '@'+handle : short(a.wallet)));
  const av = (typeof pfIdenticon==='function') ? pfIdenticon(String(a.wallet), 44) : '';
  const xrow = handle ? '<a class="ar-x" href="https://x.com/'+escapeHtml(handle)+'" target="_blank" rel="noopener">@'+escapeHtml(handle)+' \u2197</a>' : '<span class="ar-x mono" style="color:var(--ink-faint)">'+escapeHtml(short(a.wallet))+'</span>';
  const bio = a.bio ? '<div class="ar-bio">'+escapeHtml(String(a.bio).slice(0,160))+'</div>' : '';
  const t = a.tier;
  return '<div class="ar-card" role="button" tabindex="0" onclick="if(event.target.closest(&quot;a&quot;))return;openRosterProfile(\''+escapeHtml(String(a.wallet))+'\')" onkeydown="if(event.key===&quot;Enter&quot;)openRosterProfile(\''+escapeHtml(String(a.wallet))+'\')">'
    + '<div class="ar-top">'+av+'<div class="ar-id"><div class="ar-name">'+name+' <span class="ar-verif" title="Verified analyst">\u2605</span></div>'+xrow+'</div></div>'
    + bio
    + '<div class="ar-tier '+t.cls+'">TIER '+t.t+' \u00b7 '+escapeHtml(t.name)+'</div>'
    + '<div class="ar-stats">'
      + '<div><span class="n">'+a.xp+'</span><span class="l">XP</span></div>'
      + '<div><span class="n">'+a.authored+'</span><span class="l">intel</span></div>'
      + '<div><span class="n">'+a.won+'</span><span class="l">bounties won</span></div>'
    + '</div>'
  + '</div>';
}
async function renderAnalysts(){
  const host=document.getElementById('analyst-roster'); if(!host) return;
  if(!SUPA_ON){ host.innerHTML=''; return; }
  let analysts=[], reports=[], bounties=[];
  try{ analysts = await supaGet('analysts?select=*&approved=eq.true') || []; }catch(e){}
  try{ reports  = await supaGet('reports?select=wallet&approved=eq.true') || []; }catch(e){}
  try{ bounties = await supaGet('bounties?select=winner_wallet&winner_wallet=not.is.null') || []; }catch(e){}
  if(!analysts.length){ host.innerHTML=''; return; }
  const rows = analysts.map(function(a){ return Object.assign({}, a, analystStats(a.wallet, reports, bounties)); })
                       .sort(function(x,y){ return y.xp - x.xp; });
  host.innerHTML = '<div class="rec-sec-h">THE ROSTER \u00b7 VERIFIED ANALYSTS <span class="ar-count">'+rows.length+'</span></div><div class="ar-grid">' + rows.map(analystCard).join('') + '</div>';
}

// ===== Analyst Proof-of-Work Leaderboard (Round 1a) =====
// Reputation is earned from reviewed work only. Peer support (SOL) is voluntary and
// NEVER affects reputation or vote weight. Vote weight is capped. Identity signals are
// optional and do not by themselves confer trust. Demo data is only available when
// window.OSI_DEMO_MODE === true; live mode stays empty until real rows exist.
var LB_IS_DEMO = false;
var LEADERBOARD_SAMPLE = [
  { id:'a1', wallet:'7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', handle:'chainseer', name:'chainseer', tier:2, reviewed:34, reports:9, challenges:5, memo:71, weight:1.75, badges:['Verified','10+ reviews','First seal','Challenge accepted'], x:true, linkedin:true, joined:'Feb 2026', peer:2.4, risk:0 },
  { id:'a2', wallet:'4Nd1mYh8pQ2rStUvWxYz3aBcDeFgHjKmNpQrStUvWxY', handle:'memo_maria', name:'memo.maria', tier:2, reviewed:26, reports:5, challenges:4, memo:53, weight:1.5, badges:['Verified','Peer reviewer','Clean record'], x:false, linkedin:true, joined:'Feb 2026', peer:0.8, risk:0 },
  { id:'a3', wallet:'9zAbCdEfGhJkLmNpQrStUvWxYz2345678aBcDeFgHjK', handle:'solsleuth', name:'solsleuth', tier:2, reviewed:22, reports:6, challenges:3, memo:48, weight:1.5, badges:['Verified','6 approved reports'], x:true, linkedin:false, joined:'Mar 2026', peer:1.1, risk:0 },
  { id:'a4', wallet:'3RtY6uJ8kLmN2pQ4sV7wX9zAbCdEfGhJkLmNpQrStUv', handle:'rugtracer', name:'rugtracer', tier:1, reviewed:15, reports:4, challenges:2, memo:30, weight:1.25, badges:['Verified','Tracer'], x:true, linkedin:false, joined:'Mar 2026', peer:0.5, risk:0 },
  { id:'a5', wallet:'5FhGjKlMnBvCxZaSdFgHjKlPoIuYtReWqAsDfGhJkLm', handle:'', name:'', tier:1, reviewed:12, reports:3, challenges:1, memo:22, weight:1.25, badges:['Verified','Wallet-only'], x:false, linkedin:false, joined:'Apr 2026', peer:0, risk:0 },
  { id:'a6', wallet:'2WpQeRtYuIoPaSdFgHjKlZxCvBnMqWeRtYuIoPaSdFg', handle:'degen_dt', name:'degen.dt', tier:0, reviewed:6, reports:1, challenges:0, memo:9, weight:1.0, badges:['New analyst'], x:true, linkedin:false, joined:'Apr 2026', peer:0.2, risk:0 }
];
// transparent reputation: reviewed work + approved reports + successful challenges + signed actions
function lbRep(a){ return (a.reviewed||0)*4 + (a.reports||0)*10 + (a.challenges||0)*8 + (a.memo||0)*1; }
function lbTier(i){ return ANALYST_TIERS[Math.max(0, Math.min(ANALYST_TIERS.length-1, i||0))]; }
function lbList(){
  if(window.__realLb && window.__realLb.length){ window.__lbList = window.__realLb; return window.__realLb; }
  if(window.OSI_DEMO_MODE !== true){ LB_IS_DEMO=false; window.__lbList=[]; return []; }
  LB_IS_DEMO=true;
  var rows = LEADERBOARD_SAMPLE.map(function(a){ return Object.assign({}, a, { rep: lbRep(a) }); });
  rows.sort(function(x,y){ return y.rep - x.rep; });
  window.__lbList = rows;
  return rows;
}
// ===== identity: serious geometric avatar (deterministic gradient monogram; custom upload wins) =====
var OSI_AV_PAL=[['#22d3ee','#0e7490'],['#a78bfa','#5b21b6'],['#14f195','#047857'],['#fb923c','#9a3412'],['#38bdf8','#1e40af'],['#e879f9','#86198f']];
function osiAvatarUrl(wallet, a){
  try{ var loc=localStorage.getItem('stw_avatar_'+String(wallet||'')); if(loc) return loc; }catch(e){}
  if(a && a.avatar_url) return String(a.avatar_url);
  var m=(window.VERIFIED_ANALYSTS||{})[String(wallet||'')];
  return (m && m.avatar_url) ? String(m.avatar_url) : '';
}
function osiAvatarSvg(seed, size, name, url){
  size=size||40;
  if(url){ return '<img class="osi-av" src="'+escapeHtml(String(url))+'" alt="" width="'+size+'" height="'+size+'" style="width:'+size+'px;height:'+size+'px" loading="lazy">'; }
  var h=pfHash(String(seed||'osi'));
  var p=OSI_AV_PAL[h % OSI_AV_PAL.length];
  var rot=(h>>3)%360;
  var ch=(String(name||'').trim().charAt(0) || String(seed||'?').charAt(0) || '?').toUpperCase();
  var fs=Math.round(size*0.42), r=Math.round(size*0.3);
  return '<svg class="osi-av" width="'+size+'" height="'+size+'" viewBox="0 0 '+size+' '+size+'" role="img" aria-hidden="true">'
    +'<defs><linearGradient id="g'+h+'" gradientTransform="rotate('+rot+' .5 .5)"><stop offset="0" stop-color="'+p[0]+'"/><stop offset="1" stop-color="'+p[1]+'"/></linearGradient></defs>'
    +'<rect x="1" y="1" width="'+(size-2)+'" height="'+(size-2)+'" rx="'+r+'" fill="url(#g'+h+')" opacity=".92"/>'
    +'<rect x="1" y="1" width="'+(size-2)+'" height="'+(size-2)+'" rx="'+r+'" fill="none" stroke="rgba(255,255,255,.14)"/>'
    +'<text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="Archivo,sans-serif" font-weight="800" font-size="'+fs+'" fill="rgba(6,10,18,.9)">'+escapeHtml(ch)+'</text>'
  +'</svg>';
}
var LB_REP_TIP='REP = reviewed cases \u00d74 + approved reports \u00d710 + successful challenges \u00d78 + signed actions \u00d71. Peer support never affects REP.';
function lbStatus(a){ var v=(a.verified!==undefined)? !!a.verified : !!(a.handle||a.name); return v?'<span class="lp-st v">Verified</span>':'<span class="lp-st w">Wallet-only</span>'; }
function lbTierLine(a){ var t=lbTier(a.tier); return '<span class="lp-tier '+t.cls+'">Tier '+t.t+' \u00b7 '+escapeHtml(t.name)+'</span>'; }
function lbName(a){ return a.name ? escapeHtml(a.name) : escapeHtml(short(a.wallet)); }
function lbHandle(a){ return a.handle ? ('@'+escapeHtml(a.handle)) : escapeHtml(short(a.wallet)); }
function lbAct(a){
  var parts=[];
  if(a.reviewed) parts.push('<b>'+a.reviewed+'</b> reviewed');
  if(a.reports)  parts.push('<b>'+a.reports+'</b> reports');
  if(a.challenges) parts.push('<b>'+a.challenges+'</b> challenges');
  if(a.memo) parts.push('<b>'+a.memo+'</b> signed');
  if(a.won) parts.push('<b>'+a.won+'</b> wins');
  return parts.length ? parts.join('<span class="sep">\u00b7</span>') : '<span class="mut">new on the roster</span>';
}
function lbPodiumCard(a, rank){
  var av=osiAvatarSvg(a.wallet, 56, a.name||a.handle, osiAvatarUrl(a.wallet, a));
  return '<div class="lp-pod'+(rank===1?' first':'')+'" role="button" tabindex="0" onclick="openAnalystProfile(\''+a.id+'\')" onkeydown="if(event.key===\'Enter\'){openAnalystProfile(\''+a.id+'\');}">'
    +'<span class="lp-rank r'+rank+'">'+rank+'</span>'
    +'<div class="lp-pod-av">'+av+'</div>'
    +'<div class="lp-pod-nm">'+lbName(a)+'</div>'
    +'<div class="lp-pod-h mono">'+lbHandle(a)+'</div>'
    +'<div class="lp-pod-chips">'+lbStatus(a)+lbTierLine(a)+'</div>'
    +'<div class="lp-pod-rep" title="'+LB_REP_TIP+'"><span class="n">'+a.rep+'</span><span class="l">REP</span></div>'
    +'<div class="lp-pod-ft mono"><span>\u00d7'+a.weight+'</span><span class="l">weight</span></div>'
  +'</div>';
}
function lbTableRow(a, rank){
  var av=osiAvatarSvg(a.wallet, 34, a.name||a.handle, osiAvatarUrl(a.wallet, a));
  return '<div class="lp-row" role="button" tabindex="0" onclick="openAnalystProfile(\''+a.id+'\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();openAnalystProfile(\''+a.id+'\');}">'
    +'<span class="lp-n mono">'+rank+'</span>'
    +'<div class="lp-who">'+av+'<div class="lp-who-t"><b>'+lbName(a)+'</b><span class="mono">'+lbHandle(a)+'</span></div></div>'
    +'<span class="lp-cell st">'+lbStatus(a)+lbTierLine(a)+'</span>'
    +'<span class="lp-cell act">'+lbAct(a)+'</span>'
    +'<span class="lp-cell rep mono r" title="'+LB_REP_TIP+'">'+a.rep+' <i>REP</i></span>'
    +'<span class="lp-cell wt mono r">\u00d7'+a.weight+'</span>'
  +'</div>';
}
var lbPageN=1, LB_PER=8;
function lbPage(p){ lbPageN=p|0; renderLeaderboard(); var b=document.getElementById('lb-board'); if(b){ try{ b.scrollIntoView({behavior:'smooth',block:'start'}); }catch(e){} } }
function renderLeaderboard(){
  var pod=document.getElementById('lb-podium');
  var host=document.getElementById('lb-body');
  if(!host && !pod) return;
  var rows=lbList();
  if(!rows.length){
    if(pod){ pod.innerHTML='<div class="lb-empty-state"><b>No verified analysts ranked yet.</b><span>Verified analysts will appear here after signed contribution data is available.</span></div>'; }
    if(host){ host.innerHTML='<div class="fd-empty mono" style="padding:18px 14px">No analyst ranking rows available yet.</div>'; }
    var ec=document.getElementById('lb-count'); if(ec){ ec.textContent=''; }
    var ep=document.getElementById('lb-pnav'); if(ep){ ep.innerHTML=''; }
    return;
  }
  if(pod){
    var demo = LB_IS_DEMO ? '<div class="lb-demo">Demo roster shown \u00b7 verified analysts appear here after signed contributions.</div>' : '';
    var top=rows.slice(0,3);
    var order=[]; if(top[1]) order.push([top[1],2]); if(top[0]) order.push([top[0],1]); if(top[2]) order.push([top[2],3]);
    pod.innerHTML = demo + '<div class="lp-podium-row">' + order.map(function(x){ return lbPodiumCard(x[0],x[1]); }).join('') + '</div>';
  }
  if(host){
    var rest=rows.slice(3);
    var totalPages=Math.max(1, Math.ceil(rest.length/LB_PER));
    if(lbPageN>totalPages) lbPageN=totalPages; if(lbPageN<1) lbPageN=1;
    var from=(lbPageN-1)*LB_PER, page=rest.slice(from, from+LB_PER);
    host.innerHTML = page.length ? page.map(function(a,i){ return lbTableRow(a, from+i+4); }).join('')
                                 : '<div class="fd-empty mono" style="padding:18px 14px">The podium holds the whole roster right now.</div>';
    var c=document.getElementById('lb-count');
    if(c){ c.textContent = rows.length ? ('Showing '+rows.length+' analyst'+(rows.length===1?'':'s')+' \u00b7 ranked by signed proof-of-work') : ''; }
    var pn=document.getElementById('lb-pnav');
    if(pn){
      if(totalPages<=1){ pn.innerHTML=''; }
      else{
        var ph='<button class="fo-pg" type="button" '+(lbPageN<=1?'disabled':'')+' onclick="lbPage('+(lbPageN-1)+')" aria-label="Previous">\u2039</button>';
        for(var pi=1; pi<=totalPages; pi++){ ph+='<button class="fo-pg n'+(pi===lbPageN?' active':'')+'" type="button" onclick="lbPage('+pi+')">'+pi+'</button>'; }
        ph+='<button class="fo-pg" type="button" '+(lbPageN>=totalPages?'disabled':'')+' onclick="lbPage('+(lbPageN+1)+')" aria-label="Next">\u203a</button>';
        pn.innerHTML=ph;
      }
    }
  }
}
// ===== real roster: verified analysts replace the demo board as they sign work =====
async function lbHydrateReal(){
  if(!SUPA_ON) return;
  try{
    var analysts=await supaGet('analysts?select=*&approved=eq.true')||[];
    if(!analysts.length) return;
    var reports=[], bounties=[];
    try{ reports=await supaGet('reports?select=wallet&approved=eq.true')||[]; }catch(e){}
    try{ bounties=await supaGet('bounties?select=winner_wallet&winner_wallet=not.is.null')||[]; }catch(e){}
    var rows=analysts.map(function(a){
      var st=analystStats(a.wallet, reports, bounties);
      var rep=st.xp|0, ti=0;
      for(var i=0;i<ANALYST_TIERS.length;i++){ if(rep>=ANALYST_TIERS[i].min) ti=i; }
      return { id:'w:'+a.wallet, wallet:String(a.wallet), handle:a.handle||'', name:a.name||a.handle||'',
        verified:(a.verified!==false), avatar_url:a.avatar_url||'', tier:ti,
        reviewed:0, reports:st.authored|0, challenges:0, memo:0, won:st.won|0,
        weight:(a.tier_weight!=null? Number(a.tier_weight): (1+ti*0.25)), rep:rep,
        badges:['Verified'], x:false, linkedin:false, joined:'', peer:0, risk:0 };
    }).sort(function(x,y){ return y.rep-x.rep; });
    window.__realLb=rows; LB_IS_DEMO=false; lbPageN=1;
    renderLeaderboard();
  }catch(e){}
}
async function lbActions(){
  var host=document.getElementById('lb-actions'); if(!host) return;
  if(!SUPA_ON){ host.innerHTML='<div class="fd-empty mono">No recent analyst actions yet.</div>'; return; }
  try{
    var evs=await supaGet('onchain_events?select=event_type,tx_sig,created_at,actor_wallet&order=created_at.desc&limit=4');
    if(!evs||!evs.length){ host.innerHTML='<div class="fd-empty mono">No recent analyst actions yet.</div>'; return; }
    host.innerHTML=evs.map(function(ev){
      var sig=String(ev.tx_sig||'');
      var right=sig?('<a class="fd-ago mono" href="https://solscan.io/tx/'+encodeURIComponent(sig)+'" target="_blank" rel="noopener">'+escapeHtml(sig.slice(0,4)+'\u2026'+sig.slice(-4))+' \u2197</a>'):('<span class="fd-ago mono">'+fdAgo(ev.created_at)+'</span>');
      return '<div class="fd-it"><span class="fd-ic vio">\u25ce</span><div class="fd-tx"><b>'+escapeHtml(String(ev.event_type||'SIGNED_ACTION'))+'</b><span>'+escapeHtml(raShortW(ev.actor_wallet))+' \u00b7 '+fdAgo(ev.created_at)+'</span></div>'+right+'</div>';
    }).join('');
  }catch(e){ host.innerHTML='<div class="fd-empty mono">Proof log unavailable right now.</div>'; }
}
// ===== apply-for-credentials modal =====
function apxOpen(){ var m=document.getElementById('apx-modal'); if(!m) return; m.classList.add('open'); document.body.style.overflow='hidden'; var t=document.getElementById('an-tg'); if(t) setTimeout(function(){ try{t.focus();}catch(e){} },60); }
function apxClose(){ var m=document.getElementById('apx-modal'); if(m) m.classList.remove('open'); document.body.style.overflow=''; }
// ===== profile avatar upload (saved to storage when connected; always remembered on this device) =====
function pfAvatarPick(){ var i=document.getElementById('pf-ava-file'); if(i) i.click(); }
async function pfAvatarChange(inp){
  var f=inp && inp.files && inp.files[0]; if(!f) return;
  if(!/^image\//.test(f.type||'')){ showToast('Please choose an image file.'); return; }
  if(f.size>2*1024*1024){ showToast('Image too large. Keep it under 2 MB.'); return; }
  if(!walletPubkey){ showToast('Connect your wallet first.'); return; }
  var url='';
  try{ url=await supaUpload(f); }catch(e){ url=''; }
  if(!url){
    try{ url=await new Promise(function(res,rej){ var r=new FileReader(); r.onload=function(){res(String(r.result));}; r.onerror=rej; r.readAsDataURL(f); }); }catch(e){ showToast('Could not read the image.'); return; }
    if(url.length>300000){ showToast('Upload unavailable offline; image too large to store locally.'); return; }
  }
  try{ localStorage.setItem('stw_avatar_'+walletPubkey, url); }catch(e){}
  if(SUPA_ON && /^https?:/.test(url)){
    try{ await fetch(SUPABASE_URL+'/rest/v1/analysts?wallet=eq.'+encodeURIComponent(walletPubkey), { method:'PATCH', headers:{ 'apikey':SUPABASE_ANON_KEY, 'Authorization':'Bearer '+(SUPA_AUTH_TOKEN||SUPABASE_ANON_KEY), 'Content-Type':'application/json', 'Prefer':'return=minimal' }, body:JSON.stringify({avatar_url:url}) }); }catch(e){}
  }
  showToast('Avatar updated.');
  try{ renderLeaderboard(); }catch(e){}
  try{ if(typeof CV_CTX==='object' && CV_CTX) openProfileCV(CV_CTX); }catch(e){}
}

// ===== OSI Profile CV: one premium identity surface, three roles (user / analyst / maintainer) =====
// Reputation reflects reviewed work only. Peer support and identity signals never affect vote weight.
var CV_CTX = null;
function cvSolscanAcct(w){ return 'https://solscan.io/account/'+encodeURIComponent(String(w)); }
function cvCopy(txt, btn){
  function done(){ if(btn){ var o=btn.textContent; btn.textContent='\u2713'; setTimeout(function(){ btn.textContent=o==='\u2713'?'\u29c9':o; }, 900); } }
  try{ navigator.clipboard.writeText(String(txt)).then(done, function(){ if(typeof showToast==='function') showToast('Copy failed.'); }); }
  catch(e){ if(typeof showToast==='function') showToast('Copy not available in this browser.'); }
}
function cvTab(btn, id){
  document.querySelectorAll('#ap-modal .cv-tab').forEach(function(b){ b.classList.toggle('active', b===btn); });
  document.querySelectorAll('#ap-modal .cv-pane').forEach(function(p){ p.classList.toggle('active', p.id===id); });
}
function cvTierByXp(xp){ var idx=0; for(var i=0;i<ANALYST_TIERS.length;i++){ if(xp>=ANALYST_TIERS[i].min) idx=i; } return ANALYST_TIERS[idx]; }

// ---- entry points ----
function openAnalystProfile(id){ // leaderboard rows (sample roster)
  var list = window.__lbList || lbList();
  var a=null; for(var i=0;i<list.length;i++){ if(String(list[i].id)===String(id)){ a=list[i]; break; } }
  if(!a) return;
  openProfileCV({ role:'analyst', src:'sample', data:a });
}
function openRosterProfile(wallet){ openProfileCV({ role:'analyst', src:'live', wallet:String(wallet) }); }
function openSelfProfile(){
  if(!walletPubkey){ if(typeof showToast==='function') showToast('Connect your wallet first (top right).'); return; }
  var maint = (typeof resolveMaintainerAccess === 'function') ? resolveMaintainerAccess().allowed : false;
  var role = maint ? 'maintainer' : (isVerifiedAnalyst(walletPubkey) ? 'analyst' : 'user');
  openProfileCV({ role:role, src:'live', wallet:walletPubkey, self:true });
  if(typeof closeWalletMenu==='function') closeWalletMenu();
}
function openProfileCV(ctx){
  CV_CTX = ctx;
  var body=document.getElementById('ap-modal-body'), m=document.getElementById('ap-modal');
  if(!body || !m) return;
  m.classList.add('open'); m.setAttribute('aria-hidden','false'); document.body.classList.add('cr-drawer-lock');
  if(ctx.src==='sample'){ body.innerHTML = cvHtml(cvFromSample(ctx.data), ctx); return; }
  body.innerHTML = '<div class="cv-loading mono">Building profile from live data\u2026</div>';
  cvLoadLive(ctx).then(function(model){ if(CV_CTX===ctx){ body.innerHTML = cvHtml(model, ctx); } });
}
function closeAnalystProfile(){ var m=document.getElementById('ap-modal'); if(m){ m.classList.remove('open'); m.setAttribute('aria-hidden','true'); } document.body.classList.remove('cr-drawer-lock'); CV_CTX=null; }

// ---- models ----
function cvFromSample(a){
  var t = lbTier(a.tier);
  return {
    demo:true, wallet:a.wallet, name:(a.name||''), handle:(a.handle||''),
    tier:t, weight:(a.weight||1), rep:(a.rep!=null?a.rep:lbRep(a)),
    joined:(a.joined||'-'), risk:!!a.risk, x:!!a.x, linkedin:!!a.linkedin,
    stats:{ reviewed:a.reviewed||0, reports:a.reports||0, challenges:a.challenges||0, signed:a.memo||0, vouchesGiven:null, backs:null },
    badges:(a.badges||[]).slice(), peer:(a.peer||0),
    records:[{id:null,label:'OSI-4433'},{id:null,label:'OSI-2185'},{id:null,label:'OSI-7706'}].slice(0, Math.max(1, Math.min(3, a.reports||1))),
    activity:[
      { t:'2h ago',  label:'Signed a review memo on a pending finding' },
      { t:'1d ago',  label:'Report approved and added to the public record' },
      { t:'3d ago',  label:'Challenge filed on a weak attribution, accepted' }
    ],
    firstSeen:(a.joined||'-'), signedTotal:(a.memo||0)
  };
}
async function cvLoadLive(ctx){
  var W = String(ctx.wallet||'');
  var entry = (window.VERIFIED_ANALYSTS||{})[W] || null;
  var m = { demo:false, wallet:W, name:(entry&&(entry.name||''))||'', handle:(entry&&(entry.handle||''))||'',
            x:false, linkedin:false, risk:false, joined:'-', peer:null,
    stats:{ reviewed:null, reports:null, challenges:null, signed:null, vouchesGiven:null, backs:null },
    badges:[], records:[], events:[], pending:!SUPA_ON };
  var weight = (typeof analystWeight==='function' ? analystWeight(W) : 0) || 1;
  m.weight = Math.min(2, weight);
  if(entry && entry.created_at){ try{ m.joined = new Date(entry.created_at).toLocaleDateString(); }catch(e){} }
  var authored=0, won=0;
  if(SUPA_ON){
    async function got(q){ try{ return await supaGet(q) || []; }catch(e){ return null; } }
    var reps = await got('reports?select=id&wallet=eq.'+encodeURIComponent(W)+'&approved=eq.true&limit=100');
    var wins = await got('bounties?select=id&winner_wallet=eq.'+encodeURIComponent(W)+'&limit=100');
    var evs  = await got('onchain_events?select=event_type,item_type,item_id,vote,label,tx_sig,created_at,actor_wallet&actor_wallet=eq.'+encodeURIComponent(W)+'&order=created_at.desc&limit=25');
    if(reps!==null){ authored=reps.length; m.stats.reports=authored; }
    if(wins!==null){ won=wins.length; }
    if(evs!==null){
      m.events = evs;
      m.stats.signed = evs.length;
      m.stats.vouchesGiven = evs.filter(function(e){ return e.event_type==='analyst_vouch'; }).length;
      m.stats.backs = evs.filter(function(e){ return e.event_type==='demand_signal'; }).length;
      m.stats.reviewed = m.stats.vouchesGiven;
      if(evs.length){ try{ m.firstSeen = new Date(evs[evs.length-1].created_at).toLocaleDateString(); }catch(e){} }
      if(ctx.role==='maintainer'){ m.sealsDone = evs.filter(function(e){ return e.event_type==='maintainer_seal'; }).length; }
    }
    if(ctx.role==='maintainer'){
      var pk = await got('escalation_packs?select=id&status=eq.approved&limit=200');
      m.packsApproved = (pk===null? null : pk.length);
    }
  }
  var xp = authored*15 + won*60;
  m.tier = entry ? cvTierByXp(xp) : (ctx.role==='maintainer' ? {name:'Maintainer',cls:'pf-l4',t:'M'} : {name:'Contributor',cls:'pf-l1',t:'-'});
  m.rep = (m.stats.reports!=null || m.stats.reviewed!=null || m.stats.signed!=null)
        ? ((m.stats.reports||0)*10 + (m.stats.reviewed||0)*4 + (m.stats.signed||0)) : null;
  // self-only local signals
  if(ctx.self){
    try{ m.selfBacked = Object.keys(lsGet('stw_boosted',{})||{}).length; }catch(e){ m.selfBacked = null; }
    try{ m.selfApplied = Object.keys(lsGet('stw_applied',{})||{}).length; }catch(e){ m.selfApplied = null; }
  }
  // public records authored (link into the archive when loaded)
  try{
    var cr = window.__crList || [];
    m.records = cr.filter(function(r){ return r && String(r.wallet||'')===W; }).slice(0,5)
      .map(function(r){ return { id:r.id, label:(typeof osiCaseId==='function'? osiCaseId(r.id) : String(r.id).slice(0,8)) }; });
  }catch(e){}
  // honest badges from live signals
  if(entry) m.badges.push('Verified analyst');
  if((m.stats.signed||0)>0) m.badges.push('Memo signer');
  if((m.stats.reports||0)>0) m.badges.push('Public record contributor');
  if((m.stats.reviewed||0)>0) m.badges.push('Case reviewer');
  if(ctx.role==='maintainer') m.badges.push('Maintainer');
  if(!m.badges.length) m.badges.push('New wallet');
  return m;
}

// ---- render ----
function cvNum(v){ return (v===null||v===undefined) ? '<span class="cv-pend" title="No live data yet">\u2013</span>' : String(v); }
function cvRecordBtn(r){
  if(!r.id) return '<span class="ap-case mono">'+escapeHtml(r.label)+'</span>';
  var id=String(r.id).replace(/[^A-Za-z0-9_-]/g,'');
  return '<button class="ap-case mono cv-reclink" type="button" onclick="(window.__crRecords&&window.__crRecords[\''+id+'\'])?openCaseRecord(\''+id+'\'):showView(\'records\')">'+escapeHtml(r.label)+' \u2197</button>';
}
function cvHtml(m, ctx){
  var role = ctx.role||'analyst';
  var nm = m.name ? escapeHtml(m.name) : (m.handle? '@'+escapeHtml(m.handle) : escapeHtml(short(m.wallet)));
  var av = (typeof pfIdenticon==='function') ? pfIdenticon(String(m.wallet), 64) : '';
  var roleLabel = role==='maintainer' ? 'MAINTAINER' : (role==='analyst' ? 'VERIFIED ANALYST' : 'CONTRIBUTOR');
  var roleCls   = role==='maintainer' ? 'maint' : (role==='analyst' ? 'an' : 'usr');
  var idsig = (m.x?'<span class="lb-id x">\uD835\uDD4F verified</span>':'') + (m.linkedin?'<span class="lb-id li">in verified</span>':'');
  if(!idsig) idsig='<span class="lb-id wo">wallet-only</span>';
  var handleLine = m.handle ? '<span class="cv-handle">@'+escapeHtml(m.handle)+'</span>' : '';
  var wshort = escapeHtml(short(m.wallet));
  var demoChip = m.demo ? '<span class="cv-demochip">SAMPLE</span>' : '';

  // ----- tabs -----
  var tabs = '<div class="cv-tabs" role="tablist">'
    + '<button class="cv-tab active" type="button" onclick="cvTab(this,\'cv-ov\')">Overview</button>'
    + '<button class="cv-tab" type="button" onclick="cvTab(this,\'cv-rc\')">Public records</button>'
    + '<button class="cv-tab" type="button" onclick="cvTab(this,\'cv-ac\')">Activity</button>'
    + (role==='maintainer' ? '<button class="cv-tab" type="button" onclick="cvTab(this,\'cv-mt\')">Maintainer</button>' : '')
    + '</div>';

  // ----- Overview pane: proof-of-work grid + badges -----
  var s=m.stats||{};
  var pow = '<div class="cv-kpis">'
    + '<div class="cv-kpi"><span class="n">'+cvNum(s.reviewed)+'</span><span class="l">Reviewed contributions</span></div>'
    + '<div class="cv-kpi"><span class="n">'+cvNum(s.reports)+'</span><span class="l">Approved reports</span></div>'
    + '<div class="cv-kpi"><span class="n">'+cvNum(s.challenges)+'</span><span class="l">Successful challenges</span></div>'
    + '<div class="cv-kpi"><span class="n">'+cvNum(s.signed)+'</span><span class="l">Memo-signed actions</span></div>'
    + (s.vouchesGiven!=null ? '<div class="cv-kpi"><span class="n">'+s.vouchesGiven+'</span><span class="l">Reviews signed</span></div>' : '')
    + (s.backs!=null ? '<div class="cv-kpi"><span class="n">'+s.backs+'</span><span class="l">Cases backed</span></div>' : '')
    + (ctx.self && m.selfApplied!=null ? '<div class="cv-kpi"><span class="n">'+m.selfApplied+'</span><span class="l">Reports submitted (this device)</span></div>' : '')
    + (ctx.self && m.selfBacked!=null ? '<div class="cv-kpi"><span class="n">'+m.selfBacked+'</span><span class="l">Cases supported (this device)</span></div>' : '')
    + '</div>';
  var badges = (m.badges&&m.badges.length) ? '<div class="ap-sec-l">Badges</div><div class="ap-badges">'+m.badges.map(function(b){return '<span class="ap-badge">'+escapeHtml(b)+'</span>';}).join('')+'</div>' : '';
  var usrCta = (role==='user')
    ? '<div class="cv-note">Anyone can contribute: open a case, file a report, support a finding. Build a signed track record, then <a class="cv-a" onclick="closeAnalystProfile();goCommunity(\'tab-analysts\')">apply to the verified roster \u2192</a></div>' : '';
  var ov = '<div class="cv-pane active" id="cv-ov"><div class="ap-sec-l">Proof of work</div>'+pow+badges+usrCta+'</div>';

  // ----- Records pane -----
  var recs = (m.records&&m.records.length)
    ? '<div class="ap-cases">'+m.records.map(cvRecordBtn).join('')+(m.demo?' <span class="ap-case-note">sample</span>':'')+'</div>'
    : '<div class="cv-empty mono">No public case records linked to this wallet yet.</div>';
  var rc = '<div class="cv-pane" id="cv-rc"><div class="ap-sec-l">Public case records</div>'+recs
    + '<div class="cv-note">Only reviewed cases appear in the public archive. <a class="cv-a" onclick="closeAnalystProfile();showView(\'records\')">Open the archive \u2192</a></div></div>';

  // ----- Activity pane -----
  var act;
  if(m.demo){
    act = '<div class="cv-demo-note mono">Sample data for demo only. Not real analyst activity \u00b7 no live transactions.</div>'
      + '<div class="cv-sactl">'+m.activity.map(function(x){ return '<div class="cv-sact"><span class="t mono">'+escapeHtml(x.t)+'</span><span>'+escapeHtml(x.label)+'</span></div>'; }).join('')+'</div>';
  } else if(m.events && m.events.length){
    act = '<div class="ra-feed cv-feed">'+m.events.map(raSignedItem).join('')+'</div>';
  } else {
    act = '<div class="cv-empty mono">No signed on-chain actions from this wallet yet.</div>';
  }
  var ac = '<div class="cv-pane" id="cv-ac"><div class="ap-sec-l">Recent signed actions</div>'+act+'</div>';

  // ----- Maintainer pane -----
  var mt='';
  if(role==='maintainer'){
    mt = '<div class="cv-pane" id="cv-mt"><div class="ap-sec-l">Operational record</div>'
      + '<div class="cv-kpis">'
      + '<div class="cv-kpi"><span class="n">'+cvNum(m.sealsDone)+'</span><span class="l">Records reviewed on-chain</span></div>'
      + '<div class="cv-kpi"><span class="n">'+cvNum(m.packsApproved)+'</span><span class="l">AI packs approved</span></div>'
      + '</div>'
      + '<div class="cv-mtacts">'
      + '<button class="cf-btn primary" type="button" onclick="closeAnalystProfile();admOpen()">Open Command Center</button>'
      + '<button class="cf-btn ghost" type="button" onclick="closeAnalystProfile();goCommunity(\'tab-analysts\')">Open review queue</button>'
      + '</div>'
      + '<div class="cv-note">Maintainer actions are signed and final-review only. AI drafts are never public until a human approves them.</div></div>';
  }

  // ----- right rail -----
  var rep = '<div class="cv-card"><div class="cv-card-h">REPUTATION &amp; STATUS</div>'
    + '<div class="cv-repline"><span class="cv-rep">'+(m.rep!=null?m.rep:'\u2013')+'</span><span class="cv-replbl">reputation'+(m.demo?'':' \u00b7 provisional')+'</span></div>'
    + '<div class="cv-kv"><span>Vote weight</span><b>\u00d7'+(m.weight||1)+' <i>capped</i></b></div>'
    + '<div class="cv-kv"><span>Tier</span><b>'+escapeHtml(m.tier.name)+'</b></div>'
    + '<div class="cv-kv"><span>Joined</span><b>'+escapeHtml(m.joined||'-')+'</b></div>'
    + '<div class="cv-kv"><span>Risk flags</span><b class="'+(m.risk?'cv-bad':'cv-ok')+'">'+(m.risk?'\u26a0 flagged':'none recorded')+'</b></div>'
    + '<div class="cv-fine">Reputation reflects reviewed work only. Peer support and identity signals do not affect vote weight.</div></div>';
  var peer = '<div class="cv-card"><div class="cv-card-h">PEER SUPPORT <span class="cv-hnote">not reputation</span></div>'
    + (m.demo
        ? '<div class="cv-peer">\u25ce '+(m.peer||0)+' SOL received <span class="cv-fine2">sample</span></div>'
        : '<div class="cv-peer cv-dim">No peer support recorded on-chain yet.</div>')
    + '<div class="cv-fine">Voluntary and peer to peer. It never affects reputation, vote weight, review authority, or ranking.</div></div>';
  var chain = '<div class="cv-card"><div class="cv-card-h">ON-CHAIN IDENTITY</div>'
    + '<div class="cv-kv"><span>Wallet</span><b class="mono">'+wshort+'</b></div>'
    + '<div class="cv-kv"><span>First seen</span><b>'+escapeHtml(m.firstSeen||m.joined||'-')+'</b></div>'
    + '<div class="cv-kv"><span>Signed actions</span><b>'+cvNum(m.signedTotal!=null?m.signedTotal:(s.signed))+'</b></div>'
    + '<div class="cv-kv"><span>Memo signer</span><b>'+(((m.signedTotal||s.signed||0)>0)?'yes':'\u2013')+'</b></div>'
    + '<a class="cv-scan" href="'+cvSolscanAcct(m.wallet)+'" target="_blank" rel="noopener">View on Solscan \u2197</a></div>';

  // ----- header -----
  var head = '<div class="cv-head">'
    + '<div class="cv-av">'+av+'</div>'
    + '<div class="cv-idbox">'
      + '<div class="cv-name">'+nm+' '+handleLine+' '+demoChip+'</div>'
      + '<div class="cv-pills"><span class="cv-role '+roleCls+'">'+roleLabel+'</span><span class="lb-tier '+m.tier.cls+'">'+escapeHtml(m.tier.name)+'</span>'+idsig+'</div>'
      + '<div class="cv-wline mono">'+wshort+' <button class="cv-copy" type="button" title="Copy wallet" onclick="cvCopy(\''+escapeHtml(String(m.wallet))+'\',this)">\u29c9</button> <a class="cv-wsol" href="'+cvSolscanAcct(m.wallet)+'" target="_blank" rel="noopener">Solana \u2197</a></div>'
    + '</div></div>';

  var foot = m.demo ? '<div class="ap-demo">Sample data for demo only \u00b7 not real analyst activity</div>' : '';
  return '<div class="cv-wrap">'
    + '<div class="cv-main">'+head+tabs+ov+rc+ac+mt+'</div>'
    + '<div class="cv-rail">'+rep+peer+chain+'</div>'
    + '</div>'+foot;
}
// ----- maintainer: roster management -----
async function supaUpsertAnalyst(row){
  const r = await fetch(SUPABASE_URL + '/rest/v1/analysts', {
    method:'POST',
    headers: supaHeaders({ Prefer:'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(row)
  });
  if(!r.ok && r.status!==409) throw new Error('analyst upsert ' + r.status);
  return true;
}
async function admAddAnalyst(){
  if(!requireMaintainerAccess('Add analyst')) return;
  const wallet=(document.getElementById('admAnWallet').value||'').trim();
  const handle=(document.getElementById('admAnHandle').value||'').trim().replace(/^@/,'');
  const name=(document.getElementById('admAnName').value||'').trim();
  const bio=(document.getElementById('admAnBio').value||'').trim();
  const msg=document.getElementById('admAnMsg');
  if(!isSolAddr(wallet)){ if(msg){ msg.style.color='var(--red)'; msg.textContent='Enter a valid Solana wallet address.'; } return; }
  osiSignEvent({ eventType:'ANALYST_VERIFIED', actionLabel:'Add analyst', itemType:'analyst', itemId: wallet, publicLabel:'Analyst verified', onSuccess: async (sig)=>{
  if(msg){ msg.style.color='var(--ink-dim)'; msg.textContent='Adding\u2026'; }
  try{
    await supaUpsertAnalyst({ wallet:wallet, handle:handle||null, name:name||null, bio:bio||null, verified:true, approved:true });
    if(msg){ msg.style.color='var(--sol)'; msg.textContent='\u2713 Analyst added to the roster.'; }
    ['admAnWallet','admAnHandle','admAnName','admAnBio'].forEach(function(id){ const e=document.getElementById(id); if(e) e.value=''; });
    admRefresh(); loadAnalysts(); renderAnalysts();
  }catch(e){ if(msg){ msg.style.color='var(--red)'; msg.textContent='Failed: '+((e&&e.message)||e)+' (did you run the latest SQL?)'; } }
  }});
}
async function admSetAnalyst(wallet, on){
  if(!requireMaintainerAccess(on ? 'Verify analyst' : 'Unverify analyst')) return;
  osiSignEvent({ eventType: on?'ANALYST_VERIFIED':'ANALYST_REVOKED', actionLabel: on?'Verify analyst':'Unverify analyst', itemType:'analyst', itemId: wallet, sensitive: !on, publicLabel: (on?'Analyst verified':null), onSuccess: async (sig)=>{
  try{
    await supaPatch('analysts?wallet=eq.'+encodeURIComponent(wallet), { verified:on, approved:on });
    showToast(on?'Analyst verified and on the roster.':'Analyst hidden from the roster.');
    admRefresh(); loadAnalysts(); renderAnalysts();
  }catch(e){ showToast('Failed: '+((e&&e.message)||e)); }
  }});
}
async function admDelAnalyst(wallet){
  if(!requireMaintainerAccess('Remove analyst')) return;
  if(!confirm('Remove this analyst from the roster? This cannot be undone.')) return;
  osiSignEvent({ eventType:'ANALYST_REVOKED', actionLabel:'Remove analyst', itemType:'analyst', itemId: wallet, sensitive:true, onSuccess: async (sig)=>{
  try{ await supaDelete('analysts?wallet=eq.'+encodeURIComponent(wallet)); showToast('Analyst removed.'); admRefresh(); loadAnalysts(); renderAnalysts(); }
  catch(e){ showToast('Failed: '+((e&&e.message)||e)); }
  }});
}