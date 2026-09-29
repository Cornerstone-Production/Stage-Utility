import { deepEqual, strictEqual } from "assert";
import { describe, it } from "node:test";
import { RelayLogWatcher } from "./relay-log.ts";

describe("RelayLogWatcher", () => {
  it("parses the B-frames fixture lines in order", () => {
    const watcher = new RelayLogWatcher();

    const lines = [
      "2026/09/27 17:47:50 INF [WebRTC] [session b84d469e] created by 127.0.0.1:52936",
      "2026/09/27 17:47:50 INF [WebRTC] [session b84d469e] peer connection established, local candidate: host/udp/127.0.0.1/18189, remote candidate: prflx/udp/127.0.0.1/60195",
      "2026/09/27 17:47:50 INF [WebRTC] [session b84d469e] is reading from path 'bframes', 1 track (H264)",
      "2026/09/27 17:47:50 INF [WebRTC] [session b84d469e] closed: WebRTC doesn't support H264 streams with B-frames",
    ];

    const result0 = watcher.line(lines[0]);
    const result1 = watcher.line(lines[1]);
    const result2 = watcher.line(lines[2]);
    const result3 = watcher.line(lines[3]);

    strictEqual(result0, null);
    strictEqual(result1, null);
    strictEqual(result2, null);
    deepEqual(result3, { kind: "b-frames", path: "bframes" });
  });

  it("returns null for a close line of an unknown session", () => {
    const watcher = new RelayLogWatcher();
    const result = watcher.line(
      "2026/09/27 17:47:50 INF [WebRTC] [session unknown123] closed: something"
    );
    strictEqual(result, null);
  });

  it("parses version from startup line", () => {
    const watcher = new RelayLogWatcher();
    watcher.line(
      "2026/09/27 18:05:03 INF MediaMTX v1.21.1, darwin, arm64"
    );
    strictEqual(watcher.version(), "v1.21.1");
  });

  it("parses errors from both formats", () => {
    const watcher1 = new RelayLogWatcher();
    const result1 = watcher1.line(
      "ERR: json: unknown field \"rtsps\""
    );
    deepEqual(result1, { kind: "error", text: "json: unknown field \"rtsps\"" });
    strictEqual(watcher1.lastError(), "json: unknown field \"rtsps\"");

    const watcher2 = new RelayLogWatcher();
    const result2 = watcher2.line(
      "2026/09/27 18:00:33 ERR [API] path already exists"
    );
    deepEqual(result2, { kind: "error", text: "[API] path already exists" });
    strictEqual(watcher2.lastError(), "[API] path already exists");
  });

  // A real v1.21.1 binary given a malformed pull source echoed the
  // WHOLE credentialed URL back in exactly this shape — lastError() is what
  // supervisor.ts turns into its exit reason (status.reason, and the
  // "relay exited" log line), so this must never carry it through.
  it("strips a user:pass@ userinfo out of an ERR line before it becomes lastError()", () => {
    const watcher = new RelayLogWatcher();
    const result = watcher.line(
      "2026/09/27 18:00:33 ERR [API] 'rtsp://admin:s3c%!z(MISSING)ret@192.0.2.1/s' is not a valid URL"
    );
    deepEqual(result, { kind: "error", text: "[API] 'rtsp://192.0.2.1/s' is not a valid URL" });
    strictEqual(watcher.lastError(), "[API] 'rtsp://192.0.2.1/s' is not a valid URL");
    strictEqual(watcher.lastError()?.includes("admin"), false, "the username must not survive either");
    strictEqual(watcher.lastError()?.includes("s3c"), false, "no fragment of the password may survive");
  });

  it("strips an SRT pull's passphrase out of an ERR line before it becomes lastError()", () => {
    const watcher = new RelayLogWatcher();
    watcher.line("2026/09/28 21:40:02 ERR [API] 'srt://ho%zzst:9000?passphrase=SECRETPASS123' is not a valid URL");
    strictEqual(watcher.lastError()?.includes("SECRETPASS123"), false, "the passphrase must not survive into an exit reason");
    strictEqual(watcher.lastError(), "[API] 'srt://ho%zzst:9000?passphrase=<redacted>' is not a valid URL");
  });

  it("maintains session map with 256-entry limit", () => {
    const watcher = new RelayLogWatcher();

    // Feed 300 "is reading" lines to exceed the 256 limit
    for (let i = 0; i < 300; i++) {
      const sessionId = i.toString(16).padStart(8, "0");
      watcher.line(
        `2026/09/27 17:47:50 INF [WebRTC] [session ${sessionId}] is reading from path 'stream', 1 track (H264)`
      );
    }

    // The first session (0x00000000) should have been evicted
    const firstSessionId = "00000000";
    const result = watcher.line(
      `2026/09/27 17:47:50 INF [WebRTC] [session ${firstSessionId}] closed: WebRTC doesn't support H264 streams with B-frames`
    );
    // Should return null because the session is not in the map
    strictEqual(result, null);

    // The last session (0x0000012b = 299) should still be there
    const lastSessionId = (299).toString(16).padStart(8, "0");
    const result2 = watcher.line(
      `2026/09/27 17:47:50 INF [WebRTC] [session ${lastSessionId}] closed: WebRTC doesn't support H264 streams with B-frames`
    );
    deepEqual(result2, { kind: "b-frames", path: "stream" });
  });
});
