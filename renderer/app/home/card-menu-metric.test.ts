import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { LayoutObject } from "@main/types/views";
import type { ContextMenuItem } from "../../components/ui/context-menu.js";
import { LOUDEST_METER } from "../recording-status.js";
import { buildCardMenu } from "./card-menu.js";

const rig = {
  connected: true,
  meters: {
    "dev::FOH": { deviceName: "Console", channelName: "FOH L", metrics: { "SPL A Slow": 93.84, "SPL C Slow": 101.4, "LAeq 10": 91.2 } },
    "dev::Stage": { deviceName: "Console", channelName: "Wedge", metrics: { "SPL A Slow": 80, "SPL C Slow": 110, "LAeq 1": 79 } },
  },
};

/**
 * The Metric submenu of a home-spl card pinned to `meterId` and `metric`, built
 * by the real card menu. `onPick` receives what a click would have saved.
 */
function splMetricMenu(
  spl: Parameters<typeof buildCardMenu>[1]["spl"],
  meterId: string,
  metric: string,
  onPick: (metric: string) => void,
): ContextMenuItem {
  const card = {
    id: "c1", x: 0, y: 0, w: 1, h: 1, z: 0,
    config: { type: "home-spl", meterId, metricKey: metric },
  } as unknown as LayoutObject;
  const menu = buildCardMenu(card, {
    scoresFavourites: [],
    spl,
    splSummary: undefined,
    choosePress: () => {},
    cues: null,
    save: (update) => onPick((update([card])[0].config as { metricKey: string }).metricKey),
    close: () => {},
  });
  return menu.find((i) => i.label === "Metric")!;
}

const rows = (m: ContextMenuItem) => m.items ?? [];

describe("the SPL card's Metric submenu", () => {
  test("Automatic first, naming the metric it resolves to, then a heading and every key", () => {
    const m = splMetricMenu(rig, LOUDEST_METER, "", () => {});
    assert.equal(m.label, "Metric");
    const r = rows(m);
    assert.deepEqual(
      r.map((i) => (i.separator ? "-" : i.heading ? `#${i.label}` : `${i.label}|${i.meta ?? ""}`)),
      ["Automatic|SPL A Slow", "-", "#From Loudest meter", "SPL A Slow|93.8", "SPL C Slow|101.4", "LAeq 10|91.2"],
    );
  });

  test("the heading names a pinned meter, and the rows are that meter's", () => {
    const r = rows(splMetricMenu(rig, "dev::Stage", "", () => {}));
    assert.equal(r.find((i) => i.heading)?.label, "From Wedge");
    assert.deepEqual(r.filter((i) => i.checked !== undefined).map((i) => i.label), ["Automatic", "SPL A Slow", "SPL C Slow", "LAeq 1"]);
  });

  test("on the loudest meter the rows follow whichever meter is loudest on the pinned metric", () => {
    // Stage is quieter on A but louder on C, so pinning C moves the list to Stage's keys.
    const names = (metric: string) =>
      rows(splMetricMenu(rig, LOUDEST_METER, metric, () => {})).filter((i) => i.checked !== undefined && i.label !== "Automatic").map((i) => i.label);
    assert.deepEqual(names(""), ["SPL A Slow", "SPL C Slow", "LAeq 10"]);
    assert.deepEqual(names("SPL C Slow"), ["SPL A Slow", "SPL C Slow", "LAeq 1"]);
  });

  test("exactly one row is ticked: Automatic when nothing is pinned, else the pick", () => {
    const ticked = (metric: string) =>
      rows(splMetricMenu(rig, LOUDEST_METER, metric, () => {})).filter((i) => i.checked).map((i) => i.label);
    assert.deepEqual(ticked(""), ["Automatic"]);
    assert.deepEqual(ticked("SPL C Slow"), ["SPL C Slow"]);
  });

  test("a pinned metric that is gone is listed, ticked and marked, with no value", () => {
    const r = rows(splMetricMenu(rig, "dev::FOH", "SPL Z Peak", () => {}));
    const gone = r.find((i) => i.checked);
    assert.equal(gone?.label, "SPL Z Peak (not reporting)");
    assert.equal(gone?.meta, undefined);
  });

  test("picking a row hands back the Smaart key, and Automatic hands back the empty string", () => {
    const picked: string[] = [];
    const r = rows(splMetricMenu(rig, LOUDEST_METER, "SPL C Slow", (k) => picked.push(k)));
    r.find((i) => i.label === "Automatic")?.onSelect?.();
    r.find((i) => i.label === "LAeq 1")?.onSelect?.();
    assert.deepEqual(picked, ["", "LAeq 1"]);
  });

  test("Automatic names what picking it would show: the unpinned loudest meter's own automatic metric", () => {
    // FOH's automatic metric is LAeq 10 (no SPL A key) and it is loudest on A-less
    // reading; Stage is loudest on C. With C pinned the rows are Stage's, but
    // Automatic returns the card to FOH and must say LAeq 10, not Stage's A Slow.
    const odd = {
      connected: true,
      meters: {
        "dev::FOH": { deviceName: "Console", channelName: "FOH", metrics: { "LAeq 10": 99, "SPL C Slow": 95 } },
        "dev::Stage": { deviceName: "Console", channelName: "Wedge", metrics: { "SPL A Slow": 80, "SPL C Slow": 101 } },
      },
    };
    const r = rows(splMetricMenu(odd, LOUDEST_METER, "SPL C Slow", () => {}));
    assert.deepEqual(r.filter((i) => i.checked !== undefined).map((i) => i.label), ["Automatic", "SPL A Slow", "SPL C Slow"]);
    assert.equal(r[0].meta, "LAeq 10");
  });

  test("with nothing reporting, only Automatic is offered", () => {
    const r = rows(splMetricMenu(null, LOUDEST_METER, "", () => {}));
    assert.deepEqual(r.map((i) => i.label), ["Automatic"]);
    assert.equal(r[0].meta, undefined);
  });
});
