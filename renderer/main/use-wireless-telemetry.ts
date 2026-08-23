import { useCallback, useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";
import { WIRELESS_STATUS_CHANNEL, type DeviceStatus } from "@main/types/devices";

/**
 * Live telemetry for every wireless RF channel — RF bars, battery, runtime,
 * frequency, audio — behind the "Wireless summary" and "Wireless channel"
 * widgets and the editor's channel picker.
 *
 * It used to fetch `wireless:listChannels`, which is the PICKER endpoint and
 * answers `{id, label}`. This hook declared that as `DeviceStatus[]` and the
 * type checker had nothing to say, so every field the widgets read was
 * undefined: the summary reported 0 of N online for good, and a channel tile
 * with a channel chosen matched nothing and drew a dash.
 *
 * It was called `useWirelessChannels`, which is ALSO the name of the picker hook
 * in app/queries.ts — two hooks, one name, opposite answers, and the editor
 * imported whichever one autocomplete offered. Hence `Telemetry`: one hook lists
 * what EXISTS, this one reports what is HAPPENING, and the names now say which.
 *
 * Chargers are not here; `charger-battery` is their widget. See
 * `wirelessChannelStatuses` for why mixing them poisons both figures.
 */
export function useWirelessTelemetry(enabled = true): DeviceStatus[] {
  const [channels, setChannels] = useState<DeviceStatus[]>([]);

  const load = useCallback(() => {
    invoke<DeviceStatus[]>("wireless:channelStatuses")
      .then((c) => setChannels(c ?? []))
      .catch(() => {
        /* not configured yet */
      });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    load();
  }, [load, enabled]);

  // The live path. Telemetry arrives coalesced and only on change, so this is
  // cheap on a quiet week and current during a service; the fetch above is only
  // the first paint before the first broadcast lands.
  useEffect(() => {
    if (!enabled) return;
    return onNotification(WIRELESS_STATUS_CHANNEL, (p) => {
      if (Array.isArray(p)) setChannels(p as DeviceStatus[]);
    });
  }, [enabled]);

  // Adding or removing a connection changes which channels exist at all, which
  // no telemetry broadcast will report — a removed receiver simply stops
  // sending.
  useEffect(() => {
    if (!enabled) return;
    return onNotification("wireless:connections-changed", () => load());
  }, [load, enabled]);

  return channels;
}
