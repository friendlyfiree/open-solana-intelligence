/* Public SAS review-authority badges and wallet verifier. Presentation only. */
(function(){
  'use strict';

  var WALLET_RE=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  var cache=Object.create(null);
  var pending=Object.create(null);
  var scanQueued=false;

  function walletValue(value){
    value=String(value||'').trim();
    return WALLET_RE.test(value)?value:'';
  }
  function isPositive(result){
    return !!(result&&result.ok===true&&result.valid===true&&String(result.state)==='verified');
  }
  function provider(){
    if(typeof window.osiPublicApi!=='function')throw new Error('sas_verifier_unavailable');
    return window.osiPublicApi;
  }
  function verifyWallet(value,options){
    var wallet=walletValue(value),refresh=!!(options&&options.refresh);
    if(!wallet)return Promise.reject(new Error('invalid_wallet'));
    if(!refresh&&cache[wallet])return Promise.resolve(cache[wallet]);
    if(pending[wallet])return pending[wallet];
    var request;
    try{request=provider()('osi-v2-proof',{mode:'sas_verify',wallet:wallet});}
    catch(error){return Promise.reject(error);}
    pending[wallet]=Promise.resolve(request).then(function(result){
      delete pending[wallet];
      if(!result||result.ok!==true)throw new Error('sas_verifier_unavailable');
      cache[wallet]=result;
      return result;
    },function(error){delete pending[wallet];throw error;});
    return pending[wallet];
  }
  function clearNode(node){
    if(!node)return;
    if(typeof node.replaceChildren==='function')node.replaceChildren();
    else node.textContent='';
  }
  function setStatus(node,text,kind){
    if(!node)return;
    node.textContent=text||'';
    node.className='osi-form-status mono '+(kind||'');
  }
  function openExplanation(value){
    var wallet=walletValue(value);
    if(typeof window.osiNavigate==='function')window.osiNavigate('methodology');
    else if(typeof window.showView==='function')window.showView('methodology');
    setTimeout(function(){
      var section=document.getElementById('sas-verifier');
      var input=document.getElementById('sas-verifier-wallet');
      if(input&&wallet)input.value=wallet;
      if(section&&typeof section.scrollIntoView==='function')section.scrollIntoView({block:'start'});
      if(input&&typeof input.focus==='function')input.focus();
      if(wallet)verifyPublicWallet(wallet);
    },40);
  }
  function badgeFor(slot,result){
    clearNode(slot);
    if(slot&&typeof slot.removeAttribute==='function')slot.removeAttribute('aria-busy');
    if(!isPositive(result))return null;
    var doc=slot.ownerDocument||document;
    var badge=doc.createElement('a');
    badge.className='osi-proof-label';
    badge.href='#sas-verifier';
    badge.textContent='\u00a0Verified \u00b7 Solana Attestation Service';
    badge.setAttribute('data-sas-badge','verified');
    badge.setAttribute('aria-label','Verified analyst authority. Read the Solana Attestation Service explanation.');
    badge.addEventListener('click',function(event){
      event.preventDefault();
      event.stopPropagation();
      openExplanation(slot.getAttribute('data-sas-wallet'));
    });
    slot.appendChild(badge);
    return badge;
  }
  function decorateSlot(slot){
    var wallet=walletValue(slot&&slot.getAttribute('data-sas-wallet'));
    if(!slot||!wallet){clearNode(slot);return Promise.resolve(null);}
    slot.setAttribute('aria-busy','true');
    return verifyWallet(wallet).then(function(result){return badgeFor(slot,result);},function(){return badgeFor(slot,null);});
  }
  function decorateAll(root){
    root=root||document;
    var slots=root.querySelectorAll?root.querySelectorAll('[data-sas-wallet]'):[];
    Array.prototype.forEach.call(slots,function(slot){
      if(slot.getAttribute('data-sas-bound')==='true')return;
      slot.setAttribute('data-sas-bound','true');
      decorateSlot(slot);
    });
    return slots.length||0;
  }
  function explorerLink(doc,label,address){
    address=walletValue(address);
    if(!address)return null;
    var link=doc.createElement('a');
    link.className='osi-button osi-button-secondary';
    link.href='https://explorer.solana.com/address/'+encodeURIComponent(address);
    link.target='_blank';
    link.rel='noopener noreferrer';
    link.textContent=label;
    return link;
  }
  function paragraph(doc,text){
    var node=doc.createElement('p');
    node.textContent=text;
    return node;
  }
  function presentResult(result,nodes){
    var status=nodes.status,resultHost=nodes.result;
    var doc=resultHost.ownerDocument||document;
    clearNode(resultHost);
    resultHost.hidden=false;
    if(isPositive(result)){
      setStatus(status,'Verified: current OSI_VERIFIED_ANALYST credential.','success');
      resultHost.appendChild(paragraph(doc,'This wallet has current OSI review authority under the configured SAS credential, schema, and issuer. This does not prove identity, endorsement, truth, or review correctness.'));
    }else{
      setStatus(status,'Not verified. No current OSI_VERIFIED_ANALYST credential was returned for this wallet.','');
      resultHost.appendChild(paragraph(doc,'No badge is shown. State: '+String(result&&result.state||'unavailable')+'. Reason: '+String(result&&result.reason||'not returned')+'.'));
    }
    var links=doc.createElement('div');
    links.className='osi-about-actions';
    var credential=explorerLink(doc,'Credential on Solana Explorer',result&&result.credential);
    var schema=explorerLink(doc,'Schema on Solana Explorer',result&&result.schema);
    if(credential)links.appendChild(credential);
    if(schema)links.appendChild(schema);
    if(links.children&&links.children.length)resultHost.appendChild(links);
    var checked=result&&result.checked_at?String(result.checked_at):'not supplied';
    resultHost.appendChild(paragraph(doc,'Verifier source: '+String(result&&result.source||'unavailable')+'. Checked: '+checked+'.'));
    return isPositive(result);
  }
  function verifierNodes(nodes){
    nodes=nodes||{};
    return{
      input:nodes.input||document.getElementById('sas-verifier-wallet'),
      status:nodes.status||document.getElementById('sas-verifier-status'),
      result:nodes.result||document.getElementById('sas-verifier-result')
    };
  }
  function verifyPublicWallet(value,nodes){
    nodes=verifierNodes(nodes);
    var wallet=walletValue(value||(nodes.input&&nodes.input.value));
    if(!wallet){
      setStatus(nodes.status,'Enter a valid Solana wallet address.','error');
      clearNode(nodes.result);
      if(nodes.result)nodes.result.hidden=true;
      return Promise.resolve(null);
    }
    if(nodes.input)nodes.input.value=wallet;
    setStatus(nodes.status,'Checking the public SAS verifier...','');
    clearNode(nodes.result);
    if(nodes.result)nodes.result.hidden=true;
    return verifyWallet(wallet,{refresh:true}).then(function(result){
      presentResult(result,nodes);
      return result;
    },function(){
      setStatus(nodes.status,'Verification is temporarily unavailable. No verified badge is shown.','error');
      if(nodes.result){nodes.result.hidden=false;nodes.result.appendChild(paragraph(nodes.result.ownerDocument||document,'The verifier did not return an authoritative answer. Try again later.'))}
      return null;
    });
  }
  function scheduleScan(){
    if(scanQueued)return;
    scanQueued=true;
    Promise.resolve().then(function(){scanQueued=false;decorateAll(document);});
  }
  function init(){
    var form=document.getElementById('sas-verifier-form');
    if(form)form.addEventListener('submit',function(event){event.preventDefault();verifyPublicWallet();});
    decorateAll(document);
    if(typeof MutationObserver==='function')new MutationObserver(scheduleScan).observe(document.body,{childList:true,subtree:true});
  }

  window.osiSasVerification={
    isPositive:isPositive,
    verifyWallet:verifyWallet,
    decorateSlot:decorateSlot,
    decorateAll:decorateAll,
    verifyPublicWallet:verifyPublicWallet,
    openExplanation:openExplanation
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);
  else init();
})();
