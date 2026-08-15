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
  /**
   * Superseded. Kept renderable, out of the palette, and offered a one-click
   * conversion in the inspector.
   *
   * Not deleted: an object type lives in views.json, which is a CONFIG store and
   * therefore what Backup & restore puts back. Removing the type outright means
   * restoring any snapshot taken before the change hands the renderer an object
   * it no longer understands, and the object silently vanishes from a layout the
   * operator believes they just restored. Deletion waits until the conversions
   * have happened and such a snapshot is no longer one anybody would restore.
   */
  retired?: { replacedBy: LayoutObjectType; why: string };
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

/** The default look: centerd white text at body size. */
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

/**
 * The font size an embedded View starts at, as a fraction of layout height.
 *
 * Derived from the ScriptView page rather than picked: the page sets
 * `clamp(0.8rem, 1.6vmin, 1.1rem)`, which on a 1080-tall 16:9 screen resolves to
 * 1.6vmin = 17.28px, and 17.28 / 1080 = 0.016. Exported so the layout editor can
 * show the same number as the default instead of a second guess — the inspector
 * used to fall back to 0.05, so a fresh embed reported a size it was not using.
 */
export const EMBED_FONT_FRACTION = 0.016;

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
    label: "Service order (legacy)",
    group: null,
    retired: {
      replacedBy: "view-embed",
      why: "Embedded view renders the full ScriptView rundown — the same table as the ScriptView pages, with your saved column presets.",
    },
    config: () => ({ type: "service-order", noteCategories: null, showLength: false, highlightLive: true, scroll: "auto", autoFit: true }),
    style: () => TEXT({ fontSize: 0.035, textAlign: "left", vAlign: "top" }),
  },
  "view-embed": {
    label: "Embedded view",
    group: "PCO / service",
    config: () => ({ type: "view-embed", viewId: null }),
    // The size the ScriptView PAGE actually renders at, expressed as a fraction
    // of height: the page's `clamp(0.8rem, 1.6vmin, 1.1rem)` resolves to ~17.3px
    // on a 1080-tall 16:9 screen, and 17.3/1080 ≈ 0.016.
    //
    // It was 0.03 — nearly double — chosen on the reasoning that an embed should
    // be "readable from a stage" without touching anything. That was the wrong
    // frame: the requirement for this object is that nothing looks different
    // between the embed and the page it came out of, and a default that renders
    // at 1.85× the page breaks exactly that, showing about half the rundown.
    // Someone who does want it bigger has the font-size field; someone who wants
    // it to match the page had no way to get there by eye.
    style: () => TEXT({ fontSize: EMBED_FONT_FRACTION, textAlign: "left", vAlign: "top" }),
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

  // Recording state. `record-status` answers "is anything recording?" across both
  // recorders; the two device-specific objects below are for when you want one.
  "record-status": {
    label: "Record status",
    group: "Status",
    config: () => ({ type: "record-status", source: "any", hideWhenIdle: false, fillWhenRecording: true }),
    style: () => PILL({ fontWeight: 700, uppercase: true }),
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

  "action-button": {
    label: "Action button",
    group: "Control",
    config: () => ({ type: "action-button", actionId: "", params: {}, label: "Action" }),
    style: () => PILL({ fontSize: 0.045 }),
  },

  notes: {
    label: "Notes",
    group: "Control",
    config: () => ({ type: "notes", placeholder: "Notes for this service" }),
    style: () => ({ fontSize: 0.035, align: "left" as const }),
  },

  checklist: {
    label: "Checklist",
    group: "Control",
    config: () => ({ type: "checklist", title: "Pre-service" }),
    style: () => ({ fontSize: 0.035, align: "left" as const }),
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

/**
 * Which View kinds a `view-embed` object may render.
 *
 * ONE function, used by both the picker and the renderer, because the two
 * disagreeing is the whole hazard. Custom is excluded and that is the entire
 * recursion guard: a custom View is the only kind holding a layout, so refusing
 * it means an embed can never reach another embed — no depth counter to get
 * wrong. Every other kind is listed explicitly, so adding a View kind does not
 * silently make it embeddable before anyone has made it render in a box.
 *
 * A function rather than a comment or a filter written out at each call site:
 * the guard test calls THIS, so it fails on the behaviour changing rather than
 * on a string moving inside a 2,500-line file.
 */
export const EMBEDDABLE_VIEW_KINDS: readonly ViewKind[] = ["script"];

export function isEmbeddableViewKind(kind: ViewKind): boolean {
  return EMBEDDABLE_VIEW_KINDS.includes(kind);
}

/** Offered in the embed picker: everything except custom, so an operator can see
 *  a kind exists and read why it is not renderable yet, rather than wondering
 *  where it went. Custom never appears — see isEmbeddableViewKind. */
export function isOfferableInEmbedPicker(kind: ViewKind): boolean {
  return kind !== "custom";
}

// ── Derived views over the registry ───────────────────────────────────────────

const ALL_TYPES = Object.keys(LAYOUT_OBJECTS) as LayoutObjectType[];

/** Add-object palette, grouped by domain and ordered by PALETTE_GROUP_ORDER. */
export const PALETTE_GROUPS: { label: PaletteGroup; types: LayoutObjectType[] }[] =
  PALETTE_GROUP_ORDER.map((label) => ({
    label,
    types: ALL_TYPES.filter((t) => LAYOUT_OBJECTS[t].group === label),
  })).filter((g) => g.types.length > 0);

/**
 * The registry entry for a type, or null when this build has never heard of it.
 *
 * The type system says every `LayoutObjectType` is a key of `LAYOUT_OBJECTS`, and
 * within one build that is true. It stops being true the moment a layout arrives
 * from somewhere else — and layouts do: `views.json` is a CONFIG store, so it is
 * carried across versions by export/import and by every restore. Feed a config
 * containing an object this build does not have (restore a newer snapshot onto an
 * older server — exactly what a config upload does) and the lookup returns
 * undefined against a type that claims it cannot.
 *
 * Every accessor below goes through this. They used to read `.label`, `.retired`
 * and friends straight off the lookup, so opening the layout editor on such a
 * view threw `can't access property "label", undefined` and white-screened the
 * whole Views page — no way back except editing config by hand.
 */
export function findLayoutObjectSpec(t: LayoutObjectType): LayoutObjectSpec | null {
  return (LAYOUT_OBJECTS as Partial<Record<LayoutObjectType, LayoutObjectSpec>>)[t] ?? null;
}

/** True when this build can actually render/edit the type at all. */
export function isKnownObjectType(t: LayoutObjectType): boolean {
  return findLayoutObjectSpec(t) !== null;
}

// Fallbacks are chosen so an unknown object is INERT rather than plausible: it
// keeps its place in the layout and names itself, and every capability query
// answers "no" so nothing tries to configure something it cannot describe.
export const typeLabel = (t: LayoutObjectType): string => findLayoutObjectSpec(t)?.label ?? `Unsupported object (${t})`;
export const defaultConfig = (t: LayoutObjectType): LayoutObjectConfig => findLayoutObjectSpec(t)?.config() ?? ({ type: t } as LayoutObjectConfig);
export const defaultStyle = (t: LayoutObjectType): LayoutStyle => findLayoutObjectSpec(t)?.style() ?? {};
export const objectIntegration = (t: LayoutObjectType) => findLayoutObjectSpec(t)?.integration;
export const isStylingOnly = (t: LayoutObjectType): boolean => findLayoutObjectSpec(t)?.stylingOnly === true;
export const usesPropInstance = (t: LayoutObjectType): boolean => findLayoutObjectSpec(t)?.propInstance === true;
export const objectRetired = (t: LayoutObjectType) => findLayoutObjectSpec(t)?.retired;
