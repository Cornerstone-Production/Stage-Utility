// The pacing widget's projected-end option, drawn rather than read out of source.
//
// Three properties, and the first is the one that matters most: an object that
// never set the option draws exactly what it drew before. The other two are the
// classic trap in this repo — a "what time will it be" readout must render in
// the zone the APP reasons in, not the box's, and in the 12h/24h the operator
// chose for every other clock.
//
// Rendered through ObjectContent, the real path, because a source-text guard
// cannot tell a rewrite that preserves behaviour from one that breaks it — this
// file's neighbours record two occasions when one went green on the exact defect
// it was written for.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { ObjectContent } = await import("./layout-renderer.js");
const { setDisplayHourCycle } = await import("../lib/clock-format.js");

after(() => {
  cleanup();
  teardown();
  setDisplayHourCycle(null);
});

// 15:00 UTC. Invented ids throughout — nothing here names a real plan or org.
const T0 = Date.parse("2026-08-30T15:00:00.000Z");

const PLAN = {
  planId: "plan-1",
  noteCategories: [],
  items: [
    { id: "welcome", title: "Welcome", itemType: "item", lengthSec: 300, sequence: 0, notesByCategory: {}, description: null },
    { id: "song", title: "Song", itemType: "item", lengthSec: 1200, sequence: 1, notesByCategory: {}, description: null },
    { id: "message", title: "Message", itemType: "item", lengthSec: 1800, sequence: 2, notesByCategory: {}, description: null },
  ],
};

const LIVE = {
  mode: "item",
  currentItemId: "welcome",
  label: "Welcome",
  lengthSec: 300,
  liveStartAt: new Date(T0).toISOString(),
  targetAt: null,
  serverNow: new Date(T0).toISOString(),
  currentItemTitle: "Welcome",
  nextItemTitle: "Song",
  serviceTimeId: null,
  serviceTimeStartsAt: null,
};

/** A live service timeline running 2:00 behind: the welcome ran 5:00 over its
 *  planned 3:00, and the song has been live for 0:00. */
const TIMELINE = {
  serviceKey: "svc-1",
  serviceTypeId: null,
  planId: "plan-1",
  planTitle: null,
  seriesTitle: null,
  serviceDate: "2026-08-30",
  serviceTimeId: null,
  serviceTimeStartsAt: null,
  startedAt: new Date(T0 - 600 * 1000).toISOString(),
  endedAt: null,
  items: [
    {
      itemId: "welcome", title: "Welcome", sequence: 0, plannedLengthSec: 480,
      startedAt: new Date(T0 - 600 * 1000).toISOString(),
      endedAt: new Date(T0).toISOString(), actualDurationSec: 600,
    },
    {
      itemId: "song", title: "Song", sequence: 1, plannedLengthSec: 1200,
      startedAt: new Date(T0).toISOString(), endedAt: null, actualDurationSec: null,
    },
  ],
};

/** A render context with only the fields the pacing widget reads. `timezone` is
 *  the app's configured zone; `null` means "follow the viewer". */
function ctx(over: Record<string, unknown> = {}) {
  return {
    home: false,
    now: T0,
    skewMs: 0,
    H: 1080,
    interactive: false,
    pcoLive: LIVE,
    planItems: PLAN,
    serviceTimeline: null,
    state: { timezone: null, outputs: [] },
    ...over,
  } as never;
}

function draw(config: Record<string, unknown>, over: Record<string, unknown> = {}): string {
  cleanup();
  const o = { id: "o1", x: 0, y: 0, w: 0.2, h: 0.1, z: 1, config, style: {} } as never;
  const { container } = render(React.createElement(ObjectContent as never, { o, ctx: ctx(over) }));
  return (container.textContent ?? "").trim();
}

describe("an object that never set the option", () => {
  test("draws the drift, exactly as before", () => {
    // THE guard on the default. Every service-pacing object on every screen that
    // exists today has no `showProjectedEnd`, and none of them may change.
    // 10:00 elapsed against 8:00 planned = 2:00 behind.
    const text = draw({ type: "service-pacing" }, { serviceTimeline: TIMELINE });
    assert.equal(text, "+2:00");
  });

  test("and a dash, not a time, when nothing is recording", () => {
    // The projection CAN answer here — PCO is live and the plan has lengths — so
    // a default that leaked it would show a clock where a dash belongs.
    assert.equal(draw({ type: "service-pacing" }), "—");
  });
});

describe("with the projected end turned on", () => {
  test("the value is the wall-clock time the plan runs out", () => {
    // 15:00Z + 5:00 + 20:00 + 30:00 = 15:55Z.
    setDisplayHourCycle("24h");
    assert.equal(draw({ type: "service-pacing", showProjectedEnd: true }, { state: { timezone: "UTC", outputs: [] } }), "15:55");
  });

  test("in the zone the APP reasons in, not the machine's", () => {
    // The trap this repo keeps stepping in: servers run UTC, and a display
    // driven off one must read the venue's clock. Kiritimati is UTC+14 — no CI
    // runner and no operator's browser is in it, so this can only pass by
    // honouring the configured zone. 15:55Z is 05:55 the next morning there.
    setDisplayHourCycle("24h");
    const text = draw({ type: "service-pacing", showProjectedEnd: true }, { state: { timezone: "Pacific/Kiritimati", outputs: [] } });
    assert.equal(text, "05:55");
  });

  test("and in the 12h/24h every other clock in the app is using", () => {
    setDisplayHourCycle("12h");
    const twelve = draw({ type: "service-pacing", showProjectedEnd: true }, { state: { timezone: "UTC", outputs: [] } });
    assert.match(twelve, /^3:55\s?(?:PM|pm)$/, `12h setting ignored: ${twelve}`);
    setDisplayHourCycle("24h");
    assert.equal(draw({ type: "service-pacing", showProjectedEnd: true }, { state: { timezone: "UTC", outputs: [] } }), "15:55");
  });

  test("it answers with no service-timeline recording at all", () => {
    // The drift needs a recorder running; the projection needs only PCO Live and
    // the plan. Sharing one idle test would have blanked it in the common case.
    setDisplayHourCycle("24h");
    assert.equal(draw({ type: "service-pacing", showProjectedEnd: true }, { state: { timezone: "UTC", outputs: [] } }), "15:55");
  });

  test("the drift joins it on the sub-line when the label is on", () => {
    setDisplayHourCycle("24h");
    const text = draw(
      { type: "service-pacing", showProjectedEnd: true, showLabel: true },
      { serviceTimeline: TIMELINE, state: { timezone: "UTC", outputs: [] } },
    );
    assert.equal(text, "15:552:00 behind");
  });

  test("and stays away when it is off", () => {
    setDisplayHourCycle("24h");
    const text = draw(
      { type: "service-pacing", showProjectedEnd: true },
      { serviceTimeline: TIMELINE, state: { timezone: "UTC", outputs: [] } },
    );
    assert.equal(text, "15:55");
  });

  test("a plan with no lengths draws a dash, never a made-up time", () => {
    setDisplayHourCycle("24h");
    const bare = {
      planId: "plan-1",
      noteCategories: [],
      items: [{ id: "welcome", title: "Welcome", itemType: "item", lengthSec: 0, sequence: 0, notesByCategory: {}, description: null }],
    };
    const text = draw(
      { type: "service-pacing", showProjectedEnd: true },
      { planItems: bare, pcoLive: { ...LIVE, lengthSec: null }, state: { timezone: "UTC", outputs: [] } },
    );
    assert.equal(text, "—");
  });

  test("and hides entirely when the object asked to be hidden while idle", () => {
    const text = draw(
      { type: "service-pacing", showProjectedEnd: true, hideWhenIdle: true },
      { pcoLive: { ...LIVE, serviceEnded: true }, state: { timezone: "UTC", outputs: [] } },
    );
    assert.equal(text, "");
  });
});
