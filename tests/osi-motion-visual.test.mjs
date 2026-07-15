import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const require = createRequire(import.meta.url);
const intent = require("../assets/js/93-navigation-intent.js");
const html = read("index.html");
const css = read("assets/css/70-intelligence-redesign.css");
const shell = read("assets/js/94-navigation-shell.js");
const signal = read("assets/js/95-signal-interactions.js");
let passed = 0;
function ok(name, condition) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}

function harness(canHover = true) {
  let nextId = 0;
  const timers = new Map();
  const events = [];
  let opened = false;
  const controller = intent.create({
    openDelay: 100,
    closeDelay: 220,
    canHover: () => canHover,
    isOpen: () => opened,
    open: () => { opened = true; events.push("open"); },
    close: () => { opened = false; events.push("close"); },
    setTimer(fn, delay) { const id = ++nextId; timers.set(id, { fn, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  return {
    controller,
    events,
    timers,
    fire(delay) {
      const pending = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      if (!pending) throw new Error(`No pending ${delay}ms timer`);
      timers.delete(pending[0]);
      pending[1].fn();
    },
  };
}

const mouse = harness();
mouse.controller.pointerEnter("mouse");
ok("desktop hover uses a real 100ms intent timer", mouse.events.length === 0 && [...mouse.timers.values()][0].delay === 100);
mouse.fire(100);
ok("desktop hover opens only after intent resolves", mouse.events.join() === "open");
mouse.controller.pointerLeave("mouse");
ok("desktop leave uses a real 220ms safety timer", mouse.events.length === 1 && [...mouse.timers.values()][0].delay === 220);
mouse.controller.pointerEnter("mouse");
ok("moving back into the menu cancels close", mouse.timers.size === 0 && mouse.events.join() === "open");
mouse.controller.cancel();
ok("click, resize and explicit close can cancel all hover work", mouse.timers.size === 0);

const touch = harness();
touch.controller.pointerEnter("touch");
touch.controller.pointerLeave("touch");
ok("touch never gains hover-only behavior", touch.events.length === 0 && touch.timers.size === 0);
const coarse = harness(false);
coarse.controller.pointerEnter("mouse");
ok("coarse pointers ignore mouse-style hover intent", coarse.timers.size === 0);

for (const state of ["WALLET_SIGNED", "REVIEW_QUORUM", "CHALLENGE_WINDOW", "MEMO_ANCHORED", "SOL_TRANSFER_VERIFIED"]) {
  ok(`hero exposes truthful ${state} lifecycle state`, html.includes(`<strong>${state}</strong>`));
}
ok("hero lifecycle is accessible inline SVG and real HTML", html.includes('class="osi-proof-map"') && html.includes('role="img"') && html.includes('class="osi-proof-state-sequence"'));
ok("lifecycle motion has a complete reduced-motion state", css.includes("@media (prefers-reduced-motion: reduce)") && css.includes("stroke-dasharray: none"));
ok("responsive action surface has four, two and one column modes", css.includes("repeat(4, minmax(0, 1fr))") && css.includes("repeat(2, minmax(0, 1fr))") && /\.osi-action-matrix\s*\{\s*grid-template-columns:\s*1fr;/s.test(css));
ok("final design layer contains no orange identity or transition-all debt", !/(#f97316|#ff6b|#ea58|orange|transition\s*:\s*all)/i.test(css.replace(/--orange2?:\s*var\([^;]+;/g, "")));
ok("final design layer avoids unreadable 9px microcopy", !/font-size:\s*(?:8|9)(?:\.\d+)?px/i.test(css));
ok("keyboard focus, click, Escape, outside click and focus return remain wired", shell.includes("osi-keyboard-input") && shell.includes("ArrowDown") && shell.includes("event.key === 'Escape'") && shell.includes("platformTrigger.focus()") && shell.includes("pointerdown"));
ok("touch and mobile focus trap remain part of the same navigation", shell.includes("trapMobileFocus") && shell.includes("nav-open") && html.includes('aria-controls="global-nav"'));
ok("workspace routes mark Platform as the current navigation group", shell.includes("platformViews") && shell.includes("platformTrigger.setAttribute('aria-current', 'page')"));
ok("pointer illumination is motion-safe and frame-throttled", signal.includes("prefers-reduced-motion: reduce") && signal.includes("(pointer: fine)") && signal.includes("requestAnimationFrame"));
ok("section reveals progressively enhance behind an opt-in root class", signal.includes("IntersectionObserver") && signal.includes("section.classList.add('is-visible')") && signal.includes("classList.add('osi-signal-ready')") && css.includes(".osi-signal-ready [data-signal-reveal]:not(.osi-home-hero)"));
ok("reduced motion makes every reveal immediately visible", /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\[data-signal-reveal\]:not\(\.osi-home-hero\)[\s\S]*?opacity:\s*1;/s.test(css));

console.log(`\n${passed} motion, navigation and visual checks passed.`);
