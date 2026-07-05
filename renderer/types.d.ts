// Shared types mirroring the backend contract exactly.
// Used for typed invoke<T>() calls in the renderer.

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

interface ConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "select" | "ip-list";
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
  default?: string | number;
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
  /** Operator has set this up (creds/config, or the master toggle for
   *  wireless/OSC). Independent of the live connection. */
  configured?: boolean;
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

interface SplMeterDTO {
  deviceName: string;
  channelName: string;
  metrics: Record<string, number>;
  ts: string | null;
}

interface SplMetricsDTO {
  connected: boolean;
  apiVersion: string | null;
  meters: Record<string, SplMeterDTO>;
}

interface ObsStatusDTO {
  connected: boolean;
  recording: boolean;
  recordPaused: boolean;
  streaming: boolean;
  virtualCam: boolean;
  recordTimecode: string | null;
}

interface OscArg {
  type: "i" | "f" | "s" | "T" | "F";
  value?: number | string;
}

interface OscFeedbackBind {
  address: string;
  equals?: number | string | boolean;
  activeColor?: string;
}

interface OscTarget {
  id: string;
  name: string;
  enabled: boolean;
  connection: ConnectionState;
  message: string | null;
  config: {
    host?: string;
    port?: number;
    subscribeAddress?: string;
    subscribeIntervalSec?: number;
  };
}

interface OscFeedbackDTO {
  values: Record<string, number | string | boolean>;
}

interface PeopleZoneCount {
  id: string;
  name: string;
  attendance: number;
  occupancy: number;
}
interface PeopleHistoryPoint {
  t: string;
  attendance: number;
  occupancy: number;
}
interface PeopleCountDTO {
  connected: boolean;
  updatedAt: string | null;
  total: {
    attendance: number | null;
    occupancy: number | null;
    peak?: number | null;
    min?: number | null;
    avg?: number | null;
    capacity?: number | null;
  };
  zones: PeopleZoneCount[];
  history?: PeopleHistoryPoint[];
}

interface SplMetricStat {
  max: number | null;
  avg: number | null;
  count: number;
}

interface SplItemHistory {
  itemId: string;
  title: string;
  sequence: number;
  metrics: Record<string, SplMetricStat>;
  maxSpl: number | null;
  avgSpl: number | null;
  sampleCount: number;
  startedAt: string;
  endedAt: string | null;
}

interface ServiceSplHistory {
  serviceKey: string;
  serviceTypeId: string | null;
  /** PCO service-type name — labels the History service-type filter. */
  serviceTypeName?: string | null;
  planId: string | null;
  planTitle: string | null;
  seriesTitle: string | null;
  serviceDate: string;
  serviceTimeId: string | null;
  serviceTimeStartsAt: string | null;
  meterId: string | null;
  metricKey: string | null;
  startedAt: string;
  endedAt: string | null;
  items: SplItemHistory[];
}

interface AttendanceSample {
  t: string;
  attendance: number;
  occupancy: number;
}
interface ServiceAttendance {
  serviceKey: string;
  serviceTypeId: string | null;
  /** PCO service-type name — labels the History service-type filter. */
  serviceTypeName?: string | null;
  planId: string | null;
  planTitle: string | null;
  seriesTitle: string | null;
  serviceDate: string;
  serviceTimeId: string | null;
  serviceTimeStartsAt: string | null;
  startedAt: string;
  endedAt: string | null;
  /** samples.attendance is PER-SERVICE (baselined) so a 2nd service in the same plan starts at 0. */
  samples: AttendanceSample[];
  /** Raw cumulative attendance at this record's first sample; per-service = raw − baseline. */
  attendanceBaseline: number | null;
  /** Latest raw cumulative attendance = running total across all of the day's services. */
  totalAttendance: number;
  peakAttendance: number;
  peakOccupancy: number;
  /** Lowest in-room occupancy seen while the service was live (the "floor"); null
   *  until the first tick. */
  minOccupancy: number | null;
  lastAttendance: number;
  lastOccupancy: number;
}
interface ServiceTimelineItem {
  itemId: string;
  title: string;
  sequence: number;
  plannedLengthSec: number | null;
  startedAt: string;
  endedAt: string | null;
  actualDurationSec: number | null;
  /** Auto: recorded above the plan's SERVICE START header (pre-service). */
  preService?: boolean;
  /** User override for counting this item toward the service timers. */
  counted?: boolean;
}
interface ServiceTimeline {
  serviceKey: string;
  serviceTypeId: string | null;
  /** PCO service-type name — labels the History service-type filter. */
  serviceTypeName?: string | null;
  planId: string | null;
  planTitle: string | null;
  seriesTitle: string | null;
  serviceDate: string;
  serviceTimeId: string | null;
  serviceTimeStartsAt: string | null;
  startedAt: string;
  endedAt: string | null;
  items: ServiceTimelineItem[];
}
type BaptismPhase = "idle" | "testimony" | "baptism";
type BaptismMode = "per-person" | "grouped";
interface BaptismPerson {
  testimonyMs: number;
  baptizeMs: number;
}
interface BaptismState {
  mode: BaptismMode;
  phase: BaptismPhase;
  personNumber: number;
  baptismIndex: number;
  segmentStartedAt: string | null;
  sessionStartedAt: string | null;
  finishedAt: string | null;
  people: BaptismPerson[];
  pendingTestimonyMs: number | null;
  serviceTitle: string | null;
  serviceTypeId: string | null;
  planId: string | null;
}
interface BaptismSession {
  id: string;
  startedAt: string;
  finishedAt: string;
  people: BaptismPerson[];
  title: string | null;
  serviceTypeId: string | null;
  planId: string | null;
}

interface ServiceTypeDTO {
  id: string;
  name: string;
}

interface PlanItemDTO {
  id: string;
  title: string;
  itemType: string;
  lengthSec: number;
  sequence: number;
  notesByCategory: Record<string, string>;
  description: string | null;
}

interface PlanItemsDTO {
  planId: string | null;
  items: PlanItemDTO[];
  noteCategories: string[];
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
  | { kind: "spacer"; showEmptyImage?: boolean };

interface SlotDevice {
  status: "none" | "ok" | "warn" | "error";
  rf: number | null;
  battery: number | null;
  freq: string | null;
  audioLevel: number | null;
  /** Resolved charge-bar level (mic battery, a charger bay, or null). */
  charge: number | null;
  /** Resolved battery for a second device (e.g. IEM/PSM pack), shown as a
   *  second bar beneath the primary. Null when no IEM is bound. */
  iemCharge: number | null;
  /** Static label for an offline/manual primary device (no telemetry), or a
   *  per-slot override. Shown as text, no bars. Null for live devices. */
  label: string | null;
  /** Static label for an offline/manual IEM device (headphones icon, no bar). */
  iemLabel: string | null;
}

interface Slot {
  id: string;
  channel: string;
  order: number;
  link: SlotLink;
  deviceBinding?: { providerId: string; channelId: string } | null;
  /** Charge-bar source: "mic" (bound device, default), "charger" (chargeBayId), "off". */
  chargeSource?: "mic" | "charger" | "off";
  /** ChargerBay id (connectionId::bay) when chargeSource === "charger". */
  chargeBayId?: string | null;
  /** Hide RF bars on this slot; show only the charge bar. */
  hideRf?: boolean;
  /** Optional second device (e.g. IEM/PSM pack) whose battery shows as a second bar. */
  iemBinding?: { providerId: string; channelId: string } | null;
  /** Optional custom label override for an offline/manual primary (mic) device. */
  deviceLabel?: string | null;
  /** Optional custom label override for an offline/manual IEM device. */
  iemLabel?: string | null;
  displayName?: string | null;
  photoUrl?: string | null;
  device: SlotDevice;
  /** When true, stacks into the same on-screen column as the previous slot. */
  stackWithPrevious?: boolean;
  /** Column width in inches (used only when the View has a slotsLayout). */
  widthIn?: number;
}

type ViewKind =
  | "slots"
  | "dashboard"
  | "stage"
  | "transcription"
  | "custom"
  | "script"
  | "spl-rundown";
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
  /** Show the PCO Live Prev/Next controls on a "script" View (default false). */
  showLiveControls?: boolean;
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
  fit?: "contain" | "fill";
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
  boxShadow?: number; // 0..1 box elevation
  lineClamp?: number | null;
}

type LayoutObjectConfig =
  | { type: "text"; text: string }
  | { type: "clock"; showSeconds?: boolean; format?: "12h" | "24h"; showMeridiem?: boolean }
  | { type: "countdown-timer"; hideWhenIdle?: boolean; warnSeconds?: number }
  | { type: "service-pacing"; scope?: "item" | "service"; hideWhenIdle?: boolean; showLabel?: boolean }
  | { type: "pp-timer"; timerName?: string | null; propresenterInstanceId?: string | null; warnStates?: boolean; hideWhenIdle?: boolean; showLabel?: boolean }
  | { type: "slide-progress"; propresenterInstanceId?: string | null; display?: "fraction" | "remaining" | "percent" | "bar"; showLabel?: boolean }
  | { type: "current-slide-text"; propresenterInstanceId?: string | null }
  | { type: "next-slide-text"; propresenterInstanceId?: string | null }
  | { type: "current-service-item"; propresenterInstanceId?: string | null }
  | { type: "next-service-item"; propresenterInstanceId?: string | null }
  | { type: "current-slide-notes"; propresenterInstanceId?: string | null }
  | { type: "slide-thumbnail"; propresenterInstanceId?: string | null }
  | { type: "section-chip"; which: "current" | "next" | "nextArrangement"; propresenterInstanceId?: string | null }
  | { type: "slots-grid"; source?: "view" | "inline"; sourceViewId?: string | null; slotsLayout?: SlotsLayout | null }
  | { type: "transcript-strip"; mode: "latest" | "rolling"; maxLines?: number; hideChannels?: string[] }
  | { type: "live-controls" }
  | {
      type: "charger-battery";
      bays: { id: string; label?: string }[];
      show: { battery?: boolean; charging?: boolean; cycles?: boolean; health?: boolean; temp?: boolean };
    }
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
  | {
      type: "spl-meter";
      meterId?: string | null;
      metricKey?: string | null;
      showLabel?: boolean;
      thresholds?: { amber: number; red: number } | null;
      peakHold?: boolean;
    }
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
  | {
      type: "osc-button";
      targetId?: string | null;
      label?: string;
      address: string;
      args?: OscArg[];
      feedback?: OscFeedbackBind | null;
    }
  | { type: "shape"; shape: "rect" | "ellipse" }
  | {
      type: "integration-status";
      integrationId?: string | null;
      label?: string;
      showLabel?: boolean;
    }
  | {
      type: "wireless-summary";
      showOnline?: boolean;
      showBattery?: boolean;
      label?: string;
      showLabel?: boolean;
    }
  | {
      type: "wireless-channel";
      channelId?: string | null;
      show?: { rf?: boolean; battery?: boolean; frequency?: boolean; audio?: boolean };
      showLabel?: boolean;
    }
  | {
      type: "people-counter";
      metric?: "attendance" | "serviceAttendance" | "occupancy" | "peak" | "min" | "avg";
      zoneId?: string | null;
      label?: string;
      showLabel?: boolean;
    }
  | {
      type: "people-graph";
      metric?: "attendance" | "occupancy";
      label?: string;
      showLabel?: boolean;
      /** "live" = real-time rolling window; "recorded" = a past service's curve. */
      source?: "live" | "recorded";
      /** Which recorded service to show (null = most recent) when source = recorded. */
      recordedServiceKey?: string | null;
      /** Overlay PCO plan-item markers (with times). */
      showMarkers?: boolean;
      /** Hover/tap tooltip showing the value + time at a point. */
      showTooltip?: boolean;
      /** Show an on-screen live/recorded toggle so a kiosk viewer can switch. */
      kioskToggle?: boolean;
    }
  | {
      type: "people-panel";
      metrics?: ("occupancy" | "peak" | "attendance" | "serviceAttendance" | "min" | "avg" | "avgService" | "capacity" | "vsAverage")[];
      showLabels?: boolean;
      orientation?: "row" | "column";
    }
  | {
      type: "baptism-timer";
      field?: "live" | "count" | "total" | "average" | "last";
      label?: string;
      showLabel?: boolean;
    }
  | {
      type: "service-order";
      noteCategories?: string[] | null;
      showLength?: boolean;
      highlightLive?: boolean;
      scroll?: "auto" | "static";
      autoFit?: boolean;
    }
  | { type: "container" };

type LayoutObjectType = LayoutObjectConfig["type"];

interface LayoutObject {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  hidden?: boolean;
  locked?: boolean;
  style?: LayoutStyle;
  config: LayoutObjectConfig;
  children?: LayoutObject[];
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

/** A named, reusable single object (container + children) — a "group". */
interface LayoutGroup {
  id: string;
  name: string;
  object: LayoutObject;
  createdAt: string;
}

/** A physical screen at a URL slug, routed to exactly one View (or none). */
interface Output {
  id: string;
  name: string;
  viewId: string | null;
  /** When true, the screen renders a full black blackout regardless of its View. */
  blackout?: boolean;
  /** When true, this display's top bar hides its nav escape hatches (QR/settings +
   *  home logo) so a handed-out link can't leave the display. */
  locked?: boolean;
}

/** Per-output render descriptor (output id → routed view's kind/ndi/name). */
interface ResolvedOutput {
  viewId: string | null;
  kind: ViewKind;
  ndiSource: string | null;
  viewName: string | null;
  blackout: boolean;
  locked: boolean;
}

/** A live transcript line from ProdCom (SSE "prodcom:transcript"). */
interface TranscriptLineDTO {
  id: string;
  channel: string | null;
  channelName: string | null;
  /** Per-channel color from ProdCom if provided; null → deterministic fallback. */
  color: string | null;
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
  currentItemId: string | null;
  label: string | null;
  lengthSec: number | null;
  liveStartAt: string | null;
  targetAt: string | null;
  serverNow: string;
  currentItemTitle: string | null;
  nextItemTitle: string | null;
  serviceTimeId: string | null;
  serviceTimeStartsAt: string | null;
  /** True once the live controller reached the plan's "SERVICE END" marker. */
  serviceEnded?: boolean;
  /** True while the current live item is above the plan's "SERVICE START" header. */
  beforeServiceStart?: boolean;
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

interface PropInstanceMeta {
  id: string;
  name: string;
}
interface PropInstanceConn {
  state: ConnectionState;
  message: string | null;
}
interface PropInstancesDTO {
  list: PropInstanceMeta[];
  status: Record<string, ProPresenterStatusDTO>;
  conn: Record<string, PropInstanceConn>;
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
  /** Resolved slots for inline mic-slots objects, keyed by layout object id. */
  slotsByLayoutObject: Record<string, Slot[]>;
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
  /** Raw LAN IP URL (http://<ip>:<port>) for the Companion panel; Companion can't
   *  resolve DNS, so this is shown regardless of publicUrl. */
  lanUrl: string | null;
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
  onboardingDismissed: boolean;
}

interface ChargerBayDTO {
  id: string;
  connectionId: string;
  bay: number;
  chargerIndex: number;
  /** The charger connection's user-set name (e.g. "SBC-220-03"), for bay labels. */
  connectionName: string | null;
  name: string | null;
  online: boolean;
  battery: number | null;
  charging: boolean | null;
  cycles: number | null;
  health: number | null;
  tempC: number | null;
}

interface AutoUpdateSettings {
  enabled: boolean;
  /** Day of week 0–6 (Sun–Sat), or null for any day. */
  dayOfWeek: number | null;
  /** Hour of day 0–23 (local time) the update window opens. */
  hour: number;
}

/** In-app update status (git-based), surfaced in the Advanced tab. */
interface UpdateStatus {
  tracks: string[];
  isGitRepo: boolean;
  branch: string | null;
  version: string;
  currentSha: string | null;
  currentDate: string | null;
  behind: number;
  latestSha: string | null;
  latestDate: string | null;
  changelog: string[];
  lastCheckedAt: string | null;
  phase: "idle" | "checking" | "updating";
  step: "pull" | "install" | "build" | "restarting" | null;
  lastResult: { ok: boolean; finishedAt: string; log: string | null } | null;
  error: string | null;
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
