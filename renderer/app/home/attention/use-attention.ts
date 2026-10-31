// Gathers what Needs attention reads, and turns it into an AttentionInput.
//
// Every channel is read through the hook its own widget uses, each with its own
// `known` flag. This only mounts while a Needs attention widget is placed, which
// is the gate: a Home without one opens none of these.

import { useMemo, useState } from "react";

import { useIntegrations } from "../../../main/use-integration-states";
import { useDisplayPresenceStatus } from "../../../main/use-display-presence";
import { useObsStatus } from "../../../main/use-obs-state";
import { projectedServiceEndMs } from "../../../main/pco-timer";
import { usePlanItemsStatus } from "../../../main/use-plan-items";
import { useReaperStatus } from "../../../main/use-reaper-state";
import { useWirelessTelemetryStatus } from "../../../main/use-wireless-telemetry";
import { integrationHealth } from "../../context-bar";
import { trackDownSince } from "./down-since";
import type { AttentionInput } from "./types";

/** Wireless channel id -> the name of the slot it is assigned to, across every board. */
export function assignedChannels(state: StageState): Map<string, string> {
  const out = new Map<string, string>();
  const slots = [...Object.values(state.slotsByView ?? {}), ...Object.values(state.slotsByLayoutObject ?? {})].flat();
  for (const slot of slots) {
    const label = slot.displayName || slot.channel;
    for (const b of [slot.deviceBinding, slot.iemBinding]) {
      if (b?.channelId && !out.has(b.channelId)) out.set(b.channelId, label);
    }
  }
  return out;
}

export function useAttentionInput(args: {
  mood: "live" | "idle";
  now: number;
  state: StageState;
  pcoLive: PcoLiveDTO | null;
}): AttentionInput {
  const { mood, now, state, pcoLive } = args;
  const presence = useDisplayPresenceStatus();
  const wireless = useWirelessTelemetryStatus();
  const integrations = useIntegrations();
  const reaper = useReaperStatus();
  const obs = useObsStatus();
  // The rundown is read only while live: it is what turns "26 minutes of
  // battery" into "enough for the 52 left", and idle has no service to be left in.
  const planItems = usePlanItemsStatus(mood === "live");

  const downIds = useMemo(
    () => integrationHealth(integrations.states).down.map((i) => i.id),
    [integrations.states],
  );
  // Derived while rendering, from the server's own clock (the one the source
  // compares against), rather than in an effect that would draw a stale frame first.
  const [tracked, setTracked] = useState(() => ({ ids: downIds, since: trackDownSince(new Map(), downIds, now) }));
  if (tracked.ids !== downIds) setTracked({ ids: downIds, since: trackDownSince(tracked.since, downIds, now) });
  const downSince = tracked.since;

  const assigned = useMemo(() => assignedChannels(state), [state]);

  const endMs = mood === "live" ? projectedServiceEndMs(pcoLive, planItems.value, now) : null;
  const minutesLeft = endMs === null ? null : Math.max(0, (endMs - now) / 60_000);

  return {
    mood,
    now,
    state,
    onlineOutputIds: presence.onlineOutputIds,
    onlineKnown: presence.known,
    lastSeen: presence.lastSeen,
    wireless: wireless.channels,
    wirelessKnown: wireless.known,
    assigned,
    minutesLeft,
    integrations: integrations.states,
    integrationLabels: integrations.labels,
    integrationsKnown: integrations.known,
    downSince,
    reaper: reaper.value,
    reaperKnown: reaper.known,
    obs: obs.value,
    obsKnown: obs.known,
  };
}
