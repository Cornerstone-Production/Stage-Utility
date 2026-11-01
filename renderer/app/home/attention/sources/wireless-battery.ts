// A pack in a slot that will not last the service.
//
// "Will it last" is the question, not "is it low": 30 minutes of battery is fine
// with 20 to go and a problem with 52. So where the receiver reports a runtime
// AND the service's remaining time is known, they are compared; otherwise the
// charge percentage stands in, at 20%. Equal is fine -- a pack with exactly the
// time left lasts exactly as long.
//
// Only channels assigned to a slot count. A spare in a drawer at 5% is not the
// operator's problem on Sunday morning. A pack on a charger is not either: its
// level is going up.

import { attentionKey, type AttentionInput, type AttentionItem, type AttentionSource } from "../types";

/** The percentage at or below which a pack is called low when runtime or the time left is unknown. */
export const LOW_BATTERY_PERCENT = 20;

export const wirelessBattery: AttentionSource = {
  id: "wireless-battery",
  items(input: AttentionInput): AttentionItem[] {
    if (!input.wirelessKnown) return [];
    const out: AttentionItem[] = [];
    for (const ch of input.wireless) {
      const slot = input.assigned.get(ch.channelId);
      if (slot === undefined || ch.deviceType === "charger" || ch.charging === true || !ch.online) continue;

      // Zero minutes left is a service that is overrunning, not one that is about
      // to end: comparing a runtime against 0 would never fire, so a pack nearly
      // empty in the longest service of the year would pass. It falls to the 20% rule.
      const byRuntime = ch.batteryMinutes !== null && input.minutesLeft !== null && input.minutesLeft > 0;
      const low = byRuntime
        ? ch.batteryMinutes! < input.minutesLeft!
        : ch.battery !== null && ch.battery <= LOW_BATTERY_PERCENT;
      if (!low) continue;

      const name = ch.name ?? slot;
      out.push({
        key: attentionKey("wireless-battery", ch.channelId),
        severity: input.mood === "live" ? "critical" : "warn",
        title: ch.battery !== null ? `${name} at ${Math.round(ch.battery)}%` : `${name} is running low`,
        detail: byRuntime
          ? `${slot} · about ${ch.batteryMinutes} min left, service has ${Math.round(input.minutesLeft!)} to go`
          : `${slot} · battery low`,
        // The Mic slots page has no per-channel control to flash, so no flash id.
        fix: { label: "Open slots", route: "/mic-slots" },
      });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  },
};
