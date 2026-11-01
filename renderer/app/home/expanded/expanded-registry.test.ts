// The set of Home cards that expand, held as an exact sorted list.
//
// `Record<ExpandableHomeCard, ExpandedBody>` is the real guard: the type checker
// refuses a card in one and not the other. This is the half that makes adding a
// card a visible line in a diff, and one that fails on the page a card links to
// being a route that does not exist.

import assert from "node:assert/strict";
import { after, test } from "node:test";

import type { LayoutObject } from "@main/types/views";
import { installDom } from "../../../test-dom.js";

const teardown = installDom();
const { EXPANDED_BODIES, expandedBodyFor } = await import("./registry.js");
const { ALL_DESTINATIONS } = await import("../../destinations.js");
after(() => teardown());

const obj = (config: unknown): LayoutObject =>
  ({ id: "x", x: 0, y: 0, w: 1, h: 1, z: 1, config, style: {} }) as unknown as LayoutObject;

test("the expandable Home cards are exactly these", () => {
  assert.deepEqual(
    Object.keys(EXPANDED_BODIES).sort(),
    [
      "current-service-item",
      "home-recent-services",
      "home-screens",
      "timer",
      "wireless-summary",
    ],
    "the expandable card set changed - update this list deliberately",
  );
});

test("every Open <page> goes to a page the app really has", () => {
  const known = new Set(ALL_DESTINATIONS.map((d) => d.path));
  const dangling = Object.entries(EXPANDED_BODIES)
    .filter(([, b]) => !known.has(b.page.to))
    .map(([type, b]) => `${type} -> ${b.page.to}`);
  assert.deepEqual(dangling, []);
});

test("only a card with no controls of its own expands on a press of the card", () => {
  const bodyPress = Object.entries(EXPANDED_BODIES)
    .filter(([, b]) => b.bodyPress)
    .map(([t]) => t)
    .sort();
  assert.deepEqual(bodyPress, ["home-recent-services", "home-screens", "wireless-summary"]);
});

test("a timer expands only when it reads the service", () => {
  assert.equal(expandedBodyFor(obj({ type: "timer", source: "service", nextItem: true })), EXPANDED_BODIES.timer);
  assert.equal(expandedBodyFor(obj({ type: "timer" })), EXPANDED_BODIES.timer, "no source means service");
  assert.equal(expandedBodyFor(obj({ type: "timer", source: "propresenter" })), null);
  assert.equal(expandedBodyFor(obj({ type: "timer", source: "baptism" })), null);
  // The retired Home card that is a Timer by the time it is drawn.
  assert.equal(expandedBodyFor(obj({ type: "home-live-status" })), EXPANDED_BODIES.timer);
});

test("a card with no expanded body has none, and prototype names are not cards", () => {
  assert.equal(expandedBodyFor(obj({ type: "home-recording" })), null);
  assert.equal(expandedBodyFor(obj({ type: "home-streaming" })), null);
  assert.equal(expandedBodyFor(obj({ type: "toString" })), null);
  assert.equal(expandedBodyFor(obj({ type: "constructor" })), null);
});
