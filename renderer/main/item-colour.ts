import type { PcoItemTypeColor } from "../../main/types/stage.js";

/** PCO stores #ffffff to mean "no colour" — it is the shipped default on Media. */
const UNSET = "#ffffff";

/**
 * The PCO item row colour for one item, or null when PCO says nothing about it.
 *
 * Custom types are checked first: they match text CONTAINED in the title, which the
 * operator typed deliberately, so they beat the broad standard-type match.
 */
export function resolveItemColour(
  item: { itemType: string; title: string },
  colours: PcoItemTypeColor[] | undefined,
): string | null {
  if (!colours || colours.length === 0) return null;
  const title = item.title.toLowerCase();
  const type = item.itemType.trim().toLowerCase();

  for (const c of colours) {
    if (!c.custom) continue;
    const needle = c.name.trim().toLowerCase();
    // "" is contained in every string — a blank entry must not paint the whole plan.
    if (!needle) continue;
    if (title.includes(needle)) return c.color === UNSET ? null : c.color;
  }

  for (const c of colours) {
    if (c.custom) continue;
    if (c.name.trim().toLowerCase() === type) return c.color === UNSET ? null : c.color;
  }

  return null;
}
