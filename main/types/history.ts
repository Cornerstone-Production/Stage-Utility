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
  /** Service-level Leq per Smaart metric key, with the samples behind it. */
  metrics: Record<string, { leq: number; count: number }>;
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
  /** User override for whether this item counts toward the service timers. When set,
   *  it wins over the auto (buffer/pre-service) default; absent = use the default. */
  counted?: boolean;
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
  /** ISO when recording began (first live item seen). */
  startedAt: string;
  /** ISO when recording ended / service finalized. */
  endedAt: string | null;
  items: ServiceTimelineItem[];
}
