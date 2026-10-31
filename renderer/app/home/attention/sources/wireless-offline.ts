// A mic in a slot that is not reporting, during the service.
//
// Only while live. Packs sit switched off all week, and an offline mic on a
// Tuesday is not a fault; the same mic mid-service is silence on stage.

import { attentionKey, type AttentionInput, type AttentionItem, type AttentionSource } from "../types";

export const wirelessOffline: AttentionSource = {
  id: "wireless-offline",
  items(input: AttentionInput): AttentionItem[] {
    if (!input.wirelessKnown || input.mood !== "live") return [];
    const out: AttentionItem[] = [];
    for (const ch of input.wireless) {
      const slot = input.assigned.get(ch.channelId);
      if (slot === undefined || ch.deviceType === "charger" || ch.online) continue;
      out.push({
        key: attentionKey("wireless-offline", ch.channelId),
        severity: "critical",
        title: `${ch.name ?? slot} is offline`,
        detail: `${slot} · not reporting`,
        fix: { label: "Open slots", route: "/mic-slots" },
      });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  },
};
