import type { VideoPorts } from "../../types/video.ts";

export interface RelayUser {
  user: string;
  pass: string;
  ips: string[];
  permissions: { action: "publish" | "read" | "api"; path: string }[];
}

/** Anyone on loopback may read — the playback proxy is the one reader. Not
 *  the API: that belongs to API_USER alone, so nothing else on this machine
 *  can read a pull feed's credentialed source from /v3/config/paths/list or
 *  reconfigure the relay. */
export const READER_USER: RelayUser = {
  user: "any",
  pass: "",
  ips: ["127.0.0.1", "::1"],
  // An EMPTY path means "any path" — confirmed against the real v1.21.1
  // binary: `path: "*"` authenticates against the LITERAL path name "*",
  // which no feed is ever named, so every WHEP/WHIP read and HLS request
  // answered 401.
  permissions: [{ action: "read", path: "" }],
};

/** The one user the relay's API accepts: this server's own MediaMtxRelay,
 *  from loopback, with a password made fresh for every relay start
 *  (relay-lifecycle.ts) and never written anywhere but the 0600 config. */
export function apiUser(pass: string): RelayUser {
  return { user: "stage-utility", pass, ips: ["127.0.0.1", "::1"], permissions: [{ action: "api", path: "" }] };
}

/** Anyone on loopback may publish to the `-listen` path of a feed that has one:
 *  that is where the server's own ffmpeg writes (audio-listen.ts). Only those
 *  exact paths, only from this machine, and no user of the LAN reaches the RTSP
 *  listener at all (it is bound to 127.0.0.1). */
export function listenPublisherUser(paths: string[]): RelayUser {
  return {
    user: "any",
    pass: "",
    ips: ["127.0.0.1", "::1"],
    permissions: paths.map((path) => ({ action: "publish" as const, path })),
  };
}

export function relayConfig({
  ports,
  lanIp,
  users,
  rtsp = false,
}: {
  ports: VideoPorts;
  lanIp: string;
  users: RelayUser[];
  /** Whether to bind the loopback RTSP listener the `-listen` paths need. */
  rtsp?: boolean;
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
    // No push kind uses RTSP and pulling RTSP needs no listener. The one reader
    // and publisher of RTSP here is this server's own ffmpeg, over TCP on
    // loopback, and only while ffmpeg is usable: no LAN listener, and with TCP
    // alone MediaMTX does not open its default UDP ports (8000, 8001) either.
    rtsp,
    ...(rtsp ? { rtspAddress: `127.0.0.1:${ports.rtsp}`, rtspTransports: ["tcp"] } : {}),
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
