// Which physical machine shows which display.
//
// STORED, and declared "config": a binding is the operator's work — they stood in
// front of a screen and said "this one is the Left Mic Display" — so it must
// survive a restore. Declaring the class is not optional; the type checker and
// config-snapshot.test.ts both refuse a store that does not.
//
// The other half of the model is NOT here. An unclaimed device lives in memory
// only (see kiosk-presence.ts), which is why powering a Pi off before pairing it
// makes it vanish from every server's list: there was never anything stored.
//
// The mutations below are pure functions over the array rather than methods on
// the store, so the rules that matter — one device per output, a claim moves
// rather than duplicates — are testable without a filesystem.

import { randomBytes } from "node:crypto";

import type { BoundDevice } from "../types/kiosk.js";
import { DataStore } from "./data-store.js";

export const kioskDevicesStore = new DataStore<BoundDevice[]>("kiosk-devices.json", [], "config");

/** A claim token. Long enough that guessing it is not a strategy; it is the only
 *  thing standing between a claimed display and anything else on the LAN. */
export function newClaimToken(): string {
  return randomBytes(24).toString("base64url");
}

export const findById = (devices: readonly BoundDevice[], id: string): BoundDevice | undefined =>
  devices.find((d) => d.id === id);

export const findByOutput = (devices: readonly BoundDevice[], outputId: string): BoundDevice | undefined =>
  devices.find((d) => d.outputId === outputId);

/**
 * Is this enrolment allowed to be served the display it claims?
 *
 * A device id alone is self-asserted — anything on the LAN can send one — so a
 * wrong or missing secret is NOT an error, it is a different device. It gets the
 * holding screen and appears in Kiosks as its own entry, rather than silently
 * being handed a claimed screen's content.
 *
 * THE SECRET IS THE DEVICE'S, not ours. The installer generates it and the agent
 * presents it; we pin whatever the device showed us at the moment it was
 * claimed. Issuing one from here looked right until the installer was written
 * and there was nowhere to send it — the agent is a shell script and a browser,
 * with no channel back from a claim that happens in somebody else's browser.
 */
export function authorise(
  devices: readonly BoundDevice[],
  id: string,
  secret: string | undefined,
): BoundDevice | null {
  const device = findById(devices, id);
  if (!device || !secret) return null;
  // Unpinned: claimed before this device had ever enrolled, so trust the first
  // secret presented and pin it. The window is between claiming and the screen's
  // next load, on a LAN this server already trusts for reads.
  if (device.token === "") return device;
  return secret === device.token ? device : null;
}

/** Pin the secret a device presented, if it has not got one yet. Returns the
 *  SAME array when there is nothing to pin. */
export function pinSecret(devices: readonly BoundDevice[], id: string, secret: string): BoundDevice[] {
  const i = devices.findIndex((d) => d.id === id && d.token === "");
  if (i === -1) return devices as BoundDevice[];
  const next = [...devices];
  next[i] = { ...next[i], token: secret };
  return next;
}

export interface ClaimDetails {
  /** The secret this device presented when it last enrolled. Absent when it has
   *  never reached us over HTTP — then the binding is left unpinned and takes
   *  the first secret it shows. */
  secret?: string;
  macs?: string[];
  hostname?: string;
  os?: string;
  ip?: string;
  label?: string;
  now?: number;
}

/**
 * Bind a device to an output.
 *
 * Binds to an EXISTING output on purpose: a replacement Pi is claimed as "Left
 * Mic Display" and inherits the slot, its view, its slug and every QR code
 * pointing at it. An output per device would leave a dead entry behind on every
 * hardware swap.
 *
 * An output holds at most one device, so claiming an output that already has one
 * MOVES the binding rather than adding a second — two machines fighting over one
 * screen is not a state worth being able to reach. The displaced device keeps
 * nothing: it becomes unclaimed and starts advertising again.
 */
export function claim(
  devices: readonly BoundDevice[],
  id: string,
  outputId: string,
  details: ClaimDetails = {},
): { devices: BoundDevice[]; token: string; displaced: BoundDevice | null } {
  const displaced = devices.find((d) => d.outputId === outputId && d.id !== id) ?? null;
  const existing = findById(devices, id);
  // A re-claim keeps whatever is already pinned, so the agent currently serving
  // that screen is not locked out by an operator adjusting its binding.
  const token = existing?.token || details.secret || "";
  const device: BoundDevice = {
    ...existing,
    id,
    token,
    outputId,
    label: details.label ?? existing?.label ?? details.hostname,
    macs: details.macs ?? existing?.macs ?? [],
    hostname: details.hostname ?? existing?.hostname,
    os: details.os ?? existing?.os,
    ip: details.ip ?? existing?.ip,
    lastSeen: details.now ?? existing?.lastSeen,
  };
  const kept = devices.filter((d) => d.id !== id && d.id !== displaced?.id);
  return { devices: [...kept, device], token, displaced };
}

/** Unbind a device. The output is untouched — it keeps its view and its slug and
 *  simply has no machine showing it. */
export function release(devices: readonly BoundDevice[], id: string): BoundDevice[] {
  return devices.filter((d) => d.id !== id);
}

/**
 * Record what a probe told us about hardware we already know.
 *
 * Returns the SAME array when nothing changed, so a device probing every two
 * seconds does not rewrite a config file every two seconds.
 */
export function touch(
  devices: readonly BoundDevice[],
  id: string,
  seen: { macs?: string[]; hostname?: string; os?: string; ip?: string; now: number },
): BoundDevice[] {
  const i = devices.findIndex((d) => d.id === id);
  if (i === -1) return devices as BoundDevice[];
  const d = devices[i];
  const macs = seen.macs ?? d.macs;
  const changed =
    d.hostname !== (seen.hostname ?? d.hostname) ||
    d.os !== (seen.os ?? d.os) ||
    d.ip !== (seen.ip ?? d.ip) ||
    macs.length !== d.macs.length ||
    macs.some((m, k) => m !== d.macs[k]);
  // lastSeen alone is deliberately not a reason to write: it changes constantly
  // and nothing reads it precisely enough to be worth the disk churn.
  if (!changed) return devices as BoundDevice[];
  const next = [...devices];
  next[i] = { ...d, macs, hostname: seen.hostname ?? d.hostname, os: seen.os ?? d.os, ip: seen.ip ?? d.ip, lastSeen: seen.now };
  return next;
}

/**
 * A bound device with its token removed.
 *
 * The token is the ONLY thing separating a claimed display from anything else on
 * the LAN, and reads on this server are deliberately open (writes are
 * same-origin; it is a plain-HTTP appliance). Returning tokens from a listing
 * anyone can GET would hand out the secret and make the check theatre.
 *
 * Nothing in the UI needs it: the agent already holds its own.
 */
export type PublicDevice = Omit<BoundDevice, "token">;

export function withoutTokens(devices: readonly BoundDevice[]): PublicDevice[] {
  return devices.map(({ token: _secret, ...rest }) => rest);
}

/**
 * Devices that look like the same hardware coming back.
 *
 * Used when an unclaimed device appears and a claimed one with the same MAC is
 * offline — the OS-reinstall case, where the id is new but the box is not. The
 * app offers "this looks like Left Mic Display"; a person confirms.
 *
 * Never binds anything on its own. Wi-Fi MACs randomise per network, a NIC swap
 * changes them, and a cloned VM can duplicate one — so this suggests, and the id
 * does the binding.
 */
export function matchByMac(devices: readonly BoundDevice[], macs: readonly string[]): BoundDevice[] {
  if (macs.length === 0) return [];
  const want = new Set(macs.map((m) => m.toLowerCase()));
  return devices.filter((d) => d.macs.some((m) => want.has(m.toLowerCase())));
}
