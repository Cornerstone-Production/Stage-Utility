// The editor canvas is a KIOSK ground, and has to bring the kiosk's foregrounds
// with it.
//
// It painted `var(--kiosk-bg)` — near-black — and carried no `.kiosk-surface`
// class, so every widget drawn on it resolved the APP's `--color-fg`. In light
// mode that is #161b22 on #0a0a0a: measured in a browser at 1.05–1.14:1 on
// thirty of the forty-eight object types that draw text, which is invisible.
// The ones that still looked right were the ones NOT reading the token — a
// literal white, or a colour the object itself carries — which is what made a
// cascade bug look like a handful of broken widgets. Reported as "some
// widgets are specifically broken in the editor but work perfectly when on that
// display", and that is exactly what it was — the display carries the class, the
// editor did not.
//
// WHY THE CLASS AND NOT THE `--su-*` VARIABLES: `--color-fg: var(--su-fg)` is
// declared on :root, so it RESOLVES there and inherits its computed value down.
// Redefining `--su-fg` on a nested element changes nothing. `.kiosk-surface`
// therefore sets the Tailwind colour variables directly, and an element only
// gets them by carrying the class. See the rule in styles.css.
//
// ── What this test can and cannot do ────────────────────────────────────────
//
// jsdom does NOT substitute `var()` in ordinary properties: getComputedStyle on
// an element whose rule says `color: var(--color-fg)` returns the literal string
// "var(--color-fg)". So a test cannot ask jsdom for the painted colour.
//
// It DOES run the real cascade for CUSTOM PROPERTIES — specificity, inheritance,
// and `.kiosk-surface` beating `:root` — which is precisely the mechanism that
// broke. Verified in this session: inside `.kiosk-surface` a descendant reports
// `--color-fg: rgba(255,255,255,0.92)`; outside it reports `var(--su-fg)`, which
// resolves on the same element to the app's #161b22.
//
// So this mounts the REAL EditorCanvas with the REAL styles.css, asks jsdom for
// the token each object inherits, follows the one `var()` indirection by hand,
// and computes a real WCAG ratio with the app's own `contrastRatio`. Nothing
// here reads source text, and a comment naming the class cannot satisfy it: the
// numbers come out of the cascade or they do not come out at all.
//
// The browser numbers this stands in for were measured directly, with the fix
// in place: all 48 text-bearing object types in the editor now report the SAME
// contrast as the same object on a real display, in both app themes.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { installDom } from "../test-dom.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STYLES = path.join(HERE, "..", "styles.css");

const teardown = installDom();

// Home's cards read live state through the app's SSE hooks, which open an
// EventSource on mount. jsdom has none, and what this measures is the colour
// token an object inherits — fed by the cascade either way — so a stub that
// never emits is the whole requirement.
class NoStream {
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
(globalThis as { EventSource?: unknown }).EventSource = NoStream;

const realFetch = globalThis.fetch;

// jsdom lays nothing out, and the canvas draws nothing at a zero-size wrapper —
// so the pane is given a size the way a browser would report one.
const PANE = { width: 1200, height: 700 };
const realRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function () {
  return { ...PANE, top: 0, left: 0, right: PANE.width, bottom: PANE.height, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
};

// The REAL stylesheet. `@theme { … }` is Tailwind's spelling of a `:root` block
// and is what carries `--color-*: var(--su-*)`; jsdom drops at-rules it does not
// know, so the wrapper — and ONLY the wrapper — is rewritten to the `:root` it
// compiles to. Every declaration inside it is the shipped one, untouched.
const styleEl = document.createElement("style");
styleEl.textContent = readFileSync(STYLES, "utf8").replace(/@theme\s*\{/, ":root {");
document.head.appendChild(styleEl);

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { EditorCanvas } = await import("./layout-editor.js");
const { LAYOUT_OBJECTS } = await import("../main/layout-objects.js");
const { makeRenderCtx, DEFAULT_STAGE_STATE } = await import("../main/test-render-ctx.js");

const { contrastRatio, parseColor, formatColor } = await import("../components/ui/color-math.js");
const { RouterContextProvider, createRootRoute, createRouter, createMemoryHistory } = await import("@tanstack/react-router");

// Some of the cards fetch on mount — the shared stage state, service history.
// There is no server here, and an unanswered request settles after the DOM is
// torn down and throws "window is not defined" from a React update with nowhere
// to land. So every request is answered: the state document for the state route,
// an empty LIST for everything else, because a card handed the state object
// where it expected an array throws on `.filter` and takes the tree with it.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const body = url.startsWith("/api/state") ? DEFAULT_STAGE_STATE : [];
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

after(() => {
  cleanup();
  styleEl.remove();
  globalThis.fetch = realFetch;
  Element.prototype.getBoundingClientRect = realRect;
  teardown();
});

/** Every object an operator can put on a canvas — the palette, in full. */
const TYPES = Object.keys(LAYOUT_OBJECTS).sort();

const CANVAS = { width: 1920, height: 1080, background: null };

/** One of each, in a grid, z ascending so DOM order is TYPES order. */
const OBJECTS = TYPES.map((type, i) => ({
  id: `probe-${type}`,
  x: (i % 8) / 8 + 0.004,
  y: Math.floor(i / 8) / 8 + 0.004,
  w: 1 / 8 - 0.008,
  h: 1 / 8 - 0.008,
  z: i + 1,
  config: LAYOUT_OBJECTS[type as keyof typeof LAYOUT_OBJECTS].config(),
  style: {},
}));

/**
 * One `var()` indirection, resolved against the element it was read from.
 *
 * That is all the shipped CSS uses: `--color-fg: var(--su-fg)` on :root, and a
 * literal inside `.kiosk-surface`. Written as a loop rather than a single step
 * so a second level would resolve too instead of silently returning a string
 * `contrastRatio` reads as unparseable (and scores 1, i.e. a false failure).
 */
function resolve(el: Element, token: string): string {
  let value = getComputedStyle(el).getPropertyValue(token).trim();
  for (let hops = 0; hops < 8; hops++) {
    const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
    if (!m) return value;
    value = getComputedStyle(el).getPropertyValue(m[1]).trim();
  }
  return value;
}

/**
 * WCAG contrast, with the translucent foreground painted onto the ground first.
 *
 * `contrastRatio` ignores alpha by design — a translucent colour has no
 * luminance until you know what is behind it — and the kiosk foregrounds are
 * all white at an alpha. Compositing here is what turns "rgba(255,255,255,0.92)"
 * into the number a person actually sees.
 */
function ratioOn(fg: string, groundHex: string): number {
  const f = parseColor(fg);
  const g = parseColor(groundHex);
  if (!f || !g) return 1;
  const mix = formatColor({
    r: f.r * f.a + g.r * (1 - f.a),
    g: f.g * f.a + g.g * (1 - f.a),
    b: f.b * f.a + g.b * (1 - f.a),
    a: 1,
  });
  return contrastRatio(mix, groundHex);
}

function canvasElement() {
  return React.createElement(EditorCanvas as never, {
    canvas: CANVAS,
    objects: OBJECTS,
    selectedId: null,
    selectedIds: new Set<string>(),
    // Off, so the content layer's children are the objects and nothing else.
    gridOn: false,
    alignOn: false,
    locked: false,
    // The shared typed context, so a required field added to LayoutRenderCtx
    // stops this compiling rather than crashing one widget at render time.
    ctx: makeRenderCtx({ now: Date.parse("2026-08-22T18:00:00.000Z") }),
    ndiSource: null,
    interactive: false,
    onSelect: () => {},
    onMarqueeSelect: () => {},
    onGeom: () => {},
    onGeomMany: () => {},
    onCommitStart: () => {},
    onReparent: () => {},
  });
}

/**
 * The canvas, inside a router.
 *
 * Two of the Home cards contain an in-app `AppLink`, which is a TanStack `Link`
 * and throws on mount without a router in the tree. A memory router with one
 * route is the smallest thing that satisfies it, and rendering the real link is
 * worth the four lines: an anchor brings its own `color`, and a widget whose
 * link is invisible is the bug this file is about.
 */
const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
// Matched before render: a Link asks the router to build its location, which an
// unloaded router cannot do.
await router.load();

function mount() {
  // RouterContextProvider, not RouterProvider: this needs the router IN CONTEXT
  // so the links render, not the router's own route tree rendered in place of
  // the canvas.
  return render(
    React.createElement(RouterContextProvider as never, { router }, canvasElement()),
  );
}

/**
 * The tokens that DISCRIMINATE, and the floor each must clear.
 *
 * Not all four foregrounds: outside `.kiosk-surface`, `--color-fg-subtle` and
 * `--color-fg-faint` resolve to the light theme's PALE greys, which are legible
 * on black by accident and so cannot tell the two contexts apart. These two are
 * the ones that go near-black, and they are what the value line and the caption
 * line of every readout are painted in.
 *
 * The floors sit well below what the fix delivers (16.9 and 11.0) and well above
 * what the bug delivers (1.14 and 3.31), so neither a rounding change nor a
 * token tweak flips the result without a real regression.
 */
const CHECKS: { token: string; floor: number; what: string }[] = [
  { token: "--color-fg", floor: 7, what: "the value line of every readout" },
  { token: "--color-fg-muted", floor: 4.5, what: "the caption line of every readout" },
];

/**
 * What each object type inherits on the canvas — measured ONCE, synchronously,
 * while the tree is up.
 *
 * Measured here rather than inside the tests because Testing Library's auto
 * cleanup is registered against node:test's global `afterEach`, so the tree is
 * gone by the time the first `test` body runs. Reading tokens is a pure query;
 * carrying numbers into the assertions loses nothing.
 */
function measure(): { ground: string; rows: { type: string; tokens: Record<string, string> }[] } {
  const { container } = mount();
  // The canvas box is the element the background is painted on; the content
  // layer is its first child, and the objects are that layer's children.
  const box = container.querySelector(".rounded-xl");
  assert.ok(box, "could not find the editor canvas box — has its shape changed?");
  const layer = box.firstElementChild;
  assert.ok(layer, "the canvas box has no content layer");
  const rows = [...layer.children].map((el, i) => ({
    type: TYPES[i] ?? `#${i}`,
    tokens: Object.fromEntries(CHECKS.map(({ token }) => [token, resolve(el, token)])),
  }));
  // The ground, from the cascade rather than a literal repeated here — if
  // --kiosk-bg moves, every number below moves with it.
  return { ground: resolve(box, "--kiosk-bg"), rows };
}

const { ground, rows } = measure();

/** The same tokens on an element that is NOT on a kiosk surface. */
const outsideFg = (() => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  try {
    return resolve(el, "--color-fg");
  } finally {
    el.remove();
  }
})();

// Everything the mount scheduled, settled while the DOM is still up: the state
// hydrate, and the canvas's own re-measure (a rAF and an 80ms settle). Left to
// land after teardown they throw "window is not defined" from an update with
// nowhere to go, and the run fails with five green assertions above it.
await new Promise((r) => setTimeout(r, 250));

describe("every widget on the editor canvas inherits the kiosk foregrounds", () => {
  test("the canvas is the kiosk ground", () => {
    assert.match(ground, /^#[0-9a-f]{6}$/i, `--kiosk-bg did not resolve to a hex colour (got ${JSON.stringify(ground)})`);
    const c = parseColor(ground);
    assert.ok(c, "--kiosk-bg is not parseable");
    assert.ok(c.r === c.g && c.g === c.b, `the kiosk ground ${ground} is not strictly neutral`);
    // The object tokens are white at an alpha; a light ground would make every
    // ratio below pass for the wrong reason.
    assert.ok(c.r < 0x20, `the kiosk ground ${ground} is not dark`);
  });

  test("one of every object type is on the canvas — an EXACT count", () => {
    // Exact, not a floor. A floor with slack is how a widget joins the palette
    // and is never measured: the bug this guards hit every type on the canvas,
    // and an "at least twenty" assertion would have been green throughout.
    assert.equal(
      rows.length,
      TYPES.length,
      `the canvas drew ${rows.length} objects for ${TYPES.length} palette types`,
    );
    assert.deepEqual(
      rows.map((r) => r.type),
      TYPES,
      "the measured objects are not one of each palette type, in order",
    );
  });

  for (const { token, floor, what } of CHECKS) {
    test(`${token} is legible on the canvas for all ${TYPES.length} object types (${what})`, () => {
      const failures: string[] = [];
      for (const { type, tokens } of rows) {
        const fg = tokens[token];
        const r = ratioOn(fg, ground);
        if (!(r >= floor)) failures.push(`${type}: ${fg || "(unset)"} on ${ground} = ${r.toFixed(2)}:1`);
      }
      assert.deepEqual(
        failures,
        [],
        `${failures.length}/${rows.length} object types resolve ${token} below ${floor}:1 on the editor canvas — ` +
          `the canvas is painting the kiosk ground without carrying .kiosk-surface, so widgets are ` +
          `drawing the APP's foregrounds on it:\n  ${failures.join("\n  ")}`,
      );
    });
  }

  test("the same tokens are near-invisible WITHOUT the kiosk surface — the bug, measured", () => {
    // Proof that the checks above are testing the cascade and not a constant:
    // the identical measurement on an element outside .kiosk-surface returns the
    // app's foregrounds, and they fail the same floors. If this ever passes, the
    // floors have stopped discriminating and the guard above is decoration.
    const r = ratioOn(outsideFg, ground);
    assert.ok(
      r < 7,
      `--color-fg outside .kiosk-surface is ${outsideFg} = ${r.toFixed(2)}:1 on ${ground}, which passes the ` +
        `floor the guard above relies on — the two contexts no longer differ, so that guard proves nothing`,
    );
  });
});
