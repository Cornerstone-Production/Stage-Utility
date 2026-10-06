// main/services/video/ports.ts — validating a PATCH /api/video/ports body.
//
// Pure, so the rule ("six whole numbers, 1024-65535, all different") is
// tested against plain objects rather than through the route.

import type { VideoPorts } from "../../types/video.js";

/** Every key VideoPorts declares, in the order the config and the Advanced
 *  page's two groups both read it in: the three LAN inputs, then the three
 *  loopback-only listeners. */
export const PORT_KEYS = ["rtmp", "srt", "webrtcUdp", "webrtcHttp", "hls", "api"] as const;

const MIN_PORT = 1024;
const MAX_PORT = 65535;

export type ParsedPorts = { ok: true; ports: VideoPorts } | { ok: false; error: string };

/** Accepts only an integer 1024-65535 for every key, all six different from
 *  one another — the same six ports the relay itself binds (port-check.ts),
 *  so nothing here can invite two of them to collide before they ever reach
 *  a real bind() call. */
export function parsePorts(body: unknown): ParsedPorts {
  const obj = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
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
