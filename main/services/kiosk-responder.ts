// The UDP half of enrolment: listen for probes, decide, answer.
//
// node:dgram, no dependency — the same broadcast/respond shape the OSC manager
// and the Sennheiser provider already use.
//
// Everything this module DECIDES lives in kiosk-discovery.ts as pure functions,
// and the duplicate-id check's schedule in kiosk-duplicate-check.ts; what is left
// here is the socket, which is the part that cannot be unit tested and therefore
// should hold no policy.

import { randomBytes } from "node:crypto";
import * as dgram from "node:dgram";
import { hostname, networkInterfaces } from "node:os";

import {
  broadcastAddresses, decodeProbe, decodeReply, encodeProbe, encodeReply, isDuplicateCheck, decideProbe, listedBoundTo,
  isFromThisMachine,
} from "./kiosk-discovery.js";
import { heardDuplicate, recheckFromScratch, startDuplicateCheck, stopDuplicateCheck } from "./kiosk-duplicate-check.js";
import { recordSeen, scanning, forgetSeen, noteReleased } from "./kiosk-presence.js";
import { kioskDevicesStore, findById, touch, updateDevices } from "./kiosk-devices-store.js";
import { errorMessage } from "./errors.js";
import { DEFAULT_DISCOVERY_PORT, type DuplicateCheck } from "../types/kiosk.js";

export interface ResponderOptions {
  /** Stable per install. A device uses it to tell two servers apart. Read on
   *  every datagram, so a new id (New server id) is answered with at once. */
  serverId: () => string;
  /** Shown in Devices so a binding is attributable to a named server. */
  serverName: string;
  /** How a device should reach us, e.g. "http://192.168.1.50". */
  url: () => string;
  port?: number;
  /** This machine's MAC addresses, lower case. Read from the network interfaces
   *  when absent; a test names its own because a CI box may have none. */
  ownMacs?: () => ReadonlySet<string>;
  /** Where the duplicate-id check goes. Each interface's directed broadcast
   *  address on the discovery port (broadcastAddresses); a test names a peer. */
  probeTo?: { address: string; port: number };
  /** See kiosk-duplicate-check.ts. */
  recheckMs?: number;
  replyWindowMs?: number;
  /** Told whenever what the duplicate-id check knows changes. */
  onCheck?: (state: DuplicateCheck) => void;
}

let socket: dgram.Socket | null = null;
/** Whether the last read of the bindings failed, so the log says so once. */
let bindingsUnreadable = false;

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
  /** This start's own check id: how its own check, heard back, is told apart. */
  const ownCheckId = `server-check-${randomBytes(6).toString("hex")}`;
  /** Why broadcast was refused, if it was: then the check cannot be sent. */
  let broadcastRefused: string | null = null;

  sock.on("message", (buf, rinfo) => {
    void handle(buf, rinfo);
  });

  /** Answer a probe: who we are, where to load from, and whether it is set up here. */
  function replyTo(rinfo: dgram.RemoteInfo, claimed: boolean): void {
    const reply = Buffer.from(encodeReply({ serverId: opts.serverId(), name: opts.serverName, url: opts.url(), claimed }));
    sock.send(reply, rinfo.port, rinfo.address, (err) => {
      if (err) console.warn("[kiosk-responder] reply failed:", err.message);
    });
  }

  /** One duplicate-id check, out on every target. Null when it went out anywhere:
   *  one interface refusing is not the check failing. */
  async function sendCheck(): Promise<string | null> {
    if (broadcastRefused) return `broadcast refused (${broadcastRefused})`;
    const targets = opts.probeTo
      ? [opts.probeTo]
      : broadcastAddresses(networkInterfaces()).map((address) => ({ address, port }));
    const probe = Buffer.from(
      encodeProbe({
        id: ownCheckId,
        macs: [...mine],
        hostname: hostname(),
        os: "Stage Utility server",
        boundTo: opts.serverId(),
        check: true,
      }),
    );
    const failures = await Promise.all(
      targets.map(
        (to) =>
          new Promise<string | null>((resolve) => {
            sock.send(probe, to.port, to.address, (err) => resolve(err ? `${to.address}: ${err.message}` : null));
          }),
      ),
    );
    const failed = failures.filter((f): f is string => f !== null);
    return failed.length === targets.length ? failed.join("; ") : null;
  }

  async function handle(buf: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    const probe = decodeProbe(buf);
    if (!probe) {
      // An answer to this server's duplicate-id check: a reply only ever comes
      // here because we probed, and we never answer our own check, so one that
      // carries our id is another server that has it. One carrying our own URL
      // is our own answer to someone else's check, handed back to us: with two
      // servers on one machine sharing the port, the kernel gives a unicast to
      // whichever socket it likes.
      const reply = decodeReply(buf);
      if (reply && reply.serverId === opts.serverId() && reply.url !== opts.url()) {
        heardDuplicate(rinfo.address, "it answered this server's check", { url: reply.url, name: reply.name });
      }
      // Anything else is not ours, malformed, or oversized. A broadcast port hears everything.
      return;
    }
    // Another server's duplicate-id check, before the same-machine rule: a second
    // server on this machine shares its MACs, and its check is still evidence.
    if (probe.check) {
      if (!isDuplicateCheck(probe, opts.serverId(), ownCheckId)) return;
      heardDuplicate(rinfo.address, "it checked for this id");
      replyTo(rinfo, false);
      return;
    }
    // Our own announcement bouncing back, or this machine running an agent
    // against itself — either way it is not a screen on the wall. A helper's
    // outputs are the exception: see isFromThisMachine.
    if (isFromThisMachine(probe, mine)) return;

    // load() is cached after the first read, so this is not a file read per
    // datagram — except while the file cannot be read, when each probe retries.
    const devices = await kioskDevicesStore.load();
    // Not knowing which devices are bound is not the same as none being bound:
    // answered from the defaults, every device bound here would be told this
    // server does not know it, and forget it. Silence keeps it probing.
    if (kioskDevicesStore.unreadable()) {
      if (!bindingsUnreadable) console.error("[kiosk-responder] device bindings unreadable; not answering probes until they read");
      bindingsUnreadable = true;
      return;
    }
    bindingsUnreadable = false;
    const bound = !!findById(devices, probe.id);
    const serverId = opts.serverId();
    const decision = decideProbe(probe, serverId, { scanning: scanning(), bound });
    if (!bound && probe.boundTo === serverId) noteReleased(probe.id);

    // Listed means somebody could set it up, or it cannot reach its own server.
    // Which is which is decideProbe's call; this only records it. A new device is
    // listed whether or not a page is scanning; answering it is a separate
    // decision (see rule 4 there).
    if (decision.list === "unclaimed" || decision.list === "elsewhere") {
      recordSeen({
        id: probe.id,
        macs: probe.macs,
        hostname: probe.hostname,
        os: probe.os,
        ip: rinfo.address,
        boundTo: listedBoundTo(probe, serverId),
        unreachable: probe.unreachable,
        screen: probe.mode ? { w: 0, h: 0, mode: probe.mode } : undefined,
        output: probe.output,
      });
    }
    if (decision.list === "none") {
      // Heard, and not ours to show. If it WAS listed (it was unclaimed a moment
      // ago and has since been set up on another server) it leaves the list now,
      // not when its last sighting ages out 90 s later.
      forgetSeen(probe.id);
    }
    if (decision.list === "mine") {
      // Keep the stored hardware facts current.
      // update(), not load()+save(): the atomic read-modify-write, so a probe
      // landing while an operator is claiming cannot lose one of the two.
      // touch() returns the SAME array when nothing changed, so a probe every
      // two seconds does not become a file write every two seconds.
      // Skipped while saves to the bindings are refused (DataStore.refusingSaves):
      // [data-store] has said so once, and each probe would warn again.
      if (!kioskDevicesStore.refusingSaves()) {
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
      }
      // A device that is bound is no longer a candidate to claim.
      forgetSeen(probe.id);
    }

    if (decision.answer) replyTo(rinfo, bound);
  }

  sock.on("error", (err) => {
    // A bound port is the realistic failure — say which, because "discovery does
    // not work" with no reason is the kind of thing that eats a Sunday morning.
    console.warn(`[kiosk-responder] socket error on udp/${port}: ${err.message}`);
    stopKioskResponder({ state: "failed", at: Date.now(), reason: err.message });
  });

  sock.bind(port, () => {
    try {
      sock.setBroadcast(true);
    } catch (err) {
      // Replies are unicast, so a platform that refuses this still answers
      // probes. What it cannot do is send the duplicate-id check: each check then
      // fails, and says so, on the check's own failure path.
      broadcastRefused = errorMessage(err);
    }
    console.log(`[kiosk-responder] listening on udp/${port} as "${opts.serverName}"`);
    startDuplicateCheck({
      send: sendCheck,
      serverId: opts.serverId,
      port,
      recheckMs: opts.recheckMs,
      replyWindowMs: opts.replyWindowMs,
      onChange: opts.onCheck,
    });
  });
}

/**
 * This server's id just changed (New server id): what was heard about the old one
 * says nothing any more, so forget it and check at once under the new one. The
 * id itself is read from the options on every datagram; this only re-checks. A
 * no-op while discovery is off, when nothing answers and nothing checks.
 */
export function recheckServerId(): void {
  if (socket) recheckFromScratch();
}

/** Stop answering and stop checking. */
export function stopKioskResponder(state: DuplicateCheck["check"] = { state: "off" }): void {
  if (!socket) return;
  try {
    socket.close();
  } catch {
    // Already closed — nothing to do.
  }
  socket = null;
  stopDuplicateCheck(state);
}
