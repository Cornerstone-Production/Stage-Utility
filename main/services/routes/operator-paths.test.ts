import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MOVED_PAGE_PREFIXES, OPERATOR_PATHS, isOperatorPath, legacyPageRedirect } from "./operator-paths.js";

describe("operator paths", () => {
  it("claims every operator surface, with and without a trailing slash", () => {
    for (const p of OPERATOR_PATHS) {
      assert.ok(isOperatorPath(p), `${p} must be an operator path`);
      assert.ok(isOperatorPath(`${p}/`), `${p}/ must be an operator path`);
    }
  });

  it("claims nested operator routes", () => {
    assert.ok(isOperatorPath("/servicecue/sunday/full"));
    assert.ok(isOperatorPath("/scriptview/sunday/full"), "a moved page stays claimed until it is redirected");
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
    assert.equal(isOperatorPath("/apple-touch-icon.png"), false);
    assert.equal(isOperatorPath("/favicon.svg"), false);
  });
});

describe("legacyPageRedirect", () => {
  it("maps the old prefix to the new one and keeps the path and the query", () => {
    assert.equal(legacyPageRedirect("/scriptview"), "/servicecue");
    assert.equal(legacyPageRedirect("/scriptview/"), "/servicecue/");
    assert.equal(legacyPageRedirect("/scriptview/weekend/audio", "?text=150&plan=1"), "/servicecue/weekend/audio?text=150&plan=1");
  });

  it("answers null for a path that did not move, including a lookalike", () => {
    for (const p of ["/servicecue", "/servicecue/weekend/audio", "/scriptviewer", "/api/servicecue/layouts", "/history", "/"]) {
      assert.equal(legacyPageRedirect(p, "?x=1"), null, `${p} must not be redirected`);
    }
  });

  it("every moved prefix lands on a page the server serves, never on another moved one", () => {
    for (const [from, to] of MOVED_PAGE_PREFIXES) {
      assert.ok(isOperatorPath(from), `${from} is not claimed, so a build without the redirect would 404 it`);
      assert.ok(isOperatorPath(to), `${to} is not an operator path`);
      assert.equal(legacyPageRedirect(to), null, `${to} redirects again — a loop`);
    }
  });
});
