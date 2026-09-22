// baptism.ts — Baptism timer.
//
// State for the baptism timer and the plan-item triggers that start it.
//
// Split out of stage.ts, which had grown to 1,509 lines. Every name is still
// re-exported from stage.ts, so no import anywhere had to change.


// ── Baptism timer ───────────────────────────────────────────────────────────
// An operator stopwatch for baptism services: each person has a testimony phase
// then a baptism phase. Broadcast live on "baptism:state"; finished sessions are
// logged for review. Running elapsed is derived client-side from segmentStartedAt.

export type BaptismPhase = "idle" | "testimony" | "baptism";

/** "per-person": testimony→baptism for each person in turn. "grouped": time every
 *  testimony first, then every baptism (a separate testimony section + baptism section). */
export type BaptismMode = "per-person" | "grouped";

export interface BaptismPerson {
  /** Testimony duration (ms). */
  testimonyMs: number;
  /** Baptism duration (ms). */
  baptizeMs: number;
}

export interface BaptismState {
  /** Service occurrence captured when the session started; carried onto the record
   *  so a baptism belongs to one service rather than to whatever it overlapped. */
  serviceKey?: string | null;
  /** Workflow: per-person vs grouped (all testimonies, then all baptisms). */
  mode: BaptismMode;
  phase: BaptismPhase;
  /** 1-based number of the person currently being timed (or about to start). */
  personNumber: number;
  /** Grouped baptism pass: 0-based index of the person currently being baptized. */
  baptismIndex: number;
  /** ISO when the current segment (testimony/baptism) started; null when idle. */
  segmentStartedAt: string | null;
  /** Milliseconds this segment banked before the last pause. Elapsed is this plus
   *  the time since `segmentStartedAt`; a null start with a non-zero accumulator is
   *  a paused clock. Absent on records made before pausing existed. */
  segmentAccumMs?: number;
  /**
   * Grouped only: the baptism phase has begun but nobody's clock runs yet.
   *
   * The baptisms happen across the song set, and the phase starts when the first
   * song goes live -- which is not when the first person steps up. Without this,
   * person 1 absorbs however much intro the band plays, every week. Armed, every
   * person's span runs from their own press to the next person's, so they all
   * carry the same kind of boundary.
   *
   * Distinct from paused: a paused segment has banked time to resume from, an
   * armed one has not started.
   */
  armed?: boolean;
  /** The plan item that started this session automatically, if one did — shown so
   *  the operator can see the timer did not start itself out of nowhere. */
  autoStartedFrom?: string | null;
  /** ISO when the session began; null before the first start. */
  sessionStartedAt: string | null;
  /** ISO when the session was finished (totals frozen); null while active. */
  finishedAt: string | null;
  /** Completed people (testimony + baptize splits). */
  people: BaptismPerson[];
  /** Testimony split captured for the in-progress person (set while in "baptism"). */
  pendingTestimonyMs: number | null;
  /** PCO service context snapshotted when the session started — names the session
   *  and lets Service History cross-link it. Null if no plan was active. */
  serviceTitle: string | null;
  serviceTypeId: string | null;
  planId: string | null;
}

/** A finished baptism session, kept for later review. */
/** Which plan items start each phase of the baptism timer, for one plan. */
/** How the baptism timer may start itself from the running plan. */
export interface BaptismAutoStart {
  enabled: boolean;
  /** Case-insensitive substring of a plan item's title that starts the
   *  testimonies. Only the testimony end can work this way — the baptisms happen
   *  during whichever songs are on that week, so that end is bound per plan. */
  testimonyKeyword: string;
}

export interface BaptismTriggers {
  /** Item whose going live starts the testimonies. */
  testimonyItemId?: string | null;
  /** Item whose going live switches to the baptisms. Picked per plan because it is
   *  usually a song, and the songs change every week. */
  baptismItemId?: string | null;
}

export interface BaptismSession {
  id: string;
  startedAt: string;
  finishedAt: string;
  people: BaptismPerson[];
  /** Service/plan title active when the session started (for the label). */
  title: string | null;
  serviceTypeId: string | null;
  planId: string | null;
  /** The service occurrence this belongs to — same key the recorders use, stamped
   *  when the session started. Absent on sessions recorded before it was captured,
   *  which fall back to matching by time overlap. */
  serviceKey?: string | null;
}

/** One operator action, as the raw layer records it. Never a derived total:
 *  the file is what happened, and the totals are replayed from it.
 *
 *  A runtime array, not a bare `type` union, so a guard can enforce its
 *  membership exactly rather than parsing this file's source text — see
 *  baptism-raw-event.test.ts. The replay task switches on these names; one
 *  added or renamed without that switch learning about it is silent data
 *  loss the replay cannot detect on its own. */
export const BAPTISM_RAW_EVENTS = [
  "start",
  "testimony-end",
  "baptisms-armed",
  "baptisms-start",
  "person-complete",
  "pause",
  "resume",
  "undo",
  "finish",
  "reset",
] as const;

export type BaptismRawEvent = (typeof BAPTISM_RAW_EVENTS)[number];

/** One `baptism.csv` row. The column set is FIXED — see recordBaptism. */
export interface BaptismRawFields {
  event: BaptismRawEvent;
  mode: BaptismMode;
  phase: BaptismPhase;
  personNumber: number;
  baptismIndex: number;
  /** The segment's elapsed ms at this moment, or 0 where it means nothing. */
  segmentMs: number;
  /** The plan item live when this happened. Null when nothing is live. */
  itemId: string | null;
  item: string | null;
  detail: string;
}

/** One of PCO's item row colors, from ServiceType.standard_item_types /
 *  custom_item_types. Standard entries match an item's `itemType`; custom entries
 *  match text CONTAINED in the title ("Items that include this text in the title
 *  will be highlighted"). */
