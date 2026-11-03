import { useCallback } from "react";

import { invoke } from "../lib/api";
import { useStatusChannel } from "./use-status-channel";
import { useStageState } from "./use-stage-state";
import { CHARGER_BAYS_CHANNEL } from "@main/types/devices";
import type { ChargerBayDTO } from "@main/types/state";

const NO_BAYS: ChargerBayDTO[] = [];

/**
 * Every charger bay, live: the charger widget, the Mic slots previews, and the
 * pickers that list a bay with its level.
 *
 * Bays are in stage state as well, but that is re-sent only when something
 * structural changes, so a pack charging read the same level until somebody
 * saved a layout. `wireless:chargers` carries the bays alone, on change. Until
 * it (or its read) has answered, the state's copy stands in.
 */
/** @param fallback  the bays to show until the channel answers; the stage
 *                   state's copy when not given. A layout passes its own. */
export function useChargerBays(fallback?: ChargerBayDTO[], enabled = true): { bays: ChargerBayDTO[]; known: boolean } {
  const { state } = useStageState();
  const read = useCallback(() => invoke<ChargerBayDTO[]>("wireless:chargerBays"), []);
  const { value, known, failed } = useStatusChannel<ChargerBayDTO[]>(read, CHARGER_BAYS_CHANNEL, enabled);
  if (Array.isArray(value) && !(failed && value.length === 0)) return { bays: value, known: true };
  return { bays: fallback ?? state?.chargerBays ?? NO_BAYS, known: known && !failed };
}
