import type { SlotDevice, StageState } from "../../main/types/stage";

/**
 * Merge a `slots:devices` push into the state a client already holds.
 *
 * RF and audio level move constantly while mics are live. They live on the slots
 * inside `stage:state`, so sending them meant re-sending the whole document —
 * 36.6 KB up to ~6.7 times a second, of which 88% was views, slot configuration
 * and layouts that had not changed. The server now pushes only the telemetry and
 * this puts it back where the components expect to find it.
 *
 * A slot missing from the map keeps whatever it had, so a partial or stale push
 * can never blank a reading — the worst case is a value that stops updating,
 * which the next full state push repairs.
 */
export function applyDeviceTelemetry(
  state: StageState,
  devices: Record<string, SlotDevice>,
): StageState {
  if (!devices || Object.keys(devices).length === 0) return state;

  let changed = false;
  const mapSlots = (slots: StageState["slotsByView"][string]) => {
    let touched = false;
    const next = slots.map((s) => {
      const d = devices[s.id];
      if (!d || d === s.device) return s;
      touched = true;
      return { ...s, device: d };
    });
    if (touched) changed = true;
    return touched ? next : slots;
  };

  const mapGroup = (group: StageState["slotsByView"]) => {
    const out: StageState["slotsByView"] = {};
    let touched = false;
    for (const [k, slots] of Object.entries(group)) {
      const next = mapSlots(slots);
      out[k] = next;
      if (next !== slots) touched = true;
    }
    return touched ? out : group;
  };

  const slotsByView = mapGroup(state.slotsByView ?? {});
  const slotsByLayoutObject = mapGroup(state.slotsByLayoutObject ?? {});

  // Returning the same object when nothing moved keeps React from re-rendering
  // every display on a push that changed nothing.
  if (!changed) return state;
  return { ...state, slotsByView, slotsByLayoutObject };
}
