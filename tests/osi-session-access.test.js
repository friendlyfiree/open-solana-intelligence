// Focused static contract tests for trusted wallet restore and maintainer auth.
// Run: node tests/osi-session-access.test.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const core = read('assets/js/50-core-supabase.js');
const wallet = read('assets/js/60-wallet-workspace.js');
const boot = read('assets/js/99-app.js');
const maintainer = read('assets/js/54-maintainer-console.js');
const html = read('index.html');

let assertions = 0;
function ok(value, message) {
  assertions += 1;
  if (!value) throw new Error('not ok ' + assertions + ' - ' + message);
  console.log('ok ' + assertions + ' - ' + message);
}

ok(boot.includes('connect({ onlyIfTrusted:true })'), 'page load uses Phantom trusted connect');
ok(!boot.includes('new browser session = manual connect'), 'restore is not limited to one session');
ok(wallet.includes("localStorage.getItem('osi_phantom_restore') !== '0'"), 'only a safe restore preference is persisted');
ok(wallet.includes("localStorage.setItem('osi_phantom_restore','1')"), 'explicit connection enables later trusted restore');
ok(read('assets/js/64-profile-xp.js').includes("localStorage.setItem('osi_phantom_restore','0')"), 'explicit disconnect disables automatic restore');
ok(wallet.includes('clearWalletAuthorization()'), 'wallet changes clear derived authorization');

ok(core.includes('window.supabase.createClient'), 'Supabase Auth uses the supported client session model');
ok(core.includes('autoRefreshToken:true'), 'Supabase Auth refreshes expiring access tokens');
ok(core.includes('persistSession:true'), 'Supabase Auth safely persists its session');
ok(core.includes('onAuthStateChange'), 'Supabase Auth state changes clear or restore access state');
ok(!core.includes("localStorage.setItem('SUPA_AUTH_TOKEN'"), 'application code never persists a raw access token itself');

ok(maintainer.includes('OSI_MAINTAINER_SERVER_GATE'), 'maintainer UI tracks the server-verified gate');
ok(maintainer.includes("data.maintainer_access===true"), 'server capabilities decide the full gate');
ok(maintainer.includes('isMaintainerWallet && passwordAuthenticated && OSI_MAINTAINER_SERVER_GATE'), 'wallet, auth session, and server verification are all required');
ok(maintainer.includes("setMaintainerServerGate(false,'signed_out')"), 'sign-out clears maintainer state');
ok(!maintainer.includes('MAINTAINER_AUTH_UUID'), 'maintainer auth UUID is not exposed to the frontend');

ok(html.includes('id="maintainerAccessMenu"'), 'Maintainer Access is present in the wallet menu');
ok(html.includes('id="admGateStatus"'), 'Operations Center shows both gate states');
ok(html.includes('RETRY'), 'Maintainer Access has a real retry control');

console.log('1..' + assertions);
