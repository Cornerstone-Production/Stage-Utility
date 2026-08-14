// pco.ts — Planning Center, ScriptView and slots.
//
// Plans, items, teams and attachments as PCO returns them, plus the two things
// built on top: ScriptView layouts and the slot model the stage display fills.
//
// Split out of stage.ts, which had grown to 1,509 lines. Every name is still
// re-exported from stage.ts, so no import anywhere had to change.


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
  /** True for a plan that has already happened. Set when the manual picker's list
   *  is built, so the UI does not have to re-derive it against the clock. */
  past?: boolean;
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
  /** Per-item peak SPL column. OFF by default — it is only meaningful with Smaart
   *  connected, and an always-on "—" column wastes width on most layouts. This is
   *  what the `script` View-kind used to render unconditionally; making it a
   *  preset toggle is what let that View-kind stop being a second rundown. */
  showMaxSpl?: boolean;
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
  /** Live audio level, **normalised 0–1**. Receivers report this on different
   *  scales (Shure against its own dB range, Sennheiser raw), so it is coerced to
   *  one unit in slot-resolver.ts — never assume it is dB. */
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
