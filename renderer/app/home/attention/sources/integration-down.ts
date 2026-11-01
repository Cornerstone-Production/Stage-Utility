// An integration that has been down long enough to be a problem.
//
// "Down" is the context bar's own rule (integrationHealth): enabled, set up, and
// not inbound-only. Thirty seconds of it, because a reconnect after a blip is
// not news. `downSince` is when THIS browser first saw it down, so a page opened
// onto a long outage reports it after thirty seconds, not at once.

import { integrationFlashId } from "../../../../components/integrations-panel";
import { integrationHealth } from "../../../context-bar";
import { attentionKey, type AttentionInput, type AttentionItem, type AttentionSource } from "../types";

/** How long an integration must stay down before it is listed. */
export const DOWN_FOR_MS = 30_000;

/** The Planning Center integration: the one whose loss matters most mid-service. */
const PLANNING_CENTER = "planning-center";

export const integrationDown: AttentionSource = {
  id: "integration-down",
  items(input: AttentionInput): AttentionItem[] {
    if (!input.integrationsKnown) return [];
    const out: AttentionItem[] = [];
    for (const i of integrationHealth(input.integrations).down) {
      const since = input.downSince.get(i.id);
      if (since === undefined || input.now - since <= DOWN_FOR_MS) continue;
      const label = input.integrationLabels[i.id] ?? i.id;
      out.push({
        key: attentionKey("integration-down", i.id),
        severity: input.mood === "live" && i.id === PLANNING_CENTER ? "critical" : "warn",
        title: `${label} ${i.connection === "error" ? "has an error" : "is not connected"}`,
        detail: i.message ?? (i.connection === "error" ? "reported an error" : "disconnected"),
        fix: { label: "Open integration", route: "/settings/integrations", flash: integrationFlashId(i.id) },
      });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  },
};
