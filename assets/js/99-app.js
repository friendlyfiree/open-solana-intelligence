// OSI boot sequence. Moved verbatim from the application monolith so that
// every domain file is loaded before these startup calls run. Do not add
// feature logic here.


// Restore a previously explicit OSI connection without opening a prompt.
// Connection and per-action signature approval remain separate states.
window.addEventListener('load', function(){
  wireContactLinks();
  var prov = getProvider();
  if(prov && prov.on){
    prov.on('disconnect', function(){ walletPubkey = null; if(typeof clearWalletAuthorization==='function') clearWalletAuthorization({reason:'disconnect'}); clearWalletCache(); if(typeof closeWalletMenu==='function') closeWalletMenu(); updateWalletUI(); });
    prov.on('accountChanged', function(pk){
      // A provider can emit its retained account during page startup. That is
      // not an explicit OSI connection action and must not opt the UI in.
      if(pk && !walletPubkey) return;
      if(typeof clearWalletAuthorization==='function') clearWalletAuthorization({reason:'account_changed'});
      if(pk){ walletPubkey = pk.toString(); } else { walletPubkey = null; clearWalletCache(); }
      if(typeof window.osiV2ReadSessionHandleWallet==='function')window.osiV2ReadSessionHandleWallet(walletPubkey||'');
      updateWalletUI();
    });
  }
  if(prov && sessionRestoreWanted()){
    prov.connect({ onlyIfTrusted:true }).then(function(resp){
      if(resp && resp.publicKey){ walletPubkey = resp.publicKey.toString(); if(typeof window.osiV2ReadSessionHandleWallet==='function')window.osiV2ReadSessionHandleWallet(walletPubkey); clearWalletAuthorization({preserveReadSession:true,reason:'trusted_restore'}); updateWalletUI(); }
    }).catch(function(){ /* not trusted or revoked: stay disconnected, user connects manually */ }).finally(function(){if(typeof markWalletReady==='function')markWalletReady();});
  }else if(typeof markWalletReady==='function')markWalletReady();
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
