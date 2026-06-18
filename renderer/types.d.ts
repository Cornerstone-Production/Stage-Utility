// Shared types mirroring the backend contract exactly.
// Used for typed invoke<T>() calls in the renderer.

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

interface ConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "select" | "ip-list";
  options?: { value: string; label: string }[];
  placeholder?: string;
}

interface IntegrationDescriptor {
  id: string;
  kind: "lineup" | "wireless" | "control";
  label: string;
  configSchema: ConfigField[];
}

interface IntegrationState {
  id: string;
  enabled: boolean;
  connection: ConnectionState;
  message: string | null;
  config: Record<string, unknown>;
}

interface DeviceStatus {
  channelId: string;
  name: string | null;
  deviceType: string;
  online: boolean;
  rfBars: number | null;
  rfLevelDbm: number | null;
  battery: number | null;
  charging: boolean | null;
  frequencyLabel: string | null;
  audioLevel: number | null;
  updatedAt: string;
}

interface ServiceTypeDTO {
  id: string;
  name: string;
}

interface PlanDTO {
  id: string;
  title: string;
  seriesTitle: string | null;
  sortDate: string | null;
  dates: string | null;
}

interface PcoAttachmentDTO {
  id: string;
  filename: string;
  contentType: string | null;
  fileSizeBytes: number | null;
  thumbnailUrl: string | null;
  pageOrder: number | null;
  sourceLabel: string | null;
}

interface TeamMemberDTO {
  id: string;
  name: string;
  personId: string | null;
  photoUrl: string | null;
  teamPositionName: string | null;
  teamName: string | null;
  status: string;
  notes: string | null;
}

interface TeamPositionDTO {
  teamId: string;
  teamName: string;
  positionName: string;
}

type SlotLink =
  | { kind: "pco"; matchBy: "person"; personId: string }
  | { kind: "pco"; matchBy: "position"; teamPositionName: string; notesStartsWith?: string }
  | { kind: "static"; label: string; color: string }
  | { kind: "empty" }
  | { kind: "spacer" };

interface SlotDevice {
  status: "none" | "ok" | "warn" | "error";
  rf: number | null;
  battery: number | null;
  freq: string | null;
  audioLevel: number | null;
}

interface Slot {
  id: string;
  channel: string;
  order: number;
  link: SlotLink;
  deviceBinding?: { providerId: string; channelId: string } | null;
  displayName?: string | null;
  photoUrl?: string | null;
  device: SlotDevice;
  /** When true, stacks into the same on-screen column as the previous slot. */
  stackWithPrevious?: boolean;
  /** Column width in inches (used only when the View has a slotsLayout). */
  widthIn?: number;
}

type ViewKind = "slots" | "dashboard" | "stage" | "transcription" | "custom";
/** @deprecated alias for ViewKind. */
type DisplayKind = ViewKind;

/** A named, reusable content definition (decoupled from any screen). */
interface View {
  id: string;
  name: string;
  kind: ViewKind;
  ndiSource?: string | null;
  createdAt: string;
  /** Free-form layout for kind === "custom". */
  layout?: LayoutDTO | null;
  /** Physical-alignment config for a slots-View (inches); absent → equal widths. */
  slotsLayout?: SlotsLayout | null;
}

interface SlotsLayout {
  displayWidthIn: number;
  columnWidthIn: number;
}

// ── Visual layout schema (kind === "custom") ──
interface LayoutCanvas {
  width: number;
  height: number;
  background?: string | null;
}

type LayoutHAlign = "left" | "center" | "right";
type LayoutVAlign = "top" | "middle" | "bottom";

interface LayoutStyle {
  fontSize?: number; // fraction of canvas height
  fontWeight?: number;
  italic?: boolean;
  uppercase?: boolean;
  letterSpacing?: number; // em
  color?: string;
  textAlign?: LayoutHAlign;
  vAlign?: LayoutVAlign;
  background?: string | null;
  opacity?: number;
  cornerRadius?: number; // fraction of canvas height
  padding?: number; // fraction of canvas height
  borderColor?: string | null;
  borderWidth?: number; // fraction of canvas height
  textShadow?: number; // 0..1
  lineClamp?: number | null;
}

type LayoutObjectConfig =
  | { type: "text"; text: string }
  | { type: "clock"; showSeconds?: boolean; format?: "12h" | "24h"; showMeridiem?: boolean }
  | { type: "countdown-timer" }
  | { type: "current-slide-text" }
  | { type: "next-slide-text" }
  | { type: "current-slide-notes" }
  | { type: "slide-thumbnail" }
  | { type: "section-chip"; which: "current" | "next" | "nextArrangement" }
  | { type: "slots-grid"; sourceViewId?: string | null }
  | { type: "transcript-strip"; mode: "latest" | "rolling"; maxLines?: number }
  | { type: "brand-logo"; useEmptySlotLogo?: boolean }
  | { type: "ndi-video" }
  | { type: "image"; src: string }
  | {
      type: "plan-attachment";
      match?: string;
      page?: number;
      crop?: { top: number; right: number; bottom: number; left: number };
      trim?: boolean;
      background?: "keep" | "black" | "transparent";
    }
  | { type: "shape"; shape: "rect" | "ellipse" };

type LayoutObjectType = LayoutObjectConfig["type"];

interface LayoutObject {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  hidden?: boolean;
  style?: LayoutStyle;
  config: LayoutObjectConfig;
}

interface LayoutDTO {
  version: 1;
  canvas: LayoutCanvas;
  objects: LayoutObject[];
}

/** A named, reusable custom layout (library). */
interface LayoutTemplate {
  id: string;
  name: string;
  layout: LayoutDTO;
  createdAt: string;
}

/** A physical screen at a URL slug, routed to exactly one View (or none). */
interface Output {
  id: string;
  name: string;
  viewId: string | null;
}

/** Per-output render descriptor (output id → routed view's kind/ndi/name). */
interface ResolvedOutput {
  viewId: string | null;
  kind: ViewKind;
  ndiSource: string | null;
  viewName: string | null;
}

/** A live transcript line from ProdCom (SSE "prodcom:transcript"). */
interface TranscriptLineDTO {
  id: string;
  channel: string | null;
  channelName: string | null;
  text: string;
  isFinal: boolean;
  at: string;
}

interface DisplayInfo {
  id: string;
  name: string;
  /** Defaults to "slots" when absent. */
  kind?: DisplayKind;
  /** NDI source name to show as a video layer (native Apple client only); null/absent = none. */
  ndiSource?: string | null;
}

interface ProSection {
  name: string;
  colorHex: string;
}

interface ProTimer {
  name: string;
  time: string;
  state: string;
}

/** Live PCO countdown (SSE "pco:live") — always counts down (preservice → item). */
interface PcoLiveDTO {
  mode: "item" | "preservice" | "none";
  label: string | null;
  lengthSec: number | null;
  liveStartAt: string | null;
  targetAt: string | null;
  serverNow: string;
}

/** Live ProPresenter status (SSE "propresenter:status"). */
interface ProPresenterStatusDTO {
  connected: boolean;
  currentItem: string | null;
  nextItem: string | null;
  slideIndex: number | null;
  slideCount: number | null;
  slidesRemaining: number | null;
  currentSlideText: string | null;
  nextSlideText: string | null;
  currentNotes: string | null;
  nextNotes: string | null;
  currentSection: ProSection | null;
  nextSection: ProSection | null;
  nextArrangementSection: ProSection | null;
  currentServiceItem: string | null;
  nextServiceItem: string | null;
  timers: ProTimer[];
  slidePreviewKey: string | null;
}

interface StageState {
  serviceTypeId: string | null;
  serviceTypeName: string | null;
  planMode: "auto" | "manual";
  planId: string | null;
  planTitle: string | null;
  planSeriesTitle: string | null;

  // ── Views/Outputs model (canonical) ──
  /** All content definitions. */
  views: View[];
  /** All physical screens and their routing. */
  outputs: Output[];
  /** Resolved slots keyed by View id (slots-kind Views). */
  slotsByView: Record<string, Slot[]>;
  /** Per-output render descriptor (output id → routed view's kind/ndi/name). */
  resolvedByOutput: Record<string, ResolvedOutput>;

  // ── Compat shim (computed from outputs + views) ──
  /** @deprecated primary output's resolved slots. */
  slots: Slot[];
  /** @deprecated each output joined with its routed view's kind/ndiSource. */
  displays: DisplayInfo[];
  /** @deprecated resolved slots keyed by OUTPUT id. */
  slotsByDisplay: Record<string, Slot[]>;
  pcoConfigured: boolean;
  lastRefreshedAt: string | null;
  remoteUrl: string | null;
  showQr: boolean;
  /** Allowlist of service type ids that Auto plan-mode follows and manual picker shows.
   *  Empty array means all types are allowed. */
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

/** Editor source for a brand image (original upload + saved crop transform). */
interface BrandingSource {
  original: string | null;
  crop: { scale: number; x: number; y: number } | null;
}

interface SlotPreset {
  id: string;
  name: string;
  slots: Slot[];
  createdAt: string;
}

interface WirelessConnection {
  id: string;
  name: string;
  providerId: string;
  enabled: boolean;
  connection: ConnectionState;
  message: string | null;
  config: Record<string, unknown>;
}
