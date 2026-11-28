// qsys-allow-entry.ts — the allowlist entry a control gets when it is added from
// the Core's catalog. One rule, imported by the server (an "add all of a panel's
// controls") and by /qsys/manage (Add a control), so a control added either way
// lands identically.

import type { AllowEntry } from "./qsys";

/** The longest label an allowlist entry may carry. */
export const MAX_LABEL = 120;

/** What a catalog control must say for an entry to be built from it. */
export interface CatalogRange {
  Name: string;
  ValueMin?: number;
  ValueMax?: number;
}

/**
 * The entry for a control added from the catalog: labelled "<component> <control>"
 * (two components' `gain` stay apart; cut to MAX_LABEL), limited to the Core's own
 * range (null when it reports none, or only half of one), no confirm.
 */
export function allowEntryFor(component: string, c: CatalogRange): AllowEntry {
  const ranged = Number.isFinite(c.ValueMin) && Number.isFinite(c.ValueMax) && c.ValueMin! <= c.ValueMax!;
  return {
    component,
    control: c.Name,
    label: `${component} ${c.Name}`.slice(0, MAX_LABEL),
    min: ranged ? c.ValueMin! : null,
    max: ranged ? c.ValueMax! : null,
    confirm: "none",
  };
}
