// history.ts — Recorded service history.
//
// The three per-service records — SPL, attendance, timeline — that survive a
// restart, keyed alike so they line up per service occurrence.
//
// Split out of stage.ts, which had grown to 1,509 lines. Every name is still
// re-exported from stage.ts, so no import anywhere had to change.


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

/**
 * One service's SPL, reduced to a level per metric.
 *
 * The trend line needs one number per service, not every item of every service.
 * A year of weekly services is a few thousand per-item stat objects; this is one
 * row each, so the History chart and the Home tile can both read the whole
 * history without pulling the archive across the wire.
 *
 * `count` rides along per metric because the client combines rows further — the
 * trend plots one point per DATE, and two services on a Sunday morning combine
 * by the same energy weighting that built each of these in the first place.
 */
export interface SplServiceSummary {
  serviceKey: string;
  serviceTypeId: string | null;
  serviceTypeName?: string | null;
  serviceDate: string;
  /**
   * Null while the recording behind this summary is still running.
   *
   * NOT written once at the end: the recorder persists `current` on every live
   * tick (see spl-recorder.ts's schedulePersist), so a service still in
   * progress already has a summary here, and its Leq is a partial that will
   * keep climbing as more items are sung or spoken. The overview's average
   * has to know that on the SPL data's own terms — see overview-data.ts —
   * rather than by asking a different recorder (attendance) whether IT thinks
   * the occurrence is still live.
   */
  endedAt: string | null;
  /**
   * Per Smaart metric key: the service-level Leq, the samples behind it, and
   * the loudest single reading anywhere in the service.
   *
   * `max` exists so a caller asking "how loud did it PEAK" does not have to
   * pull the whole per-item record. The Trends chart plots one point per
   * recording across up to 52 weeks, and fetching every record for that is
   * hundreds of files to answer one number each — while this summary is
   * already loaded by every page that needs it.
   *
   * Either may be null: a legacy capture has maxima and no Leq. A metric with
   * NEITHER is left out entirely.
   */
  metrics: Record<string, { leq: number | null; max: number | null; count: number }>;
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
  /** The item this record opened with — see ServiceRecord.openingItemId in
   *  service-recorder.ts, which sets it for all three recorders alike. */
  openingItemId?: string | null;
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
  /** The item this record opened with — see ServiceRecord.openingItemId in
   *  service-recorder.ts, which sets it for all three recorders alike. Null
   *  while the record has only ever held pre-service samples with no item
   *  live yet (the arrival ramp can open a record before Doors does). */
  openingItemId?: string | null;
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
  /** Override for whether this item counts toward the service timers. When set,
   *  it wins over the auto (buffer/pre-service) default; absent = use the default.
   *
   *  TWO writers, which `countedByOperator` tells apart: the operator, through
   *  POST /api/history/item-counted, and the recorder, which writes `false` by
   *  itself for an item PCO had been showing live since before this record
   *  opened (see openItem). The second is an observation about one run and does
   *  not generalise; the first is a statement about the plan item. */
  counted?: boolean;
  /** True when `counted` was set by the operator rather than derived by the
   *  recorder. A rebuild carries an operator's override onto every run of the
   *  item — it is a statement about the PLAN item — but carries the recorder's
   *  own `counted: false` only back onto the run it was observed on, because a
   *  carried-over first run says nothing about a later one. Absent on records
   *  written before this was added; see rebuildTimelineRecord. */
  countedByOperator?: true;
  /** The recorded values an operator's time correction replaced. Set ONLY by
   *  applyItemTimeEdits, never persisted: the store holds the raw item plus the
   *  record's `itemTimeEdits`, and this is how a read tells the UI which rows are
   *  edited and what they used to say. */
  editedFrom?: {
    startedAt: string;
    endedAt: string | null;
    actualDurationSec: number | null;
  };
}

/** An operator's correction of ONE run of ONE item's recorded timing.
 *
 *  Kept beside the items rather than written into them: the items are raw
 *  observation that `rebuildTimelineRecord` re-derives from `events.csv`, so an
 *  edit written in would be silently undone by the next rebuild. See
 *  main/services/history-item-times.ts. */
export interface ServiceItemTimeEdit {
  itemId: string;
  /** Which RUN — the item's `sequence` in the record. An item can appear more
   *  than once (a reprise, or a mis-split second service). */
  sequence: number;
  /** ISO replacing the recorded start. Absent = that field is not overridden. */
  startedAt?: string;
  /** ISO replacing the recorded end. Absent = that field is not overridden. */
  endedAt?: string;
  /** ISO when the operator made the correction. */
  editedAt: string;
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
  /** The item this record opened with — see ServiceRecord.openingItemId in
   *  service-recorder.ts, which sets it for all three recorders alike. Kept
   *  here alongside `items[0].itemId`, which the same tick sets, because SPL
   *  and attendance don't have an ordered items list to read it back from. */
  openingItemId?: string | null;
  /** ISO when recording began (first live item seen). */
  startedAt: string;
  /** ISO when recording ended / service finalized. */
  endedAt: string | null;
  /** An operator reset of the pacing readout: items that started before this
   *  instant do not count toward pacing, and the live item's baseline moves
   *  forward to it. Never set by the recorder — only POST
   *  /api/service-timeline/current/reset-pacing sets it, and nothing clears it;
   *  a new record always starts null. */
  pacingResetAt?: string | null;
  items: ServiceTimelineItem[];
  /** Operator corrections to individual items' recorded timings, applied over
   *  `items` on every read (never into them). Absent on a record nobody has
   *  corrected. See main/services/history-item-times.ts. */
  itemTimeEdits?: ServiceItemTimeEdit[];
}
