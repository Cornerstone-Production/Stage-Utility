/** Which rows a slot cell shows.
 *
 *  "live"    — live telemetry (RF bars, charge, battery). A manual label rides
 *            INSIDE this, in place of the frequency; it never suppresses it.
 *  "offline" — a manually-assigned device: its labels only, no telemetry.
 *  "none"    — nothing bound and nothing labeled.
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
  return "none";
}
