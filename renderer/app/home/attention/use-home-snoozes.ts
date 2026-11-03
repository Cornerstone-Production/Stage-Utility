// Home's snoozes, shared by every browser: one read to hydrate, then
// `home:snoozes` pushes ordered by the server's rev.

import { useCallback, useEffect, useRef, useState } from "react";

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
  const latest = useRef(channel.value);
  useEffect(() => {
    latest.current = channel.value;
  }, [channel.value]);
  const refresh = useCallback(async () => {
    const before = latest.current;
    const next = await read();
    // A frame that landed while the read was out is at least as new as it: the
    // read starts after the server has committed this browser's change.
    if (latest.current === before) setFresh(next);
  }, [read]);
  // `fresh` only bridges the gap until the channel next speaks. It is dropped the
  // moment a new frame arrives, never compared to it by rev: the server's rev
  // restarts at 0 with every process, so after a restart a LOWER rev is the newer
  // truth, and a stale `fresh` that won on rev would hide live problems.
  const [seen, setSeen] = useState(channel.value);
  if (seen !== channel.value) {
    setSeen(channel.value);
    setFresh(null);
  }
  const value = fresh ?? channel.value;
  return { value, known: channel.known || fresh !== null, refresh };
}

/** Both reject with the server's reason; the caller says it. */
export function snoozeItem(key: string, severity: AttentionSeverity): Promise<unknown> {
  return invoke("home:snooze", { key, severity });
}

export function unsnoozeItem(key: string): Promise<unknown> {
  return invoke("home:unsnooze", { key });
}

/**
 * Run a snooze or unsnooze, then re-read the list for instant local feedback.
 *
 * The action's own failure is the caller's to report ("Could not snooze"). The
 * re-read is a courtesy: if it fails the snooze has still SAVED and the push still
 * delivers it, so it must not make a saved snooze read as a failed one. It is
 * named in the console instead.
 */
export async function thenRefresh(action: Promise<unknown>, refresh: () => Promise<void>): Promise<void> {
  await action;
  try {
    await refresh();
  } catch (err) {
    console.warn("[home] saved, but re-reading the snoozes failed; the next push will show it:", err);
  }
}
