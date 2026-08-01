// log-persist.ts — keeps the /log history across restarts.
//
// The ring buffer in log-buffer.ts is memory only, so every restart — an update,
// a crash, a power cut, `systemctl restart` — erased the record of what led up to
// it. That is exactly the window you want to read afterwards.
//
// Lines are appended to a size-capped file and the tail is replayed into the ring
// buffer at startup. Two things keep it cheap:
//
//   Writes are batched. Patching console.* means this sits behind every log call
//   in the app, and an fs.appendFileSync per line would put a synchronous disk
//   write on the hot path — including inside the 1 Hz recorder loops. Lines are
//   queued and flushed on a timer instead.
//
//   The file is hard-capped and trimmed at a line boundary, so it cannot grow
//   without limit however long the server runs.

import * as fs from "node:fs";
import * as path from "node:path";

import { getUserDataPath } from "./app-paths.js";
import { addLogLine, setLogSink, type LogLine } from "./log-buffer.js";

/** Roughly 10k lines at typical length, hard-capped by bytes rather than count so
 *  a burst of long lines cannot blow past it. */
const MAX_BYTES = 4 * 1024 * 1024;
/** How many lines to restore into the buffer on boot. */
export const REPLAY_LINES = 10_000;
/** Batch window — long enough to coalesce a burst, short enough that a crash
 *  loses at most this much. */
const FLUSH_MS = 2000;

let queue: string[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

export function serverLogPath(): string {
  return path.join(getUserDataPath(), "server.log");
}

/** Queue one line. Never throws, never touches the disk on the caller's thread. */
export function persistLogLine(line: LogLine): void {
  // A tab-separated head keeps the parse on replay unambiguous even when the
  // message itself contains spaces or colons.
  queue.push(`${line.t}\t${line.level}\t${line.msg.replace(/\n/g, "\\n")}`);
}

export function flushLogQueue(): void {
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  try {
    fs.appendFileSync(serverLogPath(), batch.join("\n") + "\n");
    trim();
  } catch {
    /* logging must never break the app */
  }
}

/** Keep only the last MAX_BYTES, cut at a line boundary so no partial line survives. */
function trim(): void {
  try {
    const p = serverLogPath();
    const size = fs.statSync(p).size;
    if (size <= MAX_BYTES) return;
    const buf = fs.readFileSync(p);
    const slice = buf.subarray(buf.length - MAX_BYTES);
    const nl = slice.indexOf(0x0a);
    fs.writeFileSync(p, nl >= 0 ? slice.subarray(nl + 1) : slice);
  } catch {
    /* ignore */
  }
}

/** Last `maxLines` persisted lines, oldest → newest. */
export function readServerLogTail(maxLines = REPLAY_LINES): LogLine[] {
  let raw: string;
  try {
    raw = fs.readFileSync(serverLogPath(), "utf8");
  } catch {
    return []; // nothing persisted yet
  }
  const out: LogLine[] = [];
  for (const l of raw.split("\n").filter(Boolean).slice(-maxLines)) {
    const a = l.indexOf("\t");
    const b = a >= 0 ? l.indexOf("\t", a + 1) : -1;
    if (a < 0 || b < 0) {
      out.push({ t: "", level: "log", msg: l }); // pre-format or hand-edited line
      continue;
    }
    const level = l.slice(a + 1, b) as LogLine["level"];
    out.push({
      t: l.slice(0, a),
      level: ["log", "info", "warn", "error"].includes(level) ? level : "log",
      msg: l.slice(b + 1).replace(/\\n/g, "\n"),
    });
  }
  return out;
}

/**
 * Replay the previous run's tail into the buffer, then start batching new lines.
 *
 * Call after initLogCapture() so the patch is already in place, and after the
 * data directory is known.
 */
export function initLogPersistence(): void {
  const tail = readServerLogTail();
  if (tail.length) {
    addLogLine("info", `---- ${tail.length} line(s) from before the last restart ----`);
    for (const l of tail) addLogLine(l.level, l.msg, l.t || undefined);
    addLogLine("info", "---- restarted ----");
  }
  // Only start mirroring AFTER the replay, so replayed lines are not written back.
  setLogSink(persistLogLine);
  if (!flushTimer) {
    flushTimer = setInterval(flushLogQueue, FLUSH_MS);
    flushTimer.unref?.();
  }
  // Best-effort flush on the way out so the last seconds before a restart or a
  // deliberate shutdown are not the ones that go missing.
  for (const sig of ["exit", "SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => flushLogQueue());
  }
}
