

// ===== THE WIRE: open community intelligence, filed without a bounty =====
let wireState = { sort:'newest', data:[], phase:'idle', sourceError:null, mode:'public', renderToken:0 };

async function renderWire(options){
  if(!document.getElementById('wire-cases')) return;
  const activatePublic=!!(options&&options.activatePublic);
  if(wireState.mode==='private'&&!activatePublic)return;
  wireState.mode='public';
  const renderToken=++wireState.renderToken;
  if(typeof window.osiV2RefreshWireCapability==='function')window.osiV2RefreshWireCapability();
  wireState.phase = 'loading';
  wireState.sourceError = null;
  drawWire();
  let native = [];
  if(typeof window.osiV2ListPublicWireReports==='function'){
    try{
      const result=await window.osiV2ListPublicWireReports();
      native=(result.reports||[]).map(function(row){
        return{
          id:row.version_public_ref,version_public_ref:row.version_public_ref,
          wire_report_public_ref:row.wire_report_public_ref,
          subject:row.title,body:row.summary,
          author:row.author&&row.author.wallet||'',author_handle:row.author&&row.author.handle||'',
          created_at:row.published_at,native:true,publication_channel:row.publication_channel,
          contested_at:row.contested_at,support_lamports:row.support_lamports||0,
          promoted:row.promoted===true,is_current_published:row.is_current_published!==false
        };
      });
    }catch(e){ wireState.sourceError=e||new Error('wire_native_source_unavailable'); }
  }
  // Flagship investigations (the curated case studies) feature at the top of the wire.
  const featured = (window.CASE_STUDIES || []).map(function(cs){
    return { id:'cs_'+cs.id, _case:cs.id, subject: cs.company + (cs.ticker ? (' (' + cs.ticker + ')') : ''),
             body: cs.summary || cs.intro || '', author: (cs.author || ''), premium:true, legacy:true,
             image:'', wallet:'', created_at:cs.published_at||cs.created_at||'2020-01-01' };
  });
  let community = [];
  if(SUPA_ON){
    try{
      const rows = await supaGet('reports?select=id,bounty,company,wallet,summary,attachment,created_at&approved=eq.true&order=created_at.desc');
      community = (rows || [])
        .filter(function(r){ return !(r.bounty && String(r.bounty).trim()); })   // intel = no bounty
        .map(function(r){
          const isImg = r.attachment && /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(r.attachment);
          return { id:r.id, subject:(r.company || 'Intel dispatch'), body:(r.summary || ''),legacy:true,
                   author:(r.wallet ? short(r.wallet) : ''), wallet:(r.wallet || ''),
                   image:(isImg ? r.attachment : ''), attachment:(r.attachment || ''),
                   created_at:r.created_at, premium:false };
        });
    }catch(e){ wireState.sourceError = e || new Error('wire_source_unavailable'); }
  }
  if(renderToken!==wireState.renderToken||wireState.mode!=='public')return;
  wireState.data = native.concat(featured,community);
  wireState.phase = wireState.sourceError ? 'error' : 'ready';
  drawWire();
}
function drawWire(){
  const host=document.getElementById('wire-cases'); if(!host) return;
  if(wireState.phase==='loading'){
    wireStats([]);
    host.innerHTML = '<div class="wire-empty" role="status" aria-live="polite"><div class="wire-empty-h">Opening the live wire\u2026</div><p>Checking published dispatches and public reports.</p></div>';
    return;
  }
  wireStats(wireState.data);
  let list = wireState.data.slice();
  list.sort(function(a,b){ return new Date(b.created_at||0) - new Date(a.created_at||0); });
  const sourceNotice = wireState.phase==='error'
    ? '<div class="wire-empty wire-source-error" role="alert"><div class="wire-empty-h">Live dispatches are temporarily unavailable.</div><p>'+(list.length ? 'Curated public reports are still available below.' : 'We could not reach the intelligence network just now.')+'</p><button class="wire-retry" type="button" onclick="renderWire()">Retry live source</button></div>'
    : '';
  if(!list.length){
    if(sourceNotice){ host.innerHTML = sourceNotice; return; }
    host.innerHTML = '<div class="wire-empty"><div class="wire-empty-h">The wire is quiet</div><p>No reviewed Wire Reports have been published yet. Unpublished submissions remain private.</p></div>';
    return;
  }
  host.innerHTML = sourceNotice + list.map(wireCard).join('');
  const boosted=lsGet('stw_boosted',{});
  host.querySelectorAll('.bounty[data-bid]').forEach(function(card){ if(boosted[card.dataset.bid]) markBoostedUI(card,null); });
  hydrateBoosts();
}
function wireCard(d){
  const id = escapeHtml(d.id);
  const subject = escapeHtml(d.subject || 'Intel dispatch');
  const full = String(d.body || '');
  const snippet = escapeHtml(full.slice(0,130)) + (full.length>130 ? '\u2026' : '');
  const count = ((window.boostCounts||{})[d.id]) || 0;
  const authorRaw = String(d.author||'');
  const author = authorRaw ? escapeHtml(authorRaw) : '';
  const attribution = d.native
    ? ('by '+escapeHtml(d.author_handle?('@'+d.author_handle+' · '+authorRaw):authorRaw||'wallet unavailable'))
    : (author ? ('by '+author) : 'source not attributed');
  const status = d.premium ? 'flag' : 'open';
  const statusLabel = d.native
    ? (d.is_current_published===false
      ? (d.publication_channel==='maintainer_bootstrap'?'SUPERSEDED · BOOTSTRAP':'SUPERSEDED · REVIEWED')
      : (d.publication_channel==='maintainer_bootstrap'?'MAINTAINER BOOTSTRAP':'REVIEWED'))
    : (d.premium ? 'FLAGSHIP · LEGACY' : 'DISPATCH · LEGACY');
  const activity = d.native
    ? (d.contested_at?'Challenge upheld':(d.promoted?'Promoted to Case':(d.is_current_published===false?'Immutable publication history':'Published finding')))
    : '<span class="b-reward"><span class="n">'+count+'</span></span> interest signals';
  let actions = '';
  if(d.native && /^OSI-WV-[0-9A-F]{16}$/.test(String(d.version_public_ref||''))){
    actions += '<button class="wr-act primary" type="button" data-wire-version="'+escapeHtml(d.version_public_ref)+'">Open Wire Report \u2192</button>';
  } else if(d.premium && d._case){
    actions += '<button class="wr-act primary" type="button" onclick="openReport(\'case\',\''+d._case+'\')">Read report \u2192</button>';
    // Voluntary support to the configured OSI wallet only (no per-dispatch wallet).
    if(OSI_SUPPORT_WALLET){ actions += '<button class="wr-act ghost" type="button" onclick="openTip(\''+OSI_SUPPORT_WALLET+'\',\'OSI project support\',0.5,\'\\u25ce Voluntary support\')">\u25ce Support</button>'; }
  } else {
    actions += '<button class="wr-act ghost" type="button" data-wire-interest onclick="stakeBoost(this)">Signal interest</button>';
    // Stage 4: removed "Support the analyst" to a dispatch's self-declared wallet
    // (unverified, ambiguous). Support routes only to the configured OSI wallet.
  }
  return '<div class="wire-card bounty'+(d.premium?' premium':'')+'" data-bid="'+id+'">'
    + '<span class="fc-stripe"></span>'
    + '<div class="wr-head"><span class="wr-st '+status+'">'+statusLabel+'</span><span class="wr-by mono">'+attribution+'</span><span class="wr-back mono">'+activity+'</span></div>'
    + '<div class="fc-title b-target wr-title">'+subject+'</div>'
    + (snippet ? '<div class="wr-snip">'+snippet+'</div>' : '')
    + '<div class="wr-acts">'+actions+'</div>'
  + '</div>';
}
function wireStats(list){
  const host=document.getElementById('wire-stats'); if(!host) return;
  const total = list.length;
  const published = list.filter(function(d){ return d.native; }).length;
  const legacy = total - published;
  host.innerHTML =
      '<div class="wire-op"><div class="wire-op-n cy">'+total+'</div><div class="wire-op-l">Dispatches</div></div>'
    + '<div class="wire-op"><div class="wire-op-n">'+published+'</div><div class="wire-op-l">Reviewed publications</div></div>'
    + '<div class="wire-op"><div class="wire-op-n">'+legacy+'</div><div class="wire-op-l">Legacy references</div></div>';
}
document.addEventListener('click',function(event){
  var button=event.target&&event.target.closest?event.target.closest('[data-wire-version]'):null;
  if(!button)return;
  var ref=String(button.getAttribute('data-wire-version')||'');
  if(/^OSI-WV-[0-9A-F]{16}$/.test(ref)&&typeof window.osiV2OpenWireReport==='function'){
    window.osiV2OpenWireReport(ref);
  }
});
function wireSort(){ wireState.sort='newest'; document.querySelectorAll('.wire-sort').forEach(function(b){ b.classList.toggle('active', b.dataset.s==='newest'); }); drawWire(); }
function wireEnterPrivateMode(){wireState.mode='private';wireState.renderToken++;}
function wireOpenPublic(){wireState.mode='public';return renderWire({activatePublic:true});}
function wireClearPrivateMode(){if(wireState.mode==='private')return wireOpenPublic();}
function wireOpenForm(){
  if(typeof window.osiV2OpenWireForm==='function')return window.osiV2OpenWireForm();
  if(typeof showToast==='function')showToast('Native Wire intake is safely unavailable.');
}
function wireCloseForm(){
  if(typeof window.osiV2CloseWireForm==='function')return window.osiV2CloseWireForm();
}
async function submitIntel(){
  if(typeof window.osiV2SubmitWire==='function')return await window.osiV2SubmitWire();
  throw new Error('native_wire_intake_unavailable');
}

// ===== Solana Pay: turn any tip/reward/support into a scannable payment request =====
const SOLANA_PAY_QR_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
let _qrLibLoading = null, _payOpen = false, _qrTimer = null;

function loadQrLib(){
  if(window.qrcode) return Promise.resolve();
  if(_qrLibLoading) return _qrLibLoading;
  _qrLibLoading = new Promise(function(resolve, reject){
    const s = document.createElement('script');
    s.src = SOLANA_PAY_QR_CDN; s.async = true;
    s.onload = function(){ resolve(); };
    s.onerror = function(){ _qrLibLoading = null; reject(new Error('qr lib failed')); };
    document.head.appendChild(s);
  });
  return _qrLibLoading;
}
// Solana Pay transfer request spec: solana:<recipient>?amount=&label=&message=&memo=
function buildSolanaPayUrl(){
  if(!tipCtx || !tipCtx.wallet || !isSolAddr(tipCtx.wallet)) return '';
  const p = new URLSearchParams();
  if(tipCtx.amount && tipCtx.amount > 0) p.set('amount', String(tipCtx.amount));
  p.set('label', 'OSI');
  p.set('message', 'Voluntary support (does not influence review or publication)');
  p.set('memo', 'OSI1|SUPPORT_SENT');
  return 'solana:' + tipCtx.wallet + '?' + p.toString();
}
function resetSolanaPay(){
  _payOpen = false;
  const box = document.getElementById('tip-pay'); if(box) box.hidden = true;
  const tg = document.getElementById('tip-pay-toggle'); if(tg) tg.innerHTML = '\u229e&nbsp; Or pay with any wallet (Solana Pay) \u25be';
  const qr = document.getElementById('tip-qr'); if(qr) qr.innerHTML = '';
}
function toggleSolanaPay(){
  _payOpen = !_payOpen;
  const box = document.getElementById('tip-pay'); if(box) box.hidden = !_payOpen;
  const tg = document.getElementById('tip-pay-toggle'); if(tg) tg.innerHTML = _payOpen ? '\u229e&nbsp; Or pay with any wallet (Solana Pay) \u25b4' : '\u229e&nbsp; Or pay with any wallet (Solana Pay) \u25be';
  if(_payOpen) renderSolanaPay();
}
function renderSolanaPay(){
  if(!_payOpen) return;
  const url = buildSolanaPayUrl();
  const link = document.getElementById('tip-pay-link'); if(link) link.href = url || '#';
  clearTimeout(_qrTimer);
  _qrTimer = setTimeout(function(){
    const host = document.getElementById('tip-qr'); if(!host) return;
    if(!url){ host.innerHTML = ''; return; }
    host.innerHTML = '<div class="tip-qr-load mono">rendering QR…</div>';
    loadQrLib().then(function(){
      try{
        const qr = window.qrcode(0, 'M'); qr.addData(url); qr.make();
        host.innerHTML = '<img alt="Solana Pay QR" src="' + qr.createDataURL(5, 6) + '">';
      }catch(e){ host.innerHTML = '<div class="tip-qr-fallback mono">QR unavailable here, use the link below.</div>'; }
    }).catch(function(){ host.innerHTML = '<div class="tip-qr-fallback mono">QR unavailable here, use the link below.</div>'; });
  }, 160);
}
function copySolanaPay(){
  const url = buildSolanaPayUrl(); if(!url) return;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(function(){ showToast('Solana Pay link copied \u2713'); }, function(){ showToast('Copy failed, long-press the link to copy it.'); });
  } else { showToast('Copy not supported here, long-press the link.'); }
}

// ===== File + image attachments via Supabase Storage =====
const OSI_BUCKET = 'osi-uploads';
const _picked = {};   // { apply: File|null, bf: File|null }
function _fileInput(key){ return document.getElementById(key+'-file') || document.getElementById(key+'-image'); }
function onPickFile(key){
  const inp = _fileInput(key);
  const f = inp && inp.files && inp.files[0];
  const nameEl = document.getElementById(key+'-file-name');
  const prevEl = document.getElementById(key+'-file-prev');
  if(!f){ _picked[key]=null; if(nameEl) nameEl.textContent=''; if(prevEl) prevEl.innerHTML=''; return; }
  if(f.size > 10*1024*1024){ showToast("That file is over 10MB. Please attach something smaller."); if(inp) inp.value=''; return; }
  if(f.type && !/^(image\/(png|jpe?g|gif|webp|avif)|application\/pdf|text\/(plain|csv))$/i.test(f.type)){ showToast("That file type is not allowed. Attach an image, PDF, or text/CSV file."); if(inp) inp.value=''; _picked[key]=null; return; }
  _picked[key]=f;
  if(nameEl) nameEl.textContent = f.name;
  if(prevEl){
    if(/^image\//.test(f.type||'')){ const rd=new FileReader(); rd.onload=function(){ prevEl.innerHTML='<img src="'+rd.result+'" alt="preview">'; }; rd.readAsDataURL(f); }
    else { prevEl.innerHTML='<div class="file-doc">\uD83D\uDCC4 '+escapeHtml(f.name)+'</div>'; }
  }
}
function clearPickedFile(key){
  _picked[key]=null;
  const inp=_fileInput(key); if(inp) inp.value='';
  const nameEl=document.getElementById(key+'-file-name'); if(nameEl) nameEl.textContent='';
  const prevEl=document.getElementById(key+'-file-prev'); if(prevEl) prevEl.innerHTML='';
}
async function uploadPicked(key){ const f=_picked[key]; if(!f) return ''; return await supaUpload(f); }
async function supaUpload(file){
  if(!SUPA_ON || !file) return '';
  const m = file.name.match(/\.([a-z0-9]+)$/i); const ext = (m ? m[1] : 'bin').toLowerCase();
  const path = 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2,8) + '.' + ext;
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/' + OSI_BUCKET + '/' + path, {
    method:'POST',
    headers:{ 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + (SUPA_AUTH_TOKEN || SUPABASE_ANON_KEY), 'Content-Type': file.type || 'application/octet-stream', 'x-upsert':'false' },
    body: file
  });
  if(!res.ok) throw new Error('upload ' + res.status);
  return SUPABASE_URL + '/storage/v1/object/public/' + OSI_BUCKET + '/' + path;
}
// ===== THE FIELD OFFICE: the bounty operations hub =====
// Curated launch cases (real untraced DAT targets). Also a fallback when Supabase
// is unavailable. User-filed cases come from Supabase and merge in by id.
// Community intelligence requests: starter forensic cases the project wants traced (no posted reward).
// These are seeded into Supabase (where the maintainer manages them); this array is the offline
// fallback shown only if Supabase is unreachable.
const FIELD_SEED = [
  { id:'seed_drainer', target:'Wallet-drainer infrastructure, mapped',      reward_sol:0, detail:'Community intelligence request. Cluster the wallets behind a known drainer pattern, fingerprint the off-ramps, and document the reused infrastructure so the next victim can be warned early. Bring evidence and the community traces it.', created_at:'2026-06-24T00:00:00Z' },
  { id:'seed_rug',     target:'Rug pull post-mortem, follow the liquidity', reward_sol:0, detail:'Community intelligence request. When a token collapses, follow the money out: map the deployer wallets, the liquidity removal, and where the proceeds landed, with a confidence grade on every hop. Open to any analyst.', created_at:'2026-06-23T00:00:00Z' },
  { id:'seed_bridge',  target:'Cross-chain exit after an incident',         reward_sol:0, detail:'Community intelligence request. Trace funds that left Solana through a bridge after an incident: identify the entry wallet, the bridge route, and the destination cluster on the other chain, so exchanges can act on it.', created_at:'2026-06-22T00:00:00Z' },
  { id:'seed_phish',   target:'Phishing wave, shared attribution trail',    reward_sol:0, detail:'Community intelligence request. Aggregate reports from a phishing campaign, cluster the collector wallets, and build one shared attribution trail that victims and exchanges can act on together.', created_at:'2026-06-21T00:00:00Z' }
];
let fieldState = { filter:'open', sort:'reward', q:'', mine:false, page:1, data:[] };
const FIELD_PER_PAGE = 5;

async function renderFieldOffice(){
  if(!document.getElementById('field-cases')) return;
  var demo = (window.OSI_DEMO_MODE === true);   // sample cards only in demo mode
  let list = [];
  window.__foError = false;
  if(SUPA_ON){
    try{
      const rows = await supaGet('bounties?select=*&approved=eq.true&order=created_at.desc');
      list = rows || [];
    }catch(e){
      list = demo ? FIELD_SEED.slice() : [];   // live mode: NO seed cards on failure
      window.__foError = !demo;
    }
  } else {
    list = demo ? FIELD_SEED.slice() : [];     // live mode without Supabase: clean empty state
  }
  fieldState.data = list;
  drawFieldOffice();
  foDeckRender();
  try{ lbHydrateReal(); }catch(e){}
  try{ lbActions(); }catch(e){}
}
function drawFieldOffice(){
  const host=document.getElementById('field-cases'); if(!host) return;
  let base = fieldState.data.slice().filter(function(b){ if(b.winner_wallet) return true; var dl=bountyDeadline(b); return !dl || dl>Date.now(); });
  fieldStats(base);
  let list = base.slice();
  var mc=document.getElementById('fr-myc');
  if(mc){ var mn=base.filter(foIsMine).length; mc.textContent=mn; mc.style.display=mn?'':'none'; }
  const q = (fieldState.q||'').trim().toLowerCase();
  if(q){ list = list.filter(function(b){ return ((b.target||b.title||'')+' '+(b.detail||'')).toLowerCase().indexOf(q)!==-1; }); }
  if(fieldState.mine){ list = list.filter(foIsMine); }
  if(fieldState.filter==='open') list = list.filter(function(b){ return !b.winner_wallet; });
  else if(fieldState.filter==='resolved') list = list.filter(function(b){ return !!b.winner_wallet; });
  if(fieldState.sort==='reward') list.sort(function(a,b){ return (parseFloat(b.reward_sol)||0)-(parseFloat(a.reward_sol)||0); });
  else if(fieldState.sort==='newest') list.sort(function(a,b){ return new Date(b.created_at||0)-new Date(a.created_at||0); });
  else if(fieldState.sort==='boosts') list.sort(function(a,b){ return (((window.boostCounts||{})[b.id])||0)-(((window.boostCounts||{})[a.id])||0); });
  var totalPages = Math.max(1, Math.ceil(list.length / FIELD_PER_PAGE));
  if(fieldState.page > totalPages) fieldState.page = totalPages;
  if(fieldState.page < 1) fieldState.page = 1;
  var pFrom = (fieldState.page-1)*FIELD_PER_PAGE;
  var pageList = list.slice(pFrom, pFrom+FIELD_PER_PAGE);
  var cnt=document.getElementById('fo-count');
  if(cnt){ cnt.textContent = list.length ? ('Showing '+(pFrom+1)+'\u2013'+(pFrom+pageList.length)+' of '+list.length+' cases') : ''; }
  var pnav=document.getElementById('fo-pnav');
  if(pnav){
    if(totalPages<=1){ pnav.innerHTML=''; }
    else{
      var ph='<button class="fo-pg" type="button" '+(fieldState.page<=1?'disabled':'')+' onclick="fieldPage('+(fieldState.page-1)+')" aria-label="Previous page">\u2039</button>';
      for(var pi=1; pi<=totalPages; pi++){ ph+='<button class="fo-pg n'+(pi===fieldState.page?' active':'')+'" type="button" onclick="fieldPage('+pi+')">'+pi+'</button>'; }
      ph+='<button class="fo-pg" type="button" '+(fieldState.page>=totalPages?'disabled':'')+' onclick="fieldPage('+(fieldState.page+1)+')" aria-label="Next page">\u203a</button>';
      pnav.innerHTML=ph;
    }
  }
  if(!list.length){
    if(window.__foError){
      host.innerHTML='<div class="fo-empty"><div class="fo-empty-h">Cases are temporarily unavailable.</div><p>We could not reach the intelligence network just now. Refresh in a moment.</p><button class="fo-cta" onclick="renderFieldOffice()">Retry</button></div>';
      return;
    }
    if(fieldState.mine){
      host.innerHTML='<div class="fo-empty"><div class="fo-empty-h">No cases from this wallet yet.</div><p>Open your first case, it is free and signed with your wallet, so it shows up here as yours.</p><button class="fo-cta" onclick="fieldOpenForm()">+ Open a case</button></div>';
      return;
    }
    const w = fieldState.filter==='resolved' ? 'closed' : (fieldState.filter==='open' ? 'open' : '');
    const why = q ? 'No cases match your search.' : ('No '+w+' cases right now.');
    host.innerHTML='<div class="fo-empty"><div class="fo-empty-h">'+why+'</div><p>Be the first to file one. Name a target nobody has traced and let the community hunt it.</p><button class="fo-cta" onclick="fieldOpenForm()">+ Open a case</button></div>';
    return;
  }
  host.innerHTML = pageList.map(function(b,i){ return fieldCaseCard(b,i); }).join('');
  const boosted=lsGet('stw_boosted',{}), applied=lsGet('stw_applied',{});
  host.querySelectorAll('.bounty[data-bid]').forEach(function(card){
    if(boosted[card.dataset.bid]) markBoostedUI(card,null);
    if(applied[card.dataset.bid]) markAppliedUI(card,null);
  });
  hydrateBoosts();
  if(typeof foAutoPreview==='function'){ try{ foAutoPreview(); }catch(e){} }
}
function fieldSearch(v){ fieldState.q = v||''; fieldState.page=1; drawFieldOffice(); }

// Solana amblem (kucuk inline SVG, yesil) + bounty geri sayim
var SOL_MARK='<svg class="sol-mk" viewBox="0 0 24 19" aria-hidden="true"><path d="M5 1h18l-4 4H1z"/><path d="M1 7.5h18l4 4H5z"/><path d="M5 14h18l-4 4H1z"/></svg>';
function bountyDeadline(b){
  if(b && b.expires_at){ var t=new Date(b.expires_at).getTime(); if(!isNaN(t)&&t>0) return t; }
  if(!(parseFloat(b && b.reward_sol) > 0)) return 0;
  var id=String((b&&b.id)||(b&&b.target)||''); if(!id) return 0;
  var hsh=2166136261; for(var i=0;i<id.length;i++){ hsh^=id.charCodeAt(i); hsh=Math.imul(hsh,16777619); }
  var hours=100+(Math.abs(hsh)%101); // deterministic 100..200h window
  // base the countdown on the case created_at so it is identical on every device
  var base=(b && b.created_at) ? new Date(b.created_at).getTime() : 0;
  if(isNaN(base)||base<=0) base=Date.now();
  return base + hours*3600000;
}
function fmtCountdown(ms){
  if(ms<=0) return null;
  var tm=Math.floor(ms/60000), d=Math.floor(tm/1440), h=Math.floor((tm%1440)/60), m=tm%60;
  if(d>0) return d+'d '+h+'h';
  if(h>0) return h+'h '+m+'m';
  return m+'m';
}
function fieldTick(){
  document.querySelectorAll('.fo-case[data-deadline]').forEach(function(card){
    var dl=parseInt(card.dataset.deadline,10)||0; if(!dl) return;
    var left=dl-Date.now();
    if(left<=0){ card.style.display='none'; return; }
    var cd=card.querySelector('.fc-time[data-cd]'); if(cd){ cd.textContent=fmtCountdown(left); if(left<86400000) cd.classList.add('urgent'); }
  });
}
if(typeof window!=='undefined' && !window.__fieldTick){ window.__fieldTick=setInterval(fieldTick, 30000); }

function fieldCaseCard(b, i){
  const id = escapeHtml(b.id);
  const target = escapeHtml(b.target || b.title || 'case');
  const _d = String(b.detail||'').replace(/\s+/g,' ').trim();
  const descText = _d ? (_d.slice(0,96) + (_d.length>96 ? '\u2026' : '')) : 'No summary provided yet.';
  const desc = escapeHtml(descText);
  const reward = parseFloat(b.reward_sol) || 0;
  const resolved = !!b.winner_wallet;
  const count = ((window.boostCounts||{})[b.id]) || 0;
  const hot = !resolved && count >= 5;
  const status = resolved ? 'closed' : (hot ? 'hot' : 'open');
  const statusLabel = resolved ? 'REVIEWED' : 'SUBMITTED';
  const stageLabel = resolved ? 'Reviewed' : 'Submitted';
  const osi = 'OSI-' + ((pfHash(String(b.id)) % 9000) + 1000);
  const deadline = resolved ? 0 : bountyDeadline(b);
  const _left = deadline - Date.now();
  const _urgent = (deadline && _left < 86400000);
  let timeHtml;
  if(deadline && _left > 0 && !resolved){ timeHtml = '<span class="fc-time'+(_urgent?' urgent':'')+'" data-cd="1">'+fmtCountdown(_left)+'</span>'; }
  else { timeHtml = '<span class="fc-time dim">No deadline</span>'; }
  const supHtml = reward > 0 ? (SOL_MARK+' '+reward) : '<span class="fc-muted">No reward posted</span>';
  return '<div class="fo-case bounty '+status+'" data-bid="'+id+'" data-deadline="'+deadline+'" role="button" tabindex="0" onclick="fieldRowClick(\''+id+'\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();fieldRowClick(\''+id+'\');}">'
    + '<span class="fc-stripe"></span>'
    + '<div class="fc-id"><span class="fc-osi mono">'+osi+'</span><span class="fc-st '+status+'">'+statusLabel+'</span></div>'
    + '<div class="fc-main"><div class="fc-title b-target">'+target+'</div>'+(desc?('<div class="fc-desc">'+desc+'</div>'):'')+'</div>'
    + '<span class="fc-stage"><span class="fc-st '+status+'">'+stageLabel+'</span></span>'
    + '<span class="fc-sup mono">'+supHtml+'</span>'
    + '<span class="fc-back b-reward mono"><span class="n">'+count+'</span></span>'
    + '<span class="fc-dl mono">'+timeHtml+'</span>'
    + '<span class="fc-act"><span class="fc-open">Open \u203a</span></span>'
  + '</div>';
}


// ---- Case file drawer: the single detail surface for an open case ----
var caseFileData = null;
function foWide(){ return window.innerWidth>=1280 && !!document.getElementById('fo-preview'); }
function fieldRowClick(id){ if(foWide()){ foPreviewShow(id); } else { openCaseFile(id); } }
function foPreviewHtml(b){
  var target=escapeHtml(b.target||b.title||'case');
  var briefRaw=String(b.detail||'').replace(/\s+/g,' ').trim();
  var brief=escapeHtml(briefRaw||'No summary provided yet.');
  var reward=parseFloat(b.reward_sol)||0, resolved=!!b.winner_wallet;
  var count=((window.boostCounts||{})[b.id])||0;
  var status=resolved?'closed':(count>=5?'hot':'open');
  var label=resolved?'REVIEWED':'SUBMITTED';
  var osi='OSI-'+((pfHash(String(b.id))%9000)+1000);
  var dl=resolved?0:bountyDeadline(b), left=dl-Date.now();
  var timeV=resolved?'-':(dl&&left>0?fmtCountdown(left):'No deadline');
  var sup=reward>0?(SOL_MARK+' '+reward):'No reward posted';
  var hasDirectProof=!!(b.tx||b.tx_sig);
  var proofLabel=hasDirectProof?'Linked proof event':'No linked proof event';
  var proofDetail=hasDirectProof?'Ready for external verification':'Awaiting first signed action';
  var reviewDetail=resolved?'Reviewed case outcome':'Awaiting analyst report';
  var life='<div class="fp-flow" aria-label="Case lifecycle">'
    + '<span class="fp-step done"><i></i>Intake</span>'
    + '<span class="fp-line '+(resolved?'done':'')+'"></span>'
    + '<span class="fp-step '+(resolved?'done':'next')+'"><i></i>Evidence</span>'
    + '<span class="fp-line '+(resolved?'done':'')+'"></span>'
    + '<span class="fp-step '+(resolved?'active':'next')+'"><i></i>Review</span>'
    + '<span class="fp-line"></span>'
    + '<span class="fp-step next"><i></i>Seal</span>'
    + '</div>';
  var acts='<button class="cf-btn primary" type="button" onclick="openCaseFile(\''+escapeHtml(String(b.id))+'\')">View case file \u2197</button>'
    + (resolved
      ? '<button class="cf-btn ghost" type="button" onclick="caseFileReward()">\u25ce Support the winner</button>'
      : '<button class="cf-btn ghost" type="button" onclick="caseFileApply()">\u2726 Submit a report</button>'
        +'<button class="cf-btn ghost" type="button" onclick="caseFileBack()">\u2191 Support this case</button>')
    + (hasDirectProof
      ? '<button class="cf-btn ghost verify" type="button" onclick="foVerify()">'+SOL_MARK+' Verify on Solana</button>'
      : '<button class="cf-btn ghost verify disabled" type="button" disabled aria-disabled="true">No linked proof event</button>');
  return '<div class="fp-k">SELECTED CASE FILE</div>'
    +'<div class="fp-idrow"><span class="fp-osi mono">'+osi+'</span><span class="fc-st '+status+'">'+label+'</span></div>'
    +'<div class="fp-title">'+target+'</div>'
    +life
    +'<div class="fp-status-console">'
    +'<div><span>Current stage</span><b>'+escapeHtml(resolved?'Reviewed':'Submitted')+'</b></div>'
    +'<div><span>Review</span><b>'+escapeHtml(reviewDetail)+'</b></div>'
    +'<div><span>Proof</span><b>'+escapeHtml(proofDetail)+'</b></div>'
    +'</div>'
    +'<div class="fp-stats">'
    +'<div class="fp-stat"><span class="n">'+sup+'</span><span class="l">Reward / support</span></div>'
    +'<div class="fp-stat"><span class="n">'+count+'</span><span class="l">Backers</span></div>'
    +'<div class="fp-stat"><span class="n">'+timeV+'</span><span class="l">Deadline</span></div>'
    +'</div>'
    +'<div class="cf-sec-l">Case summary</div>'
    +'<div class="fp-sum">'+brief+'</div>'
    +'<div class="fp-proof-state '+(hasDirectProof?'linked':'pending')+'"><span>'+proofLabel+'</span><b>'+proofDetail+'</b></div>'
    +'<div class="fp-acts">'+acts+'</div>'
    +'<div class="fp-note">Peer support is voluntary and non-custodial. It never affects review outcomes.</div>';
}
function foPreviewShow(id){
  var host=document.getElementById('fo-preview'); if(!host) return;
  var list=(fieldState&&fieldState.data)?fieldState.data:[]; var b=null;
  for(var i=0;i<list.length;i++){ if(String(list[i].id)===String(id)){ b=list[i]; break; } }
  if(!b) return;
  caseFileData=b;
  host.innerHTML=foPreviewHtml(b);
  document.querySelectorAll('#field-cases .fo-case').forEach(function(r){ r.classList.toggle('selected', String(r.getAttribute('data-bid'))===String(id)); });
}
function foAutoPreview(){
  if(!foWide()) return;
  var sel=document.querySelector('#field-cases .fo-case.selected[data-bid]');
  var first=sel||document.querySelector('#field-cases .fo-case[data-bid]');
  if(first){ foPreviewShow(first.getAttribute('data-bid')); }
  else { var hh=document.getElementById('fo-preview'); if(hh) hh.innerHTML='<div class="fo-prev-empty mono">No open cases right now. Open the first one, it is free.</div>'; }
}
async function cfLoadProof(bid){
  var host=document.getElementById('cf-proof'); if(!host) return;
  if(!caseFileData || String(caseFileData.id)!==String(bid)) return;
  if(!SUPA_ON){ host.innerHTML='<span class="cv-empty mono">Live proof log loads when the backend is connected.</span>'; return; }
  try{
    var evs=await supaGet('onchain_events?select=event_type,item_type,item_id,vote,label,tx_sig,created_at,actor_wallet&item_id=eq.'+encodeURIComponent(String(bid))+'&order=created_at.desc&limit=8');
    if(!caseFileData || String(caseFileData.id)!==String(bid)) return;
    if(!evs || !evs.length){ host.innerHTML='<span class="cv-empty mono">No signed on-chain actions for this case yet. Backing it or filing a report writes the first memo.</span>'; return; }
    host.innerHTML='<div class="ra-feed cf-feed">'+evs.map(raSignedItem).join('')+'</div>';
  }catch(e){ host.innerHTML='<span class="cv-empty mono">Proof log unavailable right now.</span>'; }
}
function openCaseFile(id){
  var list = (fieldState && fieldState.data) ? fieldState.data : [];
  var b = null; for(var i=0;i<list.length;i++){ if(String(list[i].id)===String(id)){ b=list[i]; break; } }
  if(!b) return;
  caseFileData = b;
  var body = document.getElementById('cf-drawer-body'); if(body) body.innerHTML = cfDrawerHtml(b);
  if(typeof cfLoadProof === 'function') cfLoadProof(b.id);
  var dr = document.getElementById('cf-drawer'); if(dr){ dr.classList.add('open'); dr.setAttribute('aria-hidden','false'); }
  document.body.classList.add('cr-drawer-lock');
}
function closeCaseFile(){ var d=document.getElementById('cf-drawer'); if(d){ d.classList.remove('open'); d.setAttribute('aria-hidden','true'); } document.body.classList.remove('cr-drawer-lock'); }
// case lifecycle tracker: Submitted -> Under Review -> Reviewed -> Public Record
function cfLifecycle(idx){
  var steps = ['Submitted','Under Review','Reviewed','Public Record'];
  var track = '';
  for(var i=0;i<steps.length;i++){
    var dcls = i<idx ? 'done' : (i===idx ? 'current' : 'pending');
    track += '<span class="cf-dot '+dcls+'"></span>';
    if(i<steps.length-1) track += '<span class="cf-line '+(i<idx?'done':'pending')+'"></span>';
  }
  var labels = steps.map(function(s,i){ return '<span class="'+(i<idx?'done':(i===idx?'current':''))+'">'+s+'</span>'; }).join('');
  return '<div class="cf-life"><div class="cf-track">'+track+'</div><div class="cf-labels">'+labels+'</div></div>';
}
