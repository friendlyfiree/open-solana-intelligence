/* Public SAS review-authority badges and wallet verifier. Presentation only. */
(function(){
  'use strict';

  var WALLET_RE=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  var cache=Object.create(null);
  var pending=Object.create(null);
  var scanQueued=false;

  function tr(key,variables){
    var source=String(key||'');
    if(typeof window.osiT==='function')return window.osiT(source,variables);
    if(!variables)return source;
    return source.replace(/\{([a-zA-Z0-9_]+)\}/g,function(_,name){
      return Object.prototype.hasOwnProperty.call(variables,name)?String(variables[name]):'{'+name+'}';
    });
  }
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
    node.textContent=tr(text||'');
    node.className='osi-form-status '+(kind||'');
  }
  // Server codes are shown as reviewed words; an unknown code is shown as is
  // rather than guessed at.
  // The credential's states are named for what they say about the credential.
  // "Verified" is also an analyst tier, so the credential never borrows it.
  var STATE_TEXT={verified:'Current',invalid:'Invalid',expired:'Expired',revoked:'Revoked',unavailable:'Unavailable',pending_verification:'Check pending'};
  var REASON_TEXT={valid:'Current credential',absent:'No credential exists for this wallet',expired:'The credential has expired',revoked:'The credential was revoked'};
  var SOURCE_TEXT={live:'Live Solana read',cache:'Recent cached read',cached:'Recent cached read'};
  function stateText(value){value=String(value||'unavailable');return STATE_TEXT[value]?tr(STATE_TEXT[value]):value;}
  function reasonText(value){value=String(value||'');return REASON_TEXT[value]?tr(REASON_TEXT[value]):(value||tr('Not returned'));}
  function sourceText(value){value=String(value||'');return SOURCE_TEXT[value]?tr(SOURCE_TEXT[value]):(value||tr('Unavailable'));}
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
  // When the badge's own read happened. A check from today reads as a time,
  // an older cached read as a date, and both say "checked" so neither looks
  // like the credential's issue date.
  function checkedShort(result){
    var value=result&&result.checked_at?new Date(result.checked_at):null;
    if(!value||isNaN(value.getTime()))return tr('time unavailable');
    var locale=window.OSI_I18N&&typeof window.OSI_I18N.getLocale==='function'&&window.OSI_I18N.getLocale()==='tr'?'tr-TR':'en-US';
    try{
      var today=new Date().toISOString().slice(0,10)===value.toISOString().slice(0,10);
      return today
        ?value.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'UTC'})+' UTC'
        :value.toLocaleDateString(locale,{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
    }catch(_){return value.toISOString().slice(0,10);}
  }
  // One timestamp style across the product: short date, 24-hour time, UTC.
  function checkedText(result){
    var value=result&&result.checked_at?new Date(result.checked_at):null;
    if(!value||isNaN(value.getTime()))return tr('time unavailable');
    var locale=window.OSI_I18N&&typeof window.OSI_I18N.getLocale==='function'&&window.OSI_I18N.getLocale()==='tr'?'tr-TR':'en-US';
    try{
      return value.toLocaleDateString(locale,{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'})+' '
        +value.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'UTC'})+' UTC';
    }catch(_){return value.toISOString().slice(0,16).replace('T',' ')+' UTC';}
  }
  function badgeFor(slot,result,overrideState){
    clearNode(slot);
    if(slot&&typeof slot.removeAttribute==='function')slot.removeAttribute('aria-busy');
    var doc=slot.ownerDocument||document;
    var state=overrideState||String(result&&result.state||'unavailable');
    var badge;
    if(isPositive(result)&&!overrideState){
      badge=doc.createElement('a');
      badge.className='osi-proof-label';
      badge.href='#sas-verifier';
      // The badge carries its own padding now, so the old leading space that
      // separated a bare inline label from the wallet beside it would only
      // push the text off centre inside the chip.
      // It names what the credential is, on-chain review authority, and never
      // says "verified": that word is an analyst tier, and a probationary
      // analyst holds this same credential. The attribute value stays the
      // verifier's state code so styling and tests keep one meaning.
      badge.textContent=tr('SAS review authority · checked {checked}',{checked:checkedShort(result)});
      badge.setAttribute('data-sas-badge','verified');
      badge.setAttribute('aria-label',tr('Current on-chain SAS review authority. Last checked {checked}. This is separate from the analyst tier. Read the Solana Attestation Service explanation.',{checked:checkedText(result)}));
      badge.addEventListener('click',function(event){
        event.preventDefault();
        event.stopPropagation();
        openExplanation(slot.getAttribute('data-sas-wallet'));
      });
    }else if(state==='checking'){
      // The badge's own read is still in flight. That is not a credential
      // state, so it stays neutral instead of borrowing the warning tone a
      // genuinely pending or failed credential uses.
      badge=doc.createElement('span');
      badge.className='osi-chip';
      badge.setAttribute('data-sas-badge','checking');
      badge.setAttribute('aria-busy','true');
      badge.textContent=tr('Checking SAS credential');
    }else{
      badge=doc.createElement('span');
      badge.className='osi-chip warning';
      badge.setAttribute('data-sas-badge',state);
      if(state==='pending_verification')badge.textContent=tr('SAS check pending');
      else if(state==='expired')badge.textContent=tr('SAS expired')+' \u00b7 '+checkedText(result);
      else if(state==='revoked')badge.textContent=tr('SAS revoked')+' \u00b7 '+checkedText(result);
      else if(state==='invalid')badge.textContent=tr('No current SAS review authority')+' \u00b7 '+checkedText(result);
      // A failed client read says nothing about counting: the server's own
      // authority record decides that. Only the live check is unavailable.
      else{badge.className='osi-chip';badge.textContent=tr('Live SAS check unavailable');}
      badge.setAttribute('aria-label',badge.textContent);
    }
    slot.appendChild(badge);
    return badge;
  }
  function decorateSlot(slot){
    var wallet=walletValue(slot&&slot.getAttribute('data-sas-wallet'));
    if(!slot||!wallet){clearNode(slot);return Promise.resolve(null);}
    slot.setAttribute('aria-busy','true');
    badgeFor(slot,null,'checking');
    slot.setAttribute('aria-busy','true');
    return verifyWallet(wallet).then(function(result){return badgeFor(slot,result);},function(){return badgeFor(slot,null,'unavailable');});
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
    link.textContent=tr(label);
    return link;
  }
  function paragraph(doc,text,variables){
    var node=doc.createElement('p');
    node.textContent=tr(text,variables);
    return node;
  }
  function presentResult(result,nodes){
    var status=nodes.status,resultHost=nodes.result;
    var doc=resultHost.ownerDocument||document;
    clearNode(resultHost);
    resultHost.hidden=false;
    if(isPositive(result)){
      setStatus(status,'Current SAS review authority: this wallet holds a valid OSI_VERIFIED_ANALYST credential.','success');
      resultHost.appendChild(paragraph(doc,'This wallet has current OSI review authority under the configured SAS credential, schema, and issuer. This does not prove identity, endorsement, truth, or review correctness.'));
    }else{
      setStatus(status,'No current SAS review authority. No valid OSI_VERIFIED_ANALYST credential was returned for this wallet.','');
      resultHost.appendChild(paragraph(doc,'No badge is shown. State: {state}. Reason: {reason}.',{
        state:stateText(result&&result.state),
        reason:reasonText(result&&result.reason)
      }));
    }
    var links=doc.createElement('div');
    links.className='osi-about-actions';
    var credential=explorerLink(doc,'Credential on Solana Explorer',result&&result.credential);
    var schema=explorerLink(doc,'Schema on Solana Explorer',result&&result.schema);
    if(credential)links.appendChild(credential);
    if(schema)links.appendChild(schema);
    if(links.children&&links.children.length)resultHost.appendChild(links);
    var checked=result&&result.checked_at?checkedText(result):tr('not supplied');
    resultHost.appendChild(paragraph(doc,'Verifier source: {source}. Checked: {checked}.',{
      source:sourceText(result&&result.source),
      checked:checked
    }));
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
    var raw=String(value||(nodes.input&&nodes.input.value)||'').trim();
    var wallet=walletValue(raw);
    if(!raw){
      setStatus(nodes.status,'Paste a Solana wallet address to check.','error');
      if(nodes.input&&nodes.input.setAttribute)nodes.input.setAttribute('aria-invalid','true');
      clearNode(nodes.result);
      if(nodes.result)nodes.result.hidden=true;
      return Promise.resolve(null);
    }
    if(!wallet){
      if(nodes.input&&nodes.input.setAttribute)nodes.input.setAttribute('aria-invalid','true');
      setStatus(nodes.status,'Enter a valid Solana wallet address.','error');
      clearNode(nodes.result);
      if(nodes.result)nodes.result.hidden=true;
      return Promise.resolve(null);
    }
    if(nodes.input)nodes.input.value=wallet;
    if(nodes.input&&nodes.input.removeAttribute)nodes.input.removeAttribute('aria-invalid');
    setStatus(nodes.status,'Checking the public SAS verifier...','');
    clearNode(nodes.result);
    if(nodes.result)nodes.result.hidden=true;
    return verifyWallet(wallet,{refresh:true}).then(function(result){
      presentResult(result,nodes);
      return result;
    },function(){
      setStatus(nodes.status,'The verifier is temporarily unavailable. No review authority badge is shown.','error');
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
    // A verified answer belongs to exactly one pasted wallet. As soon as the
    // field changes, the previous answer stops being true for what is on
    // screen, so it is cleared instead of left standing next to a new address.
    var walletInput=document.getElementById('sas-verifier-wallet');
    if(walletInput)walletInput.addEventListener('input',function(){
      var nodes=verifierNodes();
      setStatus(nodes.status,'','');
      clearNode(nodes.result);
      if(nodes.result)nodes.result.hidden=true;
    });
    decorateAll(document);
    if(typeof window.addEventListener==='function')window.addEventListener('osi:localechange',function(){
      var slots=document.querySelectorAll?document.querySelectorAll('[data-sas-wallet]'):[];
      Array.prototype.forEach.call(slots,function(slot){decorateSlot(slot);});
    });
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
