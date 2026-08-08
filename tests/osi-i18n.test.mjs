import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file), 'utf8');
const index = read('index.html');
const css = read('assets/css/70-intelligence-redesign.css');
const i18n = read('assets/js/03-i18n.js');
const caseUi = read('assets/js/v2-case-integration.js');
const reportUi = read('assets/js/v2-report-integration.js');
const analystUi = read('assets/js/v2-analyst-integration.js');
const wireUi = read('assets/js/v2-wire-integration.js');
const profileUi = read('assets/js/v2-profile-integration.js');

let passed = 0;
function ok(name, value) {
  if (!value) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}

ok('the root document keeps English as the safe default', index.includes('<html lang="en">'));
ok('the language runtime loads before the application modules',
  index.indexOf('assets/js/03-i18n.js') > index.indexOf('assets/js/02-route-styles.js')
    && index.indexOf('assets/js/03-i18n.js') < index.indexOf('assets/js/99-app.js'));
ok('the header exposes one native language selector',
  (index.match(/id="osi-language-select"/g) || []).length === 1
    && index.includes('<option value="en">EN</option>')
    && index.includes('<option value="tr">TR</option>'));
ok('the language selector is keyboard and screen-reader accessible',
  index.includes('for="osi-language-select"')
    && index.includes('aria-label="Select language"')
    && css.includes('.osi-language-control select:focus-visible'));
ok('the language preference uses one non-sensitive storage key',
  i18n.includes("var STORAGE_KEY = 'osi_language'")
    && !/sessionStorage|walletPubkey|private.?key|service.?role/i.test(i18n.slice(i18n.indexOf('function writeStoredLocale'), i18n.indexOf('function isIgnored'))));
ok('unsupported language values fail safely to English',
  i18n.includes("return SUPPORTED_LOCALES.indexOf(candidate) !== -1 ? candidate : DEFAULT_LOCALE"));
ok('the document language and metadata follow the selected locale',
  i18n.includes('document.documentElement.lang = currentLocale')
    && i18n.includes("description.setAttribute('content'")
    && i18n.includes("document.title = currentLocale === 'tr'"));
ok('dynamic interface content is translated without HTML injection',
  i18n.includes('new MutationObserver')
    && i18n.includes('node.nodeValue = next')
    && !i18n.includes('innerHTML =')
    && !i18n.includes('insertAdjacentHTML'));
ok('user-authored and code content can opt out of translation',
  i18n.includes('[data-osi-user-content]')
    && i18n.includes('[data-osi-i18n-ignore]')
    && i18n.includes('contenteditable="true"'));
ok('English originals are restored instead of reloading the application',
  i18n.includes('originalText.get(node)')
    && i18n.includes('originalAttributes.get(element)'));
ok('the locale API supports future dynamic modules',
  i18n.includes('window.OSI_I18N')
    && i18n.includes('window.osiT = t')
    && i18n.includes("'osi:localechange'"));
ok('the compact mobile wallet label follows the locale',
  css.includes('var(--osi-connect-compact-label, "Connect")')
    && i18n.includes("'--osi-connect-compact-label'"));
ok('the selector retains a 40 pixel touch target on mobile',
  css.includes('.osi-language-control select {')
    && css.includes('min-height: 40px'));
ok('Turkish safety copy preserves OSI process boundaries',
  i18n.includes('Otomatik gerçeklik kararı değil, süreç.')
    && i18n.includes('Hukuki tavsiye değildir.')
    && i18n.includes('Varlık saklama yok'));
ok('Turkish covers the new payment, SAS and private AI operations controls',
  i18n.includes("'Review exact mainnet transfer': 'Kesin mainnet transferini inceleyin'")
    && i18n.includes("'Pay with Solana Pay': 'Solana Pay ile öde'")
    && i18n.includes("'SAS Authority': 'SAS Yetkisi'")
    && i18n.includes("'Maintainer-only AI Pack': 'Yalnızca sürdürücüye açık AI Pack'"));
ok('Turkish covers dynamic Analyst profile and timestamped SAS authority copy',
  i18n.includes("'Server-derived weight': 'Sunucunun belirlediği ağırlık'")
    && i18n.includes("'Probationary': 'Deneme süreci'")
    && i18n.includes("'Support analyst with SOL': 'Analisti SOL ile destekle'")
    && i18n.includes("'No public contributions recorded': 'Kaydedilmiş kamusal katkı yok'")
    && i18n.includes("'SAS verified': 'SAS doğrulandı'")
    && i18n.includes("'SAS analyst review authority verified. Last checked {checked}. Read the Solana Attestation Service explanation.'"));

ok('Turkish covers persistent receipts, unified queue recovery, and connected Phantom payment copy',
  i18n.includes("'Saved successfully': 'Başarıyla kaydedildi'")
    && i18n.includes("'Open review queue': 'İnceleme kuyruğunu aç'")
    && i18n.includes("'Refresh private access': 'Özel erişimi yenile'")
    && i18n.includes("'Use connected Phantom': 'Bağlı Phantom’u kullan'")
    && i18n.includes("'Finalized payment receipt': 'Kesinleşmiş ödeme makbuzu'")
    && i18n.includes("'Maintainer bootstrap (cold-start) decision. Not an independent analyst quorum outcome.'")
    && i18n.includes("'Conflict: this exact governance action is unavailable to this wallet.'"));
ok('optional Report evidence copy is non-contradictory in both locales',
  i18n.includes("'Evidence references are recommended and can strengthen review. Add up to 12 total references when useful. Blank lines are ignored.'")
    && !i18n.includes('Add at least one and no more than 12 total references.'));
ok('Turkish covers Case drawer system chrome and Public Records copy feedback',
  [
    "'Overview': 'Genel Bakış'",
    "'Initial Review': 'İlk İnceleme'",
    "'Created': 'Oluşturuldu'",
    "'Summary': 'Özet'",
    "'Submit Report': 'Rapor Gönder'",
    "'Copy transaction signature {signature}': '{signature} işlem imzasını kopyala'",
    "'Copied': 'Kopyalandı'",
  ].every((marker) => i18n.includes(marker)));
ok('Case drawer localizes generated chrome while preserving submitted content',
  caseUi.includes('esc(t(tab[1]))')
    && caseUi.includes("esc(t('Case overview'))")
    && caseUi.includes("esc(t('Created'))")
    && caseUi.includes("esc(t('Submit Report'))")
    && caseUi.includes('caseProse(item.summary)')
    && caseUi.includes('data-osi-user-content'));
ok('dynamic system copy uses the locale API while user-authored content opts out',
  caseUi.includes("t('One queue, eight server-authorized lanes. Errors never become empty results.')")
    && reportUi.includes('data-osi-user-content')
    && analystUi.includes('data-osi-user-content')
    && wireUi.includes('data-osi-user-content'));
ok('Turkish covers private/public profile and Case attribution decisions',
  i18n.includes("'My Profile': 'Profilim'")
    && i18n.includes("'Private': 'Gizli'")
    && i18n.includes("'Attribute my current and future public Cases to this profile'")
    && i18n.includes("'Community submitter': 'Topluluk göndereni'"));
ok('profile user content is escaped and excluded from mutation translation',
  profileUi.includes('data-osi-user-content')
    && profileUi.includes('esc(profile.bio)')
    && profileUi.includes("esc(t('Privacy and Case attribution'))"));

console.log(`\n${passed} localization checks passed.`);
