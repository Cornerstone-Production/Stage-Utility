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

import { announceDevices } from "./kiosk-presence.js";
import { mergeScreen, sameScreen, screenFrom } from "./kiosk-screen-size.js";
import type { BoundDevice, ScreenSize } from "../types/kiosk.js";
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
 * holding screen and appears on Screens as its own entry, rather than silently
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
  /** What the device said its screen is while it was still unclaimed. Carried
   *  across so the size is on the card the moment it is set up, rather than
   *  blank until the display next sends a heartbeat. */
  screen?: ScreenSize;
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
    screen: details.screen ?? existing?.screen,
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
 * Record the size a bound device says it is running at.
 *
 * Keyed by OUTPUT, because this arrives on the display heartbeat, which knows
 * which display it is showing and not which machine is showing it. Returns the
 * SAME array when nothing changed — a heartbeat every twenty seconds must not be
 * a file write every twenty seconds.
 */
export function recordScreen(
  devices: readonly BoundDevice[],
  outputId: string,
  screen: { w: number; h: number; dpr?: number },
): BoundDevice[] {
  const i = devices.findIndex((d) => d.outputId === outputId);
  if (i === -1) return devices as BoundDevice[];
  const merged = mergeScreen(devices[i].screen, screen);
  if (sameScreen(devices[i].screen, merged)) return devices as BoundDevice[];
  const next = [...devices];
  next[i] = { ...next[i], screen: merged };
  return next;
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
  seen: { macs?: string[]; hostname?: string; os?: string; ip?: string; mode?: string; now: number },
): BoundDevice[] {
  const i = devices.findIndex((d) => d.id === id);
  if (i === -1) return devices as BoundDevice[];
  const d = devices[i];
  const macs = seen.macs ?? d.macs;
  const changed =
    (seen.mode !== undefined && seen.mode !== d.screen?.mode) ||
    d.hostname !== (seen.hostname ?? d.hostname) ||
    d.os !== (seen.os ?? d.os) ||
    d.ip !== (seen.ip ?? d.ip) ||
    macs.length !== d.macs.length ||
    macs.some((m, k) => m !== d.macs[k]);
  // lastSeen alone is deliberately not a reason to write: it changes constantly
  // and nothing reads it precisely enough to be worth the disk churn.
  if (!changed) return devices as BoundDevice[];
  const next = [...devices];
  next[i] = {
    ...d, macs,
    hostname: seen.hostname ?? d.hostname,
    os: seen.os ?? d.os,
    ip: seen.ip ?? d.ip,
    screen: mergeScreen(d.screen, seen.mode === undefined ? undefined : { mode: seen.mode }),
    lastSeen: seen.now,
  };
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
 * Record what a bound display says its screen is, from its heartbeat.
 *
 * Owns the parse as well as the write so the route does not re-derive what a
 * plausible number is — these arrive in a JSON body off the LAN, exactly like
 * the holding screen's query string, and both go through `screenFrom`.
 *
 * Returns the failure rather than swallowing it. Nothing downstream reads a
 * screen size to decide anything, so the caller is free to discard it — but that
 * is the route's call to make explicitly, not this function's to make silently.
 */
/**
 * Write to the bound-device store and tell anybody watching.
 *
 * Every mutator here returns the SAME array when nothing changed, which is what
 * keeps a two-second probe from being a two-second disk write. That identity is
 * also the change signal, so the broadcast rides on it: no separate "did it
 * change" check to fall out of step with the mutators.
 *
 * Screens refetches the whole listing on this notification, so one channel
 * covers both halves of the page. Before this existed, five write sites — claim,
 * release, pinSecret, touch and recordScreen — all reached the disk and none of
 * them reached an open page.
 */
export async function updateDevices(
  mutate: (current: readonly BoundDevice[]) => BoundDevice[],
): Promise<boolean> {
  let changed = false;
  await kioskDevicesStore.update((current) => {
    const next = mutate(current);
    changed = next !== current;
    return next;
  });
  if (changed) announceDevices();
  return changed;
}

export async function recordDisplayScreen(
  outputId: string,
  deviceId: unknown,
  reported: unknown,
): Promise<Error | null> {
  // Only the bound device may say how big its screen is. Any browser can open a
  // display URL and heartbeat — a phone checking the wall panel would otherwise
  // record 390 x 844 as that screen's size, and the two would then fight, each
  // flip a real disk write.
  if (typeof deviceId !== "string" || !deviceId) return null;
  const r = reported as { w?: unknown; h?: unknown; dpr?: unknown } | undefined;
  const screen = r ? screenFrom(r.w, r.h, r.dpr) : null;
  if (!screen) return null;
  try {
    // recordScreen returns the SAME array when nothing changed, and the store
    // skips the write for an unchanged value — so a heartbeat every twenty
    // seconds is not a disk write every twenty seconds.
    await updateDevices((cur) =>
      cur.some((d) => d.id === deviceId && d.outputId === outputId)
        ? recordScreen(cur, outputId, screen)
        : (cur as BoundDevice[]),
    );
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
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
