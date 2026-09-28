import { deepEqual, strictEqual } from "assert";
import { describe, it } from "node:test";
import { relayConfig, READER_USER } from "./mediamtx-config.ts";
import type { VideoPorts } from "../../types/video.ts";

describe("relayConfig", () => {
  it("produces the exact config structure with all keys pinned", () => {
    const ports: VideoPorts = {
      rtmp: 1935,
      srt: 8890,
      webrtcUdp: 8189,
      webrtcHttp: 8889,
      hls: 8888,
      api: 9997,
    };

    const config = relayConfig({
      ports,
      lanIp: "192.0.2.1",
      users: [READER_USER],
    });

    const expected = {
      logLevel: "info",
      logDestinations: ["stdout"],
      authMethod: "internal",
      authInternalUsers: [READER_USER],
      api: true,
      apiAddress: "127.0.0.1:9997",
      metrics: false,
      pprof: false,
      playback: false,
      rtsp: false,
      rtspEncryption: "no",
      rtmp: true,
      rtmpAddress: ":1935",
      rtmpEncryption: "no",
      hls: true,
      hlsAddress: "127.0.0.1:8888",
      hlsVariant: "lowLatency",
      webrtc: true,
      webrtcAddress: "127.0.0.1:8889",
      webrtcLocalUDPAddress: ":8189",
      webrtcLocalTCPAddress: "",
      webrtcAdditionalHosts: ["192.0.2.1"],
      srt: true,
      srtAddress: ":8890",
      moq: false,
      pathDefaults: { overridePublisher: false },
      paths: {},
    };

    deepEqual(config, expected);
  });

  it("READER_USER has the right structure", () => {
    strictEqual(READER_USER.user, "any");
    strictEqual(READER_USER.pass, "");
    deepEqual(READER_USER.ips, ["127.0.0.1", "::1"]);
    strictEqual(READER_USER.permissions.length, 2);
    // Empty, not "*" — MediaMTX treats "*" as a literal path name (confirmed
    // against the real v1.21.1 binary, task-13-report.md), which never
    // matches a real feed id.
    deepEqual(READER_USER.permissions[0], { action: "read", path: "" });
    deepEqual(READER_USER.permissions[1], { action: "api", path: "" });
  });
});
