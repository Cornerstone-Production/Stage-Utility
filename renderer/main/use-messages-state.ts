import { useCallback } from "react";

import { invoke } from "../lib/api";
import { logReadFailure } from "../lib/client-log";
import { useStatusChannel, type StatusChannelResult } from "./use-status-channel";
import { MESSAGES_CHANNEL, type MessagesState } from "@main/types/messages";

/**
 * The day's stage messages, the groups, the quick lists and the running alerts,
 * live: one read to hydrate, then `messages:state` pushes. Shared by the Messages
 * and Message composer widgets (gated to layouts that hold one), the alert overlay
 * (every kiosk screen) and the Screens page's group list.
 *
 * `known` matters: "No messages" off a `null` value is a claim only once the
 * channel has answered, and a value that stays null after it did is a read that
 * failed — which is not "nothing was sent".
 */
export function useMessagesStatus(enabled = true): StatusChannelResult<MessagesState> {
  // A failed read is said on /log and then handed on: the channel settles as
  // answered-with-nothing (never "no messages"), and the live pushes still apply.
  const read = useCallback(
    () =>
      invoke<MessagesState>("messages:get").catch((err: unknown) => {
        logReadFailure("messages", "the stage messages", err);
        throw err;
      }),
    [],
  );
  return useStatusChannel<MessagesState>(read, MESSAGES_CHANNEL, enabled);
}
