import { deepEqual, strictEqual } from "assert";
import { describe, it } from "node:test";
import { apiUser, relayConfig, READER_USER, type RelayUser } from "./mediamtx-config.ts";
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

  it("READER_USER reads from loopback, and nothing else", () => {
    strictEqual(READER_USER.user, "any");
    strictEqual(READER_USER.pass, "");
    deepEqual(READER_USER.ips, ["127.0.0.1", "::1"]);
    // Empty, not "*" — MediaMTX treats "*" as a literal path name (confirmed
    // against the real v1.21.1 binary), which never matches a real feed id.
    deepEqual(READER_USER.permissions, [{ action: "read", path: "" }]);
  });
});

/**
 * MediaMTX's internal authentication, reduced to what decides an API call:
 * a user entry matches when its name is "any" (anyone, no password) or the
 * credentials are its own, from one of its ips; the call is allowed when a
 * matching entry grants "api". Enough to ask the generated config the one
 * question that matters — can anything on loopback reach the API without
 * the password — and to be driven once against the real binary.
 */
function allowsApi(users: RelayUser[], creds: { user: string; pass: string }): boolean {
  return users.some(
    (u) =>
      (u.user === "any" || (u.user === creds.user && u.pass === creds.pass)) &&
      u.ips.includes("127.0.0.1") &&
      u.permissions.some((p) => p.action === "api"),
  );
}

describe("the relay API's own user", () => {
  const ports: VideoPorts = { rtmp: 1935, srt: 8890, webrtcUdp: 8189, webrtcHttp: 8889, hls: 8888, api: 9997 };
  const config = relayConfig({ ports, lanIp: "192.0.2.1", users: [READER_USER, apiUser("s3cret-api-pw")] });

  it("an unauthenticated API request is refused by the generated config", () => {
    strictEqual(allowsApi(config.authInternalUsers, { user: "", pass: "" }), false);
    strictEqual(allowsApi(config.authInternalUsers, { user: "any", pass: "" }), false);
  });

  it("the API user's own credentials are allowed, from loopback only", () => {
    const user = apiUser("s3cret-api-pw");
    strictEqual(allowsApi(config.authInternalUsers, { user: user.user, pass: "s3cret-api-pw" }), true);
    strictEqual(allowsApi(config.authInternalUsers, { user: user.user, pass: "wrong" }), false);
    deepEqual(user.ips, ["127.0.0.1", "::1"]);
    deepEqual(user.permissions, [{ action: "api", path: "" }]);
  });
});
