// The preview URL contract, from both ends.
//
// The bug this guards is silent by construction: the writer and the reader are
// in different files and different apps (a settings card, and the kiosk page
// inside its iframe). Spell the query key differently at the two ends and the
// iframe still loads, the picture is still right, and the screen's setting
// simply never arrives — which looks exactly like the control being broken,
// which is the report this whole change came from.
//
// So every case here runs a real string through BOTH functions rather than
// asserting a literal at either end.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { previewOutputId, previewSrc } from "./preview-url.js";

/** What the kiosk sees: `previewSrc` parsed the way a browser location is. */
function roundTrip(viewId: string, outputId?: string | null): string | null {
  const url = new URL(previewSrc(viewId, outputId), "http://stage.invalid");
  const slug = url.pathname.replace(/^\/+|\/+$/g, "");
  const previewViewId = slug.startsWith("preview-") ? slug.slice("preview-".length) : null;
  return previewOutputId(url.search, previewViewId);
}

describe("the preview URL carries the screen a card stands in for", () => {
  test("an output id written by the card is the one the kiosk reads back", () => {
    assert.equal(roundTrip("v1", "display-1"), "display-1");
  });

  test("a card with no screen behind it names none", () => {
    assert.equal(roundTrip("v1"), null);
    assert.equal(roundTrip("v1", null), null);
    // An empty string is "no output", not an output whose id is "".
    assert.equal(roundTrip("v1", ""), null);
  });

  test("ids that need escaping survive both ends", () => {
    // Not hypothetical: view ids are generated, and an operator-set slug can
    // carry anything. A raw "&" would end the value and silently truncate it.
    for (const id of ["a&b=c", "with space", "sl/ash", "q?mark", "100%", "üñî"]) {
      assert.equal(roundTrip("v1", id), id, `an output id did not survive the URL: ${id}`);
    }
  });

  test("a view id that needs escaping does not swallow the output", () => {
    assert.equal(roundTrip("view?one", "display-1"), "display-1");
    assert.equal(roundTrip("view&one=two", "display-1"), "display-1");
  });

  test("the path still names the view, and only the view", () => {
    // The `preview-` prefix is a reserved slug (reserved-slugs.ts) and the whole
    // segment after it is the view id. A second path segment would break every
    // reader of that slug, which is why the output rides in the query.
    assert.equal(previewSrc("v1"), "/preview-v1");
    assert.ok(previewSrc("v1", "display-1").startsWith("/preview-v1?"));
  });

  test("a real display ignores an output named in its URL", () => {
    // The reader refuses unless the caller has already decided this is a
    // preview. A wall screen's address is its identity; a query param must not
    // be able to point it at another screen's settings.
    assert.equal(previewOutputId("?output=display-2", null), null);
  });
});
