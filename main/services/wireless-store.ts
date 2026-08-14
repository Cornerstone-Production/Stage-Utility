// Persists the CONFIG portion of wireless connections (id, name, providerId,
// enabled, config). Runtime fields (connection/message) are never persisted.

import { DataStore } from "./data-store.js";

export interface WirelessConnectionConfig {
  id: string;
  name: string;
  providerId: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

/**
 * This IS the DataStore — there is no wrapper.
 *
 * The object that used to sit here forwarded load() and save() verbatim and
 * added nothing else, in seven files. It had to be edited every time the store's
 * own API grew, and it hid update() and reload() from callers for no reason.
 */
export const wirelessStore = new DataStore<WirelessConnectionConfig[]>("wireless-connections.json", [], "config");
