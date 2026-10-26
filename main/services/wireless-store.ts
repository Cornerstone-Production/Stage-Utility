// Persists the CONFIG portion of wireless connections (id, name, providerId,
// enabled, config). Runtime fields (connection/message) are never persisted.

import { DataStore } from "./data-store.js";
import { checked, optional, targetEntries } from "./restore-check.js";
import { splitConfig } from "./wireless-credentials.js";

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
export const wirelessStore = new DataStore<WirelessConnectionConfig[]>("wireless-connections.json", [], "config", {
  // PATCH /api/wireless/connections/:id: a text name and provider, a boolean
  // enabled, an object config — and a credential in the config never reaches
  // this file, which splitConfig keeps out on a save. A restore cannot write
  // secrets.bin, so a credential in a restored config is dropped, not stored.
  restoreCheck: checked((raw) =>
    targetEntries(raw, "the wireless connections").map((c, i) => {
      optional(c.providerId, "string", `wireless connection ${i + 1}'s provider`);
      return { ...c, config: splitConfig((c.config ?? {}) as Record<string, unknown>).safe };
    }),
  ),
});
