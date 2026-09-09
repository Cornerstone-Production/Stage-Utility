// The pill on a rules-list row saying what the last reconcile found.
//
// A `missing` cue REFUSES to press rather than guessing at a coordinate, so this
// pill is the only warning an operator gets. Two ways it could be silently
// wrong, both guarded here:
//
//  - a rule that has never been reconciled — every cue on an upgrading install,
//    and every rule written by hand — must show NOTHING. A grey "unknown" on all
//    of them is noise, and a red one would be a lie.
//  - the words have to name the status. A pill that read "in place" on a missing
//    button is worse than no pill.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND. node:assert builds its
// failure message by inspecting `actual`, and inspecting a live jsdom element
// does not terminate in any useful time — a sibling file ran for 81.5 s on one
// such assertion and was killed with no line number.
//
// NOT unit-tested here, and driven in a browser instead: that amber reads as
// amber and red as red. jsdom loads no stylesheet, so the `Status` dot's colour
// is not observable in it at all — only the variant name it was asked for is,
// and asserting that a component was passed "warning" is not evidence that
// anything is yellow.

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { CueButtonStatus, buttonStatusText, relativeSince } = await import("./companion-cues.js");
const { fingerprintParams, readFingerprint } = await import("@main/services/companion-fingerprint");

afterEach(cleanup);
after(() => {
  cleanup();
  teardown();
});

const FOUND = {
  page: 1,
  row: 4,
  col: 6,
  pageId: "page-one",
  label: "Projectors ON",
  actionIds: ["a1"],
};

const NOW = Date.parse("2026-09-09T14:00:00.000Z");
const TWO_HOURS_AGO = "2026-09-09T12:00:00.000Z";

/** What the pill rendered, as strings. */
function pill(params: Record<string, string | number>): { status: string; text: string } {
  render(React.createElement(CueButtonStatus, { params }));
  const node = document.querySelector("[data-cue-button-status]");
  return {
    status: node?.getAttribute("data-cue-button-status") ?? "none",
    text: node?.textContent ?? "",
  };
}

describe("relativeSince", () => {
  test("is coarse on purpose, and says nothing about a time it cannot read", () => {
    assert.equal(relativeSince(null, NOW), "");
    assert.equal(relativeSince("not a date", NOW), "");
    assert.equal(relativeSince("2026-09-09T13:59:30.000Z", NOW), "just now");
    assert.equal(relativeSince("2026-09-09T13:45:00.000Z", NOW), "15 minutes ago");
    assert.equal(relativeSince("2026-09-09T13:00:00.000Z", NOW), "1 hour ago");
    assert.equal(relativeSince(TWO_HOURS_AGO, NOW), "2 hours ago");
    assert.equal(relativeSince("2026-09-07T14:00:00.000Z", NOW), "2 days ago");
    // A clock that has gone backwards must not read "-3 minutes ago".
    assert.equal(relativeSince("2026-09-09T15:00:00.000Z", NOW), "just now");
  });
});

describe("buttonStatusText", () => {
  test("says nothing for a rule that has never been reconciled", () => {
    // Every cue on an upgrading install looks like this: three coordinates and a
    // label, and no status at all. The first pass adopts them.
    const legacy = readFingerprint({ page: 1, row: 4, col: 6, label: "Projectors ON" });
    assert.equal(legacy.status, null);
    assert.equal(buttonStatusText(legacy, NOW), null);
  });

  test("says nothing for a rule with no button chosen", () => {
    assert.equal(buttonStatusText(readFingerprint({ label: "" }), NOW), null);
  });

  test("names each status, and reads out where a moved button went", () => {
    const inPlace = buttonStatusText(
      readFingerprint(fingerprintParams(FOUND, "in-place", TWO_HOURS_AGO)),
      NOW,
    )!;
    assert.equal(inPlace.pill, "in place");
    assert.equal(inPlace.variant, "neutral");
    assert.equal(inPlace.detail, "", "an unmoved button has nothing to explain");

    const moved = buttonStatusText(
      readFingerprint(fingerprintParams(FOUND, "moved", TWO_HOURS_AGO, { page: 1, row: 1, col: 3 })),
      NOW,
    )!;
    assert.equal(moved.pill, "moved");
    assert.equal(moved.variant, "warning");
    assert.equal(moved.detail, "r1c3 → r4c6 · updated 2 hours ago");

    const missing = buttonStatusText(
      readFingerprint(fingerprintParams(FOUND, "missing", TWO_HOURS_AGO)),
      NOW,
    )!;
    assert.equal(missing.pill, "button missing");
    assert.equal(missing.variant, "error");
    // The page, the reason and what to do about it — the cue will not press, so
    // this is the whole explanation an operator gets.
    assert.equal(
      missing.detail,
      "Projectors ON is no longer on Companion page 1. Open this rule and pick the button again.",
    );
  });

  test("a moved button with no recorded origin still says it moved", () => {
    // Restored from an older backup, or written by hand. The pill must not go
    // blank on it.
    const moved = buttonStatusText(readFingerprint({ ...FOUND, actionIds: "a1", status: "moved" }), NOW)!;
    assert.equal(moved.pill, "moved");
    assert.equal(moved.detail, "r4c6");
  });

  test("an unlabelled button is named by its coordinates, not by nothing", () => {
    const missing = buttonStatusText(
      readFingerprint(fingerprintParams({ ...FOUND, label: "" }, "missing", TWO_HOURS_AGO)),
      NOW,
    )!;
    assert.match(missing.detail, /^the button at r4c6 is no longer on Companion page 1\./);
  });
});

describe("the pill, rendered", () => {
  test("renders nothing at all for a rule that has never been reconciled", () => {
    render(React.createElement(CueButtonStatus, { params: { page: 1, row: 4, col: 6 } }));
    assert.equal(document.querySelectorAll("[data-cue-button-status]").length, 0);
  });

  test("carries the status it is showing, and the words with it", () => {
    const moved = pill(fingerprintParams(FOUND, "moved", TWO_HOURS_AGO, { page: 1, row: 1, col: 3 }));
    assert.equal(moved.status, "moved");
    assert.ok(moved.text.includes("moved"), moved.text);
    assert.ok(moved.text.includes("r1c3"), moved.text);
    cleanup();

    const missing = pill(fingerprintParams(FOUND, "missing", TWO_HOURS_AGO));
    assert.equal(missing.status, "button missing");
    assert.ok(missing.text.includes("no longer on Companion page 1"), missing.text);
    cleanup();

    const inPlace = pill(fingerprintParams(FOUND, "in-place", TWO_HOURS_AGO));
    assert.equal(inPlace.status, "in place");
  });
});
