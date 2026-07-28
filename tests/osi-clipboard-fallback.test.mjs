import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const identity = fs.readFileSync(
  new URL("../assets/js/30-analysts-identity.js", import.meta.url),
  "utf8",
);
const helper = identity.slice(
  identity.indexOf("function osiCopyText"),
  identity.indexOf("function cvCopy"),
);

function contextFor({ clipboard, commandResult = true } = {}) {
  const state = { appended: 0, removed: 0, commands: 0 };
  const textarea = {
    parentNode: {
      removeChild() { state.removed++; },
    },
    setAttribute() {},
    style: {},
    select() {},
    setSelectionRange() {},
    value: "",
  };
  const context = vm.createContext({
    navigator: clipboard === undefined ? {} : { clipboard },
    document: {
      body: {
        appendChild() { state.appended++; },
      },
      createElement(name) {
        assert.equal(name, "textarea");
        return textarea;
      },
      execCommand(command) {
        assert.equal(command, "copy");
        state.commands++;
        return commandResult;
      },
    },
    Promise,
    Error,
  });
  vm.runInContext(helper, context);
  return { context, state, textarea };
}

let passed = 0;
async function ok(name, test) {
  await test();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

await ok("Clipboard API success reports copied without invoking the fallback", async () => {
  const { context, state } = contextFor({
    clipboard: { writeText: async () => {} },
  });
  assert.equal(await context.osiCopyText("wallet"), true);
  assert.equal(state.commands, 0);
});

await ok("Clipboard API rejection uses a working textarea fallback", async () => {
  const { context, state, textarea } = contextFor({
    clipboard: { writeText: async () => { throw new Error("denied"); } },
  });
  assert.equal(await context.osiCopyText("signature"), true);
  assert.equal(textarea.value, "signature");
  assert.equal(state.commands, 1);
  assert.equal(state.appended, 1);
  assert.equal(state.removed, 1);
});

await ok("Unavailable clipboard reports failure when the fallback is rejected", async () => {
  const { context, state } = contextFor({ commandResult: false });
  assert.equal(await context.osiCopyText("memo"), false);
  assert.equal(state.commands, 1);
});

await ok("All active copy consumers wait for the verified copy result", async () => {
  const consumers = [
    "assets/js/30-analysts-identity.js",
    "assets/js/40-wire-field.js",
    "assets/js/64-profile-xp.js",
    "assets/js/74-community-cases.js",
    "assets/js/84-public-records.js",
  ].map((path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
  for (const source of consumers) {
    assert.match(source, /osiCopyText\([^)]*\)\.then\(function\(copied\)/);
  }
});

console.log(`OK (${passed} assertions passed)`);
