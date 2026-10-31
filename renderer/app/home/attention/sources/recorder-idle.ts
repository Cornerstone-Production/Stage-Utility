// The service is live and a recorder that is switched on is not recording.
//
// "Switched on" is the integration being enabled and connected. A recorder that
// cannot be reached is integration-down's to say, and asking it to record would
// only fail.

import { attentionKey, type AttentionInput, type AttentionItem, type AttentionSource } from "../types";

interface Recorder {
  id: "reaper" | "obs";
  fix: { actionId: string; params: Record<string, unknown> };
}

const RECORDERS: Recorder[] = [
  { id: "reaper", fix: { actionId: "reaper.transport", params: { command: "record" } } },
  { id: "obs", fix: { actionId: "obs.record", params: { command: "start" } } },
];

export const recorderIdle: AttentionSource = {
  id: "recorder-idle",
  items(input: AttentionInput): AttentionItem[] {
    if (input.mood !== "live" || !input.integrationsKnown) return [];
    const out: AttentionItem[] = [];
    for (const r of RECORDERS) {
      const status = r.id === "reaper" ? input.reaper : input.obs;
      const known = r.id === "reaper" ? input.reaperKnown : input.obsKnown;
      const enabled = input.integrations.some((i) => i.id === r.id && i.enabled);
      if (!enabled || !known || !status?.connected || status.recording) continue;
      const label = input.integrationLabels[r.id] ?? r.id;
      out.push({
        key: attentionKey("recorder-idle", r.id),
        severity: "warn",
        title: `${label} is not recording`,
        detail: `The service is live and ${label} is connected but idle`,
        fix: { label: "Start recording", action: r.fix },
      });
    }
    return out;
  },
};
