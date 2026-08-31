// A picker whose options are read LIVE from Planning Center.
//
// Two settings panels do this — which calendars and tags a calendar View draws,
// and which note categories and teams become the pre-service checklist — and
// both had their own copy of the same function, differing only in the shape of
// an item. Both appended the same marker, both ordered live-then-missing, and
// their headers quoted the same rationale at each other. Changing the wording,
// the ordering, or adding de-duplication in one would have left the other
// silently on the old behaviour; the IpListField duplication this release
// removed was the same shape.
//
// THE RULE, in one place:
//
// Options come from PCO rather than from a stored copy, because a tag or a
// category renamed there has to appear under its new name — a picker built from
// a remembered list is how somebody ends up choosing an option that matches
// nothing and cannot tell why their view is empty.
//
// A stored choice PCO no longer offers is KEPT and MARKED, never dropped.
// Dropping it silently unselects the operator's choice, with nothing on screen
// to explain what changed. What that costs differs — the checklist goes empty,
// the calendar widens to everything — but the answer is the same either way.
//
// Live first, missing after: the list is something to pick from, and a name
// that is no longer offered is a footnote to it.

import type { MultiSelectOption } from "../../components/ui";

/** Appended to a stored choice Planning Center no longer offers. */
export const NOT_OFFERED = "(not in Planning Center)";

/**
 * What PCO offers, plus any stored choice it no longer does, marked.
 *
 * @param offered what PCO returned just now.
 * @param chosen  what is stored on the view or in settings.
 * @param id      the value MultiSelect works in — PCO's id, or the name itself
 *                where the name IS the stored value.
 * @param label   what the operator reads. It has to answer for a missing choice
 *                too, which is why a stored NAME is worth keeping beside an id:
 *                without one a deleted tag shows as a hex string.
 */
export function optionsFor<T>(
  offered: readonly T[],
  chosen: readonly T[],
  { id, label }: { id: (item: T) => string; label: (item: T) => string },
): MultiSelectOption[] {
  const live = new Set(offered.map(id));
  const missing = chosen.filter((c) => !live.has(id(c)));
  return [
    ...offered.map((o) => ({ value: id(o), label: label(o) })),
    ...missing.map((c) => ({ value: id(c), label: `${label(c)} ${NOT_OFFERED}` })),
  ];
}
