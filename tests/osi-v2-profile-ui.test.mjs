import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file), 'utf8');
const index = read('index.html');
const profile = read('assets/js/v2-profile-integration.js');
const cases = read('assets/js/v2-case-integration.js');
const navigation = read('assets/js/94-navigation-shell.js');
const css = read('assets/css/v2-profile-integration.css');
const i18n = read('assets/js/03-i18n.js');

let passed = 0;
function ok(name, value) {
  if (!value) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}
function functionSlice(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = nextName ? source.indexOf(`function ${nextName}(`, start + 1) : source.length;
  if (start < 0 || end < 0) throw new Error(`Function slice missing: ${name}`);
  return source.slice(start, end);
}

ok('My Profile style and runtime load in the root application',
  index.includes('assets/css/v2-profile-integration.css')
    && index.includes('assets/js/v2-profile-integration.js'));
ok('the wallet menu reaches one general owner profile',
  index.includes('onclick="osiV2OpenMyProfile();closeWalletMenu();">My Profile</button>')
    && !index.includes('>My Analyst Profile</button>'));
ok('owner reads use the exact profile self scope',
  profile.includes("osiV2ReadSession(['profile:self']")
    && profile.includes("osiV2RefreshReadSession(['profile:self'])")
    && profile.includes("op:'get_my_profile'"));
ok('profile wallet lookup is centralized on the canonical connected-wallet state',
  profile.includes("function connectedWallet(){return String(typeof walletPubkey==='undefined'?'':walletPubkey||'');}"));
ok('owner writes use prepare sign commit with the existing signing client',
  profile.includes("op:'prepare_profile_update'")
    && profile.includes('window.osiV2ApproveMessage(prepared.message)')
    && profile.includes("op:'commit_profile_update'"));
ok('new profiles and Case attribution fail private by default',
  profile.includes("return selected?selected.value:'private'")
    && profile.includes("attribute_public_cases:visibility()==='public'"));
ok('retroactive and future Case attribution requires explicit consent copy',
  profile.includes('Attribute my current and future public Cases to this profile')
    && profile.includes('Explicit consent applies retroactively to public Cases you already submitted'));
ok('avatar gates match the server size, MIME and dimension contract',
  profile.includes("['image/png','image/jpeg']")
    && profile.includes('file.size>524288')
    && profile.includes('dimensions.width<64')
    && profile.includes('dimensions.width>1024'));
ok('avatar controls disclose content-addressed public URL retention before upload',
  profile.includes('Replacing or removing an image stops its current display.')
    && profile.includes('previously shared public image URL may remain reachable')
    && profile.includes('aria-describedby="osi-profile-avatar-help osi-profile-avatar-retention osi-profile-avatar-error"'));
ok('profile states remain honest across loading, error, disabled and success paths',
  profile.includes('osi-profile-loading')
    && profile.includes('My Profile is unavailable')
    && profile.includes('Profile updates are currently disabled')
    && profile.includes('Profile saved. Your visibility and Case attribution choices are now current.'));
ok('published handles are not offered as editable',
  profile.includes('profile.handle_locked===true')
    && profile.includes('This username cannot be renamed after its first publication.')
    && profile.includes("handleLocked?' disabled':''"));
ok('analyst authority and maintainer operator identity stay outside the owner payload',
  profile.includes('Analyst authority stays separate')
    && profile.includes('Maintainer operator profile stays separate')
    && !functionSlice(profile, 'formPayload', 'syncPrivacy').match(/expertise|review_weight|analyst_status|public_links|maintainer/));
ok('private mode discloses the separate public analyst identity mirror',
  profile.includes('Your wallet profile stays owner-only. General identity fields you save also update your separate public analyst profile.')
    && profile.includes('even when this wallet profile is private')
    && i18n.includes('ayrı kamusal analist profilinizi de günceller'));
ok('public profile reads are shareable by public ref or handle',
  profile.includes("op:'get_public_profile'")
    && profile.includes("'#profile/'+encodeURIComponent(parsed.route)")
    && navigation.includes('function walletProfileRoute(hash)')
    && navigation.includes('window.osiV2OpenPublicProfile(walletProfileRef, { history: true })'));
ok('public profile rendering never prints the gateway wallet field',
  !functionSlice(profile, 'renderPublicProfile', 'authorityNote').match(/\.wallet|wallet\]/)
    && profile.includes('OSI does not expose the profile wallet or private Case data.'));
ok('Case cards and detail use public submitter projection with a neutral fallback',
  cases.includes('item.submitter_profile')
    && cases.includes("t('Community submitter')")
    && cases.includes('submitterIdentity(item,false)')
    && cases.includes('submitterIdentity(item,true)'));
ok('only a valid public profile reference creates an interactive Case identity',
  cases.includes('/^OSI-PRF-[A-F0-9]{16}$/.test')
    && cases.includes('data-public-wallet-profile=')
    && cases.includes('window.osiV2OpenPublicProfile(publicRef)'));
ok('Case submitter rendering never reads wallet or UUID identity fields',
  !functionSlice(cases, 'submitterIdentity', 'referenceRow').match(/submitted_by|owner_wallet|\.wallet|auth_uuid|user_uuid/i));
ok('profile CSS defines every scoped compatibility token it consumes',
  ['--card:', '--card2:', '--line-strong:', '--radius:', '--radius-sm:', '--radius-lg:', '--input:', '--acc-dim:', '--success:']
    .every((token) => css.includes(token)));
ok('profile CSS keeps responsive and keyboard-visible contracts',
  css.includes('@media (max-width:820px)')
    && css.includes('@media (max-width:520px)')
    && css.includes(':focus-visible')
    && css.includes('min-height:44px'));
ok('Turkish includes profile privacy, attribution and public submitter chrome',
  i18n.includes("'My Profile': 'Profilim'")
    && i18n.includes("'Private': 'Gizli'")
    && i18n.includes("'Community submitter': 'Topluluk göndereni'")
    && i18n.includes("'This username cannot be renamed after its first publication.'"));

console.log(`\n${passed} wallet profile UI checks passed.`);
