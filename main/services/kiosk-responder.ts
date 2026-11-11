// The UDP half of enrolment: listen for probes, decide, answer.
//
// node:dgram, no dependency — the same broadcast/respond shape the OSC manager
// and the Sennheiser provider already use.
//
// Everything this module DECIDES lives in kiosk-discovery.ts as pure functions;
// what is left here is the socket, which is the part that cannot be unit tested
// and therefore should hold no policy.

import { randomBytes } from "node:crypto";
import * as dgram from "node:dgram";
import { hostname, networkInterfaces } from "node:os";

import {
  decodeProbe, decodeReply, encodeProbe, encodeReply, decideCheck, decideProbe, listedBoundTo, isFromThisMachine,
} from "./kiosk-discovery.js";
import { recordSeen, scanning, forgetSeen, noteReleased } from "./kiosk-presence.js";
import { kioskDevicesStore, findById, touch, updateDevices } from "./kiosk-devices-store.js";
import { scrub } from "./scrub.js";
import { errorMessage } from "./errors.js";
import { DEFAULT_DISCOVERY_PORT, type DuplicateServer, type ServerIdentity } from "../types/kiosk.js";

export interface ResponderOptions {
  /** Stable per install. A device uses it to tell two servers apart. */
  serverId: string;
  /** Shown in Devices so a binding is attributable to a named server. */
  serverName: string;
  /** How a device should reach us, e.g. "http://192.168.1.50". */
  url: () => string;
  port?: number;
  /** This machine's MAC addresses, lower case. Read from the network interfaces
   *  when absent; a test names its own because a CI box may have none. */
  ownMacs?: () => ReadonlySet<string>;
  /** Where the duplicate-id check goes. The limited broadcast address on the
   *  discovery port, which is where every agent probes; a test names a peer. */
  probeTo?: { address: string; port: number };
  /** How often the check repeats while another server is answering with this
   *  id, so the flag clears once it stops. Nothing repeats while none is. */
  recheckMs?: number;
  /** How long after a check its answers are counted. */
  replyWindowMs?: number;
  /** Told whenever what discovery knows about this server's id changes. */
  onIdentity?: (identity: ServerIdentity) => void;
}

let socket: dgram.Socket | null = null;
/** Whether the last read of the bindings failed, so the log says so once. */
let bindingsUnreadable = false;

/** The duplicate-id check. Module state, like the socket it rides on. */
const RECHECK_MS = 60_000;
const REPLY_WINDOW_MS = 3_000;
/** Answers carrying our id are evidence of a duplicate only from this many
 *  addresses; the first ones heard are kept, and each was logged. */
const MAX_DUPLICATES = 8;
/** Rounds in a row an address may go unheard before it is cleared. Two, so one
 *  lost datagram cannot flicker the flag. */
const CLEAR_AFTER_MISSES = 2;

interface Heard extends DuplicateServer {
  missed: number;
}
const duplicates = new Map<string, Heard>();
/** Addresses heard answering (or checking for) our id since the round began. */
const heardThisRound = new Set<string>();
let check: ServerIdentity["check"] = { state: "off" };
let roundTimer: ReturnType<typeof setTimeout> | null = null;
let recheckTimer: ReturnType<typeof setTimeout> | null = null;
/** The current responder's own options, for the check's timers. */
let current: ResponderOptions | null = null;
/** This start's own check id: how its own check, heard back, is told apart. */
let ownCheckId = "";
/** The id this server answers with. Starts as the option; New server id changes
 *  it in place (changeServerId), with no socket rebind mid-service. */
let serverId = "";
let sendFailing = false;

function identity(): ServerIdentity {
  const list = [...duplicates.values()]
    .map(({ missed: _missed, ...d }) => d)
    .sort((a, b) => a.address.localeCompare(b.address));
  return { id: current ? serverId : null, check, duplicates: list };
}

function report(): void {
  current?.onIdentity?.(identity());
}

/**
 * Another server is answering with this server's id. Logged once per address,
 * when first heard; after that it only stays fresh.
 */
function noteDuplicate(address: string, how: string, from?: { url: string; name: string }): void {
  heardThisRound.add(address);
  const known = duplicates.get(address);
  if (known) {
    known.missed = 0;
    if (from && !known.url) Object.assign(known, { url: from.url, name: from.name });
    report();
    return;
  }
  if (duplicates.size >= MAX_DUPLICATES) return;
  duplicates.set(address, { address, ...(from && { url: from.url, name: from.name }), since: Date.now(), missed: 0 });
  console.warn(
    `[kiosk-responder] another server at ${scrub(address)}${from ? ` (${scrub(from.url)})` : ""} answers as this server, id ${scrub(serverId)} (${how}); ` +
      "screens set up here may switch between the two. Give one of them a new server id: Settings > Advanced > Network",
  );
  report();
  scheduleRecheck();
}

/** While anything is flagged, check again later: that is how a flag clears. */
function scheduleRecheck(): void {
  if (recheckTimer || duplicates.size === 0 || !current) return;
  recheckTimer = setTimeout(() => {
    recheckTimer = null;
    sendCheck();
  }, current.recheckMs ?? RECHECK_MS);
  recheckTimer.unref?.();
}

/**
 * One round of the duplicate-id check: today's probe, naming this server's own id
 * as the server it is bound to, marked `check`. Every server with another id
 * ignores it (decideProbe rule 1); one with the same id answers it on any build
 * (rule 3), and a build that reads `check` also takes the probe as evidence.
 *
 * Sent when the responder starts (boot, the restart after a restore, discovery
 * switched on: all of them start it), and again every recheckMs only while
 * something is flagged. A server with nothing flagged sends nothing on a timer.
 */
function sendCheck(): void {
  const sock = socket;
  const opts = current;
  if (!sock || !opts) return;
  if (roundTimer) clearTimeout(roundTimer);
  heardThisRound.clear();
  const port = opts.port ?? DEFAULT_DISCOVERY_PORT;
  const to = opts.probeTo ?? { address: "255.255.255.255", port };
  const probe = Buffer.from(
    encodeProbe({
      id: ownCheckId,
      macs: [...(opts.ownMacs ?? ownMacs)()],
      hostname: hostname(),
      os: "Stage Utility server",
      boundTo: serverId,
      check: true,
    }),
  );
  sock.send(probe, to.port, to.address, (err) => {
    if (err) {
      if (!sendFailing) console.warn(`[kiosk-responder] could not send the duplicate-id check on udp/${port}: ${err.message}`);
      sendFailing = true;
      check = { state: "failed", at: Date.now(), reason: err.message };
      report();
      return;
    }
    sendFailing = false;
    // "ok" means the check went out, at this time; who answered is `duplicates`.
    check = { state: "ok", at: Date.now() };
    report();
    roundTimer = setTimeout(() => endRound(), opts.replyWindowMs ?? REPLY_WINDOW_MS);
    roundTimer.unref?.();
  });
}

/** Count who was not heard this round; clear whoever has been silent long enough. */
function endRound(): void {
  roundTimer = null;
  for (const [address, d] of duplicates) {
    if (heardThisRound.has(address)) continue;
    d.missed += 1;
    if (d.missed >= CLEAR_AFTER_MISSES) {
      duplicates.delete(address);
      console.log(`[kiosk-responder] ${scrub(address)} no longer answers as this server`);
    }
  }
  report();
  scheduleRecheck();
}

function resetCheck(state: ServerIdentity["check"]): void {
  if (roundTimer) clearTimeout(roundTimer);
  if (recheckTimer) clearTimeout(recheckTimer);
  roundTimer = null;
  recheckTimer = null;
  duplicates.clear();
  heardThisRound.clear();
  check = state;
}

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
  current = opts;
  serverId = opts.serverId;
  ownCheckId = `server-check-${randomBytes(6).toString("hex")}`;
  resetCheck({ state: "off" });

  sock.on("message", (buf, rinfo) => {
    void handle(buf, rinfo);
  });

  async function handle(buf: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    const probe = decodeProbe(buf);
    if (!probe) {
      // An answer to this server's duplicate-id check: a reply only ever comes
      // here because we probed, and we never answer our own check, so one that
      // carries our id is another server that has it.
      const reply = decodeReply(buf);
      if (reply && reply.serverId === serverId) {
        noteDuplicate(rinfo.address, "it answered this server's check", { url: reply.url, name: reply.name });
      }
      // Anything else is not ours, malformed, or oversized. A broadcast port hears everything.
      return;
    }
    // Another server's duplicate-id check, before the same-machine rule: a second
    // server on this machine shares its MACs, and its check is still evidence.
    if (probe.check) {
      if (decideCheck(probe, serverId, ownCheckId) !== "duplicate") return;
      noteDuplicate(rinfo.address, "it checked for this id");
      sock.send(
        Buffer.from(encodeReply({ serverId, name: opts.serverName, url: opts.url(), claimed: false })),
        rinfo.port,
        rinfo.address,
        (err) => {
          if (err) console.warn("[kiosk-responder] reply failed:", err.message);
        },
      );
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

    if (!decision.answer) return;
    const reply = Buffer.from(
      encodeReply({ serverId, name: opts.serverName, url: opts.url(), claimed: bound }),
    );
    sock.send(reply, rinfo.port, rinfo.address, (err) => {
      if (err) console.warn("[kiosk-responder] reply failed:", err.message);
    });
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
      // probes. What it cannot do is send the duplicate-id check, so say so and
      // leave the check marked failed rather than quietly reading as fine.
      const reason = errorMessage(err);
      console.warn(`[kiosk-responder] broadcast refused on udp/${port} (${reason}); cannot check for another server with this id`);
      check = { state: "failed", at: Date.now(), reason };
      console.log(`[kiosk-responder] listening on udp/${port} as "${opts.serverName}"`);
      report();
      return;
    }
    console.log(`[kiosk-responder] listening on udp/${port} as "${opts.serverName}"`);
    sendCheck();
  });
}

/**
 * Answer as `next` from now on, and check at once whether anyone else does.
 *
 * What was heard about the old id is dropped with it: the server that shares the
 * old id keeps it, and the screens bound to it follow that server. A no-op while
 * discovery is off, when nothing answers and nothing checks.
 */
export function changeServerId(next: string): void {
  if (!socket || !current) return;
  serverId = next;
  resetCheck(check);
  report();
  sendCheck();
}

/** Stop answering and stop checking. What the check knew goes with it: a stopped
 *  responder hears nobody, so it can claim nothing. */
export function stopKioskResponder(state: ServerIdentity["check"] = { state: "off" }): void {
  if (!socket) return;
  try {
    socket.close();
  } catch {
    // Already closed — nothing to do.
  }
  socket = null;
  resetCheck(state);
  report();
  current = null;
}
