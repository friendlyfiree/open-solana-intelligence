// ── Shared public read layer ────────────────────────────────────────
// Every public projection on the root product is fetched by several
// independent surfaces: the Home live panel, the Field Office registry,
// Public Records, the Proof Log and The Wire all ask for the same
// `list_public_cases` and `list_public_wire_reports` answers. Before this
// module each surface opened its own request, so one page visit paid for the
// same multi-second server projection four or five times, and every tab
// switch paid for it again.
//
// This layer changes only WHEN a request is made, never what it returns:
//
//   * single flight  - concurrent callers asking for the exact same
//                      endpoint and body share one in-flight request;
//   * short TTL      - list projections are reused for a few seconds so
//                      moving between tabs is instant;
//   * explicit reset - any native write calls osiPublicReadInvalidate(), so
//                      a fresh projection is fetched after a real change.
//
// Cached entries hold the raw response text and are re-parsed per caller, so
// no consumer can mutate another surface's copy. Failures are never cached
// and no response is ever served past its TTL: an unavailable source still
// reports unavailable, and nothing invents or retains private data.
(function () {
  'use strict';

  var DEFAULT_TIMEOUT_MS = 20000;
  // Long enough that switching tabs reuses one answer, short enough that a
  // record opened in another browser shows up on the next visit.
  var LIST_TTL_MS = 45000;
  var TTL_BY_OP = {
    list_public_cases: LIST_TTL_MS,
    list_public_wire_reports: LIST_TTL_MS,
    list_public_profiles: LIST_TTL_MS
  };

  var cache = Object.create(null);
  var inflight = Object.create(null);

  // Read from the public config object rather than the module-scoped
  // constants so this file stays independent of script order.
  function baseUrl() { return String(window.OSI_SUPABASE_URL || ''); }
  function anonKey() { return String(window.OSI_SUPABASE_KEY || ''); }

  function cacheKey(path, body) {
    var stable = '';
    try { stable = JSON.stringify(body || {}); } catch (e) { stable = String(body); }
    return String(path) + '|' + stable;
  }
  function ttlFor(body, options) {
    if (options && typeof options.ttl === 'number') return options.ttl;
    var op = body && typeof body.op === 'string' ? body.op : '';
    return TTL_BY_OP[op] || 0;
  }

  function send(path, body, options) {
    var url = baseUrl() + '/functions/v1/' + path;
    var key = anonKey();
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = window.setTimeout(function () {
      if (controller) controller.abort();
    }, (options && options.timeout) || DEFAULT_TIMEOUT_MS);
    var request = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: 'Bearer ' + key
      },
      body: JSON.stringify(body || {})
    };
    if (controller) request.signal = controller.signal;
    return fetch(url, request).then(function (response) {
      return response.text().then(function (text) {
        return { response: response, text: text };
      });
    }).then(function (result) {
      var payload = null;
      try { payload = JSON.parse(result.text); } catch (e) { payload = null; }
      if (!result.response.ok || !payload || payload.ok !== true) {
        var failure = new Error((payload && payload.error) || 'public_read_unavailable');
        failure.status = result.response.status;
        throw failure;
      }
      return result.text;
    }).finally(function () {
      window.clearTimeout(timer);
    });
  }

  // Resolves with a freshly parsed copy of the response so one surface can
  // sort or annotate its rows without touching another surface's data.
  function publicRead(path, body, options) {
    options = options || {};
    var key = cacheKey(path, body);
    var ttl = ttlFor(body, options);
    var now = Date.now();
    if (options.fresh === true) {
      delete cache[key];
      delete inflight[key];
    } else if (ttl > 0) {
      var hit = cache[key];
      if (hit && (now - hit.at) < ttl) {
        try { return Promise.resolve(JSON.parse(hit.text)); } catch (e) { delete cache[key]; }
      }
    }
    if (inflight[key]) return inflight[key].then(function (text) { return JSON.parse(text); });
    var pending = send(path, body, options).then(function (text) {
      if (ttl > 0) cache[key] = { at: Date.now(), text: text };
      return text;
    }).finally(function () {
      if (inflight[key] === pending) delete inflight[key];
    });
    inflight[key] = pending;
    return pending.then(function (text) { return JSON.parse(text); });
  }

  // Called after every native write so the next read reflects the change.
  function invalidate(pathPrefix) {
    Object.keys(cache).forEach(function (key) {
      if (!pathPrefix || key.indexOf(String(pathPrefix)) === 0) delete cache[key];
    });
  }

  window.osiPublicRead = publicRead;
  window.osiPublicReadInvalidate = invalidate;
})();
