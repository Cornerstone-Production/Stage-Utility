import { useCallback } from "react";

import { invoke } from "../lib/api";
import { useStatusChannel } from "./use-status-channel";
import { MESSAGES_CHANNEL, type MessageGroup, type MessagesState } from "@main/types/messages";

/** What the Screens page knows about message groups. `known` is false until the
 *  first answer lands; `failed` is a settled read that answered nothing, which is
 *  not the same as having no groups. */
export interface MessageGroups {
  groups: readonly MessageGroup[];
  known: boolean;
  failed: boolean;
}

/**
 * The message groups, live. Reads `messages:state` (which carries them), so a
 * group renamed or deleted in Settings -> Messages reaches an open Screens page
 * without a reload. Subscribed only where it is used: the Screens page.
 */
export function useMessageGroups(): MessageGroups {
  const read = useCallback(() => invoke<MessagesState>("messages:get"), []);
  const { value, known } = useStatusChannel<MessagesState>(read, MESSAGES_CHANNEL);
  return { groups: value?.groups ?? [], known, failed: known && value === null };
}
