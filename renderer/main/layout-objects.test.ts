// Golden test for the layout-object registry.
//
// The registry replaced seven hand-maintained structures. The values below are
// copied verbatim from those structures as they were BEFORE the consolidation,
// so this asserts the refactor was behaviour-preserving: same labels, same
// palette contents and order, same defaults for every type. If a future change
// to the registry alters an existing type's defaults, this fails loudly rather
// than quietly changing what a placed object looks like on a stage monitor.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import type { LayoutObjectType } from "../../main/types/stage.js";
import {
  LAYOUT_OBJECTS,
  PALETTE_GROUPS,
  defaultConfig,
  defaultStyle,
  isStylingOnly,
  objectIntegration,
  typeLabel,
  usesPropInstance,
} from "./layout-objects.js";

// ── The originals ─────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  text: "Text", clock: "Clock", "countdown-timer": "PCO countdown", "service-pacing": "Service pacing",
  "pp-timer": "ProPresenter timer", "slide-progress": "Slide progress", "wireless-channel": "Mic channel",
  "current-slide-text": "Current slide", "next-slide-text": "Next slide", "current-service-item": "Current item",
  "next-service-item": "Next item", "service-order": "Service order", "current-slide-notes": "Slide notes",
  "slide-thumbnail": "Slide image", "section-chip": "Section chip", "slots-grid": "Mic slots",
  "transcript-strip": "Transcription", "live-controls": "PCO Prev/Next", "charger-battery": "Charger battery",
  "spl-meter": "SPL meter", "obs-status": "OBS status", "reaper-status": "REAPER status",
  "osc-button": "OSC button", "integration-status": "Integration status", "wireless-summary": "Wireless summary",
  "people-counter": "People counter", "people-graph": "People graph", "people-panel": "People summary",
  "baptism-timer": "Baptism timer", "brand-logo": "Logo", "ndi-video": "NDI video", image: "Image",
  "plan-attachment": "Plan file", shape: "Shape", container: "Container",
};

const ORIGINAL_PALETTE: { label: string; types: string[] }[] = [
  { label: "Layout", types: ["container", "shape", "image", "brand-logo"] },
  { label: "Text & time", types: ["text", "clock", "countdown-timer"] },
  { label: "PCO / service", types: ["live-controls", "current-service-item", "next-service-item", "service-order", "service-pacing", "plan-attachment"] },
  { label: "ProPresenter", types: ["current-slide-text", "next-slide-text", "current-slide-notes", "slide-thumbnail", "section-chip", "pp-timer", "slide-progress"] },
  { label: "Mics & RF", types: ["slots-grid", "charger-battery", "wireless-summary", "wireless-channel"] },
  { label: "Audio (SPL)", types: ["spl-meter"] },
  { label: "Transcription", types: ["transcript-strip"] },
  { label: "People", types: ["people-counter", "people-panel", "people-graph"] },
  { label: "Baptisms", types: ["baptism-timer"] },
  { label: "OBS", types: ["obs-status"] },
  { label: "REAPER", types: ["reaper-status"] },
  { label: "Control", types: ["osc-button"] },
  { label: "Status", types: ["integration-status"] },
];

const NO_CONFIG_TYPES = [
  "current-slide-text", "next-slide-text", "current-service-item", "next-service-item",
  "current-slide-notes", "slide-thumbnail", "live-controls", "ndi-video",
];

const PROP_OBJECT_TYPES = [
  "current-slide-text", "next-slide-text", "current-service-item", "next-service-item",
  "current-slide-notes", "slide-thumbnail", "section-chip", "pp-timer", "slide-progress",
];

const OBJECT_INTEGRATION: Record<string, { id: string; label: string }> = {
  "spl-meter": { id: "smaart", label: "Smaart SPL" },
  "obs-status": { id: "obs", label: "OBS" },
  "reaper-status": { id: "reaper", label: "REAPER" },
  "people-counter": { id: "sensource", label: "SenSource" },
  "people-graph": { id: "sensource", label: "SenSource" },
  "osc-button": { id: "osc", label: "OSC" },
  "transcript-strip": { id: "prodcom", label: "transcription" },
  "charger-battery": { id: "wireless", label: "wireless" },
  "wireless-summary": { id: "wireless", label: "wireless" },
  "wireless-channel": { id: "wireless", label: "wireless" },
};

const CARD_NEUTRAL = {
  background: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.08)",
  borderWidth: 0.001, cornerRadius: 0.0148, padding: 0.0148,
};
const BASE_TEXT = { fontSize: 0.06, fontWeight: 500, color: "#ffffff", textAlign: "center", vAlign: "middle" };

/** defaultStyle() as it was, branch for branch. */
function originalStyle(type: string): Record<string, unknown> {
  if (type === "shape") return { background: "#3b82f6", opacity: 1 };
  if (type === "container") return { ...CARD_NEUTRAL };
  if (["ndi-video", "slide-thumbnail", "image", "plan-attachment", "brand-logo", "live-controls"].includes(type)) return {};
  if (type === "transcript-strip") return { fontSize: 0.045, fontWeight: 500, color: "#ffffff", textAlign: "left", vAlign: "bottom" };
  if (type === "charger-battery") return { fontSize: 0.045, fontWeight: 500, color: "#ffffff", textAlign: "left", vAlign: "middle" };
  if (type === "service-order") return { fontSize: 0.035, fontWeight: 500, color: "#ffffff", textAlign: "left", vAlign: "top" };
  if (type === "obs-status") return { fontSize: 0.05, fontWeight: 700, color: "#ffffff", textAlign: "center", vAlign: "middle", uppercase: true, ...CARD_NEUTRAL };
  if (type === "reaper-status") return { fontSize: 0.05, fontWeight: 700, color: "#ffffff", textAlign: "center", vAlign: "middle", uppercase: true, ...CARD_NEUTRAL };
  if (type === "osc-button") return { fontSize: 0.045, fontWeight: 600, color: "#ffffff", textAlign: "center", vAlign: "middle", ...CARD_NEUTRAL };
  if (type === "people-counter") return { fontSize: 0.12, fontWeight: 700, color: "#ffffff", textAlign: "center", vAlign: "middle" };
  if (type === "baptism-timer") return { fontSize: 0.14, fontWeight: 700, color: "#ffffff", textAlign: "center", vAlign: "middle" };
  if (type === "pp-timer" || type === "service-pacing") return { fontSize: 0.1, fontWeight: 700, color: "#ffffff", textAlign: "center", vAlign: "middle" };
  if (type === "wireless-channel") return { fontSize: 0.05, fontWeight: 600, color: "#ffffff", textAlign: "center", vAlign: "middle", ...CARD_NEUTRAL };
  if (type === "people-panel") return { fontSize: 0.1, fontWeight: 700, color: "#ffffff", textAlign: "center", vAlign: "middle" };
  if (type === "integration-status" || type === "wireless-summary") return { fontSize: 0.05, fontWeight: 600, color: "#ffffff", textAlign: "center", vAlign: "middle", ...CARD_NEUTRAL };
  if (type === "people-graph") return { color: "#5b9cff", ...CARD_NEUTRAL };
  return { ...BASE_TEXT };
}

/** defaultConfig() as it was, case for case. */
const ORIGINAL_CONFIG: Record<string, unknown> = {
  text: { type: "text", text: "Text" },
  clock: { type: "clock", showSeconds: true, format: "12h" },
  "section-chip": { type: "section-chip", which: "current" },
  "slots-grid": { type: "slots-grid", source: "inline", sourceViewId: null },
  "transcript-strip": { type: "transcript-strip", mode: "rolling" },
  "charger-battery": { type: "charger-battery", bays: [], show: { battery: true, charging: true } },
  "spl-meter": { type: "spl-meter", meterId: null, metricKey: null, showLabel: false, thresholds: null },
  "obs-status": { type: "obs-status", mode: "recording", showTimecode: false, hideWhenIdle: false, fillWhenRecording: true },
  "reaper-status": { type: "reaper-status", showPosition: false, hideWhenIdle: false, fillWhenRecording: true },
  "osc-button": { type: "osc-button", targetId: null, label: "Button", address: "/", args: [], feedback: null },
  "integration-status": { type: "integration-status", integrationId: null, showLabel: true },
  "wireless-summary": { type: "wireless-summary", showOnline: true, showBattery: true, showLabel: false, label: "Mics" },
  "wireless-channel": { type: "wireless-channel", channelId: null, show: { rf: true, battery: true, frequency: true, audio: false }, showLabel: true },
  "service-pacing": { type: "service-pacing", hideWhenIdle: false, showLabel: false },
  "pp-timer": { type: "pp-timer", timerName: null, propresenterInstanceId: null, warnStates: true, hideWhenIdle: false, showLabel: true },
  "slide-progress": { type: "slide-progress", propresenterInstanceId: null, display: "fraction", showLabel: false },
  "people-counter": { type: "people-counter", metric: "attendance", zoneId: null, label: "People", showLabel: true },
  "people-graph": { type: "people-graph", metric: "occupancy", showLabel: true, label: "In room" },
  "people-panel": { type: "people-panel", metrics: ["occupancy", "peak", "attendance"], showLabels: true, orientation: "row" },
  "baptism-timer": { type: "baptism-timer", field: "live", showLabel: true, label: "" },
  "brand-logo": { type: "brand-logo", useEmptySlotLogo: false },
  image: { type: "image", src: "" },
  "plan-attachment": { type: "plan-attachment", match: "stage plot", page: 1 },
  shape: { type: "shape", shape: "rect" },
  "service-order": { type: "service-order", noteCategories: null, showLength: false, highlightLive: true, scroll: "auto", autoFit: true },
  container: { type: "container" },
  // Types that fell through defaultConfig's `default:` arm — bare discriminant.
  "countdown-timer": { type: "countdown-timer" },
  "live-controls": { type: "live-controls" },
  "current-slide-text": { type: "current-slide-text" },
  "next-slide-text": { type: "next-slide-text" },
  "current-service-item": { type: "current-service-item" },
  "next-service-item": { type: "next-service-item" },
  "current-slide-notes": { type: "current-slide-notes" },
  "slide-thumbnail": { type: "slide-thumbnail" },
  "ndi-video": { type: "ndi-video" },
};

const ALL = Object.keys(TYPE_LABELS);

/**
 * Types added deliberately AFTER the consolidation. The originals above stay pinned
 * so they can never drift; new entries are listed here so the guard keeps working
 * instead of being weakened every time an object type is added.
 */
const ADDED_SINCE: { type: string; label: string; group: string; after: string }[] = [
  { type: "rosstalk-button", label: "RossTalk button", group: "Control", after: "osc-button" },
];

// ── Assertions ────────────────────────────────────────────────────────────────

describe("layout-object registry vs. the structures it replaced", () => {
  test("still covers every original type, plus only deliberate additions", () => {
    const actual = Object.keys(LAYOUT_OBJECTS).sort();
    const expected = [...ALL, ...ADDED_SINCE.map((a) => a.type)].sort();
    assert.deepEqual(actual, expected,
      "an unexpected type appeared or an original vanished — add it to ADDED_SINCE if intended");
  });

  test("deliberate additions carry the label and group they claim", () => {
    for (const a of ADDED_SINCE) {
      assert.equal(typeLabel(a.type as never), a.label);
      assert.equal(LAYOUT_OBJECTS[a.type as LayoutObjectType].group, a.group);
    }
  });

  test("labels are unchanged", () => {
    for (const t of ALL) assert.equal(typeLabel(t as never), TYPE_LABELS[t], `label for ${t}`);
  });

  test("palette groups and their order are unchanged for the original types", () => {
    // Filter out deliberate additions, then the palette must match the original
    // exactly — same groups, same order within each group.
    const added = new Set(ADDED_SINCE.map((a) => a.type));
    const actual = PALETTE_GROUPS.map((g) => ({
      label: g.label as string,
      types: (g.types as string[]).filter((t) => !added.has(t)),
    })).filter((g) => g.types.length > 0);
    assert.deepEqual(actual, ORIGINAL_PALETTE);
  });

  test("each addition sits directly after the type it claims to follow", () => {
    // Pins placement too, so a new object cannot silently reorder the palette.
    for (const a of ADDED_SINCE) {
      const group = PALETTE_GROUPS.find((g) => (g.types as string[]).includes(a.type));
      assert.ok(group, `${a.type} is not in the palette`);
      const types = group!.types as string[];
      assert.equal(types[types.indexOf(a.after) + 1], a.type,
        `${a.type} should sit immediately after ${a.after}`);
    }
  });

  test("ndi-video stays OUT of the palette", () => {
    // Placed by the native client, never added by hand.
    const inPalette = PALETTE_GROUPS.flatMap((g) => g.types as string[]);
    assert.ok(!inPalette.includes("ndi-video"));
  });

  test("styling-only types are unchanged", () => {
    const actual = ALL.filter((t) => isStylingOnly(t as never)).sort();
    assert.deepEqual(actual, [...NO_CONFIG_TYPES].sort());
  });

  test("ProPresenter-instance types are unchanged", () => {
    const actual = ALL.filter((t) => usesPropInstance(t as never)).sort();
    assert.deepEqual(actual, [...PROP_OBJECT_TYPES].sort());
  });

  test("integration requirements are unchanged", () => {
    for (const t of ALL) {
      assert.deepEqual(objectIntegration(t as never) ?? undefined, OBJECT_INTEGRATION[t], `integration for ${t}`);
    }
  });

  test("default config is unchanged for every type", () => {
    for (const t of ALL) {
      assert.deepEqual(defaultConfig(t as never), ORIGINAL_CONFIG[t], `defaultConfig("${t}")`);
    }
  });

  test("default style is unchanged for every type", () => {
    for (const t of ALL) {
      assert.deepEqual(defaultStyle(t as never), originalStyle(t), `defaultStyle("${t}")`);
    }
  });

  test("defaults are fresh objects, not shared references", () => {
    // The old code built a new object per call; a registry holding literals could
    // hand every placed object the SAME object and make edits leak between them.
    const a = defaultConfig("text" as never);
    const b = defaultConfig("text" as never);
    assert.notEqual(a, b, "defaultConfig must not return a shared object");

    const sa = defaultStyle("container" as never);
    const sb = defaultStyle("container" as never);
    assert.notEqual(sa, sb, "defaultStyle must not return a shared object");
  });
});
