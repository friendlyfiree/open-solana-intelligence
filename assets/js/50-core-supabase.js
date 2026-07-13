

// ====================================================================
//  WALLET / dAPP LAYER, Phantom connect + on-chain memo vote
// ====================================================================

// ── CONTACT ─────────────────────────────────────────────────────────
// Feedback uses this address (click-to-copy). Keep it current.
const CONTACT_EMAIL = "aksusarya@proton.me";

// ── NEWSLETTER ──────────────────────────────────────────────────────
// All form submissions (requests, reports, applications, newsletter) are
// delivered through Web3Forms. Paste your free access key below (get one at
// web3forms.com). Submissions arrive at the email tied to that key.
// Until it's set, the forms politely say signups open soon.
const WEB3FORMS_KEY = "e8e7134b-bc86-483f-add9-8f735d686a2f";

// Single delivery helper: injects the access key, maps the subject, and posts
// to Web3Forms. Returns the fetch response so callers can check res.ok.
async function sendForm(fields){
  if(!WEB3FORMS_KEY || WEB3FORMS_KEY.indexOf("PASTE_YOUR") !== -1){ return { ok: false }; }
  const payload = Object.assign({ access_key: WEB3FORMS_KEY }, fields);
  if(payload._subject && !payload.subject){ payload.subject = payload._subject; }
  return fetch("https://api.web3forms.com/submit", {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(payload)
  });
}

// On-chain votes are written as a Solana Memo transaction, a real,
// verifiable signed action that pays NO ONE (only the ~0.000005 SOL
// network fee). This site collects nothing.
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

// ── WALLET REQUESTS (community demand board) ────────────────────────
// Seed requests the project wants traced. Vote tallies start honest (0):
// there is no backend yet, so the only real increment we can show is the
// visitor's own upvote (kept in this browser). New requests are emailed to
// the maintainer via Formspree AND saved on this device so they show up and
// can be voted on. Global, cross-device tallying is the Phase 2 backend.
const REQUESTS = [];
function lsGet(k, def){ try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; }catch(e){ return def; } }
function lsSet(k, val){ try{ localStorage.setItem(k, JSON.stringify(val)); }catch(e){} }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function safeUrl(u){ u = String(u || '').trim(); return /^https?:\/\//i.test(u) ? u : ''; }

// a stable per-browser id so one browser counts as one vote
function voterId(){ let v = lsGet('stw_voter', null); if(!v){ v = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36); lsSet('stw_voter', v); } return v; }
// Client-side spam speed-bump. A real rate limit needs a backend; this only stops casual rapid-fire from one browser.
function rateOk(key, ms){ try{ const now=Date.now(); const last=parseInt(localStorage.getItem('stw_rl_'+key)||'0',10)||0; if(now-last < ms) return false; localStorage.setItem('stw_rl_'+key, String(now)); return true; }catch(e){ return true; } }

// ── OPTIONAL GLOBAL BACKEND (Supabase) ──────────────────────────────
// Leave BOTH blank → the boards run on local storage (per-browser, the
// honest default). Fill them in (Supabase dashboard → Settings → API) to
// make Wallet Requests + their upvotes GLOBAL, shared across every visitor.
// Run the setup SQL first. Any failure falls back to local automatically.
// URL + public key now live in config.js (a tiny file you can edit safely,
// without ever touching this large file). If config.js is missing, the app
// quietly runs in local-only mode instead of erroring.
const SUPABASE_URL = (window.OSI_SUPABASE_URL || "https://afibxpniwfnavdobecrn.supabase.co");
const SUPABASE_ANON_KEY = (window.OSI_SUPABASE_KEY || "");
const SUPA_ON = !!(SUPABASE_URL && SUPABASE_ANON_KEY);
let SUPA_AUTH_TOKEN = null;
let SUPA_AUTH_USER = null;
let SUPA_AUTH_READY = Promise.resolve(null);
let SUPA_CLIENT = null;

function notifySupaAuthChanged(eventName){
  if(typeof setMaintainerServerGate === 'function') setMaintainerServerGate(false, 'checking');
  if(typeof updateMaintainerAccessUI === 'function') updateMaintainerAccessUI();
  var activeWallet = '';
  try{ activeWallet = walletPubkey || ''; }catch(_){ }
  if(typeof refreshMaintainerGate === 'function' && activeWallet) refreshMaintainerGate();
  if(!SUPA_AUTH_TOKEN && document.body && document.body.dataset.view === 'admin' && typeof renderAdminAccess === 'function'){
    renderAdminAccess({clear:true});
  }
  try{ window.dispatchEvent(new CustomEvent('osi:supabase-auth',{detail:{event:eventName,user:SUPA_AUTH_USER?{id:SUPA_AUTH_USER.id,email:SUPA_AUTH_USER.email}:null}})); }catch(_){ }
}

function applySupaSession(session,eventName){
  SUPA_AUTH_TOKEN = session && session.access_token ? session.access_token : null;
  SUPA_AUTH_USER = session && session.user ? session.user : null;
  notifySupaAuthChanged(eventName || (session ? 'SESSION_RESTORED' : 'SIGNED_OUT'));
  return session || null;
}

function initSupaAuth(){
  if(!SUPA_ON || !window.supabase || typeof window.supabase.createClient !== 'function'){
    SUPA_AUTH_READY = Promise.resolve(applySupaSession(null,'AUTH_UNAVAILABLE'));
    return SUPA_AUTH_READY;
  }
  SUPA_CLIENT = window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{
    auth:{
      autoRefreshToken:true,
      persistSession:true,
      detectSessionInUrl:true,
      storageKey:'osi-maintainer-auth-v1'
    }
  });
  SUPA_CLIENT.auth.onAuthStateChange(function(event,session){ applySupaSession(session,event); });
  SUPA_AUTH_READY = SUPA_CLIENT.auth.getSession().then(function(result){
    if(result.error) throw result.error;
    return applySupaSession(result.data && result.data.session,'INITIAL_SESSION');
  }).catch(function(){ return applySupaSession(null,'SESSION_RESTORE_FAILED'); });
  return SUPA_AUTH_READY;
}
function supaHeaders(extra){
  const h = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  // A signed-in maintainer sends their session token on Authorization.
  // Otherwise a legacy (eyJ...) key also goes on Authorization, but a new
  // sb_publishable_ key must NOT (the gateway rejects a non-JWT Bearer value).
  if(SUPA_AUTH_TOKEN) h.Authorization = 'Bearer ' + SUPA_AUTH_TOKEN;
  else if(/^eyJ/.test(SUPABASE_ANON_KEY)) h.Authorization = 'Bearer ' + SUPABASE_ANON_KEY;
  return Object.assign(h, extra || {});
}
async function supaGet(path){ const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { headers: supaHeaders() }); if(!r.ok) throw new Error('supa get ' + r.status); return r.json(); }
async function supaPost(table, row){ const r = await fetch(SUPABASE_URL + '/rest/v1/' + table, { method: 'POST', headers: supaHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(row) }); if(!r.ok && r.status !== 409) throw new Error('supa post ' + r.status); return true; }
async function supaDelete(path){ const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { method: 'DELETE', headers: supaHeaders() }); if(!r.ok) throw new Error('supa del ' + r.status); return true; }
async function supaPatch(path, row){ const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, { method:'PATCH', headers: supaHeaders({ Prefer:'return=minimal' }), body: JSON.stringify(row) }); if(!r.ok) throw new Error('supa patch ' + r.status); return true; }
async function supaSignIn(email, password){
  if(!SUPA_CLIENT) await initSupaAuth();
  if(!SUPA_CLIENT) throw new Error('Supabase authentication is unavailable.');
  const result = await SUPA_CLIENT.auth.signInWithPassword({email:email,password:password});
  if(result.error || !result.data || !result.data.session) throw (result.error || new Error('Sign-in failed.'));
  applySupaSession(result.data.session,'SIGNED_IN');
  return result.data;
}
async function supaSignOut(){
  if(SUPA_CLIENT){ try{ await SUPA_CLIENT.auth.signOut({scope:'local'}); }catch(_){ } }
  applySupaSession(null,'SIGNED_OUT');
}

initSupaAuth();
