// messages-store.ts — the day's stage messages, so a restart mid-service keeps
// the thread.
//
// "runtime", NOT "config", and the distinction is the design. A message is an
// observation about one day: restoring a backup from last winter and having its
// "Walk now" reappear on this Sunday's screens would be worse than starting
// empty. The groups the messages went to are the operator's work and live in
// messaging-store.ts, which a backup does carry.
//
// The messages service is the only writer; it owns the nightly clear, the cap
// and the broadcast. This module is the file and its shape.

import type { StageMessage } from "../types/messages.js";
import { DataStore } from "./data-store.js";

export interface MessagesFile {
  /**
   * The calendar date, in the app time zone, on which the thread was last
   * cleared (or first started). Null only before the first start. Compared each
   * minute against today's date so a server that was off at midnight clears the
   * stale day on boot.
   */
  lastClearedDate: string | null;
  /** Oldest first. */
  messages: StageMessage[];
}

export const messagesStore = new DataStore<MessagesFile>(
  "messages.json",
  { lastClearedDate: null, messages: [] },
  "runtime",
);
