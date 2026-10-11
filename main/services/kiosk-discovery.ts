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

import { DEVICE_OUTPUT_KINDS, type DeviceOutput, type DiscoveryProbe, type DiscoveryReply } from "../types/kiosk.js";

/** Marks our datagrams so we ignore whatever else is on the port. */
const MAGIC = "stageUtility";
const PROBE = "discover";
const REPLY = "server";
const VERSION = 1;

/** Bounds on untrusted input. A device that sends more than this is malformed,
 *  and truncating beats letting a broadcast decide how much memory we keep. */
const MAX_STR = 128;
const MAX_MACS = 8;
/** A DeckLink port reports a few dozen modes at most, and the datagram cap above
 *  would refuse a probe long before this many fit. Bounded anyway: the Map this
 *  lands in lives for as long as the device is heard. */
const MAX_MODES = 24;
const MAX_MODE_LEN = 32;
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
    output: p.output,
  });
}

/**
 * The `output` a Mac output helper puts on each of its probes, or undefined.
 *
 * Dropped, not repaired, when it is not a whole one: a kind this server does not
 * know (a newer helper announcing something older code cannot name) or a missing
 * name or port. The probe itself still stands — it then reads as the plain device
 * it has always been, which is what "a probe without `output` behaves exactly as
 * today" promises.
 */
function decodeOutput(v: unknown): DeviceOutput | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const kind = DEVICE_OUTPUT_KINDS.find((k) => k === o.kind);
  const name = str(o.name);
  const port = str(o.port);
  if (!kind || !name || !port) return undefined;
  const modes = Array.isArray(o.modes)
    ? o.modes.map((m) => str(m, MAX_MODE_LEN)).filter((m): m is string => !!m).slice(0, MAX_MODES)
    : [];
  return modes.length > 0 ? { kind, name, port, modes } : { kind, name, port };
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
  const output = decodeOutput(o.output);
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
    ...(output && { output }),
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
 * Is this probe this machine talking to itself?
 *
 * Our own announcement bouncing back, or an agent on this machine run against
 * itself, is not a screen on the wall, so it is dropped. A probe carrying an
 * `output` is the exception: the output helper on the server's own Mac is a
 * supported setup, and what it announces are that Mac's displays and SDI ports,
 * which are screens on the wall whichever machine the server is on.
 */
export function isFromThisMachine(probe: DiscoveryProbe, ownMacs: ReadonlySet<string>): boolean {
  if (probe.output) return false;
  return probe.macs.some((m) => ownMacs.has(m.toLowerCase()));
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
 * Four rules, and the first two are the ones that are easy to get wrong:
 *
 *  1. **A device bound to somebody else is ignored.** This is what makes "claim it
 *     on one server and it disappears from the others" work without the servers
 *     ever talking: the device carries its own binding and every other server
 *     leaves it alone. The exception: one that cannot reach the server that owns
 *     it is shown, never answered, so it can be recovered from a decommissioned
 *     server without SSH. Showing it is not claiming it.
 *  2. **A device bound HERE is always answered, and never listed**, scanning or
 *     not, whatever its probe says about where it belongs. Answering is how a
 *     display re-finds its server after an IP change with nobody present. Not
 *     listing it covers the probe already on the wire when it was claimed, which
 *     does not carry the binding yet: listing that would offer a screen that is
 *     already set up, and announce it as newly seen.
 *  3. **A device that names us but is not bound here is unclaimed, and answered**:
 *     released, a restored config, or claimed on an install since wiped. It must
 *     stay answerable so it can be set up again rather than going dark.
 *  4. **Anything else is answered and listed only while SCANNING.** Nothing new
 *     appears unless someone is looking.
 */
export function decideProbe(
  probe: DiscoveryProbe,
  serverId: string,
  opts: { scanning: boolean; bound: boolean },
): ProbeDecision {
  if (probe.boundTo && probe.boundTo !== serverId) {
    return probe.unreachable ? { answer: false, list: "elsewhere" } : { answer: false, list: "none" };
  }
  if (opts.bound) return { answer: true, list: "mine" };
  if (probe.boundTo === serverId) return { answer: true, list: "unclaimed" };
  return opts.scanning ? { answer: true, list: "unclaimed" } : { answer: false, list: "none" };
}

/**
 * The binding a listed device is shown with: only one to ANOTHER server.
 *
 * Agents remember whichever server answered them, so a released device, or one
 * that was only ever heard by this server, still names it. Shown as bound, it read
 * "Set up on another server, which it cannot reach" under a device that can reach
 * this one fine.
 */
export function listedBoundTo(probe: Pick<DiscoveryProbe, "boundTo">, serverId: string): string | undefined {
  return probe.boundTo === serverId ? undefined : probe.boundTo;
}
