import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { holdingScreen } from "./kiosk-holding-screen.js";

// The first thing a brand-new screen ever renders. It has to work before the
// device knows anything — no bundle, no state — and it has to be readable from
// across a room, because that is how you tell four identical Pis apart.

describe("what an unclaimed screen shows", () => {
  const html = holdingScreen({
    id: "d4f19c2a", ip: "192.168.16.74", hostname: "raspberrypi",
    mac: "b8:27:eb:41:9c:2a", reason: "unclaimed",
  });

  test("it prints the facts you need standing in front of it", () => {
    for (const fact of ["d4f19c2a", "192.168.16.74", "raspberrypi", "b8:27:eb:41:9c:2a"]) {
      assert.ok(html.includes(fact), `the screen does not show ${fact}`);
    }
  });

  test("it says what to do next", () => {
    assert.match(html, /Waiting to be assigned/);
    assert.match(html, /Devices/);
  });

  test("it is self-contained", () => {
    // No bundle, no font fetch, no API call: this renders on a device that has
    // just booted and knows nothing, possibly before the app has ever loaded.
    assert.doesNotMatch(html, /<script[^>]+src=/, "the holding screen pulls in a script");
    assert.doesNotMatch(html, /<link[^>]+href=/, "the holding screen pulls in a stylesheet");
  });

  test("it reloads itself, so claiming needs nobody at the screen", () => {
    // The server also pushes a refresh on claim; this is the fallback for when
    // that missed. Without it, claiming a device means walking to the wall.
    assert.match(html, /location\.reload\(\)/);
  });

  test("missing facts are omitted, not rendered blank", () => {
    const sparse = holdingScreen({ id: "abc", reason: "unclaimed" });
    assert.ok(sparse.includes("abc"));
    assert.doesNotMatch(sparse, /MAC/, "an empty MAC field was still drawn");
  });
});

describe("someone opening it by hand", () => {
  test("says why rather than 404ing", () => {
    const html = holdingScreen({ id: null, reason: "no-device" });
    assert.match(html, /No device id/);
  });
});

describe("it cannot be used to inject markup", () => {
  test("a hostile hostname is escaped", () => {
    // hostname, MAC and id all come from a UDP broadcast — anything on the LAN
    // can set them, and this HTML is rendered on a screen nobody is watching.
    const html = holdingScreen({
      id: "ok",
      hostname: '<img src=x onerror="alert(1)">',
      reason: "unclaimed",
    });
    assert.doesNotMatch(html, /<img src=x/, "a broadcast injected markup into the holding screen");
    assert.match(html, /&lt;img src=x/);
  });
});
