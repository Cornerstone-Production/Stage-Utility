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
   *
   * A genuinely new session is capped at `max(MAX_SESSIONS, the store's size
   * before this append)`, not at a bare `MAX_SESSIONS`. A restore
   * (`addSessions`) never evicts, so it can legitimately leave the store
   * holding more than the cap — a plain `.slice(0, MAX_SESSIONS)` here would
   * then let the very next live Finish silently delete every session over the
   * cap in one shot. This still evicts exactly one once the store is AT the
   * cap, the same as before; it only refuses to evict MORE than the one
   * session this append would otherwise add past an already-over-cap store.
   */
  async addSession(session: BaptismSession): Promise<void> {
    await this.store.update((file) => {
      const at = file.sessions.findIndex((s) => s.id === session.id);
      if (at >= 0) {
        const sessions = file.sessions.slice();
        sessions[at] = session;
        return { ...file, sessions };
      }
      const merged = [session, ...file.sessions];
      const cap = Math.max(MAX_SESSIONS, file.sessions.length);
      const sessions = merged.slice(0, cap);
      const evicted = merged.length - sessions.length;
      if (evicted > 0) {
        console.log(`[baptism] a live append evicted ${evicted} session(s) to stay at the cap`);
      }
      return { ...file, sessions };
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
   *
   * Genuinely uncapped: this can leave the store holding more than
   * MAX_SESSIONS. `addSession` (the live-append path) knows about that —
   * see its own doc comment — so the very next Finish does not silently
   * delete the excess in one shot; it pares the store back toward the cap one
   * session at a time instead.
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
      return { ...file, sessions: merged };
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
   * as many as fit are added (in the order handed in); the rest are
   * reported back as `full` rather than silently dropped or evicted to make
   * room. An operator who wants those in has one option: delete some old
   * sessions and rebuild again. Every REPLACEMENT lands unconditionally —
   * overwriting an existing session's own fields never changes how many
   * sessions the store holds, so it is never capacity-limited.
   *
   * Returns `addedIds` and `updatedIds` — the ids of `sessions` that actually
   * landed as a NEW entry or as a REPLACEMENT of an existing one, not merely
   * planned to — alongside `full`, all counted here, at write time, from the
   * same batch the write itself just applied. `added`/`updated` are
   * `addedIds.size`/`updatedIds.size`, never separate counts: a caller that
   * needs to know WHICH sessions were restored (the save-failure note's own
   * Rebuild offer clears an entry only for an id that genuinely landed,
   * whether that landing was an add or an update — a session whose LATER
   * re-Finish failed to save already has a stored counterpart, so its own
   * rebuild can only ever update it) cannot get that from a bare number, and
   * a caller must not re-derive either from its own plan-time count of how
   * many rows it expected to add or update — the store can change between
   * planning a rebuild and applying it (an operator deleting a session this
   * rebuild had matched, another save landing), and subtracting a stale
   * plan-time count from a fresh write-time one can drift, even go negative.
   * `added + full` is exactly `sessions.length` minus however many were
   * REPLACEMENTS (`updated`), by construction.
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
  async mergeRebuilt(
    sessions: BaptismSession[],
  ): Promise<{ added: number; addedIds: ReadonlySet<string>; updated: number; updatedIds: ReadonlySet<string>; full: number }> {
    if (sessions.length === 0) return { added: 0, addedIds: new Set(), updated: 0, updatedIds: new Set(), full: 0 };
    const seen = new Set<string>();
    for (const s of sessions) {
      if (seen.has(s.id)) {
        throw new Error(`mergeRebuilt received two sessions sharing id "${s.id}" — refusing rather than silently keeping one`);
      }
      seen.add(s.id);
    }

    let addedIds = new Set<string>();
    let updatedIds = new Set<string>();
    let full = 0;
    await this.store.update((file) => {
      let changed = false;
      const incoming = new Map(sessions.map((s) => [s.id, s]));
      const updated = new Set<string>();
      const next = file.sessions.map((existing) => {
        const repl = incoming.get(existing.id);
        if (!repl) return existing;
        incoming.delete(existing.id);
        if (repl.finishedAt === existing.finishedAt && JSON.stringify(repl.people) === JSON.stringify(existing.people)) {
          return existing; // matched, but nothing about it actually differs — no write needed for this one
        }
        changed = true;
        updated.add(existing.id);
        return repl;
      });
      updatedIds = updated;
      // Whatever is left in `incoming` after every replacement is consumed
      // are genuinely new sessions. `next.length` here still equals the
      // store's own current size — every existing session was either kept
      // or replaced in place, never added or removed — so this is exactly
      // how much room is left under the cap, with no eviction involved.
      const toAdd = [...incoming.values()];
      const room = Math.max(0, MAX_SESSIONS - next.length);
      // `addedIds`, `updatedIds` and `full` all come from the SAME
      // toAdd/room/updated right here, at write time, rather than being
      // derived by the caller from a plan-time count — the store can change
      // between planning a rebuild and applying it (an operator deleting a
      // matched session, another save landing), and a caller subtracting a
      // stale plan-time count could go negative. Returning the real ids the
      // write itself just produced cannot.
      const writable = toAdd.slice(0, room);
      addedIds = new Set(writable.map((s) => s.id));
      full = toAdd.length - writable.length;
      for (const s of writable) {
        changed = true;
        next.push(s);
      }
      if (!changed) return file;
      return { ...file, sessions: next };
    });
    return { added: addedIds.size, addedIds, updated: updatedIds.size, updatedIds, full };
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
