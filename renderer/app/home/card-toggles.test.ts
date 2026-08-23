// Which settings a Home widget offers on right-click.
//
// Which WIDGETS support which setting is enforced by the type checker — see the
// header of card-toggles. Proven in this session by three edits, each of which
// failed `tsc`: dropping reaper-status from the hideWhenIdle list, adding `text`
// to the showSeconds list, and adding `hideWhenIdle?` to `text` in the config
// union (the drift that matters — a NEW widget forces the list to be updated).
//
// So these tests cover the part the compiler cannot: the state each toggle
// reports, and what applying one writes.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { LayoutObject } from "@main/types/views";

import { togglesFor, withToggle } from "./card-toggles";

const card = (config: Record<string, unknown>): LayoutObject =>
  ({ id: "c1", x: 0, y: 0, w: 1, h: 1, config }) as unknown as LayoutObject;

describe("what a widget offers", () => {
  test("a clock offers seconds, the hour cycle and AM/PM", () => {
    const keys = togglesFor(card({ type: "clock" })).map((t) => t.key);
    assert.deepEqual(keys, ["showSeconds", "format", "showMeridiem"]);
  });

  test("a setting the widget does not support is never offered", () => {
    // Without this, "offer everything" would satisfy the test above and put a
    // Timecode switch on the clock.
    const keys = togglesFor(card({ type: "clock" })).map((t) => t.key);
    assert.ok(!keys.includes("showTimecode"), keys.join(", "));
    assert.ok(!keys.includes("hideWhenIdle"), keys.join(", "));
  });

  test("a widget with no settings at all offers none", () => {
    // Home's own cards — home-screens, home-recording and the rest — have no
    // config beyond their type, on purpose. The menu still opens; it just has
    // Size, Show and Remove in it.
    assert.deepEqual(togglesFor(card({ type: "home-screens" })), []);
  });

  test("an unknown type offers nothing rather than throwing", () => {
    assert.deepEqual(togglesFor(card({ type: "not-a-widget" })), []);
  });

  test("obs-status offers the three it supports and no more", () => {
    const keys = togglesFor(card({ type: "obs-status" })).map((t) => t.key);
    assert.deepEqual(keys, ["showTimecode", "hideWhenIdle", "fillWhenRecording"]);
  });
});

describe("the state a toggle reports", () => {
  test("reads the STORED value when the object has one", () => {
    const t = togglesFor(card({ type: "clock", showSeconds: false })).find((x) => x.key === "showSeconds");
    assert.equal(t?.checked, false);
    assert.equal(t?.next, true);
  });

  test("falls back to what the RENDERER does when the object never set it", () => {
    // An object saved before a setting existed has no key at all. Reading that
    // as `undefined === true` → false would show every old clock as "Seconds
    // off" while it visibly ticks seconds.
    const t = togglesFor(card({ type: "clock" })).find((x) => x.key === "showSeconds");
    assert.equal(t?.checked, true, "layout-renderer defaults showSeconds to true");
    assert.equal(t?.next, false);
  });

  test("an unset hideWhenIdle reads as OFF, matching the renderer", () => {
    const t = togglesFor(card({ type: "obs-status" })).find((x) => x.key === "hideWhenIdle");
    assert.equal(t?.checked, false);
  });

  test("the hour cycle is a choice, not a boolean", () => {
    const on24 = togglesFor(card({ type: "clock", format: "24h" })).find((x) => x.key === "format");
    assert.equal(on24?.checked, true);
    assert.equal(on24?.next, "12h");
    const on12 = togglesFor(card({ type: "clock", format: "12h" })).find((x) => x.key === "format");
    assert.equal(on12?.checked, false);
    assert.equal(on12?.next, "24h");
  });

  test("AM/PM is dropped on a 24-hour clock, where it does nothing", () => {
    const at24 = togglesFor(card({ type: "clock", format: "24h" })).map((t) => t.key);
    assert.ok(!at24.includes("showMeridiem"), at24.join(", "));
    const at12 = togglesFor(card({ type: "clock", format: "12h" })).map((t) => t.key);
    assert.ok(at12.includes("showMeridiem"), at12.join(", "));
  });
});

describe("applying one", () => {
  test("changes that key and nothing else", () => {
    const before = card({ type: "clock", showSeconds: true, format: "12h" });
    const after = withToggle(before, "showSeconds", false);
    assert.deepEqual(after.config, { type: "clock", showSeconds: false, format: "12h" });
    assert.equal(after.id, before.id);
  });

  test("does not mutate the card it was given", () => {
    // Home saves by rebuilding the object list; a mutation here would edit the
    // object the render is still holding and the page would not update.
    const before = card({ type: "clock", showSeconds: true });
    withToggle(before, "showSeconds", false);
    assert.equal((before.config as { showSeconds: boolean }).showSeconds, true);
  });

  test("round-trips: applying a toggle's own `next` flips its reported state", () => {
    // The whole menu contract in one property — the tick you see is the value
    // that gets written, and clicking again puts it back.
    for (const type of ["clock", "obs-status", "stream-status"]) {
      let c = card({ type });
      let flipped = 0;
      for (const key of togglesFor(c).map((t) => t.key)) {
        // Re-read rather than reusing the list: flipping `format` to 24h
        // legitimately removes showMeridiem, which the test below covers on its
        // own. A key that is gone is skipped, not asserted against.
        const t = togglesFor(c).find((x) => x.key === key);
        if (!t) continue;
        c = withToggle(c, t.key, t.next);
        assert.equal(togglesFor(c).find((x) => x.key === key)?.checked, !t.checked, `${type}/${key}`);
        flipped++;
      }
      assert.ok(flipped >= 2, `${type} only exercised ${flipped} toggles`);
    }
  });

  test("turning a clock to 24-hour removes the AM/PM item", () => {
    const c = withToggle(card({ type: "clock", format: "12h" }), "format", "24h");
    assert.ok(!togglesFor(c).some((t) => t.key === "showMeridiem"));
  });
});
