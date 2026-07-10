

// ===== Maintainer button: visible only to the configured maintainer wallet =====
function updateAdminButton(){
  const btn=document.getElementById('admLockBtn'); if(!btn) return;
  const access = (typeof resolveMaintainerAccess === 'function') ? resolveMaintainerAccess() : { isMaintainerWallet:false };
  const show = !!access.isMaintainerWallet;
  btn.style.display = show ? '' : 'none';
}
function admUseConnectedAdmin(){
  if(!walletPubkey){ showToast("Connect your wallet first (top right), then click this again."); return; }
  const el=document.getElementById('admAdminW'); if(el) el.value=walletPubkey;
}
async function admSaveAdminWallet(){
  if(!requireMaintainerAccess('Save maintainer wallet')) return;
  const v=(document.getElementById('admAdminW').value||'').trim();
  const msg=document.getElementById('admAdminMsg');
  if(v && !isSolAddr(v)){ if(msg){ msg.style.color='var(--red)'; msg.textContent="That is not a valid Solana address."; } return; }
  osiSignEvent({ eventType:'CONFIG_CHANGED', actionLabel:'Save maintainer wallet', itemType:'config', itemId:'admin_wallet', sensitive:true, onSuccess: async (sig)=>{
  if(msg){ msg.style.color='var(--ink-dim)'; msg.textContent='Saving\u2026'; }
  try{
    await supaUpsertConfig('admin_wallet', v);
    OSI_ADMIN_WALLET = isSolAddr(v) ? v : '';
    updateAdminButton();
    if(msg){ msg.style.color='var(--sol)'; msg.textContent = OSI_ADMIN_WALLET ? ('\u2713 Saved. The maintainer button now appears only when '+short(OSI_ADMIN_WALLET)+' is connected.') : '\u2713 Cleared. The button stays visible until you set a wallet.'; }
  }catch(e){ if(msg){ msg.style.color='var(--red)'; msg.textContent='Save failed: '+((e&&e.message)||e); } }
  }});
}

// ===== Admin: edit a bounty (target, brief, reward, logo) =====
function admEditBounty(id){
  if(!requireMaintainerAccess('Edit case')) return;
  const b = (window.__admBounties||[]).find(function(x){ return String(x.id)===String(id); });
  if(!b){ showToast('Bounty not found, hit Refresh and try again.'); return; }
  document.getElementById('aeb-id').value = b.id;
  document.getElementById('aeb-target').value = b.target || b.title || '';
  document.getElementById('aeb-detail').value = b.detail || '';
  document.getElementById('aeb-reward').value = (b.reward_sol!=null ? b.reward_sol : '');
  document.getElementById('aeb-image').value = b.image || '';
  clearPickedFile('aeb');
  const prev=document.getElementById('aeb-file-prev'); if(prev){ const _ai=safeUrl(b.image); prev.innerHTML = _ai ? '<img src="'+escapeHtml(_ai)+'" alt="">' : ''; }
  const msg=document.getElementById('aeb-msg'); if(msg) msg.textContent='';
  document.getElementById('adm-edit-modal').classList.add('open');
}
function admCloseEdit(){ const m=document.getElementById('adm-edit-modal'); if(m) m.classList.remove('open'); }
async function admSaveBounty(){
  if(!requireMaintainerAccess('Save case')) return;
  const id = document.getElementById('aeb-id').value;
  const target = (document.getElementById('aeb-target').value||'').trim();
  const detail = (document.getElementById('aeb-detail').value||'').trim();
  let reward = parseFloat((document.getElementById('aeb-reward').value||'').trim()); if(isNaN(reward) || reward<0) reward=0; if(reward>2) reward=2;
  let image = (document.getElementById('aeb-image').value||'').trim();
  const msg = document.getElementById('aeb-msg');
  if(!target){ if(msg){ msg.style.color='var(--red)'; msg.textContent='Target cannot be empty.'; } return; }
  osiSignEvent({ eventType:'CASE_EDITED', actionLabel:'Save case', caseId: id, itemType:'bounty', itemId: id, sensitive:true, onSuccess: async (sig)=>{
  if(msg){ msg.style.color='var(--ink-dim)'; msg.textContent='Saving\u2026'; }
  try{
    try{ const up = await uploadPicked('aeb'); if(up) image = up; }catch(e){ if(msg) msg.textContent='Logo upload failed, saving the rest\u2026'; }
    await supaPatch('bounties?id=eq.'+encodeURIComponent(id), { target:target, title:target, detail:detail, reward_sol:reward, image:(image||null) });
    if(msg){ msg.style.color='var(--sol)'; msg.textContent='\u2713 Saved.'; }
    admCloseEdit(); admRefresh(); admReflow();
  }catch(e){ if(msg){ msg.style.color='var(--red)'; msg.textContent='Save failed: '+((e&&e.message)||e); } }
  }});
}

// ===== Support / payout wallet (maintainer-set, stored globally in Supabase) =====
let OSI_SUPPORT_WALLET = '';
let OSI_ADMIN_WALLET = '';
function isSolAddr(a){ a = String(a || '').trim(); return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a); }

async function loadConfig(){
  if(!SUPA_ON) return;
  try{
    const rows = await supaGet('osi_config?key=in.(support_wallet,admin_wallet,consensus_threshold,consensus_auto)&select=key,value');
    (rows||[]).forEach(function(r){
      if(r.key==='support_wallet' && r.value && isSolAddr(r.value)) OSI_SUPPORT_WALLET = String(r.value).trim();
      if(r.key==='admin_wallet'   && r.value && isSolAddr(r.value)) OSI_ADMIN_WALLET   = String(r.value).trim();
      if(r.key==='consensus_threshold' && r.value) CONSENSUS_THRESHOLD = parseInt(r.value,10)||3;
      if(r.key==='consensus_auto') CONSENSUS_AUTO = (r.value==='on');
    });
  }catch(e){ /* no config yet */ }
}
async function supaUpsertConfig(key, value){
  const r = await fetch(SUPABASE_URL + '/rest/v1/osi_config', {
    method:'POST',
    headers: supaHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ key: key, value: value, updated_at: new Date().toISOString() })
  });
  if(!r.ok && r.status !== 409) throw new Error('config save ' + r.status);
  return true;
}
function admUseConnected(){
  if(!walletPubkey){ showToast("Connect your wallet first (top right), then click this again."); return; }
  const el = document.getElementById('admSupport'); if(el) el.value = walletPubkey;
}
async function admSaveSupport(){
  if(!requireMaintainerAccess('Save support wallet')) return;
  const v = (document.getElementById('admSupport').value || '').trim();
  const msg = document.getElementById('admCfgMsg');
  if(v && !isSolAddr(v)){ if(msg){ msg.style.color='var(--red)'; msg.textContent = "That does not look like a valid Solana address."; } return; }
  osiSignEvent({ eventType:'CONFIG_CHANGED', actionLabel:'Save support wallet', itemType:'config', itemId:'support_wallet', sensitive:true, onSuccess: async (sig)=>{
  if(msg){ msg.style.color='var(--ink-dim)'; msg.textContent = 'Saving…'; }
  try{
    await supaUpsertConfig('support_wallet', v);
    OSI_SUPPORT_WALLET = isSolAddr(v) ? v : '';
    if(msg){ msg.style.color='var(--sol)'; msg.textContent = OSI_SUPPORT_WALLET ? ('\u2713 Saved. Flagship reports now accept support to ' + short(OSI_SUPPORT_WALLET) + '.') : '\u2713 Cleared. Support buttons are now hidden.'; }
    try{ renderCaseStudies(); }catch(e){}
    try{ renderWire(); }catch(e){}
  }catch(e){ if(msg){ msg.style.color='var(--red)'; msg.textContent = 'Save failed: ' + ((e && e.message) || e); } }
  }});
}