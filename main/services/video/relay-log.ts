import { withoutCredentials } from "./redact-url.js";

export type RelayLogEvent =
  | { kind: "b-frames"; path: string }
  | { kind: "error"; text: string };

const READING = /\[WebRTC\] \[session ([0-9a-f]+)\] is reading from path '([^']+)'/;
const BFRAMES = /\[WebRTC\] \[session ([0-9a-f]+)\] closed: WebRTC doesn't support H264 streams with B-frames/;
const CLOSED = /\[WebRTC\] \[session ([0-9a-f]+)\] (?:closed|destroyed)/;
const VERSION = /INF MediaMTX (v\d+\.\d+\.\d+)/;
const ERROR = /(?:^ERR: | ERR )(.+)$/;

export class RelayLogWatcher {
  private sessions = new Map<string, string>();
  private lastErrorText: string | null = null;
  private versionString: string | null = null;

  line(text: string): RelayLogEvent | null {
    // Check for version first
    const versionMatch = text.match(VERSION);
    if (versionMatch) {
      this.versionString = versionMatch[1];
    }

    // Check for errors
    const errorMatch = text.match(ERROR);
    if (errorMatch) {
      // R14j: the relay's own error lines can echo a credentialed URL back
      // verbatim (a real v1.21.1 binary given a malformed pull source did
      // exactly this) — lastError() is what the supervisor turns into its
      // exit reason (status.reason, and the "relay exited" log line), so
      // stripped here, at the one place this text is captured, rather than
      // trusted to every future reader of lastError() to strip it itself.
      const stripped = withoutCredentials(errorMatch[1]!);
      this.lastErrorText = stripped;
      return { kind: "error", text: stripped };
    }

    // Check for reading (session started)
    const readingMatch = text.match(READING);
    if (readingMatch) {
      const sessionId = readingMatch[1];
      const path = readingMatch[2];
      this.sessions.set(sessionId, path);
      // Keep only 256 most recent sessions
      if (this.sessions.size > 256) {
        const firstKey = this.sessions.keys().next().value as string;
        this.sessions.delete(firstKey);
      }
      return null;
    }

    // Check for B-frames error (session closed with B-frame error)
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

    // Check for other close/destroy (cleanup)
    const closedMatch = text.match(CLOSED);
    if (closedMatch) {
      const sessionId = closedMatch[1];
      this.sessions.delete(sessionId);
      return null;
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
  }

  version(): string | null {
    return this.versionString;
  }
}
