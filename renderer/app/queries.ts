// The queries every operator surface shares.
//
// Extracted from settings-view.tsx unchanged. No context provider: React Query
// is already the shared cache, so two routes calling the same key share one
// fetch and one cache entry. A provider would stack a second state layer on top
// and re-render every consumer whenever any part of it changed.
//
// THE KEYS ARE THE OLD KEYS, deliberately. 43 handlers and four SSE listeners
// write results back with setQueryData against these exact arrays. A tidier
// scheme would have detached every live update from the UI with nothing failing
// loudly — no error, no failed request, just a panel that stops reflecting
// reality. queries.test.ts asserts the exact strings for that reason.

import { useQuery } from "@tanstack/react-query";
import { invoke } from "../lib/api";
import type { WirelessChannel } from "../settings/types";

/** Matches settings-view.tsx's local helper, so the moved queryFns are identical. */
function ipc<T>(channel: string, ...args: unknown[]): Promise<T> {
  return invoke<T>(channel, args[0] as Record<string, unknown> | undefined);
}

export const QUERY_KEYS = {
  stageState: ["stage:getState"] as const,
  serviceTypes: ["stage:listServiceTypes"] as const,
  /** The service type is a LATER element so invalidating ["stage:listPlans"]
   *  with no id clears every variant by prefix — which handlers rely on. */
  plans: (serviceTypeId?: string | null) => ["stage:listPlans", serviceTypeId] as const,
  teamPositions: (serviceTypeId?: string | null) => ["stage:listTeamPositions", serviceTypeId] as const,
  wirelessChannels: ["wireless:listChannels"] as const,
  layoutTemplates: ["layoutTemplates:list"] as const,
  slotPresets: ["presets:list"] as const,
  updateStatus: ["update:status"] as const,
};

export function useStageStateQuery() {
  return useQuery({
    queryKey: QUERY_KEYS.stageState,
    queryFn: () => ipc<StageState>("stage:getState"),
  });
}

/**
 * All service types. Gated on PCO being configured, as the plan and
 * team-position queries below already are: without credentials the request can
 * only fail, and ungated it retried on every load — filling the server log with
 * "PCO not configured" handler errors on a machine that simply has not been set
 * up yet.
 */
export function useServiceTypes(stageState: StageState | undefined) {
  return useQuery({
    queryKey: QUERY_KEYS.serviceTypes,
    queryFn: () => ipc<ServiceTypeDTO[]>("stage:listServiceTypes"),
    enabled: !!stageState?.pcoConfigured,
  });
}

/** Plans for the selected service type. */
export function usePlans(stageState: StageState | undefined) {
  const serviceTypeId = stageState?.serviceTypeId;
  return useQuery({
    queryKey: QUERY_KEYS.plans(serviceTypeId),
    queryFn: () =>
      serviceTypeId
        ? ipc<PlanDTO[]>("stage:listPlans", { serviceTypeId })
        : Promise.resolve([]),
    enabled: !!serviceTypeId,
  });
}

/** Team positions for the position dropdown. */
export function useTeamPositions(stageState: StageState | undefined) {
  return useQuery({
    queryKey: QUERY_KEYS.teamPositions(stageState?.serviceTypeId),
    queryFn: () => ipc<TeamPositionDTO[]>("stage:listTeamPositions"),
    enabled: !!stageState?.serviceTypeId && !!stageState?.pcoConfigured,
  });
}

export function useWirelessChannels() {
  return useQuery({
    queryKey: QUERY_KEYS.wirelessChannels,
    queryFn: () => ipc<WirelessChannel[]>("wireless:listChannels"),
  });
}

/** Reusable custom-layout templates. */
export function useLayoutTemplates() {
  return useQuery({
    queryKey: QUERY_KEYS.layoutTemplates,
    queryFn: () => ipc<LayoutTemplate[]>("layoutTemplates:list"),
  });
}

/** Saved slot arrangements — global, recall into any view. */
export function useSlotPresets() {
  return useQuery({
    queryKey: QUERY_KEYS.slotPresets,
    queryFn: () => ipc<SlotPreset[]>("presets:list"),
  });
}

/** In-app update status (surfaced in Advanced). */
export function useUpdateStatus() {
  return useQuery({
    queryKey: QUERY_KEYS.updateStatus,
    queryFn: () => ipc<UpdateStatus>("update:status"),
  });
}
