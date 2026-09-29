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

/** ss's own connection-state column — never a program name. An unprivileged
 *  `ss` asked about another user's socket prints the state and every OTHER
 *  column ("LISTEN 0 4096 0.0.0.0:1935 0.0.0.0:*") with no "users:(())" at
 *  all — nothing to name the holder with. Item 5 (findings-t15-r3.md): that
 *  shape still matched the lsof regex below (a word, then a number), and
 *  read "LISTEN (pid 0)". */
const SS_STATE_TOKENS = new Set([
  "LISTEN",
  "ESTAB",
  "SYN-SENT",
  "SYN-RECV",
  "FIN-WAIT-1",
  "FIN-WAIT-2",
  "TIME-WAIT",
  "CLOSE",
  "CLOSE-WAIT",
  "LAST-ACK",
  "CLOSING",
  "UNCONN",
]);

/**
 * `describePortHolder()`'s own two shapes, reduced to a bare PHRASE — every
 * caller here embeds the result in "Port X is in use by <holder>.", and a
 * full SENTENCE in that spot reads as two run together. Whatever
 * `rawPortHolder()` fell back to (`lsof`'s or `ss`'s raw listing line) is a
 * diagnostic dump, not a sentence either: "node    43580 hstreuber   12u
 * IPv6 0x8c0d35a89313ccc8      0t0  TCP *:51935 (LISTEN)" on the Video
 * feeds page, where the operator needs "what is using this port", not
 * every column `lsof`/`ss` prints. Reduced to "node (pid 43580)" or
 * "another Stage Utility (version X, pid Y)" when a shape parses; left
 * exactly as `describePortHolder()` returned it otherwise — never worse
 * than the raw text, only sometimes shorter.
 */
export function shortenHolder(holder: string): string {
  // "another Stage Utility is already serving :1935 — version 1.24.0, pid
  // 200. If that is not the service you expect, ..." — item 12
  // (findings-t15-r3.md): embedded as-is this produced "Port 1935 is in
  // use by another Stage Utility is already serving :1935 — version...",
  // naming the port twice and reading as two sentences run together.
  // Anchored on port-holder.ts's own trailing "If that is not the service
  // you expect" sentence, not a bare "up to the next period" — the parts
  // this captures always include "version X.Y.Z", whose OWN periods a
  // generic stop-at-period match would cut short at (confirmed: an
  // earlier version of this regex returned "version 1" for "version
  // 1.24.0, pid 200, ...").
  const another = holder.match(/^another Stage Utility is already serving :\d+ — (.+?)\. If that is not the service you expect/);
  if (another) return `another Stage Utility (${another[1]})`;
  // ss -lptn: "...users:(("node",pid=43580,fd=12))" — checked BEFORE lsof's
  // shape below, which would otherwise match ss's own leading
  // "LISTEN 0 128 ..." columns first (a word, then a number) and report the
  // socket's state as if it were the holding program's name.
  const ss = holder.match(/users:\(\("([^"]+)",pid=(\d+)/);
  if (ss) return `${ss[1]} (pid ${ss[2]})`;
  // lsof -nP -iTCP:<port> -sTCP:LISTEN: "COMMAND   PID USER   FD ...".
  const lsof = holder.match(/^(\S+)\s+(\d+)\s/);
  if (lsof && !SS_STATE_TOKENS.has(lsof[1]!)) return `${lsof[1]} (pid ${lsof[2]})`;
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
      return { port: spec.port, proto: spec.proto, holder: shortenHolder(await describePortHolder(spec.port, spec.proto)) };
    }),
  );
  return results.filter((r): r is BusyPort => r !== null);
}
