// What `boards:changed` carries: which slot boards changed, never what is on them.

/** One board a write to slots.json changed. */
export interface BoardChange {
  id: string;
  /** Its name or column width changed, or it was created or deleted. */
  meta: boolean;
  /** Which of its layouts changed, sorted: `default:<serviceTypeId>` or `plan:<planId>`. */
  targets: string[];
}

/**
 * The last write to slots.json, and where it sits in this server's sequence.
 *
 * `seq` is bumped on EVERY write, so a client that sees a frame which is not
 * the one after the last it saw (or an `epoch` it has not seen: the server
 * restarted, a restore among the ways) has missed a change and re-reads every
 * board rather than trust the list. The connect burst re-sends the last frame.
 */
export interface BoardsChanged {
  /** This server process. */
  epoch: string;
  /** 0 until the first write since the process started. */
  seq: number;
  /** Sorted by id. Empty on seq 0. */
  boards: BoardChange[];
}

/** The SSE channel that carries a {@link BoardsChanged}. */
export const BOARDS_CHANGED_CHANNEL = "boards:changed";
