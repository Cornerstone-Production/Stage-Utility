// One icon, one key.
//
// A Screens card keyed by output id and a sidebar console tab keyed by view id
// were two entries for what the operator sees as one thing, with the tab
// preferring its own. Set the tab's icon once and the card could never move it
// again — reported as the icon not reflecting for one of the consoles.
//
// A screen showing a CONTROL SURFACE now shares the view's key with the tab.
// Anything else is a screen in its own right and keeps its id.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { iconKeyFor } from "./outputs-section.js";
import type { View } from "@main/types/views";

const view = (id: string, surface: "display" | "console") =>
  ({ id, name: id, kind: "custom", surface, ndiSource: null, createdAt: "" }) as unknown as View;

const VIEWS = [view("console-a", "console"), view("wall-b", "display")];

describe("where a screen's icon is stored", () => {
  test("a screen showing a control surface uses the VIEW's key", () => {
    assert.equal(iconKeyFor({ id: "display-1", viewId: "console-a" }, VIEWS), "console-a");
  });

  test("so two screens showing the same console share one icon", () => {
    const a = iconKeyFor({ id: "display-1", viewId: "console-a" }, VIEWS);
    const b = iconKeyFor({ id: "display-2", viewId: "console-a" }, VIEWS);
    assert.equal(a, b, "the same console would have two different icons");
  });

  test("a screen showing a wall-screen view keeps its OWN key", () => {
    // It is a screen, not a thing the sidebar lists.
    assert.equal(iconKeyFor({ id: "display-1", viewId: "wall-b" }, VIEWS), "display-1");
  });

  test("a screen showing nothing keeps its own key", () => {
    assert.equal(iconKeyFor({ id: "display-1", viewId: null }, VIEWS), "display-1");
    assert.equal(iconKeyFor({ id: "display-1" }, VIEWS), "display-1");
  });

  test("a screen pointed at a view this build cannot find keeps its own key", () => {
    // Rather than throwing, or keying by an id nothing resolves.
    assert.equal(iconKeyFor({ id: "display-1", viewId: "gone" }, VIEWS), "display-1");
  });

  test("the console tab reads that same key", () => {
    // The tab keys by view id, which is what a console card now writes.
    const railKey = "console-a";
    assert.equal(iconKeyFor({ id: "display-1", viewId: "console-a" }, VIEWS), railKey);
  });
});
