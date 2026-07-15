/* Shared short-lived Phantom authorization for READ-ONLY private views. */
(function(root,factory){
  var api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.OSIReadSessionCore=api;
})(typeof window!=='undefined'?window:null,function(){
  'use strict';
  var TOKEN_KEY='osi_v2_read_session_v1';
  var EXPIRED_KEY='osi_v2_read_session_expired_v1';

  function error(code){var value=new Error(code);value.code=code;return value;}
  function normalizeScopes(scopes){return Array.from(new Set((scopes||[]).map(String))).sort();}
  function decodePayload(token){
    try{
      var part=String(token||'').split('.')[1];
      var base64=part.replace(/-/g,'+').replace(/_/g,'/');
      base64+='='.repeat((4-base64.length%4)%4);
      return JSON.parse(decodeURIComponent(Array.prototype.map.call(atob(base64),function(char){return'%'+char.charCodeAt(0).toString(16).padStart(2,'0');}).join('')));
    }catch(_){return null;}
  }
  function createWalletApprovalBroker(){
    var messages=new Map(),transactions=new Map();
    function once(store,key,runner){
      key=String(key||'');if(!key)throw error('approval_key_required');
      if(store.has(key))return store.get(key);
      var pending=Promise.resolve().then(runner);store.set(key,pending);
      return pending.finally(function(){if(store.get(key)===pending)store.delete(key);});
    }
    return{
      message:function(key,runner){return once(messages,'message:'+key,runner);},
      transaction:function(key,runner){return once(transactions,'transaction:'+key,runner);},
      clear:function(){messages.clear();transactions.clear();}
    };
  }
  function createReadSessionClient(options){
    var storage=options.storage,origin=String(options.origin||''),unlockPromise=null,expiryTimer=null;
    var cacheClearers=new Map();
    function nowSeconds(){return Math.floor((options.now?options.now():Date.now())/1000);}
    function readRaw(){try{return JSON.parse(storage.getItem(TOKEN_KEY)||'null');}catch(_){return null;}}
    function clearTimer(){if(expiryTimer){(options.clearTimeout||clearTimeout)(expiryTimer);expiryTimer=null;}}
    function dispatch(reason){if(typeof options.onClear==='function')options.onClear(reason);cacheClearers.forEach(function(fn){try{fn(reason);}catch(_){}});}
    function clear(reason,settings){
      settings=settings||{};clearTimer();unlockPromise=null;
      try{storage.removeItem(TOKEN_KEY);if(settings.markExpired)storage.setItem(EXPIRED_KEY,'1');else storage.removeItem(EXPIRED_KEY);}catch(_){ }
      dispatch(reason||'cleared');
    }
    function schedule(payload){
      clearTimer();var delay=Math.max(0,(Number(payload.exp)-nowSeconds())*1000);
      expiryTimer=(options.setTimeout||setTimeout)(function(){clear('expiry',{markExpired:true});},delay);
    }
    function usableRecord(wallet,scopes){
      var record=readRaw(),payload=record&&decodePayload(record.token),required=normalizeScopes(scopes);
      if(!record||!payload)return null;
      if(payload.aud!==origin||payload.sub!==wallet){clear(payload.sub!==wallet?'wallet_mismatch':'origin_mismatch');return null;}
      if(!Number.isSafeInteger(payload.exp)||payload.exp<=nowSeconds()){clear('expiry',{markExpired:true});return null;}
      if(!Array.isArray(payload.scp)||required.some(function(scope){return payload.scp.indexOf(scope)<0;}))return null;
      schedule(payload);return{token:record.token,wallet:wallet,payload:payload};
    }
    async function unlock(scopes,settings){
      settings=settings||{};
      var wallet=String(await options.ensureWallet()||'');if(!wallet)throw error('wallet_not_connected');
      var cached=usableRecord(wallet,scopes);if(cached)return cached;
      var expired=false;try{expired=storage.getItem(EXPIRED_KEY)==='1';}catch(_){ }
      if(expired&&!settings.explicitRefresh)throw error('read_session_expired');
      if(settings.allowUnlock===false)throw error('read_session_required');
      if(unlockPromise){
        var shared=await unlockPromise;
        var sharedScopes=shared.payload&&shared.payload.scp||[];
        if(normalizeScopes(scopes).some(function(scope){return sharedScopes.indexOf(scope)<0;}))throw error('read_session_wrong_scope');
        return shared;
      }
      unlockPromise=(async function(){
        try{storage.removeItem(EXPIRED_KEY);}catch(_){ }
        var issued=await options.request({op:'issue_read_session_challenge',wallet:wallet});
        var signature=await options.signMessage(issued.challenge);
        var created=await options.request({op:'create_read_session',wallet:wallet,challenge:issued.challenge,signature:signature});
        if(!created||!created.read_session)throw error('read_session_unavailable');
        var payload=decodePayload(created.read_session);
        if(!payload||payload.sub!==wallet||payload.aud!==origin)throw error('read_session_tampered');
        try{storage.setItem(TOKEN_KEY,JSON.stringify({token:created.read_session}));}catch(_){throw error('read_session_storage_unavailable');}
        schedule(payload);
        return{token:created.read_session,wallet:wallet,payload:payload};
      })();
      try{return await unlockPromise;}finally{unlockPromise=null;}
    }
    function handleWallet(wallet){
      var record=readRaw(),payload=record&&decodePayload(record.token);if(payload&&payload.sub!==String(wallet||''))clear('wallet_mismatch');
    }
    function handleAuth(authSubject){
      var record=readRaw(),payload=record&&decodePayload(record.token);if(!payload)return;
      var expected=payload.auth_sub||null,current=authSubject||null;if(expected!==current)clear('auth_changed');
    }
    function registerCache(name,clearer){if(name&&typeof clearer==='function')cacheClearers.set(String(name),clearer);}
    var initial=readRaw(),initialPayload=initial&&decodePayload(initial.token);if(initialPayload){if(initialPayload.exp>nowSeconds())schedule(initialPayload);else clear('expiry',{markExpired:true});}
    return{get:unlock,clear:clear,handleWallet:handleWallet,handleAuth:handleAuth,registerCache:registerCache,decodePayload:decodePayload};
  }
  return{createReadSessionClient:createReadSessionClient,createWalletApprovalBroker:createWalletApprovalBroker,decodePayload:decodePayload,TOKEN_KEY:TOKEN_KEY,EXPIRED_KEY:EXPIRED_KEY};
});

(function(){
  'use strict';
  if(typeof window==='undefined'||!window.OSIReadSessionCore)return;
  var READ_URL=SUPABASE_URL+'/functions/v1/osi-v2-case-read';
  function bytesToBase64(bytes){var binary='';for(var i=0;i<bytes.length;i++)binary+=String.fromCharCode(bytes[i]);return btoa(binary);}
  async function request(body){
    var response=await fetch(READ_URL,{method:'POST',headers:supaHeaders(),body:JSON.stringify(body)}),payload={};
    try{payload=await response.json();}catch(_){payload={ok:false,error:'invalid_server_response'};}
    if(!response.ok||payload.ok!==true)throw new Error(payload.error||('request_failed_'+response.status));
    return payload;
  }
  async function ensureWallet(){
    if(window.OSI_WALLET_READY)await window.OSI_WALLET_READY;
    if(!walletPubkey&&typeof toggleWallet==='function')await toggleWallet();
    return walletPubkey||'';
  }
  async function signMessage(message){
    var provider=typeof getProvider==='function'?getProvider():null;
    if(!provider||typeof provider.signMessage!=='function')throw new Error('wallet_sign_message_unavailable');
    var signed=await provider.signMessage(new TextEncoder().encode(message),'utf8');
    var bytes=signed&&signed.signature?signed.signature:signed;if(!(bytes instanceof Uint8Array))bytes=new Uint8Array(bytes||[]);
    return bytesToBase64(bytes);
  }
  var client=window.OSIReadSessionCore.createReadSessionClient({
    storage:sessionStorage,origin:window.location.origin,request:request,signMessage:signMessage,ensureWallet:ensureWallet,
    onClear:function(reason){try{window.dispatchEvent(new CustomEvent('osi:read-session-cleared',{detail:{reason:reason}}));}catch(_){}}
  });
  var approvals=window.OSIReadSessionCore.createWalletApprovalBroker();
  window.OSI_READ_SESSION_TTL_SECONDS=300;
  window.osiV2ReadSession=function(scopes,settings){return client.get(scopes,settings||{});};
  window.osiV2RefreshReadSession=function(scopes){client.clear('explicit_refresh');return client.get(scopes,{allowUnlock:true,explicitRefresh:true});};
  window.osiV2ClearReadSession=function(reason){client.clear(reason||'explicit_logout');};
  window.osiV2ReadSessionHandleWallet=client.handleWallet;
  window.osiV2ReadSessionHandleAuth=client.handleAuth;
  window.osiV2RegisterPrivateCache=client.registerCache;
  window.osiV2ApproveMessage=function(message){
    return approvals.message(message,async function(){
      var provider=typeof getProvider==='function'?getProvider():null;
      if(!provider||typeof provider.signMessage!=='function')throw new Error('wallet_sign_message_unavailable');
      var signed=await provider.signMessage(new TextEncoder().encode(message),'utf8');
      var bytes=signed&&signed.signature?signed.signature:signed;if(!(bytes instanceof Uint8Array))bytes=new Uint8Array(bytes||[]);
      return bytesToBase64(bytes);
    });
  };
  window.osiV2ApproveTransaction=function(key,submitter){return approvals.transaction(key,submitter);};
  window.addEventListener('osi:read-session-cleared',function(){approvals.clear();});
})();
