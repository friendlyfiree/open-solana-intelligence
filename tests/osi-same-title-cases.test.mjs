// Two public Cases can share a title (production holds two "Forward
// Industries" Cases). The registry has no merge transition and a public record
// is never rewritten, so the interface only tells them apart. These checks pin
// the neutral wording, the escaping and the Turkish coverage of that note.
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const source = read("assets/js/v2-case-integration.js");
const i18n = read("assets/js/03-i18n.js");
const turkish = i18n.slice(i18n.indexOf("  var turkish = {"), i18n.indexOf("  var translations = {"));
let passed = 0;
function ok(name, value) {
  if (!value) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}
const block = source.slice(source.indexOf("function titleKey("), source.indexOf("document.addEventListener('input',function(event){"));
const sentences = [
  "Same title as {count} other public Cases",
  "Same title as {ref}, opened {date}",
  "Same title as {ref}",
  "Another public Case has the same title. It opened {date}.",
  "Another public Case has the same title.",
  "Open {ref}",
  "A public Case with this title already exists: {ref}. Open it to check before filing a new Case.",
];
ok("titles are compared trimmed, case-insensitive and with whitespace collapsed",
  block.includes("String(value||'').trim().replace(/\\s+/g,' ').toLowerCase()"));
ok("only well-formed public refs are offered, never the Case itself",
  block.includes("isCaseRef(other.public_ref)&&other.public_ref!==exceptRef"));
ok("the drawer note appears only for a public Case", block.includes("item.visibility!=='public'"));
ok("the drawer note and the intake hint are built from text nodes",
  !/innerHTML/.test(block) && block.includes("text.textContent=") && block.includes("open.textContent="));
ok("the row note is escaped", source.includes("'<small class=\"osi-same-title\">'+esc(sameTitle)+'</small>'"));
ok("the notes read the shared public list instead of a new endpoint", block.includes("publicRead({op:'list_public_cases'})"));
ok("the intake hint never blocks submission", !/submit[^;]*disabled|setCustomValidity|preventDefault/.test(block));
ok("no note calls a Case a duplicate", sentences.every((text) => !/duplicate/i.test(text)) && !/duplicate/i.test(block.replace(/\/\/[^\n]*/g, "")));
ok("every note sentence is used and has a Turkish key",
  sentences.every((text) => source.includes(`'${text}'`) && turkish.includes(`'${text}':`)));
ok("a language switch redraws the rows and the notes",
  /osi:localechange[\s\S]*?drawCases\(\);[\s\S]*?paintSameTitle\(state\.current\);[\s\S]*?paintIntakeTitleHint\(\);/.test(source));
console.log(`\n${passed} same-title checks passed.`);
