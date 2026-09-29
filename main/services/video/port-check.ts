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
import { describePortHolder } from "../port-holder.js";

export interface BusyPort {
  port: number;
  proto: "tcp" | "udp";
  holder: string;
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
    socket.once("error", () => resolve(true));
    socket.once("listening", () => socket.close(() => resolve(false)));
    socket.bind(port, host);
  });
}

/**
 * `describePortHolder()`'s own "another Stage Utility" sentence is already
 * the right shape for an operator to read as-is. Its OTHER shape — whatever
 * `rawPortHolder()` fell back to, `lsof`'s or `ss`'s raw listing line — is
 * a diagnostic dump, not a sentence: "node    43580 hstreuber   12u  IPv6
 * 0x8c0d35a89313ccc8      0t0  TCP *:51935 (LISTEN)" on the Video feeds
 * page, where the operator needs "what is using this port", not every
 * column `lsof`/`ss` prints. Reduced to "node (pid 43580)" when either
 * shape parses; left exactly as `describePortHolder()` returned it
 * otherwise — never worse than the raw line, only sometimes shorter.
 */
export function shortenHolder(holder: string): string {
  if (holder.startsWith("another Stage Utility")) return holder;
  // ss -lptn: "...users:(("node",pid=43580,fd=12))" — checked BEFORE lsof's
  // shape below, which would otherwise match ss's own leading
  // "LISTEN 0 128 ..." columns first (a word, then a number) and report the
  // socket's state as if it were the holding program's name.
  const ss = holder.match(/users:\(\("([^"]+)",pid=(\d+)/);
  if (ss) return `${ss[1]} (pid ${ss[2]})`;
  // lsof -nP -iTCP:<port> -sTCP:LISTEN: "COMMAND   PID USER   FD ...".
  const lsof = holder.match(/^(\S+)\s+(\d+)\s/);
  if (lsof) return `${lsof[1]} (pid ${lsof[2]})`;
  return holder;
}

/**
 * Every one of the relay's six ports that is already taken, each with who is
 * holding it (`describePortHolder`, the same lookup `/api/version` itself
 * uses, shortened to a program and a pid — see `shortenHolder`). A port
 * nobody is using is left out entirely — the caller only ever wants the ones
 * that are a problem.
 */
export async function busyPorts(ports: VideoPorts): Promise<BusyPort[]> {
  const specs = specsFor(ports);
  const results = await Promise.all(
    specs.map(async (spec): Promise<BusyPort | null> => {
      const busy = spec.proto === "tcp" ? await tcpBusy(spec.port, spec.host) : await udpBusy(spec.port, spec.host);
      if (!busy) return null;
      return { port: spec.port, proto: spec.proto, holder: shortenHolder(await describePortHolder(spec.port)) };
    }),
  );
  return results.filter((r): r is BusyPort => r !== null);
}
