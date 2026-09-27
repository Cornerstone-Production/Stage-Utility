import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

import { RESERVED_SLUG_PREFIX } from "../main/services/reserved-slugs.js";

// index.html's synchronous boot script — the one with no `src`, which runs
// before the <style> block and before any module graph exists — adds
// "kiosk-preview" to <html> when the page is a settings preview. The <style>
// block right below it restores `overscroll-behavior: auto` under that
// class, undoing the `none` the rest of that block sets on a real display so
// a real display can never hand a scroll gesture off to whatever embeds it.
//
// This has to be live before first paint, not from a React effect that only
// runs once a preview's whole bundle has loaded: LazyPreview
// (renderer/settings/sections/lazy-preview.tsx) mounts a fresh iframe every
// time a preview card scrolls into view, so an effect-based fix left the
// window it needed to close open again on every card — right while the
// operator is scrolling. See safari-fix-report.md.
//
// "preview-" is a THIRD copy of RESERVED_SLUG_PREFIX
// (main/services/reserved-slugs.ts) / PREVIEW_PREFIX
// (renderer/main/preview-url.ts, checked against RESERVED_SLUG_PREFIX by
// preview-url.test.ts) — spelled again in index.html because that script
// runs before any module graph exists, so it cannot import either. This
// guards the third copy by RUNNING the real script index.html actually
// ships — loaded off disk, not retyped — against a path built from the
// canonical RESERVED_SLUG_PREFIX, rather than matching index.html's text:
// a comment mentioning "preview-" would satisfy a text match and prove
// nothing about what the script does.

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

/**
 * The classes index.html's own boot script leaves on <html> after loading at
 * `pathname` — jsdom parses AND RUNS index.html's inline script exactly as a
 * browser would (`runScripts: "dangerously"`). The module script at the foot
 * of the file (`<script type="module" src="...">`) never executes: jsdom does
 * not fetch external resources unless told to, so it is inert here, and only
 * the classic inline script — the one under test — ever runs.
 */
function classesAfterLoadingAt(pathname: string): string[] {
  const dom = new JSDOM(html, { url: `http://localhost${pathname}`, runScripts: "dangerously" });
  return [...dom.window.document.documentElement.classList];
}

describe("index.html's boot script marks a preview before first paint", () => {
  test("a preview path gets kiosk-preview, alongside the always-on dark/kiosk classes", () => {
    const classes = classesAfterLoadingAt(`/${RESERVED_SLUG_PREFIX}v1`);
    assert.ok(classes.includes("kiosk-preview"), `expected kiosk-preview, got: ${classes.join(" ")}`);
    assert.ok(classes.includes("dark"));
    assert.ok(classes.includes("kiosk"));
  });

  test("a preview standing in for a specific output is still a preview", () => {
    // previewOutputId's query param rides on the same path; the boot script
    // only looks at the path, so it must not need that param too.
    const classes = classesAfterLoadingAt(`/${RESERVED_SLUG_PREFIX}v1?output=display-1`);
    assert.ok(classes.includes("kiosk-preview"), `expected kiosk-preview, got: ${classes.join(" ")}`);
  });

  test("a real display by its permanent id is NOT marked a preview", () => {
    const classes = classesAfterLoadingAt("/display-1");
    assert.ok(!classes.includes("kiosk-preview"), `a real display must not carry kiosk-preview`);
  });

  test("a real display at a friendly slug is NOT marked a preview", () => {
    // Exactly the case reserved-slugs.ts exists to keep impossible the other
    // way — a slug is refused if it WOULD collide with this prefix — so a
    // display can never legitimately reach this script at a path starting
    // with the reserved prefix. Prove the boot script agrees for an ordinary
    // one that does not.
    const classes = classesAfterLoadingAt("/stage-left");
    assert.ok(!classes.includes("kiosk-preview"), `a friendly slug must not carry kiosk-preview`);
  });
});
