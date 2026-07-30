// Shared stage types — frontend mirrors these shapes exactly.

import type { OscArg, OscFeedbackBind } from "./osc.js";
import type { ConnectionState } from "./integrations.js";

/**
 * What a View renders: slot grid (default), dashboard, stage, transcription, or
 * a "custom" free-form layout authored with the visual editor (see {@link LayoutDTO}).
 */
export type ViewKind =
  | "slots"
  | "dashboard"
  | "stage"
  | "transcription"
  | "custom"
  | "script"
  | "spl-rundown";

/** @deprecated Back-compat alias retained for the legacy display model. Use ViewKind. */
export type DisplayKind = ViewKind;

/** A live transcript line from ProdCom (pushed on "prodcom:transcript"). */
export interface TranscriptLineDTO {
  /** Stable id for keying/dedupe (falls back to a synthesized one). */
  id: string;
  /** Channel id/index from ProdCom, if provided. */
  channel: string | null;
  /** Human channel label, if provided. */
  channelName: string | null;
  /** Per-channel color from ProdCom, if it provides one (e.g. "#rrggbb"). When
   *  null the UI falls back to a deterministic per-channel color. */
  color: string | null;
  text: string;
  /** False = interim/partial hypothesis still being revised; true = finalized. */
  isFinal: boolean;
  /** ISO timestamp the line was received. */
  at: string;
}

/** A ProPresenter slide group/section (e.g. Verse, Chorus) with its color. */
export interface ProSection {
  name: string;
  /** "#rrggbb" derived from ProPresenter's rgba group color. */
  colorHex: string;
}

/** A ProPresenter named timer (countdown/clock) currently running. */
export interface ProTimer {
  name: string;
  /** Display string from the API, e.g. "00:03:00". */
  time: string;
  state: string;
}

/**
 * @deprecated The display model has been split into {@link View} (content) and
 * {@link Output} (a physical screen). DisplayInfo is retained only as a computed
 * compatibility shim in {@link StageState} so older clients (the native Apple app,
 * the legacy phone control page) keep working. Each shim entry is one Output joined
 * with the kind/ndiSource of the View it's routed to.
 */
export interface DisplayInfo {
  id: string;
  name: string;
  /** Defaults to "slots" when absent (back-compat with older settings). */
  kind?: DisplayKind;
  /** NDI source name (mirrors the routed View's ndiSource). */
  ndiSource?: string | null;
}

/**
 * A named, reusable content definition — what to show, decoupled from any screen.
 * Many Views can exist; an {@link Output} is routed to exactly one View, and one
 * View can drive many Outputs.
 *
 * For slots-kind Views the actual slot configuration lives in the slots store
 * (slots.json), keyed by this View's `id` + the active service type — exactly the
 * storage the legacy per-display model used, so migrated Views reuse it untouched.
 * Resolved slots are surfaced on `StageState.slotsByView[id]`.
 */
export interface View {
  id: string;
  name: string;
  kind: ViewKind;
  /**
   * NDI source name this View should show as a video layer, or null for none.
   * Stored as the source *name* only — video never flows through the server. The
   * native Apple client discovers the source on the LAN (mDNS) and receives it
   * peer-to-peer; web clients can't render NDI and ignore this.
   */
  ndiSource?: string | null;
  /** ISO creation timestamp (for stable ordering). */
  createdAt: string;
  /** Free-form layout for kind === "custom"; null/absent for the built-in kinds. */
  layout?: LayoutDTO | null;
  /**
   * Physical-alignment config for a slots-View (so on-screen columns line up with
   * the chargers below the monitor). Absent/null → columns share width equally
   * (default). When set, columns are sized in inches against `displayWidthIn`
   * (the monitor's active width), so widths render at true physical inches.
   */
  slotsLayout?: SlotsLayout | null;
  /** Show the PCO Live Prev/Next controls on a "script" View (default false). */
  showLiveControls?: boolean;
}

/** Physical layout config for a slots-View. All measurements in inches. */
export interface SlotsLayout {
  /** The monitor's active-area width (e.g. ~32.25 for a 37″ 16:9 panel). */
  displayWidthIn: number;
  /** Default width of one charger column (e.g. 3.49 for a Shure SBC220). */
  columnWidthIn: number;
}

// ── Visual layout schema (kind === "custom") ─────────────────────────────────
// A custom View is a fixed DESIGN canvas with absolutely-positioned objects.
// All positions/sizes are FRACTIONS of the canvas (0..1) so the same layout
// renders identically at any rendered size. Font/radius/padding sizes are
// fractions of canvas HEIGHT. Bound objects read the same live data the built-in
// kinds use (no new live data is introduced).

export interface LayoutCanvas {
  /** Design-space dimensions; define aspect ratio + the basis for font scaling. */
  width: number;
  height: number;
  /** Solid background behind all objects (under NDI). "#rrggbb[aa]" or null. */
  background?: string | null;
  /**
   * How the layout fits its display/editor area:
   * - "contain" (default): letterbox the design aspect (bars on mismatched screens).
   * - "fill": fill the whole window — objects (fractional) reflow to the window's
   *   shape, fonts scale by window height; no bars, no distortion.
   */
  fit?: "contain" | "fill";
}

export type LayoutHAlign = "left" | "center" | "right";
export type LayoutVAlign = "top" | "middle" | "bottom";

/** Generic visual styling. Every field optional; the renderer applies defaults. */
export interface LayoutStyle {
  /** Fraction of canvas HEIGHT (e.g. 0.06 ≈ 64px on a 1080-tall canvas). */
  fontSize?: number;
  fontWeight?: number;
  italic?: boolean;
  uppercase?: boolean;
  letterSpacing?: number; // em
  color?: string;
  textAlign?: LayoutHAlign;
  vAlign?: LayoutVAlign;
  background?: string | null;
  opacity?: number; // 0..1
  cornerRadius?: number; // fraction of canvas height
  padding?: number; // fraction of canvas height
  borderColor?: string | null;
  borderWidth?: number; // fraction of canvas height
  /** Drop-shadow strength 0..1 for legibility over video/photos. */
  textShadow?: number;
  /** Box elevation 0..1 — a soft drop shadow under the object's box, so stacked
   *  cards read as layered. 0 = none. */
  boxShadow?: number;
  lineClamp?: number | null;
}

/** Per-type configuration. The discriminant is `type`. */
export type LayoutObjectConfig =
  | { type: "text"; text: string }
  | { type: "clock"; showSeconds?: boolean; format?: "12h" | "24h"; showMeridiem?: boolean }
  // PCO Live countdown. `hideWhenIdle` renders nothing (instead of "—") when no
  // timer is live; `warnSeconds` turns the readout amber once the remaining time
  // drops to/below that many seconds (it still goes red on overtime).
  | { type: "countdown-timer"; hideWhenIdle?: boolean; warnSeconds?: number }
  // Service pacing — how far ahead/behind the plan we are right now. `scope: "item"`
  // compares the current live item's elapsed time to its planned length (from
  // pco:live); `scope: "service"` sums actual-vs-planned across the recorded service
  // timeline for a running whole-service total. Over plan reads red, under reads green.
  | { type: "service-pacing"; scope?: "item" | "service"; hideWhenIdle?: boolean; showLabel?: boolean; aheadColor?: string | null; behindColor?: string | null }
  // ProPresenter-fed objects. `propresenterInstanceId` picks which configured
  // instance to read (omitted / "default" = the primary) — lets separate custom
  // views per auditorium point at different ProPresenter machines.
  | { type: "current-slide-text"; propresenterInstanceId?: string | null }
  | { type: "next-slide-text"; propresenterInstanceId?: string | null }
  | { type: "current-service-item"; propresenterInstanceId?: string | null }
  | { type: "next-service-item"; propresenterInstanceId?: string | null }
  | { type: "current-slide-notes"; propresenterInstanceId?: string | null }
  | { type: "slide-thumbnail"; propresenterInstanceId?: string | null }
  | { type: "section-chip"; which: "current" | "next" | "nextArrangement"; propresenterInstanceId?: string | null }
  // A timer running INSIDE ProPresenter (its stage/countdown timers) — distinct from
  // the PCO countdown. `timerName` picks one by name (blank = the first reported);
  // `warnStates` colors the readout when the timer's state reads as overrun/expired.
  | { type: "pp-timer"; timerName?: string | null; propresenterInstanceId?: string | null; warnStates?: boolean; hideWhenIdle?: boolean; showLabel?: boolean }
  // ProPresenter slide position within the current presentation. `display`: "fraction"
  // ("3 / 12"), "remaining" ("9 left"), "percent", or a progress "bar".
  | { type: "slide-progress"; propresenterInstanceId?: string | null; display?: "fraction" | "remaining" | "percent" | "bar"; showLabel?: boolean }
  // Mic-slots grid. `source: "view"` embeds an existing slots-View's grid by
  // `sourceViewId`; `source: "inline"` defines its own slot set, stored per service
  // type keyed by this object's id (resolved into `StageState.slotsByLayoutObject`),
  // with `slotsLayout` holding its physical-inch alignment. Missing `source` ==
  // "view" (back-compat with existing objects).
  | { type: "slots-grid"; source?: "view" | "inline"; sourceViewId?: string | null; slotsLayout?: SlotsLayout | null }
  // `hideChannels` drops lines from the named ProdCom channels (by channel name)
  // so a strip can show only the channels you care about.
  | { type: "transcript-strip"; mode: "latest" | "rolling"; maxLines?: number; hideChannels?: string[] }
  | { type: "live-controls" } // PCO Services Live Prev/Next buttons (interactive)
  // Shure SBC charger bay battery levels. `bays` lists which bays to show (by
  // ChargerBay id) with an optional custom label; `show` toggles each metric.
  | {
      type: "charger-battery";
      bays: { id: string; label?: string }[];
      show: { battery?: boolean; charging?: boolean; cycles?: boolean; health?: boolean; temp?: boolean };
    }
  | { type: "brand-logo"; useEmptySlotLogo?: boolean }
  | { type: "ndi-video" } // background; web shows a placeholder, Apple shows video
  | { type: "image"; src: string }
  // A file attached to the CURRENT PCO plan, matched by filename each week so the
  // object auto-tracks the live plan (e.g. the Sunday stage plot). PDFs render
  // client-side; images render directly. `match` is a case-insensitive filename
  // substring (default "stage plot"); `page` is the 1-based PDF page. The rendered
  // image (not the source file) is post-processed: optional manual `crop` (edge
  // insets 0..1), `trim` of surrounding whitespace, and `background` recolor of the
  // near-white page (keep / fill black / knock out to transparent).
  | {
      type: "plan-attachment";
      match?: string;
      page?: number;
      crop?: { top: number; right: number; bottom: number; left: number };
      trim?: boolean;
      background?: "keep" | "black" | "transparent";
    }
  // A live SPL value from Smaart. `meterId` selects a device/channel
  // ("device::channel"); `metricKey` selects which value to show (e.g. "SPL A
  // Slow", "LAeq 10"); both default to the first available. Optional thresholds
  // color the readout amber/red above the given dB levels.
  | {
      type: "spl-meter";
      meterId?: string | null;
      metricKey?: string | null;
      showLabel?: boolean;
      thresholds?: { amber: number; red: number } | null;
      /** Hold the highest value seen (resets on reload / meter change) instead of the live reading. */
      peakHold?: boolean;
    }
  // Live OBS output indicator (from the OBS integration, `StageState`-adjacent
  // `obs:status` channel). `mode` picks which output to reflect — recording
  // (default, back-compat), streaming, or virtual camera. Turns red while that
  // output is active. The label texts override the per-mode defaults
  // ("OBS: Recording" / "OBS: Standby" / "OBS: Offline" for recording, etc.).
  // `hideWhenIdle` makes it a pure tally light (render nothing unless active);
  // `fillWhenRecording` fills the whole box red instead of just coloring the
  // text; `showTimecode` appends the record duration (recording mode only).
  | {
      type: "obs-status";
      mode?: "recording" | "streaming" | "virtualcam";
      recordingText?: string;
      idleText?: string;
      offlineText?: string;
      showTimecode?: boolean;
      hideWhenIdle?: boolean;
      fillWhenRecording?: boolean;
    }
  // "Is anything recording?" — one indicator across every recorder, so a layout does
  // not need to know whether the campus records on OBS or REAPER. `source: "any"`
  // is red when EITHER is recording. The device-specific obs-status/reaper-status
  // objects remain for when you want exactly one machine.
  | {
      type: "record-status";
      source?: "any" | "obs" | "reaper";
      recordingText?: string;
      idleText?: string;
      offlineText?: string;
      hideWhenIdle?: boolean;
      fillWhenRecording?: boolean;
    }
  // Live REAPER recording indicator (from the REAPER integration, `reaper:status`
  // channel). Turns red while REAPER is recording. Label texts override the
  // defaults ("REAPER: Recording" / "REAPER: Standby" / "REAPER: Offline");
  // `hideWhenIdle` makes it a pure tally light (render nothing unless recording);
  // `fillWhenRecording` fills the whole box red instead of just coloring the text;
  // `showPosition` appends REAPER's transport position while recording.
  | {
      type: "reaper-status";
      recordingText?: string;
      idleText?: string;
      offlineText?: string;
      showPosition?: boolean;
      hideWhenIdle?: boolean;
      fillWhenRecording?: boolean;
    }
  // A RossTalk control button. Tapping it (on a real display / operator surface,
  // never in the editor) fires `commandId` with `params` at `targetId`, or `raw`
  // when no catalogue command is chosen. No feedback bind: RossTalk is send-only,
  // so a button is a trigger and never an indicator.
  | {
      type: "rosstalk-button";
      targetId: string | null;
      commandId: string | null;
      params: Record<string, string | number>;
      label: string;
      raw?: string;
    }
  // An OSC control button. Tapping it (on a real display / operator surface, never
  // in the editor) sends `address` + `args` to the chosen OSC target. `feedback`
  // optionally lights the button from incoming OSC. Send-only if no feedback bind.
  | {
      type: "osc-button";
      targetId?: string | null;
      label?: string;
      address: string;
      args?: OscArg[];
      feedback?: OscFeedbackBind | null;
    }
  | { type: "shape"; shape: "rect" | "ellipse" }
  // A connection-status light for any integration, driven by the
  // "integrations:state-changed" channel. `integrationId` selects which (null =
  // first). Dot color reflects the live connection (green/amber/red/gray);
  // `label` overrides the integration's friendly name.
  | {
      type: "integration-status";
      integrationId?: string | null;
      label?: string;
      showLabel?: boolean;
    }
  // A compact wireless fleet summary computed from all configured connections'
  // channels: `showOnline` → "online/total", `showBattery` → the lowest live
  // battery % (colored). Optional `label` prefix when `showLabel`.
  | {
      type: "wireless-summary";
      showOnline?: boolean;
      showBattery?: boolean;
      label?: string;
      showLabel?: boolean;
    }
  // A focused single wireless channel readout (e.g. a "Pastor's mic" tile). `channelId`
  // is the namespaced device channel; `show` toggles which metrics appear. Reads the
  // same live wireless data as the slots/summary.
  | {
      type: "wireless-channel";
      channelId?: string | null;
      show?: { rf?: boolean; battery?: boolean; frequency?: boolean; audio?: boolean };
      showLabel?: boolean;
    }
  // A live people count from the SenSource Vea integration ("people:count"
  // channel). `metric` picks attendance (Σins today) or occupancy (in-room now);
  // `zoneId` null = building total, else a single zone. Optional `label` shown
  // when `showLabel`.
  | {
      type: "people-counter";
      // attendance (Σins) / occupancy (in-room now) resolve per-zone or building;
      // peak/min/avg (today, from the space endpoint) are building-only.
      metric?: "attendance" | "serviceAttendance" | "occupancy" | "peak" | "min" | "avg";
      zoneId?: string | null;
      label?: string;
      showLabel?: boolean;
    }
  // The current PCO service order as a full list. Highlights the live item and
  // shows each item's notes (e.g. vocal parts). `noteCategories`: null = all
  // present, [] = none, [..] = chosen. `scroll`: "auto" keeps the live item in
  // view; "static" renders in place. Reuses the cached plan-items pipeline.
  | {
      type: "service-order";
      noteCategories?: string[] | null;
      showLength?: boolean;
      highlightLive?: boolean;
      scroll?: "auto" | "static";
      /** Shrink the text so the whole order fits the object height (no scroll). */
      autoFit?: boolean;
    }
  // A trend sparkline of the building-total people count over the rolling
  // in-memory history (people:count `history`). `metric` picks attendance or
  // occupancy; optional `label` + current value shown when `showLabel`.
  | {
      type: "people-graph";
      metric?: "attendance" | "occupancy";
      label?: string;
      showLabel?: boolean;
      source?: "live" | "recorded";
      recordedServiceKey?: string | null;
      showMarkers?: boolean;
      showTooltip?: boolean;
      kioskToggle?: boolean;
    }
  // A multi-metric people summary — several building-wide counts side by side,
  // each toggleable. `metrics` is the ordered set shown. avgService is the mean
  // peak occupancy across recorded services (from Attendance history).
  | {
      type: "people-panel";
      metrics?: ("occupancy" | "peak" | "attendance" | "serviceAttendance" | "min" | "avg" | "avgService" | "capacity" | "vsAverage")[];
      showLabels?: boolean;
      orientation?: "row" | "column";
    }
  // A readout from the baptism timer (operator stopwatch). `field` picks what to
  // show: the live phase + running clock, or a session stat. Self-contained — no
  // integration required.
  | {
      type: "baptism-timer";
      field?: "live" | "count" | "total" | "average" | "last";
      label?: string;
      showLabel?: boolean;
    }
  // A styled box that holds other objects. Children are positioned as fractions
  // of THIS container's box (not the canvas), so moving/resizing the container
  // moves/scales its contents as a unit. The box itself is drawn from `style`
  // (background/border/radius/padding) — same fields as any other object.
  | { type: "container" };

export type LayoutObjectType = LayoutObjectConfig["type"];

export interface LayoutObject {
  id: string;
  /** Position/size as fractions of the PARENT (the canvas for top-level objects,
   *  or the containing container's box for nested children) — all 0..1. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Paint order WITHIN the object's sibling scope; higher = front. */
  z: number;
  hidden?: boolean;
  /** When true, the editor won't move/resize/reparent/delete this object — and,
   *  for a container, anything nested inside it — until it's unlocked. */
  locked?: boolean;
  style?: LayoutStyle;
  config: LayoutObjectConfig;
  /** Nested objects, positioned relative to this object's box. Only meaningful
   *  for `container` objects; absent/empty for leaf objects. */
  children?: LayoutObject[];
}

export interface LayoutDTO {
  /** Schema version — bump when the shape changes so old layouts can migrate. */
  version: 1;
  canvas: LayoutCanvas;
  objects: LayoutObject[];
}

/** A named, reusable custom layout — saved to a library, applied to any custom View. */
export interface LayoutTemplate {
  id: string;
  name: string;
  layout: LayoutDTO;
  createdAt: string;
}

/** A named, reusable single object (typically a container + its children) that can
 *  be inserted into any custom View — a "group" in the editor. */
export interface LayoutGroup {
  id: string;
  name: string;
  object: LayoutObject;
  createdAt: string;
}

/** A physical screen at a URL slug, routed to exactly one View (or none). */
export interface Output {
  /** Permanent. Never rewritten after creation — slots.json and every other store
   *  is keyed by this, and Pis/bookmarks/QR codes point at `/<id>`. */
  id: string;
  name: string;
  /** Optional friendly URL. `/<id>` always resolves; when this is set, `/<slug>`
   *  resolves to the same display. Never used as a storage key, so clearing it
   *  cannot orphan anything. Validated against RESERVED_SLUGS on save. */
  slug?: string;
  /** The View this screen currently shows, or null when unrouted (renders a placeholder). */
  viewId: string | null;
  /** When true, this screen renders a full black "blackout" regardless of its
   *  routed View. Toggling it off restores the View instantly. */
  blackout?: boolean;
  /** When true, this display's top bar hides its nav escape hatches (QR/settings +
   *  home logo) so a handed-out link can't navigate away from the display. */
  locked?: boolean;
}

/** Per-output render descriptor so the kiosk needs no client-side joins. */
export interface ResolvedOutput {
  viewId: string | null;
  kind: ViewKind;
  ndiSource: string | null;
  viewName: string | null;
  blackout: boolean;
  locked: boolean;
}

/**
 * Live PCO countdown (pushed on "pco:live"). Mirrors PCO's green timer, which
 * always counts DOWN: to the service start before service ("preservice"), then
 * each item's length while live ("item"). "none" = nothing to count down to.
 */
export interface PcoLiveDTO {
  mode: "item" | "preservice" | "none";
  /** Stable PCO item id of the current live item ("item" mode) — keys SPL recording. */
  currentItemId: string | null;
  /** Item title ("item") or service label ("preservice"). */
  label: string | null;
  /** PCO item_type of the live item ("song" | "header" | "media" | "item"), so
   *  recorders can tag what was playing without re-fetching the plan. */
  itemType?: string | null;
  /** Item's planned length in seconds ("item" mode). */
  lengthSec: number | null;
  /** ISO timestamp the current item went live — countdown anchor ("item" mode). */
  liveStartAt: string | null;
  /** ISO timestamp to count down to — the service start ("preservice" mode). */
  targetAt: string | null;
  /** Server clock at send time (ISO) so the client can correct for skew. */
  serverNow: string;
  /** Current item title from the PCO PLAN order (authoritative), or null. */
  currentItemTitle: string | null;
  /** Next non-header item title from the PCO PLAN order, or null. */
  nextItemTitle: string | null;
  /** PCO "service" plan_time id for this occurrence (9am vs 11am) — keys SPL recording. */
  serviceTimeId: string | null;
  /** ISO start of the chosen service occurrence (also the preservice target). */
  serviceTimeStartsAt: string | null;
  /** True once the live controller has reached the plan's "SERVICE END" marker —
   *  the service is over (recording should finalize) even though an item is still
   *  "live". Only set when the plan has an explicit end header. */
  serviceEnded?: boolean;
  /** True while the current live item is ABOVE the plan's "SERVICE START" header —
   *  a pre-service item (doors, pre-roll). Position-based, so early/late starts
   *  don't misclassify it. Only set when the plan has a start header. */
  beforeServiceStart?: boolean;
}

/** Live ProPresenter status (pushed on "propresenter:status"). */
export interface ProPresenterStatusDTO {
  connected: boolean;
  /** Active presentation name (the simple dashboard's "current item"). */
  currentItem: string | null;
  /** Next slide's text (the simple dashboard's "next item"). */
  nextItem: string | null;
  /** 1-based index of the current slide within the active presentation. */
  slideIndex: number | null;
  slideCount: number | null;
  slidesRemaining: number | null;
  // ── Stage-display extras ──
  /** Current/next slide text content. */
  currentSlideText: string | null;
  nextSlideText: string | null;
  /** Per-slide notes (often chords, e.g. "Gb"). */
  currentNotes: string | null;
  nextNotes: string | null;
  /** Section of the current slide, the next slide, and the next *different* section. */
  currentSection: ProSection | null;
  nextSection: ProSection | null;
  nextArrangementSection: ProSection | null;
  /** Current + next playlist (service) item names. */
  currentServiceItem: string | null;
  nextServiceItem: string | null;
  /** Running named timers (state ≠ "stopped"). */
  timers: ProTimer[];
  /** "<activeUuid>:<index>" — changes on slide change so the preview <img> refetches. */
  slidePreviewKey: string | null;
}

/** Metadata for one configured ProPresenter instance (id + display name). */
export interface PropInstanceMeta {
  id: string;
  name: string;
}

/** Live connection state for one instance, mirroring an integration card's badge
 *  (connected / connecting / error / disconnected) plus an optional detail message. */
export interface PropInstanceConn {
  state: ConnectionState;
  message: string | null;
}

/** All ProPresenter instances + their latest status, keyed by id. The primary
 *  instance is always present as id "default". Broadcast on "propresenter:instances". */
export interface PropInstancesDTO {
  list: PropInstanceMeta[];
  status: Record<string, ProPresenterStatusDTO>;
  /** Per-instance reachability, keyed by id — drives the settings status line. */
  conn: Record<string, PropInstanceConn>;
}

/** One Smaart SPL meter (a calibrated device/channel) and its latest values. */
export interface SplMeterDTO {
  deviceName: string;
  channelName: string;
  /** Latest metric values, keyed exactly as Smaart names them (e.g. "SPL A Slow"). */
  metrics: Record<string, number>;
  /** ISO timestamp of the latest reading, or null before any reading. */
  ts: string | null;
}

/** Live SPL state (pushed on "spl:metrics"). `meters` is keyed "device::channel". */
export interface SplMetricsDTO {
  connected: boolean;
  /** Negotiated Smaart API version ("3", "4", …) or null when offline. */
  apiVersion: string | null;
  meters: Record<string, SplMeterDTO>;
}

/** Live OBS Studio output state (pushed on "obs:status"). `connected` is the
 *  obs-websocket link; the rest reflect OBS's outputs. v1 surfaces recording for
 *  the layout object, but streaming/virtual-cam are carried for future objects. */
export interface ObsStatusDTO {
  connected: boolean;
  recording: boolean;
  recordPaused: boolean;
  streaming: boolean;
  virtualCam: boolean;
  /** "HH:MM:SS" record duration while recording, else null. */
  recordTimecode: string | null;
}

/** Live REAPER transport state (pushed on "reaper:status"). `connected` is the
 *  web-interface HTTP link; the rest reflect REAPER's transport. v1 surfaces
 *  recording for the layout object. */
export interface ReaperStatusDTO {
  connected: boolean;
  recording: boolean;
  recordPaused: boolean;
  playing: boolean;
  /** Transport position in seconds, or null when unknown. */
  positionSeconds: number | null;
  /** REAPER's position string (e.g. "0:02.123"), or null. */
  positionString: string | null;
}

/** Live people counts from the SenSource Vea integration (pushed on
 *  "people:count"). Counts are polled (SenSource has no real-time endpoint) and
 *  computed from today's traffic: attendance = Σins, occupancy = Σins − Σouts
 *  (clamped ≥0). `zones` is the per-zone breakdown; `total` sums the selected
 *  zones. `null` numbers mean "no data yet". */
export interface PeopleZoneCount {
  id: string;
  name: string;
  attendance: number;
  occupancy: number;
}
/** One sampled point of building-total counts, for the trend sparkline. */
export interface PeopleHistoryPoint {
  /** ISO timestamp of the sample. */
  t: string;
  attendance: number;
  occupancy: number;
}
export interface PeopleCountDTO {
  connected: boolean;
  /** ISO timestamp of the last successful poll, or null. */
  updatedAt: string | null;
  total: {
    attendance: number | null;
    occupancy: number | null;
    /** Today's peak/lowest/mean occupancy (from the authoritative space endpoint;
     *  null when no space exists — building-wide only, not per-zone). */
    peak?: number | null;
    min?: number | null;
    avg?: number | null;
    /** Configured max capacity across the space(s) — for the % of capacity metric. */
    capacity?: number | null;
  };
  zones: PeopleZoneCount[];
  /** Rolling building-total samples (oldest→newest) for the people-graph object.
   *  In-memory only — resets when the server restarts. */
  history?: PeopleHistoryPoint[];
}

/** Running max/mean of one Smaart metric over an item (e.g. "LAeq 10"). */
export interface SplMetricStat {
  max: number | null;
  /** Arithmetic mean of the dB readings. WRONG for sound levels — decibels are
   *  logarithmic, so this understates a dynamic passage by 8-15 dB. Kept only so
   *  records made before `leq` existed still load; never displayed or exported.
   *  @deprecated use `leq`. */
  avg: number | null;
  /** Equivalent continuous level (energy average) across the samples — the
   *  correct way to combine dB. Absent on records made before this existed. */
  leq?: number | null;
  count: number;
}

/** Per-item recorded SPL across one service. */
export interface SplItemHistory {
  itemId: string;
  title: string;
  /** Order within the service (incrementing as items go live). */
  sequence: number;
  /**
   * Per-metric max/mean for EVERY metric the meter reported (peak, LAeq, LCeq, …),
   * keyed by Smaart metric name. The History tab chooses which to surface.
   */
  metrics: Record<string, SplMetricStat>;
  /** Legacy single-metric peak (dB) — kept populated for back-compat reads. */
  maxSpl: number | null;
  /** Legacy single-metric arithmetic mean (dB). @deprecated see SplMetricStat.avg. */
  avgSpl: number | null;
  /** Legacy single-metric energy average (dB). Absent on older records. */
  leqSpl?: number | null;
  /** PCO item_type ("song" | "header" | "media" | "item") when it was known at
   *  record time. Absent on records made before this was captured, so a song
   *  cannot be identified in older history. */
  itemType?: string | null;
  sampleCount: number;
  startedAt: string;
  endedAt: string | null;
}

/** SPL recording for one service occurrence, keyed by serviceKey. */
export interface ServiceSplHistory {
  /** `${serviceTypeId}:${planId}:${serviceTimeId ?? YYYY-MM-DD}`. */
  serviceKey: string;
  serviceTypeId: string | null;
  /** PCO service-type name (e.g. "Weekend", "The Salt Company") — labels the
   *  History service-type filter. Absent on records made before this was added. */
  serviceTypeName?: string | null;
  planId: string | null;
  planTitle: string | null;
  seriesTitle: string | null;
  /** Local date the recording started (YYYY-MM-DD). */
  serviceDate: string;
  /** PCO "service" plan_time id for this occurrence (null when unknown). */
  serviceTimeId: string | null;
  /** ISO start of this service occurrence (for the title, e.g. "9:00 AM"). */
  serviceTimeStartsAt: string | null;
  /** Which Smaart meter the levels were recorded from. */
  meterId: string | null;
  /** Legacy "primary" metric key (first preferred) — for back-compat display. */
  metricKey: string | null;
  startedAt: string;
  endedAt: string | null;
  items: SplItemHistory[];
}

/** One sampled point of building-total people counts during a service. */
export interface AttendanceSample {
  /** ISO timestamp of the sample. */
  t: string;
  attendance: number;
  occupancy: number;
  /** "pre" = arrivals sampled before the service began, "post" = the room emptying
   *  after it ended. Omitted = in-service — only these feed Peak/Lowest/Avg so the
   *  ramp-up and taper tails don't skew the stats (they still draw on the curve). */
  phase?: "pre" | "post";
}

/** Recorded attendance/occupancy trend for one service occurrence, keyed by
 *  serviceKey (same scheme as ServiceSplHistory). */
export interface ServiceAttendance {
  /** `${serviceTypeId}:${planId}:${serviceTimeId ?? YYYY-MM-DD}`. */
  serviceKey: string;
  serviceTypeId: string | null;
  /** PCO service-type name (e.g. "Weekend", "The Salt Company") — labels the
   *  History service-type filter. Absent on records made before this was added. */
  serviceTypeName?: string | null;
  planId: string | null;
  planTitle: string | null;
  seriesTitle: string | null;
  /** Local date the recording started (YYYY-MM-DD). */
  serviceDate: string;
  serviceTimeId: string | null;
  serviceTimeStartsAt: string | null;
  /** When recording began — may be BEFORE the service (pre-service arrival ramp). */
  startedAt: string;
  /** First in-service sample (the service proper began). Null while only pre-service
   *  samples exist; may differ from `startedAt`. Absent on pre-taper legacy records. */
  serviceStartedAt?: string | null;
  /** When the service ended (the taper boundary). Post-service samples continue past
   *  this during the cooldown window. */
  endedAt: string | null;
  /** Down-sampled samples across the service (oldest→newest). `attendance` is
   *  PER-SERVICE (baselined — see attendanceBaseline), so a second service in the
   *  same plan starts its curve at 0 instead of inheriting the first service's count. */
  samples: AttendanceSample[];
  /** Raw cumulative attendance (SenSource Σ-entries, a running daily total) captured
   *  when this record's first sample landed. Per-service attendance = raw − baseline.
   *  null until the first sample. */
  attendanceBaseline: number | null;
  /** Latest raw cumulative attendance = the building's running total across ALL of
   *  the day's services (kept alongside the per-service figure). */
  totalAttendance: number;
  /** Peak PER-SERVICE attendance (baselined). */
  peakAttendance: number;
  peakOccupancy: number;
  /** Lowest in-room occupancy seen while the service was live (the service
   *  "floor"). null until the first tick — NOT 0, so an empty-room moment during
   *  the service still reads 0 rather than being masked by a 0 initializer. */
  minOccupancy: number | null;
  /** Most recent sampled values (for the summary row). */
  lastAttendance: number;
  lastOccupancy: number;
}

/** One plan item's planned-vs-actual timing within a recorded service. */
export interface ServiceTimelineItem {
  itemId: string;
  title: string;
  sequence: number;
  /** Planned length from PCO (seconds), or null if unset. Snapshotted at record time. */
  plannedLengthSec: number | null;
  /** ISO when the item went live (PCO live_start_at, else first seen). */
  startedAt: string;
  /** ISO when the next item went live / the service ended (null while live). */
  endedAt: string | null;
  /** Actual elapsed seconds (endedAt − startedAt), null while still live. */
  actualDurationSec: number | null;
  /** Auto: item was above the plan's SERVICE START header when recorded (pre-service).
   *  Drives the default "not counted" state. Absent on older records. */
  preService?: boolean;
  /** User override for whether this item counts toward the service timers. When set,
   *  it wins over the auto (buffer/pre-service) default; absent = use the default. */
  counted?: boolean;
}

/** Recorded ACTUAL service rundown timing for one occurrence — when each item
 *  really went live and how long it ran vs its planned length. Captured from PCO
 *  Live independent of Smaart/SPL. Keyed like the SPL + attendance records, so the
 *  three line up per service occurrence. Late-start and per-item overrun are
 *  derived from these fields (not stored). */
export interface ServiceTimeline {
  /** `${serviceTypeId}:${planId}:${serviceTimeId ?? YYYY-MM-DD}`. */
  serviceKey: string;
  serviceTypeId: string | null;
  /** PCO service-type name (e.g. "Weekend", "The Salt Company") — labels the
   *  History service-type filter. Absent on records made before this was added. */
  serviceTypeName?: string | null;
  planId: string | null;
  planTitle: string | null;
  seriesTitle: string | null;
  /** Local date the recording started (YYYY-MM-DD). */
  serviceDate: string;
  serviceTimeId: string | null;
  /** Scheduled service start (PCO service-time occurrence). */
  serviceTimeStartsAt: string | null;
  /** ISO when recording began (first live item seen). */
  startedAt: string;
  /** ISO when recording ended / service finalized. */
  endedAt: string | null;
  items: ServiceTimelineItem[];
}

// ── Baptism timer ───────────────────────────────────────────────────────────
// An operator stopwatch for baptism services: each person has a testimony phase
// then a baptism phase. Broadcast live on "baptism:state"; finished sessions are
// logged for review. Running elapsed is derived client-side from segmentStartedAt.

export type BaptismPhase = "idle" | "testimony" | "baptism";

/** "per-person": testimony→baptism for each person in turn. "grouped": time every
 *  testimony first, then every baptism (a separate testimony section + baptism section). */
export type BaptismMode = "per-person" | "grouped";

export interface BaptismPerson {
  /** Testimony duration (ms). */
  testimonyMs: number;
  /** Baptism duration (ms). */
  baptizeMs: number;
}

export interface BaptismState {
  /** Workflow: per-person vs grouped (all testimonies, then all baptisms). */
  mode: BaptismMode;
  phase: BaptismPhase;
  /** 1-based number of the person currently being timed (or about to start). */
  personNumber: number;
  /** Grouped baptism pass: 0-based index of the person currently being baptized. */
  baptismIndex: number;
  /** ISO when the current segment (testimony/baptism) started; null when idle. */
  segmentStartedAt: string | null;
  /** ISO when the session began; null before the first start. */
  sessionStartedAt: string | null;
  /** ISO when the session was finished (totals frozen); null while active. */
  finishedAt: string | null;
  /** Completed people (testimony + baptize splits). */
  people: BaptismPerson[];
  /** Testimony split captured for the in-progress person (set while in "baptism"). */
  pendingTestimonyMs: number | null;
  /** PCO service context snapshotted when the session started — names the session
   *  and lets Service History cross-link it. Null if no plan was active. */
  serviceTitle: string | null;
  serviceTypeId: string | null;
  planId: string | null;
}

/** A finished baptism session, kept for later review. */
export interface BaptismSession {
  id: string;
  startedAt: string;
  finishedAt: string;
  people: BaptismPerson[];
  /** Service/plan title active when the session started (for the label). */
  title: string | null;
  serviceTypeId: string | null;
  planId: string | null;
}

/** One of PCO's item row colors, from ServiceType.standard_item_types /
 *  custom_item_types. Standard entries match an item's `itemType`; custom entries
 *  match text CONTAINED in the title ("Items that include this text in the title
 *  will be highlighted"). */
export interface PcoItemTypeColor {
  /** "Header" / "Song" / "Media" for standard; the operator's text for custom. */
  name: string;
  /** "#rrggbb". PCO stores #ffffff to mean "no color". */
  color: string;
  custom: boolean;
}

export interface ServiceTypeDTO {
  id: string;
  name: string;
  /** Item row colors configured on this service type in PCO. */
  itemTypeColors?: PcoItemTypeColor[];
}

export interface PlanDTO {
  id: string;
  title: string;
  seriesTitle: string | null;
  sortDate: string | null;
  dates: string | null;
}

/** One line-item of a PCO plan (song / header / media / item). */
export interface PlanItemDTO {
  id: string;
  title: string;
  /** PCO item_type: "song" | "header" | "media" | "item". "header" = section row. */
  itemType: string;
  /** Planned length in seconds (0 when unset). */
  lengthSec: number;
  /** Order within the plan. */
  sequence: number;
  /** Per-note-category content (e.g. {"Audio": "...", "Vocals": "..."}). */
  notesByCategory: Record<string, string>;
  description: string | null;
  /** Song meta (present on "song" items): selected key, arrangement BPM + name. */
  songKey?: string | null;
  bpm?: number | null;
  arrangementName?: string | null;
  /** PCO service_position: "pre" | "during" | "post" (drives pre-service styling). */
  servicePosition?: string | null;
}

/** A plan's full rundown plus the ordered note-category column names. */
export interface PlanItemsDTO {
  planId: string | null;
  items: PlanItemDTO[];
  /** Ordered note-category names (the script columns: Audio, Band, MD, Vocals…). */
  noteCategories: string[];
}

/** A saved ScriptView layout — a named column preset (our in-app ScriptViewer
 *  replacement). GLOBAL: one set of layouts applies across every service type.
 *  Columns reference category ROLES, not names. Names are defined per service type and
 *  vary between them, so a name-based column rendered empty wherever that service type
 *  used a different word for the same thing. A role whose members are all absent is
 *  hidden instead. */
export interface ScriptViewLayout {
  id: string;
  name: string;
  order: number;
  /** @deprecated Ordered note-category NAMES. Migrated to `columnRoles` on load and
   *  kept only so an unmigrated file still parses. Category names vary per service
   *  type, which is why columns reference roles now. */
  columns?: string[];
  /** Ordered role ids shown as columns. See CategoryRole. */
  columnRoles?: string[];
  // Per-element visibility toggles (undefined = shown; opt-out by setting false).
  showClock?: boolean;        // projected wall-clock column
  showLength?: boolean;       // length / "Time" column
  showKey?: boolean;          // song key in the title meta line
  showBpm?: boolean;          // BPM in the title meta line
  showArrangement?: boolean;  // arrangement name in the title meta line
  showItemNotes?: boolean;    // description line (leader / cues) under the title
  showTotalTime?: boolean;    // total-time footer
  /** What colors this layout's rows. Absent = "pco", so a layout saved before this
   *  existed keeps the behavior it had. */
  rowColor?: "pco" | "category" | "none";
  /** @deprecated Category NAME that tinted the row. Migrated to `accentRole`. */
  accentDepartment?: string | null;
  /** Role whose presence tints a row, used only when rowColor === "category". */
  accentRole?: string | null;
}

/** ScriptView-wide config: which PCO service types appear on the landing page
 *  (ordered). Empty = fall back to types that have layouts. */
export interface ScriptViewConfig {
  serviceTypeIds: string[];
}

/** The resolved rundown for a ScriptView page: the chosen plan's items + columns,
 *  plus whether this service type is the one currently running live. */
export interface ScriptViewRundownDTO {
  serviceTypeId: string;
  planId: string | null;
  planTitle: string | null;
  planSeriesTitle: string | null;
  planDates: string | null;
  items: PlanItemDTO[];
  noteCategories: string[];
  /** Item row colors for this rundown's service type (see PcoItemTypeColor). */
  itemTypeColors?: PcoItemTypeColor[];
  /** Scheduled service start time(s), ISO (from PCO plan_times type=service).
   *  serviceTimes[0] anchors the projected per-item clock. */
  serviceTimes: string[];
  /** Org IANA time zone for rendering the clock in the plan's local time. */
  timeZone: string | null;
  /** True when this is the app's currently-selected plan, so the live pcoLive
   *  feed applies to it. Actual "live" (badge/highlight) additionally requires
   *  pcoLive.mode === "item" — this flag alone does NOT mean a service is running. */
  isActivePlan: boolean;
}

/** A file attached to a PCO plan (e.g. a stage plot, chart, or rundown PDF). */
export interface PcoAttachmentDTO {
  id: string;
  filename: string;
  /** MIME type reported by PCO (e.g. "application/pdf"), or null. */
  contentType: string | null;
  fileSizeBytes: number | null;
  /** PCO-generated preview image URL, when available. */
  thumbnailUrl: string | null;
  /** PCO display ordering, when present. */
  pageOrder: number | null;
  /** Where the file is attached — "Plan file", "Service type", "Song chart", etc.
   *  (from the attachment's attachable type), for disambiguation in the picker. */
  sourceLabel: string | null;
}

export interface TeamMemberDTO {
  id: string;
  name: string;
  personId: string | null;
  photoUrl: string | null;
  teamPositionName: string | null;
  teamName: string | null;
  status: string;
  notes: string | null;
}

export interface TeamPositionDTO {
  teamId: string;
  teamName: string;
  positionName: string;
}

/** One position a slot will accept, with an optional note filter scoped to it.
 *  `name` omitted = any position (the note is then the only constraint). An entry
 *  with neither is a misconfiguration and never matches — see slot-resolver. */
export interface SlotPositionMatch {
  name?: string;
  notesStartsWith?: string;
}

export type SlotLink =
  | { kind: "pco"; matchBy: "person"; personId: string }
  // A range: the first listed position with someone available fills the slot. A
  // per-position note pins that entry to one person (e.g. Vocals note "4").
  | { kind: "pco"; matchBy: "position"; positions: SlotPositionMatch[] }
  | { kind: "static"; label: string; color: string }
  | { kind: "empty" }
  // A horizontal gap used to align slot columns with physical chargers. Occupies
  // width (see Slot.widthIn). Renders nothing unless `showEmptyImage` is set, in
  // which case the empty-slot logo is centered in the gap.
  /** `showEmptyImage` is no longer read — a spacer is a gap and nothing else. Kept
   *  on the type so slots saved with it still load. */
  | { kind: "spacer"; showEmptyImage?: boolean };

export interface SlotDevice {
  status: "none" | "ok" | "warn" | "error";
  rf: number | null;
  battery: number | null;
  freq: string | null;
  audioLevel: number | null;
  /** Resolved level for the charge bar, from the slot's chargeSource: the bound
   *  mic's battery, a chosen SBC charger bay, or null (off / no source). */
  charge: number | null;
  /** Resolved battery for a second device (e.g. a vocalist's IEM/PSM pack),
   *  shown as a second bar beneath the primary. Null when no IEM is bound. */
  iemCharge: number | null;
  /** Static label for the primary device when it has no live telemetry — i.e. an
   *  OFFLINE/manual device (a networkless PSM/mic) or a per-slot label override.
   *  Shown as text with no bars. Null for live devices. */
  label: string | null;
  /** Static label for the second (IEM) device when offline/manual, shown with a
   *  headphones icon and no bar. Null for live or unbound IEMs. */
  iemLabel: string | null;
}

export interface Slot {
  id: string;
  channel: string;
  order: number;
  link: SlotLink;
  deviceBinding?: { providerId: string; channelId: string } | null;
  /** Where the charge bar reads its level: "mic" = the bound device's battery
   *  (default), "charger" = the SBC bay in `chargeBayId`, "off" = no charge bar. */
  chargeSource?: "mic" | "charger" | "off";
  /** ChargerBay id (connectionId::bay) when chargeSource === "charger". */
  chargeBayId?: string | null;
  /** Hide the RF bars on this slot and show only the charge bar. */
  hideRf?: boolean;
  /** Optional second device whose battery shows as a second bar beneath the
   *  primary charge bar — e.g. a vocalist who also wears an IEM/PSM pack. */
  iemBinding?: { providerId: string; channelId: string } | null;
  /** Optional custom label override for the primary (mic) device, shown when it's
   *  an offline/manual device with no telemetry. Defaults to the device's name. */
  deviceLabel?: string | null;
  /** Optional custom label override for the IEM device (offline/manual). Defaults
   *  to the device's name. */
  iemLabel?: string | null;
  displayName?: string | null;
  /** Which of a position range's names the resolved person is actually scheduled
   *  for. A slot may accept "EG Ghost or EG Shadow"; the cell should name only what
   *  this person is really doing. Absent on non-position slots. */
  shownPositions?: string[];
  photoUrl?: string | null;
  device: SlotDevice;
  /** When true, this slot stacks into the SAME on-screen column as the previous
   *  slot (in order), forming a multi-row column. Used to mirror dual-bay
   *  chargers where two people share one charger footprint. */
  stackWithPrevious?: boolean;
  /** Width in inches for this column, used only when the View has a `slotsLayout`
   *  (physical alignment). Required for a "spacer" slot; an optional per-column
   *  override on a column's lead slot (defaults to slotsLayout.columnWidthIn). */
  widthIn?: number;
}

export interface SlotPreset {
  id: string;
  name: string;
  slots: Slot[];
  createdAt: string;
}

export interface StageState {
  serviceTypeId: string | null;
  serviceTypeName: string | null;
  planMode: "auto" | "manual";
  planId: string | null;
  planTitle: string | null;
  planSeriesTitle: string | null;

  // ── Views/Outputs model (canonical) ──────────────────────────────────
  /** All content definitions. */
  views: View[];
  /** All physical screens and their routing. */
  outputs: Output[];
  /** Resolved slots keyed by View id (for slots-kind Views). Drives both the
   *  kiosk (via the output's routed view) and the settings editor/preview. */
  slotsByView: Record<string, Slot[]>;
  /** Resolved slots for inline mic-slots objects, keyed by the layout object's id
   *  (a custom-layout `slots-grid` with `source: "inline"`). */
  slotsByLayoutObject: Record<string, Slot[]>;
  /** Per-output render descriptor (output id → routed view's kind/ndi/name). */
  resolvedByOutput: Record<string, ResolvedOutput>;

  // ── Compat shim (computed from outputs + views) ──────────────────────
  /** @deprecated Primary output's resolved slots (legacy phone control page). */
  slots: Slot[];
  /** @deprecated Resolved slots keyed by OUTPUT id (== slotsByView of its routed view). */
  slotsByDisplay: Record<string, Slot[]>;
  /** @deprecated Each output joined with its routed view's kind/ndiSource. */
  displays: DisplayInfo[];

  pcoConfigured: boolean;
  lastRefreshedAt: string | null;
  remoteUrl: string | null;
  /** Raw LAN IP URL (http://<ip>:<port>) for the Companion panel; Companion can't
   *  resolve DNS, so this is shown regardless of publicUrl. */
  lanUrl: string | null;
  showQr: boolean;
  /** Allowlisted service type IDs for auto mode. Empty array = all allowed. */
  allowedServiceTypeIds: string[];
  /** Customizable brand name shown in the sidebar header and on the kiosk. */
  appName: string;
  /** Themeable brand accent (#rrggbb), or null to use the built-in default. */
  accentColor: string | null;
  /** Customizable brand logo as a data URL (PNG/JPG/SVG/WebP), or null. */
  appLogo: string | null;
  /** Recolor a single-color logo to match the theme. */
  appLogoMonochrome: boolean;
  /** Image centered in empty slots on the kiosk (recolored to the kiosk gray). */
  emptySlotLogo: string | null;
  /** Avatar shown for matched people with no PCO photo (recolored like a silhouette);
   *  null = use the built-in person icon. */
  defaultAvatar: string | null;
  /** Show NDI-related controls in settings (off by default; native client only). */
  ndiEnabled: boolean;
  /** Public base URL (DNS) for the connect QR + display links; null = LAN IP. */
  publicUrl: string | null;
  /** Icon tint per display id or tool path (e.g. "display-1", "/baptism"), as
   *  "#rrggbb". One map covers the Displays cards, the Connect tool cards and the
   *  picker tiles, so a color set anywhere shows everywhere that item appears. */
  iconColors?: Record<string, string>;
  /** User-assigned caption colors, keyed by ProdCom channel label. */
  captionChannelColors: Record<string, string>;
  /** Live battery bays from any Shure SBC charger connections. */
  chargerBays: ChargerBayDTO[];
  /** Automatic-update schedule (in-app self-update). */
  autoUpdate: AutoUpdateSettings;
  reconnectSchedule: ReconnectSchedule;
  /** Attendance ramp/taper capture windows (Advanced tab). */
  taperWindow: TaperWindow;
  /** Operator dismissed the first-run "Getting started" checklist (machine-wide). */
  onboardingDismissed: boolean;
}

/** One battery bay of a Shure SBC charger (derived from charger-kind devices). */
export interface ChargerBayDTO {
  /** Stable id = the namespaced device channelId (connectionId::bay). */
  id: string;
  /** Charger connection id (the part before "::"). */
  connectionId: string;
  /** 1-based bay number within its charger. */
  bay: number;
  /** 1-based index of this charger among charger connections (for default labels). */
  chargerIndex: number;
  /** The charger connection's user-set name (e.g. "SBC-220-03"), for unambiguous
   *  bay labels that map to the physical unit. Null if not resolvable. */
  connectionName: string | null;
  /** Device-reported battery/bay name, if any. */
  name: string | null;
  /** A battery is docked in the bay. */
  online: boolean;
  battery: number | null;
  charging: boolean | null;
  cycles: number | null;
  health: number | null;
  tempC: number | null;
}

/** Scheduled auto-update config. When enabled, the server applies an available
 *  update during the weekly window (skipping while a PCO service is live). */
/**
 * How updates are applied.
 *   manual       — operator checks, applies and restarts by hand
 *   auto-install — apply automatically in the window, but WAIT for an operator
 *                  to restart (the new build sits ready; nothing interrupts)
 *   auto-full    — apply and restart in the window (the original behavior)
 */
export type UpdateMode = "manual" | "auto-install" | "auto-full";

export interface AutoUpdateSettings {
  mode: UpdateMode;
  /** @deprecated Pre-mode boolean, read once to migrate. true -> auto-full. */
  enabled?: boolean;
  /** Day of week 0–6 (Sun–Sat), or null for any day. */
  dayOfWeek: number | null;
  /** Hour of day 0–23 (local time) the update window opens. */
  hour: number;
}

/** Minutes to keep sampling attendance/occupancy around a service so the graphs
 *  show the room filling before and emptying after (Advanced tab). 0 = off. */
export interface TaperWindow {
  /** Sample the arrival ramp this many minutes before the service start. */
  preMin: number;
  /** Keep sampling the emptying room this many minutes after the service ends. */
  postMin: number;
}

/** Tunables for time-aware integration reconnects (Advanced tab). */
export interface ReconnectSchedule {
  /** When on, reconnect cadence follows PCO rehearsal/service times. */
  enabled: boolean;
  /** Ramp up this many minutes before a rehearsal/service start. */
  leadMin: number;
  /** Stay active this many minutes after a service ends. */
  tailMin: number;
  /** Max minutes between retries when far from any service. */
  dormantMin: number;
}

/** In-app update status (git-based), surfaced in the Advanced tab. */
export interface UpdateStatus {
  /** False when this isn't a git checkout (or git is unavailable) — update via CLI. */
  isGitRepo: boolean;
  branch: string | null;
  /** Selectable update tracks (git branches) the operator can switch between. */
  tracks: string[];
  /** App version from package.json. */
  version: string;
  /** Short SHA + ISO commit date of the running checkout. */
  currentSha: string | null;
  currentDate: string | null;
  /** Commits the local branch is behind its upstream. */
  behind: number;
  latestSha: string | null;
  latestDate: string | null;
  /** Commit subjects between current and latest (newest first), capped. */
  changelog: string[];
  lastCheckedAt: string | null;
  /** "idle" normally; "checking" during a fetch; "updating" while the script runs. */
  phase: "idle" | "checking" | "updating";
  /** Sub-phase while `phase==="updating"`, for the progress bar. Null otherwise. */
  step: "pull" | "install" | "build" | "restarting" | null;
  /** A build has been installed but the process is still running the old code —
   *  set by an auto-install update that deferred its restart. */
  restartPending: boolean;
  /** Outcome of the most recent apply (read from the updater's result file). */
  lastResult: { ok: boolean; finishedAt: string; log: string | null } | null;
  /** Non-null when the last check failed (e.g. no network). */
  error: string | null;
}

// ── Stage patch sheet (see docs/patch-sheet/DESIGN.md) ───────────────────────
export type PatchDeviceKind = "rack" | "snake" | "drop-snake" | "pocket" | "wireless" | "array" | "other";

/** A physical device that carries channels (SD rack, snake, pocket, RF bank, …). */
export interface PatchDevice {
  id: string;
  name: string;
  kind: PatchDeviceKind;
  inputs: number;
  outputs: number;
  /** Optional custom connector labels; default = "1".."N" (supports "B-1", "S11", …). */
  inLabels?: string[];
  outLabels?: string[];
  /** Optional color ("#rrggbb") to tint every channel sourced from this device. */
  color?: string;
}

/** One hop in a signal path: a specific connector on a device. */
export interface PatchHop {
  deviceId: string;
  connector: string;
}

/** One console endpoint on a rack — the spine of the patch. */
export interface PatchEndpoint {
  rackId: string;
  dir: "in" | "out";
  index: number;
  consoleChannel?: string;
  /** Source (in) / destination (out) name. */
  label?: string;
  /** Input metadata. */
  mic?: string;
  phantom?: boolean;
  /** Output metadata: "IEM" | "wedge" | "amp" | "stream" | "record" | … */
  feedType?: string;
  /** Ordered upstream (in) / downstream (out) hops; empty/absent = direct. */
  path?: PatchHop[];
  unused?: boolean;
  notes?: string;
  /** Optional ownership/section tag (e.g. "338 @ FOH") — groups channels under a
   *  subheading, mirroring the ownership bands on a Dante patch sheet. */
  owner?: string;
  /** HOOK: link a vocal/RF endpoint to a mic-board channel (feature later). */
  micSlotRef?: string | null;
  /** HOOK: PCO team position tag for scheduling suggestions (feature later). */
  pcoPosition?: string | null;
}

/** A named overlay of endpoint overrides on the default patch (template == event). */
export interface PatchVariant {
  id: string;
  name: string;
  /** key = `${rackId}:${dir}:${index}`; value = only the changed fields. */
  overrides: Record<string, Partial<PatchEndpoint>>;
}

export interface PatchAssignments {
  /** Standing variant per PCO service type. */
  byServiceType: Record<string, string>;
  /** Per specific PCO plan: override variant + one-off week tweaks. */
  byPlan: Record<string, { variantId?: string; tweaks?: Record<string, Partial<PatchEndpoint>> }>;
}

/** What kind of patch a sheet documents — drives labels/cosmetics only. */
export type PatchSheetKind = "analog" | "dante" | "network" | "monitor" | "custom";

/** One patch surface (a tab): its own devices, default endpoints, variants, and
 *  weekly assignments. Analog stage patch, Dante, Waves SoundGrid, monitors, etc.
 *  each are a sheet of this same shape. */
export interface PatchSheet {
  id: string;
  name: string;
  kind: PatchSheetKind;
  devices: PatchDevice[];
  /** The DEFAULT patch for this sheet (source of truth). */
  endpoints: PatchEndpoint[];
  variants: PatchVariant[];
  assignments: PatchAssignments;
}

export interface PatchFile {
  /** All patch sheets (tabs). At least one; the first is the default view. */
  sheets: PatchSheet[];
  updatedAt: string;
}
