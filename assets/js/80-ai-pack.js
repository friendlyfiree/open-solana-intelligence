


// ============================================================
// AI Escalation Pack Builder (maintainer-only pilot)
// Calls our Supabase Edge Function (never the AI directly).
// ============================================================
var escCaseEvidence = {};
var escLastFilename = 'OSI_escalation_pack.txt';

function escStatus(msg, cls){
  var el = document.getElementById('esc-status');
  if(!el) return;
  el.textContent = msg;
  el.className = 'esc-status' + (cls ? ' ' + cls : '');
}
function escSetOutput(text){
  var wrap = document.getElementById('esc-out-wrap');
  var out = document.getElementById('esc-out');
  if(out) out.value = text || '';
  if(wrap) wrap.style.display = text ? 'block' : 'none';
}
async function escLoadCases(){
  var sel = document.getElementById('esc-case');
  if(!sel) return;
  if(!resolveMaintainerAccess().allowed){ escStatus(maintainerAccessMessage(resolveMaintainerAccess()), 'warn'); return; }
  if(typeof SUPA_ON === 'undefined' || !SUPA_ON){ escStatus('Supabase is not configured.', 'warn'); return; }
  escStatus('Loading reviewed cases\u2026', 'busy');
  try{
    var rows = await supaGet('reports?approved=eq.true&select=id,company,summary,onchain,offchain,tx,wallet&order=id.desc&limit=200');
    escCaseEvidence = {};
    sel.innerHTML = '<option value="">Select a reviewed case\u2026</option>';
    (rows || []).forEach(function(r){
      escCaseEvidence[r.id] = { subject:r.company||'', summary:r.summary||'', onchain:r.onchain||'', offchain:r.offchain||'', tx:r.tx||'', wallet:r.wallet||'' };
      var o = document.createElement('option');
      o.value = r.id;
      var label = (r.company || r.summary || r.id || 'case');
      o.textContent = String(label).slice(0, 70);
      sel.appendChild(o);
    });
    escStatus((rows && rows.length) ? (rows.length + ' reviewed case(s) loaded.') : 'No reviewed cases yet.', (rows && rows.length) ? 'ok' : 'warn');
  }catch(e){
    escStatus('Could not load cases. Are you signed in as a maintainer?', 'warn');
  }
}
// ============================================================
// Stage 3: secure AI Pack access helpers
//  - proof: wallet signature, purpose "OSI AI Pack Access v1" (cached 90s)
//  - public_meta: metadata-only list for Public Records (never content)
//  - get/download: full pack content ONLY for a maintainer (JWT) or a
//    server-verified analyst, via the osi-ai-pack Edge Function. Anon and
//    ordinary connected wallets get metadata only (RLS no longer exposes it).
// ============================================================
async function osiAiPackProof(){
  if(window.__osiAiPackProof && window.__osiAiPackProof.proof && window.__osiAiPackProof.proof.wallet===walletPubkey && (Date.now()-window.__osiAiPackProof.at < 90000)){
    return window.__osiAiPackProof.proof;
  }
  var prov = (typeof getConnectedProvider==='function') ? getConnectedProvider() : (typeof getProvider==='function'?getProvider():null);
  if(!walletPubkey || !prov){
    if(typeof toggleWallet==='function'){ try{ await toggleWallet(); }catch(e){} }
    prov = (typeof getConnectedProvider==='function') ? getConnectedProvider() : (typeof getProvider==='function'?getProvider():null);
  }
  if(!walletPubkey || !prov){ var e0=new Error('no_wallet'); e0.status=401; throw e0; }
  if(typeof prov.signMessage !== 'function'){ var e1=new Error('This wallet cannot sign messages.'); e1.status=400; throw e1; }
  var msg = 'OSI AI Pack Access v1\nwallet: '+walletPubkey+'\nissued: '+Date.now()+'\nnonce: '+(Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2));
  var res = await prov.signMessage(new TextEncoder().encode(msg), 'utf8');
  var sigBytes = (res && res.signature) ? res.signature : res;
  var proof = { wallet: walletPubkey, message: msg, signature: osiB64(sigBytes) };
  window.__osiAiPackProof = { at: Date.now(), proof: proof };
  return proof;
}
// Metadata only (case_ref, pack_type, status). Safe for the public "reviewed
// pack" indicator; carries no pack content.
async function osiAiPackPublicMeta(){
  var url = SUPABASE_URL + '/functions/v1/osi-ai-pack';
  var headers = { 'Content-Type':'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization':'Bearer '+SUPABASE_ANON_KEY };
  var res = await fetch(url, { method:'POST', headers: headers, body: JSON.stringify({ mode:'public_meta' }) });
  if(!res.ok){ var er=new Error('meta_'+res.status); er.status=res.status; throw er; }
  var data = await res.json();
  return (data && data.packs) ? data.packs : [];
}
// Full pack content for AUTHORIZED callers only. Maintainers authenticate with
// their Supabase session JWT; everyone else signs a wallet proof (the server
// admits ONLY a verified analyst; a wallet merely appearing on a report does
// not qualify). Returns the JSON body or throws an Error whose .status carries
// the HTTP code.
async function osiAiPackGet(caseRef, packType){
  var url = SUPABASE_URL + '/functions/v1/osi-ai-pack';
  var maint = (typeof resolveMaintainerAccess==='function') ? resolveMaintainerAccess().allowed : false;
  var headers = { 'Content-Type':'application/json', 'apikey': SUPABASE_ANON_KEY };
  var payload = { mode:'get', case_ref: caseRef };
  if(packType) payload.pack_type = packType;
  if(maint && SUPA_AUTH_TOKEN){
    headers['Authorization'] = 'Bearer ' + SUPA_AUTH_TOKEN;
  } else {
    headers['Authorization'] = 'Bearer ' + SUPABASE_ANON_KEY;
    var proof = await osiAiPackProof();
    payload.wallet = proof.wallet; payload.message = proof.message; payload.signature = proof.signature;
  }
  var res = await fetch(url, { method:'POST', headers: headers, body: JSON.stringify(payload) });
  if(!res.ok){ var er=new Error('pack_'+res.status); er.status=res.status; throw er; }
  return await res.json();
}
// Download flow for Public Records + profile. Content is fetched on demand and
// never cached in the DOM; unauthorized callers get a friendly message.
async function osiAiPackDownload(caseRef, packType){
  try{
    var data = await osiAiPackGet(caseRef, packType);
    if(!data || !data.ok || !data.content){ if(typeof showToast==='function') showToast('This pack is not available.'); return; }
    var blob = new Blob([data.content], { type:'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = 'OSI_' + (packType||'pack') + '_' + caseRef + '.txt';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }catch(e){
    var st = e && e.status;
    var msg = (st===403 || st===401) ? 'Available to verified analysts and maintainers.'
      : (st===404) ? 'No reviewed pack is available for this case.'
      : 'Could not retrieve the pack right now.';
    if(typeof showToast==='function') showToast(msg); else if(typeof alert==='function') alert(msg);
  }
}
async function escGenerate(){
  if(!requireMaintainerAccess('Generate escalation pack')){ escStatus(maintainerAccessMessage(resolveMaintainerAccess()), 'warn'); return; }
  var sel = document.getElementById('esc-case');
  var caseRef = sel ? sel.value : '';
  var typeEl = document.querySelector('input[name="esc-type"]:checked');
  var pt = typeEl ? typeEl.value : '';
  if(!caseRef){ escStatus('Pick a reviewed case (Load, then select).', 'warn'); return; }
  if(!pt){ escStatus('Choose a pack type.', 'warn'); return; }
  var btn = document.querySelector('.esc-go');
  if(btn) btn.disabled = true;
  escStatus('Generating with Claude, this can take 10-30s\u2026', 'busy');
  escSetOutput('');
  try{
    // Evidence is fetched server-side from the reviewed case; the client never
    // supplies or trusts pack evidence. Maintainers authenticate with the
    // Supabase session JWT.
    var res = await fetch(SUPABASE_URL + '/functions/v1/osi-ai-pack', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'apikey':SUPABASE_ANON_KEY, 'Authorization':'Bearer ' + SUPA_AUTH_TOKEN },
      body: JSON.stringify({ mode:'generate', case_ref:caseRef, pack_type:pt })
    });
    if(res.status === 404){ escStatus('Backend not deployed yet. Deploy the Edge Function (see setup notes).', 'warn'); if(btn) btn.disabled=false; return; }
    if(res.status === 401 || res.status === 403){ escStatus('Not authorized. Sign in as a maintainer and retry.', 'warn'); if(btn) btn.disabled=false; return; }
    if(res.status === 429){ escStatus('Generation rate limit reached. Try again shortly.', 'warn'); if(btn) btn.disabled=false; return; }
    var data = null; try{ data = await res.json(); }catch(_e){}
    if(!res.ok || !data || !data.ok){
      var emsg = (data && data.error === 'not_reviewed') ? 'This case is not reviewed/approved yet.'
        : (data && data.error === 'refused') ? 'The model declined to produce this pack.'
        : (data && data.error) ? String(data.error) : ('Generation failed (' + res.status + ').');
      escStatus(emsg, 'warn'); if(btn) btn.disabled=false; return;
    }
    escSetOutput(data.content || '');
    var badge = document.getElementById('esc-badge');
    if(badge) badge.textContent = ((data.status || 'review_required') === 'review_required') ? 'ai_generated \u00b7 review_required' : ('ai_generated \u00b7 ' + data.status);
    escStatus('Done. Review required before use.', 'ok');
    escLastFilename = 'OSI_' + pt + '_' + (caseRef || 'case') + '.txt';
    if(typeof escRenderPackControls==='function') escRenderPackControls({ id: data.id, status: data.status || 'review_required', pack_type: pt });
  }catch(e){
    escStatus('Could not reach the backend. Is the Edge Function deployed?', 'warn');
  }
  if(btn) btn.disabled = false;
}
function escCopy(){
  var out = document.getElementById('esc-out'); if(!out || !out.value) return;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(out.value).then(function(){ escStatus('Copied to clipboard.', 'ok'); }, function(){ out.select(); });
  } else { out.select(); try{ document.execCommand('copy'); escStatus('Copied.', 'ok'); }catch(_e){} }
}
function escDownload(){
  var out = document.getElementById('esc-out'); if(!out || !out.value) return;
  var blob = new Blob([out.value], { type:'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = escLastFilename || 'OSI_escalation_pack.txt';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}


// ============================================================
// AI packs as persistent CASE ARTIFACTS
//  - load saved packs for a case (fixes "disappears on refresh")
//  - maintainer: mark a pack reviewed (publish) and seal a case
//  - Public Case Records archive + profile "My case records"
// ============================================================
var escCurrentPacks = [];

function escPackLabel(t){ return t==='victim' ? 'Victim brief' : (t==='exchange' ? 'Exchange pack' : (t==='law_enforcement' ? 'Law-enforcement brief' : String(t||'Pack'))); }
function escStatusLabel(s){ return s==='approved' ? 'reviewed' : (s==='discarded' ? 'discarded' : 'review required'); }

// Load any saved packs for a case and show the most recent one.
async function escLoadPacksForCase(caseRef){
  escCurrentPacks = [];
  var host = document.getElementById('esc-pack-controls'); if(host) host.innerHTML='';
  if(!caseRef){ return; }
  if(!resolveMaintainerAccess().allowed){ escSetOutput(''); escStatus(maintainerAccessMessage(resolveMaintainerAccess()), 'warn'); return; }
  if(typeof SUPA_ON === 'undefined' || !SUPA_ON){ return; }
  try{
    var rows = await supaGet('escalation_packs?case_ref=eq.' + encodeURIComponent(caseRef) + '&select=id,pack_type,content,status,created_at&order=created_at.desc');
    escCurrentPacks = rows || [];
    if(escCurrentPacks.length){
      var p = escCurrentPacks[0];
      escSetOutput(p.content || '');
      var badge = document.getElementById('esc-badge'); if(badge) badge.textContent = 'ai_generated \u00b7 ' + escStatusLabel(p.status);
      escRenderPackControls(p);
      escStatus('Loaded a saved ' + escPackLabel(p.pack_type) + ' (' + escStatusLabel(p.status) + ').', 'ok');
    } else {
      escStatus('No saved pack for this case yet.', '');
    }
  }catch(e){ /* anon only sees approved; maintainer sees all */ }
}

// Maintainer-only controls shown under a pack: mark reviewed (publish) / seal case.
function escRenderPackControls(p){
  var host = document.getElementById('esc-pack-controls'); if(!host) return;
  if(!p || !resolveMaintainerAccess().allowed){ host.innerHTML=''; return; }
  var approved = (p.status === 'approved');
  host.innerHTML =
    (approved
      ? '<span class="esc-okline">\u2713 Reviewed \u00b7 eligible for Public Case Records</span>'
      : '<button class="esc-mini ok" type="button" onclick="escApprovePack(\'' + p.id + '\')">Mark reviewed (publish pack)</button>')
    + '<button class="esc-mini" type="button" onclick="escSealCase()">Seal this case</button>';
}

async function escApprovePack(packId){
  if(!requireMaintainerAccess('Approve escalation pack')){ escStatus(maintainerAccessMessage(resolveMaintainerAccess()), 'warn'); return; }
  var _packCaseRef = (typeof escCurrentPacks!=='undefined' && escCurrentPacks) ? ((escCurrentPacks.find(function(p){ return String(p.id)===String(packId); })||{}).case_ref||'') : '';
  osiSignEvent({ eventType:'ESCALATION_PACK_APPROVED', actionLabel:'Approve escalation pack', reportId:_packCaseRef, itemType:'report', itemId: packId, sensitive:true, onSuccess: async (sig)=>{
  try{
    await supaPatch('escalation_packs?id=eq.' + encodeURIComponent(packId), { status:'approved' });
    escStatus('Pack marked reviewed. It can now appear in Public Case Records.', 'ok');
    var sel = document.getElementById('esc-case'); if(sel) await escLoadPacksForCase(sel.value);
    if(typeof renderCaseRecords === 'function') renderCaseRecords();
  }catch(e){ escStatus('Could not update the pack. Check you are signed in as a maintainer.', 'warn'); }
  }});
}

async function escSealCase(){
  if(!requireMaintainerAccess('Seal case')){ escStatus(maintainerAccessMessage(resolveMaintainerAccess()), 'warn'); return; }
  var sel = document.getElementById('esc-case'); var caseRef = sel ? sel.value : '';
  if(!caseRef){ escStatus('Pick a case first.', 'warn'); return; }
  osiSignEvent({ eventType:'RECORD_SEALED', actionLabel:'Seal case', reportId: caseRef, itemType:'report', itemId: caseRef, publicLabel:'Record sealed', onSuccess: async (sig)=>{
  try{
    await supaPatch('reports?id=eq.' + encodeURIComponent(caseRef), { sealed:true });
    escStatus('Case sealed. It now shows as Sealed in Public Case Records.', 'ok');
    if(typeof renderCaseRecords === 'function') renderCaseRecords();
  }catch(e){ escStatus('Could not seal the case. Check you are signed in as a maintainer.', 'warn'); }
  }});
}
