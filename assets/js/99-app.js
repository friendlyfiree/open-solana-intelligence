// OSI boot sequence. Moved verbatim from the application monolith so that
// every domain file is loaded before these startup calls run. Do not add
// feature logic here.


// Phantom trusted reconnect is safe to attempt on every load because
// onlyIfTrusted never opens an approval prompt or exposes signing material.
window.addEventListener('load', function(){
  wireContactLinks();
  // The extension can still be injecting at load. Waiting for the provider
  // keeps the disconnect/accountChanged listeners and the silent restore
  // attached to the wallet the visitor actually has.
  function attachProvider(prov){
    if(prov && prov.on){
      prov.on('disconnect', function(){ walletPubkey = null; if(typeof clearWalletAuthorization==='function') clearWalletAuthorization({reason:'disconnect'}); clearWalletCache(); if(typeof closeWalletMenu==='function') closeWalletMenu(); updateWalletUI(); });
      prov.on('accountChanged', function(pk){
        if(typeof clearWalletAuthorization==='function') clearWalletAuthorization({reason:'account_changed'});
        if(pk){ walletPubkey = pk.toString(); } else { walletPubkey = null; clearWalletCache(); }
        if(typeof window.osiV2ReadSessionHandleWallet==='function')window.osiV2ReadSessionHandleWallet(walletPubkey||'');
        updateWalletUI();
        if(walletPubkey&&typeof window.osiResumeWalletIntent==='function')window.osiResumeWalletIntent();
      });
    }
    // A rejected/revoked trust check leaves the UI honestly disconnected.
    if(prov && sessionRestoreWanted()){
      prov.connect({ onlyIfTrusted:true }).then(function(resp){
        var restored = (resp && resp.publicKey) || prov.publicKey;
        if(restored){ walletPubkey = restored.toString(); try{ localStorage.setItem('osi_phantom_restore','1'); }catch(e){} if(typeof window.osiV2ReadSessionHandleWallet==='function')window.osiV2ReadSessionHandleWallet(walletPubkey); clearWalletAuthorization({preserveReadSession:true,reason:'trusted_restore'}); updateWalletUI(); if(typeof window.osiResumeWalletIntent==='function')window.osiResumeWalletIntent(); }
      }).catch(function(){ /* not trusted or revoked: stay disconnected, user connects manually */ }).finally(function(){if(typeof markWalletReady==='function')markWalletReady();});
    }else if(typeof markWalletReady==='function')markWalletReady();
  }
  if(typeof waitForProvider==='function') waitForProvider().then(attachProvider);
  else attachProvider(getProvider());
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
