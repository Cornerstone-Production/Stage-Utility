// The discovery exchange, as pure functions.
//
// A device broadcasts a probe; a server decides whether to answer it and whether
// to show it. Everything that decides those two things lives here, with no
// socket in sight, because it is the part worth testing and the part that would
// otherwise be buried in a datagram handler.
//
// The wire format is JSON in a UDP datagram. It arrives on a BROADCAST port, so
// every field is untrusted: anything on the LAN can send anything. Decoding is
// therefore total — it returns null rather than throwing, and it bounds every
// string and array before they reach a Map that lives in memory.

import type { DiscoveryProbe, DiscoveryReply } from "../types/kiosk.js";

/** Marks our datagrams so we ignore whatever else is on the port. */
const MAGIC = "stageUtility";
const PROBE = "discover";
const REPLY = "server";
const VERSION = 1;

/** Bounds on untrusted input. A device that sends more than this is malformed,
 *  and truncating beats letting a broadcast decide how much memory we keep. */
const MAX_STR = 128;
const MAX_MACS = 8;
/** A datagram larger than this is not ours. Keeps a flood cheap to reject. */
export const MAX_DATAGRAM = 2048;

const str = (v: unknown, max = MAX_STR): string | undefined =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;

export function encodeProbe(p: DiscoveryProbe): string {
  return JSON.stringify({
    [MAGIC]: PROBE,
    v: VERSION,
    id: p.id,
    macs: p.macs,
    hostname: p.hostname,
    os: p.os,
    boundTo: p.boundTo,
    unreachable: p.unreachable || undefined,
    mode: p.mode,
  });
}

/** Parse a probe, or null when the datagram is not one. Never throws. */
export function decodeProbe(buf: Buffer | string): DiscoveryProbe | null {
  if (buf.length > MAX_DATAGRAM) return null;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(buf.toString());
    if (!parsed || typeof parsed !== "object") return null;
    o = parsed as Record<string, unknown>;
  } catch {
    // Anything at all can land on a broadcast port. Not ours, not an error.
    return null;
  }
  if (o[MAGIC] !== PROBE || o.v !== VERSION) return null;
  const id = str(o.id);
  if (!id) return null;
  return {
    id,
    macs: Array.isArray(o.macs)
      ? o.macs.map((m) => str(m)).filter((m): m is string => !!m).slice(0, MAX_MACS)
      : [],
    hostname: str(o.hostname),
    os: str(o.os),
    boundTo: str(o.boundTo),
    unreachable: o.unreachable === true,
    // "1920x1080" — bounded like everything else off the wire.
    mode: str(o.mode, 32),
  };
}

export function encodeReply(r: DiscoveryReply): string {
  return JSON.stringify({ [MAGIC]: REPLY, v: VERSION, serverId: r.serverId, name: r.name, url: r.url });
}

/** Parse a reply, or null. Used by the device agent. Never throws. */
export function decodeReply(buf: Buffer | string): DiscoveryReply | null {
  if (buf.length > MAX_DATAGRAM) return null;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(buf.toString());
    if (!parsed || typeof parsed !== "object") return null;
    o = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (o[MAGIC] !== REPLY || o.v !== VERSION) return null;
  const serverId = str(o.serverId);
  const url = str(o.url, 512);
  if (!serverId || !url) return null;
  return { serverId, name: str(o.name) ?? serverId, url };
}

/**
 * What this server does about a probe it just heard.
 *
 * `answer` — reply with our address, so the device can load its display.
 * `list`   — what, if anything, Devices should show for it.
 */
export interface ProbeDecision {
  answer: boolean;
  list: "unclaimed" | "mine" | "elsewhere" | "none";
}

/**
 * The whole policy, in one place.
 *
 * Three rules, and the first one is the one that is easy to get wrong:
 *
 *  1. **A device bound to US is always answered**, scanning or not. That is how a
 *     display re-finds its server after an IP change with nobody present.
 *     Gating it behind a scan would leave a screen dark until somebody opened
 *     settings, which is the opposite of what discovery is for.
 *  2. **A device bound to somebody else is ignored.** This is what makes "claim it
 *     on one server and it disappears from the others" work without the servers
 *     ever talking: the device carries its own binding and every other server
 *     leaves it alone.
 *  3. **An unclaimed device is answered and listed only while SCANNING.** Nothing
 *     new appears unless someone is looking.
 *
 * The exception to (2): a device that cannot reach the server that owns it is
 * shown — never answered — so it can be recovered from a decommissioned server
 * without SSH. Showing it is not claiming it; that stays an explicit act.
 */
export function decideProbe(
  probe: DiscoveryProbe,
  serverId: string,
  opts: { scanning: boolean; bound: boolean },
): ProbeDecision {
  if (probe.boundTo && probe.boundTo === serverId) {
    // Ours. Answer even when the binding is unknown to us (a restored config, a
    // device claimed on a previous install) — the enrolment check decides what it
    // is actually allowed to see; discovery only tells it where we are.
    return { answer: true, list: opts.bound ? "mine" : "unclaimed" };
  }
  if (probe.boundTo) {
    return probe.unreachable ? { answer: false, list: "elsewhere" } : { answer: false, list: "none" };
  }
  return opts.scanning ? { answer: true, list: "unclaimed" } : { answer: false, list: "none" };
}
