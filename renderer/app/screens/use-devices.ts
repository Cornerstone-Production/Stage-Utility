// One `devices:list` fetch shared by everything on the Screens page.
//
// Both halves of the merge need it — the unclaimed section lists what is not set
// up, and every screen card asks "is a machine showing me, and what size is it".
// A card-level fetch would be one request per screen on every render, so the
// subscription lives here and the components read from it.

import { useEffect, useState } from "react";

import { invoke, onNotification } from "../../lib/api";
import type { SeenDevice } from "@main/types/kiosk";
import type { PublicDevice } from "@main/services/kiosk-devices-store";
import type { OutputHealth } from "@main/types/output-health";
// One phrasing of a screen size, shared with the holding screen the operator is
// looking at on the wall — the two must not drift apart.
export { describeScreen } from "@main/services/kiosk-screen-size";

export interface DevicesPayload {
  scanning: boolean;
  seen: SeenDevice[];
  /** Unclaimed device id → bound device ids sharing a MAC. A hint, never a bind. */
  matches: Record<string, string[]>;
  bound: PublicDevice[];
  /** What each Mac output helper output last reported, for the ones still
   *  reporting. Pushed with every `kiosk:devices`, so it is as fresh as the
   *  server last said. */
  health: OutputHealth[];
  /** Ids of the devices that have reported health at any time since this page
   *  loaded. A reading that is no longer in `health` was dropped after the helper
   *  stopped, which is what tells "stopped reporting" from "never reported". */
  reported: string[];
  /** The last refresh that failed, or null. Carried in the state rather than
   *  thrown so it reaches subscribers that did not make the call. */
  error: Error | null;
}

const EMPTY: DevicesPayload = { scanning: false, seen: [], matches: {}, bound: [], health: [], reported: [], error: null };

let current: DevicesPayload = EMPTY;
let inFlight: Promise<Error | null> | null = null;
const listeners = new Set<(d: DevicesPayload) => void>();

/** Tests only: forget what has been fetched, so one case's reports cannot read as
 *  the next case's "stopped reporting". */
export function __resetDevicesForTests(): void {
  current = EMPTY;
  inFlight = null;
}

function publish(next: DevicesPayload): void {
  current = next;
  for (const l of listeners) l(next);
}

/**
 * Fetch once however many components ask at the same moment, then fan out.
 *
 * Returns the failure rather than throwing it. The returned promise is shared by
 * every concurrent caller, so rejecting it would reject calls that have nothing
 * to do with each other; and it is never simply swallowed either — the error
 * lands in `error` on the fanned-out state, so a subscriber with somewhere to
 * put it can show it whether or not it was the one that asked.
 */
export function refreshDevices(): Promise<Error | null> {
  inFlight ??= invoke<Omit<DevicesPayload, "error" | "health" | "reported"> & { health?: OutputHealth[] }>("devices:list")
    .then((d): Error | null => {
      // `health` is absent from a server older than the page, which an updating
      // appliance is for a moment; no readings, rather than a page that throws.
      const health = d.health ?? [];
      const reported = [...new Set([...current.reported, ...health.map((h) => h.deviceId)])];
      publish({ ...d, health, reported, error: null });
      return null;
    })
    .catch((err: unknown): Error => {
      const error = err instanceof Error ? err : new Error(String(err));
      // Keep the last good listing on screen. A screen that is genuinely there
      // must not vanish from the page because one poll lost the network.
      publish({ ...current, error });
      return error;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function useDevices(): DevicesPayload {
  const [data, setData] = useState(current);
  useEffect(() => {
    listeners.add(setData);
    void refreshDevices();
    // The server broadcasts on every claim, release and newly-heard device, so
    // nothing here polls.
    const off = onNotification("kiosk:devices", () => void refreshDevices());
    return () => {
      listeners.delete(setData);
      off();
    };
  }, []);
  return data;
}
