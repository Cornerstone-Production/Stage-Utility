import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { qsysAddressesOf, addressKey, type QsysAddress, type QsysBinding } from "./qsys.js";
import type { LayoutObjectConfig } from "./views.js";
import { CAPABILITIES, hasCapability } from "./object-capabilities.js";
import { LAYOUT_OBJECT_TYPES } from "./layout-object-types.js";

const a = (component: string, control: string): QsysAddress => ({ component, control });
const keys = (list: QsysAddress[]): string[] => list.map((x) => `${x.component}/${x.control}`);

const GAIN: QsysBinding = a("Lobby_Mixer", "gain");
const MUTE: QsysBinding = a("Lobby_Mixer", "mute");
const LED: QsysBinding = { ...a("Zone 1", "recall"), indicator: a("Zone 1", "match") };

describe("qsysAddressesOf", () => {
  test("a fader reads its binding and its indicator", () => {
    const c: LayoutObjectConfig = {
      type: "qsys-fader",
      binding: { ...GAIN, indicator: a("Lobby_Mixer", "led") },
      orientation: "vertical",
      showDb: true,
      steps: false,
      stepDb: 3,
    };
    assert.deepStrictEqual(keys(qsysAddressesOf(c)), ["Lobby_Mixer/gain", "Lobby_Mixer/led"]);
  });

  test("a meter reads both bindings", () => {
    const c: LayoutObjectConfig = { type: "qsys-meter", binding: a("Mix", "meter.1"), binding2: a("Mix", "meter.2"), form: "bar" };
    assert.deepStrictEqual(keys(qsysAddressesOf(c)), ["Mix/meter.1", "Mix/meter.2"]);
  });

  test("mute, button and label read their one binding", () => {
    assert.deepStrictEqual(keys(qsysAddressesOf({ type: "qsys-mute", binding: MUTE })), ["Lobby_Mixer/mute"]);
    assert.deepStrictEqual(
      keys(qsysAddressesOf({ type: "qsys-button", binding: LED, label: "Go", hold: false })),
      ["Zone 1/recall", "Zone 1/match"],
    );
    assert.deepStrictEqual(keys(qsysAddressesOf({ type: "qsys-label", binding: GAIN, text: "" })), ["Lobby_Mixer/gain"]);
  });

  test("a switch reads its boolean, on and off bindings", () => {
    const c: LayoutObjectConfig = {
      type: "qsys-switch",
      binding: a("Zone 1", "power"),
      onBinding: a("Zone 1", "on"),
      offBinding: a("Zone 1", "off"),
      label: "Power",
    };
    assert.deepStrictEqual(keys(qsysAddressesOf(c)), ["Zone 1/power", "Zone 1/on", "Zone 1/off"]);
  });

  test("presets read every item then the previous control", () => {
    const c: LayoutObjectConfig = {
      type: "qsys-presets",
      items: [
        { label: "Full", binding: a("Snap", "1") },
        { label: "Half", binding: a("Snap", "2") },
      ],
      previous: a("Snap", "prev"),
    };
    assert.deepStrictEqual(keys(qsysAddressesOf(c)), ["Snap/1", "Snap/2", "Snap/prev"]);
  });

  test("a selector reads its choice list and every item", () => {
    const c: LayoutObjectConfig = {
      type: "qsys-selector",
      binding: a("Router", "select"),
      items: [{ label: "A", binding: a("Router", "a") }],
    };
    assert.deepStrictEqual(keys(qsysAddressesOf(c)), ["Router/select", "Router/a"]);
  });

  test("a strip reads name, gain, mute and both meters", () => {
    const c: LayoutObjectConfig = {
      type: "qsys-strip",
      name: a("Mix", "name"),
      label: "Ch 1",
      gain: GAIN,
      mute: MUTE,
      meter: a("Mix", "meter.1"),
      meter2: a("Mix", "meter.2"),
    };
    assert.deepStrictEqual(keys(qsysAddressesOf(c)), [
      "Mix/name",
      "Lobby_Mixer/gain",
      "Lobby_Mixer/mute",
      "Mix/meter.1",
      "Mix/meter.2",
    ]);
  });

  test("null and absent bindings contribute nothing", () => {
    assert.deepStrictEqual(qsysAddressesOf({ type: "qsys-mute", binding: null }), []);
    assert.deepStrictEqual(qsysAddressesOf({ type: "qsys-meter", binding: null, binding2: null, form: "number" }), []);
    assert.deepStrictEqual(qsysAddressesOf({ type: "qsys-selector", items: [] }), []);
    assert.deepStrictEqual(
      qsysAddressesOf({ type: "qsys-strip", name: null, label: "", gain: GAIN, mute: null, meter: null }),
      [GAIN].map((g) => a(g.component, g.control)),
    );
  });

  test("an address named twice is listed once", () => {
    const c: LayoutObjectConfig = {
      type: "qsys-strip",
      name: null,
      label: "",
      gain: GAIN,
      mute: null,
      meter: a("Lobby_Mixer", "gain"),
    };
    assert.equal(qsysAddressesOf(c).length, 1);
    assert.equal(addressKey(qsysAddressesOf(c)[0]!), addressKey(GAIN));
  });

  test("the status object reads nothing, and neither do non-Q-SYS objects", () => {
    assert.deepStrictEqual(qsysAddressesOf({ type: "qsys-status" }), []);
    assert.deepStrictEqual(qsysAddressesOf({ type: "clock" } as LayoutObjectConfig), []);
    assert.deepStrictEqual(qsysAddressesOf({ type: "cue-button", cue: "x" }), []);
  });

  test("returned addresses carry no indicator field", () => {
    const [first] = qsysAddressesOf({ type: "qsys-mute", binding: LED });
    assert.deepStrictEqual(first, a("Zone 1", "recall"));
  });
});

describe("Q-SYS object types", () => {
  const QSYS_TYPES = [
    "qsys-button",
    "qsys-fader",
    "qsys-label",
    "qsys-meter",
    "qsys-mute",
    "qsys-presets",
    "qsys-selector",
    "qsys-status",
    "qsys-strip",
    "qsys-switch",
  ];

  test("the registry holds exactly these Q-SYS types", () => {
    assert.deepStrictEqual(LAYOUT_OBJECT_TYPES.filter((t) => t.startsWith("qsys-")), QSYS_TYPES);
    assert.deepStrictEqual(Object.keys(CAPABILITIES).filter((t) => t.startsWith("qsys-")).sort(), QSYS_TYPES);
  });

  test("the objects that write are controls and the rest are readouts only", () => {
    const writers = ["qsys-button", "qsys-fader", "qsys-mute", "qsys-presets", "qsys-selector", "qsys-strip", "qsys-switch"] as const;
    for (const t of writers) assert.ok(hasCapability(t, "control"), `${t} writes to the Core`);
    for (const t of ["qsys-label", "qsys-meter", "qsys-status"] as const) {
      assert.ok(!hasCapability(t, "control"), `${t} only reads`);
    }
  });
});
