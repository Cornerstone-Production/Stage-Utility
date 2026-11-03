// What the Mic slots page re-reads when `boards:changed` speaks.
//
// The frame names the boards a write to slots.json changed, numbered in the
// server's sequence. A frame that is the next one is acted on as named; one that
// is not (a reconnect missed some, or the server restarted, which a restore
// always does) says this page cannot know what changed, so it re-reads all.

import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { BoardChange, BoardsChanged } from "@main/types/boards-changed";

/** The named boards, "all" when a change may have been missed, or null for nothing. */
export function boardsToReread(prev: BoardsChanged | null, next: BoardsChanged, replayed: boolean): BoardChange[] | "all" | null {
  // A replay is the cached last frame, from before this page read anything: its
  // own reads are newer. It is only where the count stands.
  if (replayed) return null;
  if (!prev) return next.boards;
  if (next.epoch !== prev.epoch) return "all";
  if (next.seq === prev.seq) return null;
  if (next.seq === prev.seq + 1) return next.boards;
  return "all";
}

/** Whether a `boards:targets` query key ([, boardId, serviceTypeId, planId]) reads a layout this change touched. */
function readsChanged(key: QueryKey, change: BoardChange): boolean {
  if (key[0] !== "boards:targets" || key[1] !== change.id) return false;
  return change.targets.some((t) => t === `default:${String(key[2])}` || (key[3] != null && t === `plan:${String(key[3])}`));
}

/** Mark stale, and re-read where mounted, exactly what the change touched. */
export function rereadBoards(qc: QueryClient, what: BoardChange[] | "all", keys: { boards: QueryKey }): Promise<unknown> {
  if (what === "all") {
    return Promise.all([
      qc.invalidateQueries({ queryKey: keys.boards }),
      qc.invalidateQueries({ queryKey: ["boards:targets"] }),
      qc.invalidateQueries({ queryKey: ["boards:contents"] }),
      qc.invalidateQueries({ queryKey: ["boards:check"] }),
    ]);
  }
  const jobs: Promise<unknown>[] = [];
  // A board made, deleted, renamed or resized is in the list itself.
  if (what.some((c) => c.meta)) jobs.push(qc.invalidateQueries({ queryKey: keys.boards }));
  const layouts = what.filter((c) => c.targets.length > 0);
  if (layouts.length > 0) {
    jobs.push(qc.invalidateQueries({ predicate: (q) => layouts.some((c) => readsChanged(q.queryKey, c)) }));
    for (const c of layouts) jobs.push(qc.invalidateQueries({ queryKey: ["boards:contents", c.id] }));
    // Who has no slot is a question about every board's layout.
    jobs.push(qc.invalidateQueries({ queryKey: ["boards:check"] }));
  }
  return Promise.all(jobs);
}
