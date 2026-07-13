// ============================================================================
// OSI V2 read-only Case registry app (classic script, no framework).
//
// Every rendered field passes through escapeHtml. No API response is written
// to console. The only backend is the osi-v2-case-read Edge Function, which
// authorizes every call server-side; this file holds no privileged key.
// only the publishable anon key from 01-public-config.js.
//
// Active buttons: Connect Wallet, Unlock My Cases, Refresh, View authorized
// Case, Return to Field Office, maintainer Sign in / Sign out, Unlock
// overview. Every V2 write control is rendered disabled with its exact unmet
// prerequisite. OSI_V2_WRITES_ENABLED is false in production.
// ============================================================================

"use strict";

var OSI_API_BASE = (window.OSI_SUPABASE_URL || "") + "/functions/v1/osi-v2-case-read";
var OSI_ANON_KEY = window.OSI_SUPABASE_KEY || "";
var WRITE_GATE_NOTE = "V2 intake remains closed until the signed-write rollout is enabled (OSI_V2_WRITES_ENABLED=false).";

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function shortWallet(w) {
  w = String(w || "");
  return w.length > 12 ? w.slice(0, 4) + "…" + w.slice(-4) : w;
}
function fmtDate(iso) {
  if (!iso) return "Not recorded";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "Not recorded";
  return d.toISOString().slice(0, 10);
}
function chipClassForLabel(label) {
  if (label === "Memo-anchored on Solana") return "chip chip-verified";
  if (label === "Wallet-signed & server-verified") return "chip chip-verified";
  if (label === "System event") return "chip chip-system";
  return "chip chip-legacy";
}

// ── API client ──────────────────────────────────────────────────────────────
function apiCall(payload, authToken) {
  var headers = { "Content-Type": "application/json" };
  if (OSI_ANON_KEY) headers.apikey = OSI_ANON_KEY;
  if (authToken) headers.Authorization = "Bearer " + authToken;
  return fetch(OSI_API_BASE, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(payload),
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      return { status: res.status, data: data };
    });
  });
}

// ── Wallet (Phantom-compatible) ─────────────────────────────────────────────
var walletPubkey = null;

function walletProvider() {
  var p = window.phantom && window.phantom.solana ? window.phantom.solana : window.solana;
  return p && p.signMessage ? p : null;
}
function updateWalletUi() {
  var text = document.getElementById("wallet-btn-text");
  var dot = document.getElementById("wallet-dot");
  if (text) text.textContent = walletPubkey ? shortWallet(walletPubkey) : "Connect Wallet";
  if (dot) dot.className = walletPubkey ? "wallet-dot on" : "wallet-dot";
}
function walletButtonClick() {
  if (walletPubkey) {
    var p = walletProvider();
    if (p && p.disconnect) { try { p.disconnect(); } catch (e) { /* ignore */ } }
    walletPubkey = null;
    updateWalletUi();
    renderCurrentView();
    return;
  }
  connectWallet();
}
function connectWallet() {
  var p = walletProvider();
  if (!p) {
    alert("No Solana wallet found. Install a Solana wallet extension (e.g. Phantom), then try again.");
    return Promise.resolve(false);
  }
  return p.connect().then(function (res) {
    var key = res && res.publicKey ? res.publicKey.toString() : (p.publicKey ? p.publicKey.toString() : null);
    if (key) { walletPubkey = key; updateWalletUi(); renderCurrentView(); return true; }
    return false;
  }).catch(function () { return false; });
}
function bytesToBase64(bytes) {
  var bin = "";
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
// Fresh challenge → wallet signature → base64. Rejection and expiry surface
// as distinct, honest error strings for the UI.
function signedRead(purpose, caseRef) {
  if (!walletPubkey) return Promise.reject(new Error("wallet_not_connected"));
  return apiCall({ op: "issue_read_challenge", purpose: purpose, wallet: walletPubkey, case_ref: caseRef || "" })
    .then(function (res) {
      if (res.status !== 200 || !res.data.ok) throw new Error(res.data.error || "challenge_failed");
      var challenge = res.data.challenge;
      var provider = walletProvider();
      return provider.signMessage(new TextEncoder().encode(challenge), "utf8")
        .catch(function () { throw new Error("signature_rejected"); })
        .then(function (signed) {
          var sigBytes = signed && signed.signature ? signed.signature : signed;
          return { challenge: challenge, signature: bytesToBase64(sigBytes) };
        });
    });
}

// ── Maintainer session (memory only; never persisted) ───────────────────────
var maintainerToken = null;
var maintainerEmail = null;

function maintainerSignIn(email, password) {
  return fetch(window.OSI_SUPABASE_URL + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { apikey: OSI_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: email, password: password }),
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (data) {
      if (!r.ok || !data.access_token) {
        throw new Error(data.error_description || data.msg || "Sign-in failed (" + r.status + ")");
      }
      maintainerToken = data.access_token;
      maintainerEmail = email;
      return true;
    });
  });
}
function maintainerSignOut() {
  maintainerToken = null;
  maintainerEmail = null;
  renderCurrentView();
}

// ── Shared render helpers ───────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }
function mainEl() { return el("app-main"); }

function stateHtml(kind, icon, title, body, extraHtml) {
  return '<div class="state state-' + kind + '">' +
    '<div class="state-icon" aria-hidden="true">' + icon + "</div>" +
    "<h3>" + escapeHtml(title) + "</h3>" +
    "<p>" + body + "</p>" + (extraHtml || "") + "</div>";
}
function loadingGrid(n) {
  var cells = "";
  for (var i = 0; i < n; i++) cells += '<div class="skeleton"></div>';
  return '<div class="skeleton-grid" role="status" aria-label="Loading">' + cells + "</div>";
}
function errorState(retryFnName) {
  var offline = navigator.onLine === false;
  return stateHtml(
    "error", "⚠",
    offline ? "You are offline" : "The registry could not be reached",
    offline
      ? "Reconnect to the network, then retry. Nothing shown here is live data."
      : "The read API returned an error. This page never shows placeholder data. Retry when ready.",
    '<button class="btn" onclick="' + retryFnName + '()">Refresh</button>'
  );
}
function proofLogHtml(proofLog) {
  if (!proofLog || !proofLog.length) {
    return '<p class="mono" style="color:var(--ink-faint);font-size:12px">No Proof Log entries for this Case.</p>';
  }
  var out = "";
  for (var i = 0; i < proofLog.length; i++) {
    var r = proofLog[i];
    out += '<div class="proof-item">' +
      '<span class="' + chipClassForLabel(r.label) + '">' + escapeHtml(r.label) + "</span>" +
      '<span class="mono" style="font-size:11.5px">' + escapeHtml(r.event_type || "") + "</span>" +
      (r.tx_sig ? '<span class="mono" style="font-size:11px;color:var(--ink-faint)">tx ' + escapeHtml(shortWallet(r.tx_sig)) + "</span>" : "") +
      '<span class="proof-when">' + escapeHtml(fmtDate(r.occurred_at)) + "</span>" +
      "</div>";
  }
  return out;
}
function disabledWriteButton(label) {
  return '<div><button class="btn" disabled title="' + escapeHtml(WRITE_GATE_NOTE) + '">' +
    escapeHtml(label) + '</button><div class="disabled-note">' + escapeHtml(WRITE_GATE_NOTE) + "</div></div>";
}
function viewHead(kicker, title, lede) {
  return '<div class="view-head"><div class="view-kicker">' + escapeHtml(kicker) + "</div>" +
    '<h1 class="view-title">' + escapeHtml(title) + "</h1>" +
    '<p class="view-lede">' + lede + "</p></div>";
}

// ── View: Field Office (public Case list) ───────────────────────────────────
function renderFieldOffice() {
  mainEl().innerHTML =
    viewHead("Field Office", "Public Case registry",
      "Community-reviewed V2 Cases with wallet-signed provenance. Only genuinely public Cases appear here. Nothing is staged or simulated.") +
    '<div class="toolbar">' +
    '<button class="btn" onclick="loadFieldOffice()">Refresh</button>' +
    '<div class="spacer"></div>' +
    disabledWriteButton("Submit a Case") +
    "</div>" +
    '<div id="fo-body">' + loadingGrid(3) + "</div>";
  loadFieldOffice();
}
function loadFieldOffice() {
  var body = el("fo-body");
  if (!body) return;
  body.innerHTML = loadingGrid(3);
  apiCall({ op: "list_public_cases" }).then(function (res) {
    if (res.status !== 200 || !res.data.ok) { body.innerHTML = errorState("loadFieldOffice"); return; }
    var cases = res.data.cases || [];
    if (!cases.length) {
      body.innerHTML = stateHtml(
        "empty", "◈", "No public Cases yet",
        "The V2 registry is live and this list reads real production data. There are currently zero publicly visible Cases. " +
        "Imported Cases exist in private draft state, readable only by their owners (My OSI) and the maintainer (Operations Center).",
        '<div class="mono">list_public_cases · live · 0 rows</div>'
      );
      return;
    }
    var out = '<div class="case-grid">';
    for (var i = 0; i < cases.length; i++) out += publicCaseCard(cases[i]);
    body.innerHTML = out + "</div>";
  }).catch(function () { body.innerHTML = errorState("loadFieldOffice"); });
}
function publicCaseCard(c) {
  return '<a class="case-card" href="#/case/' + encodeURIComponent(c.public_ref) + '" style="color:inherit;text-decoration:none">' +
    '<div class="case-ref">' + escapeHtml(c.public_ref) + "</div>" +
    '<h3 class="case-title">' + escapeHtml(c.title) + "</h3>" +
    '<p class="case-summary">' + escapeHtml(c.summary) + "</p>" +
    '<div class="case-meta">' +
    '<span class="chip chip-public">' + escapeHtml(c.visibility) + "</span>" +
    '<span class="chip chip-stage">' + escapeHtml(c.stage) + "</span>" +
    '<span class="chip">' + escapeHtml(fmtDate(c.created_at)) + "</span>" +
    "</div></a>";
}

// ── View: Case detail ───────────────────────────────────────────────────────
var currentCaseRef = "";
function renderCaseDetail(ref) {
  currentCaseRef = ref;
  mainEl().innerHTML =
    viewHead("Case file", ref, "Exact stage, visibility, Report versions and provenance for this Case.") +
    '<div class="toolbar"><a class="btn btn-ghost" href="#/field-office">← Return to Field Office</a></div>' +
    '<div id="cd-body">' + loadingGrid(1) + "</div>";
  loadCaseDetail();
}
function loadCaseDetail() {
  var body = el("cd-body");
  if (!body) return;
  var ref = currentCaseRef;
  body.innerHTML = loadingGrid(1);
  apiCall({ op: "get_public_case", public_ref: ref }).then(function (res) {
    if (res.status === 404) {
      body.innerHTML = stateHtml(
        "locked", "🔒", "Private or unknown Case",
        "This reference does not correspond to a publicly visible Case. If it is yours, connect your wallet and unlock it in " +
        '<a href="#/my-osi">My OSI</a>; maintainers can inspect it in the <a href="#/operations">Operations Center</a>. ' +
        "No private content is ever shown here.",
        '<a class="btn" href="#/field-office">Return to Field Office</a>'
      );
      return;
    }
    if (res.status !== 200 || !res.data.ok) { body.innerHTML = errorState("loadCaseDetail"); return; }
    body.innerHTML = publicCaseDetailHtml(res.data.case);
  }).catch(function () { body.innerHTML = errorState("loadCaseDetail"); });
}
function publicCaseDetailHtml(c) {
  var reports = c.reports || [];
  var reportsHtml = reports.length
    ? reports.map(function (r) {
        var v = r.current_version;
        return '<div class="version-block">' +
          '<span class="chip chip-stage">report ' + escapeHtml(r.status) + "</span> " +
          (v ? '<span class="chip">version ' + escapeHtml(String(v.version_no)) + " · " + escapeHtml(v.lifecycle_state) + "</span>" : "") +
          '<span class="chip ' + (r.published ? "chip-public" : "chip-private") + '">' + (r.published ? "published" : "not published") + "</span>" +
          "</div>";
      }).join("")
    : '<p class="mono" style="color:var(--ink-faint);font-size:12px">No Reports filed on this Case.</p>';
  return '<div class="panel">' +
    '<div class="detail-head"><h2 class="panel-h" style="margin:0">' + escapeHtml(c.title) + "</h2>" +
    '<span class="chip chip-public">' + escapeHtml(c.visibility) + "</span>" +
    '<span class="chip chip-stage">' + escapeHtml(c.stage) + "</span></div>" +
    "<p>" + escapeHtml(c.summary) + "</p>" +
    '<table class="kv-table"><tbody>' +
    "<tr><th>Case ref</th><td class=\"mono\">" + escapeHtml(c.public_ref) + "</td></tr>" +
    "<tr><th>Opened</th><td>" + escapeHtml(fmtDate(c.created_at)) + "</td></tr>" +
    "<tr><th>Sealed</th><td>" + escapeHtml(c.sealed_at ? fmtDate(c.sealed_at) : "not sealed") + "</td></tr>" +
    "</tbody></table></div>" +
    '<div class="panel"><h3 class="panel-h">Reports</h3>' + reportsHtml + "</div>" +
    '<div class="panel"><h3 class="panel-h">Proof Log</h3>' + proofLogHtml(c.proof_log) + "</div>";
}

// ── View: The Wire ──────────────────────────────────────────────────────────
function renderWire() {
  mainEl().innerHTML =
    viewHead("The Wire", "Standalone dispatches",
      "The Wire carries standalone V2 findings that do not require a Case. It reads the live V2 registry. No legacy material is re-labeled as a Wire dispatch.") +
    stateHtml("empty", "◈", "No V2 Wire dispatches yet",
      "The V2 Wire tables are live and empty. Historical V1 wire material remains available, unchanged and clearly labeled, in the " +
      '<a href="./legacy.html">V1 archive</a>.',
      '<div class="mono">wire_reports · live · 0 rows</div>') +
    '<div class="toolbar" style="margin-top:16px">' + disabledWriteButton("Submit a Wire dispatch") + "</div>";
}

// ── View: My OSI ────────────────────────────────────────────────────────────
var myCasesCache = null;
function renderMyOsi() {
  var connected = !!walletPubkey;
  mainEl().innerHTML =
    viewHead("My OSI", "Your Cases",
      "Prove control of your wallet with a fresh signature to read your own private Cases. The signature authorizes a single short-lived read. It writes nothing and costs nothing.") +
    '<div class="panel"><h3 class="panel-h">Wallet</h3>' +
    (connected
      ? '<div class="gate-row"><span class="gate-dot ok"></span><span class="mono">' + escapeHtml(shortWallet(walletPubkey)) + "</span> connected</div>" +
        '<div class="toolbar" style="margin-top:8px">' +
        '<button class="btn btn-primary" id="unlock-btn" onclick="unlockMyCases()">Unlock My Cases</button>' +
        '<button class="btn btn-ghost" onclick="walletButtonClick()">Disconnect</button></div>'
      : '<div class="gate-row"><span class="gate-dot"></span>No wallet connected.</div>' +
        '<div class="toolbar" style="margin-top:8px"><button class="btn btn-primary" onclick="connectWallet()">Connect Wallet</button></div>') +
    '<div class="form-msg" id="myosi-msg"></div></div>' +
    '<div id="myosi-body"></div>' +
    '<div class="toolbar" style="margin-top:16px">' + disabledWriteButton("Submit a Case") + disabledWriteButton("Submit a Report") + "</div>";
  if (myCasesCache) el("myosi-body").innerHTML = myCasesListHtml(myCasesCache);
}
function unlockMyCases() {
  var msg = el("myosi-msg");
  var body = el("myosi-body");
  if (!walletPubkey) { if (msg) { msg.className = "form-msg err"; msg.textContent = "Connect a wallet first."; } return; }
  if (msg) { msg.className = "form-msg dim"; msg.textContent = "Requesting challenge and wallet signature…"; }
  if (body) body.innerHTML = loadingGrid(2);
  signedRead("CASE_READ_MY_CASES").then(function (proof) {
    if (msg) { msg.className = "form-msg dim"; msg.textContent = "Verifying signature server-side…"; }
    return apiCall({ op: "list_my_cases", wallet: walletPubkey, challenge: proof.challenge, signature: proof.signature });
  }).then(function (res) {
    if (res.status !== 200 || !res.data.ok) {
      var reason = res.data && res.data.error;
      var friendly =
        reason === "expired" ? "The challenge expired before it was signed. Unlock again to get a fresh one." :
        reason === "replayed" ? "That signature was already used. Unlock again for a fresh challenge." :
        reason === "bad_signature" ? "The wallet signature did not verify. Try again." :
        "Unlock failed (" + escapeHtml(String(reason || res.status)) + ").";
      if (msg) { msg.className = "form-msg err"; msg.textContent = friendly; }
      if (body) body.innerHTML = "";
      return;
    }
    myCasesCache = res.data.cases || [];
    if (msg) {
      msg.className = "form-msg ok";
      msg.textContent = "✓ Signature verified. Showing " + myCasesCache.length + " Case(s) owned by this wallet.";
    }
    if (body) body.innerHTML = myCasesListHtml(myCasesCache);
  }).catch(function (e) {
    var text = e && e.message === "signature_rejected"
      ? "Signature request was dismissed in the wallet. Nothing was unlocked."
      : "Unlock failed: " + (navigator.onLine === false ? "you appear to be offline." : "the read API could not be reached.");
    if (msg) { msg.className = "form-msg err"; msg.textContent = text; }
    if (body) body.innerHTML = "";
  });
}
function myCasesListHtml(cases) {
  if (!cases.length) {
    return stateHtml("empty", "◈", "This wallet owns no Cases",
      "The signature verified, and the registry holds no Case submitted by this wallet. Imported legacy Cases belong to their original submitting wallets.",
      '<div class="mono">list_my_cases · live · 0 rows</div>');
  }
  var out = "";
  for (var i = 0; i < cases.length; i++) out += authorizedCaseHtml(cases[i]);
  return out;
}
function authorizedCaseHtml(c) {
  var reports = c.reports || [];
  var reportsHtml = reports.length
    ? reports.map(function (r) {
        var versions = (r.versions || []).map(function (v) {
          return '<div class="version-block">' +
            '<span class="chip">v' + escapeHtml(String(v.version_no)) + "</span> " +
            '<span class="chip chip-stage">' + escapeHtml(v.lifecycle_state) + "</span> " +
            '<span class="chip">' + escapeHtml(fmtDate(v.created_at)) + "</span> " +
            '<span class="chip ' + (v.published_at ? "chip-public" : "chip-private") + '">' +
            (v.published_at ? "published " + escapeHtml(fmtDate(v.published_at)) : "not published") + "</span>" +
            '<div class="disabled-note">author ' + escapeHtml(shortWallet(v.created_by_wallet)) +
            " · body " + escapeHtml(String(v.body_length)) + " chars · evidence hash " +
            escapeHtml(String(v.evidence_snapshot_hash).slice(0, 12)) + "…</div>" +
            (typeof v.body_private === "string"
              ? '<div class="body-private-box">' + escapeHtml(v.body_private) + "</div>"
              : '<div class="disabled-note">Private body visible only to its author wallet.</div>') +
            "</div>";
        }).join("");
        return '<div style="margin-top:10px"><span class="chip chip-stage">report · ' + escapeHtml(r.status) + "</span> " +
          '<span class="chip">author ' + escapeHtml(shortWallet(r.author_wallet)) + "</span>" + versions + "</div>";
      }).join("")
    : '<p class="mono" style="color:var(--ink-faint);font-size:12px">No Reports filed on this Case.</p>';
  return '<div class="panel">' +
    '<div class="detail-head"><h3 class="panel-h" style="margin:0">' + escapeHtml(c.title) + "</h3>" +
    '<span class="chip ' + (c.visibility === "public" ? "chip-public" : "chip-private") + '">' + escapeHtml(c.visibility) + "</span>" +
    '<span class="chip chip-stage">' + escapeHtml(c.stage) + "</span>" +
    '<span class="chip">' + escapeHtml(c.risk_tier) + " risk</span></div>" +
    '<div class="case-ref" style="margin-bottom:8px">' + escapeHtml(c.public_ref) + " · " + escapeHtml(c.category) + "</div>" +
    "<p>" + escapeHtml(c.summary) + "</p>" +
    '<table class="kv-table"><tbody>' +
    "<tr><th>Owner wallet</th><td class=\"mono\">" + escapeHtml(c.submitted_by_wallet) + "</td></tr>" +
    "<tr><th>Created</th><td>" + escapeHtml(fmtDate(c.created_at)) + "</td></tr>" +
    "</tbody></table>" +
    '<h4 style="margin:14px 0 4px;font-size:13.5px">Reports &amp; immutable versions</h4>' + reportsHtml +
    '<h4 style="margin:14px 0 4px;font-size:13.5px">Proof Log</h4>' + proofLogHtml(c.proof_log) +
    "</div>";
}

// ── View: Operations Center ─────────────────────────────────────────────────
function renderOperations() {
  var authed = !!maintainerToken;
  var connected = !!walletPubkey;
  mainEl().innerHTML =
    viewHead("Operations Center", "Maintainer inspection",
      "Read-only oversight of the live V2 registry. Access requires BOTH the maintainer Supabase sign-in and a fresh signature from the configured admin wallet. Either alone is denied.") +
    '<div class="panel"><h3 class="panel-h">Maintainer gates</h3>' +
    '<div class="gate-row"><span class="gate-dot ' + (authed ? "ok" : "") + '"></span>Gate 1 · Supabase maintainer session: ' +
    (authed ? '<strong>signed in</strong> <span class="mono">(' + escapeHtml(maintainerEmail || "") + ')</span>' : "not signed in") + "</div>" +
    '<div class="gate-row"><span class="gate-dot ' + (connected ? "ok" : "") + '"></span>Gate 2 · Admin wallet signature: ' +
    (connected ? '<span class="mono">' + escapeHtml(shortWallet(walletPubkey)) + "</span> connected; signature requested at unlock" : "no wallet connected") + "</div>" +
    (authed
      ? '<div class="toolbar" style="margin-top:10px">' +
        '<button class="btn btn-primary" onclick="unlockOverview()">Unlock overview</button>' +
        '<button class="btn btn-ghost" onclick="maintainerSignOut()">Sign out</button>' +
        (!connected ? '<button class="btn" onclick="connectWallet()">Connect Wallet</button>' : "") + "</div>"
      : '<form onsubmit="opsSignIn(event)" style="margin-top:10px">' +
        '<div class="field"><label for="ops-email">Maintainer email</label><input id="ops-email" type="email" autocomplete="username" required></div>' +
        '<div class="field"><label for="ops-pass">Password</label><input id="ops-pass" type="password" autocomplete="current-password" required></div>' +
        '<button class="btn btn-primary" type="submit">Sign in</button>' +
        (!connected ? ' <button class="btn" type="button" onclick="connectWallet()">Connect Wallet</button>' : "") +
        "</form>") +
    '<div class="form-msg" id="ops-msg"></div></div>' +
    '<div id="ops-body"></div>';
}
function opsSignIn(event) {
  event.preventDefault();
  var msg = el("ops-msg");
  var email = (el("ops-email") || {}).value || "";
  var pass = (el("ops-pass") || {}).value || "";
  if (msg) { msg.className = "form-msg dim"; msg.textContent = "Signing in…"; }
  maintainerSignIn(email.trim(), pass).then(function () {
    renderOperations();
    var m = el("ops-msg");
    if (m) { m.className = "form-msg ok"; m.textContent = "✓ Gate 1 satisfied. Now unlock with the admin wallet signature."; }
  }).catch(function (e) {
    if (msg) { msg.className = "form-msg err"; msg.textContent = String((e && e.message) || "Sign-in failed."); }
  });
}
function unlockOverview() {
  var msg = el("ops-msg");
  var body = el("ops-body");
  if (!maintainerToken) { if (msg) { msg.className = "form-msg err"; msg.textContent = "Sign in first (Gate 1)."; } return; }
  if (!walletPubkey) { if (msg) { msg.className = "form-msg err"; msg.textContent = "Connect the admin wallet first (Gate 2)."; } return; }
  if (msg) { msg.className = "form-msg dim"; msg.textContent = "Requesting challenge and admin wallet signature…"; }
  if (body) body.innerHTML = loadingGrid(2);
  signedRead("CASE_READ_MAINTAINER_OVERVIEW").then(function (proof) {
    return apiCall(
      { op: "maintainer_case_overview", wallet: walletPubkey, challenge: proof.challenge, signature: proof.signature },
      maintainerToken
    );
  }).then(function (res) {
    if (res.status !== 200 || !res.data.ok) {
      var reason = res.data && res.data.error;
      var friendly =
        reason === "half_maintainer_wallet_only" ? "Denied: valid admin wallet signature, but no maintainer sign-in (half-maintainer)." :
        reason === "half_maintainer_auth_only" ? "Denied: signed in, but the connected wallet is not the configured admin wallet (half-maintainer)." :
        reason === "maintainer_denied" ? "Denied: neither maintainer gate is satisfied." :
        reason === "expired" ? "The challenge expired. Unlock again." :
        "Unlock failed (" + escapeHtml(String(reason || res.status)) + ").";
      if (msg) { msg.className = "form-msg err"; msg.textContent = friendly; }
      if (body) body.innerHTML = "";
      return;
    }
    if (msg) { msg.className = "form-msg ok"; msg.textContent = "✓ Both gates verified."; }
    if (body) body.innerHTML = overviewHtml(res.data.overview);
  }).catch(function (e) {
    var text = e && e.message === "signature_rejected"
      ? "Signature request was dismissed in the wallet. Nothing was unlocked."
      : "Unlock failed. The read API could not be reached.";
    if (msg) { msg.className = "form-msg err"; msg.textContent = text; }
    if (body) body.innerHTML = "";
  });
}
function overviewHtml(o) {
  var totals = o.totals || {};
  var flags = o.flags || {};
  function objRows(obj) {
    return Object.keys(obj || {}).map(function (k) {
      return "<tr><th>" + escapeHtml(k) + "</th><td>" + escapeHtml(String(obj[k])) + "</td></tr>";
    }).join("");
  }
  var casesHtml = (o.cases || []).map(authorizedCaseHtml).join("");
  return '<div class="panel"><h3 class="panel-h">Registry state (live)</h3>' +
    '<table class="kv-table"><tbody>' +
    "<tr><th>Total Cases</th><td>" + escapeHtml(String(totals.cases)) + "</td></tr>" +
    objRows(totals.cases_by_stage ? prefixKeys("stage · ", totals.cases_by_stage) : {}) +
    objRows(totals.cases_by_visibility ? prefixKeys("visibility · ", totals.cases_by_visibility) : {}) +
    objRows(prefixKeys("receipts · ", totals.receipts_by_label || {})) +
    "<tr><th>Crosswalk rows</th><td>" + escapeHtml(String(totals.migration_crosswalk_rows)) + "</td></tr>" +
    "<tr><th>Manual queue rows</th><td>" + escapeHtml(String(totals.migration_manual_queue_rows)) + "</td></tr>" +
    '<tr><th>OSI_V2_WRITES_ENABLED</th><td class="mono">' + escapeHtml(flags.OSI_V2_WRITES_ENABLED) + "</td></tr>" +
    '<tr><th>OSI_V2_PROOF_ENABLED</th><td class="mono">' + escapeHtml(flags.OSI_V2_PROOF_ENABLED) + "</td></tr>" +
    "</tbody></table></div>" +
    '<h3 style="margin:22px 0 10px;font-size:16px">Imported Cases (' + escapeHtml(String((o.cases || []).length)) + ")</h3>" + casesHtml;
}
function prefixKeys(prefix, obj) {
  var out = {};
  Object.keys(obj).forEach(function (k) { out[prefix + k] = obj[k]; });
  return out;
}

// ── Router ──────────────────────────────────────────────────────────────────
function currentRoute() {
  var hash = String(location.hash || "#/field-office");
  var caseMatch = hash.match(/^#\/case\/([A-Za-z0-9-]+)$/);
  if (caseMatch) return { view: "case", ref: decodeURIComponent(caseMatch[1]) };
  if (hash === "#/wire") return { view: "wire" };
  if (hash === "#/my-osi") return { view: "my-osi" };
  if (hash === "#/operations") return { view: "operations" };
  return { view: "field-office" };
}
function renderCurrentView() {
  var route = currentRoute();
  var links = document.querySelectorAll(".topnav a");
  for (var i = 0; i < links.length; i++) {
    links[i].className = links[i].getAttribute("data-nav") === route.view ? "active" : "";
  }
  if (route.view === "case") return renderCaseDetail(route.ref);
  if (route.view === "wire") return renderWire();
  if (route.view === "my-osi") return renderMyOsi();
  if (route.view === "operations") return renderOperations();
  return renderFieldOffice();
}

function updateOfflineBanner() {
  var banner = el("offline-banner");
  if (banner) banner.hidden = navigator.onLine !== false;
}

window.addEventListener("hashchange", renderCurrentView);
window.addEventListener("online", updateOfflineBanner);
window.addEventListener("offline", updateOfflineBanner);
document.addEventListener("DOMContentLoaded", function () {
  updateOfflineBanner();
  updateWalletUi();
  renderCurrentView();
  // Re-adopt a previously trusted wallet silently if the provider offers it.
  var provider = walletProvider();
  if (provider && provider.connect) {
    provider.connect({ onlyIfTrusted: true }).then(function (res) {
      var key = res && res.publicKey ? res.publicKey.toString() : null;
      if (key) { walletPubkey = key; updateWalletUi(); renderCurrentView(); }
    }).catch(function () { /* not trusted yet; fine */ });
  }
});
