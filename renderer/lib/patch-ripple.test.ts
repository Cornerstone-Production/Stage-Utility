// patch-ripple.test.ts — the ripple fill's arithmetic, called directly.
//
// The editor's own tests (settings/sections/patch-editor.test.tsx) drive one fill
// through the table; this pins the rules underneath it, each of which would
// otherwise only show as a wrong channel number on a patch sheet.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { bumpValue, generateLabels, rippleEndpoints } from "./patch-ripple.js";

const dev = (id: string, inputs: number, inLabels?: string[]): PatchDevice => ({ id, name: id, kind: "snake", inputs, outputs: 0, inLabels });
const hop = (deviceId: string, connector: string): PatchHop => ({ deviceId, connector });

describe("bumpValue", () => {
  test("increments the trailing integer, keeping prefix, suffix and zero padding", () => {
    assert.equal(bumpValue("1", 1), "2");
    assert.equal(bumpValue("B-1", 3), "B-4");
    assert.equal(bumpValue("09", 1), "10");
    assert.equal(bumpValue("L-3-2", 1), "L-3-3");
    assert.equal(bumpValue("7a", 2), "9a");
  });

  test("a value with no number, an empty value, a zero delta or a result below zero is returned as it was", () => {
    assert.equal(bumpValue("L", 2), "L");
    assert.equal(bumpValue("", 2), "");
    assert.equal(bumpValue("5", 0), "5");
    assert.equal(bumpValue("2", -3), "2");
  });
});

describe("rippleEndpoints", () => {
  const run = (over: Partial<Parameters<typeof rippleEndpoints>[0]>) =>
    rippleEndpoints({ endpoints: [], rackId: "r", dir: "in", startIndex: 3, field: "consoleChannel", value: "10", count: 3, rackChannels: 8, ...over });
  const byIndex = (list: PatchEndpoint[]) => list.map((e) => [e.index, e.consoleChannel] as const).sort((a, b) => a[0] - b[0]);

  test("a numeric field increments down a run of exactly `count` channels, starting at the edited row", () => {
    assert.deepEqual(byIndex(run({})), [[3, "10"], [4, "11"], [5, "12"]]);
  });

  test("the run is clamped to the rack, and 'end' runs to its last channel", () => {
    assert.deepEqual(byIndex(run({ count: 12, startIndex: 7 })), [[7, "10"], [8, "11"]]);
    assert.deepEqual(byIndex(run({ count: "end", startIndex: 6 })), [[6, "10"], [7, "11"], [8, "12"]]);
  });

  test("a text field copies down unchanged, and a toggle copies its value", () => {
    const mics = run({ field: "mic", value: "SM58", count: 2 });
    assert.deepEqual(mics.map((e) => [e.index, e.mic]).sort(), [[3, "SM58"], [4, "SM58"]]);
    const phantom = run({ field: "phantom", value: true, count: 2 });
    assert.deepEqual(phantom.map((e) => e.phantom), [true, true]);
  });

  test("only the one field is written: every other column on a row it reaches is kept", () => {
    const out = run({ endpoints: [{ rackId: "r", dir: "in", index: 4, label: "Snare", mic: "Beta 57" }], count: 2 });
    const row4 = out.find((e) => e.index === 4)!;
    assert.equal(row4.consoleChannel, "11");
    assert.equal(row4.label, "Snare");
    assert.equal(row4.mic, "Beta 57");
  });

  test("a row in another rack or direction with the same index is not touched", () => {
    const other: PatchEndpoint[] = [
      { rackId: "x", dir: "in", index: 4, consoleChannel: "keep" },
      { rackId: "r", dir: "out", index: 4, consoleChannel: "keep" },
    ];
    const out = run({ endpoints: other, count: 2 });
    assert.equal(out.length, 4);
    assert.deepEqual(out.filter((e) => e.consoleChannel === "keep").length, 2);
  });

  test("a path's source hop rolls over from one device to the next when the first runs out", () => {
    const stage = [dev("A", 2), dev("B", 2)];
    const out = rippleEndpoints({
      endpoints: [], rackId: "r", dir: "in", startIndex: 1, field: "path", value: [hop("A", "2")],
      count: 3, rackChannels: 8, stageDevices: stage,
    });
    assert.deepEqual(out.sort((a, b) => a.index - b.index).map((e) => e.path?.[0]), [hop("A", "2"), hop("B", "1"), hop("B", "2")]);
  });

  test("the path fill stops, without inventing sources, when the devices run out", () => {
    const out = rippleEndpoints({
      endpoints: [], rackId: "r", dir: "in", startIndex: 1, field: "path", value: [hop("A", "1")],
      count: 6, rackChannels: 8, stageDevices: [dev("A", 2)],
    });
    assert.deepEqual(out.map((e) => e.index).sort(), [1, 2]);
  });

  test("a source hop not found among the devices falls back to a numeric increment", () => {
    const out = rippleEndpoints({
      endpoints: [], rackId: "r", dir: "in", startIndex: 1, field: "path", value: [hop("A", "x9")],
      count: 2, rackChannels: 8, stageDevices: [dev("A", 2)],
    });
    assert.deepEqual(out.sort((a, b) => a.index - b.index).map((e) => e.path?.[0].connector), ["x9", "x10"]);
  });

  test("a device's generated labels are the slots, in place of 1..n", () => {
    const out = rippleEndpoints({
      endpoints: [], rackId: "r", dir: "in", startIndex: 1, field: "path", value: [hop("A", "A-1")],
      count: 2, rackChannels: 8, stageDevices: [dev("A", 2, ["A-1", "A-2"])],
    });
    assert.deepEqual(out.sort((a, b) => a.index - b.index).map((e) => e.path?.[0].connector), ["A-1", "A-2"]);
  });
});

describe("generateLabels", () => {
  test("prefix plus a run from start, and nothing for a count below one", () => {
    assert.deepEqual(generateLabels(3, "A-", 5), ["A-5", "A-6", "A-7"]);
    assert.deepEqual(generateLabels(0, "A-", 1), []);
    assert.deepEqual(generateLabels(-2, "A-", 1), []);
  });
});
