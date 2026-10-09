import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { groupByMachine } from "./machine-groups.js";
import type { SeenDevice } from "@main/types/kiosk";
import type { PublicDevice } from "@main/services/kiosk-devices-store";

const MAC = "02:aa:00:bb:11:cc";
const seen = (id: string, over: Partial<SeenDevice> = {}): SeenDevice => ({
  id, macs: [MAC], hostname: "booth-mini", os: "macOS", ip: "192.0.2.40", firstSeen: 1, lastSeen: 1, ...over,
});
const out = (name: string, kind: "display" | "decklink" = "decklink") => ({ kind, name, port: name });
const bound = (id: string, over: Partial<PublicDevice> = {}): PublicDevice => ({
  id, outputId: `screen-${id}`, macs: [MAC], hostname: "booth-mini", ...over,
});

const ids = (rows: { device: { id: string } }[]) => rows.map((r) => r.device.id);

describe("grouping what Screens has heard", () => {
  it("puts the outputs of one Mac under one machine", () => {
    const g = groupByMachine(
      [seen("m.sdi-1", { output: out("SDI 1") }), seen("m.sdi-2", { output: out("SDI 2") })],
      [],
    );
    assert.equal(g.machines.length, 1);
    assert.deepEqual(g.machines[0].hostname, "booth-mini");
    assert.deepEqual(ids(g.machines[0].rows), ["m.sdi-1", "m.sdi-2"]);
    assert.deepEqual(g.plain, []);
  });

  it("leaves a device with no output exactly where it was, in the order it came", () => {
    const a = seen("pi-a", { macs: ["02:00:00:00:00:01"] });
    const b = seen("pi-b", { macs: ["02:00:00:00:00:02"] });
    const g = groupByMachine([b, a], []);
    assert.deepEqual(g.machines, []);
    assert.deepEqual(g.plain.map((d) => d.id), ["pi-b", "pi-a"]);
  });

  it("does not group a plain device with an output that shares its MAC", () => {
    const g = groupByMachine([seen("m.sdi-1", { output: out("SDI 1") }), seen("mac-kiosk")], []);
    assert.deepEqual(g.plain.map((d) => d.id), ["mac-kiosk"]);
    assert.equal(g.machines[0].rows.length, 1);
  });

  it("keeps two Macs apart", () => {
    const g = groupByMachine(
      [
        seen("a.sdi-1", { output: out("SDI 1"), macs: ["02:00:00:00:00:0a"], hostname: "booth-a" }),
        seen("b.sdi-1", { output: out("SDI 1"), macs: ["02:00:00:00:00:0b"], hostname: "booth-b" }),
      ],
      [],
    );
    assert.deepEqual(g.machines.map((m) => m.hostname), ["booth-a", "booth-b"]);
  });

  it("matches MACs whatever their case", () => {
    const g = groupByMachine(
      [seen("m.sdi-1", { output: out("SDI 1") }), seen("m.sdi-2", { output: out("SDI 2"), macs: [MAC.toUpperCase()] })],
      [],
    );
    assert.equal(g.machines.length, 1);
  });

  it("joins outputs that share any one MAC", () => {
    const g = groupByMachine(
      [
        seen("m.sdi-1", { output: out("SDI 1"), macs: ["02:00:00:00:00:01", "02:00:00:00:00:02"] }),
        seen("m.sdi-2", { output: out("SDI 2"), macs: ["02:00:00:00:00:02"] }),
      ],
      [],
    );
    assert.equal(g.machines.length, 1);
  });

  it("an output with no MAC at all cannot be placed, so it reads as a plain device", () => {
    const g = groupByMachine([seen("m.sdi-1", { output: out("SDI 1"), macs: [] })], []);
    assert.deepEqual(g.plain.map((d) => d.id), ["m.sdi-1"]);
    assert.deepEqual(g.machines, []);
  });
});

describe("the outputs already set up", () => {
  it("sit among their unclaimed siblings, marked as bound", () => {
    const g = groupByMachine(
      [seen("m.sdi-2", { output: out("SDI 2") })],
      [bound("m.sdi-1", { output: out("SDI 1") })],
    );
    assert.deepEqual(g.machines[0].rows.map((r) => [r.device.id, r.state]), [
      ["m.sdi-1", "bound"],
      ["m.sdi-2", "unclaimed"],
    ]);
  });

  it("do not make a machine on their own", () => {
    const g = groupByMachine([], [bound("m.sdi-1", { output: out("SDI 1") })]);
    assert.deepEqual(g.machines, [], "a Mac with everything set up was listed as not set up yet");
  });

  it("never include a bound device that is not an output", () => {
    const g = groupByMachine([seen("m.sdi-1", { output: out("SDI 1") })], [bound("mac-kiosk")]);
    assert.deepEqual(ids(g.machines[0].rows), ["m.sdi-1"]);
  });

  it("never include a device bound on another Mac", () => {
    const g = groupByMachine(
      [seen("m.sdi-1", { output: out("SDI 1") })],
      [bound("x.sdi-1", { output: out("SDI 1"), macs: ["02:00:00:00:00:99"] })],
    );
    assert.deepEqual(ids(g.machines[0].rows), ["m.sdi-1"]);
  });
});

describe("the order a person reads them in", () => {
  const rows = (g: ReturnType<typeof groupByMachine>) => ids(g.machines[0].rows);

  it("is displays first, then SDI ports, each counted naturally", () => {
    const g = groupByMachine(
      [
        seen("m.sdi-10", { output: out("SDI 10") }),
        seen("m.sdi-2", { output: out("SDI 2") }),
        seen("m.hdmi-1", { output: out("HDMI 1", "display") }),
        seen("m.sdi-1", { output: out("SDI 1") }),
      ],
      [],
    );
    assert.deepEqual(rows(g), ["m.hdmi-1", "m.sdi-1", "m.sdi-2", "m.sdi-10"]);
  });

  it("does not depend on which output was heard last", () => {
    const list = [
      seen("m.sdi-2", { output: out("SDI 2"), lastSeen: 9 }),
      seen("m.sdi-1", { output: out("SDI 1"), lastSeen: 1 }),
    ];
    assert.deepEqual(rows(groupByMachine(list, [])), rows(groupByMachine([...list].reverse(), [])));
  });

  it("machines are in hostname order, whatever was heard last", () => {
    const list = [
      seen("b.sdi-1", { output: out("SDI 1"), macs: ["02:00:00:00:00:0b"], hostname: "booth-b" }),
      seen("a.sdi-1", { output: out("SDI 1"), macs: ["02:00:00:00:00:0a"], hostname: "booth-a" }),
    ];
    assert.deepEqual(groupByMachine(list, []).machines.map((m) => m.hostname), ["booth-a", "booth-b"]);
  });
});
