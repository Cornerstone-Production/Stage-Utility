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

import type { HomeCardSize, HomeVisibility } from "@main/types/views";
import { IDIOM_TYPES } from "@main/types/readout-types";

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
  "Resi",
  "YouTube",
  "Control",
  "Status",
] as const;
export type PaletteGroup = (typeof PALETTE_GROUP_ORDER)[number];

export interface LayoutObjectSpec {
  /** Shown in the palette, the layer list and the inspector header. */
  label: string;
  /**
   * One line saying what this SHOWS, for the palette card.
   *
   * Required, so a new object type cannot join the palette as a bare name with
   * no explanation — `tsc` refuses. Written for someone who has not met the
   * object before: "Red while OBS is recording", not "OBS status indicator".
   *
   * Keep under 60 characters; the palette card gives it one line.
   */
  blurb: string;
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
   * The tile this widget arrives at on HOME's grid. Medium when absent.
   *
   * A judgement about the widget, not about a layout: a clock wants a small
   * square, a rundown wants the width. The operator changes it per card; this is
   * only where it starts.
   */
  homeSize?: HomeCardSize;
  /** When this widget is on Home. "always" unless it only makes sense in one of
   *  Home's two moods — a live timer is noise for six days a week. */
  homeWhen?: HomeVisibility;
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

/**
 * One hairline, one radius, for every widget that wears a card.
 *
 * These were written out per preset and had drifted: Glass and the neutral card
 * carried 8% white, Solid carried NO border, and Outline was half again as
 * thick. Three widgets side by side on a wall therefore had three different
 * edges, which is what "the greys look different" was.
 *
 * WIDTH IS A FRACTION OF THE CANVAS HEIGHT, as every length in a layout is. On
 * the 1080-tall design canvas this resolves to exactly 1px, which is what a
 * hairline means; a layout drawn at another size scales it with everything else
 * rather than going spindly against type that grew.
 */
export const HAIRLINE_COLOR = "rgba(255,255,255,0.1)";
export const HAIRLINE = 1 / 1080;
export const CARD_RADIUS = 0.0148;

/**
 * Widgets whose frame is drawn FOR them, and only on Home.
 *
 * These default to no card because Home's grid draws one tile frame around
 * everything on it, and a card inside that tile is a second box. That is right
 * on Home and wrong everywhere else: the palette offers them on a wall layout
 * too, where nothing draws a frame, so a Resi status landed naked beside a
 * REAPER status wearing a card and the two read as different components.
 *
 * The frame is a property of the DESTINATION, not of the widget, so the widget
 * cannot answer it alone — `defaultStyleFor` takes the destination and answers
 * it in one place rather than each caller guessing.
 *
 * This is the same set as the `home-*` half of object-look.test.ts's BARE list,
 * and object-look.test.ts asserts the two are equal — a new Home widget added to
 * one and not the other would otherwise land naked on a wall again, which is the
 * bug this set exists to fix. Typed, not `Set<string>`: a misspelling has to
 * fail the build rather than silently never match.
 */
export const HOST_FRAMED_TYPES = new Set<LayoutObjectType>([
  "home-readiness", "home-next-service", "home-live-status", "home-recent-services",
  "home-recording", "home-recording-obs", "home-recording-reaper", "home-spl",
  "home-screens", "home-streaming", "home-streaming-resi", "home-streaming-youtube",
  "home-scores",
]);

type CardAccent = "neutral" | "green" | "red" | "amber" | "flat";

/**
 * One-click card accents. Also used by the inspector's style-preset picker.
 *
 * The grounds are OPAQUE, and each is the exact blend of the translucent value
 * it replaces over the kiosk black — so a card looks the same as it always did
 * on a bare canvas, and now actually covers what is behind it.
 *
 * The translucent versions made layering unreadable. A card at 4% white does not
 * occlude: put a status widget over a transcript and the transcript reads
 * straight through it, which looks exactly like the widget being drawn
 * underneath. Paint order was verified correct while this was happening — the
 * card was on top and 96% see-through.
 *
 * Deliberately not a blur or a lower alpha: a widget is a card, and a card that
 * you can read the page through is a tint. An operator who wants the canvas to
 * show through still has Fill and Opacity in the inspector.
 */
export const CARD_PRESETS: Record<CardAccent, LayoutStyle> = {
  // #141414, and the shared hairline. This is the "black" a card can actually be.
  //
  // Pure black was tried and is wrong here, measured: the stage canvas grounds at
  // #0a0a0a, so a #000000 card is DARKER than the surface it sits on. It stops
  // reading as a card and starts reading as a hole cut in the canvas -- an editor
  // full of them looks blank. #141414 is two steps up from the canvas, which is
  // what makes it a surface rather than an absence, and it is what the presets
  // have always used.
  //
  // A TINTED card keeps its own coloured edge -- that is an accent the operator
  // asked for, not a default.
  neutral: { background: "#141414", borderColor: HAIRLINE_COLOR, borderWidth: HAIRLINE, cornerRadius: CARD_RADIUS },
  green: { background: "#0d1a15", borderColor: "rgba(45,212,150,0.13)", borderWidth: HAIRLINE, cornerRadius: CARD_RADIUS },
  red: { background: "#201011", borderColor: "rgba(229,72,77,0.25)", borderWidth: HAIRLINE, cornerRadius: CARD_RADIUS },
  amber: { background: "#1e190e", borderColor: "rgba(255,197,61,0.20)", borderWidth: HAIRLINE, cornerRadius: CARD_RADIUS },
  flat: { background: null, borderColor: null, borderWidth: 0, cornerRadius: 0 },
};


/** The default look: centerd white text at body size, on nothing. */
const TEXT = (over: LayoutStyle = {}): LayoutStyle => ({
  fontSize: 0.06,
  fontWeight: 500,
  color: "#ffffff",
  textAlign: "center",
  vAlign: "middle",
  ...over,
});

/**
 * A readout in a card — the default for anything that shows a VALUE in a box.
 *
 * Read out of the operator's own config rather than designed from scratch.
 * Across four real layouts, `CARD_PRESETS.neutral` had been applied BY HAND to
 * thirteen different object types — clock, countdown, plan file, people panel,
 * pacing, people counter, transcript strip, embedded view, live controls and
 * more — every one carrying the identical background, hairline and radius.
 *
 * That is a missing default, not a preference. Half the readouts already shipped
 * with this card (status chips, buttons, wireless, OBS, REAPER) and half did
 * not, for no reason anyone could state — so the operator dressed the second
 * half by hand, once per object, on every layout they built.
 *
 * Only new objects are affected: a stored object carries its own style, so no
 * existing layout moves.
 */
const CARD = (over: LayoutStyle = {}): LayoutStyle => ({ ...CARD_PRESETS.neutral, ...TEXT(over) });
/** A big bold tabular readout in a card (clock, countdown, timers, counters). */
const READOUT = (fontSize: number): LayoutStyle => CARD({ fontSize, fontWeight: 700 });
/** A compact glass pill (status chips, buttons, single mic tiles). */
const PILL = (over: LayoutStyle = {}): LayoutStyle => CARD({ fontSize: 0.05, fontWeight: 600, ...over });
/**
 * No styling at all.
 *
 * For content that paints its own box — media, a shape whose fill IS the object,
 * a grid of its own tiles, a Home card that draws its own frame — and for
 * full-bleed text on a stage display, where a card around every line is chrome
 * nobody asked for. The operator's own layouts leave exactly these bare.
 */
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
    blurb: "Groups other objects so they move and scale together",
    group: "Layout",
    config: () => ({ type: "container" }),
    style: () => ({ ...CARD_PRESETS.neutral }),
  },
  shape: {
    label: "Shape",
    blurb: "A plain rectangle or circle, for dividing up a screen",
    group: "Layout",
    config: () => ({ type: "shape", shape: "rect" }),
    style: () => ({ background: "#3b82f6" }),
    homeSize: "s",
  },
  image: {
    label: "Image",
    blurb: "A picture from a file or URL",
    group: "Layout",
    config: () => ({ type: "image", src: "" }),
    style: BARE,
  },
  "brand-logo": {
    label: "Logo",
    blurb: "Your church logo, from Branding",
    group: "Layout",
    config: () => ({ type: "brand-logo", useEmptySlotLogo: false }),
    style: BARE,
    homeSize: "s",
  },

  // Text & time
  text: {
    label: "Text",
    blurb: "Words you type, that do not change",
    group: "Text & time",
    config: () => ({ type: "text", text: "Text" }),
    style: () => TEXT(),
    homeSize: "s",
  },
  clock: {
    label: "Clock",
    blurb: "The wall clock, 12 or 24 hour",
    group: "Text & time",
    config: () => ({ type: "clock", showSeconds: true, format: "12h" }),
    style: () => CARD({ fontWeight: 600 }),
    homeSize: "s",
  },
  "countdown-timer": {
    label: "PCO countdown",
    blurb: "Time until the service starts, from Planning Center",
    group: "Text & time",
    config: () => ({ type: "countdown-timer", caption: "Service starts in" }) as LayoutObjectConfig,
    style: () => READOUT(0.085),
  },

  // PCO / service
  "live-controls": {
    label: "PCO Prev/Next",
    blurb: "Previous and next buttons for the service",
    group: "PCO / service",
    config: () => ({ type: "live-controls" }) as LayoutObjectConfig,
    style: () => CARD({ fontSize: 0.05, fontWeight: 600 }),
    homeSize: "m",
    homeWhen: "live",
    stylingOnly: true,
  },
  "current-service-item": {
    label: "Current item",
    blurb: "What the plan is on right now",
    group: "PCO / service",
    config: () => ({ type: "current-service-item" }) as LayoutObjectConfig,
    style: () => TEXT(),
    homeSize: "m",
    homeWhen: "live",
    stylingOnly: true,
    propInstance: true,
  },
  "next-service-item": {
    label: "Next item",
    blurb: "What comes after the current item",
    group: "PCO / service",
    config: () => ({ type: "next-service-item" }) as LayoutObjectConfig,
    style: () => TEXT(),
    homeSize: "m",
    homeWhen: "live",
    stylingOnly: true,
    propInstance: true,
  },
  "service-order": {
    label: "Service order (legacy)",
    blurb: "The plan as a running list, with the live item marked",
    group: null,
    retired: {
      replacedBy: "view-embed",
      why: "Embedded view renders the full ScriptView rundown — the same table as the ScriptView pages, with your saved column presets.",
    },
    config: () => ({ type: "service-order", noteCategories: null, showLength: false, highlightLive: true, scroll: "auto", autoFit: true }),
    style: () => TEXT({ fontSize: 0.035, textAlign: "left", vAlign: "top" }),
    homeSize: "l",
  },
  "view-embed": {
    label: "Embedded view",
    blurb: "Another view, shown inside this one",
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
    style: () => CARD({ fontSize: EMBED_FONT_FRACTION, textAlign: "left", vAlign: "top" }),
    homeSize: "l",
  },
  "screen-embed": {
    label: "Embedded screen",
    blurb: "What another screen is showing, live",
    group: "PCO / service",
    config: () => ({ type: "screen-embed", outputId: null, showLabel: true, showStatus: true }),
    // Same starting size as the embedded VIEW above, and for the same reason:
    // whatever the screen is routed to should look like it does on that screen.
    style: () => CARD({ fontSize: EMBED_FONT_FRACTION, textAlign: "left", vAlign: "top" }),
    homeSize: "l",
  },
  "home-readiness": {
    label: "Readiness",
    blurb: "What still needs doing before the next service",
    group: "PCO / service",
    config: () => ({ type: "home-readiness" }),
    style: BARE,
    homeSize: "l",
    homeWhen: "idle",
  },
  "home-next-service": {
    label: "Next service",
    blurb: "The next plan, its series and when it starts",
    group: "PCO / service",
    config: () => ({ type: "home-next-service" }),
    style: BARE,
    homeSize: "m",
    homeWhen: "idle",
  },
  "home-live-status": {
    label: "Service timer",
    blurb: "The running item's clock, and what comes next",
    group: "PCO / service",
    config: () => ({ type: "home-live-status" }),
    style: BARE,
    homeSize: "xl",
    homeWhen: "live",
  },
  "home-recent-services": {
    label: "Recent services",
    blurb: "Attendance, length and start time, recently averaged",
    group: "PCO / service",
    config: () => ({ type: "home-recent-services" }),
    style: BARE,
    homeSize: "xl",
    homeWhen: "idle",
  },
  "service-pacing": {
    label: "Service pacing",
    blurb: "How far ahead or behind the plan the service is",
    group: "PCO / service",
    config: () => ({ type: "service-pacing", hideWhenIdle: false, showLabel: false, caption: "Pacing" }),
    style: () => READOUT(0.1),
    homeSize: "s",
    homeWhen: "live",
  },
  "plan-attachment": {
    label: "Plan file",
    blurb: "A page from a file attached to the plan",
    group: "PCO / service",
    config: () => ({ type: "plan-attachment", match: "stage plot", page: 1 }),
    style: () => ({ ...CARD_PRESETS.neutral }),
    homeSize: "l",
  },

  // ProPresenter
  "current-slide-text": {
    label: "Current slide",
    blurb: "The words on the slide showing now",
    group: "ProPresenter",
    config: () => ({ type: "current-slide-text" }) as LayoutObjectConfig,
    style: () => TEXT({ uppercase: true }),
    homeSize: "m",
    homeWhen: "live",
    stylingOnly: true,
    propInstance: true,
  },
  "next-slide-text": {
    label: "Next slide",
    blurb: "The words on the slide coming next",
    group: "ProPresenter",
    config: () => ({ type: "next-slide-text" }) as LayoutObjectConfig,
    style: () => TEXT({ uppercase: true }),
    homeSize: "m",
    homeWhen: "live",
    stylingOnly: true,
    propInstance: true,
  },
  "current-slide-notes": {
    label: "Slide notes",
    blurb: "The speaker notes on the slide showing now",
    group: "ProPresenter",
    config: () => ({ type: "current-slide-notes" }) as LayoutObjectConfig,
    style: () => TEXT({ uppercase: true }),
    homeSize: "m",
    homeWhen: "live",
    stylingOnly: true,
    propInstance: true,
  },
  "slide-thumbnail": {
    label: "Slide image",
    blurb: "A picture of the slide showing now",
    group: "ProPresenter",
    config: () => ({ type: "slide-thumbnail" }) as LayoutObjectConfig,
    style: BARE,
    stylingOnly: true,
    propInstance: true,
  },
  "section-chip": {
    label: "Section chip",
    blurb: "The part of the service running now, as a label",
    group: "ProPresenter",
    config: () => ({ type: "section-chip", which: "current" }),
    style: () => PILL({ uppercase: true, letterSpacing: 0.04 }),
    homeSize: "s",
    propInstance: true,
  },
  "pp-timer": {
    label: "ProPresenter timer",
    blurb: "A timer from ProPresenter, by name",
    group: "ProPresenter",
    config: () => ({ type: "pp-timer", timerName: null, propresenterInstanceId: null, warnStates: true, hideWhenIdle: false, showLabel: true, caption: "Stage timer" }),
    style: () => READOUT(0.1),
    homeSize: "s",
    homeWhen: "live",
    propInstance: true,
  },
  "slide-progress": {
    label: "Slide progress",
    blurb: "How far through the current presentation",
    group: "ProPresenter",
    config: () => ({ type: "slide-progress", propresenterInstanceId: null, display: "fraction", showLabel: false }),
    style: () => CARD({ fontWeight: 600 }),
    homeSize: "s",
    propInstance: true,
  },

  // Mics & RF
  "slots-grid": {
    label: "Mic slots",
    blurb: "Who is on which mic, as a grid of cards",
    group: "Mics & RF",
    config: () => ({ type: "slots-grid", source: "inline", sourceViewId: null }),
    style: () => TEXT(),
    homeSize: "xl",
  },
  "charger-battery": {
    label: "Charger battery",
    blurb: "Battery levels in the charger bays",
    group: "Mics & RF",
    config: () => ({ type: "charger-battery", bays: [], show: { battery: true, charging: true } }),
    style: () => CARD({ fontSize: 0.045, textAlign: "left" }),
    homeSize: "s",
    integration: { id: "wireless", label: "wireless" },
  },
  "wireless-summary": {
    label: "Wireless summary",
    blurb: "How many packs are online, and their batteries",
    group: "Mics & RF",
    config: () => ({ type: "wireless-summary", showOnline: true, showBattery: true, showRuntime: false, showLabel: false, label: "Mics" }),
    style: () => PILL(),
    homeSize: "s",
    integration: { id: "wireless", label: "wireless" },
  },
  "wireless-channel": {
    label: "Mic channel",
    blurb: "RF and battery for one wireless pack",
    group: "Mics & RF",
    config: () => ({ type: "wireless-channel", channelId: null, show: { rf: true, battery: true, runtime: false, frequency: true, audio: false }, showLabel: true }),
    style: () => PILL(),
    homeSize: "s",
    integration: { id: "wireless", label: "wireless" },
  },

  // Audio (SPL)
  "spl-meter": {
    label: "SPL meter",
    blurb: "The live sound level from Smaart",
    group: "Audio (SPL)",
    config: () => ({ type: "spl-meter", meterId: null, metricKey: null, showLabel: false, thresholds: null, caption: "SPL dB(A)" }),
    style: () => READOUT(0.085),
    homeSize: "s",
    integration: { id: "smaart", label: "Smaart SPL" },
  },

  // Transcription
  "home-spl": {
    label: "Sound level",
    blurb: "The loudest meter right now, and which one",
    group: "Audio (SPL)",
    config: () => ({ type: "home-spl" }),
    style: BARE,
    homeSize: "s",
    stylingOnly: true,
  },
  "transcript-strip": {
    label: "Transcription",
    blurb: "Live captions of what is being said",
    group: "Transcription",
    config: () => ({ type: "transcript-strip", mode: "rolling" }),
    style: () => TEXT({ fontSize: 0.045, textAlign: "left", vAlign: "bottom" }),
    homeSize: "xl",
    integration: { id: "prodcom", label: "transcription" },
  },

  // People
  "people-counter": {
    label: "People counter",
    blurb: "How many people are in the room",
    group: "People",
    config: () => ({ type: "people-counter", metric: "attendance", zoneId: null, label: "People", showLabel: true, caption: "Attendance" }),
    style: () => READOUT(0.12),
    homeSize: "s",
    integration: { id: "sensource", label: "SenSource" },
  },
  "people-panel": {
    label: "People summary",
    blurb: "Several attendance numbers side by side",
    group: "People",
    config: () => ({ type: "people-panel", metrics: ["occupancy", "peak", "attendance"], showLabels: true, orientation: "row" }),
    style: () => READOUT(0.1),
  },
  "people-graph": {
    label: "People graph",
    blurb: "How the room has filled over time",
    group: "People",
    config: () => ({ type: "people-graph", metric: "occupancy", showLabel: true, label: "In room" }),
    style: () => ({ color: "#5b9cff", ...CARD_PRESETS.neutral }),
    homeSize: "l",
    integration: { id: "sensource", label: "SenSource" },
  },

  // Baptisms
  "baptism-timer": {
    label: "Baptism timer",
    blurb: "The running baptism clock, or the session's totals",
    group: "Baptisms",
    config: () => ({ type: "baptism-timer", field: "live", showLabel: true, label: "", caption: "Baptisms" }),
    style: () => READOUT(0.14),
    homeSize: "s",
    homeWhen: "live",
  },

  // Recording state. `record-status` answers "is anything recording?" across both
  // recorders; the two device-specific objects below are for when you want one.
  "record-status": {
    label: "Record status",
    blurb: "Red while anything is recording",
    group: "Status",
    config: () => ({ type: "record-status", source: "any", hideWhenIdle: false, fillWhenRecording: true }),
    style: () => PILL({ fontWeight: 700, uppercase: true }),
    homeSize: "s",
  },

  // OBS / REAPER — bold pills that fill red while recording.
  "obs-status": {
    label: "OBS status",
    blurb: "Red while OBS is recording or streaming",
    group: "OBS",
    config: () => ({ type: "obs-status", mode: "recording", showTimecode: false, hideWhenIdle: false, fillWhenRecording: true }),
    style: () => PILL({ fontWeight: 700, uppercase: true }),
    homeSize: "s",
    integration: { id: "obs", label: "OBS" },
  },
  "reaper-status": {
    label: "REAPER status",
    blurb: "Red while REAPER is recording",
    group: "REAPER",
    config: () => ({ type: "reaper-status", showPosition: false, hideWhenIdle: false, fillWhenRecording: true }),
    style: () => PILL({ fontWeight: 700, uppercase: true }),
    homeSize: "s",
    integration: { id: "reaper", label: "REAPER" },
  },

  // Control
  "osc-button": {
    label: "OSC button",
    blurb: "Sends an OSC message to gear on the network",
    group: "Control",
    config: () => ({ type: "osc-button", targetId: null, label: "Button", address: "/", args: [], feedback: null }),
    style: () => PILL({ fontSize: 0.045 }),
    integration: { id: "osc", label: "OSC" },
  },

  "rosstalk-button": {
    label: "RossTalk button",
    blurb: "Fires a RossTalk command at a switcher",
    group: "Control",
    config: () => ({ type: "rosstalk-button", targetId: null, commandId: null, params: {}, label: "RossTalk" }),
    style: () => PILL({ fontSize: 0.045 }),
    integration: { id: "rosstalk", label: "RossTalk" },
  },

  "action-button": {
    label: "Action button",
    blurb: "Runs one of the app's own actions",
    group: "Control",
    config: () => ({ type: "action-button", actionId: "", params: {}, label: "Action" }),
    style: () => PILL({ fontSize: 0.045 }),
  },

  notes: {
    label: "Notes",
    blurb: "A shared note anyone can type into",
    group: "Control",
    config: () => ({ type: "notes", placeholder: "Notes for this service" }),
    style: () => CARD({ fontSize: 0.035, textAlign: "left", vAlign: "top" }),
  },

  checklist: {
    label: "Checklist",
    blurb: "A list of things to tick off",
    group: "Control",
    config: () => ({ type: "checklist", title: "Pre-service" }),
    style: () => CARD({ fontSize: 0.035, textAlign: "left", vAlign: "top" }),
  },

  // Status
  "integration-status": {
    label: "Integration status",
    blurb: "Whether one integration is connected",
    group: "Status",
    config: () => ({ type: "integration-status", integrationId: null, showLabel: true }),
    style: () => PILL(),
    homeSize: "s",
  },
  "home-recording": {
    label: "Recording",
    blurb: "Is anything rolling — every recorder answered at once",
    group: "Status",
    config: () => ({ type: "home-recording" }),
    style: BARE,
    homeSize: "s",
    stylingOnly: true,
  },
  "home-recording-obs": {
    label: "OBS recording",
    blurb: "Rolling or stopped, with the elapsed time",
    group: "OBS",
    config: () => ({ type: "home-recording-obs" }),
    style: BARE,
    homeSize: "s",
    stylingOnly: true,
    integration: { id: "obs", label: "OBS" },
  },
  "home-recording-reaper": {
    label: "REAPER recording",
    blurb: "Rolling or stopped, with the elapsed time",
    group: "REAPER",
    config: () => ({ type: "home-recording-reaper" }),
    style: BARE,
    homeSize: "s",
    stylingOnly: true,
    integration: { id: "reaper", label: "REAPER" },
  },
  "home-screens": {
    label: "Screens online",
    blurb: "How many displays are connected, of how many",
    group: "Status",
    config: () => ({ type: "home-screens" }),
    style: BARE,
    homeSize: "s",
    stylingOnly: true,
  },
  "home-streaming": {
    label: "Streaming",
    blurb: "Live or off air, across every platform at once",
    group: "Status",
    config: () => ({ type: "home-streaming" }),
    style: BARE,
    homeSize: "s",
    stylingOnly: true,
  },
  "home-streaming-resi": {
    label: "Resi status",
    blurb: "Live or off air, with the elapsed time",
    group: "Resi",
    config: () => ({ type: "home-streaming-resi" }),
    style: BARE,
    homeSize: "s",
    stylingOnly: true,
    integration: { id: "resi", label: "Resi" },
  },
  "home-streaming-youtube": {
    label: "YouTube status",
    blurb: "Live or off air, with the elapsed time",
    group: "YouTube",
    config: () => ({ type: "home-streaming-youtube" }),
    style: BARE,
    homeSize: "s",
    stylingOnly: true,
    integration: { id: "youtube", label: "YouTube" },
  },
  "stream-status": {
    label: "Streaming status",
    blurb: "Whether anything is going out, and for how long",
    group: "Status",
    // fillWhenLive stated rather than left to the default, exactly as obs-status
    // states fillWhenRecording — the two sit beside each other on a wall and the
    // pair of defaults disagreeing is what made them look like different widgets.
    config: () => ({ type: "stream-status", platform: "any", showElapsed: true, fillWhenLive: true }),
    // A pill like obs-status: this one goes on a WALL, where a bare number has
    // nothing to say what it is. The three Home ones stay bare, because Home's
    // grid draws their frame.
    style: () => PILL({ fontWeight: 700, uppercase: true }),
  },

  // Live scores. Its own composition -- team colours, the score, and the centre
  // each sport needs -- so it is NOT a PILL and NOT in IDIOM_TYPES: there is no
  // caption/value/sub to squeeze it into.
  scores: {
    label: "Live scores",
    blurb: "Live score for a team you follow",
    group: "Status",
    config: () => ({ type: "scores", game: "auto", detail: true }),
    // BARE, like slots-grid, and for the same reason it gives: the strip paints
    // its own neutral ground edge to edge. A card around it would be a hairline
    // and a radius nobody could see -- the strip's own opaque ground covers both
    // the card's corners and its fill. This DEVIATES from the plan's table, which
    // had scores carded; the plan was written before the strip existed.
    style: () => TEXT(),
    homeSize: "m",
    integration: { id: "scores", label: "Live scores" },
  },

  // The same fact on Home, in Home's own voice. A separate type rather than the
  // wall object with a flag, exactly as the recording and streaming pairs are:
  // the two are different compositions, and a card that wore the wall's got a
  // panel of brand colour beside a readiness list.
  "home-scores": {
    label: "Scores",
    blurb: "Followed teams' scores, on your own page",
    group: "Status",
    config: () => ({ type: "home-scores" }),
    // Bare on Home, carded on a wall -- see HOST_FRAMED_TYPES.
    style: () => TEXT(),
    homeSize: "m",
    // "always", by NOT saying otherwise. Sunday afternoon NFL overlaps the second
    // service in most US churches, so "idle" as a default would mean the feature
    // never fires on the day it exists for. The operator's own page is not
    // stage-facing and they chose to add the card; `when` is on the config for
    // anyone who wants it gone mid-service.
    integration: { id: "scores", label: "Live scores" },
  },

  // Video layer — native client only; the web build ignores it.
  "ndi-video": {
    label: "NDI video",
    blurb: "An NDI video source from the network",
    group: null,
    config: () => ({ type: "ndi-video" }) as LayoutObjectConfig,
    style: BARE,
    homeSize: "l",
    stylingOnly: true,
  },
};

/**
 * Which View kinds a `view-embed` object may render.
 *
 * Every kind. It used to be `["script"]`, with custom excluded from the picker
 * as the entire recursion guard — and the picker offered four kinds it then
 * refused to draw, which read as broken rather than as unfinished.
 *
 * The guard now lives in embed-chain.ts, where it is a cycle check over the
 * ancestor chain plus a depth cap, rather than a whole kind being unavailable.
 *
 * Listed rather than derived, so adding a View kind is a deliberate decision to
 * make it embeddable and not something that happens by accident. The list is
 * every member of ViewKind today; EmbeddedView's switch is exhaustive, so a new
 * kind is a compile error there whether or not anyone remembers this list.
 */
export const EMBEDDABLE_VIEW_KINDS: readonly ViewKind[] = [
  "slots",
  "dashboard",
  "stage",
  "transcription",
  "custom",
  "script",
  "spl-rundown",
  "calendar",
];

export function isEmbeddableViewKind(kind: ViewKind): boolean {
  return EMBEDDABLE_VIEW_KINDS.includes(kind);
}

/** Offered in the embed picker. Every kind renders now, so the picker no longer
 *  needs to offer kinds it cannot draw — the two lists are the same list. */
export function isOfferableInEmbedPicker(kind: ViewKind): boolean {
  return isEmbeddableViewKind(kind);
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
/**
 * The style a NEW object of this type starts with.
 *
 * Readouts come out with no `textAlign` at all. Every style preset here spreads
 * TEXT(), which writes `textAlign: "center"` — so every readout ever created
 * stored a centre alignment nobody chose, and the idiom's left-aligned
 * composition could not be the default without ignoring the field entirely.
 *
 * Stripped HERE because this is the single funnel: adding an object, resetting
 * an object's style and seeding a Home card all come through it, so a readout
 * cannot acquire the value by some other door. `readout-align.test.ts` walks
 * every readout type rather than trusting that.
 */
export const defaultStyle = (t: LayoutObjectType): LayoutStyle => {
  const s = findLayoutObjectSpec(t)?.style() ?? {};
  if (!IDIOM_TYPES.has(t)) return s;
  const { textAlign: _neverChosen, ...rest } = s;
  return rest;
};
export const objectIntegration = (t: LayoutObjectType) => findLayoutObjectSpec(t)?.integration;
export const isStylingOnly = (t: LayoutObjectType): boolean => findLayoutObjectSpec(t)?.stylingOnly === true;
export const usesPropInstance = (t: LayoutObjectType): boolean => findLayoutObjectSpec(t)?.propInstance === true;
export const objectRetired = (t: LayoutObjectType) => findLayoutObjectSpec(t)?.retired;

/**
 * The style a newly added widget starts with, for the surface it is added to.
 *
 * `hostDrawsFrame` is true only for Home, whose grid frames every tile. Anywhere
 * else a host-framed widget gets the ordinary card, so it matches the widget
 * beside it instead of sitting on the canvas with no edge at all.
 */
export function defaultStyleFor(
  type: keyof typeof LAYOUT_OBJECTS,
  opts: { hostDrawsFrame: boolean },
): LayoutStyle {
  // THROUGH defaultStyle, never the registry directly. It does two jobs this
  // must not skip: it strips the `textAlign` that TEXT() writes but nobody
  // chose, so DEFAULT_READOUT_ALIGN can still decide; and it reads through
  // findLayoutObjectSpec, so a type this build does not know returns {} instead
  // of throwing. Both were lost when makeObject and resetLook moved onto this
  // function -- a readout added in the editor stored textAlign:"center"
  // permanently, and Reset look on an object from a newer build white-screened
  // the page.
  const base = defaultStyle(type);
  if (opts.hostDrawsFrame || !HOST_FRAMED_TYPES.has(type)) return base;
  return { ...CARD_PRESETS.neutral, ...base };
}
