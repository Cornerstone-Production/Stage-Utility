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

import { previewOutputId, previewSrc, previewViewIdFromSlug } from "./preview-url.js";
import { RESERVED_SLUG_PREFIX } from "../../main/services/reserved-slugs.js";

/**
 * What the kiosk sees.
 *
 * Every step is the app's own: the slug is taken the way StageView takes it, then
 * handed to the SAME parse StageView calls. An earlier draft re-implemented that
 * parse inline, which left the round trip unable to fail on the parse being
 * wrong - the half of the contract most likely to drift.
 */
function roundTrip(viewId: string, outputId?: string | null) {
  const url = new URL(previewSrc(viewId, outputId), "http://stage.invalid");
  const slug = url.pathname.replace(/^\/+|\/+$/g, "");
  const previewViewId = previewViewIdFromSlug(slug);
  return { viewId: previewViewId, outputId: previewOutputId(url.search, previewViewId) };
}

describe("the preview URL carries the screen a card stands in for", () => {
  test("an output id written by the card is the one the kiosk reads back", () => {
    assert.deepEqual(roundTrip("v1", "display-1"), { viewId: "v1", outputId: "display-1" });
  });

  test("a card with no screen behind it names none, and still names its view", () => {
    assert.deepEqual(roundTrip("v1"), { viewId: "v1", outputId: null });
    assert.deepEqual(roundTrip("v1", null), { viewId: "v1", outputId: null });
    // An empty string is "no output", not an output whose id is "".
    assert.deepEqual(roundTrip("v1", ""), { viewId: "v1", outputId: null });
  });

  test("ids that need escaping survive both ends", () => {
    // Not hypothetical: view ids are generated, and an operator-set slug can
    // carry anything. A raw "&" would end the value and silently truncate it.
    for (const id of ["a&b=c", "with space", "sl/ash", "q?mark", "100%", "üñî"]) {
      assert.equal(roundTrip("v1", id).outputId, id, `an output id did not survive the URL: ${id}`);
    }
  });

  test("a view id that needs escaping does not swallow the output", () => {
    assert.equal(roundTrip("view?one", "display-1").outputId, "display-1");
    assert.equal(roundTrip("view&one=two", "display-1").outputId, "display-1");
  });

  test("a slug that is not a preview names no view", () => {
    // This parse runs on EVERY kiosk page, not only previews. A wall screen at
    // /display-1 must come back null, or it would be treated as a preview of a
    // view called "display-1".
    assert.equal(previewViewIdFromSlug("display-1"), null);
    assert.equal(previewViewIdFromSlug(""), null);
    assert.equal(previewViewIdFromSlug("preview"), null, "the bare word is not the prefix");
    assert.equal(previewViewIdFromSlug("preview-"), "", "the prefix alone names no view");
  });

  test("the prefix here is the one the server reserves", () => {
    // reserved-slugs.ts forbids the renderer importing it at runtime, so
    // preview-url.ts spells the literal again. This is that copy's guard: change
    // one and the slug validator and the kiosk stop describing the same route,
    // so a display could take a slug that shadows every preview.
    assert.ok(
      previewSrc("v1").startsWith(`/${RESERVED_SLUG_PREFIX}`),
      `the preview route no longer uses the reserved prefix "${RESERVED_SLUG_PREFIX}"`,
    );
    assert.equal(previewViewIdFromSlug(`${RESERVED_SLUG_PREFIX}v1`), "v1");
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
