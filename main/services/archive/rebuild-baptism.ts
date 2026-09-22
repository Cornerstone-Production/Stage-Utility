// rebuild-baptism.ts — recompute a service's baptism sessions from its raw rows.
//
// `baptism.json` is a REWRITABLE array: finalize() replaces a session's entry
// every time it closes, the persist behind it is debounced, and a file that will
// not parse is renamed aside and started from defaults (see data-store.ts). Any
// of those loses the session outright, and a baptism happens once. `baptism.csv`
// is append-only and holds every press the operator made, so the sessions can be
// re-derived instead of lost.
//
// PURE, like rebuildTimelineRecord: no disk, no store. That lets it COMPARE a
// stored record against the rows as well as replace one.
//
// ── The replay rules, and the emitter behaviour each one exists for ─────────
//
// Read off baptism-timer-service.ts rather than reasoned about, because most of
// them are counter-intuitive:
//
//  • MODE comes from the `start` row, never from the first row of the file.
//    reset() emits AFTER clearing state, and setMode() emits nothing at all, so
//    the first row of a per-person session is commonly a `reset` still reading
//    `mode=grouped` — the mode of the session before it.
//
//  • `person-complete` is NOT unique per person. undo() lets an operator
//    re-baptise the same `baptismIndex`, and both attempts are in the file. The
//    LAST row for an index is the real one, so grouped completions ASSIGN
//    `baptizeMs` at the row's index rather than appending. Counting rows counts
//    baptisms that were undone.
//
//  • `baptisms-armed` carries a PERSON. startBaptisms() folds the testimony that
//    was still running into `people` as the section arms, and that row's
//    `segmentMs` is the only structured place that duration exists.
//
//  • A grouped row is keyed on `baptismIndex`, never `personNumber`.
//    personNumber is the testimony counter and freezes at the section total once
//    the baptisms arm, so every `person-complete` in a 2-person session reads
//    `personNumber=2`.
//
//  • A per-person `testimony-end` means one of two different things, told apart
//    by `phase`: baptized() emits it with the state already moved on
//    (`phase=baptism`) and only BANKS the testimony, while finish()'s testimony
//    branch emits it before finalize() runs (`phase=testimony`) and has already
//    pushed a person. Grouped `testimony-end` always pushes.
//
//  • An `undo` row's `phase` is the phase it landed IN; its `detail` names the
//    phase it came FROM. The people effect follows from (mode, phase) alone —
//    `detail` is corroborating only, which matters because the same (phase,
//    detail) pair means opposite things in the two modes: `phase=testimony
//    detail="from baptism"` pops the folded person in grouped mode and pops
//    NOBODY in per-person mode. There are seven (mode, phase, from) triples in
//    the emitter, four grouped and three per-person.
//
//  • A session can carry TWO `finish` rows — finish, undo out of idle, finish
//    again — and is ONE session. baptismStore.addSession replaces by id rather
//    than prepending for exactly this reason, so the replay replaces too.
//
//  • A `finish` that is undone and never re-finished still leaves the earlier
//    session in the store; undo() writes nothing. So each `finish` logs a COPY
//    of the people as they stood at that moment, and later presses cannot reach
//    back and alter it.
//
//  • `person-complete` is never emitted while the section is still armed —
//    nobody's clock has run — so there is no "completion with no clock" shape to
//    tolerate.
//
//  • `finish` with nobody in `people` logs no session, matching finalize().
//
// What it CANNOT reconstruct exactly: `startedAt`, `finishedAt` and therefore
// `id`. The timer stamps its own state a moment before emitRaw hands the row to
// the archive, which stamps the row itself — so a replayed session's stamps run
// a millisecond or two late. The per-person splits, which is what the feature
// exists to record, come back exactly.

import { baptismSessionId, type BaptismMode, type BaptismPerson, type BaptismSession } from "../../types/stage.js";
import { scrub } from "../scrub.js";
import { readArchiveRows, rowsByTime, type ArchiveRow } from "./archive-rows.js";
import { serviceDirPath } from "./archive-paths.js";

/** One row of `baptism.csv`, as readArchiveRows hands it back. */
export type BaptismRow = ArchiveRow;

/** What the rows cannot say: which service this was and what it was called. */
export interface BaptismIdentity {
  serviceKey: string;
  title: string | null;
  serviceTypeId: string | null;
  planId: string | null;
}

function num(v: string | undefined): number {
  const n = Number(v ?? "");
  return Number.isFinite(n) ? n : 0;
}

/** The session being replayed: the timer's own state, minus everything the
 *  totals do not depend on. */
interface OpenSession {
  mode: BaptismMode;
  startedAt: string;
  people: BaptismPerson[];
  /** per-person only: the testimony baptized() banked, awaiting its baptism. */
  pendingTestimonyMs: number | null;
  /** Where this session's last `finish` already logged it in the output, so a
   *  second `finish` replaces that entry instead of adding a second session. */
  logged: number | null;
}

/** Counters for what a damaged file made this skip, reported as one line rather
 *  than one per row — a truncated CSV can carry thousands. */
interface Skips {
  unreadableStart: number;
  noSession: number;
  missingIndex: number;
  unknownMode: number;
}

/**
 * Replay rows into the sessions they describe.
 *
 * One session per `start`, logged by each `finish` that closes it with at least
 * one person. A `reset` abandons whatever was underway — that is what reset
 * means — without disturbing a session the same rows already logged.
 *
 * Rows before the first `start`, or after a `reset`, belong to no session and
 * are ignored: the timer had no session to record them against either.
 */
export function rebuildBaptismSessions(rows: BaptismRow[], identity: BaptismIdentity): BaptismSession[] {
  const out: BaptismSession[] = [];
  const skips: Skips = { unreadableStart: 0, noSession: 0, missingIndex: 0, unknownMode: 0 };
  let open: OpenSession | null = null;

  for (const r of rowsByTime(rows)) {
    const at = r.at ?? "";

    if (r.event === "start") {
      // Without a readable stamp there is no startedAt and therefore no id —
      // and finalize() itself logs nothing without a sessionStartedAt. The
      // whole session is dropped rather than logged under `bap-NaN`, which
      // every later rebuild would mint again as a fresh duplicate.
      if (!Number.isFinite(Date.parse(at))) {
        skips.unreadableStart += 1;
        open = null;
        continue;
      }
      let mode: BaptismMode;
      if (r.mode === "per-person" || r.mode === "grouped") mode = r.mode;
      else {
        skips.unknownMode += 1;
        mode = "grouped";
      }
      open = { mode, startedAt: at, people: [], pendingTestimonyMs: null, logged: null };
      continue;
    }

    if (!open) {
      if (r.event !== "reset") skips.noSession += 1;
      continue;
    }

    switch (r.event) {
      case "testimony-end":
        if (open.mode === "per-person" && r.phase === "baptism") {
          // baptized(): the state has already moved into the baptism phase, so
          // this only banks the testimony. The person is completed later, by
          // next() or by finish().
          open.pendingTestimonyMs = num(r.segmentMs);
        } else {
          // Grouped next()/finish(), and per-person finish() closing a testimony
          // that never reached a baptism — all three had already pushed a person
          // when they emitted, with baptizeMs still 0.
          open.people.push({ testimonyMs: num(r.segmentMs), baptizeMs: 0 });
        }
        break;

      case "baptisms-armed":
        // startBaptisms() folds the running testimony into `people` and carries
        // its duration here. Nowhere else holds it.
        open.people.push({ testimonyMs: num(r.segmentMs), baptizeMs: 0 });
        break;

      case "person-complete":
        if (open.mode === "per-person") {
          open.people.push({ testimonyMs: open.pendingTestimonyMs ?? 0, baptizeMs: num(r.segmentMs) });
          open.pendingTestimonyMs = null;
        } else {
          // ASSIGN, never append: a re-baptised index has two rows and the last
          // one wins.
          const person = open.people[num(r.baptismIndex)];
          if (person) person.baptizeMs = num(r.segmentMs);
          else skips.missingIndex += 1;
        }
        break;

      case "undo":
        // `phase` is where the undo LANDED. Together with the mode that is the
        // whole rule; see the header for why `detail` is not consulted.
        if (open.mode === "per-person") {
          if (r.phase === "testimony") {
            // Un-baptized: the banked testimony went back into the running
            // clock and a later testimony-end re-banks the corrected total.
            open.pendingTestimonyMs = null;
          } else {
            // Stepped back into the person just completed (from the next
            // testimony, or from a finished session). Their testimony becomes
            // the pending one again.
            open.pendingTestimonyMs = open.people.pop()?.testimonyMs ?? null;
          }
        } else if (r.phase === "testimony") {
          // Back into the testimony section: pop the completed testimony, or
          // the person startBaptisms() folded in. Left in place, a re-arm folds
          // the same person a SECOND time and a one-person service finishes as
          // two — the headline number of the whole feature.
          open.people.pop();
        } else {
          // Still in the baptism section (or reopening a finished one): the
          // person at the row's index is un-baptized, not removed.
          const person = open.people[num(r.baptismIndex)];
          if (person) person.baptizeMs = 0;
          else skips.missingIndex += 1;
        }
        break;

      case "finish": {
        // finalize() logs nothing for an empty session, and leaves any session
        // it already logged alone.
        if (open.people.length === 0) break;
        const session: BaptismSession = {
          id: baptismSessionId(open.startedAt),
          startedAt: open.startedAt,
          finishedAt: at,
          // A COPY: a later undo must not reach back into a session this row
          // already logged, because undo() does not rewrite the store either.
          people: open.people.map((p) => ({ ...p })),
          title: identity.title,
          serviceTypeId: identity.serviceTypeId,
          planId: identity.planId,
          serviceKey: identity.serviceKey,
        };
        if (open.logged != null) out[open.logged] = session;
        else {
          open.logged = out.length;
          out.push(session);
        }
        break;
      }

      case "reset":
        open = null;
        break;

      default:
        // baptisms-start, pause and resume carry no session content. They are in
        // the file because the operator's timeline is drawn from it.
        break;
    }
  }

  const notes: string[] = [];
  if (skips.unreadableStart) notes.push(`${skips.unreadableStart} session(s) whose start row had an unreadable timestamp`);
  if (skips.noSession) notes.push(`${skips.noSession} row(s) belonging to no started session`);
  if (skips.missingIndex) notes.push(`${skips.missingIndex} row(s) naming a baptismIndex with nobody at it`);
  if (skips.unknownMode) notes.push(`${skips.unknownMode} start row(s) with an unreadable mode, replayed as grouped`);
  if (notes.length > 0) {
    // The serviceKey arrives verbatim in an HTTP body wherever a rebuild is
    // triggered, the same way history-edit.ts's does — scrubbed, or a newline
    // in it forges a `/log` entry. The notes are fixed prose and counts, and
    // are scrubbed anyway: the barrier is applied at the logger, so no reader
    // has to re-derive which half of a line came from outside.
    console.warn(`[baptism-replay] ${scrub(identity.serviceKey)}: skipped ${scrub(notes.join("; "))}`);
  }
  return out;
}

/** The rows for one service, or null when it has no baptism archive — the same
 *  "nothing to rebuild from" contract rebuildSplItems has. */
export async function readBaptismRows(serviceKey: string, serviceDate: string): Promise<BaptismRow[] | null> {
  return readArchiveRows(serviceDirPath(serviceKey, serviceDate), "baptism");
}
