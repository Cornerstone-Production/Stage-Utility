import assert from "node:assert/strict";
import { after, test, describe } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { installDom } from "../../test-dom.js";

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

// installDom() first, then the DOM-dependent modules by dynamic import — same
// order attendance-trend-chart.test.tsx uses and for the same reason: a static
// import of React/testing-library would evaluate before the DOM exists.
const teardown = installDom();
const { render, cleanup, fireEvent } = await import("@testing-library/react");
const { ContextMenu } = await import("./context-menu.js");

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

// ── The submenu flip ─────────────────────────────────────────────────────
//
// The ternary this guards had two IDENTICAL branches, so every submenu always
// opened right regardless of room. A test that only checked "the submenu
// carries a class" would have passed against that broken ternary too — a
// hard-coded "left-full" is still "a class." These read the RESOLVED side —
// which class actually won — against a viewport engineered to have no room
// on the side the bug always picked.
describe("a submenu flips to whichever side actually has room", () => {
  const rect = (left: number, top: number, width: number, height: number) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  });

  /** What the submenu panel's own box reports, set per test. Everything else
   *  (the root menu's fixed container, each MenuList) answers a small
   *  on-screen box, so the ROOT menu's own — already-correct — flip never
   *  triggers and cannot be confused with the one under test here. */
  let panel = { left: 0, top: 0, width: 200, height: 100 };

  function stubRects(): () => void {
    const real = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect")!;
    Object.defineProperty(Element.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: Element) {
        const isSubmenuPanel = this instanceof HTMLElement && this.className.includes("z-10");
        return isSubmenuPanel ? rect(panel.left, panel.top, panel.width, panel.height) : rect(40, 40, 200, 100);
      },
    });
    return () => Object.defineProperty(Element.prototype, "getBoundingClientRect", real);
  }

  /** Hover the "Metric" row to open its submenu, and return the resolved
   *  panel element (the "absolute z-10" wrapper SubmenuItem renders once
   *  open) — its className says which side won. */
  function openSubmenu(container: HTMLElement): HTMLElement {
    const trigger = [...container.querySelectorAll('button[role="menuitem"]')].find((b) =>
      b.textContent?.includes("Metric"),
    );
    assert.ok(trigger, 'no "Metric" row to hover');
    fireEvent.mouseEnter(trigger!.parentElement!);
    const submenu = container.querySelector<HTMLElement>(".z-10");
    assert.ok(submenu, "hovering the row did not open a submenu");
    return submenu!;
  }

  // The long list from the maintainer's own screenshot — a Smaart rig with
  // several bands reports several metrics, which is also what makes the
  // submenu tall enough to run off the BOTTOM, not just the side.
  const items = [
    {
      label: "Metric",
      items: ["LAeq", "LAeq10", "SPL A Slow", "SPL C Fast", "Peak", "RT60", "STI"].map((m) => ({ label: m })),
    },
  ];

  test("opens LEFT when there is no room on the right", (t) => {
    const restore = stubRects();
    t.after(() => {
      restore();
      cleanup();
    });
    // Right edge at 900 + 200 = 1100, past 1024 - 8.
    panel = { left: 900, top: 40, width: 200, height: 100 };
    const { container } = render(<ContextMenu x={20} y={20} items={items} onClose={() => {}} />);

    const submenu = openSubmenu(container);
    assert.ok(
      submenu.className.includes("right-full"),
      `expected right-full (opens toward the left), got: ${submenu.className}`,
    );
    assert.ok(!submenu.className.includes("left-full"), "still carries the class for the side with no room");
  });

  test("opens RIGHT when there is room", (t) => {
    const restore = stubRects();
    t.after(() => {
      restore();
      cleanup();
    });
    // Right edge at 100 + 200 = 300, well inside 1024.
    panel = { left: 100, top: 40, width: 200, height: 100 };
    const { container } = render(<ContextMenu x={20} y={20} items={items} onClose={() => {}} />);

    const submenu = openSubmenu(container);
    assert.ok(
      submenu.className.includes("left-full"),
      `expected left-full (opens toward the right), got: ${submenu.className}`,
    );
  });

  test("opens UP when there is no room below", (t) => {
    const restore = stubRects();
    t.after(() => {
      restore();
      cleanup();
    });
    // Bottom edge at 700 + 200 = 900, past 768 - 8 — the long metric list.
    panel = { left: 100, top: 700, width: 200, height: 200 };
    const { container } = render(<ContextMenu x={20} y={20} items={items} onClose={() => {}} />);

    const submenu = openSubmenu(container);
    assert.ok(submenu.className.includes("bottom-0"), `expected bottom-0 (opens upward), got: ${submenu.className}`);
    assert.ok(!submenu.className.includes("top-0"), "still carries the class for the side with no room");
  });

  test("opens DOWN when there is room below", (t) => {
    const restore = stubRects();
    t.after(() => {
      restore();
      cleanup();
    });
    panel = { left: 100, top: 40, width: 200, height: 100 };
    const { container } = render(<ContextMenu x={20} y={20} items={items} onClose={() => {}} />);

    const submenu = openSubmenu(container);
    assert.ok(submenu.className.includes("top-0"), `expected top-0 (opens downward), got: ${submenu.className}`);
  });
});

after(() => teardown());
