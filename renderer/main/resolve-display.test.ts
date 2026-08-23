// Every URL shape a kiosk page can be opened at.
//
// Three of them now, and they resolve differently enough that the checks were
// worth pulling out of the component: spelled inline they had already started to
// disagree about which counted as a preview.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { parseScreenPath, resolveDisplayId } from "./resolve-display";

const OUTPUTS = [
  { id: "display-1", slug: "left-mic" },
  { id: "display-9" },
];

describe("a real screen", () => {
  test("resolves by its permanent id", () => {
    const p = parseScreenPath("display-9", OUTPUTS);
    assert.equal(p.displayId, "display-9");
    assert.equal(p.isPreview, false);
  });

  test("and by its friendly slug", () => {
    assert.equal(parseScreenPath("left-mic", OUTPUTS).displayId, "display-1");
  });

  test("an unknown slug is left alone rather than guessed at", () => {
    // It still needs to render something, and inventing a display is worse than
    // showing "not configured" for the one that was asked for.
    assert.equal(parseScreenPath("nobody", OUTPUTS).displayId, "nobody");
  });
});

describe("a view preview", () => {
  const p = parseScreenPath("preview-view-3", OUTPUTS);

  test("names the view", () => {
    assert.equal(p.previewViewId, "view-3");
  });

  test("and is not an output", () => {
    // A view preview has no output. Treating the slug as one downstream would
    // look up resolvedByOutput["preview-view-3"], which is nothing.
    assert.equal(p.displayId, "preview-view-3");
  });

  test("counts as a preview", () => {
    assert.equal(p.isPreview, true);
  });
});

describe("an output preview", () => {
  const p = parseScreenPath("preview-out-display-9", OUTPUTS);

  test("resolves to the output, so per-output content has something to resolve for", () => {
    // Signage is why this shape exists: one Signage view drives every signage
    // screen and content is resolved per OUTPUT, so a per-view preview had no
    // output and every signage card on the Screens page was a black rectangle.
    assert.equal(p.displayId, "display-9");
    // "Is this an output preview" is isPreview with no view id — the separate
    // field said the same thing and nothing read it.
    assert.equal(p.isPreview, true);
    assert.equal(p.previewViewId, null);
  });

  test("is NOT read as a view preview", () => {
    // "preview-out-display-9" also starts with "preview-". Tested in the wrong
    // order it parses as a view whose id begins with "out-", and the card goes
    // back to being black.
    assert.equal(p.previewViewId, null);
  });

  test("counts as a preview", () => {
    // Which is what keeps it from reporting presence, reloading on a refresh
    // broadcast, writing a boot record, or being rotated.
    assert.equal(p.isPreview, true);
  });
});

describe("resolveDisplayId on its own", () => {
  test("prefers an id over a slug that collides with it", () => {
    // Not because validation makes a collision impossible: if a bad slug ever
    // does land in config, a display must not become unreachable at its own
    // permanent address.
    const outputs = [{ id: "display-9" }, { id: "display-2", slug: "display-9" }];
    assert.equal(resolveDisplayId("display-9", outputs), "display-9");
  });

  test("is null for an empty path or no outputs", () => {
    assert.equal(resolveDisplayId("", OUTPUTS), null);
    assert.equal(resolveDisplayId("display-9", undefined), null);
  });
});
