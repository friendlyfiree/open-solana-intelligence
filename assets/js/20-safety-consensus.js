

// ===== Local Safety Gate (client-side, no API/AI/backend) =====
// A guardrail that blocks obviously risky USER content before it is signed
// on-chain or written to Supabase. It is bypassable by design (client-side),
// so the real protection stays the maintainer-approval step + RLS. This only
// stops accidental/casual risky content from ever reaching the queue.
// NOTE: tx signatures and private keys are both ~88-char base58 and cannot be
// told apart by length, so private keys are matched by keyword + byte-array
// format only, never by base58 length. That keeps tx hashes (allowed) safe.
var SAFETY_PROFANITY = /\b(f+u+c+k+(?:ing|er|ers|ed|s)?|motherf\w+|c+u+n+t+s?|n[i1]gg(?:er|a|ers|as)|f[a4]gg?(?:ot|ots)?|f[a4]gs?|spics?|kikes?|wetbacks?|trann(?:y|ies)|retard(?:ed|s)?)\b/i;

// --- the scanner: returns {blocked, reasons[]} ; tuned to avoid blocking legit on-chain evidence
function osiSafetyScan(text, kind){
  var reasons = [];
  if(!text) return { blocked:false, reasons:reasons };
  var t = String(text);
  var low = t.toLowerCase();
  function add(r){ if(reasons.indexOf(r) < 0) reasons.push(r); }

  // 1) seed / recovery phrase: keyword, OR a clean maximal run of an exact BIP39 length
  var seedHit = /\b(seed|recovery|mnemonic)\s*(phrase|words?)\b/i.test(t) || /\bseed\s*:/i.test(t);
  if(!seedHit){
    var STOP = {the:1,and:1,but:1,for:1,with:1,that:1,this:1,your:1,you:1,are:1,was:1,her:1,his:1,its:1,our:1,their:1,from:1,have:1,has:1,had:1,not:1,all:1,any:1,can:1,will:1,out:1,who:1,how:1,why:1,what:1,when:1,where:1,been:1,were:1,they:1,them:1,then:1,than:1,into:1,over:1,just:1,like:1,some:1,more:1,also:1,only:1,sent:1,went:1,here:1,came:1,used:1,both:1,each:1,very:1,much:1,many:1,most:1,wallet:1,funds:1,money:1,token:1,tokens:1,coins:1,scam:1,scammer:1,hack:1,hacked:1,stole:1,stolen:1,drained:1,sol:1,usdc:1,address:1,wallets:1};
    var ow = t.split(/\s+/), run = [];
    for(var i=0;i<=ow.length;i++){
      var w = ow[i] || '';
      if(/^[a-z]{3,8}$/.test(w)){ run.push(w); }
      else {
        if([12,15,18,21,24].indexOf(run.length) >= 0){
          var sN=0, uq={}; for(var j=0;j<run.length;j++){ if(STOP[run[j]]) sN++; uq[run[j]]=1; }
          if(sN<=1 && Object.keys(uq).length===run.length){ seedHit = true; break; }
        }
        run = [];
      }
    }
  }
  if(seedHit) add('a seed or recovery phrase');

  // 2) private key: keyword, byte-array, or long hex ONLY. Never base58 length (tx sigs share it).
  if(/\b(private|secret)\s*key\b/i.test(t)) add('a private key');
  else if(/\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){47,}\s*\]/.test(t)) add('a private key (keypair array)');
  else if(/\b[0-9a-fA-F]{64,}\b/.test(t)) add('a private key (hex)');

  // application is just a contact handle + a public link, so only the catastrophic checks apply
  if(kind === 'application') return { blocked:reasons.length>0, reasons:reasons };

  // 3) email
  if(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i.test(t)) add('an email address');

  // 4) phone: formatted or +country only (bare digit runs are amounts/slots, allowed)
  if(/\+\d[\d\s().\-]{7,}\d/.test(t) || /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/.test(t)) add('a phone number');

  // 5) personal identity / home address (doxxing)
  if(/\b(real name is|their name is|his name is|her name is|full name is|lives at|home address|residing at|home is at)\b/i.test(low)) add('a personal identity or home address');
  else if(/\b\d{1,5}\s+(?:[a-z0-9.]+\s){1,4}(street|avenue|boulevard|apartment|suite)\b/i.test(low)) add('a home address');

  // 6) threats
  if(/\b(i\s*will\s*kill|i'?ll\s*kill|kill\s*you|you\s*are\s*dead|you'?re\s*dead|i\s*will\s*find\s*you|i'?ll\s*find\s*you|watch\s*your\s*back|i\s*know\s*where\s*you\s*live|hunt\s*you\s*down|burn\s*your)\b/i.test(low)) add('a threat');

  // 7) spam: too many links, or a long repeated-character run
  var links = (t.match(/https?:\/\//gi) || []).length;
  if(links > 6) add('too many links (spam)');
  else if(/(.)\1{14,}/.test(t)) add('repeated-character spam');

  // 8) heavy profanity / slurs (the maintainer asked for a clean, professional record)
  if(SAFETY_PROFANITY.test(low)) add('heavy profanity or a slur');

  return { blocked:reasons.length>0, reasons:reasons };
}

// gather the relevant field text per submission kind
function osiScanFor(kind){
  function v(id){ var e=document.getElementById(id); return e ? String(e.value||'') : ''; }
  if(kind === 'case')        return v('bf-target') + '\n' + v('bf-detail');
  if(kind === 'report')      return v('apply-report');
  if(kind === 'intel')       return v('wire-subject-in') + '\n' + v('wire-body-in');
  if(kind === 'application') return v('an-tg') + '\n' + v('an-web');
  return '';
}


function safetyGate(text){
  var t = String(text || '');
  var low = t.toLowerCase();
  var hits = [];
  function add(l){ if(hits.indexOf(l) === -1) hits.push(l); }

  // seed / recovery phrase (protects the user from doxxing themselves)
  if(/\b(seed phrase|recovery phrase|secret recovery phrase|mnemonic phrase|mnemonic|seed words?)\b/i.test(t)) add('a seed or recovery phrase');
  var run = low.match(/\b[a-z]{3,8}(?:\s+[a-z]{3,8}){11,23}\b/);
  if(run){
    var ws = run[0].split(/\s+/);
    var STOP = /^(the|and|for|you|your|was|were|are|this|that|with|but|not|they|them|then|now|gone|sent|send|lost|funds|fund|wallet|money|scam|scammed|stole|stolen|drain|drained|please|help|someone|somebody|anybody|nothing|hacked|hack|hacker|address|account|transaction|transfer|swap|swapped|staked|stake|claimed|signed|approve|approved|phantom|solana|ethereum|bitcoin|usdc|usdt|dollars|amount|balance|from|have|has|had|will|been|into|onto|over|back|just|like|when|what|where|which|there|their|would|could|should|because|after|before|while|through|around|between|here|told|said|asked|paid|using|used|received|missing|moving|moved|tracing|traced|going|doing|trying|really|started|looking|getting|coins|token|tokens|exchange|binance|coinbase|thanks|thank)$/;
    var nar = 0; for(var i=0;i<ws.length;i++){ if(STOP.test(ws[i])) nar++; }
    if(nar === 0) add('a seed or recovery phrase');
  }

  // private key (keyword + exported byte-array; NOT base58 length, see note above)
  if(/\b(private key|secret key|priv\s*key|privkey|keypair|secret phrase)\b/i.test(t)) add('a private key');
  if(/\[\s*\d{1,3}\s*(?:,\s*\d{1,3}\s*){47,}\]/.test(t)) add('a private key');

  // email
  if(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/.test(t)) add('an email address');

  // phone (needs grouping or country code, so amounts/hashes do not trip it)
  if(/(?:\+\d{1,3}[\s.\-]?)?(?:\(\d{3}\)|\d{3})[\s.\-]\d{3}[\s.\-]\d{4}\b/.test(t) || /\+\d{1,3}[\s.\-]?\d{9,12}\b/.test(t)) add('a phone number');

  // physical address / government ID
  if(/\b\d{1,5}\s+(?:[A-Za-z0-9.]+\s+){1,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|place|pl|way|highway|hwy|apt|suite|ste)\b/i.test(t)) add('a home address');
  if(/\b\d{3}\-\d{2}\-\d{4}\b/.test(t)) add('a personal ID number');

  // private message / DM content
  if(/(?:\b(?:the|our|my|his|her|their)\s+dms?\b|\bin\s+(?:the\s+|our\s+|his\s+|her\s+|their\s+)?dms?\b|\bprivate\s+(?:message|chat|conversation|dm)s?\b|\bscreenshot\s+of\b[\s\S]{0,40}?\b(?:dm|chat|conversation|messages?|texts?)\b|\b(?:he|she|they|we)\s+(?:dm(?:ed|d)?|messaged|texted|pm(?:ed|d)?)\s+me\b|\b(?:dm(?:ed|d)?|messaged|texted)\s+me\s+(?:saying|that|this)\b|\bover\s+(?:dm|whatsapp|telegram|signal|imessage)\b)/i.test(t)) add('private message content');

  // threats (first-person)
  if(/\b(?:i(?:'?| a)m going to|i will|i'?ll|im gonna|i'?m gonna|we will|we'?ll|im going to)\b[^.!?\n]{0,40}\b(?:kill|hurt|harm|find you|come for you|come to your|beat you|destroy you|end you|make you pay|expose you|burn|stab|shoot|murder)\b/i.test(t)) add('a threat');

  // direct accusation / name-calling at a person (the event itself is fine; naming a person a "thief" is not)
  if(/\b(?:you(?:'?| a)re|he'?s|she'?s|they'?re|is|are)\s+(?:a |an |the )?(?:thief|thieves|scammer|scammers|fraudster|fraud|criminal|crook|liar|con\s?artist|pedophile|paedophile|terrorist|rapist)\b/i.test(t)) add('a direct accusation or name-calling');

  // spam / excessive links
  var urls = (t.match(/https?:\/\/[^\s]+/gi) || []);
  if(urls.length > 5) add('too many links (spam)');
  var seen = {}, rep = false;
  for(var u=0; u<urls.length; u++){ var k = urls[u].toLowerCase(); seen[k] = (seen[k]||0)+1; if(seen[k] >= 3) rep = true; }
  if(rep) add('repeated links (spam)');
  if(/\b(?:free (?:crypto|sol|airdrop|nft|tokens?)|claim your (?:free|reward|airdrop)|connect your wallet to (?:claim|receive)|guaranteed (?:profit|returns|gains)|double your (?:sol|crypto|money)|click here to (?:win|claim))\b/i.test(t)) add('spam content');

  // heavy profanity / slur
  if(SAFETY_PROFANITY.test(t)) add('heavy profanity or a slur');

  return { ok: hits.length === 0, hits: hits };
}

function osiBlockShow(hits){
  var lst = document.getElementById('osi-block-list');
  if(lst){ lst.innerHTML = (hits && hits.length) ? ('<div class="ob-det">Detected in your text: ' + hits.join(', ') + '. Please remove it and try again.</div>') : ''; }
  var m = document.getElementById('osi-block'); if(m){ m.style.display = ''; m.hidden = false; }
}
function osiBlockClose(){ var m = document.getElementById('osi-block'); if(m){ m.hidden = true; m.style.display = 'none'; } }
// ===== CONSENSUS (analyst peer-review / progressive decentralization) =====
let CONSENSUS_THRESHOLD = 4;   // weight needed to publish; the same weight of rejections closes an item
let CONSENSUS_AUTO = true;     // analysts hold near-seal power: consensus publishes without waiting for the maintainer
window.ANALYST_WEIGHT = window.ANALYST_WEIGHT || {};
window.VOUCHES = window.VOUCHES || {};
// ---- vote power ladder (capped, earned by REP tier):
//   Tier I Apprentice \u00d71 \u00b7 Tier II Investigator \u00d72 \u00b7 Tier III Detective \u00d73 \u00b7 Tier IV Chief \u00d74
function analystWeight(wallet){ const w = window.ANALYST_WEIGHT[String(wallet)]; return Math.max(0, Math.min(4, (w==null?0:Number(w)))); }
function vouchKey(type,id){ return type+'|'+id; }
async function loadVouches(){
  if(!SUPA_ON) return;
  try{
    const rows = await supaGet('vouches?select=item_type,item_id,analyst,vote') || [];
    const map={};
    rows.forEach(function(v){
      const k=vouchKey(v.item_type, v.item_id);
      if(!map[k]) map[k]={approve:[],reject:[]};
      map[k][v.vote==='reject'?'reject':'approve'].push(String(v.analyst));
    });
    window.VOUCHES = map;
  }catch(e){ /* table may not exist yet */ }
}
function vouchTally(type,id){
  const v = window.VOUCHES[vouchKey(type,id)] || {approve:[],reject:[]};
  let aw=0, rw=0;
  v.approve.forEach(function(w){ aw += analystWeight(w); });
  v.reject.forEach(function(w){ rw += analystWeight(w); });
  return { approve:v.approve, reject:v.reject, aw:aw, rw:rw };
}
function myVouch(type,id){
  if(!walletPubkey) return null;
  const v = window.VOUCHES[vouchKey(type,id)] || {approve:[],reject:[]};
  if(v.approve.indexOf(walletPubkey)!==-1) return 'approve';
  if(v.reject.indexOf(walletPubkey)!==-1) return 'reject';
  return null;
}
// author head start: an analyst author's own standing pre-fills the bar,
// but at least ONE independent vote is always required (no single voice decides).
function vouchAuthorW(type,row){
  if(type==='challenge' || !row) return 0;
  var creator = row.created_by || row.wallet || '';
  return analystWeight(creator);
}
function vouchThreshold(type,id,row){
  if(type==='challenge') return CONSENSUS_THRESHOLD;
  return Math.max(1, CONSENSUS_THRESHOLD - vouchAuthorW(type,row));
}
// first weight to reach its line locks the item; a locked item takes no more votes
function vouchDecision(type,id,row){
  if(row && row.review_status==='rejected') return 'rejected';
  if(row && row.status==='upheld') return 'published';
  if(row && row.status==='dismissed') return 'rejected';
  if(row && row.approved===true && type!=='challenge') return 'published';
  const t = vouchTally(type,id);
  const thr = vouchThreshold(type,id,row);
  if(t.aw>=thr && t.aw>=t.rw) return 'published';
  if(t.rw>=CONSENSUS_THRESHOLD) return 'rejected';
  return null;
}
function consensusMeter(type,id,row){
  const t = vouchTally(type,id);
  const dec = vouchDecision(type,id,row);
  const thr = vouchThreshold(type,id,row);
  const aW  = vouchAuthorW(type,row);
  const ap = Math.min(100, Math.round(t.aw / Math.max(1,thr) * 100));
  const rp = Math.min(100, Math.round(t.rw / Math.max(1,CONSENSUS_THRESHOLD) * 100));
  const isCh = (type==='challenge');
  let status;
  if(dec==='published') status = '<span class="cm-lock ok">'+(isCh?'\u2713 challenge upheld \u00b7 record returns to review':'\u2713 consensus reached \u00b7 published \u00b7 locked')+'</span>';
  else if(dec==='rejected') status = '<span class="cm-lock bad">'+(isCh?'\u2715 challenge dismissed \u00b7 locked':'\u2715 closed by consensus \u00b7 locked')+'</span>';
  else {
    const need = Math.max(0, thr - t.aw);
    status = '<span class="cm-st">'+need+' more weight to '+(isCh?'uphold':'publish')+(aW>0?(' \u00b7 author standing \u00d7'+aW+' counted'):'')+'</span>';
  }
  return '<div class="cm'+(dec?' done':'')+'">'
    + '<div class="cm-bar"><div class="cm-fill" style="width:'+ap+'%"></div></div>'
    + (t.rw>0 ? '<div class="cm-bar rj"><div class="cm-fill rj" style="width:'+rp+'%"></div></div>' : '')
    + '<div class="cm-meta mono"><span class="cm-w">\u2713 '+t.aw+' / '+thr+'</span>'
      + (t.rw>0 ? ('<span class="cm-rj">\u2715 '+t.rw+' / '+CONSENSUS_THRESHOLD+'</span>') : '')
      + status
    + '</div></div>';
}
async function vouch(type,id,vote,creator){
  void type; void id; void vote; void creator;
  showToast("Legacy review voting is disabled. Open native Case review for current governance.");
}
// ===== challenges: any wallet can contest a published record; analysts judge it =====
var chxCtx=null;
function chxOpen(itemType,itemId,label){
  if(!walletPubkey){ showToast('Connect your wallet first \u00b7 a challenge must be signed.'); return; }
  chxCtx={item_type:String(itemType),item_id:String(itemId),item_label:String(label||'')};
  var t=document.getElementById('chx-title'); if(t) t.textContent='Challenge \u00b7 '+(label||itemId);
  var th=document.getElementById('chx-thr'); if(th) th.textContent=String(CONSENSUS_THRESHOLD);
  var r=document.getElementById('chx-reason'); if(r) r.value='';
  var m=document.getElementById('chx-modal'); if(m){ m.classList.add('open'); document.body.style.overflow='hidden'; }
  if(r) setTimeout(function(){ try{r.focus();}catch(e){} },60);
}
function chxClose(){ var m=document.getElementById('chx-modal'); if(m) m.classList.remove('open'); document.body.style.overflow=''; }
async function chxSubmit(){
  if(!chxCtx) return;
  var reason=(document.getElementById('chx-reason')||{}).value||''; reason=reason.trim();
  if(reason.length<30){ showToast('Lay out the evidence \u00b7 at least a sentence or two with the on-chain facts.'); return; }
  if(!rateOk('challenge', 8000)){ showToast('Give it a few seconds.'); return; }
  var ctx=chxCtx;
  try{
    var ex=await supaGet('challenges?select=id&item_type=eq.'+encodeURIComponent(ctx.item_type)+'&item_id=eq.'+encodeURIComponent(ctx.item_id)+'&challenger=eq.'+encodeURIComponent(walletPubkey)+'&status=eq.open&limit=1');
    if(ex && ex.length){ showToast('You already have an open challenge on this record.'); return; }
  }catch(e){}
  var _ts=Math.floor(Date.now()/1000);
  var memo='OSI_CHALLENGE_FILED|item_type='+ctx.item_type+'|item_id='+ctx.item_id+'|challenger='+(walletPubkey||'')+'|ts='+_ts;
  withOnchainVote('File a challenge', memo, async function(sig){
    try{
      await supaPost('challenges', { item_type:ctx.item_type, item_id:ctx.item_id, item_label:ctx.item_label, challenger:walletPubkey, reason:reason, status:'open' });
      recordOnchainEvent({ event_type:'analyst_vouch', item_type:'challenge', item_id:ctx.item_id, vote:'reject', label:'challenged a published '+ctx.item_type, memo_text:memo, tx_sig:sig });
      showToast('\u2696 Challenge filed and signed \u00b7 verified analysts will judge it.');
      chxClose(); renderReviewFloor();
    }catch(e){ showToast('Challenge could not be filed \u00b7 the challenges table may not exist yet.'); }
  });
}
var rfTab='pending', rfPageN=1, RF_PER=6;
var RF_Q='';
function rfSetTab(t){ rfTab=t; rfPageN=1; renderReviewFloor(); }
function rfSetPage(p){ rfPageN=p|0; renderReviewFloor(); }
function rfSearch(v){ RF_Q=(v||'').trim().toLowerCase(); rfPageN=1; renderReviewFloor(); }
// evidence / tx / attachment counts from real row data
function rfEvidence(row, type){
  if(!row) return 0;
  if(type==='challenge') return 0;
  var fields = type==='bounty' ? [row.detail, row.onchain] : [row.onchain, row.offchain, row.summary];
  return fields.reduce(function(s,f){ return s + crCountTokens(f); }, 0);
}
function rfTxLinks(row, type){
  if(!row) return 0;
  var t = row.tx || row.onchain || '';
  return crCountTokens(t);
}
function rfAttach(row){ return row && row.image ? 1 : 0; }
// item's live status bucket for tabs
function rfBucket(it){
  var row=(window.__rfRows||{})[vouchKey(it.type,it.id)]||null;
  var dec=vouchDecision(it.type,it.id,row);
  if(dec==='rejected') return 'rejected';
  if(it.type==='challenge') return 'disputed';
  if(row && row.review_status==='challenged') return 'disputed';
  if(dec==='published') return 'ready';
  var t=vouchTally(it.type,it.id);
  var thr=vouchThreshold(it.type,it.id,row);
  if(t.aw>=thr && t.aw>=t.rw) return 'ready';
  return 'pending';
}
// Demo queue is unavailable in live mode. It only renders when
// window.OSI_DEMO_MODE === true, so sample review items cannot leak into testing.
function reviewQueueSample(){
  if(window.OSI_DEMO_MODE !== true) return [];
  var now = Date.now();
  function t(days){ return new Date(now - days*86400000).toISOString(); }
  return [
    { type:'report', id:'DMO-5153', title:'Upexi', creator:'42VqAbcdEfGhXU4y', sub:'On-chain evidence pack regarding suspicious market activity and potential disclosure issues.', ts:t(2),
      row:{ id:'DMO-5153', company:'Upexi', wallet:'42VqAbcdEfGhXU4y', summary:'On-chain evidence pack regarding suspicious market activity and potential disclosure issues. The report traces a cluster of wallets moving funds through an intermediary before a public announcement.', onchain:'walletAAA111 walletBBB222 walletCCC333 txHashLongEnough1 txHashLongEnough2 txHashLongEnough3', tx:'sig111LongEnoughToCount sig222LongEnoughToCount sig333LongEnoughToCount', created_at:t(2) },
      votes:{ approve:['DEMO_B'], reject:[] } },
    { type:'bounty', id:'DMO-5181', title:'Wallet-Drainer Incident', creator:'7vAbCdEfGhLm2a', sub:'Initial evidence and victim reports related to a wallet drainer operating across multiple tokens.', ts:t(3),
      row:{ id:'DMO-5181', target:'Wallet-Drainer Incident', created_by:'7vAbCdEfGhLm2a', detail:'Initial evidence and victim reports related to a wallet drainer operating across multiple tokens. Victims report a malicious signature request followed by asset movement to a consolidation wallet.', onchain:'drainerWallet1 victimWallet1 victimWallet2 consolidation1 txHashLong1', created_at:t(3) },
      votes:{ approve:['DEMO_C'], reject:['DEMO_B'] } },
    { type:'challenge', id:'DMO-4990', title:'Exchange Deposit Attribution', creator:'HjKlMnPq9pQe', sub:'Attribution report linking deposit addresses to exchange clusters is challenged on an intermediary hop.', ts:t(4),
      row:{ id:'DMO-4990', item_label:'Exchange Deposit Attribution', challenger:'HjKlMnPq9pQe', item_id:'DMO-4990r', reason:'The attribution treats an exchange hot wallet as the endpoint, but the deposit routed through an intermediary the report never addresses. The on-chain path shows one more hop before the exchange.', created_at:t(4) },
      votes:{ approve:['DEMO_B'], reject:[] } },
    { type:'report', id:'DMO-5202', title:'Token Team Wallet Movements', creator:'8BvCdEfRtY1', sub:'Analysis of team wallet movements and token unlock events against the published vesting schedule.', ts:t(1),
      row:{ id:'DMO-5202', company:'Token Team Wallet Movements', wallet:'8BvCdEfRtY1', summary:'Analysis of team wallet movements and token unlock events against the published vesting schedule. Several transfers precede the stated cliff, moving tokens to fresh wallets ahead of the public unlock.', onchain:'teamWallet1 freshWallet1 freshWallet2 txHashLong1 txHashLong2', tx:'sigA1LongEnoughToCount sigA2LongEnoughToCount', created_at:t(1) },
      votes:{ approve:[], reject:[] } }
  ];
}
function rfInstallDemo(){
  if(window.OSI_DEMO_MODE !== true) return [];
  window.ANALYST_WEIGHT = window.ANALYST_WEIGHT || {};
  window.VERIFIED_ANALYSTS = window.VERIFIED_ANALYSTS || {};
  ['DEMO_B','DEMO_C'].forEach(function(w){ if(window.ANALYST_WEIGHT[w]==null) window.ANALYST_WEIGHT[w]=2; window.VERIFIED_ANALYSTS[w]=window.VERIFIED_ANALYSTS[w]||{handle:w}; });
  var sample=reviewQueueSample();
  window.VOUCHES = window.VOUCHES || {};
  sample.forEach(function(it){ window.__rfRows[vouchKey(it.type,it.id)]=it.row; window.VOUCHES[vouchKey(it.type,it.id)]=it.votes; });
  return sample.map(function(it){ return {type:it.type, id:it.id, title:it.title, sub:it.sub, ts:it.ts, creator:it.creator, _demo:true}; });
}
