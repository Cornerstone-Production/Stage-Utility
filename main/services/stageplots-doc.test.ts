// resolvePlot: which of a venue's plots a plan shows. The server and the
// renderer share it, so /stageplots, its print and the edit page's This week
// card cannot disagree about it.
//
// Every name below is invented. This is a public repository.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Plot, PlotOverride, Venue } from "../types/stageplots.js";
import { overridesOfPlot, resolvePlot } from "./stageplots-doc.js";

function plot(id: string, venueId: string): Plot {
  return { id, venueId, name: id, backgroundId: null, bgFade: 0.4, items: [], version: 0 };
}

function doc(overrides: PlotOverride[] = []) {
  const venues: Venue[] = [
    { id: "v-main", name: "Room One", kind: "home", notes: "", plotIds: ["p-std", "p-bap", "p-xmas"], defaultPlotId: "p-std" },
    { id: "v-off", name: "Hall Away", kind: "offsite", notes: "", plotIds: ["p-hall"], defaultPlotId: "p-hall" },
    { id: "v-empty", name: "Room Two", kind: "home", notes: "", plotIds: [], defaultPlotId: null },
  ];
  const plots = [plot("p-std", "v-main"), plot("p-bap", "v-main"), plot("p-xmas", "v-main"), plot("p-hall", "v-off")];
  return { venues, plots, overrides };
}

const ov = (planId: string, venueId: string, plotId: string): PlotOverride => ({ planId, venueId, plotId, planDate: null });

describe("resolvePlot", () => {
  test("an override wins for its plan", () => {
    const r = resolvePlot(doc([ov("plan-9am", "v-main", "p-bap")]), "v-main", "plan-9am");
    assert.equal(r.plot?.id, "p-bap");
    assert.equal(r.reason, "plan");
  });

  test("another plan gets the default", () => {
    const r = resolvePlot(doc([ov("plan-9am", "v-main", "p-bap")]), "v-main", "plan-11am");
    assert.equal(r.plot?.id, "p-std");
    assert.equal(r.reason, "default");
  });

  test("two plans on one day each get their own override", () => {
    const d = doc([ov("plan-9am", "v-main", "p-bap"), ov("plan-11am", "v-main", "p-xmas")]);
    assert.equal(resolvePlot(d, "v-main", "plan-9am").plot?.id, "p-bap");
    assert.equal(resolvePlot(d, "v-main", "plan-11am").plot?.id, "p-xmas");
  });

  test("an override is for its venue only", () => {
    const r = resolvePlot(doc([ov("plan-9am", "v-main", "p-bap")]), "v-off", "plan-9am");
    assert.deepEqual([r.plot?.id, r.reason], ["p-hall", "default"]);
  });

  test("no plan reads the default, whatever overrides exist", () => {
    const r = resolvePlot(doc([ov("plan-9am", "v-off", "p-hall"), ov("plan-9am", "v-main", "p-bap")]), "v-main", null);
    assert.deepEqual([r.plot?.id, r.reason], ["p-std", "default"]);
  });

  test("an override to a deleted plot falls back to the default", () => {
    const d = doc([ov("plan-9am", "v-main", "p-gone")]);
    const r = resolvePlot(d, "v-main", "plan-9am");
    assert.deepEqual([r.plot?.id, r.reason], ["p-std", "default"]);
  });

  test("an override to another venue's plot falls back to the default", () => {
    const r = resolvePlot(doc([ov("plan-9am", "v-main", "p-hall")]), "v-main", "plan-9am");
    assert.deepEqual([r.plot?.id, r.reason], ["p-std", "default"]);
  });

  test("a venue with no plots resolves to none", () => {
    assert.deepEqual(resolvePlot(doc(), "v-empty", "plan-9am"), { plot: null, reason: "default" });
    assert.deepEqual(resolvePlot(doc(), "v-unknown", "plan-9am"), { plot: null, reason: "default" });
  });

  test("overridesOfPlot lists the overrides a plot's delete would clear", () => {
    const d = doc([ov("plan-a", "v-main", "p-bap"), ov("plan-b", "v-main", "p-xmas"), ov("plan-c", "v-main", "p-bap")]);
    assert.deepEqual(
      overridesOfPlot(d, "p-bap").map((o) => o.planId),
      ["plan-a", "plan-c"],
    );
  });
});
