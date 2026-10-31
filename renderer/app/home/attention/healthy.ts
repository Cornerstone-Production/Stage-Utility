// The line under the list: everything that is fine, in a few words.
//
// A source that has not answered adds nothing, as it adds no item -- "7 of 8
// mics" built from telemetry that has not arrived would be a claim.

import { splitByPresence } from "../readiness";
import { integrationHealth } from "../../context-bar";
import { attentionKey, type AttentionInput, type AttentionItem } from "./types";

export function healthyLine(input: AttentionInput, items: readonly AttentionItem[]): string[] {
  const bad = new Set(items.map((i) => i.key));
  const out: string[] = [];

  if (input.onlineKnown) {
    const routed = (input.state.outputs ?? []).filter((o) => o.viewId);
    if (routed.length > 0) {
      const { online } = splitByPresence(routed, input.onlineOutputIds);
      // Nothing is "healthy" about 0 of 3: the problems above say it.
      if (online.length > 0) out.push(`${online.length} of ${routed.length} screens`);
    }
  }

  if (input.wirelessKnown) {
    const mics = input.wireless.filter((c) => c.deviceType !== "charger" && input.assigned.has(c.channelId));
    if (mics.length > 0) {
      const fine = mics.filter(
        (c) => c.online && !bad.has(attentionKey("wireless-battery", c.channelId)),
      ).length;
      if (fine > 0) out.push(`${fine} of ${mics.length} mics`);
    }
  }

  if (input.integrationsKnown) {
    for (const i of integrationHealth(input.integrations).setUp) {
      if (i.connection !== "connected" || bad.has(`integration-down:${i.id}`)) continue;
      out.push(input.integrationLabels[i.id] ?? i.id);
    }
  }
  return out;
}
