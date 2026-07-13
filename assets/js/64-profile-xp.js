
// ===== Wallet profile: a personal console for the connected wallet =====
function walletButtonClick(){
  if(walletPubkey){ toggleWalletMenu(); }
  else { toggleWallet(); }
}

async function disconnectWallet(){
  var prov = getProvider();
  try{ if(prov && prov.disconnect) await prov.disconnect(); }catch(e){}
  walletPubkey = null;
  try{ localStorage.setItem('osi_phantom_restore','0'); }catch(e){}
  if(typeof clearWalletAuthorization==='function') clearWalletAuthorization();
  clearWalletCache();
  if(typeof closeWalletMenu==='function') closeWalletMenu();
  updateWalletUI();
  if(document.body && document.body.dataset && document.body.dataset.view==='admin' && typeof renderAdminAccess==='function') renderAdminAccess({clear:true});
  if(document.body && document.body.dataset && document.body.dataset.view==='profile') showView('registry');
  else if(document.body && document.body.dataset && document.body.dataset.view==='identity' && typeof renderIdentity==='function') await renderIdentity();
  if(typeof showToast==='function') showToast('Wallet disconnected.');
}

function pfHash(str){ let h=0; str=String(str); for(let i=0;i<str.length;i++){ h=(h<<5)-h+str.charCodeAt(i); h|=0; } return Math.abs(h); }
function pfIdenticon(addr, size){
  const h=pfHash(addr); const hue=h%360; const hue2=(Math.floor(h/7))%360; const n=5; const cell=size/n; const cells=[];
  for(let y=0;y<n;y++){ for(let x=0;x<3;x++){ if(((h>>(y*3+x))&1)===1){ cells.push([x,y]); if(x!==n-1-x) cells.push([n-1-x,y]); } } }
  const rects=cells.map(function(c){ return '<rect x="'+(c[0]*cell)+'" y="'+(c[1]*cell)+'" width="'+cell+'" height="'+cell+'"/>'; }).join('');
  return '<svg viewBox="0 0 '+size+' '+size+'" width="'+size+'" height="'+size+'" style="border-radius:5px;background:hsl('+hue2+',26%,12%)"><g fill="hsl('+hue+',70%,56%)">'+rects+'</g></svg>';
}
function pfStatus(id, pubIds){ return pubIds[id] ? '<span class="pf-badge pub">\u2713 Published</span>' : '<span class="pf-badge pend">\u23f3 Pending review</span>'; }
function pfDate(ts){ try{ return new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric'}); }catch(e){ return ''; } }
function pfTx(tx){ return tx ? ' \u00b7 <a class="pf-tx" href="https://solscan.io/tx/'+encodeURIComponent(tx)+'" target="_blank" rel="noopener">on-chain \u2197</a>' : ''; }

function pfGate(){
  return '<div class="pf-gate">'
    +'<div class="pf-gate-ic">\u25c6</div>'
    +'<div class="pf-gate-h">Your analyst console</div>'
    +'<p class="pf-gate-p">Connect your Phantom wallet to open your profile. Your wallet is your identity here: every report you file, every case you open, and every case you back is signed by it. This is the foundation of on-chain reputation (Phase 2).</p>'
    +'<button class="btn-fill" onclick="toggleWallet()">Connect Phantom \u2192</button>'
    +'</div>';
}
function pfReports(reports, pubIds){
  if(!reports.length) return '<div class="pf-empty">No reports filed yet. Apply to a case or submit research and it lands here.</div>';
  return reports.map(function(r){
    const title=escapeHtml(r.company||r.bounty||'Attribution report');
    const sum=escapeHtml(String(r.summary||'').slice(0,160));
    return '<div class="pf-item"><div class="pf-it-top"><div class="pf-it-t">'+title+'</div>'+pfStatus(r.id,pubIds)+'</div>'
      +'<div class="pf-it-s">'+sum+'</div>'
      +'<div class="pf-it-m mono">'+pfDate(parseInt(String(r.id).replace(/\D/g,''))||Date.now())+pfTx(r.tx)+'</div></div>';
  }).join('');
}
function pfBounties(bounties, pubIds){
  if(!bounties.length) return '<div class="pf-empty">No cases opened yet. Open a case on the board to file one.</div>';
  return bounties.map(function(b){
    const title=escapeHtml(b.target||b.title||'Bounty');
    const det=escapeHtml(String(b.detail||'').slice(0,150));
    return '<div class="pf-item"><div class="pf-it-top"><div class="pf-it-t">'+title+'</div>'+pfStatus(b.id,pubIds)+'</div>'
      +'<div class="pf-it-s">'+det+'</div></div>';
  }).join('');
}
function pfBoosts(boosted){
  const ids=Object.keys(boosted||{}); if(!ids.length) return '<div class="pf-empty">No cases backed yet. Back a case to signal it matters.</div>';
  return ids.map(function(bid){
    const v=boosted[bid]; let nm=(v&&v.name)?v.name:null;
    if(!nm){ const c=document.querySelector('.bounty[data-bid="'+bid+'"] .b-target'); nm=c?c.textContent.trim():bid; }
    const tx=(v&&v.tx)?v.tx:null;
    return '<div class="pf-item pf-mini"><div class="pf-it-t">\u2191 '+escapeHtml(nm)+'</div><div class="pf-it-m mono">boosted'+pfTx(tx)+'</div></div>';
  }).join('');
}
// ===== XP / reputation =====
const PF_RANKS = [
  { name:'Apprentice',         cls:'pf-l1', min:0 },
  { name:'Field Analyst',      cls:'pf-l2', min:60 },
  { name:'Detective',          cls:'pf-l3', min:180 },
  { name:'Chief Investigator', cls:'pf-l4', min:400 }
];
function pfApproved(reports, bounties, pubIds){
  let a=0; reports.forEach(function(x){ if(pubIds[x.id]) a++; }); bounties.forEach(function(x){ if(pubIds[x.id]) a++; }); return a;
}
function pfXP(reports, bounties, boosted, pubIds){
  const r=reports.length, b=bounties.length, bo=Object.keys(boosted||{}).length;
  return r*10 + b*15 + bo*4 + pfApproved(reports,bounties,pubIds)*30;
}
function pfRank(xp){
  let idx=0; for(let i=0;i<PF_RANKS.length;i++){ if(xp>=PF_RANKS[i].min) idx=i; }
  const cur=PF_RANKS[idx], next=PF_RANKS[idx+1]||null;
  const pct = next ? Math.max(4, Math.min(100, Math.round((xp-cur.min)/(next.min-cur.min)*100))) : 100;
  return { cur:cur, next:next, pct:pct };
}
function pfMonth(ts){ try{ return new Date(ts).toLocaleDateString('en-US',{month:'short',year:'numeric'}); }catch(e){ return 'recently'; } }

// name: live local + debounced sync to the wallet's profile row
let _pfNameT=null;
function pfSaveName(v){
  lsSet('stw_profile_name', v); pfLiveName(v);
  const av=document.getElementById('wbAva'); const wt=document.getElementById('wbText'); if(wt && walletPubkey) wt.textContent = v ? v : (walletPubkey.slice(0,4)+'\u2026'+walletPubkey.slice(-4));
  if(SUPA_ON && walletPubkey){ clearTimeout(_pfNameT); _pfNameT=setTimeout(function(){ supaUpsertProfile(walletPubkey, v).catch(function(){}); }, 800); }
}
async function supaUpsertProfile(addr, name){
  await fetch(SUPABASE_URL + '/rest/v1/profiles', {
    method:'POST', headers: supaHeaders({ Prefer:'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ wallet:addr, name:name, updated_at:new Date().toISOString() })
  });
}

function pfAnalystStatus(addr){
  if(isVerifiedAnalyst(addr)){
    return '<div class="pf-an verified"><span class="pf-an-ic">\u2605</span><div><div class="pf-an-t">Verified analyst</div><div class="pf-an-s">Founder-approved and on the public roster. Your tier rises automatically as your reports get approved and you win bounties.</div></div></div>';
  }
  if(lsGet('stw_applied_analyst', false)){
    return '<div class="pf-an pending"><span class="pf-an-ic">\u25d0</span><div><div class="pf-an-t">Application under review</div><div class="pf-an-s">The maintainer is reviewing your application. You can already file reports and apply to bounties in the meantime.</div></div></div>';
  }
  return '<div class="pf-an member"><span class="pf-an-ic">\u25c8</span><div><div class="pf-an-t">Contributor</div><div class="pf-an-s">Anyone can file reports and apply to bounties. Build a track record, then <a onclick="goCommunity(\'tab-analysts\')" style="color:var(--sol);cursor:pointer">apply to join the verified roster \u2192</a></div></div></div>';
}
function pfShell(addr, name, email, joined, reports, bounties, boosted, pubIds){
  const display = name ? escapeHtml(name) : short(addr);
  const xp = pfXP(reports, bounties, boosted, pubIds);
  const rk = pfRank(xp);
  const approved = pfApproved(reports, bounties, pubIds);
  const nBoost = Object.keys(boosted||{}).length;
  return ''
  +'<div class="pf-hero">'
    +'<button class="pf-dc" onclick="disconnectWallet()">\u23fb Disconnect</button>'
    +'<div class="pf-hero-top">'
      +'<div class="pf-ava" title="Change avatar" onclick="pfAvatarPick()" style="cursor:pointer">'+osiAvatarSvg(addr,72,(CV_CTX&&CV_CTX.data&&(CV_CTX.data.name||CV_CTX.data.handle))||'' ,osiAvatarUrl(addr,(CV_CTX&&CV_CTX.data)||null))+'<span class="pf-ava-edit mono">edit</span></div>'+'<input type="file" id="pf-ava-file" accept="image/*" style="display:none" onchange="pfAvatarChange(this)">'
      +'<div class="pf-id">'
        +'<div class="pf-name">'+display+' <span class="pf-clear '+rk.cur.cls+'">'+rk.cur.name+'</span></div>'
        +'<div class="pf-addr mono" title="Click to copy" onclick="pfCopy(\''+addr+'\')">'+escapeHtml(addr)+' <span class="pf-copy">copy</span></div>'
        +'<div class="pf-since mono">\u25c8 Member since '+pfMonth(joined)+'</div>'
      +'</div>'
    +'</div>'
    +pfAnalystStatus(addr)
    +'<div class="pf-xp">'
      +'<div class="pf-xp-top"><span class="pf-xp-n">'+xp+' <span class="pf-xp-u">XP</span></span>'
        +(rk.next ? ('<span class="pf-xp-next mono">'+(rk.next.min-xp)+' XP to '+rk.next.name+'</span>') : '<span class="pf-xp-next mono">top rank reached \u2605</span>')+'</div>'
      +'<div class="pf-xp-track"><div class="pf-xp-bar" style="width:'+rk.pct+'%"></div></div>'
    +'</div>'
  +'</div>'
  +'<div class="pf-stats">'
    +'<div class="pf-stat"><div class="n">'+reports.length+'</div><div class="l">Filings</div></div>'
    +'<div class="pf-stat"><div class="n" style="color:var(--sol)">'+approved+'</div><div class="l">Published</div></div>'
    +'<div class="pf-stat"><div class="n">'+bounties.length+'</div><div class="l">Bounties</div></div>'
    +'<div class="pf-stat"><div class="n">'+nBoost+'</div><div class="l">Backed</div></div>'
  +'</div>'
  +'<div class="pf-grid">'
    +'<div class="pf-col"><div class="pf-h">My filings <span class="pf-h-c">'+reports.length+'</span></div>'+pfReports(reports,pubIds)+'</div>'
    +'<div class="pf-col"><div class="pf-h">My bounties <span class="pf-h-c">'+bounties.length+'</span></div>'+pfBounties(bounties,pubIds)+'</div>'
    +'<div class="pf-col pf-col-wide"><div class="pf-h">My boosts <span class="pf-h-c">'+nBoost+'</span></div>'+pfBoosts(boosted)+'</div>'
  +'</div>'
  +'<div class="pf-cases"><div class="pf-h">My case records <span class="pf-h-c" id="pf-cases-n">0</span></div><div id="pf-cases-body"><div class="pf-empty mono">Loading</div></div></div>'
  +'<div class="pf-settings">'
    +'<div class="pf-h">Profile</div>'
    +'<div class="pf-set-grid">'
      +'<div class="pf-field"><label class="pf-lab">Display name</label>'
        +'<input class="pf-in" id="pf-name" value="'+(name?escapeHtml(name):'')+'" placeholder="e.g. aksusarya" oninput="pfSaveName(this.value)">'
        +'<div class="pf-hint mono">Shown instead of your address. Synced to your wallet.</div></div>'
      +'<div class="pf-field"><label class="pf-lab">Email <span class="pf-opt">optional</span></label>'
        +'<input class="pf-in" id="pf-email" type="email" value="'+(email?escapeHtml(email):'')+'" placeholder="you@example.com" oninput="lsSet(\'stw_profile_email\', this.value)">'
        +'<div class="pf-hint mono">Kept on this device, for your own record.</div></div>'
    +'</div>'
    +'<div class="pf-set-row"><span class="pf-hint mono">\u25c6 Signed in with Phantom \u00b7 '+short(addr)+'</span><button class="pf-dc sm" onclick="disconnectWallet()">\u23fb Disconnect wallet</button></div>'
  +'</div>';
}
function pfLiveName(v){ const el=document.querySelector('.pf-name'); if(el && el.firstChild){ el.firstChild.textContent=(v || (walletPubkey?short(walletPubkey):'')) + ' '; } }
function pfCopy(a){ try{ navigator.clipboard.writeText(a); showToast('Address copied.'); }catch(e){} }

async function renderProfile(){
  const host=document.getElementById('profile-body'); if(!host) return;
  if(!walletPubkey){ host.innerHTML=pfGate(); return; }
  const addr=walletPubkey;
  let joined=lsGet('stw_joined',''); if(!joined){ joined=new Date().toISOString(); lsSet('stw_joined',joined); }
  const reports=lsGet('stw_reports',[]);
  const bounties=lsGet('stw_bounties',[]);
  const boosted=lsGet('stw_boosted',{});
  let name=lsGet('stw_profile_name','');
  const email=lsGet('stw_profile_email','');
  host.innerHTML=pfShell(addr,name,email,joined,reports,bounties,boosted,{});
  if(typeof pfRenderCases==='function') pfRenderCases(addr);
  if(SUPA_ON){
    try{
      const pr=await supaGet('reports?select=id&wallet=eq.'+encodeURIComponent(addr)+'&approved=eq.true');
      const pb=await supaGet('bounties?select=id&created_by=eq.'+encodeURIComponent(addr)+'&approved=eq.true');
      const pubIds={}; (pr||[]).forEach(function(x){ pubIds[x.id]=1; }); (pb||[]).forEach(function(x){ pubIds[x.id]=1; });
      try{ const prof=await supaGet('profiles?select=name&wallet=eq.'+encodeURIComponent(addr)); if(prof&&prof[0]&&prof[0].name){ name=prof[0].name; lsSet('stw_profile_name',name); if(typeof updateWalletUI==='function') updateWalletUI(); } }catch(_){}
      if(document.body.dataset.view==='profile' && walletPubkey===addr){ host.innerHTML=pfShell(addr,name,email,joined,reports,bounties,boosted,pubIds); if(typeof pfRenderCases==='function') pfRenderCases(addr); }
    }catch(e){}
  }
}
