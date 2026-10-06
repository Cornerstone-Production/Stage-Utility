// main/services/video/port-check.ts — which of the relay's ports are already
// taken, and by what, before the relay is asked to bind them.
//
// A port already in use is not a MediaMTX error worth decoding: it is
// answered here, up front, the same way the rest of the app reports a taken
// port (port-holder.ts), so the Video relay card in Advanced can say WHO is
// holding 1935 rather than just that the relay would not start.

import * as dgram from "node:dgram";
import * as net from "node:net";

import type { VideoPorts } from "../../types/video.js";
import { portHolder, type PortHolder } from "../port-holder.js";

export interface BusyPort {
  port: number;
  proto: "tcp" | "udp";
  /** As parts — see port-holder.ts's holderPhrase for why the caller, not
   *  this module, words it. */
  holder: PortHolder;
}

interface PortSpec {
  port: number;
  proto: "tcp" | "udp";
  /** 127.0.0.1 for a listener the relay's own config keeps loopback-only;
   *  0.0.0.0 for one of the LAN inputs — see "Configuration" in the design
   *  doc for which port is which. */
  host: string;
}

function specsFor(ports: VideoPorts): PortSpec[] {
  return [
    { port: ports.rtmp, proto: "tcp", host: "0.0.0.0" },
    { port: ports.srt, proto: "udp", host: "0.0.0.0" },
    { port: ports.webrtcUdp, proto: "udp", host: "0.0.0.0" },
    { port: ports.webrtcHttp, proto: "tcp", host: "127.0.0.1" },
    { port: ports.hls, proto: "tcp", host: "127.0.0.1" },
    { port: ports.api, proto: "tcp", host: "127.0.0.1" },
  ];
}

/** True if something else is already listening — bind, then immediately
 *  release, so this never actually holds the port itself. */
function tcpBusy(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen({ port, host });
  });
}

function udpBusy(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    // A failed bind still leaves the socket open; closed here, or every
    // retry against a taken port leaks one socket and its descriptor.
    socket.once("error", () => socket.close(() => resolve(true)));
    socket.once("listening", () => socket.close(() => resolve(false)));
    socket.bind(port, host);
  });
}

/**
 * Every one of the relay's six ports that is already taken, each with who is
 * holding it (port-holder.ts's portHolder). A port nobody is using is left
 * out entirely — the caller only ever wants the ones that are a problem.
 */
export async function busyPorts(ports: VideoPorts): Promise<BusyPort[]> {
  const specs = specsFor(ports);
  const results = await Promise.all(
    specs.map(async (spec): Promise<BusyPort | null> => {
      const busy = spec.proto === "tcp" ? await tcpBusy(spec.port, spec.host) : await udpBusy(spec.port, spec.host);
      if (!busy) return null;
      return { port: spec.port, proto: spec.proto, holder: await portHolder(spec.port, spec.proto) };
    }),
  );
  return results.filter((r): r is BusyPort => r !== null);
}
