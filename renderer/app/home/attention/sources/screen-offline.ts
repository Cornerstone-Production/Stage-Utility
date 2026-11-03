// A screen that has a view and no browser attached.
//
// A screen with no view is not here: that is the readiness check "A screen has
// no view", and "offline" would be the wrong word for something nobody routed.

import { screenFlashId } from "../../../../settings/sections/outputs-section";
import { splitByPresence } from "../../readiness";
import { attentionKey, type AttentionInput, type AttentionItem, type AttentionSource } from "../types";

/** "4 min ago", "3 h ago", or the day and time once it is more than a day. */
export function lastSeenText(at: number | undefined, now: number): string {
  if (at === undefined) return "never connected";
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 1) return "last seen just now";
  if (min < 60) return `last seen ${min} min ago`;
  if (min < 24 * 60) return `last seen ${Math.round(min / 60)} h ago`;
  return `last seen ${new Date(at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

export const screenOffline: AttentionSource = {
  id: "screen-offline",
  items(input: AttentionInput): AttentionItem[] {
    if (!input.onlineKnown) return [];
    const live = input.mood === "live";
    const { offline } = splitByPresence(input.state.outputs ?? [], input.onlineOutputIds);
    return offline
      .filter((o) => o.viewId)
      .map((o) => {
        const seen = input.lastSeen.get(o.id);
        return {
          key: attentionKey("screen-offline", o.id),
          severity: live ? ("critical" as const) : ("warn" as const),
          title: `${o.name} ${live && seen !== undefined ? "dropped" : "is offline"}`,
          detail: lastSeenText(seen, input.now),
          fix: { label: "Open screen", route: "/screens", flash: screenFlashId(o.id) },
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  },
};
