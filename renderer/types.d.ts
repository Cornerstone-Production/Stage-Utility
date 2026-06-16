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
  | { kind: "empty" };

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
}

type DisplayKind = "slots" | "dashboard" | "stage" | "transcription";

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
  slots: Slot[];
  /** Multi-display: list of configured displays (primary is index 0) */
  displays: DisplayInfo[];
  /** Multi-display: slots keyed by display id */
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
