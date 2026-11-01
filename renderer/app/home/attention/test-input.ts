// A healthy AttentionInput to override, for the tests. Everything is known and
// nothing is wrong, so a test names only the one thing it is about.

import type { DeviceStatus } from "@main/types/devices";
import type { IntegrationState } from "@main/types/integrations";
import type { AttentionInput } from "./types";

export function mic(channelId: string, over: Partial<DeviceStatus> = {}): DeviceStatus {
  return {
    channelId, name: channelId, deviceType: "receiver", online: true, rfBars: 5, rfLevelDbm: -50,
    battery: 90, batteryMinutes: 300, charging: false, frequencyLabel: null, audioLevel: null,
    cycles: null, health: null, tempC: null, updatedAt: "2026-10-30T00:00:00Z", ...over,
  };
}

export function integration(id: string, over: Partial<IntegrationState> = {}): IntegrationState {
  return { id, enabled: true, connection: "connected", message: null, config: {}, configured: true, ...over };
}

export function attentionInput(over: Partial<AttentionInput> = {}): AttentionInput {
  return {
    mood: "idle",
    now: 1_000_000_000_000,
    state: {
      pcoConfigured: true, serviceTypeName: "Weekend", planId: "p1", planTitle: "A plan",
      views: [{ id: "home" }, { id: "v1" }, { id: "v2" }], outputs: [],
    } as unknown as StageState,
    onlineOutputIds: [],
    onlineKnown: true,
    lastSeen: new Map(),
    wireless: [],
    wirelessKnown: true,
    assigned: new Map(),
    minutesLeft: null,
    integrations: [],
    integrationLabels: {},
    integrationsKnown: true,
    downSince: new Map(),
    reaper: null,
    reaperKnown: true,
    obs: null,
    obsKnown: true,
    resi: null,
    resiKnown: true,
    youtube: null,
    youtubeKnown: true,
    ...over,
  };
}
