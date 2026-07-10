
// ============================================================
//  ON-CHAIN AUDIT INDEX  (surface the signed actions that already happen)
//  Best-effort, additive: never blocks or reverses any action. The
//  on-chain memo transaction is the real proof; Supabase is just an index.
// ============================================================
function solscanTx(sig){ return 'https://solscan.io/tx/' + encodeURIComponent(sig); }
async function recordOnchainEvent(ev){
  if(typeof SUPA_ON==='undefined' || !SUPA_ON || !ev || !ev.tx_sig) return;
  try{
    await supaPost('onchain_events', {
      event_type:   ev.event_type || 'event',
      actor_wallet: ev.actor_wallet || (typeof walletPubkey!=='undefined' ? walletPubkey : null) || null,
      item_type:    ev.item_type || null,
      item_id:      (ev.item_id!=null) ? String(ev.item_id) : null,
      vote:         ev.vote || null,
      amount:       (ev.amount!=null && ev.amount!=='') ? Number(ev.amount) : null,
      token:        ev.token || null,
      label:        ev.label || null,
      memo_text:    ev.memo_text || null,
      tx_sig:       ev.tx_sig,
      status:       'confirmed'
    });
  }catch(e){ /* the on-chain memo tx remains the source of truth */ }
}
// ============================================================
//  OSI signed-event helper layer (Stage 1)
//  Thin, additive wrapper over withOnchainVote + recordOnchainEvent.
//  New events use the OSI1 memo grammar. No allegation text, rejection
//  reasons, or AI-Pack content ever goes into the memo or memo_text.
// ============================================================
function osiSignerRole(){
  try{
    if(typeof resolveMaintainerAccess === 'function' && resolveMaintainerAccess().allowed) return 'maintainer';
    if(typeof isVerifiedAnalyst === 'function' && isVerifiedAnalyst(walletPubkey)) return 'analyst';
  }catch(e){}
  return 'user';
}
function osiSanitizeMemoField(v){ return String(v==null?'':v).replace(/[|\r\n]/g,'/').slice(0,64); }
// OSI1|<EVENT_TYPE>|case=<case_id>|report=<report_id>|actor=<wallet>|role=<role>|ts=<unix>
function osiBuildMemo(eventType, o){
  o = o || {};
  return 'OSI1|' + String(eventType)
    + '|case='   + osiSanitizeMemoField(o.caseId   || '')
    + '|report=' + osiSanitizeMemoField(o.reportId || '')
    + '|actor='  + osiSanitizeMemoField(o.actor || (typeof walletPubkey!=='undefined' ? walletPubkey : '') || 'anon')
    + '|role='   + osiSanitizeMemoField(o.role  || osiSignerRole())
    + '|ts='     + (o.ts || Math.floor(Date.now()/1000));
}
// Map OSI1 event types to the DB event_type strings the Proof Log reader
// (plGroup) already recognizes, so no reader change is needed.
function osiEventTypeToDb(eventType){
  var m = { CASE_SUBMITTED:'case_opened', REPORT_SUBMITTED:'report_submitted' };
  return m[String(eventType)] || String(eventType).toLowerCase();
}
// Sign an OSI1 memo, then (best-effort) index it into onchain_events.
// opts: { eventType, actionLabel, caseId, reportId, itemType, itemId,
//         vote, amount, token, publicLabel, sensitive, onSuccess }
async function osiSignEvent(opts){
  opts = opts || {};
  var ts = Math.floor(Date.now()/1000);
  var role = osiSignerRole();
  var memo = osiBuildMemo(opts.eventType, {
    caseId: opts.caseId, reportId: opts.reportId, role: role, ts: ts
  });
  await withOnchainVote(opts.actionLabel || opts.eventType, memo, async function(sig){
    try{
      if(typeof recordOnchainEvent === 'function'){
        recordOnchainEvent({
          event_type: osiEventTypeToDb(opts.eventType),
          item_type:  opts.itemType || null,
          item_id:    opts.itemId || opts.caseId || opts.reportId || null,
          vote:       opts.vote || null,
          amount:     (opts.amount != null && opts.amount !== '') ? Number(opts.amount) : null,
          token:      opts.token || null,
          // Privacy: sensitive/intake events store NO narrative label or memo_text.
          label:      opts.sensitive ? null : (opts.publicLabel || null),
          memo_text:  opts.sensitive ? null : memo,
          tx_sig:     sig
        });
      }
    }catch(e){ /* on-chain memo tx remains source of truth */ }
    if(typeof opts.onSuccess === 'function') await opts.onSuccess(sig, memo);
  });
}
function raShortW(w){ w=String(w||''); return w.length>8 ? (w.slice(0,4)+'\u2026'+w.slice(-4)) : (w||'someone'); }
function raSignedItem(ev){
  var w=raShortW(ev.actor_wallet);
  var item=escapeHtml(String(ev.item_id||'').slice(0,12));
  var type=escapeHtml(ev.item_type||'item');
  var ic='\u2605', label, signed='Signed memo';
  if(ev.event_type==='analyst_vouch'){ ic='\u2713'; label='Analyst <b>'+w+'</b> '+(ev.vote==='approve'?'approved':'challenged')+' '+type+(item?(' '+item):''); }
  else if(ev.event_type==='report_submitted'){ ic='\u25a4'; label='Researcher <b>'+w+'</b> filed a report'+(ev.label?(' '+escapeHtml(String(ev.label).replace(/^filed report on /,'on '))):''); }
  else if(ev.event_type==='wire_dispatch'){ ic='\u25c8'; label='Analyst <b>'+w+'</b> filed a dispatch'+(ev.label?(' '+escapeHtml(String(ev.label).replace(/^filed a dispatch on /,'on '))):''); }
  else if(ev.event_type==='demand_signal'){ ic='\u25ce'; label='<b>'+w+'</b> backed the case'+(ev.label?(' '+escapeHtml(String(ev.label).replace(/^pledged demand for /,'for '))):''); }
  else if(ev.event_type==='support'){ ic='\u25ce'; signed='Signed transfer'; label='<b>'+w+'</b> sent '+(ev.amount!=null?(escapeHtml(String(ev.amount))+' '+escapeHtml(ev.token||'SOL')):'support')+(ev.label?(' '+escapeHtml(String(ev.label).replace(/^supported /,'to support '))):''); }
  else if(ev.event_type==='maintainer_seal'){ ic='\u2713'; label='Maintainer <b>'+w+'</b> sealed '+type+(item?(' '+item):'')+' as a public record'; }
  else { label='<b>'+w+'</b> signed an action'; }
  var link=ev.tx_sig?(' \u00b7 <a href="'+solscanTx(ev.tx_sig)+'" target="_blank" rel="noopener" class="ra-solscan">'+signed+' \u2197</a>'):'';
  return '<div class="ra-item"><span class="ra-ic sgn">'+ic+'</span><div class="ra-tx"><div class="ra-t">'+label+'</div><div class="ra-m">'+raTimeAgo(ev.created_at)+link+'</div></div></div>';
}