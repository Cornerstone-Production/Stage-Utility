import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OPERATOR_PATHS, isOperatorPath } from "./operator-paths.js";

describe("operator paths", () => {
  it("claims every operator surface, with and without a trailing slash", () => {
    for (const p of OPERATOR_PATHS) {
      assert.ok(isOperatorPath(p), `${p} must be an operator path`);
      assert.ok(isOperatorPath(`${p}/`), `${p}/ must be an operator path`);
    }
  });

  it("claims nested operator routes", () => {
    assert.ok(isOperatorPath("/scriptview/sunday/full"));
    assert.ok(isOperatorPath("/patch/rack-a"));
  });

  it("leaves the wall displays alone", () => {
    // These belong to index.html. Claiming one would black out a wall display.
    for (const p of ["/display-1", "/display-lobby", "/preview-view1"]) {
      assert.equal(isOperatorPath(p), false, `${p} must NOT be an operator path`);
    }
  });

  it("claims the root, which is Home now", () => {
    // Matched exactly, never by prefix: "/" is a prefix of every path, so
    // folding it into the generic loop would claim /display-1 too and black out
    // every screen in the building.
    assert.ok(isOperatorPath("/"));
    assert.ok(isOperatorPath(""));
    assert.equal(isOperatorPath("/display-1"), false, "the root rule must not swallow displays");
  });

  it("claims /settings, which is no longer its own document", () => {
    // settings-window.html is retired: the settings surfaces are routes in the
    // operator app now. This flipped from the opposite assertion, which was
    // correct while the panel had its own entry point.
    for (const p of ["/settings", "/settings/", "/settings/branding"]) {
      assert.ok(isOperatorPath(p), `${p} must be an operator path`);
    }
  });

  it("does not claim a path that merely starts with an operator path's name", () => {
    // "/historyfoo" shares a prefix with "/history" but is not it. A naive
    // startsWith would swallow it and serve the wrong document.
    assert.equal(isOperatorPath("/historyfoo"), false);
    assert.equal(isOperatorPath("/patchwork"), false);
  });

  it("does not claim asset requests", () => {
    assert.equal(isOperatorPath("/assets/index-abc123.js"), false);
    assert.equal(isOperatorPath("/app-icon.png"), false);
  });
});
