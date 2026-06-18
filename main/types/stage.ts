// Shared stage types — frontend mirrors these shapes exactly.

/**
 * What a View renders: slot grid (default), dashboard, stage, transcription, or
 * a "custom" free-form layout authored with the visual editor (see {@link LayoutDTO}).
 */
export type ViewKind = "slots" | "dashboard" | "stage" | "transcription" | "custom";

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
  | { type: "current-slide-notes" }
  | { type: "slide-thumbnail" }
  | { type: "section-chip"; which: "current" | "next" | "nextArrangement" }
  | { type: "slots-grid"; sourceViewId?: string | null } // embed a slots-View's grid
  | { type: "transcript-strip"; mode: "latest" | "rolling"; maxLines?: number }
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
  | { type: "shape"; shape: "rect" | "ellipse" };

export type LayoutObjectType = LayoutObjectConfig["type"];

export interface LayoutObject {
  id: string;
  /** Position/size as fractions of the canvas (0..1). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Paint order; higher = front. */
  z: number;
  hidden?: boolean;
  style?: LayoutStyle;
  config: LayoutObjectConfig;
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

/** A physical screen at a URL slug, routed to exactly one View (or none). */
export interface Output {
  id: string;
  name: string;
  /** The View this screen currently shows, or null when unrouted (renders a placeholder). */
  viewId: string | null;
}

/** Per-output render descriptor so the kiosk needs no client-side joins. */
export interface ResolvedOutput {
  viewId: string | null;
  kind: ViewKind;
  ndiSource: string | null;
  viewName: string | null;
}

/**
 * Live PCO countdown (pushed on "pco:live"). Mirrors PCO's green timer, which
 * always counts DOWN: to the service start before service ("preservice"), then
 * each item's length while live ("item"). "none" = nothing to count down to.
 */
export interface PcoLiveDTO {
  mode: "item" | "preservice" | "none";
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
  // A horizontal gap used to align slot columns with physical chargers. Renders
  // nothing; only occupies width (see Slot.widthIn).
  | { kind: "spacer" };

export interface SlotDevice {
  status: "none" | "ok" | "warn" | "error";
  rf: number | null;
  battery: number | null;
  freq: string | null;
  audioLevel: number | null;
}

export interface Slot {
  id: string;
  channel: string;
  order: number;
  link: SlotLink;
  deviceBinding?: { providerId: string; channelId: string } | null;
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
}
