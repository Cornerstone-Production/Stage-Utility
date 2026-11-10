// preload.ts — loaded into the screenshot server with `node --import`.
//
// The server under capture runs the app's own, unmodified code. This file changes
// what its process can reach, so a screenshot run cannot touch anything real:
//
//   fetch                 Planning Center (api.planningcenteronline.com) is answered
//                         by fakes/pco.ts. Loopback is left alone. Every other host
//                         is refused, so nothing leaves the machine and no update
//                         check, scores feed or photo CDN is ever contacted.
//   net.Socket.connect    the invented wireless receivers (192.168.1.41/42:2202)
//                         are redirected to fakes/shure.ts on loopback. Any other
//                         connection to a private address goes to loopback port 1
//                         and is refused: the invented cameras are never dialled.
//   UDP                   a datagram to a private address (an OSC target, a
//                         discovery reply to a pretend Pi) is redirected to
//                         loopback, where nothing listens. A probe from a pretend
//                         device arrives from loopback; it is given the LAN source
//                         address the device claims, so the Screens page names it.
//   os.networkInterfaces  the machine reports 192.168.1.20, so the connect QR, the
//                         "open on the LAN" addresses and video push URLs name an
//                         invented address rather than this Mac's own.
//
// The kiosk discovery port itself is moved in the scratch settings.json (see
// lib/server.ts), so the real Mac helper's probes on UDP 8789 are never answered.
//
// Controlled by the orchestrator through the environment:
//   DOCS_SHOT_NOW         ISO instant the invented world is anchored to
//   DOCS_SHOT_STATE_FILE  JSON file re-read per Planning Center request: {"live": bool}

import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

import { handlePco } from "./fakes/pco.ts";
import { startFakeShure } from "./fakes/shure.ts";
import { FAKE_DEVICES, SERVER_LAN_IP, WIRELESS_CHANNELS } from "./world.ts";

const PCO_HOST = "api.planningcenteronline.com";
const PCO_PREFIX = "/services/v2";

/** An address on a private network: nothing there is real, and nothing may be dialled. */
const isPrivate = (host: unknown): boolean => typeof host === "string" && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
const isLoopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";

// ── time ──────────────────────────────────────────────────────────────────────

const startedAt = Date.now();
/** `now` for the plans: the anchor, moved forward by however long the server has run. */
function anchoredNow() {
  const anchor = process.env.DOCS_SHOT_NOW;
  return anchor ? new Date(Date.parse(anchor) + (Date.now() - startedAt)) : new Date();
}

function liveMode() {
  const file = process.env.DOCS_SHOT_STATE_FILE;
  if (!file) return false;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).live === true;
  } catch {
    return false;
  }
}

// ── fetch ─────────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  if (url.hostname === PCO_HOST && url.pathname.startsWith(PCO_PREFIX)) {
    const answer = handlePco(url.pathname.slice(PCO_PREFIX.length), url.searchParams, { now: anchoredNow(), live: liveMode() });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }
  if (isLoopback(url.hostname)) return realFetch(input, init);
  console.warn(`[docs-screenshots] refused a request to ${url.hostname}: the screenshot server is offline by design`);
  throw new TypeError(`fetch failed: ${url.hostname} is not reachable from the screenshot server`);
};

// ── TCP: the wireless receivers ───────────────────────────────────────────────

const fakeShure = await startFakeShure();
const RECEIVER_HOSTS = new Set(Object.keys(WIRELESS_CHANNELS));

// The patched methods are overloaded and take their arguments positionally, so the
// replacements take them as a list and are cast back to the method they replace.
const realConnect = net.Socket.prototype.connect as (...args: any[]) => net.Socket;
net.Socket.prototype.connect = function connect(this: net.Socket, ...args: any[]) {
  const [first, second] = args;
  const options = typeof first === "object" && first !== null && !Array.isArray(first);
  const host = options ? first.host : second;
  if (RECEIVER_HOSTS.has(host)) {
    this.once("connect", () => fakeShure.expect(this.localPort, host));
    if (options) args[0] = { ...first, host: "127.0.0.1", port: fakeShure.port };
    else {
      args[0] = fakeShure.port;
      args[1] = "127.0.0.1";
    }
  } else if (isPrivate(host)) {
    if (options) args[0] = { ...first, host: "127.0.0.1", port: 1 };
    else {
      args[0] = 1;
      args[1] = "127.0.0.1";
    }
  }
  return realConnect.apply(this, args);
} as typeof net.Socket.prototype.connect;

// ── UDP ───────────────────────────────────────────────────────────────────────

const realSend = dgram.Socket.prototype.send as (...args: any[]) => void;
dgram.Socket.prototype.send = function send(this: dgram.Socket, ...args: any[]) {
  return realSend.apply(
    this,
    args.map((a) => (isPrivate(a) ? "127.0.0.1" : a)),
  );
} as typeof dgram.Socket.prototype.send;

const realEmit = dgram.Socket.prototype.emit as (event: string | symbol, ...args: any[]) => boolean;
dgram.Socket.prototype.emit = function emit(this: dgram.Socket, event: string | symbol, ...args: any[]) {
  if (event === "message" && args[1]?.address === "127.0.0.1") {
    try {
      const device = FAKE_DEVICES.find((d) => d.id === JSON.parse(String(args[0])).id);
      if (device) args[1] = { ...args[1], address: device.ip };
    } catch {
      /* not a probe */
    }
  }
  return realEmit.call(this, event, ...args);
} as typeof dgram.Socket.prototype.emit;

// ── the machine's own address ─────────────────────────────────────────────────

os.networkInterfaces = () => ({
  en0: [
    {
      address: SERVER_LAN_IP,
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "02:00:00:00:00:01",
      internal: false,
      cidr: `${SERVER_LAN_IP}/24`,
    },
  ],
});
syncBuiltinESMExports();
