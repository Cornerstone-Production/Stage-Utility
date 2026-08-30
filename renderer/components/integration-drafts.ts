// integration-drafts.ts — uncommitted setup-form edits, held OUTSIDE the card.
//
// A card MOVES HOUSE the moment its integration is enabled. The Integrations
// page lists unused integrations in a "Not set up" group at the bottom and
// everything else in category groups above, so flicking the switch takes the
// descriptor out of one group and puts it in another — a different place in the
// React tree. React unmounts the old card and mounts a new one, and anything the
// operator had typed lived in the old card's `useState` and died with it. Type an
// IP into an integration at the bottom of the page, enable it, and the card
// reappeared at the top with the field empty.
//
// Collapsing a card does the same thing on a smaller scale: Collapsible renders
// `{open && children}`, so closing one unmounts the form mid-edit.
//
// So the draft lives here, keyed by integration id, and the card seeds itself
// from whatever survived. Module-level rather than a React context because there
// is then no provider to forget — the panel is a singleton, and a card that is
// remounted somewhere else must find the same store either way. The panel clears
// it on unmount, so a draft lives exactly as long as the page is open.

/** Draft config per integration id. An id is present only while its form differs
 *  from what is saved — see the panel's dirty check. */
const drafts = new Map<string, Record<string, unknown>>();

/** Which field the operator was in when a card was last taken away from them.
 *  One-shot: taken by the next mount of that card, then forgotten, so a stale
 *  entry cannot yank focus into an unrelated re-render later. */
let pendingFocus: { id: string; key: string } | null = null;

export const integrationDrafts = {
  /** The surviving draft for an integration, or undefined if its form was clean. */
  get(id: string): Record<string, unknown> | undefined {
    return drafts.get(id);
  },
  set(id: string, config: Record<string, unknown>): void {
    drafts.set(id, config);
  },
  clear(id: string): void {
    drafts.delete(id);
    if (pendingFocus?.id === id) pendingFocus = null;
  },
  /** Everything goes when the page does. */
  clearAll(): void {
    drafts.clear();
    pendingFocus = null;
  },
  /** Remember where the caret is, in case this card is about to be remounted. */
  noteFocus(id: string, key: string): void {
    pendingFocus = { id, key };
  },
  /** The field this integration should return focus to, once. */
  takeFocus(id: string): string | null {
    if (pendingFocus?.id !== id) return null;
    const { key } = pendingFocus;
    pendingFocus = null;
    return key;
  },
};
