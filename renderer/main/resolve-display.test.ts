// Resolution decides which slice of state a kiosk renders. Get it wrong and the
// display shows the right shell with another display's board — which reads as data
// loss, not as a routing bug.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { resolveDisplayId } from "./resolve-display.js";

const outputs = [
  { id: "display-1", slug: "left-mic" },
  { id: "display-2" },
  { id: "display-3", slug: "lobby" },
];

describe("resolveDisplayId", () => {
  test("resolves by id", () => {
    assert.equal(resolveDisplayId("display-2", outputs), "display-2");
  });

  test("resolves a slug to the CANONICAL id", () => {
    // Downstream keys off the id — returning the slug would miss the saved slots.
    assert.equal(resolveDisplayId("left-mic", outputs), "display-1");
  });

  test("an id wins over another output's slug", () => {
    // Validation should make this unreachable, but resolution must not depend on
    // that: a display has to stay reachable at its own permanent address even if a
    // bad slug lands in config by some other route.
    const tricky = [{ id: "display-9", slug: "display-1" }, { id: "display-1" }];
    assert.equal(resolveDisplayId("display-1", tricky), "display-1");
  });

  test("returns null when nothing matches, so the caller decides", () => {
    assert.equal(resolveDisplayId("nope", outputs), null);
    assert.equal(resolveDisplayId("", outputs), null);
  });

  test("returns null before state has loaded", () => {
    assert.equal(resolveDisplayId("left-mic", undefined), null);
  });

  test("is case-insensitive on both sides", () => {
    assert.equal(resolveDisplayId("LEFT-MIC", outputs), "display-1");
    assert.equal(resolveDisplayId("left-mic", [{ id: "d1", slug: "Left-Mic" }]), "d1");
  });

  test("ignores surrounding whitespace in a stored slug", () => {
    assert.equal(resolveDisplayId("lobby", [{ id: "d3", slug: " lobby " }]), "d3");
  });

  test("a preview path resolves to nothing so the caller keeps its own handling", () => {
    assert.equal(resolveDisplayId("preview-view-1", outputs), null);
  });
});
