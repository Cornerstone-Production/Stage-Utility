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
    people: [],
    pendingTestimonyMs: null,
    serviceTitle: null,
    serviceTypeId: null,
    planId: null,
  };
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
   * `accumMs` defaults to 0 — a genuinely new segment. resume() is the one
   * caller that passes the banked amount instead, since resuming counts ON
   * from what was banked rather than restarting at zero.
   */
  private startSegment(accumMs = 0): Pick<BaptismState, "armed" | "segmentStartedAt" | "segmentAccumMs"> {
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

  /** Switch workflow — only allowed while idle (preserves nothing else). */
  setMode(mode: BaptismMode): BaptismState {
    if (mode !== "per-person" && mode !== "grouped") return this.state;
    if (this.state.phase !== "idle") return this.state;
    this.state = idleState(mode);
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
      ...this.startSegment(),
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
    };
    this.emitRaw("start", 0, this.state.autoStartedFrom ? `auto: ${this.state.autoStartedFrom}` : "manual");
    return this.commit();
  }

  /** PER-PERSON: testimony → baptism for the current person. */
  baptized(): BaptismState {
    if (this.state.mode !== "per-person" || this.state.phase !== "testimony") return this.state;
    this.state = { ...this.state, phase: "baptism", pendingTestimonyMs: this.elapsedMs(), ...this.startSegment() };
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
    this.emitRaw("baptisms-armed", 0);
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
      this.state = { ...this.state, ...this.startSegment() };
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
      this.state = { ...this.state, phase: "testimony", people: [...this.state.people, person], personNumber: this.state.personNumber + 1, pendingTestimonyMs: null, ...this.startSegment() };
      return this.commit();
    }
    // grouped
    if (this.state.phase === "testimony") {
      const person: BaptismPerson = { testimonyMs: this.elapsedMs(), baptizeMs: 0 };
      // Same reasoning as above: emit against the person whose testimony just
      // ended, before personNumber moves on to the next one.
      this.emitRaw("testimony-end", person.testimonyMs);
      this.state = { ...this.state, people: [...this.state.people, person], personNumber: this.state.personNumber + 1, ...this.startSegment() };
      return this.commit();
    }
    if (this.state.phase === "baptism") {
      // `armed` may still be true here — /api/baptism/next is a documented route,
      // reachable directly (bypassing advance()) while the phase is armed — so
      // startSegment() clearing it is load-bearing, not just tidy.
      const people = this.state.people.map((p, i) => (i === this.state.baptismIndex ? { ...p, baptizeMs: this.elapsedMs() } : p));
      const justBaptized = people[this.state.baptismIndex]!;
      // Emitted against THIS state — mode/phase/personNumber/baptismIndex all
      // still name the person just baptized. Emitting after baptismIndex
      // advances (or after finalize() resets the whole session to idle, for the
      // last person) would point the row at the wrong person, or at nobody: the
      // final person in a grouped session auto-finishes straight into
      // finalize() rather than reaching a `return this.commit()` of its own, so
      // this call is the only chance to record their completion at all.
      this.emitRaw(
        "person-complete",
        justBaptized.baptizeMs,
        `t=${justBaptized.testimonyMs} b=${justBaptized.baptizeMs}`,
      );
      if (this.state.baptismIndex + 1 < people.length) {
        this.state = { ...this.state, people, baptismIndex: this.state.baptismIndex + 1, ...this.startSegment() };
        return this.commit();
      }
      // last person baptized → close the session.
      return this.finalize(people);
    }
    return this.state;
  }

  /** Close the in-progress person/segment, freeze the session, and log it. */
  finish(): BaptismState {
    if (this.state.phase === "idle") return this.state;
    let people = [...this.state.people];
    if (this.state.mode === "per-person") {
      if (this.state.phase === "baptism") people.push({ testimonyMs: this.state.pendingTestimonyMs ?? 0, baptizeMs: this.elapsedMs() });
      else if (this.state.phase === "testimony") people.push({ testimonyMs: this.elapsedMs(), baptizeMs: 0 });
    } else if (this.state.phase === "testimony") {
      people.push({ testimonyMs: this.elapsedMs(), baptizeMs: 0 });
    } else if (this.state.phase === "baptism") {
      people = people.map((p, i) => (i === this.state.baptismIndex ? { ...p, baptizeMs: this.elapsedMs() } : p));
    }
    return this.finalize(people);
  }

  private finalize(people: BaptismPerson[]): BaptismState {
    const finishedAt = new Date().toISOString();
    // `armed: false` is load-bearing, not tidy: finishing (or auto-finishing after
    // the last person) while armed used to persist `{ phase: "idle", armed: true }`
    // to disk, and init() restored it — the panel checks `armed` before
    // `phase === "idle"`, so a finished session read as "Baptize person 1."
    this.state = { ...this.state, phase: "idle", armed: false, segmentStartedAt: null, pendingTestimonyMs: null, finishedAt, people };
    this.emitRaw("finish", 0, `people=${people.length}`);
    if (people.length > 0 && this.state.sessionStartedAt) {
      void baptismStore.addSession({
        id: `bap-${Date.parse(this.state.sessionStartedAt)}`,
        startedAt: this.state.sessionStartedAt,
        finishedAt,
        people,
        title: this.state.serviceTitle,
        serviceTypeId: this.state.serviceTypeId,
        planId: this.state.planId,
        serviceKey: this.state.serviceKey ?? null,
      }).catch((err) => console.error("[baptism-timer] session save failed:", err));
    }
    return this.commit();
  }

  /** Step back one action — fixes a mis-tap without losing the session. Every
   *  branch resumes a real clock (startSegment()), so none of them can restore
   *  into the armed state — armed means nobody has pressed yet, and undo only
   *  runs after some press already happened. */
  undo(): BaptismState {
    const s = this.state;
    if (s.mode === "per-person") {
      if (s.phase === "baptism") {
        this.state = { ...s, phase: "testimony", pendingTestimonyMs: null, ...this.startSegment() };
      } else if (s.phase === "testimony" && s.people.length > 0) {
        const people = [...s.people];
        const last = people.pop()!;
        this.state = { ...s, phase: "baptism", people, personNumber: Math.max(1, s.personNumber - 1), pendingTestimonyMs: last.testimonyMs, ...this.startSegment() };
      } else if (s.phase === "idle" && s.finishedAt && s.people.length > 0) {
        const people = [...s.people];
        const last = people.pop()!;
        this.state = { ...s, phase: "baptism", people, personNumber: people.length + 1, pendingTestimonyMs: last.testimonyMs, ...this.startSegment(), finishedAt: null };
      } else return s;
    } else {
      // grouped
      if (s.phase === "testimony" && s.people.length > 0) {
        const people = [...s.people];
        people.pop();
        this.state = { ...s, people, personNumber: Math.max(1, s.personNumber - 1), ...this.startSegment() };
      } else if (s.phase === "baptism" && s.baptismIndex > 0) {
        const idx = s.baptismIndex - 1;
        const people = s.people.map((p, i) => (i === idx ? { ...p, baptizeMs: 0 } : p));
        this.state = { ...s, people, baptismIndex: idx, ...this.startSegment() };
      } else if (s.phase === "baptism" && s.baptismIndex === 0) {
        // Back to the testimony section.
        this.state = { ...s, phase: "testimony", personNumber: s.people.length + 1, ...this.startSegment() };
      } else if (s.phase === "idle" && s.finishedAt && s.people.length > 0) {
        const idx = s.people.length - 1;
        const people = s.people.map((p, i) => (i === idx ? { ...p, baptizeMs: 0 } : p));
        this.state = { ...s, phase: "baptism", people, baptismIndex: idx, ...this.startSegment(), finishedAt: null };
      } else return s;
    }
    this.emitRaw("undo", 0, `from ${s.phase}`);
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
