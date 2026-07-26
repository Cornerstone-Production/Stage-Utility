// layout-objects.ts — the single registry of custom-layout object types.
//
// Adding an object type used to mean editing seven structures that had to agree
// but were never checked against each other: TYPE_LABELS, PALETTE_GROUPS,
// NO_CONFIG_TYPES, defaultConfig(), defaultStyle(), PROP_OBJECT_TYPES and
// OBJECT_INTEGRATION. Miss one and the failure was silent — an object with no
// palette entry, or one that added with an empty config.
//
// They are now one `Record<LayoutObjectType, LayoutObjectSpec>`. Because the key
// type is the config union's discriminant, **omitting a type is a compile
// error**, and everything the editor needs about a type is in one place.
//
// Rendering still lives in layout-renderer.tsx (ObjectContent) — those are React
// bodies with their own hooks and context, not data. That switch has an
// exhaustiveness check so a type without a renderer is also a compile error.

/** Palette sections, in the order the add-object dropdown shows them. */
export const PALETTE_GROUP_ORDER = [
  "Layout",
  "Text & time",
  "PCO / service",
  "ProPresenter",
  "Mics & RF",
  "Audio (SPL)",
  "Transcription",
  "People",
  "Baptisms",
  "OBS",
  "REAPER",
  "Control",
  "Status",
] as const;
export type PaletteGroup = (typeof PALETTE_GROUP_ORDER)[number];

export interface LayoutObjectSpec {
  /** Shown in the palette, the layer list and the inspector header. */
  label: string;
  /** Which palette section this appears under, or null to keep it OUT of the
   *  add-object palette (NDI is placed by the native client, not by hand). */
  group: PaletteGroup | null;
  /** Config for a freshly-added object. */
  config: () => LayoutObjectConfig;
  /** Style for a freshly-added object. */
  style: () => LayoutStyle;
  /**
   * The OPTIONAL integration this object needs for real data — dims its palette
   * entry until that integration is set up. Core PCO/ProPresenter text objects
   * are deliberately omitted: they read data that is almost always present, and
   * dimming them would just be noise.
   */
  integration?: { id: string; label: string };
  /** No per-object options; the inspector shows a "styling only" hint. */
  stylingOnly?: boolean;
  /** Reads from one ProPresenter machine — offers the instance picker when
   *  more than one is configured. */
  propInstance?: boolean;
}

// ── Shared style fragments ────────────────────────────────────────────────────

type CardAccent = "neutral" | "green" | "red" | "amber" | "flat";

/** One-click card accents. Also used by the inspector's style-preset picker. */
export const CARD_PRESETS: Record<CardAccent, LayoutStyle> = {
  neutral: { background: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.08)", borderWidth: 0.001, cornerRadius: 0.0148, padding: 0.0148 },
  green: { background: "rgba(45,212,150,0.08)", borderColor: "rgba(45,212,150,0.13)", borderWidth: 0.001, cornerRadius: 0.0148, padding: 0.0148 },
  red: { background: "rgba(229,72,77,0.10)", borderColor: "rgba(229,72,77,0.25)", borderWidth: 0.001, cornerRadius: 0.0148, padding: 0.0148 },
  amber: { background: "rgba(255,197,61,0.08)", borderColor: "rgba(255,197,61,0.20)", borderWidth: 0.001, cornerRadius: 0.0148, padding: 0.0148 },
  flat: { background: null, borderColor: null, borderWidth: 0, cornerRadius: 0, padding: 0 },
};

/** The default look: centred white text at body size. */
const TEXT = (over: LayoutStyle = {}): LayoutStyle => ({
  fontSize: 0.06,
  fontWeight: 500,
  color: "#ffffff",
  textAlign: "center",
  vAlign: "middle",
  ...over,
});
/** A big bold tabular readout (clock, countdown, timers, counters). */
const READOUT = (fontSize: number): LayoutStyle => TEXT({ fontSize, fontWeight: 700 });
/** A compact glass pill (status chips, buttons, single mic tiles). */
const PILL = (over: LayoutStyle = {}): LayoutStyle => TEXT({ fontSize: 0.05, fontWeight: 600, ...CARD_PRESETS.neutral, ...over });
/** Media that paints its own content — no type styling at all. */
const BARE = (): LayoutStyle => ({});

// ── The registry ──────────────────────────────────────────────────────────────

export const LAYOUT_OBJECTS: Record<LayoutObjectType, LayoutObjectSpec> = {
  // Layout
  container: {
    label: "Container",
    group: "Layout",
    config: () => ({ type: "container" }),
    style: () => ({ ...CARD_PRESETS.neutral }),
  },
  shape: {
    label: "Shape",
    group: "Layout",
    config: () => ({ type: "shape", shape: "rect" }),
    style: () => ({ background: "#3b82f6", opacity: 1 }),
  },
  image: {
    label: "Image",
    group: "Layout",
    config: () => ({ type: "image", src: "" }),
    style: BARE,
  },
  "brand-logo": {
    label: "Logo",
    group: "Layout",
    config: () => ({ type: "brand-logo", useEmptySlotLogo: false }),
    style: BARE,
  },

  // Text & time
  text: {
    label: "Text",
    group: "Text & time",
    config: () => ({ type: "text", text: "Text" }),
    style: () => TEXT(),
  },
  clock: {
    label: "Clock",
    group: "Text & time",
    config: () => ({ type: "clock", showSeconds: true, format: "12h" }),
    style: () => TEXT(),
  },
  "countdown-timer": {
    label: "PCO countdown",
    group: "Text & time",
    config: () => ({ type: "countdown-timer" }) as LayoutObjectConfig,
    style: () => TEXT(),
  },

  // PCO / service
  "live-controls": {
    label: "PCO Prev/Next",
    group: "PCO / service",
    config: () => ({ type: "live-controls" }) as LayoutObjectConfig,
    style: BARE,
    stylingOnly: true,
  },
  "current-service-item": {
    label: "Current item",
    group: "PCO / service",
    config: () => ({ type: "current-service-item" }) as LayoutObjectConfig,
    style: () => TEXT(),
    stylingOnly: true,
    propInstance: true,
  },
  "next-service-item": {
    label: "Next item",
    group: "PCO / service",
    config: () => ({ type: "next-service-item" }) as LayoutObjectConfig,
    style: () => TEXT(),
    stylingOnly: true,
    propInstance: true,
  },
  "service-order": {
    label: "Service order",
    group: "PCO / service",
    config: () => ({ type: "service-order", noteCategories: null, showLength: false, highlightLive: true, scroll: "auto", autoFit: true }),
    style: () => TEXT({ fontSize: 0.035, textAlign: "left", vAlign: "top" }),
  },
  "service-pacing": {
    label: "Service pacing",
    group: "PCO / service",
    config: () => ({ type: "service-pacing", hideWhenIdle: false, showLabel: false }),
    style: () => READOUT(0.1),
  },
  "plan-attachment": {
    label: "Plan file",
    group: "PCO / service",
    config: () => ({ type: "plan-attachment", match: "stage plot", page: 1 }),
    style: BARE,
  },

  // ProPresenter
  "current-slide-text": {
    label: "Current slide",
    group: "ProPresenter",
    config: () => ({ type: "current-slide-text" }) as LayoutObjectConfig,
    style: () => TEXT(),
    stylingOnly: true,
    propInstance: true,
  },
  "next-slide-text": {
    label: "Next slide",
    group: "ProPresenter",
    config: () => ({ type: "next-slide-text" }) as LayoutObjectConfig,
    style: () => TEXT(),
    stylingOnly: true,
    propInstance: true,
  },
  "current-slide-notes": {
    label: "Slide notes",
    group: "ProPresenter",
    config: () => ({ type: "current-slide-notes" }) as LayoutObjectConfig,
    style: () => TEXT(),
    stylingOnly: true,
    propInstance: true,
  },
  "slide-thumbnail": {
    label: "Slide image",
    group: "ProPresenter",
    config: () => ({ type: "slide-thumbnail" }) as LayoutObjectConfig,
    style: BARE,
    stylingOnly: true,
    propInstance: true,
  },
  "section-chip": {
    label: "Section chip",
    group: "ProPresenter",
    config: () => ({ type: "section-chip", which: "current" }),
    style: () => TEXT(),
    propInstance: true,
  },
  "pp-timer": {
    label: "ProPresenter timer",
    group: "ProPresenter",
    config: () => ({ type: "pp-timer", timerName: null, propresenterInstanceId: null, warnStates: true, hideWhenIdle: false, showLabel: true }),
    style: () => READOUT(0.1),
    propInstance: true,
  },
  "slide-progress": {
    label: "Slide progress",
    group: "ProPresenter",
    config: () => ({ type: "slide-progress", propresenterInstanceId: null, display: "fraction", showLabel: false }),
    style: () => TEXT(),
    propInstance: true,
  },

  // Mics & RF
  "slots-grid": {
    label: "Mic slots",
    group: "Mics & RF",
    config: () => ({ type: "slots-grid", source: "inline", sourceViewId: null }),
    style: () => TEXT(),
  },
  "charger-battery": {
    label: "Charger battery",
    group: "Mics & RF",
    config: () => ({ type: "charger-battery", bays: [], show: { battery: true, charging: true } }),
    style: () => TEXT({ fontSize: 0.045, textAlign: "left" }),
    integration: { id: "wireless", label: "wireless" },
  },
  "wireless-summary": {
    label: "Wireless summary",
    group: "Mics & RF",
    config: () => ({ type: "wireless-summary", showOnline: true, showBattery: true, showLabel: false, label: "Mics" }),
    style: () => PILL(),
    integration: { id: "wireless", label: "wireless" },
  },
  "wireless-channel": {
    label: "Mic channel",
    group: "Mics & RF",
    config: () => ({ type: "wireless-channel", channelId: null, show: { rf: true, battery: true, frequency: true, audio: false }, showLabel: true }),
    style: () => PILL(),
    integration: { id: "wireless", label: "wireless" },
  },

  // Audio (SPL)
  "spl-meter": {
    label: "SPL meter",
    group: "Audio (SPL)",
    config: () => ({ type: "spl-meter", meterId: null, metricKey: null, showLabel: false, thresholds: null }),
    style: () => TEXT(),
    integration: { id: "smaart", label: "Smaart SPL" },
  },

  // Transcription
  "transcript-strip": {
    label: "Transcription",
    group: "Transcription",
    config: () => ({ type: "transcript-strip", mode: "rolling" }),
    style: () => TEXT({ fontSize: 0.045, textAlign: "left", vAlign: "bottom" }),
    integration: { id: "prodcom", label: "transcription" },
  },

  // People
  "people-counter": {
    label: "People counter",
    group: "People",
    config: () => ({ type: "people-counter", metric: "attendance", zoneId: null, label: "People", showLabel: true }),
    style: () => READOUT(0.12),
    integration: { id: "sensource", label: "SenSource" },
  },
  "people-panel": {
    label: "People summary",
    group: "People",
    config: () => ({ type: "people-panel", metrics: ["occupancy", "peak", "attendance"], showLabels: true, orientation: "row" }),
    style: () => READOUT(0.1),
  },
  "people-graph": {
    label: "People graph",
    group: "People",
    config: () => ({ type: "people-graph", metric: "occupancy", showLabel: true, label: "In room" }),
    style: () => ({ color: "#5b9cff", ...CARD_PRESETS.neutral }),
    integration: { id: "sensource", label: "SenSource" },
  },

  // Baptisms
  "baptism-timer": {
    label: "Baptism timer",
    group: "Baptisms",
    config: () => ({ type: "baptism-timer", field: "live", showLabel: true, label: "" }),
    style: () => READOUT(0.14),
  },

  // OBS / REAPER — bold pills that fill red while recording.
  "obs-status": {
    label: "OBS status",
    group: "OBS",
    config: () => ({ type: "obs-status", mode: "recording", showTimecode: false, hideWhenIdle: false, fillWhenRecording: true }),
    style: () => PILL({ fontWeight: 700, uppercase: true }),
    integration: { id: "obs", label: "OBS" },
  },
  "reaper-status": {
    label: "REAPER status",
    group: "REAPER",
    config: () => ({ type: "reaper-status", showPosition: false, hideWhenIdle: false, fillWhenRecording: true }),
    style: () => PILL({ fontWeight: 700, uppercase: true }),
    integration: { id: "reaper", label: "REAPER" },
  },

  // Control
  "osc-button": {
    label: "OSC button",
    group: "Control",
    config: () => ({ type: "osc-button", targetId: null, label: "Button", address: "/", args: [], feedback: null }),
    style: () => PILL({ fontSize: 0.045 }),
    integration: { id: "osc", label: "OSC" },
  },

  "rosstalk-button": {
    label: "RossTalk button",
    group: "Control",
    config: () => ({ type: "rosstalk-button", targetId: null, commandId: null, params: {}, label: "RossTalk" }),
    style: () => PILL({ fontSize: 0.045 }),
    integration: { id: "rosstalk", label: "RossTalk" },
  },

  // Status
  "integration-status": {
    label: "Integration status",
    group: "Status",
    config: () => ({ type: "integration-status", integrationId: null, showLabel: true }),
    style: () => PILL(),
  },

  // Video layer — native client only; the web build ignores it.
  "ndi-video": {
    label: "NDI video",
    group: null,
    config: () => ({ type: "ndi-video" }) as LayoutObjectConfig,
    style: BARE,
    stylingOnly: true,
  },
};

// ── Derived views over the registry ───────────────────────────────────────────

const ALL_TYPES = Object.keys(LAYOUT_OBJECTS) as LayoutObjectType[];

/** Add-object palette, grouped by domain and ordered by PALETTE_GROUP_ORDER. */
export const PALETTE_GROUPS: { label: PaletteGroup; types: LayoutObjectType[] }[] =
  PALETTE_GROUP_ORDER.map((label) => ({
    label,
    types: ALL_TYPES.filter((t) => LAYOUT_OBJECTS[t].group === label),
  })).filter((g) => g.types.length > 0);

export const typeLabel = (t: LayoutObjectType): string => LAYOUT_OBJECTS[t].label;
export const defaultConfig = (t: LayoutObjectType): LayoutObjectConfig => LAYOUT_OBJECTS[t].config();
export const defaultStyle = (t: LayoutObjectType): LayoutStyle => LAYOUT_OBJECTS[t].style();
export const objectIntegration = (t: LayoutObjectType) => LAYOUT_OBJECTS[t].integration;
export const isStylingOnly = (t: LayoutObjectType): boolean => LAYOUT_OBJECTS[t].stylingOnly === true;
export const usesPropInstance = (t: LayoutObjectType): boolean => LAYOUT_OBJECTS[t].propInstance === true;
