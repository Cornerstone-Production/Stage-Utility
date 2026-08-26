import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

// The DOM must exist before the component modules are evaluated - a `before`
// hook runs after the module body, so a static import would render into nothing.
import { installDom } from "../test-dom.js";

const teardown = installDom();

const { DESTINATIONS } = await import("./destinations.js");
const { THEME_MODES } = await import("../lib/use-theme.js");

after(() => {
  teardown();
});

// The settings shell carries chrome that is SHELL behaviour, not settings
// behaviour: the theme toggle, the version readout, the collapse control. The
// first draft of the operator shell silently lost nine of them. These assert the
// ones a test can hold; the rest are walked by hand against the plan's parity
// inventory.
describe("shell chrome parity", () => {
  test("the theme toggle offers all three modes, including system", () => {
    // The settings toggle is three-way. Shipping a two-way light/dark switch
    // silently removes "Match system", which is the default for anyone who
    // never touched it — storedMode() returns "system" when nothing is stored.
    assert.deepEqual([...THEME_MODES], ["light", "system", "dark"]);
  });

  test("every destination carries a description for its page header", () => {
    // Settings shows a subtitle under each section title (SECTION_DESC). A
    // destination with no description renders a bare heading and loses it.
    for (const d of DESTINATIONS) {
      assert.equal(typeof d.description, "string", `${d.label} has no description`);
      assert.ok(d.description.length > 0, `${d.label} has an empty description`);
    }
  });

  test("descriptions carry no emoji", () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    for (const d of DESTINATIONS) {
      assert.equal(emoji.test(d.description), false, `${d.label}'s description contains an emoji`);
    }
  });
});
