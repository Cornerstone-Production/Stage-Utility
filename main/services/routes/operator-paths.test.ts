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

  it("leaves the kiosk and settings alone", () => {
    // These belong to index.html and settings-window.html. Claiming one would
    // black out a wall display or the control surface.
    for (const p of ["/", "/display-1", "/display-lobby", "/settings", "/settings/"]) {
      assert.equal(isOperatorPath(p), false, `${p} must NOT be an operator path`);
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
