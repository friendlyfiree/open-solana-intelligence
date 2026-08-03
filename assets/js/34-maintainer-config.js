// Maintainer visibility and read-only legacy configuration.
function updateAdminButton(){
  const btn=document.getElementById('admLockBtn'); if(!btn) return;
  const access = (typeof resolveMaintainerAccess === 'function') ? resolveMaintainerAccess() : { isMaintainerWallet:false };
  const show = !!access.isMaintainerWallet;
  btn.style.display = show ? '' : 'none';
}

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
