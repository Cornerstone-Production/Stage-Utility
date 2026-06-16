// Shared stage types — frontend mirrors these shapes exactly.

/** What a display renders: slot grid (default), tech dashboard, or stage display. */
export type DisplayKind = "slots" | "dashboard" | "stage";

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

export interface DisplayInfo {
  id: string;
  name: string;
  /** Defaults to "slots" when absent (back-compat with older settings). */
  kind?: DisplayKind;
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
  | { kind: "empty" };

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
  /** Primary display's resolved slots (backward-compat for phone control page). */
  slots: Slot[];
  /** Resolved slots keyed by displayId. */
  slotsByDisplay: Record<string, Slot[]>;
  /** All configured displays. */
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
