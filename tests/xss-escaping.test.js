// Dependency-free regression test for the client HTML/attribute escapers.
// Run: node tests/xss-escaping.test.js   (exit 0 = pass)
//
// Guards the fixes in the hard-audit stage:
//   - crAttr must be safe inside a double-quoted on* attribute (no raw " < >
//     may survive, both JS-string delimiters neutralised) AND must round-trip
//     legitimate values to the handler argument.
//   - escapeHtml must neutralise all five HTML-significant characters.
// These are string-level invariants, so no browser/deps are needed.
const fs = require('fs');
const path = require('path');

function loadFn(file, name) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error(name + ' not found in ' + file);
  // brace-match the function body
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  // eslint-disable-next-line no-eval
  return eval('(' + src.slice(start, end).replace('function ' + name, 'function') + ')');
}

const crAttr = loadFn('assets/js/84-public-records.js', 'crAttr');
const escapeHtml = loadFn('assets/js/50-core-supabase.js', 'escapeHtml');
const escapeV2Case = loadFn('assets/js/v2-case-integration.js', 'esc');
const escapeV2Wire = loadFn('assets/js/v2-wire-integration.js', 'esc');

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; } else { fail++; console.log('FAIL ' + n + (extra ? ' :: ' + extra : '')); } };

// Simulate: HTML-attribute-decode then evaluate the JS string literal, to model
// what the browser hands the on* handler. Only entities relevant here.
function htmlAttrDecode(s) {
  return s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function jsStringValue(literalInner, delim) {
  // literalInner is the content between the delimiters; unescape \\ \' \" and \x
  // eslint-disable-next-line no-eval
  return eval(delim + literalInner + delim);
}

const payloads = [
  'a" onmouseover="alert(1)',
  "a' onmouseover='alert(1)",
  '"><img src=x onerror=alert(1)>',
  'x&quot;);alert(1)//',
  '</script><script>alert(1)</script>',
  'plain_id_123',
  '5xY5kLmNpQrStUvWxYz1234',
  'Acme & Sons "Ltd" <trace>',
];

for (const p of payloads) {
  const a = crAttr(p);
  // Safety invariant 1: no raw double-quote survives (would break a "-attr).
  ok('crAttr no raw double-quote: ' + JSON.stringify(p), a.indexOf('"') === -1, JSON.stringify(a));
  // Safety invariant 2: no raw < or > (can't start a tag inside the attribute).
  ok('crAttr no raw </>: ' + JSON.stringify(p), a.indexOf('<') === -1 && a.indexOf('>') === -1, JSON.stringify(a));

  // Round-trip through both attribute patterns used in the codebase.
  // Pattern A: onclick="f(&quot;VALUE&quot;)"  (JS string delimited by ")
  const decodedA = htmlAttrDecode('f(&quot;' + a + '&quot;)');
  const innerA = decodedA.slice('f("'.length, -2); // strip f(" ... ")
  const valA = jsStringValue(innerA, '"');
  // Pattern B: onclick="f('VALUE')"           (JS string delimited by ')
  const decodedB = htmlAttrDecode("f('" + a + "')");
  const innerB = decodedB.slice("f('".length, -2);
  const valB = jsStringValue(innerB, "'");
  ok('crAttr round-trips (A): ' + JSON.stringify(p), valA === p, JSON.stringify(valA));
  ok('crAttr round-trips (B): ' + JSON.stringify(p), valB === p, JSON.stringify(valB));
}

// escapeHtml covers all five significant chars.
ok('escapeHtml full coverage', escapeHtml('<>&"\'') === '&lt;&gt;&amp;&quot;&#39;', escapeHtml('<>&"\''));
ok('V2 Case rendering escapes all HTML-significant characters',
  escapeV2Case('<img src=x onerror="alert(1)">\'&') ===
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;',
  escapeV2Case('<img src=x onerror="alert(1)">\'&'));
ok('published V2 Wire rendering escapes all HTML-significant characters',
  escapeV2Wire('<svg onload="alert(2)">\'&') ===
    '&lt;svg onload=&quot;alert(2)&quot;&gt;&#39;&amp;',
  escapeV2Wire('<svg onload="alert(2)">\'&'));

console.log((fail ? 'FAILED: ' + fail : 'OK') + ' (' + pass + ' assertions passed, ' + fail + ' failed)');
process.exit(fail ? 1 : 0);
