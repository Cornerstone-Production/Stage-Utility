// baptism-timer-service.ts — An operator stopwatch for baptism services.
//
// Two workflows (mode):
//   • "per-person": each person's testimony then baptism, in turn
//     (start → baptized → next → …).
//   • "grouped": time ALL testimonies first, then ALL baptisms — a testimony
//     section followed by a baptism section (start → next-testimony × N →
//     start-baptisms → next-baptism × N → finish).
//
// State is broadcast on "baptism:state" and persisted (so a mid-service restart
// resumes the running clock — segmentStartedAt is an absolute timestamp). Finished
// sessions are logged for review. Running elapsed is derived client-side.

import { getSystemErrorMessage, getSystemErrorName } from "node:util";

import { baptismSessionId } from "../types/stage.js";
import type { BaptismMode, BaptismPerson, BaptismRawEvent, BaptismSession, BaptismState } from "../types/stage.js";
import { settingsStore } from "./settings-store.js";
import { baptismTriggersStore } from "./baptism-triggers-store.js";
import { autoStartAction } from "./baptism-autostart.js";
import { segmentElapsedMs } from "./baptism-elapsed.js";
import { currentServiceKey } from "./service-key.js";
import { broadcast } from "./broadcaster.js";
import { baptismStore } from "./baptism-store.js";
import { stageController } from "./stage-controller.js";
import { serviceTimelineRecorder } from "./service-timeline-recorder.js";
import { sampleArchive } from "./archive/sample-archive.js";

function idleState(mode: BaptismMode): BaptismState {
  return {
    mode,
    phase: "idle",
    personNumber: 0,
    baptismIndex: 0,
    armed: false,
    segmentStartedAt: null,
    sessionStartedAt: null,
    finishedAt: null,
    finishedFrom: null,
    people: [],
    pendingTestimonyMs: null,
    serviceTitle: null,
    serviceTypeId: null,
    planId: null,
    saveError: null,
  };
}

/**
 * What a failed save may say on the operator's screen: why, never where.
 *
 * BaptismState goes to every screen on the LAN, and a filesystem path must never
 * be readable there (see port-holder.ts) — while a failed write's own message
 * names the absolute path of the file it was writing, data directory and all. A
 * Finish driven against a read-only data directory carried exactly that in the
 * pushed state. The log line keeps the whole error.
 *
 * Path-free by construction, not by filtering: the only input read is the
 * errno NUMBER, and both halves of the reason come from Node's own table for
 * it. No string the error carries — message, code, path — reaches the screen,
 * so an error that is not a system error gets a fixed sentence rather than its
 * message. Both lookups throw on anything but a negative integer, and this runs
 * inside a rejection handler, where a throw is an unhandled rejection — hence
 * the guard.
 */
function saveFailureReason(err: unknown): string {
  const errno = (err as { errno?: unknown } | null | undefined)?.errno;
  if (typeof errno === "number" && Number.isInteger(errno) && errno < 0) {
    const name = getSystemErrorName(errno);
    const description = getSystemErrorMessage(errno);
    // An errno Node does not know reads "Unknown system error <n>" for both.
    return name === description ? description : `${name}: ${description}`;
  }
  return "an unexpected error; the log has the details";
}

class BaptismTimerService {
  private state: BaptismState = idleState("per-person");
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  /** Resume a persisted in-progress session on startup (tolerating older records
   *  that predate mode/baptismIndex). */
  async init(): Promise<void> {
    const [saved, settings] = await Promise.all([baptismStore.loadCurrent(), settingsStore.get()]);
    const fallback = settings.baptismDefaultMode === "per-person" ? "per-person" : "grouped";
    this.state = saved ? { ...idleState(fallback), ...saved } : idleState(fallback);
  }

  getState(): BaptismState {
    return this.state;
  }

  async listSessions(): Promise<BaptismSession[]> {
    return baptismStore.listSessions();
  }

  async deleteSession(id: string): Promise<boolean> {
    return baptismStore.deleteSession(id);
  }

  /** Last item auto-start considered a DONE deal for — either nothing to do, or
   *  it actually moved the phase. An item whose action was ignored (wrong mode
   *  for the section it is bound to) is deliberately left off this, so a later
   *  tick on the same item retries once the operator fixes the mode — PCO can
   *  sit on one song for minutes and the operator has no way to force a tick. */
  private lastAutoItemId: string | null = null;
  /** Last item warned about being ignored, so the operator sees the reason once
   *  per item rather than once per ~1.5s poll for as long as PCO sits on it. */
  private lastWarnedItemId: string | null = null;

  /** The plan item live right now, held from the last onLiveTick so a button
   *  press — which arrives nowhere near a live tick — can still say which song
   *  the room was on when the raw layer records the action. */
  private liveItem: { id: string; title: string } | null = null;

  /** Whether "no service open" has already been logged for the session in
   *  progress, so a producer running the whole rehearsal off-Sunday sees the
   *  line once rather than once per press. Reset in start(). */
  private warnedNoService = false;

  private elapsedMs(): number {
    return segmentElapsedMs(this.state);
  }

  /**
   * Start (or restart) the current segment's clock: never armed, never paused,
   * timing from this instant. Compose this into every state update that begins
   * timing something, rather than writing the shape by hand — eleven call
   * sites wrote `segmentStartedAt: <now>, segmentAccumMs: 0` themselves, and
   * only three of them also remembered to clear `armed`. That is exactly how
   * armed leaked past its own state: resume(), finalize() and next() could
   * each leave `armed: true` sitting on top of a running clock, or on a
   * session that had already finished.
   *
   * `accumMs` is REQUIRED, deliberately — it used to default to 0, and that
   * default has been the defect three separate times: resume() dropping its
   * one argument came back reading the length of the prayer it was paused
   * through, and both undo() branches that pop a person off `people` restarted
   * their resumed testimony at zero, discarding the minutes already banked in
   * the popped entry. A caller starting a genuinely new segment says so with
   * `startSegment(0)`; a caller resuming one passes what was banked. Omitting
   * it is now a type error rather than a silent zero.
   */
  private startSegment(accumMs: number): Pick<BaptismState, "armed" | "segmentStartedAt" | "segmentAccumMs"> {
    return { armed: false, segmentStartedAt: new Date().toISOString(), segmentAccumMs: accumMs };
  }

  /**
   * Drive the timer from the running plan, so a producer advancing PCO is not also
   * clicking start here at the same moment.
   *
   * Deliberately only moves forward — idle → testimonies, testimonies → baptisms.
   * See baptism-autostart.ts for why it can never interrupt a session underway.
   * `autoStartedFrom` records what did it, so the operator can see the timer did
   * not start itself out of nowhere and can reset if it was wrong.
   */
  async onLiveTick(live: PcoLiveDTO): Promise<void> {
    this.liveItem =
      live.mode === "item" && live.currentItemId ? { id: live.currentItemId, title: live.label ?? "" } : null;
    if (live.mode !== "item" || !live.currentItemId) return;
    if (live.currentItemId === this.lastAutoItemId) return; // only on a change

    const [settings, triggers] = await Promise.all([
      settingsStore.get(),
      baptismTriggersStore.get(stageController.getState().planId),
    ]);
    const action = autoStartAction({
      itemId: live.currentItemId,
      itemTitle: live.label,
      phase: this.state.phase,
      triggers,
      auto: settings.baptismAutoStart ?? null,
    });
    if (action === null) {
      // Nothing to do for this item -- the ordinary case -- so it is settled
      // and does not need re-reading on every subsequent tick it stays live.
      this.lastAutoItemId = live.currentItemId;
      return;
    }

    // Compare the phase the action was supposed to produce against the phase we
    // actually got. startBaptisms() returns early unless the mode is grouped,
    // and the old code set autoStartedFrom regardless -- so the panel reported a
    // transition that never happened and the operator had no reason to look.
    const before = this.state.phase;
    if (action === "start-testimonies") this.start();
    else this.startBaptisms();

    if (this.state.phase === before) {
      // Deliberately NOT recorded on lastAutoItemId: PCO can sit on this item for
      // minutes, and the operator's fix (switching the mode) only helps if the
      // next tick re-evaluates it rather than treating it as already handled.
      if (this.lastWarnedItemId !== live.currentItemId) {
        this.lastWarnedItemId = live.currentItemId;
        console.warn(
          `[baptism] auto-start: "${live.label ?? live.currentItemId}" is bound to the ` +
            `${action === "start-baptisms" ? "baptisms" : "testimonies"} but the timer is in ` +
            `${this.state.mode} mode and stayed in "${before}" — ignored`,
        );
      }
      return;
    }

    this.lastAutoItemId = live.currentItemId;
    // startBaptisms() ARMS rather than starting a clock (see BaptismState.armed) —
    // saying "started baptism" here would tell a Sunday-morning operator a clock
    // is running when nobody's is, which is the one thing this whole feature
    // exists to stop happening.
    console.log(
      action === "start-testimonies"
        ? `[baptism] auto-start: started testimonies from "${live.label ?? ""}"`
        : `[baptism] auto-start: armed baptisms from "${live.label ?? ""}" — no clock runs until the first press`,
    );
    this.state = { ...this.state, autoStartedFrom: live.label ?? null };
    this.commit();
  }

  /** Stop the clock, banking what it has run. Idempotent — pausing a paused timer
   *  must not bank the same stretch twice. */
  pause(): BaptismState {
    if (this.state.phase === "idle" || !this.state.segmentStartedAt) return this.state;
    if (this.state.armed) return this.state; // nothing is running to bank
    this.state = { ...this.state, segmentAccumMs: this.elapsedMs(), segmentStartedAt: null };
    this.emitRaw("pause", this.state.segmentAccumMs ?? 0);
    return this.commit();
  }

  /** Start it again from what was banked, not from zero. */
  resume(): BaptismState {
    if (this.state.phase === "idle" || this.state.segmentStartedAt) return this.state;
    // Nothing banked to resume FROM — advance() is how armed ends, not this. Without
    // this check, POST /api/baptism/resume while armed stamped a start time and left
    // `armed: true`, so person 1's clock silently counted the band's intro: the exact
    // outcome this whole feature exists to prevent.
    if (this.state.armed) return this.state;
    // Keeps segmentAccumMs — resuming counts ON from what was banked. Clearing it
    // here silently discarded everything before the pause, so a testimony paused
    // through the prayer came back reading the length of the prayer.
    this.state = { ...this.state, ...this.startSegment(this.state.segmentAccumMs ?? 0) };
    this.emitRaw("resume", this.state.segmentAccumMs ?? 0);
    return this.commit();
  }

  private commit(): BaptismState {
    broadcast("baptism:state", this.state);
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        void baptismStore
          .saveCurrent(this.state)
          .catch((err) => console.error("[baptism-timer] persist failed:", err));
      }, 800);
    }
    return this.state;
  }

  /**
   * Append this action to the raw layer. Gated on an open service, like every
   * other raw source — no key means no row, which is what keeps a Tuesday
   * afternoon out of the archive.
   *
   * `serviceKey` and `serviceDate` are read off the SAME record
   * (serviceTimelineRecorder.getCurrent()), never split out of a key string —
   * one read of one record cannot have its key and date disagree. "Open" mirrors
   * currentServiceKey()'s own meaning: a record exists AND `endedAt == null`.
   *
   * Never throws and never blocks: this runs from the live tick and from
   * operator presses during a service, and taking the service down to record a
   * row is worse than losing one. This is a deliberate exception to this repo's
   * catch-rethrows-or-returns rule, matching the convention sampleArchive's own
   * record methods already document (see recordBaptism).
   */
  private emitRaw(event: BaptismRawEvent, segmentMs: number, detail = ""): void {
    try {
      const record = serviceTimelineRecorder.getCurrent();
      if (!record || record.endedAt != null) {
        if (!this.warnedNoService) {
          this.warnedNoService = true;
          console.warn("[baptism] raw: no service open, session not archived");
        }
        return;
      }
      sampleArchive.recordBaptism(
        { serviceKey: record.serviceKey, serviceDate: record.serviceDate },
        {
          event,
          mode: this.state.mode,
          phase: this.state.phase,
          personNumber: this.state.personNumber,
          baptismIndex: this.state.baptismIndex,
          segmentMs,
          itemId: this.liveItem?.id ?? null,
          item: this.liveItem?.title ?? null,
          detail,
        },
      );
    } catch (err) {
      console.error("[baptism] raw: emit failed:", event, err);
    }
  }

  /** Switch workflow — only allowed while idle. Preserves nothing else but a
   *  failed save, which only a save that lands or Reset may clear (see
   *  BaptismState.saveError). */
  setMode(mode: BaptismMode): BaptismState {
    if (mode !== "per-person" && mode !== "grouped") return this.state;
    if (this.state.phase !== "idle") return this.state;
    this.state = { ...idleState(mode), saveError: this.state.saveError ?? null };
    return this.commit();
  }

  /** Begin a fresh session — person 1's testimony. Snapshots the active PCO
   *  service/plan so the session can be named + cross-linked to Service History. */
  start(): BaptismState {
    if (this.state.phase !== "idle") return this.state;
    this.warnedNoService = false; // a new session gets its own one-time "no service" warning
    const now = new Date().toISOString();
    const st = stageController.getState();
    this.state = {
      ...idleState(this.state.mode),
      phase: "testimony",
      personNumber: 1,
      ...this.startSegment(0),
      sessionStartedAt: now,
      serviceTitle: st.planTitle ?? null,
      serviceTypeId: st.serviceTypeId ?? null,
      planId: st.planId ?? null,
      // Which occurrence this is, not just which plan — two services on one day
      // share a plan, so a plan id cannot tell the 9am from the 11am. Taken from
      // the service the timeline recorder currently has open, so a baptism agrees
      // with the timing and attendance recorded alongside it, including when an
      // overrunning service rolls PCO's current service time forward.
      serviceKey: currentServiceKey(),
      // The previous session's failed save, if any. A plan item going live
      // calls this with nobody at the screen; see BaptismState.saveError.
      saveError: this.state.saveError ?? null,
    };
    // No manual/auto provenance here: at this point in start(), this.state.
    // autoStartedFrom is always whatever idleState() left it as (unset) —
    // onLiveTick sets it in a SEPARATE assignment + commit() only after start()
    // has already returned, so reading it here would read "manual" for both a
    // button press and a PCO auto-start, every time. That is worse than no
    // value: the whole point of this row is to report only what happened. The
    // `[baptism] auto-start:` log line already records which one it was.
    this.emitRaw("start", 0, "");
    return this.commit();
  }

  /** PER-PERSON: testimony → baptism for the current person. */
  baptized(): BaptismState {
    if (this.state.mode !== "per-person" || this.state.phase !== "testimony") return this.state;
    this.state = { ...this.state, phase: "baptism", pendingTestimonyMs: this.elapsedMs(), ...this.startSegment(0) };
    this.emitRaw("testimony-end", this.state.pendingTestimonyMs ?? 0);
    return this.commit();
  }

  /** GROUPED: end the testimony section and ARM the baptisms. The currently-timing
   *  testimony is finalized as the last person; no baptism clock starts until the
   *  first press. See BaptismState.armed. */
  startBaptisms(): BaptismState {
    if (this.state.mode !== "grouped" || this.state.phase !== "testimony") return this.state;
    const people = [...this.state.people, { testimonyMs: this.elapsedMs(), baptizeMs: 0 }];
    this.state = {
      ...this.state,
      phase: "baptism",
      people,
      baptismIndex: 0,
      armed: true,
      segmentStartedAt: null,
      segmentAccumMs: 0,
    };
    // The last person's testimony is folded into `people` here rather than
    // getting its own `next()` press — carry its testimonyMs as this row's
    // segmentMs, or it survives nowhere but the free-text detail of whatever
    // row eventually baptizes them (and nowhere at all if they never are).
    this.emitRaw("baptisms-armed", people[people.length - 1]!.testimonyMs);
    return this.commit();
  }

  /**
   * The phase-aware primary press — whatever the operator panel's main button
   * does right now. ONE entry point, so a Companion key, a layout button and the
   * panel cannot disagree about which action is legal in which phase.
   */
  advance(): BaptismState {
    if (this.state.phase === "idle") return this.start();
    if (this.state.armed) {
      // "First person in": begin person 1 without banking the armed stretch.
      this.state = { ...this.state, ...this.startSegment(0) };
      this.emitRaw("baptisms-start", 0);
      return this.commit();
    }
    if (this.state.phase === "testimony") {
      return this.state.mode === "grouped" ? this.next() : this.baptized();
    }
    return this.next();
  }

  /** Step forward one action — meaning depends on mode + phase:
   *   per-person/baptism  → finish this person, start the next testimony
   *   grouped/testimony   → finish this testimony, start the next testimony
   *   grouped/baptism     → finish this baptism, baptize the next person (auto-
   *                         finishes the session after the last person).
   *  Not the phase-aware entry point itself — see advance(), which calls this
   *  once the idle/armed/per-person-testimony special cases are handled. */
  next(): BaptismState {
    if (this.state.mode === "per-person") {
      if (this.state.phase !== "baptism") return this.state;
      const person: BaptismPerson = { testimonyMs: this.state.pendingTestimonyMs ?? 0, baptizeMs: this.elapsedMs() };
      // Emitted BEFORE personNumber advances, so the row names the person who was
      // just baptized rather than the one about to start their testimony.
      this.emitRaw("person-complete", person.baptizeMs, `t=${person.testimonyMs} b=${person.baptizeMs}`);
      this.state = { ...this.state, phase: "testimony", people: [...this.state.people, person], personNumber: this.state.personNumber + 1, pendingTestimonyMs: null, ...this.startSegment(0) };
      return this.commit();
    }
    // grouped
    if (this.state.phase === "testimony") {
      const person: BaptismPerson = { testimonyMs: this.elapsedMs(), baptizeMs: 0 };
      // Same reasoning as above: emit against the person whose testimony just
      // ended, before personNumber moves on to the next one.
      this.emitRaw("testimony-end", person.testimonyMs);
      this.state = { ...this.state, people: [...this.state.people, person], personNumber: this.state.personNumber + 1, ...this.startSegment(0) };
      return this.commit();
    }
    if (this.state.phase === "baptism" && this.state.people.length > 0) {
      // `people.length > 0` guards the same restored-record shape undo()'s
      // baptismIndex===0 branch guards against: a pre-mode record restores as
      // grouped/baptism/baptismIndex 0 with an empty people list (see
      // baptism-armed.test.ts), and this branch used to index into that empty
      // array unconditionally — a TypeError out of next(), a 500 from
      // POST /api/baptism/next AND /api/baptism/advance (advance() is the
      // panel's primary button and dispatches straight into this branch once
      // armed is cleared). With nobody at this index there is nothing to step
      // forward from, so this is a no-op rather than inventing a person.
      //
      // `armed` may still be true here — /api/baptism/next is a documented route,
      // reachable directly (bypassing advance()) while the phase is armed — so
      // startSegment() clearing it is load-bearing, not just tidy.
      const people = this.state.people.map((p, i) => (i === this.state.baptismIndex ? { ...p, baptizeMs: this.elapsedMs() } : p));
      const justBaptized = people[this.state.baptismIndex]!;
      // Emitted against THIS state — mode/phase/baptismIndex still name the
      // person just baptized (personNumber does NOT: in grouped mode it is the
      // testimony counter, frozen at the section total once armed, so a
      // 2-person grouped session stamps BOTH person-complete rows with
      // personNumber=2 — a replay must key grouped rows on baptismIndex, never
      // personNumber). Emitting after baptismIndex advances (or after
      // finalize() resets the whole session to idle, for the last person)
      // would point the row at the wrong person, or at nobody: the final
      // person in a grouped session auto-finishes straight into finalize()
      // rather than reaching a `return this.commit()` of its own, so this call
      // is the only chance to record their completion at all.
      //
      // Guarded on `!armed`: /api/baptism/next is a documented route reachable
      // directly while armed (see the comment above), and calling it there
      // closes person 0 having never run a clock — segmentStartedAt is null
      // and segmentAccumMs is 0, so elapsedMs() reads 0 the same as it would
      // for a genuine instant baptism. A person-complete row cannot tell those
      // apart, and a replay reading "a person-complete row exists" as "this
      // person was baptized" would invent one that never happened. Nothing is
      // lost by skipping it: this person already has a testimony-end row (or
      // was folded into baptisms-armed, for whoever arms last), correctly
      // carrying baptizeMs: 0 until a real press updates it.
      if (!this.state.armed) {
        this.emitRaw(
          "person-complete",
          justBaptized.baptizeMs,
          `t=${justBaptized.testimonyMs} b=${justBaptized.baptizeMs}`,
        );
      }
      if (this.state.baptismIndex + 1 < people.length) {
        const fromArmed = this.state.armed === true; // read before startSegment() clears it
        this.state = { ...this.state, people, baptismIndex: this.state.baptismIndex + 1, ...this.startSegment(0) };
        // A clock started from armed writes the row advance()'s armed branch
        // writes, and at the same point: after the state moves, so it names the
        // person whose clock this is. Without it this was the one clock start
        // the raw log never recorded — the person-complete above is suppressed
        // while armed, rightly, and nothing else stood in for it.
        if (fromArmed) this.emitRaw("baptisms-start", 0);
        return this.commit();
      }
      // last person baptized → close the session.
      return this.finalize(people);
    }
    // Scoped to the exact shape the guard above exists for — grouped/baptism
    // with nobody at this index — not the (also silent, pre-existing, and out
    // of scope here) grouped/idle fallthrough. Without this, an operator
    // pressing the panel's primary button on a corrupted restored session got
    // nothing: no commit(), no broadcast, no archive row, not even a state
    // push — the press looked like it did nothing because it did nothing, and
    // said so nowhere.
    if (this.state.phase === "baptism") {
      console.log(`[baptism] next: ignored, the restored session has nobody at baptismIndex ${this.state.baptismIndex}`);
    }
    return this.state;
  }

  /** Close the in-progress person/segment, freeze the session, and log it.
   *  This is a SECOND delegation to finalize() beside next()'s grouped-baptism
   *  auto-finish, and the one that terminates every per-person session — next()
   *  in per-person mode never auto-finishes, it always starts another testimony
   *  — so a Finish press is the ONLY way a per-person session ends. Each branch
   *  below emits against the person/segment it just closed, using the same
   *  "capture locally, emit before finalize() resets anything" shape next()
   *  uses, before delegating. */
  finish(): BaptismState {
    if (this.state.phase === "idle") return this.state;
    let people = [...this.state.people];
    if (this.state.mode === "per-person") {
      if (this.state.phase === "baptism") {
        const person: BaptismPerson = { testimonyMs: this.state.pendingTestimonyMs ?? 0, baptizeMs: this.elapsedMs() };
        people.push(person);
        this.emitRaw("person-complete", person.baptizeMs, `t=${person.testimonyMs} b=${person.baptizeMs}`);
      } else if (this.state.phase === "testimony") {
        const person: BaptismPerson = { testimonyMs: this.elapsedMs(), baptizeMs: 0 };
        people.push(person);
        this.emitRaw("testimony-end", person.testimonyMs);
      }
    } else if (this.state.phase === "testimony") {
      const person: BaptismPerson = { testimonyMs: this.elapsedMs(), baptizeMs: 0 };
      people.push(person);
      this.emitRaw("testimony-end", person.testimonyMs);
    } else if (this.state.phase === "baptism" && people.length > 0) {
      // Same restored-record shape as next()'s guard above: with an empty
      // people list, `people[this.state.baptismIndex]` is undefined, and
      // spreading it into `justBaptized` produced `{ baptizeMs: ... }` with no
      // testimonyMs — not a throw, but a person-complete row whose detail read
      // the literal string "t=undefined", a row the replay would have to
      // defend against. Skipping the whole branch leaves `people` (and thus
      // the finalized session) unchanged, which matches next()'s no-op.
      const justBaptized: BaptismPerson = { ...people[this.state.baptismIndex]!, baptizeMs: this.elapsedMs() };
      people = people.map((p, i) => (i === this.state.baptismIndex ? justBaptized : p));
      // Guarded on `!armed` for the same reason as next()'s grouped-baptism
      // branch: Finish pressed right after arming, before anyone has stepped
      // up, closes a person who never ran a clock. Writing a person-complete
      // row for them would tell a replay a baptism happened that did not —
      // per-person mode never sets `armed`, so this can only suppress the
      // grouped case, and per-person's own row above is unaffected.
      if (!this.state.armed) {
        this.emitRaw(
          "person-complete",
          justBaptized.baptizeMs,
          `t=${justBaptized.testimonyMs} b=${justBaptized.baptizeMs}`,
        );
      }
    } else if (this.state.phase === "baptism") {
      // finalize() below runs unconditionally and archives a "finish" row
      // carrying `people=${people.length}`, so this path is not silent the
      // way next()'s equivalent no-op is — the session does visibly close.
      // But that row reads identically whether this was a genuine service
      // with nobody baptized, or a Finish pressed on a corrupted restored
      // session with a phantom baptism in progress; only this line names the
      // second case.
      console.log(`[baptism] finish: closing with nobody at baptismIndex ${this.state.baptismIndex} — no person-complete row recorded`);
    }
    return this.finalize(people);
  }

  private finalize(people: BaptismPerson[]): BaptismState {
    const finishedAt = new Date().toISOString();
    // `armed: false` is load-bearing, not tidy: finishing (or auto-finishing after
    // the last person) while armed used to persist `{ phase: "idle", armed: true }`
    // to disk, and init() restored it — the panel checks `armed` before
    // `phase === "idle"`, so a finished session read as "Baptize person 1."
    this.state = {
      ...this.state,
      phase: "idle",
      armed: false,
      segmentStartedAt: null,
      pendingTestimonyMs: null,
      finishedAt,
      people,
      // What this reset throws away that Undo needs back: whether a clock was
      // running, and in which section. See BaptismState.finishedFrom.
      finishedFrom: this.state.armed ? "armed" : this.state.phase === "testimony" ? "testimony" : "baptism",
    };
    this.emitRaw("finish", 0, `people=${people.length}`);
    if (people.length > 0 && this.state.sessionStartedAt) {
      void baptismStore
        .addSession({
          id: baptismSessionId(this.state.sessionStartedAt),
          startedAt: this.state.sessionStartedAt,
          finishedAt,
          people,
          title: this.state.serviceTitle,
          serviceTypeId: this.state.serviceTypeId,
          planId: this.state.planId,
          serviceKey: this.state.serviceKey ?? null,
        })
        .then(
          () => {
            // A save that lands clears an earlier failure: the store is writing
            // again, and a session re-finished after an Undo keeps its id, so
            // this write replaced the one that failed.
            if (!this.state.saveError) return;
            this.state = { ...this.state, saveError: null };
            this.commit();
          },
          (err: unknown) => {
            // This was a catch that only logged, so a failed write read to the
            // operator as a clean finish. The log line stays for /log; the state
            // carries the failure to the screen. It settles after Finish has
            // already returned and pushed, so it needs a commit of its own.
            console.error("[baptism-timer] session save failed:", err);
            this.state = { ...this.state, saveError: saveFailureReason(err) };
            this.commit();
          },
        );
    }
    return this.commit();
  }

  /** Step back one action — fixes a mis-tap without losing the session. Every
   *  branch but two resumes a real clock (startSegment()). The exceptions both
   *  return to armed with no clock running: taking back "First person in",
   *  since the press before it armed the section, and undoing a Finish pressed
   *  while armed, since nobody had stepped in. A clock restored there would
   *  time person 1 from the Undo press, the one thing armed exists to prevent.
   *  Undoing any Finish returns to where Finish was pressed; see
   *  BaptismState.finishedFrom. */
  undo(): BaptismState {
    const s = this.state;
    if (s.mode === "per-person") {
      if (s.phase === "baptism") {
        // Back into the testimony we just closed. `pendingTestimonyMs` is where
        // baptized() parked it, and it does not apply in the testimony phase —
        // but clearing it without resuming FROM it throws the whole testimony
        // away. Baptized pressed a beat early on a three-minute testimony,
        // undone, then finished fifty seconds later, recorded as fifty seconds.
        // Third site of this shape; see the two grouped branches below.
        this.state = { ...s, phase: "testimony", pendingTestimonyMs: null, ...this.startSegment(s.pendingTestimonyMs ?? 0) };
      } else if (s.phase === "testimony" && s.people.length > 0) {
        const people = [...s.people];
        const last = people.pop()!;
        this.state = { ...s, phase: "baptism", people, personNumber: Math.max(1, s.personNumber - 1), pendingTestimonyMs: last.testimonyMs, ...this.startSegment(0) };
      } else if (s.phase === "idle" && s.finishedAt && s.people.length > 0) {
        // finish() pushed the person it closed either way; finishedFrom says
        // which segment that was, so this reopens it rather than assuming a
        // baptism. Assumed, a Finish pressed mid-testimony came back with the
        // testimony frozen and a baptism clock running over the rest of it.
        const people = [...s.people];
        const last = people.pop()!;
        if (s.finishedFrom === "testimony") {
          // Never reached its baptism: the testimony resumes from what it
          // banked, like every return into a testimony.
          this.state = { ...s, phase: "testimony", people, personNumber: people.length + 1, pendingTestimonyMs: null, ...this.startSegment(last.testimonyMs), finishedAt: null, finishedFrom: null };
        } else {
          this.state = { ...s, phase: "baptism", people, personNumber: people.length + 1, pendingTestimonyMs: last.testimonyMs, ...this.startSegment(0), finishedAt: null, finishedFrom: null };
        }
      } else return s;
    } else {
      // grouped
      if (s.phase === "testimony" && s.people.length > 0) {
        // Resume the popped person's testimony from the time it had already
        // banked, NOT from zero: next() was pressed a beat early, and the
        // minutes they had already spoken live nowhere but this entry. Same
        // shape as the baptismIndex === 0 branch below.
        const people = [...s.people];
        const last = people.pop()!;
        this.state = { ...s, people, personNumber: Math.max(1, s.personNumber - 1), ...this.startSegment(last.testimonyMs) };
      } else if (s.phase === "baptism" && s.baptismIndex > 0) {
        const idx = s.baptismIndex - 1;
        const people = s.people.map((p, i) => (i === idx ? { ...p, baptizeMs: 0 } : p));
        this.state = { ...s, people, baptismIndex: idx, ...this.startSegment(0) };
      } else if (s.phase === "baptism" && s.baptismIndex === 0 && s.people.length > 0) {
        // `people.length > 0` is load-bearing, matching the sibling branches
        // that pop: init() restores a record saved before `mode` existed onto
        // the grouped default, and a per-person session saved mid-baptism has
        // an EMPTY people list (person 1's testimony lives in
        // pendingTestimonyMs, not in people). Unguarded, the pop below read
        // .testimonyMs off undefined — a TypeError out of undo(), a 500 from
        // POST /api/baptism/undo, and no Undo left for the rest of the service.
        // That record also restores with `armed: false` (init() fills the idle
        // defaults in first), so the guard covers both halves below, not just
        // the one that pops: without it, the re-arm half would re-arm a session
        // with nobody in it rather than letting it reach the branch below that
        // logs it.
        if (!s.armed) {
          // Not armed, so person 1's clock has started (and may be paused
          // since): the press being taken back is "First person in", not the
          // arming. Back to armed — the shape startBaptisms() arms into, no
          // clock and nothing banked — with `people` untouched: the person the
          // arming folded in has not been baptized, so they are still waiting.
          // Person 1's time is discarded; it was the mis-tap. Returning to the
          // testimonies here, as the armed half does, took back the arming too,
          // and left the last testimony's clock running over the walk-up until
          // "Start baptisms" was pressed a second time.
          this.state = { ...s, armed: true, segmentStartedAt: null, segmentAccumMs: 0 };
        } else {
          // Still armed, so the press being taken back is the arming itself.
          // Back to the testimony section — pop the person startBaptisms()
          // folded in when it armed, resuming them as the in-progress
          // testimony. Left unpopped, a later re-arm folds them AGAIN beside the
          // leftover completed entry: a one-person service finishes as two,
          // silently.
          //
          // Resumed from the folded entry's OWN banked testimonyMs, not zero —
          // arming on the wrong song, undoing, and re-arming when the right song
          // goes live is an ordinary Sunday sequence, and restarting at zero
          // records only the seconds between the two arms while discarding the
          // whole testimony that ran before the first one.
          const people = [...s.people];
          const folded = people.pop()!;
          this.state = { ...s, phase: "testimony", people, personNumber: people.length + 1, ...this.startSegment(folded.testimonyMs) };
        }
      } else if (s.phase === "idle" && s.finishedAt && s.people.length > 0) {
        // Back to where Finish was pressed, which is not always the last
        // person. This assumed it was, and was right only for "Last person out":
        // Finish while baptizing person 1 of 3 came back on person 3, skipping
        // person 2, and Finish while armed came back baptizing person 2 with
        // person 1 skipped.
        if (s.finishedFrom === "armed") {
          // Nobody had stepped in: back to waiting for the first press, with
          // every clock stopped. The shape startBaptisms() arms into.
          this.state = { ...s, phase: "baptism", baptismIndex: 0, armed: true, segmentStartedAt: null, segmentAccumMs: 0, finishedAt: null, finishedFrom: null };
        } else if (s.finishedFrom === "testimony") {
          // Finish closed the testimony section: pop the testimony it pushed and
          // resume it from what it banked, as the testimony branch above does.
          const people = [...s.people];
          const last = people.pop()!;
          this.state = { ...s, phase: "testimony", people, personNumber: people.length + 1, ...this.startSegment(last.testimonyMs), finishedAt: null, finishedFrom: null };
        } else {
          // A baptism, re-timed from zero like every return into one, at the
          // index finalize() left: the person Finish closed, and for next()'s
          // auto-finish the last person. A record finished before finishedFrom
          // existed lands here too — never worse than the last person, which is
          // what this assumed before. Clamped so a damaged record cannot point
          // next() past the end of `people`.
          const idx = Math.min(Math.max(0, s.baptismIndex), s.people.length - 1);
          const people = s.people.map((p, i) => (i === idx ? { ...p, baptizeMs: 0 } : p));
          this.state = { ...s, phase: "baptism", people, baptismIndex: idx, ...this.startSegment(0), finishedAt: null, finishedFrom: null };
        }
      } else if (s.phase === "baptism" && s.baptismIndex === 0) {
        // The complement of the guarded branch above: baptismIndex === 0 with
        // an EMPTY people list — the same restored-record shape, caught here
        // rather than there. Named separately from the generic `else return s`
        // below (which also covers ordinary "nothing to undo yet" presses)
        // because this one specifically means the session came back corrupted,
        // not that the operator is just at the start of it.
        console.log("[baptism] undo: ignored, the restored session has nobody at baptismIndex 0");
        return s;
      } else return s;
    }
    this.emitRaw("undo", 0, `from ${s.phase}`);
    return this.commit();
  }

  /** The operator has read a failed save's note and dismissed it — the one way
   *  to clear it besides a save that lands or Reset, and the only one after
   *  the workflow toggle has carried it into a state with nobody in it, where
   *  the Timer card offers neither Reset nor Undo. Touches nothing else, and
   *  writes no raw row: it is not a press on the timer. */
  dismissSaveError(): BaptismState {
    if (!this.state.saveError) return this.state;
    console.log(`[baptism-timer] save failure dismissed: ${this.state.saveError}`);
    this.state = { ...this.state, saveError: null };
    return this.commit();
  }

  /** Clear everything back to idle (keeps the chosen mode). */
  reset(): BaptismState {
    this.state = idleState(this.state.mode);
    this.emitRaw("reset", 0);
    return this.commit();
  }
}

export const baptismTimerService = new BaptismTimerService();
