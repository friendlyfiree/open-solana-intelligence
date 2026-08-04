// Documentation integrity.
//
// OSI's public claim is that anything it asserts can be checked. That standard
// has to apply to the documentation too, otherwise the verification path a
// reader is pointed down ends at a 404 and the claim quietly becomes trust.
//
// This suite holds the docs to the same rules the product obeys:
//
//   * every internal link resolves to a file that exists;
//   * the on-chain identifiers a reader is told to check are identical in
//     every place they appear, so no page can send someone to the wrong
//     account;
//   * the maintainer track record's headline counts equal the number of
//     pieces of evidence actually listed underneath them;
//   * the English and Turkish entry points stay reachable from each other;
//   * house style holds.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
let passed = 0;
function ok(name, condition) {
  assert.equal(Boolean(condition), true, name);
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

const markdownFiles = [
  "README.md",
  "README.tr.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  ...fs.readdirSync(path.join(root, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => `docs/${name}`),
];

// 1. Every internal link resolves.
const broken = [];
for (const file of markdownFiles) {
  const source = read(file);
  const dir = path.dirname(path.join(root, file));
  for (const match of source.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const [pathPart] = target.split("#");
    if (!pathPart) continue;
    if (!fs.existsSync(path.resolve(dir, pathPart))) broken.push(`${file} -> ${target}`);
  }
}
ok(`every internal documentation link resolves (${markdownFiles.length} files checked)`,
  broken.length === 0 || assert.fail(`broken links:\n${broken.join("\n")}`));

// 2. The identifiers a reader is told to verify are the same everywhere.
// A reader who checks the wrong account has been misled just as effectively as
// one who was given no account at all.
const ONCHAIN = {
  "SAS program": "22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG",
  "OSI Credential": "D2tsrEHEXYPL82chv5PuwsQtALv1i5hXrWZorqyefJgX",
  "OSI_VERIFIED_ANALYST schema": "897TYTVN9aQfLWj2BJyhByQawsSuydLZcTpanZWCtxKz",
};
const publicSurface = ["README.md", "README.tr.md", "docs/VERIFY.md"].map(read).join("\n");
for (const [label, address] of Object.entries(ONCHAIN)) {
  ok(`the published ${label} address is present and unambiguous`,
    publicSurface.includes(address));
}
// A base58 pubkey that appears in the verification guide but is not one of the
// documented accounts, an analyst wallet, or the issuer is a typo waiting to
// send someone to the wrong place.
const KNOWN_KEYS = new Set([
  ...Object.values(ONCHAIN),
  "FcwxSJJY6x7K4fPBzTVVtvaeYpg3E472ZNXL97aFmUkG",
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
]);
const verifyGuide = read("docs/VERIFY.md");
const strayKeys = [...verifyGuide.matchAll(/\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/g)]
  .map((match) => match[0])
  .filter((key) => !KNOWN_KEYS.has(key));
ok("the verification guide contains no unexplained base58 account key",
  strayKeys.length === 0 || assert.fail(`unexplained keys: ${strayKeys.join(", ")}`));

// 2b. The default-deny proof in the verification guide names tables that exist.
//
// This check exists because the guide once told readers to expect 401 from a
// table called `reports_v2`, which has never existed. Production answered 404,
// and a reader following the page step by step got a result the page did not
// predict. On a project whose entire claim is "check it yourself", a
// verification instruction that does not reproduce is worse than no
// instruction: it spends the reader's trust rather than earning it.
const schemaSql = read("supabase/migrations/20260711092711_osi_v2_additive_schema.sql");
const declaredTables = new Set(
  [...schemaSql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)/gi)]
    .map((match) => match[1].toLowerCase()));
ok(`the V2 additive schema declares its domain tables (${declaredTables.size} found)`,
  declaredTables.size >= 30 && declaredTables.has("cases") && declaredTables.has("event_receipts"));

// The guide's loop spans several backslash-continued lines; join them first.
const denyLoop = verifyGuide.replace(/\\\n\s*/g, " ").match(/for\s+T\s+in\s+([^;]+?);\s*do/);
ok("the verification guide contains a default-deny table loop", Boolean(denyLoop));
const denyTables = (denyLoop?.[1] || "").trim().split(/\s+/).filter(Boolean);
const undeclared = denyTables.filter((name) => !declaredTables.has(name.toLowerCase()));
ok(`every table the guide tells a reader to probe actually exists (${denyTables.length} probed)`,
  denyTables.length >= 5
  && (undeclared.length === 0
    || assert.fail(`the guide names tables that are not in the schema: ${undeclared.join(", ")}`)));

// The frozen V1 tables answer 200 with an empty array. Putting one of them in a
// list captioned "expect 401 on all of these" would manufacture a false
// failure in the reader's terminal.
const V1_LEGACY_TABLES = ["reports", "analysts", "profiles", "vouches", "requests", "bounty_boosts", "config"];
const leakedLegacy = denyTables.filter((name) => V1_LEGACY_TABLES.includes(name.toLowerCase()));
ok("the default-deny loop contains no frozen V1 table that would answer 200",
  leakedLegacy.length === 0 || assert.fail(`V1 tables in the deny list: ${leakedLegacy.join(", ")}`));
ok("the guide warns about the V1 tables that do answer 200, rather than leaving them to surprise a reader",
  V1_LEGACY_TABLES.every((name) => new RegExp(`\`${name}\``).test(verifyGuide))
  && /looks like a failure and is not/i.test(verifyGuide));

// 3. The track record's counts equal the evidence listed under them.
const proofOfWork = read("docs/PROOF_OF_WORK.md");
const sections = proofOfWork.split(/^# Appendix /m);
const countLinks = (text, pattern) => (text.match(pattern) || []).length;
const bountyLinks = countLinks(sections[1] || "", /arkm\.com\/explorer\/tx\//g);
const salesLinks = countLinks(sections[2] || "", /arkm\.com\/explorer\/tx\//g);
const listingLinks = countLinks(sections[3] || "", /arkm\.com\/marketplace\/listings\//g);
ok(`bounty payout count matches the transactions listed (${bountyLinks})`,
  bountyLinks === 54 && /\| 54 \|/.test(proofOfWork));
ok(`paid report sale count matches the transactions listed (${salesLinks})`,
  salesLinks === 26 && /\| 26 \|/.test(proofOfWork));
ok(`marketplace listing count matches the listings shown (${listingLinks})`,
  listingLinks === 8 && /\| 8 \|/.test(proofOfWork));
ok("the track record discloses its own lost submission rather than omitting it",
  /Disclosure on the X ICOs submission/.test(proofOfWork));

// 4. Network status is stated, not implied, and both entry points carry it.
const readme = read("README.md");
const readmeTr = read("README.tr.md");
ok("the README states the real network size instead of describing it",
  /0 publications through an independent analyst quorum/.test(readme)
  && readme.includes("docs/NETWORK_STATUS.md"));
ok("the Turkish README carries the same network statement",
  /bağımsız analist yeter sayısı ile 0 yayımlama/.test(readmeTr)
  && readmeTr.includes("docs/NETWORK_STATUS.md"));
ok("network status records the bootstrap channel rather than hiding it",
  /maintainer_bootstrap/.test(read("docs/NETWORK_STATUS.md")));

// 5. The two entry points stay reachable from each other.
ok("English and Turkish entry points cross-link",
  readme.includes("README.tr.md") && readmeTr.includes("README.md"));

// 6. The problem statement carries a number and a citable source.
for (const [label, source] of [["README.md", readme], ["README.tr.md", readmeTr]]) {
  ok(`${label} states the problem with a figure and a named source`,
    /chainalysis\.com\/blog\/crypto-hacking-stolen-funds-2026/.test(source)
    && /ic3\.gov\/AnnualReport/.test(source)
    && /26,500|26\.500/.test(source));
}

// 7. A named subject is told how to answer, and it does not require a wallet.
const rightOfReply = read("docs/RIGHT_OF_REPLY.md");
ok("the right-of-reply route for someone without a wallet is explicit",
  /You do not need a wallet, an account, or a\s+lawyer/.test(rightOfReply));
ok("erasure is reconciled with append-only storage rather than left contradictory",
  /Personal data, immutability, and erasure/.test(rightOfReply)
  && /never putting personal data\s+where it cannot be reached/.test(rightOfReply));

// 8. House style, on the reader-facing set.
//
// The `docs/OSI_V2_*` blueprints predate this rule and are specification
// documents rather than reader copy, so they are deliberately out of scope
// here. Everything a person actually lands on is in scope.
const READER_FACING = [
  "README.md",
  "README.tr.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "docs/ARCHITECTURE.md",
  "docs/USER_GUIDE.md",
  "docs/SELF_HOSTING.md",
  "docs/VERIFY.md",
  "docs/NETWORK_STATUS.md",
  "docs/PROOF_OF_WORK.md",
  "docs/RIGHT_OF_REPLY.md",
  "docs/OSI_PRODUCTION_FEATURE_STATUS.md",
];
for (const file of READER_FACING) {
  ok(`${file} contains no em dash`, !/—|&mdash;|&#8212;/.test(read(file)));
}

process.stdout.write(`Documentation integrity tests: ${passed} passed\n`);
