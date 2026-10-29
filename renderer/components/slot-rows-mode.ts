/** Which rows a slot cell shows.
 *
 *  "live"    — live telemetry (RF bars, charge, battery). A manual label rides
 *            INSIDE this, in place of the frequency; it never suppresses it.
 *  "offline" — a manually-assigned device: its labels only, no telemetry.
 *  "none"    — nothing bound, nothing labeled and no battery level known.
 *
 *  Extracted from slot-panel so the rule is testable without a DOM. Before this
 *  split, a label set on a LIVE device suppressed every row and took the RF
 *  bars and battery with it. */
export function slotRowsMode(
  device: {
    status: string;
    charge: number | null;
    iemCharge: number | null;
    label: string | null;
    iemLabel: string | null;
  },
  hideRf?: boolean,
): "live" | "offline" | "none" {
  const live = device.status === "ok" || device.status === "warn";
  if (live) {
    // With RF hidden there has to be something else worth a row.
    const hasTelemetry = !hideRf || device.charge !== null || device.iemCharge !== null;
    return hasTelemetry ? "live" : "none";
  }
  if (device.label !== null || device.iemLabel !== null) return "offline";
  // No live device and no label, but a battery level the slot still knows: a
  // charger bay's (chargeSource "charger") reaches a slot with no mic bound at
  // all, and an IEM pack answering beside an unbound mic reports its own. Shown
  // as a battery row with no bars. Before the rows replaced the strip this was a
  // charge-only pill, and dropping it hid a bay's level from the stage.
  if (device.charge !== null || device.iemCharge !== null) return "live";
  return "none";
}
