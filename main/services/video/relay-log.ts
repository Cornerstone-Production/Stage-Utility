// relay-log.ts — reading MediaMTX's own log lines: its version, its last
// error, and a WebRTC session closed because the stream carries B-frames,
// paired with the path that session was reading, since the close line names
// only the session.

import { withoutCredentials } from "./redact-url.js";

export type RelayLogEvent =
  | { kind: "b-frames"; path: string }
  | { kind: "error"; text: string }
  /** A feed's `-listen` converter started, stopped or exited. `feedId` is the
   *  feed's id (the path without its `-listen`). `stopped` carries MediaMTX's
   *  reason ("not needed by anyone"); `exited` carries its error and the last
   *  line the converter itself printed since it started, credentials removed. */
  | { kind: "listen-started"; feedId: string }
  | { kind: "listen-stopped"; feedId: string; reason: string }
  | { kind: "listen-exited"; feedId: string; reason: string; lastOutput: string | null };

const READING = /\[WebRTC\] \[session ([0-9a-f]+)\] is reading from path '([^']+)'/;
const BFRAMES = /\[WebRTC\] \[session ([0-9a-f]+)\] closed: WebRTC doesn't support H264 streams with B-frames/;
const CLOSED = /\[WebRTC\] \[session ([0-9a-f]+)\] (?:closed|destroyed)/;
const VERSION = /INF MediaMTX (v\d+\.\d+\.\d+)/;
const ERROR = /(?:^ERR: | ERR )(.+)$/;
/** `INF [path cam-listen] runOnDemand command started|stopped: <why>|exited: <why>` */
const LISTEN = /\[path ([a-z0-9-]+)-listen\] runOnDemand command (started|stopped|exited)(?:: (.*))?$/;
/** MediaMTX's own line format. A line without it, while a converter runs, is the
 *  converter's own output: MediaMTX hands its stdout and stderr straight through. */
const MEDIAMTX_LINE = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} [A-Z]{3} /;
const OUTPUT_MAX = 300;

export class RelayLogWatcher {
  private sessions = new Map<string, string>();
  private lastErrorText: string | null = null;
  private versionString: string | null = null;
  /** The last line a converter printed since MediaMTX last started one. With two
   *  converters running at once their lines interleave, and this may be the
   *  other's: it is a clue for the log, not an attribution. */
  private lastForeign: string | null = null;

  line(text: string): RelayLogEvent | null {
    const versionMatch = text.match(VERSION);
    if (versionMatch) {
      this.versionString = versionMatch[1];
    }

    const errorMatch = text.match(ERROR);
    if (errorMatch) {
      // The relay's own error lines can echo a credentialed URL back
      // verbatim (a real v1.21.1 binary given a malformed pull source did
      // exactly this) — lastError() is what the supervisor turns into its
      // exit reason (status.reason, and the "relay exited" log line), so
      // stripped here, at the one place this text is captured, rather than
      // trusted to every future reader of lastError() to strip it itself.
      const stripped = withoutCredentials(errorMatch[1]!);
      this.lastErrorText = stripped;
      return { kind: "error", text: stripped };
    }

    const listenMatch = text.match(LISTEN);
    if (listenMatch) {
      const feedId = listenMatch[1]!;
      const what = listenMatch[2];
      const reason = withoutCredentials((listenMatch[3] ?? "").trim());
      if (what === "started") {
        this.lastForeign = null;
        return { kind: "listen-started", feedId };
      }
      if (what === "stopped") return { kind: "listen-stopped", feedId, reason };
      const lastOutput = this.lastForeign;
      this.lastForeign = null;
      return { kind: "listen-exited", feedId, reason, lastOutput };
    }

    const readingMatch = text.match(READING);
    if (readingMatch) {
      const sessionId = readingMatch[1];
      const path = readingMatch[2];
      this.sessions.set(sessionId, path);
      // Bounded: a session that never logs a close must not stay for ever.
      if (this.sessions.size > 256) {
        const firstKey = this.sessions.keys().next().value as string;
        this.sessions.delete(firstKey);
      }
      return null;
    }

    const bframesMatch = text.match(BFRAMES);
    if (bframesMatch) {
      const sessionId = bframesMatch[1];
      const pathValue = this.sessions.get(sessionId);
      this.sessions.delete(sessionId);
      if (typeof pathValue === "string") {
        return { kind: "b-frames", path: pathValue };
      }
      return null;
    }

    const closedMatch = text.match(CLOSED);
    if (closedMatch) {
      const sessionId = closedMatch[1];
      this.sessions.delete(sessionId);
      return null;
    }

    if (!MEDIAMTX_LINE.test(text) && text.trim() !== "") {
      this.lastForeign = withoutCredentials(text.trim()).slice(0, OUTPUT_MAX);
    }
    return null;
  }

  lastError(): string | null {
    return this.lastErrorText;
  }

  /** A new relay process: its sessions and its last error start empty, so
   *  an exit never reports an earlier process's error. The version stays,
   *  the same binary's until the new one prints its own. */
  newProcess(): void {
    this.sessions.clear();
    this.lastErrorText = null;
    this.lastForeign = null;
  }

  version(): string | null {
    return this.versionString;
  }
}
