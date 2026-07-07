// log-buffer.ts — In-memory ring buffer of recent server log lines, exposed at
// /log for remote debugging without SSH. Patches console.* so all existing logs
// are captured; bounded (last MAX lines) so it can never grow without limit.
//
// initLogCapture() must run BEFORE other modules log, so call it first in server.ts.

const MAX = 500;

export interface LogLine {
  /** ISO timestamp. */
  t: string;
  level: "log" | "info" | "warn" | "error";
  msg: string;
}

const lines: LogLine[] = [];
let installed = false;

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function record(level: LogLine["level"], args: unknown[]): void {
  const msg = args
    .map((a) =>
      typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : safeStringify(a),
    )
    .join(" ");
  lines.push({ t: new Date().toISOString(), level, msg });
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
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
