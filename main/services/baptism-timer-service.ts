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

import type { BaptismMode, BaptismPerson, BaptismSession, BaptismState } from "../types/stage.js";
import { currentServiceKey } from "./service-key.js";
import { broadcast } from "./broadcaster.js";
import { baptismStore } from "./baptism-store.js";
import { stageController } from "./stage-controller.js";

function idleState(mode: BaptismMode): BaptismState {
  return {
    mode,
    phase: "idle",
    personNumber: 0,
    baptismIndex: 0,
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
    const saved = await baptismStore.loadCurrent();
    if (saved) this.state = { ...idleState("per-person"), ...saved };
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

  private elapsedMs(): number {
    if (!this.state.segmentStartedAt) return 0;
    return Math.max(0, Date.now() - Date.parse(this.state.segmentStartedAt));
  }

  private commit(): BaptismState {
    broadcast("baptism:state", this.state);
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        void baptismStore.saveCurrent(this.state);
      }, 800);
    }
    return this.state;
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
    const now = new Date().toISOString();
    const st = stageController.getState();
    this.state = {
      ...idleState(this.state.mode),
      phase: "testimony",
      personNumber: 1,
      segmentStartedAt: now,
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
    return this.commit();
  }

  /** PER-PERSON: testimony → baptism for the current person. */
  baptized(): BaptismState {
    if (this.state.mode !== "per-person" || this.state.phase !== "testimony") return this.state;
    this.state = { ...this.state, phase: "baptism", pendingTestimonyMs: this.elapsedMs(), segmentStartedAt: new Date().toISOString() };
    return this.commit();
  }

  /** GROUPED: end the testimony section and begin baptisms with person 1. The
   *  currently-timing testimony is finalized as the last person. */
  startBaptisms(): BaptismState {
    if (this.state.mode !== "grouped" || this.state.phase !== "testimony") return this.state;
    const people = [...this.state.people, { testimonyMs: this.elapsedMs(), baptizeMs: 0 }];
    this.state = { ...this.state, phase: "baptism", people, baptismIndex: 0, segmentStartedAt: new Date().toISOString() };
    return this.commit();
  }

  /** Advance — meaning depends on mode + phase:
   *   per-person/baptism  → finish this person, start the next testimony
   *   grouped/testimony   → finish this testimony, start the next testimony
   *   grouped/baptism     → finish this baptism, baptize the next person (auto-
   *                         finishes the session after the last person). */
  next(): BaptismState {
    const now = new Date().toISOString();
    if (this.state.mode === "per-person") {
      if (this.state.phase !== "baptism") return this.state;
      const person: BaptismPerson = { testimonyMs: this.state.pendingTestimonyMs ?? 0, baptizeMs: this.elapsedMs() };
      this.state = { ...this.state, phase: "testimony", people: [...this.state.people, person], personNumber: this.state.personNumber + 1, pendingTestimonyMs: null, segmentStartedAt: now };
      return this.commit();
    }
    // grouped
    if (this.state.phase === "testimony") {
      const person: BaptismPerson = { testimonyMs: this.elapsedMs(), baptizeMs: 0 };
      this.state = { ...this.state, people: [...this.state.people, person], personNumber: this.state.personNumber + 1, segmentStartedAt: now };
      return this.commit();
    }
    if (this.state.phase === "baptism") {
      const people = this.state.people.map((p, i) => (i === this.state.baptismIndex ? { ...p, baptizeMs: this.elapsedMs() } : p));
      if (this.state.baptismIndex + 1 < people.length) {
        this.state = { ...this.state, people, baptismIndex: this.state.baptismIndex + 1, segmentStartedAt: now };
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
    this.state = { ...this.state, phase: "idle", segmentStartedAt: null, pendingTestimonyMs: null, finishedAt, people };
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
      });
    }
    return this.commit();
  }

  /** Step back one action — fixes a mis-tap without losing the session. */
  undo(): BaptismState {
    const now = new Date().toISOString();
    const s = this.state;
    if (s.mode === "per-person") {
      if (s.phase === "baptism") {
        this.state = { ...s, phase: "testimony", pendingTestimonyMs: null, segmentStartedAt: now };
      } else if (s.phase === "testimony" && s.people.length > 0) {
        const people = [...s.people];
        const last = people.pop()!;
        this.state = { ...s, phase: "baptism", people, personNumber: Math.max(1, s.personNumber - 1), pendingTestimonyMs: last.testimonyMs, segmentStartedAt: now };
      } else if (s.phase === "idle" && s.finishedAt && s.people.length > 0) {
        const people = [...s.people];
        const last = people.pop()!;
        this.state = { ...s, phase: "baptism", people, personNumber: people.length + 1, pendingTestimonyMs: last.testimonyMs, segmentStartedAt: now, finishedAt: null };
      } else return s;
    } else {
      // grouped
      if (s.phase === "testimony" && s.people.length > 0) {
        const people = [...s.people];
        people.pop();
        this.state = { ...s, people, personNumber: Math.max(1, s.personNumber - 1), segmentStartedAt: now };
      } else if (s.phase === "baptism" && s.baptismIndex > 0) {
        const idx = s.baptismIndex - 1;
        const people = s.people.map((p, i) => (i === idx ? { ...p, baptizeMs: 0 } : p));
        this.state = { ...s, people, baptismIndex: idx, segmentStartedAt: now };
      } else if (s.phase === "baptism" && s.baptismIndex === 0) {
        // Back to the testimony section.
        this.state = { ...s, phase: "testimony", personNumber: s.people.length + 1, segmentStartedAt: now };
      } else if (s.phase === "idle" && s.finishedAt && s.people.length > 0) {
        const idx = s.people.length - 1;
        const people = s.people.map((p, i) => (i === idx ? { ...p, baptizeMs: 0 } : p));
        this.state = { ...s, phase: "baptism", people, baptismIndex: idx, segmentStartedAt: now, finishedAt: null };
      } else return s;
    }
    return this.commit();
  }

  /** Clear everything back to idle (keeps the chosen mode). */
  reset(): BaptismState {
    this.state = idleState(this.state.mode);
    return this.commit();
  }
}

export const baptismTimerService = new BaptismTimerService();
