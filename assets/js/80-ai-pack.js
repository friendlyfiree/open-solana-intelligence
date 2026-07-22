// Legacy AI Pack compatibility UI. Native generation, approval, and sealing
// stay fail-closed until the accepted V2 AI Pack lifecycle and Stage-5 writes
// are implemented. Approved legacy content remains available to authorized
// analysts/full maintainers through the shared read-only session.
var escLastFilename = 'OSI_escalation_pack.txt';
var escCurrentPacks = [];

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
function escPackUnavailable(){
  escStatus('Native AI Pack generation is not enabled. Existing reviewed packs remain read-only.', 'warn');
}

async function escLoadCases(){
  var sel = document.getElementById('esc-case');
  if(sel) sel.innerHTML = '<option value="">Native AI Pack generation unavailable</option>';
  escPackUnavailable();
}

// Metadata only (case_ref, pack_type, status). Public responses never contain
// generated content or restricted evidence.
async function osiAiPackPublicMeta(){
  var url = SUPABASE_URL + '/functions/v1/osi-ai-pack';
  var headers = { 'Content-Type':'application/json', 'apikey':SUPABASE_ANON_KEY, 'Authorization':'Bearer '+SUPABASE_ANON_KEY };
  var res = await fetch(url, { method:'POST', headers:headers, body:JSON.stringify({ mode:'public_meta' }) });
  if(!res.ok){ var er=new Error('meta_'+res.status); er.status=res.status; throw er; }
  var data = await res.json();
  return (data && data.packs) ? data.packs : [];
}

// Full approved/attested legacy content uses the same durable, origin-bound,
// read-only capability as the native review queues. The server rechecks role.
async function osiAiPackGet(caseRef, packType){
  if(typeof osiV2ReadSession!=='function'){ var e0=new Error('read_session_unavailable'); e0.status=503; throw e0; }
  var session = await osiV2ReadSession(['report:review']);
  var payload = { mode:'get', case_ref:caseRef, wallet:session.wallet, read_session:session.token };
  if(packType) payload.pack_type = packType;
  var headers = {
    'Content-Type':'application/json',
    'apikey':SUPABASE_ANON_KEY,
    'Authorization':'Bearer '+(SUPA_AUTH_TOKEN || SUPABASE_ANON_KEY)
  };
  var res = await fetch(SUPABASE_URL + '/functions/v1/osi-ai-pack', {
    method:'POST', headers:headers, body:JSON.stringify(payload)
  });
  if(!res.ok){ var er=new Error('pack_'+res.status); er.status=res.status; throw er; }
  return await res.json();
}

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
    var msg = (st===403 || st===401) ? 'Available to verified analysts and full maintainers.'
      : (st===404) ? 'No reviewed pack is available for this case.'
      : 'Could not retrieve the pack right now.';
    if(typeof showToast==='function') showToast(msg); else if(typeof alert==='function') alert(msg);
  }
}

async function escGenerate(){ escPackUnavailable(); }

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

function escPackLabel(t){ return t==='victim' ? 'Victim brief' : (t==='exchange' ? 'Exchange pack' : (t==='law_enforcement' ? 'Law-enforcement brief' : String(t||'Pack'))); }

async function escLoadPacksForCase(caseRef){
  escCurrentPacks = [];
  var host = document.getElementById('esc-pack-controls'); if(host) host.innerHTML='';
  if(!caseRef){ return; }
  try{
    var data = await osiAiPackGet(caseRef);
    var pack = data && data.ok ? data : null;
    if(!pack){ escStatus('No reviewed pack for this case.', ''); return; }
    escCurrentPacks = [pack];
    escSetOutput(pack.content || '');
    var badge = document.getElementById('esc-badge'); if(badge) badge.textContent = 'ai_generated \u00b7 reviewed';
    escRenderPackControls(pack);
    escStatus('Loaded a reviewed ' + escPackLabel(pack.pack_type) + ' in read-only mode.', 'ok');
  }catch(e){
    escSetOutput('');
    escStatus((e && (e.status===401 || e.status===403)) ? 'Verified analyst or full maintainer access required.' : 'No reviewed pack is available.', 'warn');
  }
}

function escRenderPackControls(p){
  var host = document.getElementById('esc-pack-controls'); if(!host) return;
  host.innerHTML = p ? '<span class="esc-okline">Reviewed legacy pack \u00b7 read-only compatibility</span>' : '';
}
async function escApprovePack(packId){ void packId; escPackUnavailable(); }
async function escSealCase(){ escStatus('Legacy case sealing is disabled. Use the native resolution lifecycle.', 'warn'); }
