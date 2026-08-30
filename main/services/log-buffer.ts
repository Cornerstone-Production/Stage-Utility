// log-buffer.ts — In-memory ring buffer of recent server log lines, exposed at
// /log for remote debugging without SSH. Patches console.* so all existing logs
// are captured; bounded (last MAX lines) so it can never grow without limit.
//
// initLogCapture() must run BEFORE other modules log, so call it first in server.ts.

// Held in memory and mirrored to disk by log-persist.ts, which replays this many
// lines back on boot — so /log shows the run-up to a restart, not just what has
// happened since. ~10k lines is a couple of MB at typical length.
const MAX = 10_000;

/** Set by log-persist to mirror each line to disk. Kept as a hook rather than a
 *  direct import so log-buffer stays dependency-free and safe to load first. */
let sink: ((line: LogLine) => void) | null = null;
export function setLogSink(fn: (line: LogLine) => void): void {
  sink = fn;
}

export type LogLevel = "log" | "info" | "warn" | "error";

/** A line as it is stored on disk and replayed back — no sequence number,
 *  because a sequence number only means anything within one process. */
export interface StoredLogLine {
  /** ISO timestamp. */
  t: string;
  level: LogLevel;
  msg: string;
}

export interface LogLine extends StoredLogLine {
  /**
   * Monotonic, per-process, assigned in push() and never reused.
   *
   * It exists so /log can poll incrementally. The viewer refetched the whole
   * buffer every 2 seconds; measured on a freshly booted server that is already
   * 140 KB, and a full 10,000-line buffer projects to ~1.5 MB — per poll, per
   * open tab, off a Raspberry Pi. `?since=` turns the steady state into a few
   * hundred bytes.
   *
   * Deliberately NOT persisted: on replay the lines are pushed back through
   * push() and get fresh numbers, so a seq always means the same line for as
   * long as a client's connection to THIS process lasts, and never survives a
   * restart to mean something else.
   */
  seq: number;
}

const lines: LogLine[] = [];
let nextSeq = 1;
let installed = false;

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** The one place a line enters the buffer, so seq assignment and the cap cannot
 *  drift between the console patch and the direct-append path. */
function push(level: LogLevel, msg: string, t: string): LogLine {
  const line: LogLine = { seq: nextSeq++, t, level, msg };
  lines.push(line);
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
  return line;
}

function record(level: LogLevel, args: unknown[]): void {
  const msg = args
    .map((a) =>
      typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : safeStringify(a),
    )
    .join(" ");
  sink?.(push(level, msg, new Date().toISOString()));
}

/** Patch console.{log,info,warn,error} to also capture into the ring buffer. The
 *  original still writes to stdout/stderr; capture never throws. Idempotent. */
export function initLogCapture(): void {
  if (installed) return;
  installed = true;
  (["log", "info", "warn", "error"] as const).forEach((level) => {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      try {
        record(level, args);
      } catch {
        /* never let logging break the app */
      }
    };
  });
}

/** Snapshot of the buffered lines, oldest → newest. */
export function getLogLines(): LogLine[] {
  return lines.slice();
}

/** How many warnings and errors the buffer is currently holding.
 *
 *  Counted here rather than by copying the buffer out to count it: /log asks on
 *  every 2-second poll, and slicing 10,000 objects to look at one field of each
 *  would give back most of what `?since=` just saved. */
export function getLevelCounts(): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const l of lines) {
    if (l.level === "error") errors++;
    else if (l.level === "warn") warnings++;
  }
  return { errors, warnings };
}

/** What a client polling /api/log gets back. */
export interface LogSlice {
  lines: LogLine[];
  /**
   * Replace, do not append. True when the caller asked for everything, or when
   * the buffer has rolled past what they last saw — in which case appending
   * would silently leave a hole where the dropped lines were.
   */
  reset: boolean;
  /** Highest seq now in the buffer; 0 when it is empty. Pass back as `since`. */
  latestSeq: number;
}

/**
 * Lines newer than `since`, or everything when `since` is null or has already
 * been evicted.
 *
 * The eviction test compares against the OLDEST retained seq rather than
 * counting: a client that has seen seq N is only safe to append to if seq N+1 is
 * still here to prove nothing between them was dropped.
 */
export function getLogSince(since: number | null): LogSlice {
  const latestSeq = lines.length ? lines[lines.length - 1].seq : 0;
  const oldest = lines.length ? lines[0].seq : 0;
  if (since === null || !Number.isFinite(since) || since < 0) {
    return { lines: lines.slice(), reset: true, latestSeq };
  }
  if (lines.length > 0 && since + 1 < oldest) {
    return { lines: lines.slice(), reset: true, latestSeq };
  }
  return { lines: lines.filter((l) => l.seq > since), reset: false, latestSeq };
}

/** Push a line directly into the buffer (bypassing console). Used to seed the
 *  buffer at startup with logs that pre-date this process — e.g. replaying the
 *  last update's activity from the persisted update.log so it survives the
 *  restart. `t` preserves the original timestamp when known. */
export function addLogLine(level: LogLevel, msg: string, t?: string): void {
  push(level, msg, t ?? new Date().toISOString());
}
