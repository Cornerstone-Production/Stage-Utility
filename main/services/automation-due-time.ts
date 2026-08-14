// automation-due-time.ts — when a rule's chosen moment arrives.
//
// Two anchors because two things are worth keying off: the item's own scheduled
// time, and the service start.
//
// Item times come from PCO (current_item_time / next_item_time) rather than being
// derived from durations here, so "when is Doors due" matches what everyone sees
// in Planning Center instead of drifting from it.

export type DueAnchor = "item" | "service-start";

/**
 * Epoch ms at which the rule should fire, or null when the chosen anchor has no
 * usable time.
 *
 * Null rather than NaN: the caller must be able to say "unknown" in the Activity
 * log, and NaN would silently compare false against every clock check — the rule
 * would simply never fire, with nothing to explain why.
 */
export function dueAt(o: {
  anchor: DueAnchor;
  itemTimeIso: string | null;
  serviceStartIso: string | null;
  offsetMinutes: number;
}): number | null {
  const iso = o.anchor === "item" ? o.itemTimeIso : o.serviceStartIso;
  if (!iso) return null;
  const base = Date.parse(iso);
  if (Number.isNaN(base)) return null;
  return base + o.offsetMinutes * 60_000;
}
