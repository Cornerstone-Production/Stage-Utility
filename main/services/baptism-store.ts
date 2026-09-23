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
 *
 * Exported so a rebuild's own log line (history-edit.ts) can name the same
 * number this file enforces, rather than a second copy of "2000" the two
 * could drift on.
 */
export const MAX_SESSIONS = 2000;

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

  /**
   * Apply a rebuild's reconciled sessions in ONE write, so a crash mid-merge
   * cannot leave the store half updated.
   *
   * Each session either REPLACES the stored entry with the same id (one the
   * rebuild matched and brought up to date) or is APPENDED (one it found no
   * stored counterpart for). Everything else already in the file — every
   * session this rebuild did not touch, whichever service it names — is left
   * exactly as it was.
   *
   * NEVER evicts an existing session, unlike addSession/addSessions. A
   * rebuild's job is to reconstruct data the operator already has, not to
   * delete some of it to make room for the rest — quietly evicting the
   * oldest session to fit a rebuild in is exactly the "delete an operator's
   * data to tidy something up" this repo forbids. If adding every session
   * this batch wants to APPEND would push the store past MAX_SESSIONS, only
   * as many as fit are added (in the order handed in), and the rest are
   * reported back as `full` rather than silently dropped or evicted to make
   * room. An operator who wants those in has one option: delete some old
   * sessions and rebuild again. Every REPLACEMENT lands unconditionally —
   * overwriting an existing session's own fields never changes how many
   * sessions the store holds, so it is never capacity-limited.
   *
   * See rebuildServiceBaptisms in history-edit.ts, which is the only caller
   * and decides what belongs in `sessions`, and already refuses to let two
   * rebuilt sessions claim the same stored one. This is the second line of
   * defence: two sessions sharing an id here can only mean the caller's own
   * matching has a bug, and a `Map` built from `sessions` would silently
   * keep the LAST of them and drop the other's data — the exact
   * silent-collapse shape this refuses instead.
   *
   * A session identical, field for field, to what is already stored leaves
   * that entry as that SAME object rather than a new one carrying equal
   * values, so an already-intact store's file is untouched byte for byte —
   * verified by `baptism-store.test.ts`'s spy on the underlying write, not
   * merely claimed: DataStore.update() skips the write entirely when the
   * mutator hands back the object it was given.
   */
  async mergeRebuilt(sessions: BaptismSession[]): Promise<{ full: number }> {
    if (sessions.length === 0) return { full: 0 };
    const seen = new Set<string>();
    for (const s of sessions) {
      if (seen.has(s.id)) {
        throw new Error(`mergeRebuilt received two sessions sharing id "${s.id}" — refusing rather than silently keeping one`);
      }
      seen.add(s.id);
    }

    let full = 0;
    await this.store.update((file) => {
      let changed = false;
      const incoming = new Map(sessions.map((s) => [s.id, s]));
      const next = file.sessions.map((existing) => {
        const repl = incoming.get(existing.id);
        if (!repl) return existing;
        incoming.delete(existing.id);
        if (repl.finishedAt === existing.finishedAt && JSON.stringify(repl.people) === JSON.stringify(existing.people)) {
          return existing; // matched, but nothing about it actually differs — no write needed for this one
        }
        changed = true;
        return repl;
      });
      // Whatever is left in `incoming` after every replacement is consumed
      // are genuinely new sessions. `next.length` here still equals the
      // store's own current size — every existing session was either kept
      // or replaced in place, never added or removed — so this is exactly
      // how much room is left under the cap, with no eviction involved.
      const toAdd = [...incoming.values()];
      const room = Math.max(0, MAX_SESSIONS - next.length);
      full = Math.max(0, toAdd.length - room);
      for (const s of toAdd.slice(0, room)) {
        changed = true;
        next.push(s);
      }
      if (!changed) return file;
      return { ...file, sessions: next };
    });
    return { full };
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
