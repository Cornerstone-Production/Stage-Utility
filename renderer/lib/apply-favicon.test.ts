// applyFavicon, and the two HTML documents it assumes the stock icon of.
//
// The hook-level behaviour (a broadcast moves the tab icon on every surface) is
// proven in main/use-stage-state.test.tsx. What is here is the helper on its own:
// the href it settles on, the recolouring, and the one fact it cannot check at
// runtime: that STOCK_FAVICON is what the documents actually ship.
//
// jsdom has no canvas, so the DEFAULT rasterizer can only be driven down its
// failure path here, and that is tested as it is. The success path takes an
// injected rasterizer (__resetForTests(fn)); what a real canvas produces is
// checked by driving Chrome, not by a test that would only be reading a stub.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();
const { applyFavicon, STOCK_FAVICON, INK, __resetForTests } = await import("./apply-favicon.js");

after(() => teardown());

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const links = () => [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')];
const href = () => links()[0]?.getAttribute("href");
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const LOGO = "/branding-images/aa.png";
const OTHER = "/branding-images/bb.png";

/** A rasterizer that records its calls and answers when told to. */
function controlled() {
  const calls: { logo: string; ink: string; resolve: (url: string) => void; reject: (e: Error) => void }[] = [];
  const fn = (logo: string, ink: string) =>
    new Promise<string>((resolve, reject) => {
      calls.push({ logo, ink, resolve, reject });
    });
  return { calls, fn };
}

/** A matchMedia whose answer the test flips, firing "change" like a browser. */
function fakeScheme(dark: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: dark,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  };
  let created = 0;
  (window as unknown as { matchMedia: unknown }).matchMedia = () => {
    created++;
    return mql;
  };
  return {
    listeners,
    created: () => created,
    flip(next: boolean) {
      mql.matches = next;
      for (const l of [...listeners]) l();
    },
  };
}

beforeEach(() => {
  for (const l of links()) l.remove();
  __resetForTests();
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});
afterEach(() => __resetForTests());

describe("applyFavicon without recoloring", () => {
  test("a logo becomes the icon, null restores the stock one", () => {
    applyFavicon(LOGO);
    assert.equal(links().length, 1);
    assert.equal(href(), LOGO);
    applyFavicon(null);
    assert.equal(links().length, 1, "restoring must reuse the link, not add another");
    assert.equal(href(), STOCK_FAVICON);
  });

  test("undefined counts as no logo", () => {
    applyFavicon(LOGO);
    applyFavicon(undefined);
    assert.equal(href(), STOCK_FAVICON);
  });

  test("an unchanged logo does not rewrite the href", () => {
    applyFavicon(LOGO);
    const link = links()[0];
    assert.ok(link);
    let writes = 0;
    const real = link.setAttribute.bind(link);
    link.setAttribute = (name: string, value: string) => {
      writes++;
      real(name, value);
    };
    applyFavicon(LOGO);
    assert.equal(writes, 0, "an identical href was written again");
  });

  test("recolor off uses the logo as uploaded and never rasterizes", async () => {
    const r = controlled();
    __resetForTests(r.fn);
    applyFavicon(LOGO, false);
    await tick();
    assert.equal(href(), LOGO);
    assert.equal(r.calls.length, 0, "a logo that is not recolored was rasterized anyway");
  });
});

describe("applyFavicon with recoloring", () => {
  test("the tinted image is the icon, tinted with the light-scheme ink", async () => {
    const r = controlled();
    __resetForTests(r.fn);
    applyFavicon(LOGO, true);
    assert.equal(r.calls.length, 1);
    assert.deepEqual([r.calls[0]?.logo, r.calls[0]?.ink], [LOGO, INK.light]);
    r.calls[0]?.resolve("data:image/png;base64,TINTED");
    await tick();
    assert.equal(href(), "data:image/png;base64,TINTED");
    assert.equal(links()[0]?.getAttribute("type"), "image/png");
  });

  test("a repeat broadcast does no work, while loading or after", async () => {
    const r = controlled();
    __resetForTests(r.fn);
    applyFavicon(LOGO, true);
    applyFavicon(LOGO, true); // still loading
    assert.equal(r.calls.length, 1, "a broadcast during loading started another raster");
    r.calls[0]?.resolve("data:image/png;base64,TINTED");
    await tick();
    applyFavicon(LOGO, true); // cached
    assert.equal(r.calls.length, 1, "a broadcast with nothing changed rasterized again");
    assert.equal(href(), "data:image/png;base64,TINTED");
  });

  test("a stale slow result does not overwrite a newer one", async () => {
    const r = controlled();
    __resetForTests(r.fn);
    applyFavicon(LOGO, true);
    applyFavicon(OTHER, true);
    assert.equal(r.calls.length, 2);
    r.calls[1]?.resolve("data:image/png;base64,NEWER");
    await tick();
    r.calls[0]?.resolve("data:image/png;base64,STALE");
    await tick();
    assert.equal(href(), "data:image/png;base64,NEWER", "the older, slower raster won");
  });

  test("a raster still loading does not override a later decision not to recolor", async () => {
    const r = controlled();
    __resetForTests(r.fn);
    applyFavicon(LOGO, true);
    applyFavicon(LOGO, false);
    r.calls[0]?.resolve("data:image/png;base64,STALE");
    await tick();
    assert.equal(href(), LOGO);
  });

  test("a raster still loading does not bring back a removed logo", async () => {
    const r = controlled();
    __resetForTests(r.fn);
    applyFavicon(LOGO, true);
    applyFavicon(null, true);
    r.calls[0]?.resolve("data:image/png;base64,STALE");
    await tick();
    assert.equal(href(), STOCK_FAVICON);
  });

  test("a change of colour scheme re-tints, through one listener", async () => {
    const scheme = fakeScheme(false);
    const r = controlled();
    __resetForTests(r.fn);
    applyFavicon(LOGO, true);
    applyFavicon(LOGO, true);
    applyFavicon(OTHER, true);
    assert.equal(scheme.created(), 1, "matchMedia was queried per broadcast");
    assert.equal(scheme.listeners.size, 1, "more than one scheme listener was added");
    assert.equal(r.calls[0]?.ink, INK.light);
    r.calls[0]?.resolve("data:image/png;base64,DARKINK");
    r.calls[1]?.resolve("data:image/png;base64,DARKINK2");
    await tick();
    assert.equal(href(), "data:image/png;base64,DARKINK2");

    scheme.flip(true);
    const last = r.calls[r.calls.length - 1];
    assert.equal(last?.logo, OTHER, "the re-tint used the wrong logo");
    assert.equal(last?.ink, INK.dark, "the new scheme's ink was not used");
    last?.resolve("data:image/png;base64,LIGHTINK");
    await tick();
    assert.equal(href(), "data:image/png;base64,LIGHTINK");

    scheme.flip(false); // both inks are cached now: back with no new raster
    const before = r.calls.length;
    await tick();
    assert.equal(r.calls.length, before, "a cached (logo, ink) was rasterized again");
    assert.equal(href(), "data:image/png;base64,DARKINK2");
  });
});

describe("when the logo cannot be recolored", () => {
  /** console.warn calls made while `fn` runs. */
  async function warnings(fn: () => Promise<void> | void): Promise<string[]> {
    const seen: string[] = [];
    const real = console.warn;
    console.warn = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
    try {
      await fn();
    } finally {
      console.warn = real;
    }
    return seen;
  }

  test("the real rasterizer, with no canvas, warns and shows the logo as uploaded", async () => {
    // jsdom has no 2D context, so this is the real default code path.
    const seen = await warnings(async () => {
      applyFavicon(LOGO, true);
      await tick();
      applyFavicon(LOGO, true); // the failure is remembered, not retried per broadcast
      await tick();
    });
    assert.equal(href(), LOGO);
    assert.equal(links()[0]?.hasAttribute("type"), false);
    assert.equal(seen.length, 1, `expected one warning, got ${seen.length}`);
    assert.match(seen[0] ?? "", /^\[branding\] the tab icon could not be recolored/);
    assert.match(seen[0] ?? "", /no 2D canvas context/);
  });

  test("an image that fails to load warns and falls back the same way", async () => {
    const r = controlled();
    __resetForTests(r.fn);
    const seen = await warnings(async () => {
      applyFavicon(LOGO, true);
      r.calls[0]?.reject(new Error("the logo image failed to load"));
      await tick();
    });
    assert.equal(href(), LOGO);
    assert.equal(seen.length, 1);
    assert.match(seen[0] ?? "", /\[branding\].*failed to load/);
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
