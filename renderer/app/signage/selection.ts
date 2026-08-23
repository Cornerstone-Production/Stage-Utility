// selection.ts — click, cmd-click, shift-click over a list.
//
// PURE, and its own module because range selection is where this kind of thing
// quietly goes wrong: an anchor that no longer exists, a range dragged upward, a
// shift-click with nothing to extend from, a list that reordered underneath a
// selection. Each of those is one line here and one test below, rather than a
// pile of conditionals inside a grid component.
//
// The behaviour is the platform's, because that is what an operator already
// knows: plain click replaces, cmd (or ctrl) toggles one, shift extends from the
// last thing clicked.

export interface Selection {
  /** Selected ids, in no particular order. */
  readonly ids: readonly string[];
  /**
   * The last id clicked WITHOUT shift — what a shift-click extends from.
   *
   * Kept separately from the selection because it is not the same thing: after
   * shift-clicking a range the anchor stays where it was, so extending again
   * grows or shrinks that range rather than starting a new one from its end.
   */
  readonly anchor: string | null;
}

export const EMPTY: Selection = { ids: [], anchor: null };

/** Which modifier keys were held. `meta` is cmd on a Mac, ctrl elsewhere. */
export interface Mods {
  meta: boolean;
  shift: boolean;
}

/** Read the modifiers off a mouse event, so callers do not each decide what
 *  counts — ctrl-click is a right-click on a Mac, but ctrl is the toggle
 *  everywhere else, and metaKey covers the Mac case. */
export function modsOf(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): Mods {
  return { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey };
}

/**
 * The selection after clicking `id` in a list currently displayed as `order`.
 *
 * `order` is the list AS SHOWN — sorted and filtered — because that is what a
 * shift-click means to the person doing it: everything between the two things
 * they can see, not everything between them in some underlying order.
 */
export function clickSelect(
  current: Selection,
  order: readonly string[],
  id: string,
  mods: Mods,
): Selection {
  if (mods.shift && current.anchor && order.includes(current.anchor)) {
    const from = order.indexOf(current.anchor);
    const to = order.indexOf(id);
    if (to === -1) return current;
    const [lo, hi] = from <= to ? [from, to] : [to, from];
    // The anchor does NOT move: extending again re-draws the range from the same
    // place rather than crawling along the list one shift-click at a time.
    return { ids: order.slice(lo, hi + 1), anchor: current.anchor };
  }

  if (mods.meta) {
    const has = current.ids.includes(id);
    return {
      ids: has ? current.ids.filter((x) => x !== id) : [...current.ids, id],
      // Toggling sets the anchor either way. Shift-clicking after a cmd-click
      // extends from the thing just clicked, which is what every file manager
      // does and what the hand expects.
      anchor: id,
    };
  }

  return { ids: [id], anchor: id };
}

/** Select everything currently shown. */
export function selectAll(order: readonly string[]): Selection {
  return { ids: [...order], anchor: order[order.length - 1] ?? null };
}

/**
 * Drop ids that no longer exist.
 *
 * Called after a delete or a reload. Without it a selection keeps naming rows
 * that are gone, and the next "delete selection" reports a count larger than
 * what it removed.
 */
export function pruneSelection(current: Selection, existing: readonly string[]): Selection {
  const live = new Set(existing);
  const ids = current.ids.filter((id) => live.has(id));
  if (ids.length === current.ids.length && (current.anchor === null || live.has(current.anchor))) {
    return current;
  }
  return { ids, anchor: current.anchor && live.has(current.anchor) ? current.anchor : null };
}

/**
 * What a right-click should act on.
 *
 * Right-clicking INSIDE a selection acts on the whole selection; right-clicking
 * outside it acts on the one row and selects it. Anything else surprises: a menu
 * that silently dropped a ten-item selection because the pointer was over one of
 * them is how an operator deletes one file believing they deleted ten, or the
 * reverse.
 */
export function contextTarget(current: Selection, id: string): Selection {
  return current.ids.includes(id) ? current : { ids: [id], anchor: id };
}
