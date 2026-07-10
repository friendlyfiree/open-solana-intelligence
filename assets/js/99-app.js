// OSI boot sequence. Moved verbatim from the application monolith so that
// every domain file is loaded before these startup calls run. Do not add
// feature logic here.


// Uniswap/PancakeSwap-style wallet: silent restore on refresh ONLY within the same browser session.
window.addEventListener('load', function(){
  wireContactLinks();
  var prov = getProvider();
  if(prov && prov.on){
    prov.on('disconnect', function(){ walletPubkey = null; clearWalletCache(); if(typeof closeWalletMenu==='function') closeWalletMenu(); updateWalletUI(); });
    prov.on('accountChanged', function(pk){
      if(pk){ walletPubkey = pk.toString(); } else { walletPubkey = null; clearWalletCache(); }
      updateWalletUI();
    });
  }
  // Silent restore only if the user connected earlier in this session; new browser session = manual connect.
  if(prov && sessionRestoreWanted()){
    prov.connect({ onlyIfTrusted:true }).then(function(resp){
      if(resp && resp.publicKey){ walletPubkey = resp.publicKey.toString(); updateWalletUI(); }
    }).catch(function(){ /* not trusted or revoked: stay disconnected, user connects manually */ });
  }
  document.addEventListener('click', function(e){
    var inside = e.target && e.target.closest && e.target.closest('.wb-wrap');
    if(!inside && typeof closeWalletMenu==='function') closeWalletMenu();
  });
});

renderCaseStudies();
if(typeof renderCaseRecords==='function') renderCaseRecords();
syncTabCounts();
renderRequests();
renderReviewQueue();
restoreBountyState();
renderFieldOffice();
renderWire();
loadConfig().then(function(){ try{ renderCaseStudies(); }catch(e){} try{ renderWire(); }catch(e){} try{ updateAdminButton(); }catch(e){} });
loadAnalysts().then(function(){ try{ renderAnalysts(); }catch(e){} try{ renderReviewFloor(); }catch(e){} });
window.addEventListener('hashchange', function(){ if(typeof updateAdminButton==='function') updateAdminButton(); });
renderTicker();
renderActivity();
loadPrice();
