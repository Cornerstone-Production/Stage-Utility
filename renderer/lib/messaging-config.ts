// messaging-config.ts — the one react-query definition of the messaging config
// (GET /api/messaging) for readers outside Settings -> Messages.
//
// The rule editor's To list reads the groups from it, and Settings -> Messages
// invalidates MESSAGING_CONFIG_KEY when it saves, so the two cannot spell the
// key differently and quietly stop talking.

import { errorMessage } from "@main/services/errors";

import type { MessagingConfig } from "@main/types/messages";
import { invoke } from "./api";
import { logToServer } from "./client-log";

export const MESSAGING_CONFIG_KEY = ["messaging:get"] as const;

export const messagingConfigQuery = {
  queryKey: MESSAGING_CONFIG_KEY,
  /** Logs once per failed fetch, to the server and not only the console, and
   *  rethrows: a list of groups that could not be read is an error the consumer
   *  can say so about, not an empty list. */
  queryFn: async (): Promise<MessagingConfig> => {
    try {
      return await invoke<MessagingConfig>("messaging:get");
    } catch (err) {
      logToServer("messages", `could not read the groups for the rule editor: ${errorMessage(err)}`);
      throw err;
    }
  },
};
