// Shared stage types — frontend mirrors these shapes exactly.

import type { OscArg, OscFeedbackBind } from "./osc.js";

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
  lineClamp?: number | null;
}

/** Per-type configuration. The discriminant is `type`. */
export type LayoutObjectConfig =
  | { type: "text"; text: string }
  | { type: "clock"; showSeconds?: boolean; format?: "12h" | "24h"; showMeridiem?: boolean }
  | { type: "countdown-timer" } // PCO Live
  | { type: "current-slide-text" }
  | { type: "next-slide-text" }
  | { type: "current-service-item" }
  | { type: "next-service-item" }
  | { type: "current-slide-notes" }
  | { type: "slide-thumbnail" }
  | { type: "section-chip"; which: "current" | "next" | "nextArrangement" }
  // Mic-slots grid. `source: "view"` embeds an existing slots-View's grid by
  // `sourceViewId`; `source: "inline"` defines its own slot set, stored per service
  // type keyed by this object's id (resolved into `StageState.slotsByLayoutObject`),
  // with `slotsLayout` holding its physical-inch alignment. Missing `source` ==
  // "view" (back-compat with existing objects).
  | { type: "slots-grid"; source?: "view" | "inline"; sourceViewId?: string | null; slotsLayout?: SlotsLayout | null }
  | { type: "transcript-strip"; mode: "latest" | "rolling"; maxLines?: number }
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
    }
  // Live OBS recording indicator (from the OBS integration, `StageState`-adjacent
  // `obs:status` channel). Turns red while recording. The label texts default to
  // "OBS: Recording" / "OBS: Standby" / "OBS: Offline". `hideWhenIdle` makes it a
  // pure tally light (render nothing unless recording); `fillWhenRecording` fills
  // the whole box red instead of just coloring the text; `showTimecode` appends
  // the record duration.
  | {
      type: "obs-status";
      recordingText?: string;
      idleText?: string;
      offlineText?: string;
      showTimecode?: boolean;
      hideWhenIdle?: boolean;
      fillWhenRecording?: boolean;
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
  // A live people count from the SenSource Vea integration ("people:count"
  // channel). `metric` picks attendance (Σins today) or occupancy (in-room now);
  // `zoneId` null = building total, else a single zone. Optional `label` shown
  // when `showLabel`.
  | {
      type: "people-counter";
      metric?: "attendance" | "occupancy";
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
  id: string;
  name: string;
  /** The View this screen currently shows, or null when unrouted (renders a placeholder). */
  viewId: string | null;
  /** When true, this screen renders a full black "blackout" regardless of its
   *  routed View. Toggling it off restores the View instantly. */
  blackout?: boolean;
}

/** Per-output render descriptor so the kiosk needs no client-side joins. */
export interface ResolvedOutput {
  viewId: string | null;
  kind: ViewKind;
  ndiSource: string | null;
  viewName: string | null;
  blackout: boolean;
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
export interface PeopleCountDTO {
  connected: boolean;
  /** ISO timestamp of the last successful poll, or null. */
  updatedAt: string | null;
  total: { attendance: number | null; occupancy: number | null };
  zones: PeopleZoneCount[];
}

/** Running max/mean of one Smaart metric over an item (e.g. "LAeq 10"). */
export interface SplMetricStat {
  max: number | null;
  avg: number | null;
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
  /** Legacy single-metric running mean (dB) — kept populated for back-compat reads. */
  avgSpl: number | null;
  sampleCount: number;
  startedAt: string;
  endedAt: string | null;
}

/** SPL recording for one service occurrence, keyed by serviceKey. */
export interface ServiceSplHistory {
  /** `${serviceTypeId}:${planId}:${serviceTimeId ?? YYYY-MM-DD}`. */
  serviceKey: string;
  serviceTypeId: string | null;
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

export interface ServiceTypeDTO {
  id: string;
  name: string;
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
}

/** A plan's full rundown plus the ordered note-category column names. */
export interface PlanItemsDTO {
  planId: string | null;
  items: PlanItemDTO[];
  /** Ordered note-category names (the script columns: Audio, Band, MD, Vocals…). */
  noteCategories: string[];
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

export type SlotLink =
  | { kind: "pco"; matchBy: "person"; personId: string }
  | { kind: "pco"; matchBy: "position"; teamPositionName: string; notesStartsWith?: string }
  | { kind: "static"; label: string; color: string }
  | { kind: "empty" }
  // A horizontal gap used to align slot columns with physical chargers. Occupies
  // width (see Slot.widthIn). Renders nothing unless `showEmptyImage` is set, in
  // which case the empty-slot logo is centered in the gap.
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
  displayName?: string | null;
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
  /** User-assigned caption colors, keyed by ProdCom channel label. */
  captionChannelColors: Record<string, string>;
  /** Live battery bays from any Shure SBC charger connections. */
  chargerBays: ChargerBayDTO[];
  /** Automatic-update schedule (in-app self-update). */
  autoUpdate: AutoUpdateSettings;
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
export interface AutoUpdateSettings {
  enabled: boolean;
  /** Day of week 0–6 (Sun–Sat), or null for any day. */
  dayOfWeek: number | null;
  /** Hour of day 0–23 (local time) the update window opens. */
  hour: number;
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
  /** Outcome of the most recent apply (read from the updater's result file). */
  lastResult: { ok: boolean; finishedAt: string; log: string | null } | null;
  /** Non-null when the last check failed (e.g. no network). */
  error: string | null;
}
