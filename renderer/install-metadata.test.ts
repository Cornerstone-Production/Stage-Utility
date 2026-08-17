import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";

// What a phone gets when the app is added to a home screen.
//
// There are TWO html entry points and they had opposite amounts of this:
// index.html (the wall-display kiosk) declared all of it, and app.html — the
// operator app, and the one the manifest's start_url actually points at — had
// none. So an installed app ran with `viewport-fit=cover` and no status-bar
// declaration, iOS put the web view under the status bar and painted its own
// translucent treatment over the top ~60px, and the header came out blurred.
//
// Reading the HTML is not the usual source-text guard: the HTML IS the artifact
// here, and these tags have no runtime behaviour to exercise.

const app = readFileSync(new URL("../app.html", import.meta.url), "utf8");
const kiosk = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));

const ENTRIES: [string, string][] = [
  ["app.html", app],
  ["index.html", kiosk],
];

describe("both entry points are installable", () => {
  for (const [name, html] of ENTRIES) {
    test(`${name} declares the standalone metadata`, () => {
      assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/, `${name} is not installable`);
      assert.match(html, /name="apple-mobile-web-app-status-bar-style"/, `${name} lets iOS pick the status bar`);
      assert.match(html, /rel="apple-touch-icon"/, `${name} has no home-screen icon`);
      assert.match(html, /rel="manifest"/, `${name} links no manifest`);
      assert.match(html, /name="theme-color"/, `${name} does not tint the browser chrome`);
    });

    test(`${name} does not ask iOS for the translucent status bar`, () => {
      // THE guard. black-translucent is what puts content under the status bar
      // and leaves iOS to scrim it — the blur this whole thing was about.
      assert.doesNotMatch(
        html,
        /content="black-translucent"/,
        `${name} is back on black-translucent, which is the scrim`,
      );
    });
  }
});

describe("the chrome colour matches the page", () => {
  test("the kiosk declares ONE dark value, because it is always dark", () => {
    // It ignores system appearance by design (see its own theme script), so a
    // per-scheme theme-color would promise a light chrome it never renders.
    const colors = [...kiosk.matchAll(/name="theme-color"[^>]*content="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
    assert.deepEqual(colors, ["#0a0a0a"], "the kiosk's chrome colour drifted from --kiosk-bg");
  });

  test("the operator app declares BOTH schemes, because it follows the theme", () => {
    const light = app.match(/media="\(prefers-color-scheme: light\)" content="(#[0-9a-f]{6})"/)?.[1];
    const dark = app.match(/media="\(prefers-color-scheme: dark\)" content="(#[0-9a-f]{6})"/)?.[1];
    assert.equal(light, "#f7f8fa", "light chrome colour drifted from --background");
    assert.equal(dark, "#0e0e0e", "dark chrome colour drifted from --background");
  });
});

describe("no blue-tinted blacks", () => {
  // The standing rule: dark surfaces are strictly R=G=B. The manifest shipped
  // #080810 — B=16 against R=G=8 — which is the exact value the rest of the
  // codebase moved off, still being handed to every install dialog.
  const isNeutral = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return r === g && g === b;
  };

  test("the manifest's colours are neutral", () => {
    for (const key of ["background_color", "theme_color"] as const) {
      assert.ok(isNeutral(manifest[key]), `manifest ${key} is ${manifest[key]}, which is not R=G=B`);
    }
  });

  test("every dark theme-color is neutral", () => {
    const darks = [...`${app}${kiosk}`.matchAll(/content="(#[0-9a-f]{6})"/g)]
      .map((m) => m[1])
      .filter((hex) => parseInt(hex.slice(1, 3), 16) < 0x40);
    assert.ok(darks.length > 0, "found no dark values, so this proves nothing");
    for (const hex of darks) assert.ok(isNeutral(hex), `${hex} is a blue-tinted black`);
  });
});
