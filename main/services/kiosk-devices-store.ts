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
 * wrong or missing token is NOT an error, it is a different device. It gets the
 * holding screen and shows up in Devices as its own entry, rather than silently
 * being handed a claimed screen's content.
 */
export function authorise(
  devices: readonly BoundDevice[],
  id: string,
  token: string | undefined,
): BoundDevice | null {
  const device = findById(devices, id);
  if (!device || !token || token !== device.token) return null;
  return device;
}

export interface ClaimDetails {
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
  // A re-claim of the same device keeps its token, so the agent already holding
  // it is not locked out of the screen it is currently showing.
  const token = existing?.token ?? newClaimToken();
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
