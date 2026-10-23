// main/services/video/ports.ts — validating a PATCH /api/video/ports body.
//
// Pure, so the rule (every port a whole number, 1024-65535, all different) is
// tested against plain objects rather than through the route.

import { DEFAULT_VIDEO_PORTS, type VideoPorts } from "../../types/video.js";

/** Every key VideoPorts declares, in the order the config and the Advanced
 *  page's two groups read it: the LAN inputs, then the loopback-only listeners.
 *  Typed as a Record so a port added to VideoPorts and left out of here fails to
 *  compile. */
const PORT_ORDER: Record<keyof VideoPorts, true> = { rtmp: true, srt: true, webrtcUdp: true, webrtcHttp: true, hls: true, api: true, rtsp: true };
export const PORT_KEYS = Object.keys(PORT_ORDER) as (keyof VideoPorts)[];

const MIN_PORT = 1024;
const MAX_PORT = 65535;

export type ParsedPorts = { ok: true; ports: VideoPorts } | { ok: false; error: string };

/** Accepts only an integer 1024-65535 for every key, all different from one
 *  another — the ports the relay itself binds (port-check.ts), so nothing here can
 *  invite two of them to collide before a real bind(). A body without `rtsp` (a
 *  file or page from before it existed) keeps `current`'s. */
export function parsePorts(body: unknown, current: VideoPorts = DEFAULT_VIDEO_PORTS): ParsedPorts {
  const obj = { rtsp: current.rtsp, ...(typeof body === "object" && body !== null ? body : {}) } as Record<string, unknown>;
  const ports = {} as VideoPorts;
  for (const key of PORT_KEYS) {
    const v = obj[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < MIN_PORT || v > MAX_PORT) {
      return { ok: false, error: `Every port must be a whole number from ${MIN_PORT} to ${MAX_PORT}.` };
    }
    ports[key] = v;
  }
  const values = PORT_KEYS.map((k) => ports[k]);
  if (new Set(values).size !== values.length) {
    return { ok: false, error: "Every port must be different." };
  }
  return { ok: true, ports };
}
