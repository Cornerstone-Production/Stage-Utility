// Golden test for the layout-object registry.
//
// The registry replaced seven hand-maintained structures. The values below are
// copied verbatim from those structures as they were BEFORE the consolidation,
// so this asserts the refactor was behavior-preserving: same labels, same
// palette contents and order, same defaults for every type. If a future change
// to the registry alters an existing type's defaults, this fails loudly rather
// than quietly changing what a placed object looks like on a stage monitor.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import type { LayoutObjectType } from "../../main/types/stage.js";
import { LEGACY_TRANSLUCENT_GROUNDS } from "../../main/types/readout-types.js";
import {
  EMBED_FONT_FRACTION,
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

/** The card as it was ORIGINALLY, translucent ground and all. Pinned so the
 *  originals below stay the originals; the current ground is CARD_NEUTRAL. */
const CARD_NEUTRAL_ORIGINAL = {
  background: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.08)",
  borderWidth: 0.001, cornerRadius: 0.0148, padding: 0.0148,
};

/**
 * The card as it is NOW: the same thing with an OPAQUE ground.
 *
 * #141414 is the exact blend of rgba(255,255,255,0.04) over the kiosk black, so
 * a card looks identical on a bare canvas. What changed is that it now occludes:
 * at 4% white it did not, so a status widget over a transcript let the text read
 * straight through and looked for all the world like a broken layer order. Paint
 * order was measured and was correct the whole time.
 */
const CARD_NEUTRAL = { ...CARD_NEUTRAL_ORIGINAL, background: "#141414" };

/**
 * The ground swap, applied to a pinned original.
 *
 * Every card preset went opaque at once, on every type that carries one — about
 * twenty of them, and the change is ONE field with the same value everywhere.
 * Hand-copying twenty full styles into RESTYLED to record a single uniform swap
 * would be twenty chances to fat-finger an unrelated field into the "expected"
 * column, which is how a golden test starts agreeing with the bug.
 *
 * So the swap is expressed as the rule it is, using the SAME map the load-time
 * migration uses — so the test cannot drift from the product. Every other
 * difference still has to be recorded in RESTYLED by hand.
 */
function withCurrentGround(style: Record<string, unknown>): Record<string, unknown> {
  const bg = typeof style.background === "string" ? style.background : null;
  const opaque = bg ? LEGACY_TRANSLUCENT_GROUNDS[bg.replace(/\s+/g, "")] : undefined;
  return opaque ? { ...style, background: opaque } : style;
}
/**
 * The chrome swap, applied the same way and for the same reason.
 *
 * Three widgets side by side on a wall had three different edges: the neutral
 * card and Glass carried 8% white, Solid carried NO border at all, and Outline
 * was half again as thick. One hairline now, so every carded type moved at once.
 * The GROUND did not move: #141414 stayed, because the canvas under it is
 * #0a0a0a and a darker card reads as a hole — and again it is ONE rule with the same values everywhere, not
 * twenty hand-copied styles.
 *
 * Field by field, and only these fields: a type that changed anything ELSE still
 * has to be recorded in RESTYLED by hand.
 */
function withCurrentChrome(style: Record<string, unknown>): Record<string, unknown> {
  const out = { ...style };
  if (out.borderColor === "rgba(255,255,255,0.08)") out.borderColor = "rgba(255,255,255,0.1)";
  // Every preset's hairline, whatever it used to be — the neutral card and Glass
  // at 0.001, Outline at 0.0015.
  if (out.borderWidth === 0.001 || out.borderWidth === 0.0015) out.borderWidth = 1 / 1080;
  return out;
}

const BASE_TEXT = { fontSize: 0.06, fontWeight: 500, color: "#ffffff", textAlign: "center", vAlign: "middle" };

/**
 * Style fields that no longer exist ANYWHERE.
 *
 * Elevation, opacity, padding, text shadow and line clamp were removed from the
 * model, not just from the inspector — so every recorded style that carried one
 * differs from the registry by exactly those keys and nothing else. Stripping
 * them from both sides of the comparison keeps this guard's whole point: any
 * OTHER drift in a default style still fails.
 */
const REMOVED_FIELDS = ["padding", "opacity", "boxShadow", "textShadow", "lineClamp"];
function withoutRemoved(style: Record<string, unknown>): Record<string, unknown> {
  const out = { ...style };
  for (const k of REMOVED_FIELDS) delete out[k];
  return out;
}

/** defaultStyle() as it was, branch for branch. */
function originalStyle(type: string): Record<string, unknown> {
  if (type === "shape") return { background: "#3b82f6", opacity: 1 };
  if (type === "container") return { ...CARD_NEUTRAL_ORIGINAL };
  if (["ndi-video", "slide-thumbnail", "image", "plan-attachment", "brand-logo", "live-controls"].includes(type)) return {};
  if (type === "transcript-strip") return { fontSize: 0.045, fontWeight: 500, color: "#ffffff", textAlign: "left", vAlign: "bottom" };
  if (type === "charger-battery") return { fontSize: 0.045, fontWeight: 500, color: "#ffffff", textAlign: "left", vAlign: "middle" };
  if (type === "service-order") return { fontSize: 0.035, fontWeight: 500, color: "#ffffff", textAlign: "left", vAlign: "top" };
  if (type === "obs-status") return { fontSize: 0.05, fontWeight: 700, color: "#ffffff", textAlign: "center", vAlign: "middle", uppercase: true, ...CARD_NEUTRAL_ORIGINAL };
  if (type === "reaper-status") return { fontSize: 0.05, fontWeight: 700, color: "#ffffff", textAlign: "center", vAlign: "middle", uppercase: true, ...CARD_NEUTRAL_ORIGINAL };
  if (type === "osc-button") return { fontSize: 0.045, fontWeight: 600, color: "#ffffff", textAlign: "center", vAlign: "middle", ...CARD_NEUTRAL_ORIGINAL };
  if (type === "people-counter") return { fontSize: 0.12, fontWeight: 700, color: "#ffffff", textAlign: "center", vAlign: "middle" };
  if (type === "baptism-timer") return { fontSize: 0.14, fontWeight: 700, color: "#ffffff", textAlign: "center", vAlign: "middle" };
  if (type === "pp-timer" || type === "service-pacing") return { fontSize: 0.1, fontWeight: 700, color: "#ffffff", textAlign: "center", vAlign: "middle" };
  if (type === "wireless-channel") return { fontSize: 0.05, fontWeight: 600, color: "#ffffff", textAlign: "center", vAlign: "middle", ...CARD_NEUTRAL_ORIGINAL };
  if (type === "people-panel") return { fontSize: 0.1, fontWeight: 700, color: "#ffffff", textAlign: "center", vAlign: "middle" };
  if (type === "integration-status" || type === "wireless-summary") return { fontSize: 0.05, fontWeight: 600, color: "#ffffff", textAlign: "center", vAlign: "middle", ...CARD_NEUTRAL_ORIGINAL };
  if (type === "people-graph") return { color: "#5b9cff", ...CARD_NEUTRAL_ORIGINAL };
  return { ...BASE_TEXT };
}



/**
 * Types whose default CONFIG deliberately changed, and what it became.
 *
 * Same bar as RESTYLED below: the originals stay pinned so an accident is still
 * caught, and a deliberate change is recorded here.
 *
 * Six readouts gained a `caption` — the line above the value that says what the
 * number is. A bare 0:04:12 on a wall does not say what it is counting to, and
 * the person who built the layout is not the one reading it on Sunday morning.
 *
 * Set on NEW objects only: a stored object carries its own config, so no
 * existing layout grows a caption nobody asked for.
 */
const RECONFIGURED: Record<string, Record<string, unknown>> = {
  "countdown-timer": { type: "countdown-timer", caption: "Service starts in" },
  "service-pacing": { type: "service-pacing", hideWhenIdle: false, showLabel: false, caption: "Pacing" },
  "pp-timer": { type: "pp-timer", timerName: null, propresenterInstanceId: null, warnStates: true, hideWhenIdle: false, showLabel: true, caption: "Stage timer" },
  "spl-meter": { type: "spl-meter", meterId: null, metricKey: null, showLabel: false, thresholds: null, caption: "SPL dB(A)" },
  "people-counter": { type: "people-counter", metric: "attendance", zoneId: null, label: "People", showLabel: true, caption: "Attendance" },
  "baptism-timer": { type: "baptism-timer", field: "live", showLabel: true, label: "", caption: "Baptisms" },
};

/**
 * Types whose default config gained a SETTING since the consolidation.
 *
 * Separate from RECONFIGURED, which records the six that gained a caption and
 * asserts a caption is the only thing that moved. Folding these in there would
 * have meant loosening that assertion, and it is the assertion that makes the
 * record mean something.
 *
 * Both entries are the wireless widgets gaining runtime remaining — the figure
 * Wireless Workbench leads with. Off by default in both, so nothing anyone has
 * already placed changes; they are listed only so the new key is a deliberate,
 * recorded change rather than drift.
 */
const RETUNED: Record<string, Record<string, unknown>> = {
  "wireless-summary": { type: "wireless-summary", showOnline: true, showBattery: true, showRuntime: false, showLabel: false, label: "Mics" },
  "wireless-channel": { type: "wireless-channel", channelId: null, show: { rf: true, battery: true, runtime: false, frequency: true, audio: false }, showLabel: true },
};

/**
 * Types deliberately RESTYLED since the consolidation, and what they became.
 *
 * The originals above stay pinned so an accidental change is still caught; a
 * deliberate one is recorded here, at the same bar as adding or retiring a type.
 *
 * Nineteen defaults changed at once, for one reason. Across four real layouts the
 * operator had applied CARD_NEUTRAL BY HAND to thirteen different object types —
 * the same background, hairline and radius every time — because half the readouts
 * shipped with a card and half did not. That is a missing default, so the readouts
 * that lacked it got it. Three ProPresenter text objects went all-caps in the same
 * pass, which is legibility from the back of a room, not decoration.
 *
 * A stored object carries its own style, so no existing layout moved.
 */
const RESTYLED: Record<string, Record<string, unknown>> = {
  "clock": { ...CARD_NEUTRAL, fontSize: 0.06, fontWeight: 600, color: "#ffffff", vAlign: "middle" },
  "countdown-timer": { ...CARD_NEUTRAL, fontSize: 0.085, fontWeight: 700, color: "#ffffff", vAlign: "middle" },
  "live-controls": { ...CARD_NEUTRAL, fontSize: 0.05, fontWeight: 600, color: "#ffffff", textAlign: "center", vAlign: "middle" },
  "view-embed": { ...CARD_NEUTRAL, fontSize: 0.016, fontWeight: 500, color: "#ffffff", textAlign: "left", vAlign: "top" },
  "plan-attachment": { ...CARD_NEUTRAL },
  "current-slide-text": { fontSize: 0.06, fontWeight: 500, color: "#ffffff", textAlign: "center", vAlign: "middle", uppercase: true },
  "next-slide-text": { fontSize: 0.06, fontWeight: 500, color: "#ffffff", textAlign: "center", vAlign: "middle", uppercase: true },
  "current-slide-notes": { fontSize: 0.06, fontWeight: 500, color: "#ffffff", textAlign: "center", vAlign: "middle", uppercase: true },
  "section-chip": { ...CARD_NEUTRAL, fontSize: 0.05, fontWeight: 600, color: "#ffffff", vAlign: "middle", uppercase: true, letterSpacing: 0.04 },
  "pp-timer": { ...CARD_NEUTRAL, fontSize: 0.1, fontWeight: 700, color: "#ffffff", vAlign: "middle" },
  "slide-progress": { ...CARD_NEUTRAL, fontSize: 0.06, fontWeight: 600, color: "#ffffff", vAlign: "middle" },
  "charger-battery": { ...CARD_NEUTRAL, fontSize: 0.045, fontWeight: 500, color: "#ffffff", textAlign: "left", vAlign: "middle" },
  "spl-meter": { ...CARD_NEUTRAL, fontSize: 0.085, fontWeight: 700, color: "#ffffff", vAlign: "middle" },
  "service-pacing": { ...CARD_NEUTRAL, fontSize: 0.1, fontWeight: 700, color: "#ffffff", vAlign: "middle" },
  "people-counter": { ...CARD_NEUTRAL, fontSize: 0.12, fontWeight: 700, color: "#ffffff", vAlign: "middle" },
  "people-panel": { ...CARD_NEUTRAL, fontSize: 0.1, fontWeight: 700, color: "#ffffff", textAlign: "center", vAlign: "middle" },
  "baptism-timer": { ...CARD_NEUTRAL, fontSize: 0.14, fontWeight: 700, color: "#ffffff", vAlign: "middle" },
  "notes": { ...CARD_NEUTRAL, fontSize: 0.035, fontWeight: 500, color: "#ffffff", textAlign: "left", vAlign: "top" },
  "checklist": { ...CARD_NEUTRAL, fontSize: 0.035, fontWeight: 500, color: "#ffffff", textAlign: "left", vAlign: "top" },

  // ── The readouts stop shipping an alignment (Phase 7 Task 9) ───────────────
  //
  // Every preset above spreads TEXT(), which writes `textAlign: "center"`. So
  // every readout ever created stored a centre alignment as a side effect of
  // being created — nobody chose it — and the widget idiom's left-aligned
  // composition could not be the DEFAULT without ignoring the field entirely.
  // Ignoring it is what the first cut did, and it broke the alignment control
  // for every readout on every custom view.
  //
  // So readouts ship with no alignment: absent means the idiom's default (left),
  // and anything stored is a real choice the editor can still make. The entries
  // above lost their `textAlign` for the same reason; these six had no recorded
  // restyle before, so the removal is their first.
  //
  // readout-align.test.tsx holds the precise version of this: an EXACT walk
  // asserting no readout type ships one and every non-readout still does.
  "wireless-summary": { ...CARD_NEUTRAL, fontSize: 0.05, fontWeight: 600, color: "#ffffff", vAlign: "middle" },
  "wireless-channel": { ...CARD_NEUTRAL, fontSize: 0.05, fontWeight: 600, color: "#ffffff", vAlign: "middle" },
  "record-status": { ...CARD_NEUTRAL, fontSize: 0.05, fontWeight: 700, color: "#ffffff", vAlign: "middle", uppercase: true },
  "obs-status": { ...CARD_NEUTRAL, fontSize: 0.05, fontWeight: 700, color: "#ffffff", vAlign: "middle", uppercase: true },
  "reaper-status": { ...CARD_NEUTRAL, fontSize: 0.05, fontWeight: 700, color: "#ffffff", vAlign: "middle", uppercase: true },
  "integration-status": { ...CARD_NEUTRAL, fontSize: 0.05, fontWeight: 600, color: "#ffffff", vAlign: "middle" },
};

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
const ADDED_SINCE: { type: string; label: string; group: string; after: string | null }[] = [
  { type: "rosstalk-button", label: "RossTalk button", group: "Control", after: "osc-button" },
  { type: "record-status", label: "Record status", group: "Status", after: null },
  { type: "view-embed", label: "Embedded view", group: "PCO / service", after: "next-service-item" },
  // The producer primitive: a tile bound to a SCREEN rather than to one view, so
  // it follows a routing change. Sits directly after the embedded view it is the
  // sibling of, which moved `home-readiness` one place down on purpose.
  { type: "screen-embed", label: "Embedded screen", group: "PCO / service", after: "view-embed" },
  // The general form of the two buttons above: bound to any entry in the
  // automation action registry rather than one integration.
  { type: "action-button", label: "Action button", group: "Control", after: "rosstalk-button" },
  // The operator's own work product, stored outside the layout in notes.json.
  { type: "notes", label: "Notes", group: "Control", after: "action-button" },
  { type: "checklist", label: "Checklist", group: "Control", after: "notes" },
  // Home's own cards, so Home is built from the same widget set as every other
  // surface rather than being a bespoke page (Phase 6, carrying a Phase 4 debt).
  { type: "home-readiness", label: "Readiness", group: "PCO / service", after: "screen-embed" },
  { type: "home-next-service", label: "Next service", group: "PCO / service", after: "home-readiness" },
  // The other two things Home draws. They existed as bespoke panels; making them
  // objects is what lets the Home tab's own editor govern the whole page with
  // one mechanism (Phase 7, Task 6).
  // Renamed when it was split: it drew recording and SPL too, and does not any
  // more. The type id stays so no stored layout has to move.
  { type: "home-live-status", label: "Service timer", group: "PCO / service", after: "home-next-service" },
  { type: "home-recent-services", label: "Recent services", group: "PCO / service", after: "home-live-status" },
  // The live card's insides, split out so each can be placed on its own once
  // Home became a grid. The card kept the timer; these three kept their look.
  // Each sits beside the widgets it belongs with rather than with the other Home
  // cards, so none of them displaces the first entry of a group.
  { type: "home-spl", label: "Sound level", group: "Audio (SPL)", after: "spl-meter" },
  { type: "home-recording", label: "Recording", group: "Status", after: "integration-status" },
  // One per recorder, so each is found by NAME in the palette rather than behind
  // a control. The combined one above still answers "are we getting this?".
  { type: "home-recording-obs", label: "OBS recording", group: "OBS", after: "obs-status" },
  { type: "home-recording-reaper", label: "REAPER recording", group: "REAPER", after: "reaper-status" },
  { type: "home-screens", label: "Screens online", group: "Status", after: "home-recording" },
  // Streaming, added alongside the Resi and YouTube integrations. Same shape as
  // the recording trio: one combined answer plus a per-platform each, because a
  // widget reading LIVE while one destination sits off air is reassurance
  // nobody asked for.
  { type: "home-streaming", label: "Streaming", group: "Status", after: "home-screens" },
  { type: "stream-status", label: "Streaming status", group: "Status", after: "home-streaming" },
  // `after: null` — each leads its own group, because each platform gets one.
  { type: "home-streaming-resi", label: "Resi status", group: "Resi", after: null },
  { type: "home-streaming-youtube", label: "YouTube status", group: "YouTube", after: null },
  // ProVideoPlayer. `after: null` — it leads its own new group.
  { type: "pvp-layers", label: "ProVideoPlayer layers", group: "ProVideoPlayer", after: null },
  { type: "home-pvp", label: "ProVideoPlayer", group: "ProVideoPlayer", after: "pvp-layers" },
  // The second PVP pair: one reading rather than a list of layers. Its own
  // labels, because two entries in one palette group called "ProVideoPlayer" is
  // a choice an operator cannot make.
  { type: "pvp-now", label: "ProVideoPlayer now", group: "ProVideoPlayer", after: "home-pvp" },
  { type: "home-pvp-now", label: "On screen now", group: "ProVideoPlayer", after: "pvp-now" },
  // Live scores, from ESPN's public scoreboard. In "Status" rather than a league
  // group of its own: it is one widget reading one integration, and a group
  // holding a single entry is a heading with nothing under it.
  { type: "scores", label: "Live scores", group: "Status", after: "stream-status" },
  { type: "home-scores", label: "Scores", group: "Status", after: "scores" },
];

/**
 * Types RETIRED since the consolidation: still rendered, still restorable from
 * an old snapshot, but out of the palette so no new ones appear.
 *
 * Listed rather than quietly re-pinned. The originals above assert the label and
 * group every type shipped with; a retirement changes both on purpose, and it
 * should be a deliberate edit here — the same bar as adding one.
 */
const RETIRED: { type: string; label: string; replacedBy: string }[] = [
  { type: "service-order", label: "Service order (legacy)", replacedBy: "view-embed" },
  // The per-source Home cards. Each was one component with one prop fixed —
  // `<RecordingCard recorder="OBS" />`, `<StreamingCard platform="Resi" />` — so
  // the prop became a right-click choice on the general card and these four stop
  // needing to exist. Saved ones still draw exactly what they always drew.
  { type: "home-recording-obs", label: "OBS recording", replacedBy: "home-recording" },
  { type: "home-recording-reaper", label: "REAPER recording", replacedBy: "home-recording" },
  { type: "home-streaming-resi", label: "Resi status", replacedBy: "home-streaming" },
  { type: "home-streaming-youtube", label: "YouTube status", replacedBy: "home-streaming" },
];

/** Retirements, by type — the two assertions over ADDED_SINCE that only hold
 *  while a type is still ON the palette skip these. Its label is still pinned. */
const IS_RETIRED = new Set(RETIRED.map((r) => r.type));

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
      // The LABEL is pinned whether or not the type is still offered; the GROUP
      // only while it is. A retired type's group is null by definition, which
      // `retired types leave the palette but stay renderable` asserts instead.
      assert.equal(typeLabel(a.type as never), a.label);
      if (IS_RETIRED.has(a.type)) continue;
      assert.equal(LAYOUT_OBJECTS[a.type as LayoutObjectType].group, a.group);
    }
  });

  test("labels are unchanged", () => {
    const retired = new Map(RETIRED.map((r) => [r.type, r.label]));
    for (const t of ALL) {
      assert.equal(typeLabel(t as never), retired.get(t) ?? TYPE_LABELS[t], `label for ${t}`);
    }
  });

  test("retired types leave the palette but stay renderable", () => {
    for (const r of RETIRED) {
      const spec = LAYOUT_OBJECTS[r.type as LayoutObjectType];
      assert.equal(spec.group, null, `${r.type} must not be offered in the palette`);
      assert.equal(spec.retired?.replacedBy, r.replacedBy, `${r.type} must name its replacement`);
      // Still constructs — an old layout containing one has to keep working.
      assert.equal(defaultConfig(r.type as never).type, r.type);
    }
  });

  test("palette groups and their order are unchanged for the original types", () => {
    // Additions are filtered out of what the palette IS; retirements are filtered
    // out of what it WAS. What remains — every original type still on offer — must
    // match exactly: same groups, same order within each group.
    const added = new Set(ADDED_SINCE.map((a) => a.type));
    const gone = new Set(RETIRED.map((r) => r.type));
    const actual = PALETTE_GROUPS.map((g) => ({
      label: g.label as string,
      types: (g.types as string[]).filter((t) => !added.has(t)),
    })).filter((g) => g.types.length > 0);
    const expected = ORIGINAL_PALETTE.map((g) => ({
      label: g.label,
      types: g.types.filter((t) => !gone.has(t)),
    })).filter((g) => g.types.length > 0);
    assert.deepEqual(actual, expected);
  });

  test("each addition sits directly after the type it claims to follow", () => {
    // Pins placement too, so a new object cannot silently reorder the palette.
    // `after: null` means it leads its group.
    for (const a of ADDED_SINCE) {
      if (IS_RETIRED.has(a.type)) continue;
      if (a.after === null) {
        const g = PALETTE_GROUPS.find((x) => (x.types as string[]).includes(a.type));
        assert.ok(g, `${a.type} is not in the palette`);
        assert.equal((g!.types as string[])[0], a.type, `${a.type} should lead its group`);
        continue;
      }
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

  test("default config is the original, or a recorded change", () => {
    for (const t of ALL) {
      assert.deepEqual(
        defaultConfig(t as never),
        RETUNED[t] ?? RECONFIGURED[t] ?? ORIGINAL_CONFIG[t],
        `defaultConfig("${t}")`,
      );
    }
  });

  test("every retuned type is real, still matches, and only ADDED settings", () => {
    for (const t of Object.keys(RETUNED)) {
      assert.ok(t in LAYOUT_OBJECTS, `RETUNED names "${t}", which is not an object type`);
      assert.deepEqual(RETUNED[t], defaultConfig(t as never), `RETUNED["${t}"] no longer matches the registry`);
      assert.notDeepEqual(RETUNED[t], ORIGINAL_CONFIG[t], `RETUNED["${t}"] matches the original`);

      // Every setting the original had must still be there with the SAME value.
      // A new one is a recorded addition; a CHANGED one would silently alter how
      // every screen already in the field draws, and belongs in a change that
      // says so rather than in a list called "retuned".
      //
      // Recursive, because `wireless-channel` keeps its toggles in a nested
      // `show` object and a flat comparison reports the whole object as changed
      // the moment a key is added to it — which is exactly the addition being
      // recorded.
      const survives = (before: unknown, after: unknown, at: string): void => {
        if (before === null || typeof before !== "object" || Array.isArray(before)) {
          assert.deepEqual(after, before, `RETUNED["${t}"] changed the existing setting "${at}"`);
          return;
        }
        assert.ok(after && typeof after === "object", `RETUNED["${t}"] dropped the "${at}" group`);
        for (const [key, value] of Object.entries(before as Record<string, unknown>)) {
          survives(value, (after as Record<string, unknown>)[key], at ? `${at}.${key}` : key);
        }
      };
      survives(ORIGINAL_CONFIG[t], RETUNED[t], "");
    }
  });

  test("every reconfigured type is real, still matches, and actually differs", () => {
    for (const t of Object.keys(RECONFIGURED)) {
      assert.ok(t in LAYOUT_OBJECTS, `RECONFIGURED names "${t}", which is not an object type`);
      assert.deepEqual(RECONFIGURED[t], defaultConfig(t as never), `RECONFIGURED["${t}"] no longer matches the registry`);
      assert.notDeepEqual(RECONFIGURED[t], ORIGINAL_CONFIG[t], `RECONFIGURED["${t}"] matches the original`);
    }
  });

  test("a caption is the ONLY thing those six gained", () => {
    // The point of the change is one added key. If anything else moved, this is
    // a different change wearing its name.
    for (const t of Object.keys(RECONFIGURED)) {
      const before = { ...(ORIGINAL_CONFIG[t] as Record<string, unknown>) };
      const after = { ...RECONFIGURED[t] };
      delete after.caption;
      assert.deepEqual(after, before, `defaultConfig("${t}") changed more than the caption`);
      assert.equal(typeof RECONFIGURED[t].caption, "string", `${t} has no caption`);
    }
  });

  test("default style is the original, or a recorded restyle", () => {
    for (const t of ALL) {
      assert.deepEqual(
        defaultStyle(t as never),
        // The chrome swap wraps the WHOLE expression, hand-recorded restyles
        // included: it is one uniform change and it reached them too. Every
        // other field of a RESTYLED entry stays pinned.
        withoutRemoved(withCurrentChrome(RESTYLED[t] ?? withCurrentGround(originalStyle(t)))),
        `defaultStyle("${t}")`,
      );
    }
  });

  test("every restyled type is a real type, and actually differs", () => {
    // A name that no longer exists would silently stop guarding anything, and an
    // entry identical to the original is a change somebody backed out without
    // removing the record of it.
    // Against the whole registry, not ALL: three of the restyled types
    // (view-embed, notes, checklist) arrived after the consolidation and so have
    // no entry in the originals.
    const registry = Object.keys(LAYOUT_OBJECTS);
    for (const t of Object.keys(RESTYLED)) {
      assert.ok(registry.includes(t), `RESTYLED names "${t}", which is not an object type`);
      // Same chrome rule as above: a recorded restyle is pinned on every field
      // EXCEPT the one uniform swap, which reached it along with everything else.
      assert.deepEqual(withoutRemoved(withCurrentChrome(RESTYLED[t])), defaultStyle(t as never), `RESTYLED["${t}"] no longer matches the registry`);
      if (ALL.includes(t)) {
        assert.notDeepEqual(withoutRemoved(RESTYLED[t]), withoutRemoved(originalStyle(t)), `RESTYLED["${t}"] matches the original`);
      }
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

// ── The embedded view's starting size ─────────────────────────────────────────

describe("embedded view default font size", () => {
  // The requirement for this object is that nothing looks different between the
  // embed and the ScriptView page it came out of. It shipped at 0.03 — chosen so
  // it would be "readable from a stage" untouched — which renders at 32px on a
  // 1080-tall screen against the page's 17px, showing about half the rundown and
  // pushing the last columns off the right edge. Anyone re-raising this default
  // is re-breaking the one thing the object exists to do.
  test("matches what the ScriptView page actually renders at", () => {
    // The page sets `clamp(0.8rem, 1.6vmin, 1.1rem)`; on a 1080-tall 16:9 screen
    // that resolves to 1.6vmin = 17.28px, so the equivalent fraction is 0.016.
    const PAGE_PX_AT_1080 = 1.6 * (1080 / 100);
    assert.equal(EMBED_FONT_FRACTION, 0.016);
    assert.ok(
      Math.abs(EMBED_FONT_FRACTION * 1080 - PAGE_PX_AT_1080) < 0.5,
      `embed renders at ${EMBED_FONT_FRACTION * 1080}px where the page renders at ${PAGE_PX_AT_1080}px`,
    );
  });

  test("is what a placed embedded view is actually given", () => {
    // Pinning the constant alone would pass while the registry used something else.
    assert.equal(defaultStyle("view-embed" as LayoutObjectType).fontSize, EMBED_FONT_FRACTION);
  });
});
