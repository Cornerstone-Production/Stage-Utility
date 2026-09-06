// live.ts — Live integration DTOs.
//
// What each integration is reporting right now: PCO Live, ProPresenter, Smaart,
// OBS, REAPER, SenSource. Every one of these is a snapshot broadcast on the SSE
// stream, never persisted.
//
// Split out of stage.ts, which had grown to 1,509 lines. Every name is still
// re-exported from stage.ts, so no import anywhere had to change.


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
  /** Start time per plan item, so the automation engine's pure triggers can tell
   *  when an item is due without reaching for the PCO client. PCO puts no time on
   *  an Item, so each entry is either EXACT (a plan_time named after the item) or
   *  derived from summed item lengths — `exact` says which, and derived times
   *  drift once a service runs long. See automation-item-schedule.ts. */
  itemSchedule?: { title: string; dueAt: string; exact: boolean }[];
  /** True once the live controller has reached the plan's "SERVICE END" marker —
   *  the service is over (recording should finalize) even though an item is still
   *  "live". Only set when the plan has an explicit end header. */
  serviceEnded?: boolean;
  /** True while the current live item is ABOVE the plan's "SERVICE START" header —
   *  a pre-service item (doors, pre-roll). Position-based, so early/late starts
   *  don't misclassify it. Only set when the plan has a start header. */
  beforeServiceStart?: boolean;
  /** Every rehearsal + service time on the active plan, for time-relative triggers
   *  ("an hour before rehearsal"). Sourced from the already-cached plan times, so
   *  it costs no extra request, and carried in EVERY mode — a trigger that only
   *  worked while a service was live could never fire an hour beforehand. */
  planTimes?: PlanTimeDTO[];
}

/** One published Companion signal.
 *
 *  `error` sits ALONGSIDE the value rather than replacing it: a failed evaluation
 *  records why without clearing a working route, because a scheduling mistake must
 *  not take talkback off mid-service. */
export interface SignalState {
  value: string;
  at: string;
  ruleId: string | null;
  error: string | null;
}

/** One of a plan's scheduled times, as the automation engine sees it. */
export interface PlanTimeDTO {
  id: string;
  name: string | null;
  /** PCO's `time_type`: "service" or "rehearsal" (others are filtered out). */
  timeType: string;
  startsAt: string;
}

/**
 * The published-snapshot version every StatusIntegration stamps on what it sends.
 *
 * A status hook hydrates with a one-shot read and subscribes to a change-driven
 * channel. When a push landed before the read resolved, the older read overwrote
 * the newer push, and — because these channels broadcast only on change — the
 * wrong value then stuck until the next real change. `rev` is bumped only when a
 * frame actually goes out, and both the hydrate read (`getLatest()`) and the
 * pushed frame carry it, so a client can drop a read that is older than a push it
 * already applied.
 *
 * Optional, and additive on purpose: it is a field an existing consumer that has
 * never heard of it simply does not read. Nothing else about these payloads moved.
 * A client that sees no `rev` behaves exactly as it did before.
 */
export interface RevisionedStatus {
  /** Monotonic per integration, from 0. Comparable only within one channel and
   *  one server run — it resets when the process restarts. */
  rev?: number;
}

/** Live ProPresenter status (pushed on "propresenter:status"). */
export interface ProPresenterStatusDTO extends RevisionedStatus {
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
export interface SplMetricsDTO extends RevisionedStatus {
  connected: boolean;
  /** Negotiated Smaart API version ("3", "4", …) or null when offline. */
  apiVersion: string | null;
  meters: Record<string, SplMeterDTO>;
}

/** Live OBS Studio output state (pushed on "obs:status"). `connected` is the
 *  obs-websocket link; the rest reflect OBS's outputs. v1 surfaces recording for
 *  the layout object, but streaming/virtual-cam are carried for future objects. */
export interface ObsStatusDTO extends RevisionedStatus {
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
export interface ReaperStatusDTO extends RevisionedStatus {
  connected: boolean;
  recording: boolean;
  recordPaused: boolean;
  playing: boolean;
  /** Transport position in seconds, or null when unknown. */
  positionSeconds: number | null;
  /** REAPER's position string (e.g. "0:02.123"), or null. */
  positionString: string | null;
}

/**
 * Live state of one streaming platform (pushed on "resi:status" / "youtube:status").
 *
 * `connected` is the link to the platform's API; `live` is whether it is
 * actually broadcasting. The two are separate for the same reason they are on
 * the recorders: "we cannot reach Resi" and "Resi is not streaming" are
 * different problems and only one of them is yours to fix mid-service.
 *
 * `startedAt` is null when a platform says it is live without saying since
 * when. Resi's encoder payload may not carry a start time at all, in which case
 * the service supplies the moment it FIRST observed the stream, persisted so a
 * restart mid-service does not reset the clock. A null here means the elapsed
 * time is genuinely unknown, and the surfaces show the state without a duration
 * rather than inventing 0:00.
 */
export interface StreamStatusDTO extends RevisionedStatus {
  connected: boolean;
  live: boolean;
  startedAt: string | null;
  /** What it is streaming — the encoder or broadcast name, for the sub-line.
   *  Why a platform is UNREACHABLE is not here: that is the integration's
   *  connection state, reported once on the Integrations page rather than
   *  twice in two shapes. */
  detail: string | null;
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
export interface PeopleCountDTO extends RevisionedStatus {
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
    /** True when peak/min/avg/capacity are the last good values carried forward
     *  because the day-aggregate request is failing, rather than this poll's.
     *  Absent means they are current (or, on a site with no space, absent). */
    dayAggregatesStale?: boolean;
  };
  zones: PeopleZoneCount[];
  /** Rolling building-total samples (oldest→newest) for the people-graph object.
   *  In-memory only — resets when the server restarts. */
  history?: PeopleHistoryPoint[];
}

/** Running max/mean of one Smaart metric over an item (e.g. "LAeq 10"). */
