/* Exact, dependency-free Solana Pay transfer-request builder for native V2 SOL. */
(function(root){
  'use strict';

  var WALLET=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  var NONCE=/^[A-Za-z0-9_-]{32,128}$/;
  var PUBLIC_REF=/^OSI-[A-Z0-9-]{6,56}$/;
  var AMOUNT=/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/;

  function text(value){return typeof value==='string'?value.trim():'';}
  function requireMatch(value,pattern,name){
    var clean=text(value);
    if(!pattern.test(clean))throw new TypeError(name+' is invalid');
    return clean;
  }
  function normalize(prepared){
    if(!prepared||typeof prepared!=='object'||prepared.network!=='mainnet-beta'){
      throw new TypeError('Solana Pay intent is invalid');
    }
    var pay=prepared.solana_pay;
    var recipients=prepared.recipient_manifest;
    if(!pay||pay.enabled!==true||!Array.isArray(recipients)||recipients.length!==1){
      throw new TypeError('Solana Pay requires one bound recipient');
    }
    var recipient=recipients[0];
    var amount=requireMatch(String(recipient.amount_sol||''),AMOUNT,'amount');
    if(amount==='0'||/^0\.0*$/.test(amount))throw new TypeError('amount is invalid');
    return {
      recipient:requireMatch(recipient.wallet,WALLET,'recipient'),
      amount:amount,
      reference:requireMatch(pay.reference,WALLET,'reference'),
      memo:text(prepared.memo),
      nonce:requireMatch(prepared.nonce,NONCE,'nonce'),
      target:requireMatch(prepared.target_public_ref,PUBLIC_REF,'target'),
      expiresAt:text(pay.expires_at||prepared.expires_at)
    };
  }
  function buildUrl(prepared){
    var exact=normalize(prepared);
    if(!exact.memo||exact.memo.length>700)throw new TypeError('memo is invalid');
    var params=new URLSearchParams();
    params.set('amount',exact.amount);
    params.set('reference',exact.reference);
    params.set('label','Open Solana Intelligence');
    params.set('message','Direct native SOL payment for '+exact.target+'. Verify every field before approving.');
    params.set('memo',exact.memo);
    return 'solana:'+exact.recipient+'?'+params.toString();
  }
  function renderQr(host,url){
    if(!host||typeof root.qrcode!=='function')throw new Error('QR renderer is unavailable');
    var qr=root.qrcode(0,'M');
    qr.addData(String(url),'Byte');
    qr.make();
    host.innerHTML=qr.createSvgTag({
      scalable:true,
      margin:4,
      title:'Solana Pay transfer request',
      alt:'Scan to review the exact native SOL transfer in a compatible wallet'
    });
    return host.querySelector('svg');
  }
  function mobileDevice(){
    return /Android|iPhone|iPad|iPod|Mobile/i.test(String(root.navigator&&root.navigator.userAgent||''));
  }

  root.osiSolanaPay=Object.freeze({
    buildUrl:buildUrl,
    normalize:normalize,
    renderQr:renderQr,
    isMobileDevice:mobileDevice
  });
})(window);
