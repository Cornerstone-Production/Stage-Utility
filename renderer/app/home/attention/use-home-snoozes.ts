// Home's snoozes, shared by every browser: one read to hydrate, then
// `home:snoozes` pushes ordered by the server's rev.

import { useCallback, useState } from "react";

import { invoke } from "../../../lib/api";
import { useStatusChannel } from "../../../main/use-status-channel";
import { HOME_SNOOZES_CHANNEL, type AttentionSeverity, type HomeSnoozesState } from "@main/types/home-snoozes";

export interface HomeSnoozesHandle {
  value: HomeSnoozesState | null;
  known: boolean;
  /** Read the list again, now. The browser that pressed Snooze calls this when
   *  the server has answered, so it shows its own change at once instead of
   *  waiting for the push to come back round. Every other browser relies on the
   *  push. */
  refresh: () => Promise<void>;
}

export function useHomeSnoozes(enabled = true): HomeSnoozesHandle {
  const read = useCallback(() => invoke<HomeSnoozesState>("home:getSnoozes"), []);
  const channel = useStatusChannel<HomeSnoozesState>(read, HOME_SNOOZES_CHANNEL, enabled);
  const [fresh, setFresh] = useState<HomeSnoozesState | null>(null);
  const refresh = useCallback(async () => {
    setFresh(await read());
  }, [read]);
  // Whichever is newer by the server's rev; a push that lands after wins again.
  const value = fresh && (!channel.value || fresh.rev >= channel.value.rev) ? fresh : channel.value;
  return { value, known: channel.known || fresh !== null, refresh };
}

/** Both reject with the server's reason; the caller says it. */
export function snoozeItem(key: string, severity: AttentionSeverity): Promise<unknown> {
  return invoke("home:snooze", { key, severity });
}

export function unsnoozeItem(key: string): Promise<unknown> {
  return invoke("home:unsnooze", { key });
}
