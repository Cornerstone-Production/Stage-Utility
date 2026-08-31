// The page's name, and the page's own controls, as they appear IN the context
// bar.
//
// They used to be a band of their own. PageHeader drew a row under the strip
// with the title, a one-line description and the route's actions — 48px with a
// title alone, 70px with a description — so every desktop page carried two
// bands of chrome above its content, one saying what is happening and one
// saying where you are. They are one band now: the name goes at the head of the
// strip, the actions at its tail, and the second band is gone. The measurements
// behind that are in
// docs/superpowers/research/2026-08-30-header-context-bar-merge.md.
//
// THE NAME IS NOT A BAR ITEM, and its absence from BAR_ITEMS is deliberate
// rather than an oversight. The operator arranges the readings; the page's name
// is not one of them, it is the shell's — the same thing the phone's top bar has
// always carried. That distinction is what keeps "never drop an item the
// operator chose" true while this shortens: the ladder is shortening the
// shell's own chrome, not an item somebody placed.
//
// DESKTOP ONLY, and that is the whole of the phone story. Below 640px the
// phone's top bar already carries the name and the actions, and a merged phone
// strip was measured 3px past the floor with nothing left to ellipsise — the
// one failure `useBarFit` reports as `over`. `max-sm:hidden` rather than a JS
// width test, because a `display: none` element contributes no width at all: the
// fitter measures a phone's strip to exactly the pixel it did before this
// change, rather than to a number that happens to agree.

import type { ActivePage } from "./active-page";
import { usePageActionsSlot } from "./page-actions";

/**
 * The fewest characters of a page name the strip will ever show.
 *
 * The name is the FIRST thing on the row to give way — it is the only element in
 * the strip that may shrink above the floor, so flexbox takes its width before
 * the ladder is ever asked for a rung. Without a floor that is the nameless page
 * of #383 back again, arrived at by a different road: a strip narrow enough
 * would shrink the heading to nothing and the page would stop saying what it is.
 *
 * 14 because every name the SHELL owns is shorter than that. The longest
 * destination label is "Integrations" at 12, and the longest titled nested route
 * is "History" at 7 — so no built-in page is ever ellipsised, and
 * `page-title.test.tsx` asserts that against the real destination table rather
 * than trusting this comment.
 *
 * A CONSOLE's name is the one that can exceed it, because it is the operator's
 * own prose and has no length at all. That one ellipsises, which is right: it is
 * the same treatment the plan title and the item name get one rung further down,
 * and 14 characters is enough to tell two consoles apart.
 */
export const TITLE_FLOOR_CH = 14;

/**
 * What the title's width may shrink to.
 *
 * `max-content` for anything at or under the floor, so a short name is pinned to
 * its own width and CANNOT be shortened — which takes the font's metrics out of
 * it entirely for every name the shell owns. `ch` is the advance of a "0" and
 * only approximates a character in a proportional face, so leaning on it for
 * "Home" or "Integrations" would be trusting an estimate where an exact answer
 * is available. Only a name longer than the floor is measured in `ch`, and that
 * is a console's, where an approximate floor is all the question deserves.
 */
export function titleMinWidth(label: string): string {
  return label.length <= TITLE_FLOOR_CH ? "max-content" : `${TITLE_FLOOR_CH}ch`;
}

/**
 * The page's name, at the head of the strip.
 *
 * Only when the URL IS this page. A child route draws its own heading — the
 * layout editor puts the view's name in an editable field, a ScriptView plan
 * draws ScriptViewHeader — so the section's name in the strip above it would be
 * a second, wronger title. That is the exact-versus-prefix distinction #383
 * established, and it survives the merge unchanged.
 */
export function PageTitle({ active }: { active: ActivePage | null }) {
  if (!active?.exact) return null;
  const { label, description } = active.page;
  return (
    <h1
      className="bar-title max-sm:hidden text-subheadline font-semibold text-fg"
      // THE DESCRIPTION, with nowhere left to be printed. One 44px row has no
      // second line for it, and it is the cost of the band this change removes.
      // It is not deleted, though — every destination still carries one, the
      // parity guard still requires it, and it is here on hover. A tooltip is a
      // weaker affordance than the line it replaces and this comment is not
      // pretending otherwise; it is what a merged row can afford.
      title={description || undefined}
      style={{ minWidth: titleMinWidth(label) }}
    >
      {label}
    </h1>
  );
}

/**
 * The route's own controls, at the tail of the strip.
 *
 * Gated on `exact` for the same reason the title is, and because that is what
 * the header did: a route that draws its own heading draws its own controls with
 * it. Home's Edit control is the only thing in this slot today, and Home is
 * exact.
 *
 * `shrink-0`: the actions are buttons with hit targets, and a button squeezed
 * narrower than its label is not a smaller control, it is a broken one. The
 * title is the one thing on this row allowed to give way.
 */
export function PageActionsEnd({ active }: { active: ActivePage | null }) {
  // Read here rather than passed in: Shell renders the provider, so a hook call
  // in Shell's own body would sit outside it and always see nothing.
  const actions = usePageActionsSlot();
  if (!active?.exact || !actions) return null;
  return <div className="max-sm:hidden flex items-center gap-1.5 shrink-0">{actions}</div>;
}
