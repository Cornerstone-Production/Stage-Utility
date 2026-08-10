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

const store = new DataStore<WirelessConnectionConfig[]>("wireless-connections.json", [], "config");

export const wirelessStore = {
  async load(): Promise<WirelessConnectionConfig[]> {
    return store.load();
  },

  async save(connections: WirelessConnectionConfig[]): Promise<void> {
    return store.save(connections);
  },
};
