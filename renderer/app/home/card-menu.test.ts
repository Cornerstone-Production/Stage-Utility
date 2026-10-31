// The Home card menu, built by the real builder with plain functions for the
// page's save and close — so what is asserted is the menu the operator sees and
// what a click on it persists, not a re-derivation of either.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { LayoutObject } from "@main/types/views";
import { buildCardMenu, type CardMenuDeps } from "./card-menu.js";
import { pickedValue } from "./card-toggles.js";
import type { ContextMenuItem } from "../../components/ui/context-menu.js";

const spl = {
  connected: true,
  meters: {
    "dev::FOH": { deviceName: "Console", channelName: "FOH L", metrics: { "SPL A Slow": 93.8, "SPL C Slow": 101.4 } },
    "dev::Stage": { deviceName: "Console", channelName: "Wedge", metrics: { "SPL A Slow": 80, "SPL C Slow": 99 } },
  },
};

function card(config: Record<string, unknown>): LayoutObject {
  return { id: "c1", x: 0, y: 0, w: 1, h: 1, z: 0, config } as unknown as LayoutObject;
}

/** A page stand-in that records what the menu saved and how often it closed. */
function page(over: Partial<CardMenuDeps> = {}) {
  const saved: LayoutObject[][] = [];
  const chosen: string[] = [];
  let closed = 0;
  const deps = (c: LayoutObject): CardMenuDeps => ({
    scoresFavourites: [],
    spl,
    splSummary: undefined,
    choosePress: (card) => chosen.push(card.id),
    cues: null,
    save: (update) => saved.push(update([c])),
    close: () => closed++,
    ...over,
  });
  return { saved, chosen, closes: () => closed, deps };
}

const shape = (items: ContextMenuItem[]) => items.map((i) => (i.separator ? "-" : i.label));

describe("the SPL card's right-click menu", () => {
  const spc = card({ type: "home-spl" });

  test("rows are Meter, Metric, a separator, Size, Show, a separator, Remove", () => {
    const menu = buildCardMenu(spc, page().deps(spc));
    // "Remove Sound level": the registry's name for this card. The approved mockup
    // abbreviates it to "Remove SPL"; the registry label is what the picker, the
    // docs and every other surface call it, so the menu follows the registry.
    assert.deepEqual(shape(menu), ["Meter", "Metric", "-", "Size", "Show", "-", "Remove Sound level"]);
  });

  test("picking a metric saves it on the card, reads back as ticked, and closes the menu", () => {
    const p = page();
    const metric = buildCardMenu(spc, p.deps(spc)).find((i) => i.label === "Metric")!;
    metric.items!.find((i) => i.label === "SPL C Slow")!.onSelect!();
    assert.equal(p.saved.length, 1);
    const written = p.saved[0][0];
    assert.equal((written.config as { metricKey?: string }).metricKey, "SPL C Slow");
    assert.equal(p.closes(), 1);

    // And the rebuilt menu ticks it, on the SAME config the click wrote.
    const again = buildCardMenu(written, page().deps(written)).find((i) => i.label === "Metric")!;
    assert.deepEqual(again.items!.filter((i) => i.checked).map((i) => i.label), ["SPL C Slow"]);
  });

  test("choosing Automatic clears the pin to the empty string", () => {
    const pinned = card({ type: "home-spl", metricKey: "SPL C Slow" });
    const p = page();
    const metric = buildCardMenu(pinned, p.deps(pinned)).find((i) => i.label === "Metric")!;
    metric.items!.find((i) => i.label === "Automatic")!.onSelect!();
    assert.equal(pickedValue(p.saved[0][0], "metricKey"), "");
  });

  test("the Metric rows follow the Meter pick", () => {
    const stage = card({ type: "home-spl", meterId: "dev::Stage" });
    const metric = buildCardMenu(stage, page().deps(stage)).find((i) => i.label === "Metric")!;
    assert.equal(metric.items!.find((i) => i.heading)?.label, "From Wedge");
  });

  test("the Metric submenu is not offered on a wall spl-meter object", () => {
    // Its automatic rule and default meter differ from the Home card's, and the
    // inspector already has a Metric picker; see PICKS.metricKey.
    const wall = card({ type: "spl-meter", meterId: null, metricKey: null });
    assert.ok(!shape(buildCardMenu(wall, page().deps(wall))).includes("Metric"));
  });

  test("Recent services keeps its own Metric submenu, from history, and not this one", () => {
    const recent = card({ type: "home-recent-services", showSpl: true });
    const summary = [{ metrics: { "LAeq 10": { leq: 88, max: 100, count: 1 } } }] as unknown as SplServiceSummary[];
    const items = buildCardMenu(recent, page({ splSummary: summary }).deps(recent));
    const metric = items.find((i) => i.label === "Metric")!;
    assert.deepEqual(metric.items!.map((i) => i.label), ["LAeq 10"]);
  });
});

describe("the right-click menu of a retired timer card", () => {
  // A Home saved with the Service timer keeps `home-live-status`; the menu opens it
  // as the Timer it reads as, so the ticks reflect what is drawn and the first
  // click writes a Timer that still sits in the tile the old card held.
  const live = { ...card({ type: "home-live-status" }), id: "home-live-status" } as LayoutObject;

  test("offers the Timer's switches, ticked as the old card drew, and names it a Timer", () => {
    const menu = buildCardMenu(live, page().deps(live));
    assert.deepEqual(shape(menu), ["Red on overrun", "Show the next item", "Hide when idle", "-", "Size", "Show", "-", "Remove Timer"]);
    const ticks = Object.fromEntries(menu.filter((i) => !i.separator && "checked" in i).map((i) => [i.label, i.checked]));
    assert.deepEqual(ticks, { "Red on overrun": true, "Show the next item": true, "Hide when idle": false });
  });

  test("a click writes a Timer and keeps the card's xl live tile", () => {
    const p = page();
    buildCardMenu(live, p.deps(live)).find((i) => i.label === "Show the next item")!.onSelect!();
    const written = p.saved[0][0];
    assert.deepEqual(written.config, { type: "timer", source: "service", nextItem: false, redOnOverrun: true });
    assert.deepEqual(written.home, { size: "xl", when: "live" });
  });

  test("a baptism Timer is offered no red and no next item, which it cannot show", () => {
    const b = card({ type: "timer", source: "baptism" });
    assert.deepEqual(shape(buildCardMenu(b, page().deps(b))), ["Hide when idle", "-", "Size", "Show", "-", "Remove Timer"]);
  });
});

describe("Size on a page arranged by hand", () => {
  test("a card grown where it stands pushes the card below down, as the edit chips do", () => {
    // The menu was a second way to resize, and the fix to the chips missed it:
    // Tall stored over the cells of the card beneath, on top of it on screen.
    const at = (id: string, size: string, col: number, row: number) =>
      ({ id, x: 0, y: 0, w: 1, h: 1, z: 0, home: { size, col, row }, config: { type: "home-spl" } }) as unknown as LayoutObject;
    const timer = at("timer", "m", 1, 1);
    const pageCards = [timer, at("below", "xl", 1, 2)];
    let written: LayoutObject[] = [];
    const menu = buildCardMenu(timer, {
      scoresFavourites: [],
      spl,
      splSummary: undefined,
      choosePress: () => {},
      cues: null,
      save: (update) => (written = update(pageCards)),
      close: () => {},
    });
    menu.find((i) => i.label === "Size")!.items!.find((i) => i.label === "Tall")!.onSelect!();
    const home = (id: string) => written.find((o) => o.id === id)!.home!;
    assert.deepEqual([home("timer").size, home("timer").row], ["tall", 1]);
    assert.equal(home("below").row, 5, "the card below was left under the grown one");
  });
});

describe("a Button's right-click menu", () => {
  const button = card({ type: "cue-button", cue: "", showDevice: true });

  test("starts with Presses…, which says what it presses now, and the rest is the card's own", () => {
    const projectors = { id: "projectors", name: "Projectors", room: "", cue: "projectors", available: true };
    const cues = { manifest: { version: 1, server: { name: "t", lanUrl: null }, switches: [], buttons: [projectors] }, states: new Map() };
    const bound = card({ type: "cue-button", cue: "projectors" });
    const named = buildCardMenu(bound, page({ cues }).deps(bound));
    assert.deepEqual(shape(named), ["Presses…", "-", "Size", "Show", "-", "Remove Button"]);
    assert.equal(named[0]!.meta, "Projectors");
    assert.equal(buildCardMenu(button, page().deps(button))[0]!.meta, "Not set", "a Button with nothing chosen says so");
  });

  test("choosing Presses… closes the menu and opens the sheet for that card", () => {
    const p = page();
    buildCardMenu(button, p.deps(button))[0]!.onSelect!();
    assert.equal(p.closes(), 1);
    assert.deepEqual(p.chosen, ["c1"]);
    assert.deepEqual(p.saved, [], "nothing is saved until the sheet is saved");
  });

  test("no other card offers it", () => {
    const clock = card({ type: "clock" });
    assert.equal(buildCardMenu(clock, page().deps(clock)).some((i) => i.label === "Presses…"), false);
  });
});
