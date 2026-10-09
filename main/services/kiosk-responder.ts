// The UDP half of enrolment: listen for probes, decide, answer.
//
// node:dgram, no dependency — the same broadcast/respond shape the OSC manager
// and the Sennheiser provider already use.
//
// Everything this module DECIDES lives in kiosk-discovery.ts as pure functions;
// what is left here is the socket, which is the part that cannot be unit tested
// and therefore should hold no policy.

import * as dgram from "node:dgram";
import { networkInterfaces } from "node:os";

import { decodeProbe, encodeReply, decideProbe, isFromThisMachine } from "./kiosk-discovery.js";
import { recordSeen, scanning, forgetSeen } from "./kiosk-presence.js";
import { kioskDevicesStore, findById, touch, updateDevices } from "./kiosk-devices-store.js";
import { DEFAULT_DISCOVERY_PORT } from "../types/kiosk.js";

export interface ResponderOptions {
  /** Stable per install. A device uses it to tell two servers apart. */
  serverId: string;
  /** Shown in Devices so a binding is attributable to a named server. */
  serverName: string;
  /** How a device should reach us, e.g. "http://192.168.16.61". */
  url: () => string;
  port?: number;
  /** This machine's MAC addresses, lower case. Read from the network interfaces
   *  when absent; a test names its own because a CI box may have none. */
  ownMacs?: () => ReadonlySet<string>;
}

let socket: dgram.Socket | null = null;

/** Our own MACs, so we never treat this machine as a kiosk device. */
function ownMacs(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) if (n.mac && n.mac !== "00:00:00:00:00:00") out.add(n.mac.toLowerCase());
  }
  return out;
}

export function startKioskResponder(opts: ResponderOptions): void {
  if (socket) return;
  const port = opts.port ?? DEFAULT_DISCOVERY_PORT;
  const mine = (opts.ownMacs ?? ownMacs)();
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  socket = sock;

  sock.on("message", (buf, rinfo) => {
    void handle(buf, rinfo);
  });

  async function handle(buf: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    const probe = decodeProbe(buf);
    // Not ours, malformed, or oversized. A broadcast port hears everything.
    if (!probe) return;
    // Our own announcement bouncing back, or this machine running an agent
    // against itself — either way it is not a screen on the wall. A helper's
    // outputs are the exception: see isFromThisMachine.
    if (isFromThisMachine(probe, mine)) return;

    // load() is cached after the first read, so this is not a file read per
    // datagram.
    const devices = await kioskDevicesStore.load();
    const bound = !!findById(devices, probe.id);
    const decision = decideProbe(probe, opts.serverId, { scanning: scanning(), bound });

    // A device bound HERE is not a candidate: recording it would list it, announce
    // it and log "output seen" on every minute it runs, only to forget it again
    // below. Only a device somebody could claim, or one that cannot reach its
    // server, is shown.
    if (decision.list === "unclaimed" || decision.list === "elsewhere") {
      recordSeen({
        id: probe.id,
        macs: probe.macs,
        hostname: probe.hostname,
        os: probe.os,
        ip: rinfo.address,
        boundTo: probe.boundTo,
        unreachable: probe.unreachable,
        screen: probe.mode ? { w: 0, h: 0, mode: probe.mode } : undefined,
        output: probe.output,
      });
    }
    if (decision.list === "mine") {
      // Keep the stored hardware facts current.
      // update(), not load()+save(): the atomic read-modify-write, so a probe
      // landing while an operator is claiming cannot lose one of the two.
      // touch() returns the SAME array when nothing changed, so a probe every
      // two seconds does not become a file write every two seconds.
      try {
        await updateDevices((current) =>
          touch(current, probe.id, {
            macs: probe.macs, hostname: probe.hostname, os: probe.os, ip: rinfo.address,
            mode: probe.mode, output: probe.output, now: Date.now(),
          }),
        );
      } catch (err) {
        // Reported, not swallowed, and not fatal: the probe is still answered
        // below and the next one tries again. Losing a hostname is not worth
        // failing enrolment over.
        console.warn("[kiosk-responder] could not record device details:", err);
      }
      // A device that is bound is no longer a candidate to claim.
      forgetSeen(probe.id);
    }

    if (!decision.answer) return;
    const reply = Buffer.from(
      encodeReply({ serverId: opts.serverId, name: opts.serverName, url: opts.url() }),
    );
    sock.send(reply, rinfo.port, rinfo.address, (err) => {
      if (err) console.warn("[kiosk-responder] reply failed:", err.message);
    });
  }

  sock.on("error", (err) => {
    // A bound port is the realistic failure — say which, because "discovery does
    // not work" with no reason is the kind of thing that eats a Sunday morning.
    console.warn(`[kiosk-responder] socket error on udp/${port}: ${err.message}`);
    stopKioskResponder();
  });

  sock.bind(port, () => {
    try {
      sock.setBroadcast(true);
    } catch {
      // Broadcast is only needed to SEND; replies are unicast, so a platform that
      // refuses this can still answer probes.
    }
    console.log(`[kiosk-responder] listening on udp/${port} as "${opts.serverName}"`);
  });
}

export function stopKioskResponder(): void {
  if (!socket) return;
  try {
    socket.close();
  } catch {
    // Already closed — nothing to do.
  }
  socket = null;
}
