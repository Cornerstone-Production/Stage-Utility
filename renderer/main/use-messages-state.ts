import { useCallback, useEffect } from "react";

import { invoke, onNotification } from "../lib/api";
import { logReadFailure } from "../lib/client-log";
import { monotonicNow, serverClock } from "../lib/server-clock";
import { useStatusChannel, type StatusChannelResult } from "./use-status-channel";
import { MESSAGES_CHANNEL, type MessagesState } from "@main/types/messages";

/**
 * The server's `serverNow` of the last live frame this page fed the clock, so the
 * several components that each subscribe do not each pool the same reading.
 */
let lastFed: number | null = null;

/**
 * The day's stage messages, the groups, the quick lists and the running alerts,
 * live: one read to hydrate, then `messages:state` pushes. Shared by the Messages
 * and Message composer widgets (gated to layouts that hold one), the alert overlay
 * (every kiosk screen) and the Screens page's group list.
 *
 * `known` matters: "No messages" off a `null` value is a claim only once the
 * channel has answered, and a value that stays null after it did is a read that
 * failed — which is not "nothing was sent".
 *
 * IT ALSO FEEDS THE SERVER CLOCK, which every one of those surfaces counts an alert
 * and an age against. Every snapshot carries `serverNow`, and this is the one
 * channel every kiosk screen holds, so a slots view or an unrouted screen (which
 * hold no other server timestamp) is corrected by it:
 *  - the hydrate READ is a request and an answer, so its round trip is measured and
 *    it is a paired sample, which sets a cold clock on its own; and it is not
 *    shared (see SHARED_READ_PATHS), because a read joined to an earlier caller's
 *    is older than this one's request and the pairing would be a lie;
 *  - a LIVE frame is an unpaired sample, which can only refine it. A replayed one
 *    is this page's own cache and says when it was first seen, so it is not read.
 */
export function useMessagesStatus(enabled = true): StatusChannelResult<MessagesState> {
  // A failed read is said on /log and then handed on: the channel settles as
  // answered-with-nothing (never "no messages"), and the live pushes still apply.
  const read = useCallback(async () => {
    const sentAt = monotonicNow();
    try {
      const state = await invoke<MessagesState>("messages:get");
      if (state && typeof state.serverNow === "number") serverClock.observe(state.serverNow, monotonicNow() - sentAt);
      return state;
    } catch (err) {
      logReadFailure("messages", "the stage messages", err);
      throw err;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    return onNotification(MESSAGES_CHANNEL, (payload: unknown, replayed: boolean) => {
      if (replayed) return;
      const at = (payload as { serverNow?: unknown } | null)?.serverNow;
      if (typeof at !== "number" || at === lastFed) return;
      lastFed = at;
      serverClock.observe(at);
    });
  }, [enabled]);

  return useStatusChannel<MessagesState>(read, MESSAGES_CHANNEL, enabled);
}
