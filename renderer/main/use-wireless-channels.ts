import { useCallback, useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";

/**
 * Flat list of every wireless channel across all configured connections (the
 * same data the slots bind to). Hydrates once and refetches whenever the
 * connection set changes (`wireless:connections-changed`). Backs the "Wireless
 * summary" layout object (mics online / lowest battery).
 */
export function useWirelessChannels(enabled = true): DeviceStatus[] {
  const [channels, setChannels] = useState<DeviceStatus[]>([]);

  const load = useCallback(() => {
    invoke<DeviceStatus[]>("wireless:listChannels")
      .then((c) => setChannels(c ?? []))
      .catch(() => {
        /* not configured yet */
      });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    load();
  }, [load, enabled]);

  useEffect(() => {
    if (!enabled) return;
    return onNotification("wireless:connections-changed", () => load());
  }, [load, enabled]);

  return channels;
}
