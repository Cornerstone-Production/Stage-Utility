// baptism-lane.ts — a baptism session's timing lane, derived from the raw rows.
//
// The Baptisms tab draws a session as a lane: each testimony and baptism in real
// time, and the stretches between them — the armed wait while the band plays the
// intro, the walk from the testimonies to the water, a pause — as gaps nobody was
// timed for. `BaptismState.people` cannot draw that: it holds DURATIONS, and a
// duration has no position. `baptism.csv` stamps every press with its time, so
// the lane is derived from the rows.
//
// PURE, like rebuildBaptismSessions: no disk, no store. It walks the same rows in
// the same order (rowsByTime) with the same reading of every cell (cellNumber),
// and tracks SPANS where the replay tracks durations. What ties the two together
// is baptism-lane-roundtrip.test.ts: for every person the store recorded, their
// spans sum to their testimonyMs and baptizeMs.
//
// ── The rules, and the emitter behaviour each one exists for ─────────────────
//
// Read off baptism-timer-service.ts and checked against driven sessions:
//
//  • A span is one run of one clock. One clock runs at a time, so spans never
//    overlap, and every boundary row closes whatever is running.
//
//  • A span OPENS where a press starts a clock: `start` (person 1's testimony);
//    grouped `testimony-end` (next() starts the next testimony in the same
//    press); per-person `testimony-end` at phase=baptism (baptized() starts that
//    person's baptism — at phase=testimony it is finish() closing a testimony
//    and starts nothing); `baptisms-start` (the first baptism after arming,
//    whether advance() or a direct next() started it); `person-complete` (the
//    next person); `resume` (the paused segment, same kind and person); and
//    `undo` (below).
//
//  • Grouped `person-complete` opens the next baptism only while someone is left
//    to baptize. Past the last person next() auto-finishes instead. The count is
//    the replay's: each grouped `testimony-end` and the `baptisms-armed` fold
//    push a person, a testimony-side undo pops one. Per-person next() never
//    auto-finishes, so there it always opens the next testimony.
//
//  • `baptisms-armed` closes the last testimony and opens NOTHING. The phase
//    begins when the song goes live, not when the first person steps in, so the
//    stretch until `baptisms-start` is a gap.
//
//  • The press that ENDS a session opens nothing. finish() writes the boundary
//    for whatever it closes — testimony-end or person-complete — and finalize()
//    then writes `finish`, all in one synchronous call; next()'s auto-finish
//    after the last person does the same. So a boundary IMMEDIATELY followed by
//    `finish` is that press's closing act. Read as an ordinary boundary it opens
//    a span for someone who is not there — person N+1's testimony, or a baptism
//    for a person never baptized — which `finish` closes a millisecond later:
//    no length, but a person the session never had. The person count cannot
//    catch this. A grouped session finished mid-baptism still HAS a next
//    person; they were just never baptized.
//
//  • A grouped baptism's person is `baptismIndex + 1`, never `personNumber`:
//    personNumber is the testimony counter and freezes once the section arms.
//    Testimonies, and every per-person row, are keyed on `personNumber`.
//
//  • `undo` takes back the press before it. The span that press OPENED ran on a
//    clock the undo throws away, so it becomes a gap. The span that press CLOSED
//    runs again from the undo row: RESUMED where the emitter resumes from the
//    banked time, so its earlier pieces still count; RE-TIMED where the emitter
//    restarts at zero, so they do not. Four shapes, told apart by the session's
//    mode and the phase the undo LANDED in — never by `detail`, whose text
//    collides between the modes:
//
//      grouped     testimony  a testimony resumed: the one next() closed, the
//                             one baptisms-armed folded in (the arming taken
//                             back), or the one a Finish closed. The testimony
//                             after it and every baptism are dropped.
//      grouped     baptism    the baptism at the row's index re-timed: a step
//                             back from the next person, or reopening a session
//                             Finish closed mid-baptism. That person's and the
//                             next person's baptisms drop.
//      per-person  testimony  baptized() or a Finish mid-testimony taken back:
//                             the testimony resumes, and its baptism, if it had
//                             one, drops.
//      per-person  baptism    next() or a finish taken back: that person's
//                             baptism is re-timed, the next testimony drops.
//
//    Two grouped undos land in the baptism phase and RE-ARM instead: no clock
//    runs, so they open nothing, and the wait until the next `baptisms-start` is
//    a gap like the first one. The row has no `armed` column, and each is
//    byte-identical to a re-timing row above, so the lane tells them apart by
//    what came before it:
//
//      - "First person in" taken back writes baptism, baptismIndex 0, "from
//        baptism" — exactly what a step back from person 2 onto person 1
//        writes. The difference is whose clock the undo stopped: person 1's
//        own, where a step back stops person 2's. So when the latest span is
//        person 1's baptism, running or banked by a pause, that clock is
//        thrown away and the section re-arms; there is no earlier press of
//        theirs to re-time.
//      - Reopening a session finished while armed. The `finish` straight
//        before it tells, having closed an armed section if no clock started
//        after `baptisms-armed`. finish() leaves the timer idle, where no press
//        but Undo, Start or Reset writes a row, so an undo reopening a finish
//        is always the row right after it.
//
//  • A session's spans are what its last `finish` logged. reset() clears the
//    timer and logs nothing, so a session reset before it finished leaves no
//    spans: that time is in no recorded session, and drawn as testimony and
//    baptism it would be time the figures do not count. A session finished,
//    undone and then reset keeps what that finish logged, because the store
//    still holds it. The replay makes the same call.
//
//  • A session still running ends with its last span open, `endedAt: null`.
//    Paused or armed, nothing is running and every span is closed.
//
//  • Mode comes from the `start` row, as in the replay: reset() emits after
//    clearing state, so the first row of a session can carry the previous
//    session's mode. Rows before the first `start` or after a `reset` belong to
//    no session and are not drawn — the timer had no session to record them in.
//
// ── A clock started from armed with no row of its own ────────────────────────
//
// Every clock the emitter starts after arming now writes `baptisms-start`. PR 1's
// emitter, which ships before this one, started one silently on two presses, and
// rows are append-only, so the files it wrote keep them:
//
//  - POST /api/baptism/next while ARMED — a documented route; advance() is what
//    the panel sends — closes person 1 without a row, since nobody's clock ran,
//    and started person 2's clock with none either. It writes `baptisms-start`
//    now.
//  - Undo after a Finish pressed while armed reopened the LAST person's baptism
//    with a clock running, writing only its `undo` row. It re-arms now, and the
//    lane reads that row as the re-arm (see the undo rule above), so in an old
//    file the clock it started is silent too.
//
// The first row after a silent start is usually the `pause` that banks that
// clock or the `person-complete` that ends it, and either way its segmentMs is
// the clock's whole run, because the clock started from zero. So the span is
// placed at that row's time minus its segmentMs: the timer's own measurement,
// not a guess. Without it the lane would draw counted time as a gap.
//
// An `undo` can stop a silent clock instead. Landing on the silent clock's own
// index, which only index 0 allows, it re-arms as it does after "First person
// in": nothing was drawn, and the timer threw that time away. Landing one index
// before it, it is a step back and re-times that person like any other. The
// silent clock's index is the person after the armed one for the first press,
// and the index the undo row names for the second.
//
// Nothing the emitter writes now reaches any of this: every clock it starts has
// its row, and an armed timer's undo lands in the testimonies.
// baptism-lane-roundtrip.test.ts holds the first shape to the store by stripping
// the row from real sessions; the second, which no current press produces, is
// held by fixtures in baptism-lane.test.ts.

import { BAPTISM_RAW_EVENTS, type BaptismMode, type BaptismRawEvent } from "../../types/stage.js";
import { scrub } from "../scrub.js";
import { rowsByTime } from "./archive-rows.js";
import { cellNumber, type BaptismRow } from "./rebuild-baptism.js";

/** One run of one clock, in real time. Gaps between spans are time nobody was
 *  timed for. */
export interface BaptismSpan {
  kind: "testimony" | "baptism";
  /** 1-based, numbered the way the operator panel numbers people. */
  person: number;
  startedAt: string;
  /** Null only for the clock still running, which is always the last span. */
  endedAt: string | null;
}

type SpanKind = BaptismSpan["kind"];

const RAW_EVENTS: ReadonlySet<string> = new Set(BAPTISM_RAW_EVENTS);

/** The row's event, or null for a name this version never writes — a torn last
 *  line, say. Narrowed to BaptismRawEvent so the switch below is exhaustive: an
 *  event added to BAPTISM_RAW_EVENTS fails `tsc` here until the lane handles it. */
function rawEvent(v: string | undefined): BaptismRawEvent | null {
  return v !== undefined && RAW_EVENTS.has(v) ? (v as BaptismRawEvent) : null;
}

/** The session being walked: its spans so far, and the timer state the rules
 *  above turn on. */
class LaneSession {
  spans: BaptismSpan[] = [];
  /** The span whose clock is running, or null while paused, armed or idle. */
  private running: BaptismSpan | null = null;
  /** Grouped only: how many people `people` holds (see the header). */
  people = 0;
  /** Grouped only: when the section armed, while no baptism clock has run. */
  armedAt: string | null = null;
  /** Grouped only, read while armed: the index an old file's clock started
   *  with no row of its own would be at (see the header) — the person after
   *  the armed one, or the one a reopened armed Finish's undo row names. */
  silentIndex = 1;
  /** The `finish` just read, or null after any other row. An undo straight
   *  after a finish reopens the session, and re-arms if that finish closed an
   *  armed section (see the header). */
  justFinished: { armed: boolean } | null = null;
  /** The spans as this session's last `finish` logged them. */
  logged: BaptismSpan[] | null = null;

  constructor(readonly mode: BaptismMode) {}

  open(kind: SpanKind, person: number, at: string): void {
    const span: BaptismSpan = { kind, person, startedAt: at, endedAt: null };
    this.spans.push(span);
    this.running = span;
  }

  close(at: string): void {
    if (this.running) this.running.endedAt = at;
    this.running = null;
  }

  /** Remove spans whose clock an undo threw away. Called after close(), so the
   *  running span is never among them. `person` omitted drops every person's. */
  drop(kind: SpanKind, person?: number): void {
    this.spans = this.spans.filter((s) => s.kind !== kind || (person !== undefined && s.person !== person));
  }

  /** Whether the latest span is this person's of this kind: the clock an undo
   *  just stopped, whether it was running or a pause had already banked it. */
  lastSpanIs(kind: SpanKind, person: number): boolean {
    const last = this.spans[this.spans.length - 1];
    return last !== undefined && last.kind === kind && last.person === person;
  }

  /** A clock started with no row (see the header): open its span at `at` minus
   *  the run the row reports, and never before the section armed. */
  startedSilently(r: BaptismRow, at: string): void {
    const armed = Date.parse(this.armedAt ?? "");
    const started = Math.max(armed, Date.parse(at) - cellNumber(r.segmentMs));
    // An unreadable stamp on either end leaves a span that cannot be placed; it
    // is kept as unplaceable and counted with the rest when the walk finishes.
    this.open("baptism", cellNumber(r.baptismIndex) + 1, Number.isFinite(started) ? new Date(started).toISOString() : "");
    this.armedAt = null;
  }
}

/**
 * The session lane these rows describe: every testimony and baptism span, oldest
 * first, with at most one — the last — still running.
 *
 * `serviceKey` only names the service in the one warning line this writes when a
 * span had to be left out (a boundary whose timestamp could not be read).
 */
export function baptismLaneSpans(rows: BaptismRow[], serviceKey = ""): BaptismSpan[] {
  const ordered = rowsByTime(rows);
  const out: BaptismSpan[] = [];
  let session: LaneSession | null = null;

  for (let i = 0; i < ordered.length; i++) {
    const r = ordered[i]!;
    const event = rawEvent(r.event);
    if (event === null) continue;
    const at = r.at ?? "";

    if (event === "start") {
      // A session that never finished was never logged; see the header.
      if (session) out.push(...(session.logged ?? []));
      session = new LaneSession(r.mode === "per-person" ? "per-person" : "grouped");
      session.open("testimony", 1, at);
      continue;
    }
    if (!session) continue;

    const person = cellNumber(r.personNumber);
    const index = cellNumber(r.baptismIndex);
    const grouped = session.mode === "grouped";
    const endsSession = rawEvent(ordered[i + 1]?.event) === "finish";
    const reopens = session.justFinished;
    session.justFinished = null;

    switch (event) {
      case "testimony-end":
        session.close(at);
        if (grouped) {
          session.people += 1;
          if (!endsSession) session.open("testimony", person + 1, at);
        } else if (r.phase === "baptism" && !endsSession) {
          session.open("baptism", person, at);
        }
        break;

      case "baptisms-armed":
        session.close(at);
        session.people += 1;
        session.armedAt = at;
        session.silentIndex = 1;
        break;

      case "baptisms-start":
        session.close(at);
        session.armedAt = null;
        session.open("baptism", index + 1, at);
        break;

      case "person-complete":
        if (grouped && session.armedAt !== null) session.startedSilently(r, at);
        session.close(at);
        if (endsSession) break;
        if (!grouped) session.open("testimony", person + 1, at);
        else if (index + 1 < session.people) session.open("baptism", index + 2, at);
        break;

      case "pause":
        if (grouped && session.armedAt !== null) session.startedSilently(r, at);
        session.close(at);
        break;

      case "resume":
        session.close(at);
        if (r.phase === "baptism") session.open("baptism", grouped ? index + 1 : person, at);
        else session.open("testimony", person, at);
        break;

      case "undo":
        session.close(at);
        // The two undos that re-arm (see the header): no clock runs until a
        // baptisms-start says one did.
        if (grouped && r.phase === "baptism" && reopens?.armed) {
          // Reopening a session finished while armed: nothing ran to drop. An
          // old file's undo here started a clock at the index it names.
          session.armedAt = at;
          session.silentIndex = index;
          break;
        }
        if (grouped && r.phase === "baptism" && !reopens && index === 0 && session.lastSpanIs("baptism", 1)) {
          // "First person in" taken back: the clock it started is thrown away.
          session.drop("baptism", 1);
          session.armedAt = at;
          session.silentIndex = 1;
          break;
        }
        if (grouped && r.phase === "baptism" && !reopens && session.armedAt !== null && index === session.silentIndex) {
          // Only an old file gets here — an armed timer's undo lands in the
          // testimonies — so a clock started with no row was running at this
          // index, and the undo re-arms on it as on "First person in". None of
          // that clock was drawn, so nothing drops. See the header.
          session.armedAt = at;
          break;
        }
        session.armedAt = null;
        if (grouped && r.phase === "testimony") {
          session.people = Math.max(0, session.people - 1);
          session.drop("testimony", person + 1);
          session.drop("baptism");
          session.open("testimony", person, at);
        } else if (grouped) {
          session.drop("baptism", index + 1);
          session.drop("baptism", index + 2);
          session.open("baptism", index + 1, at);
        } else if (r.phase === "testimony") {
          session.drop("baptism", person);
          session.open("testimony", person, at);
        } else {
          session.drop("testimony", person + 1);
          session.drop("baptism", person);
          session.open("baptism", person, at);
        }
        break;

      case "finish":
        session.close(at);
        session.justFinished = { armed: session.armedAt !== null };
        // A copy: a later undo must not reach back into what this finish logged.
        session.logged = session.spans.map((s) => ({ ...s }));
        break;

      case "reset":
        // The clock it stopped is not closed: none of this session's own spans
        // are drawn, only what a finish logged. See the header.
        out.push(...(session.logged ?? []));
        session = null;
        break;

      default: {
        // If this fails to compile, BAPTISM_RAW_EVENTS gained an event this walk
        // does not handle — decide what it opens and closes before shipping it.
        const unhandled: never = event;
        void unhandled;
      }
    }
  }
  // Still underway, or finished with nothing after it: drawn as it stands.
  if (session) out.push(...session.spans);

  const placeable = out.filter(
    (s) => Number.isFinite(Date.parse(s.startedAt)) && (s.endedAt === null || Number.isFinite(Date.parse(s.endedAt))),
  );
  if (placeable.length < out.length) {
    // Scrubbed: the key arrives verbatim in the lane route's query string.
    console.warn(
      `[baptism-lane] ${scrub(serviceKey)}: left out ${scrub(out.length - placeable.length)} span(s) ` +
        "with a boundary whose timestamp could not be read",
    );
  }
  return placeable;
}
