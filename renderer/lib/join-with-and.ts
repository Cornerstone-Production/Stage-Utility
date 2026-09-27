// join-with-and.ts — "a" / "a and b" / "a, b and c": the house style every
// list-of-names sentence in the app reads in, no Oxford comma.
//
// Three private copies of this exact join (automation-section.tsx's
// joinWithAnd, bar-configurator.tsx's nameList, and cards.tsx's theList one
// step removed — see its own wrapper) drifted into being independently. One
// exported helper, so a fourth caller reaches for this rather than writing a
// fourth copy.

/** "a" / "a and b" / "a, b and c" — never an Oxford comma, and never dangling
 *  on a list of zero or one. */
export function joinWithAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
