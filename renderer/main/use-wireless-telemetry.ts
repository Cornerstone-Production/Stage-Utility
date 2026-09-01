import { useCallback, useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";
import { useStatusChannel } from "./use-status-channel";
import { WIRELESS_STATUS_CHANNEL, type DeviceStatus } from "@main/types/devices";

/** Stable identity, so a hook with nothing yet does not hand a new array out per render. */
const NO_CHANNELS: DeviceStatus[] = [];

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
 *
 * Ordering between the read and the first push is useStatusChannel's job — see
 * the note there. Telemetry is coalesced and broadcast only on change, so a read
 * landing after a frame leaves a pack showing yesterday's battery until it next
 * moves a bar.
 */
export function useWirelessTelemetry(enabled = true): DeviceStatus[] {
  // Adding or removing a connection changes which channels exist at all, which
  // no telemetry broadcast will report — a removed receiver simply stops
  // sending. Bumping this re-identifies `read`, which is what useStatusChannel
  // treats as a fresh window: it re-subscribes and re-reads, ordering intact.
  const [connectionsRev, setConnectionsRev] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    return onNotification("wireless:connections-changed", () => setConnectionsRev((n) => n + 1));
  }, [enabled]);

  const read = useCallback(() => {
    void connectionsRev;
    return invoke<DeviceStatus[]>("wireless:channelStatuses");
  }, [connectionsRev]);

  const channels = useStatusChannel<DeviceStatus[]>(read, WIRELESS_STATUS_CHANNEL, enabled);
  return Array.isArray(channels) ? channels : NO_CHANNELS;
}
