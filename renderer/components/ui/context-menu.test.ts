import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Amber and red mean different things, and a menu that confuses them tells the
// operator the wrong story at the moment it matters most.
//
//   warn (amber)   — caution: unsaved changes, an integration that is offline.
//                    Something to notice, and you can proceed through it.
//   danger (red)   — destructive: this deletes something. The last step before
//                    losing work.
//
// Delete highlighted AMBER, which reads as a warning you can walk past.

const SRC = readFileSync(new URL("./context-menu.tsx", import.meta.url), "utf8");

describe("destructive menu items use the danger colour", () => {
  test("the danger branch resolves to danger, not warn", () => {
    const m = SRC.match(/item\.danger\s*\?\s*"([^"]+)"/);
    assert.ok(m, "the danger branch must exist");
    assert.match(m[1], /danger/, `destructive hover must use a danger token, got: ${m[1]}`);
    assert.doesNotMatch(m[1], /warn/, "warn is caution, not destruction");
  });
});

describe("a menu item's click actually reaches it", () => {
  // THE bug: the dismiss-on-outside-click listener runs in the CAPTURE phase, so
  // an unfiltered close() fired on the pointerdown of a click on a menu ITEM and
  // unmounted the menu before the click could reach the button. Every item
  // looked normal, hovered normally, and did nothing.
  test("the dismiss listener ignores pointerdowns inside the menu", () => {
    const body = SRC.slice(SRC.indexOf("const close ="), SRC.indexOf("const onKey ="));
    assert.match(body, /ref\.current\?\.contains\(/, "close() must ignore events from inside the menu");
    assert.match(body, /return;/, "and return without closing");
  });

  test("it is still bound in the capture phase", () => {
    // Capture is deliberate: it must close before the canvas beneath acts on the
    // same click, so dismissing never also starts a selection.
    assert.match(SRC, /addEventListener\("pointerdown", close, true\)/);
  });
});

describe("nothing else confuses the two", () => {
  // Walked recursively, so a new component joins this check by existing rather
  // than by someone remembering to add it here.
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...sources(full));
      else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(full);
    }
    return out;
  }

  test("no warn token is used on a delete or remove control", () => {
    const ROOT = new URL("../../", import.meta.url).pathname;
    const offenders: string[] = [];
    for (const f of sources(ROOT)) {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        // The pairing is the defect: a warn colour on the same element as a
        // destructive verb. Either alone is fine.
        if (/\bwarn-\d/.test(line) && /\b(Delete|Remove|Trash|destructive)\b/i.test(line)) {
          offenders.push(`${f.replace(ROOT, "")}: ${line.trim().slice(0, 90)}`);
        }
      }
    }
    assert.deepEqual(offenders, [], "destructive controls must use danger, not warn");
  });
});
