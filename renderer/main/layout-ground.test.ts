// A custom layout brings its own ground. The operator's theme does not get a vote.
//
// A console was drawn on `bg-bg`, the app's theme background, so it read as part
// of the page rather than a slab of stage-black bolted into it. That held while
// the app was dark: `--color-bg` is #0e0e0e against the kiosk's #0a0a0a, four
// points apart and indistinguishable.
//
// In LIGHT mode the same token is #f7f8fa. A layout's objects carry colours
// somebody authored against a dark canvas — white text, most of it — so the
// ground inverted, the text stayed white, and a console on a phone in daylight
// was white-on-white. The editor never showed it, because the editor draws on the
// kiosk surface: what you designed was not what you got.
//
// Two things have to stay true for this to keep working, and each is one edit
// away from being false, so each is asserted:
//
//   1. the layout container uses the kiosk surface and nothing theme-following;
//   2. `--kiosk-bg` is NOT redefined per theme — the moment it is, the fix
//      silently becomes the bug again, everywhere at once.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(HERE, "layout-renderer.tsx");
const STYLES = path.join(HERE, "..", "styles.css");

/** Tailwind utilities whose colour changes with the operator's theme. */
const THEME_BACKGROUNDS = ["bg-bg", "bg-surface", "bg-card", "bg-fill", "bg-popover", "bg-field"];

describe("a layout's ground does not follow the app theme", () => {
  const src = readFileSync(RENDERER, "utf8");

  /** The className of the outer container the layout is drawn in. */
  function containerClass(): string {
    const m = /className=\{`relative w-full h-full flex items-center justify-center([^`]*)`\}/.exec(src);
    assert.ok(m, "could not find the layout container's className — has its shape changed?");
    return m[1];
  }

  it("the container sits on the kiosk surface", () => {
    assert.match(containerClass(), /kiosk-surface/, "the layout container lost the kiosk surface");
  });

  it("and carries no theme-following background", () => {
    const cls = containerClass();
    const found = THEME_BACKGROUNDS.filter((u) => new RegExp(`(^|[^-\\w])${u}([^-\\w]|$)`).test(cls));
    assert.deepEqual(
      found,
      [],
      `the layout container uses ${found.join(", ")} — in light mode that inverts the ground under ` +
        `objects whose colours were authored against a dark canvas`,
    );
  });

  it("nothing hands the renderer a choice of ground", () => {
    // The prop that caused this is gone rather than defaulted, so there is no
    // value a caller can pass to get the old behaviour back. tsc enforces this
    // too; the assertion is here so the REASON is written down next to it.
    assert.doesNotMatch(src, /\bground\s*[?]?:\s*"stage"/, "a ground prop is back on the renderer");
  });
});

describe("the kiosk background is one colour, not a themed pair", () => {
  const css = readFileSync(STYLES, "utf8");

  it("--kiosk-bg is declared exactly once", () => {
    // A second declaration under a theme selector is how this fix would come
    // undone without anybody touching the renderer: every kiosk surface in the
    // app would start following the theme, and every wall display with it.
    const declarations = [...css.matchAll(/^\s*--kiosk-bg\s*:/gm)];
    assert.equal(
      declarations.length,
      1,
      `--kiosk-bg is declared ${declarations.length} times; a per-theme override makes every ` +
        `layout's ground follow the operator's theme again`,
    );
  });

  it("and it is a dark, strictly neutral colour", () => {
    // R=G=B is a standing rule in this repo — no blue-biased darks. Dark,
    // because that is what the authored white text needs.
    const m = /--kiosk-bg:\s*#([0-9a-f]{6})\b/i.exec(css);
    assert.ok(m, "--kiosk-bg is no longer a plain hex colour");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    assert.ok(r === g && g === b, `--kiosk-bg #${m[1]} is not strictly neutral`);
    assert.ok(r < 0x20, `--kiosk-bg #${m[1]} is not dark enough for white text authored against it`);
  });
});
