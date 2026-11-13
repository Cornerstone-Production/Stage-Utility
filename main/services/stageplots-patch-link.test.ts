// A connection point linked to a patch device, resolved: the one reading the editor,
// /stageplots, print and the publisher all use. Synthetic patch data only.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PatchFile, PatchSheet } from "../types/patch.js";
import type { PatchLink, PlotItem } from "../types/stageplots.js";
import { publishedItems, resolveItems, resolvePatchLink, stampLinks, swatchOf, tapChannels, type PatchRead } from "./stageplots-patch-link.js";

function sheet(over: Partial<PatchSheet> = {}): PatchSheet {
  return {
    id: "main",
    name: "Main patch",
    kind: "analog",
    devices: [
      { id: "rack-a", name: "Rack A", kind: "rack", inputs: 32, outputs: 16 },
      { id: "sb1", name: "SB-1", kind: "snake", inputs: 16, outputs: 4, color: "#0091ff" },
      { id: "fp3", name: "FP-3", kind: "pocket", inputs: 4, outputs: 0, color: "#12a594" },
    ],
    endpoints: [
      { rackId: "rack-a", dir: "in", index: 2, consoleChannel: "2", label: "Kick Out", path: [{ deviceId: "sb1", connector: "2" }] },
      { rackId: "rack-a", dir: "in", index: 1, consoleChannel: "1", label: "Kick In", path: [{ deviceId: "sb1", connector: "1" }] },
      { rackId: "rack-a", dir: "in", index: 3, consoleChannel: "3", label: "Lectern", path: [{ deviceId: "fp3", connector: "1" }, { deviceId: "sb1", connector: "9" }] },
      { rackId: "rack-a", dir: "in", index: 4, consoleChannel: "4", label: "Spare", path: [{ deviceId: "sb1", connector: "4" }], unused: true },
      { rackId: "rack-a", dir: "out", index: 1, consoleChannel: "Mix 1", label: "Wedge 1", path: [{ deviceId: "sb1", connector: "A" }] },
      { rackId: "rack-a", dir: "in", index: 5, consoleChannel: "5", label: "Keys L", path: [{ deviceId: "fp3", connector: "2" }] },
    ],
    variants: [{ id: "var-x", name: "Special", overrides: { "rack-a:in:5": { path: [{ deviceId: "sb1", connector: "12" }] } } }],
    assignments: { byServiceType: {}, byPlan: { "plan-wk": { variantId: "var-x", tweaks: { "rack-a:in:1": { label: "Kick In (borrowed)" } } } } },
    ...over,
  };
}

const read = (sheets: PatchSheet[] = [sheet()]): PatchRead => ({ ok: true, file: { sheets, updatedAt: "" } as PatchFile });
const NO_PLAN = { serviceTypeId: null, planId: null };
const link = (over: Partial<PatchLink> = {}): PatchLink => ({ sheetId: "main", deviceId: "sb1", lastName: "Old name", lastColor: "#e5484d", ...over });
const conn = (id: string, over: Partial<PlotItem> = {}): PlotItem => ({
  id,
  type: "conn",
  x: 10,
  y: 10,
  w: 25,
  h: 25,
  rotation: 0,
  label: "Old name",
  color: "#e5484d",
  notes: "",
  inputs: ["Kick In"],
  ...over,
});

describe("resolving a patch link", () => {
  test("a linked point takes the device's current name and colour", () => {
    const r = resolvePatchLink(link(), read(), NO_PLAN);
    assert.equal(r.state, "linked");
    assert.equal(r.name, "SB-1");
    assert.equal(r.color, "#0091ff");
    assert.ok(r.state === "linked" && r.sheet === "Main patch" && r.device.kind === "snake");
  });

  test("channels are those whose path includes the device, for the plan's resolved patch", () => {
    const def = resolvePatchLink(link(), read(), NO_PLAN);
    assert.ok(def.state === "linked");
    assert.deepEqual(def.channels, [
      { channel: "Ch 1", label: "Kick In", path: "SB-1/1" },
      { channel: "Ch 2", label: "Kick Out", path: "SB-1/2" },
      { channel: "Ch 3", label: "Lectern", path: "SB-1/9" },
      { channel: "Mix 1", label: "Wedge 1", path: "SB-1/A" },
    ]);
    // The week's variant re-patches Keys L onto SB-1, and its tweak renames channel 1.
    const week = resolvePatchLink(link(), read(), { serviceTypeId: null, planId: "plan-wk" });
    assert.ok(week.state === "linked");
    assert.deepEqual(
      week.channels.map((c) => `${c.channel} ${c.label} ${c.path}`),
      ["Ch 1 Kick In (borrowed) SB-1/1", "Ch 2 Kick Out SB-1/2", "Ch 3 Lectern SB-1/9", "Ch 5 Keys L SB-1/12", "Mix 1 Wedge 1 SB-1/A"],
    );
  });

  test("a rack lists the set channels on it, by its own connector labels", () => {
    const s = sheet();
    s.devices[0]!.inLabels = ["R1", "R2", "R3", "R4", "R5"];
    const r = resolvePatchLink(link({ deviceId: "rack-a" }), read([s]), NO_PLAN);
    assert.ok(r.state === "linked");
    assert.deepEqual(r.channels.map((c) => c.path), ["Rack A/R1", "Rack A/R2", "Rack A/R3", "Rack A/R5", "Rack A/1"]);
  });

  test("a row names only the linked device and its connector, never the rest of the chain", () => {
    const r = resolvePatchLink(link({ deviceId: "sb1" }), read(), NO_PLAN);
    assert.ok(r.state === "linked");
    assert.ok(!JSON.stringify(r.channels).includes("FP-3"));
    assert.ok(!JSON.stringify(r.channels).includes("Rack A"));
  });

  test("a removed device reads removed with the last name", () => {
    assert.deepEqual(resolvePatchLink(link({ deviceId: "gone" }), read(), NO_PLAN), { state: "unlinked", reason: "removed", name: "Old name", color: "#e5484d" });
    assert.deepEqual(resolvePatchLink(link({ sheetId: "gone" }), read(), NO_PLAN), { state: "unlinked", reason: "removed", name: "Old name", color: "#e5484d" });
  });

  test("an unreadable store reads unavailable", () => {
    assert.deepEqual(resolvePatchLink(link(), { ok: false }, NO_PLAN), { state: "unlinked", reason: "unavailable", name: "Old name", color: "#e5484d" });
  });

  test("a device colour off the ten swatches takes the nearest; a name past 60 characters is clipped", () => {
    assert.equal(swatchOf("#0091FF"), "#0091ff");
    assert.equal(swatchOf("#2563eb"), "#3e63dd");
    assert.equal(swatchOf("red"), null);
    assert.equal(swatchOf(undefined), null);
    const s = sheet();
    s.devices[1]!.name = `  ${"N".repeat(70)}  `;
    const r = resolvePatchLink(link(), read([s]), NO_PLAN);
    assert.equal(r.name, "N".repeat(60));
  });

  test("a malformed patch (numbers for text, nulls, lists that are not lists) reads, never throws", () => {
    const odd = {
      id: "main",
      name: 7,
      kind: "analog",
      devices: [null, { id: "sb1", name: 101, kind: { not: "a kind" }, inputs: "16", outputs: -2, color: 42, inLabels: "A1" }],
      endpoints: [null, { rackId: "r", dir: "in", index: 1, consoleChannel: 3, label: 9, path: [null, { deviceId: "sb1", connector: 4 }] }, { rackId: "r", dir: "in", index: 2, path: "sb1" }],
      variants: "none",
    } as unknown as PatchSheet;
    const r = resolvePatchLink(link(), read([odd]), { serviceTypeId: "st", planId: "p" });
    assert.ok(r.state === "linked");
    assert.deepEqual([r.name, r.color, r.sheet, r.device], ["101", null, "7", { kind: "other", inputs: 0, outputs: 0 }]);
    assert.deepEqual(r.channels, [{ channel: "Ch 3", label: "9", path: "101/4" }]);
    assert.equal(resolvePatchLink(link(), { ok: true, file: { updatedAt: "" } as unknown as PatchFile }, NO_PLAN).state, "unlinked");
    const proto = { ...odd, devices: [{ id: "sb1", name: "Box", kind: "__proto__", inputs: 1, outputs: 0 }] } as unknown as PatchSheet;
    const viaProto = resolvePatchLink(link(), read([proto]), NO_PLAN);
    assert.ok(viaProto.state === "linked" && viaProto.device.kind === "other");
    assert.equal(resolvePatchLink(link(), read([{ id: "main", devices: "x" } as unknown as PatchSheet]), NO_PLAN).state, "unlinked");
  });

  test("a linked device with no channels lists the point's inputs: tapChannels is null", () => {
    const r = resolvePatchLink(link({ deviceId: "rack-a" }), read([sheet({ endpoints: [] })]), NO_PLAN);
    assert.equal(tapChannels(r), null);
    assert.equal(tapChannels(resolvePatchLink(link(), { ok: false }, NO_PLAN)), null);
  });
});

describe("items as shown, saved and published", () => {
  test("resolveItems keeps every item that did not change, and the list when none did", () => {
    const plain = conn("plain");
    const items = [plain, conn("linked", { patchLink: link() })];
    const shown = resolveItems(items, read(), NO_PLAN);
    assert.equal(shown.items[0], plain);
    assert.deepEqual([shown.items[1]!.label, shown.items[1]!.color], ["SB-1", "#0091ff"]);
    assert.equal(shown.links.get("linked")?.state, "linked");
    const settled = [plain, conn("linked", { label: "SB-1", color: "#0091ff", patchLink: link() })];
    assert.equal(resolveItems(settled, read(), NO_PLAN).items, settled);
    // Not read yet: the items as saved.
    assert.equal(resolveItems(items, null, NO_PLAN).items, items);
  });

  test("an unlinked point shows its last name and colour", () => {
    const shown = resolveItems([conn("x", { label: "drifted", patchLink: link() })], { ok: false }, NO_PLAN);
    assert.deepEqual([shown.items[0]!.label, shown.items[0]!.color], ["Old name", "#e5484d"]);
  });

  test("stampLinks saves what was shown: label, colour, last name and last colour", () => {
    const items = [conn("a", { patchLink: link() }), conn("b", { patchLink: link({ deviceId: "gone" }) })];
    const { links } = resolveItems(items, read(), NO_PLAN);
    const stamped = stampLinks(items, links);
    assert.deepEqual(stamped[0]!.patchLink, { sheetId: "main", deviceId: "sb1", lastName: "SB-1", lastColor: "#0091ff" });
    assert.deepEqual([stamped[0]!.label, stamped[0]!.color], ["SB-1", "#0091ff"]);
    assert.equal(stamped[1], items[1]);
    assert.equal(stampLinks(stamped, links), stamped);
  });

  test("published items carry the resolved name, colour and channels, never the link", () => {
    const { items, unresolved } = publishedItems([conn("a", { patchLink: link() }), conn("b", { patchLink: link({ deviceId: "gone" }) })], read(), NO_PLAN);
    assert.equal(items[0]!.label, "SB-1");
    assert.equal(items[0]!.patch?.sheet, "Main patch");
    assert.equal(items[0]!.patch?.channels.length, 4);
    assert.equal("patchLink" in items[0]!, false);
    assert.equal("patchLink" in items[1]!, false);
    assert.equal(items[1]!.patch, undefined);
    assert.deepEqual(unresolved, [{ label: "Old name", reason: "removed" }]);
  });
});
