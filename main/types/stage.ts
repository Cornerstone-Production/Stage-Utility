// Shared stage types — frontend mirrors these shapes exactly.

export interface DisplayInfo {
  id: string;
  name: string;
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
