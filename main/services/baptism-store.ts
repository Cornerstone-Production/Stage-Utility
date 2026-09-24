// baptism-store.ts — Persists the baptism timer: the in-progress session state
// (so a mid-service restart resumes the running clock) plus a log of finished
// sessions for later review. Backed by the generic DataStore (baptism.json).

import type { BaptismSession, BaptismState } from "../types/stage.js";
import { DataStore } from "./data-store.js";

interface BaptismFile {
  current: BaptismState | null;
  sessions: BaptismSession[];
}

/**
 * Hard ceiling on stored sessions — a bound on file growth, NOT a retention
 * policy, and deliberately far above any real history.
 *
 * It used to be 100 and applied on every live append, which quietly made the
 * restore fix pointless: importing 240 sessions worked, and then the very next
 * baptism sliced the list back to 100 and destroyed 139 of them for good. A
 * number small enough to reach in normal use is a data-loss mechanism wearing a
 * cap's clothing. At a few hundred bytes each, 2000 sessions is well under a
 * megabyte and no church reaches it.
 */
const MAX_SESSIONS = 2000;

class BaptismStore {
  private store = new DataStore<BaptismFile>("baptism.json", { current: null, sessions: [] }, "runtime");

  /** The in-progress session state persisted before a restart (or null). */
  async loadCurrent(): Promise<BaptismState | null> {
    return (await this.store.load()).current;
  }

  /** Finished sessions, newest first. */
  async listSessions(): Promise<BaptismSession[]> {
    const file = await this.store.load();
    return file.sessions.slice().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  async saveCurrent(state: BaptismState | null): Promise<void> {
    await this.store.update((file) => ({ ...file, current: state }));
  }

  /**
   * Append a finished session, or replace one already carrying this id.
   *
   * Not a plain prepend. `finalize()` derives the id from `sessionStartedAt`,
   * and `undo()` from the finished state clears `finishedAt` and re-enters the
   * baptism phase without touching that stamp — so finish -> undo -> finish
   * re-finalizes the SAME session. Prepended, that left two rows sharing an id,
   * and `linkBaptisms` counted the service's people twice.
   *
   * The replacement keeps its position rather than jumping to the head: the list
   * is read newest-first by `startedAt`, and a corrected session did not start
   * again.
   */
  async addSession(session: BaptismSession): Promise<void> {
    await this.store.update((file) => {
      const at = file.sessions.findIndex((s) => s.id === session.id);
      if (at >= 0) {
        const sessions = file.sessions.slice();
        sessions[at] = session;
        return { ...file, sessions };
      }
      return { ...file, sessions: [session, ...file.sessions].slice(0, MAX_SESSIONS) };
    });
  }

  /**
   * Merge in sessions from a restore, newest first, without a cap.
   *
   * An archive import used to call addSession once per session, and every call
   * re-applied the cap — so importing 45 sessions into a box holding 80 pushed 25
   * of the operator's OWN recordings past index 100 and deleted them, while the
   * API cheerfully reported only what had been added. That directly contradicts
   * importArchive's documented "merges and never overwrites".
   *
   * The cap exists to bound an append during a live service, where the list grows
   * one session at a time and old ones stop mattering. A restore is the opposite
   * situation: the operator is deliberately putting history back, and silently
   * dropping the oldest of it is the one thing they would not forgive. Existing
   * ids win, so a re-import is idempotent.
   */
  async addSessions(sessions: BaptismSession[]): Promise<number> {
    if (sessions.length === 0) return 0;
    let added = 0;
    await this.store.update((file) => {
      const have = new Set(file.sessions.map((s) => s.id));
      const fresh = sessions.filter((s) => !have.has(s.id));
      added = fresh.length;
      const merged = [...fresh, ...file.sessions].sort((a, b) =>
        (b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
      );
      return { ...file, sessions: merged.slice(0, MAX_SESSIONS) };
    });
    return added;
  }

  async deleteSession(id: string): Promise<boolean> {
    let existed = false;
    await this.store.update((file) => {
      existed = file.sessions.some((s) => s.id === id);
      return { ...file, sessions: file.sessions.filter((s) => s.id !== id) };
    });
    return existed;
  }
}

export const baptismStore = new BaptismStore();
