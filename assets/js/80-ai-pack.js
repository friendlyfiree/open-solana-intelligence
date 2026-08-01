// Legacy AI Pack read-only compatibility. Approved legacy content remains
// available to authorized analysts/full maintainers through the shared
// read-only session; native generation lives in v2-ai-pack-integration.js.

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

function escPackLabel(t){ return t==='victim' ? 'Victim brief' : (t==='exchange' ? 'Exchange pack' : (t==='law_enforcement' ? 'Law-enforcement brief' : String(t||'Pack'))); }
