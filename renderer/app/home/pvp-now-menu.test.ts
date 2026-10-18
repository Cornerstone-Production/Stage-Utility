// Home's right-click menu for the ProVideoPlayer "now" card: the Layout submenu
// (which replaced the Compact toggle), Label while the layout is Compact, and the
// Warn near the end switch. Driven through the real rows the menu is built from.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { LAYOUT_OBJECTS } from "../../main/layout-objects.js";
import type { LayoutObject } from "@main/types/views";

import { PICK_OPTIONS, pickedValue, togglesFor, withToggle } from "./card-toggles.js";
import { pvpNowMenuItems } from "./pvp-now-menu.js";

describe("Home's card menu", () => {
  const home = (config: Record<string, unknown>): LayoutObject =>
    ({ id: "c1", x: 0, y: 0, w: 1, h: 1, config: { ...LAYOUT_OBJECTS["home-pvp-now"].config(), ...config } }) as unknown as LayoutObject;
  const writes = (c: LayoutObject, label: string, choose: string) => {
    let out: LayoutObject | null = null;
    const sub = pvpNowMenuItems(c, (n) => { out = n; }).find((i) => i.label === label)?.items?.find((i) => i.label === choose);
    assert.ok(sub, `no ${label} > ${choose} row`);
    sub.onSelect!();
    return out as unknown as LayoutObject;
  };

  test("Compact is no longer a toggle; Warn near the end is, off by default", () => {
    const toggles = togglesFor(home({}));
    assert.deepEqual(toggles.map((t) => t.label), ["Progress bar", "Next cue", "Warn near the end", "Count down stills"]);
    assert.deepEqual(togglesFor(home({ layout: "countdown" })).map((t) => t.label), ["Progress bar", "Warn near the end", "Count down stills"]);
    assert.equal(toggles.find((t) => t.key === "warnNearEnd")?.checked, false);
    // The same two on the wall object, which the inspector shares the keys with.
    assert.ok(togglesFor({ ...home({}), config: { type: "pvp-now" } } as LayoutObject).some((t) => t.key === "warnNearEnd"));
  });

  test("Next cue is offered only in Full — Compact and Countdown only never draw it", () => {
    const has = (config: Record<string, unknown>) => togglesFor(home(config)).some((t) => t.key === "showNextCue");
    assert.equal(has({ layout: "full" }), true);
    assert.equal(has({ layout: "compact" }), false);
    assert.equal(has({ layout: "countdown" }), false);
    assert.equal(has({ layout: undefined, compact: true }), false, "a legacy Compact card was offered a dead Next cue switch");
    assert.equal(has({ layout: undefined, compact: false }), true);
  });

  test("the Warn toggle writes warnNearEnd", () => {
    const t = togglesFor(home({})).find((x) => x.key === "warnNearEnd")!;
    const next = withToggle(home({}), t.key, t.next);
    assert.equal((next.config as { warnNearEnd?: boolean }).warnNearEnd, true);
  });

  test("a Layout submenu: Full / Compact / Countdown only, ticking the one in force", () => {
    const layoutRows = pvpNowMenuItems(home({ layout: "countdown" }), () => {}).find((i) => i.label === "Layout")!.items!;
    assert.deepEqual(layoutRows.map((i) => [i.label, i.checked]), [
      ["Full", false], ["Compact", false], ["Countdown only", true],
    ]);
    assert.deepEqual(Object.values(PICK_OPTIONS.layout!), ["Full", "Compact", "Countdown only"]);
  });

  test("a card saved with the old Compact switch on is ticked Compact", () => {
    assert.equal(pickedValue(home({ layout: undefined, compact: true }), "layout"), "compact");
    const rows = pvpNowMenuItems(home({ layout: undefined, compact: true }), () => {}).find((i) => i.label === "Layout")!.items!;
    assert.deepEqual(rows.filter((i) => i.checked).map((i) => i.label), ["Compact"]);
  });

  test("picking a layout writes it and retires the legacy key", () => {
    const next = writes(home({ layout: undefined, compact: true }), "Layout", "Countdown only");
    const c = next.config as { layout?: string; compact?: boolean };
    assert.equal(c.layout, "countdown");
    assert.equal(c.compact, undefined);
  });

  test("Label is offered only while the layout is Compact", () => {
    const has = (c: LayoutObject) => pvpNowMenuItems(c, () => {}).some((i) => i.label === "Label");
    assert.equal(has(home({ layout: "full" })), false);
    assert.equal(has(home({ layout: "countdown" })), false);
    assert.equal(has(home({ layout: "compact" })), true);
    assert.equal(has(home({ layout: undefined, compact: true })), true, "the legacy Compact card lost its Label picker");
  });

  test("the Label submenu still writes nowLabel", () => {
    const next = writes(home({ layout: "compact" }), "Label", "Layer name");
    assert.equal((next.config as { nowLabel?: string }).nowLabel, "layer");
  });

  test("a card with neither setting gets neither submenu", () => {
    const clock = { id: "c", x: 0, y: 0, w: 1, h: 1, config: { type: "clock" } } as unknown as LayoutObject;
    assert.deepEqual(pvpNowMenuItems(clock, () => {}), []);
  });
});
