// baptism-timer-service.ts — An operator stopwatch for baptism services. Each
// person has a testimony phase then a baptism phase; the service tracks the live
// phase + running segment and the completed people (testimony + baptize splits).
// State is broadcast on "baptism:state" and persisted (so a mid-service restart
// resumes the running clock — segmentStartedAt is an absolute timestamp). Finished
// sessions are logged for review. Running elapsed is derived client-side.

import type { BaptismSession, BaptismState } from "../types/stage.js";
import { broadcast } from "./broadcaster.js";
import { baptismStore } from "./baptism-store.js";

function idleState(): BaptismState {
  return {
    phase: "idle",
    personNumber: 0,
    segmentStartedAt: null,
    sessionStartedAt: null,
    finishedAt: null,
    people: [],
    pendingTestimonyMs: null,
  };
}

class BaptismTimerService {
  private state: BaptismState = idleState();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  /** Resume a persisted in-progress session on startup. */
  async init(): Promise<void> {
    const saved = await baptismStore.loadCurrent();
    if (saved) this.state = saved;
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
    // Debounced persist so a restart resumes (state changes are infrequent).
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        void baptismStore.saveCurrent(this.state);
      }, 800);
    }
    return this.state;
  }

  /** Begin a fresh session — person 1's testimony. */
  start(): BaptismState {
    if (this.state.phase !== "idle") return this.state;
    const now = new Date().toISOString();
    this.state = {
      phase: "testimony",
      personNumber: 1,
      segmentStartedAt: now,
      sessionStartedAt: now,
      finishedAt: null,
      people: [],
      pendingTestimonyMs: null,
    };
    return this.commit();
  }

  /** Testimony → baptism for the current person. */
  baptized(): BaptismState {
    if (this.state.phase !== "testimony") return this.state;
    this.state = {
      ...this.state,
      phase: "baptism",
      pendingTestimonyMs: this.elapsedMs(),
      segmentStartedAt: new Date().toISOString(),
    };
    return this.commit();
  }

  /** Finish the current person's baptism and start the next person's testimony. */
  next(): BaptismState {
    if (this.state.phase !== "baptism") return this.state;
    const person = { testimonyMs: this.state.pendingTestimonyMs ?? 0, baptizeMs: this.elapsedMs() };
    this.state = {
      ...this.state,
      phase: "testimony",
      people: [...this.state.people, person],
      personNumber: this.state.personNumber + 1,
      pendingTestimonyMs: null,
      segmentStartedAt: new Date().toISOString(),
    };
    return this.commit();
  }

  /** Close the in-progress person and freeze the session; log it for review. */
  finish(): BaptismState {
    if (this.state.phase === "idle") return this.state;
    const people = [...this.state.people];
    if (this.state.phase === "baptism") {
      people.push({ testimonyMs: this.state.pendingTestimonyMs ?? 0, baptizeMs: this.elapsedMs() });
    } else if (this.state.phase === "testimony") {
      people.push({ testimonyMs: this.elapsedMs(), baptizeMs: 0 });
    }
    const finishedAt = new Date().toISOString();
    this.state = {
      ...this.state,
      phase: "idle",
      segmentStartedAt: null,
      pendingTestimonyMs: null,
      finishedAt,
      people,
    };
    if (people.length > 0 && this.state.sessionStartedAt) {
      void baptismStore.addSession({
        id: `bap-${Date.parse(this.state.sessionStartedAt)}`,
        startedAt: this.state.sessionStartedAt,
        finishedAt,
        people,
      });
    }
    return this.commit();
  }

  /** Step back one action — fixes a mis-tap without losing the session. */
  undo(): BaptismState {
    const now = new Date().toISOString();
    if (this.state.phase === "baptism") {
      // Re-run the current person's testimony.
      this.state = { ...this.state, phase: "testimony", pendingTestimonyMs: null, segmentStartedAt: now };
    } else if (this.state.phase === "testimony" && this.state.people.length > 0) {
      // Pop the last completed person back into their baptism.
      const people = [...this.state.people];
      const last = people.pop()!;
      this.state = {
        ...this.state,
        phase: "baptism",
        people,
        personNumber: Math.max(1, this.state.personNumber - 1),
        pendingTestimonyMs: last.testimonyMs,
        segmentStartedAt: now,
      };
    } else if (this.state.phase === "idle" && this.state.finishedAt && this.state.people.length > 0) {
      // Reopen a just-finished session at the last person's baptism.
      const people = [...this.state.people];
      const last = people.pop()!;
      this.state = {
        ...this.state,
        phase: "baptism",
        people,
        personNumber: people.length + 1,
        pendingTestimonyMs: last.testimonyMs,
        segmentStartedAt: now,
        finishedAt: null,
      };
    } else {
      return this.state;
    }
    return this.commit();
  }

  /** Clear everything back to idle (discards the current session). */
  reset(): BaptismState {
    this.state = idleState();
    return this.commit();
  }
}

export const baptismTimerService = new BaptismTimerService();
