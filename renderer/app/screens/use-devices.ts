// One `devices:list` fetch shared by everything on the Screens page.
//
// Both halves of the merge need it — the unclaimed section lists what is not set
// up, and every screen card asks "is a machine showing me, and what size is it".
// A card-level fetch would be one request per screen on every render, so the
// subscription lives here and the components read from it.

import { useEffect, useState, useSyncExternalStore } from "react";

import { invoke, onNotification } from "../../lib/api";
import { logReadFailure } from "../../lib/client-log";
import type { SeenDevice } from "@main/types/kiosk";
import type { PublicDevice } from "@main/services/kiosk-devices-store";
import type { OutputHealth } from "@main/types/output-health";
import { notSetUp } from "./not-set-up";
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
/** The read on the wire now, if any. */
let running: Promise<Error | null> | null = null;
/** The one follow-up read a request that arrived mid-flight is owed, if any. */
let queued: Promise<Error | null> | null = null;
/** Whether the last read failed, so a run of failures is one line on /log. */
let failing = false;
const listeners = new Set<(d: DevicesPayload) => void>();

/** Tests only: forget what has been fetched, so one case's reports cannot read as
 *  the next case's "stopped reporting". */
export function __resetDevicesForTests(): void {
  current = EMPTY;
  running = null;
  queued = null;
  failing = false;
}

function publish(next: DevicesPayload): void {
  current = next;
  for (const l of listeners) l(next);
}

function read(): Promise<Error | null> {
  const p: Promise<Error | null> = invoke<Partial<Omit<DevicesPayload, "error" | "reported">>>("devices:list")
    .then((d): Error | null => {
      // `health` is absent from a server older than the page, which an updating
      // appliance is for a moment; no readings, rather than a page that throws.
      // The other lists get the same treatment because this is read on every page
      // now (the sidebar's count), and a navigation that throws on one odd answer
      // takes the whole app with it.
      const health = d.health ?? [];
      const reported = [...new Set([...current.reported, ...health.map((h) => h.deviceId)])];
      failing = false;
      publish({
        scanning: d.scanning ?? false,
        seen: d.seen ?? [],
        matches: d.matches ?? {},
        bound: d.bound ?? [],
        health,
        reported,
        error: null,
      });
      return null;
    })
    .catch((err: unknown): Error => {
      const error = err instanceof Error ? err : new Error(String(err));
      // The sidebar reads this on every page and has nowhere to show an error, so
      // the failure goes to /log: once when a run of failures starts, not once per
      // retry, and again if it recovers and then fails afresh.
      if (!failing) logReadFailure("screens", "the devices heard on the network", error);
      failing = true;
      // Keep the last good listing on screen. A screen that is genuinely there
      // must not vanish from the page because one poll lost the network.
      publish({ ...current, error });
      return error;
    })
    .finally(() => {
      if (running === p) running = null;
    });
  running = p;
  return p;
}

/**
 * Read the listing, and fan the answer out.
 *
 * Returns the failure rather than throwing it. The returned promise is shared by
 * every concurrent caller, so rejecting it would reject calls that have nothing
 * to do with each other; and it is never simply swallowed either — the error
 * lands in `error` on the fanned-out state, so a subscriber with somewhere to
 * put it can show it whether or not it was the one that asked.
 *
 * A request that arrives while a read is on the wire is not answered by it: that
 * read was asked before whatever the request is about, and a burst of
 * `kiosk:devices` frames (a Mac's six outputs, heard a few ms apart) would
 * otherwise leave the list short of the last of them. Everything that arrives
 * mid-flight shares ONE more read, started when the running one lands.
 */
export function refreshDevices(): Promise<Error | null> {
  if (!running) return read();
  queued ??= running.then(() => {
    queued = null;
    return read();
  });
  return queued;
}

/** A read for a caller that only needs the listing to exist: it joins one already
 *  on the wire rather than queueing another, so a page that mounts several
 *  consumers at once reads once. */
function readOrJoin(): Promise<Error | null> {
  return running ?? read();
}

/**
 * Follow the shared listing: read it now, and again on every `kiosk:devices`.
 * Returns the way to stop. The server broadcasts on every claim, release and
 * newly-heard device, so nothing here polls.
 */
function subscribe(listener: (d: DevicesPayload) => void): () => void {
  listeners.add(listener);
  void readOrJoin();
  // A frame replayed to a new subscriber is the last one this tab saw, which the
  // read just above already postdates: not a reason to read again.
  const off = onNotification("kiosk:devices", (_payload, replayed) => {
    if (!replayed) void refreshDevices();
  });
  return () => {
    listeners.delete(listener);
    off();
  };
}

export function useDevices(): DevicesPayload {
  const [data, setData] = useState(current);
  useEffect(() => subscribe(setData), []);
  return data;
}

const countNow = () => notSetUp(current.seen).length;

/**
 * How many devices are not set up, for the sidebar. The same listing, the same
 * channel and the same filter as the Screens page's banner, so the number and the
 * banner cannot disagree; and a number, so the sidebar re-renders when the count
 * changes rather than on every health report the page cares about.
 */
export function useNotSetUpCount(): number {
  return useSyncExternalStore(subscribe, countNow);
}
