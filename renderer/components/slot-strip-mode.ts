/** Which pill a slot cell shows.
 *
 *  "strip" — live telemetry (RF bars, charge, battery). A manual label rides
 *            INSIDE this, in place of the frequency; it never suppresses it.
 *  "pill"  — a manually-assigned (offline) device: labels only, no telemetry.
 *  "none"  — nothing bound and nothing labelled.
 *
 *  Extracted from slot-panel so the rule is testable without a DOM. Before this
 *  split, a label set on a LIVE device suppressed the whole strip and took the RF
 *  bars and battery with it. */
export function slotStripMode(
  device: {
    status: string;
    charge: number | null;
    iemCharge: number | null;
    label: string | null;
    iemLabel: string | null;
  },
  hideRf?: boolean,
): "strip" | "pill" | "none" {
  const live = device.status === "ok" || device.status === "warn";
  if (live) {
    // With RF hidden there has to be something else worth a pill.
    const hasTelemetry = !hideRf || device.charge !== null || device.iemCharge !== null;
    return hasTelemetry ? "strip" : "none";
  }
  if (device.label !== null || device.iemLabel !== null) return "pill";
  return "none";
}
