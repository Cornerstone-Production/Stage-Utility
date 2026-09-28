import type { VideoPorts } from "../../types/video.ts";

export interface RelayUser {
  user: string;
  pass: string;
  ips: string[];
  permissions: { action: "publish" | "read" | "api"; path: string }[];
}

export const READER_USER: RelayUser = {
  user: "any",
  pass: "",
  ips: ["127.0.0.1", "::1"],
  // An EMPTY path means "any path" — confirmed against the real v1.21.1
  // binary (task-13-report.md): `path: "*"` authenticates against the LITERAL
  // path name "*", which no real feed is ever named, so every WHEP/WHIP read
  // and HLS request 401'd. The shipped mediamtx.yml says the same thing
  // ("An empty path means any path") but nothing here had driven a read
  // through the real binary before Task 13's proxy did.
  permissions: [
    { action: "read", path: "" },
    { action: "api", path: "" },
  ],
};

export function relayConfig({
  ports,
  lanIp,
  users,
}: {
  ports: VideoPorts;
  lanIp: string;
  users: RelayUser[];
}) {
  return {
    logLevel: "info",
    logDestinations: ["stdout"],
    authMethod: "internal",
    authInternalUsers: users,
    api: true,
    apiAddress: `127.0.0.1:${ports.api}`,
    metrics: false,
    pprof: false,
    playback: false,
    // No push kind uses RTSP and pulling RTSP needs no listener.
    rtsp: false,
    rtspEncryption: "no",
    rtmp: true,
    rtmpAddress: `:${ports.rtmp}`,
    rtmpEncryption: "no",
    hls: true,
    hlsAddress: `127.0.0.1:${ports.hls}`,
    hlsVariant: "lowLatency",
    webrtc: true,
    webrtcAddress: `127.0.0.1:${ports.webrtcHttp}`,
    webrtcLocalUDPAddress: `:${ports.webrtcUdp}`,
    webrtcLocalTCPAddress: "",
    webrtcAdditionalHosts: [lanIp],
    srt: true,
    srtAddress: `:${ports.srt}`,
    // v1.21.1 turns MoQ on by default and binds :8892 and :8893 on every interface.
    moq: false,
    pathDefaults: { overridePublisher: false },
    paths: {},
  };
}
