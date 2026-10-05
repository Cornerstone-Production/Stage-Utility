// applyFavicon, and the two HTML documents it assumes the stock icon of.
//
// The hook-level behaviour (a broadcast moves the tab icon on every surface) is
// proven in main/use-stage-state.test.tsx. What is here is the helper on its own
// and the one fact it cannot check at runtime: that STOCK_FAVICON is what the
// documents actually ship, so "logo removed" restores the icon the page started
// with rather than a different one.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();
const { applyFavicon, STOCK_FAVICON } = await import("./apply-favicon.js");

after(() => teardown());

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const links = () => [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')];

describe("applyFavicon", () => {
  beforeEach(() => {
    for (const l of links()) l.remove();
  });

  test("a logo becomes the icon, null restores the stock one", () => {
    applyFavicon("/branding-images/aa.png");
    assert.equal(links().length, 1);
    assert.equal(links()[0]?.getAttribute("href"), "/branding-images/aa.png");
    applyFavicon(null);
    assert.equal(links().length, 1, "restoring must reuse the link, not add another");
    assert.equal(links()[0]?.getAttribute("href"), STOCK_FAVICON);
  });

  test("undefined counts as no logo", () => {
    applyFavicon("/branding-images/aa.png");
    applyFavicon(undefined);
    assert.equal(links()[0]?.getAttribute("href"), STOCK_FAVICON);
  });

  test("an unchanged logo does not rewrite the href", () => {
    applyFavicon("/branding-images/aa.png");
    const link = links()[0];
    assert.ok(link);
    let writes = 0;
    const real = link.setAttribute.bind(link);
    link.setAttribute = (name: string, value: string) => {
      writes++;
      real(name, value);
    };
    applyFavicon("/branding-images/aa.png");
    assert.equal(writes, 0, "an identical href was written again");
  });
});

describe("the stock icon", () => {
  for (const doc of ["index.html", "app.html"]) {
    test(`${doc} ships STOCK_FAVICON`, () => {
      const html = readFileSync(path.join(ROOT, doc), "utf8").replace(/<!--[\s\S]*?-->/g, "");
      const tags = html.match(/<link\b[^>]*\brel="icon"[^>]*>/g) ?? [];
      assert.equal(tags.length, 1, `${doc} should declare exactly one rel="icon" link`);
      assert.match(tags[0] ?? "", new RegExp(`href="${STOCK_FAVICON}"`));
    });
  }
});
