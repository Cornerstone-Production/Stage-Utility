// The read-time mapping from the four retired timers onto the Timer.
//
// Each case states the Timer an old config must read as, key for key. A converted
// widget has to look exactly as it did, which is why some of these state settings
// a NEW Timer would leave to its defaults (an old object with no caption meant
// "no caption", an old baptism readout with no Show label meant "off"). A
// deepEqual, because an extra or missing key is exactly the drift in question.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import type { LayoutObject, LayoutObjectConfig } from "@main/types/views";
import { LAYOUT_OBJECTS } from "./layout-objects.js";
import {
  LEGACY_HOME,
  LEGACY_TIMER_TYPES,
  displayType,
  TIMER_SOURCE_INFO,
  readConfig,
  readTimerConfig,
  readTimerObject,
  timerSource,
  withTimerSource,
} from "./timer-config.js";

const cfg = (c: Record<string, unknown>) => c as unknown as LayoutObjectConfig;

describe("each retired timer reads as the equivalent Timer", () => {
  test("PCO countdown: the service clock, no next item, red on overrun, settings kept", () => {
    assert.deepEqual(
      readTimerConfig(cfg({ type: "countdown-timer", warnSeconds: 45, hideWhenIdle: true, caption: "Time left" })),
      { type: "timer", source: "service", nextItem: false, redOnOverrun: true, warnSeconds: 45, hideWhenIdle: true, caption: "Time left" },
    );
  });

  test("PCO countdown saved bare: no caption, and no keys it never had", () => {
    assert.deepEqual(readTimerConfig(cfg({ type: "countdown-timer" })), {
      type: "timer", source: "service", nextItem: false, redOnOverrun: true, caption: "",
    });
    assert.deepEqual(readTimerConfig(cfg({ type: "countdown-timer", caption: null })), {
      type: "timer", source: "service", nextItem: false, redOnOverrun: true, caption: "",
    });
  });

  test("Service timer: the service clock with the next item, no amber, the item's name for caption", () => {
    assert.deepEqual(readTimerConfig(cfg({ type: "home-live-status" })), {
      type: "timer", source: "service", nextItem: true, redOnOverrun: true,
    });
  });

  test("ProPresenter timer: red on overrun is its warn-states switch, everything else kept", () => {
    assert.deepEqual(
      readTimerConfig(cfg({ type: "pp-timer", timerName: "Sermon", propresenterInstanceId: "room-2", warnStates: false, hideWhenIdle: true, showLabel: false, caption: "Stage timer" })),
      { type: "timer", source: "propresenter", redOnOverrun: false, timerName: "Sermon", propresenterInstanceId: "room-2", hideWhenIdle: true, showLabel: false, caption: "Stage timer" },
    );
    // Absent warn-states and show-label meant on, in the old renderer.
    assert.deepEqual(readTimerConfig(cfg({ type: "pp-timer" })), {
      type: "timer", source: "propresenter", redOnOverrun: true, showLabel: true, caption: "",
    });
  });

  test("Baptism timer: the readout, label and caption kept; an unset Show label stays off", () => {
    assert.deepEqual(
      readTimerConfig(cfg({ type: "baptism-timer", field: "session", showLabel: true, label: "Elapsed", caption: "Baptisms" })),
      { type: "timer", source: "baptism", field: "session", showLabel: true, label: "Elapsed", caption: "Baptisms" },
    );
    // An empty label with the switch on drew no line, so it converts to off; a
    // label of only spaces drew a blank one, so it stays on.
    assert.equal(readTimerConfig(cfg({ type: "baptism-timer", showLabel: true, label: "" }))?.showLabel, false);
    assert.equal(readTimerConfig(cfg({ type: "baptism-timer", showLabel: true, label: "  " }))?.showLabel, true);
    assert.deepEqual(readTimerConfig(cfg({ type: "baptism-timer" })), {
      type: "timer", source: "baptism", showLabel: false, caption: "",
    });
  });

  test("a Timer reads as itself, by reference; anything else reads as null", () => {
    const t = cfg({ type: "timer", source: "baptism" });
    assert.equal(readTimerConfig(t), t);
    assert.equal(readTimerConfig(cfg({ type: "clock" })), null);
    assert.equal(readTimerConfig(undefined as never), null);
  });

  test("readConfig is the identity for everything that is not one of the four", () => {
    const c = cfg({ type: "clock", showSeconds: true });
    assert.equal(readConfig(c), c);
    assert.equal(readConfig(cfg({ type: "pp-timer" })).type, "timer");
  });

  test("the mapped types are exactly the registry's timers retired into `timer`", () => {
    const retired = Object.entries(LAYOUT_OBJECTS)
      .filter(([, s]) => s.retired?.replacedBy === "timer")
      .map(([t]) => t)
      .sort();
    assert.deepEqual(retired, [...LEGACY_TIMER_TYPES]);
    // And every one of them reads as a Timer from the registry's own default.
    for (const t of LEGACY_TIMER_TYPES) {
      assert.equal(readTimerConfig(LAYOUT_OBJECTS[t].config())?.type, "timer", `${t} does not read as a Timer`);
    }
  });
});

describe("a retired card keeps its Home tile when it is written as a Timer", () => {
  const object = (config: Record<string, unknown>, home?: LayoutObject["home"]) =>
    ({ id: "o", x: 0, y: 0, w: 1, h: 1, z: 1, config, style: {}, ...(home ? { home } : {}) }) as unknown as LayoutObject;

  test("the pinned slots are what the registry gave each type", () => {
    for (const t of LEGACY_TIMER_TYPES) {
      const pinned = LEGACY_HOME[t];
      const spec = LAYOUT_OBJECTS[t];
      assert.equal(pinned?.size, spec.homeSize, `${t} size`);
      assert.equal(pinned?.when, spec.homeWhen, `${t} visibility`);
    }
  });

  test("a card that stored no tile gets the one its old type defaulted to", () => {
    const written = readTimerObject(object({ type: "home-live-status" }), true);
    assert.equal(written.config.type, "timer");
    assert.deepEqual(written.home, { size: "xl", when: "live" });
  });

  test("a tile the operator set is kept over the pin, field by field", () => {
    const written = readTimerObject(object({ type: "pp-timer" }, { size: "l" }), true);
    assert.deepEqual(written.home, { size: "l", when: "live" });
  });

  test("an object that is not on Home gains no tile", () => {
    const written = readTimerObject(object({ type: "pp-timer" }));
    assert.equal(written.config.type, "timer");
    assert.equal("home" in written, false);
    // ...and one that already has one keeps exactly that.
    assert.deepEqual(readTimerObject(object({ type: "pp-timer" }, { size: "l" })).home, { size: "l" });
  });

  test("an object that is not a retired timer comes back untouched, by reference", () => {
    const clock = object({ type: "clock" });
    assert.equal(readTimerObject(clock), clock);
    const timer = object({ type: "timer", source: "service" });
    assert.equal(readTimerObject(timer), timer);
  });
});

describe("a retired timer is named as a Timer", () => {
  test("in the object list, the inspector and Home's menu", () => {
    for (const t of LEGACY_TIMER_TYPES) assert.equal(displayType(LAYOUT_OBJECTS[t].config()), "timer");
    assert.equal(displayType(cfg({ type: "clock" })), "clock");
  });
});

describe("a Timer's source", () => {
  const timer = (c: Record<string, unknown>) => ({ type: "timer", ...c }) as never;

  test("absent reads as the service", () => {
    assert.equal(timerSource(timer({})), "service");
    assert.equal(timerSource(timer({ source: "baptism" })), "baptism");
  });

  test("switching swaps the caption while it is still the old source's own", () => {
    assert.deepEqual(withTimerSource(timer({ source: "service" }), "propresenter"), { type: "timer", source: "propresenter", caption: "Stage timer" });
    assert.deepEqual(withTimerSource(timer({ source: "propresenter", caption: "Stage timer" }), "baptism"), { type: "timer", source: "baptism", caption: "Baptisms" });
    // Back to the service: its default is no caption at all, so the key goes.
    assert.deepEqual(withTimerSource(timer({ source: "baptism", caption: "Baptisms" }), "service"), { type: "timer", source: "service" });
  });

  test("a caption the operator typed, or cleared, stays, and so does every other setting", () => {
    assert.deepEqual(withTimerSource(timer({ source: "service", caption: "Time left", warnSeconds: 30 }), "baptism"), { type: "timer", source: "baptism", caption: "Time left", warnSeconds: 30 });
    assert.equal(withTimerSource(timer({ source: "service", caption: "" }), "propresenter").caption, "");
  });

  test("the table agrees with itself: only the service lacks a default caption, only baptism does not warn", () => {
    assert.deepEqual(Object.entries(TIMER_SOURCE_INFO).filter(([, i]) => i.caption === undefined).map(([k]) => k), ["service"]);
    assert.deepEqual(Object.entries(TIMER_SOURCE_INFO).filter(([, i]) => !i.warns).map(([k]) => k), ["baptism"]);
    assert.deepEqual(Object.entries(TIMER_SOURCE_INFO).filter(([, i]) => i.nextItem).map(([k]) => k), ["service"]);
  });
});
