// Home's cards, stored as a View.
//
// Carrying a debt: the design doc promised "Home becomes an editable console once
// edit mode exists (Phase 4)", Phase 2's out-of-scope list repeated it, and
// Phase 4's plan then contained no Home task at all. The deferral was dropped
// when that plan was written.
//
// The doc's premise was also wrong as built. It said "the widgets are identical
// in both cases, so nothing built early is discarded" — but Home's panels were
// bespoke React talking straight to the state hooks, not layout objects. That is
// why the home-* object types arrive in front of this: the widgets had to exist
// before the layout could.
//
// ── Why Home keeps a layout it does not lay out ──────────────────────────────
//
// Phase 6 gave Home a View and sent the operator to /screens/home/edit — the
// canvas editor — to change it. That was the wrong model. Nobody places pixels
// on a home dashboard: it is a stack of cards you either want or you do not, and
// a canvas asks an operator to answer a question they do not have. Phase 7
// replaced it with an Edit toggle in the Home tab itself.
//
// So Home keeps this View record, but reads only TWO things from it:
//
//   • which objects are present — a card that is not here is switched off
//   • the order they appear in — top to bottom, in array order
//
// Every object's x/y/w/h/z is IGNORED, along with the canvas size and fit. They
// are stored because the LayoutObject type requires them, not because anything
// reads them. Do not "fix" a Home card that overlaps another one in the numbers;
// nothing draws from those numbers.
//
// The alternative was a bespoke home.json holding a list of card ids. Rejected:
// the View already exists, already round-trips through views:setLayout, already
// lands in the config snapshot, and the objects in it are the same registry
// widgets a stage display uses. A second store would have been a second thing to
// back up, migrate and get wrong.

import type { View, LayoutObjectConfig } from "@main/types/views";

/** The id of the Home view. Stable, because Home routes to it by name. */
export const HOME_VIEW_ID = "home";

/**
 * Home's starting cards, in the order the fixed panels showed them.
 *
 * Deliberately close to what Home already drew — this is a migration, not a
 * redesign. An operator who never opens the editor should not be able to tell
 * that anything changed. Geometry is filler; see the note above.
 */
export function defaultHomeLayout() {
  // Typed against the real config union, so a card whose type is retired stops
  // compiling here rather than seeding an object nothing renders.
  type HomeCardConfig = Extract<LayoutObjectConfig, { type: `home-${string}` }>;
  // The id IS the type. One card of each kind, so there is nothing else it could
  // usefully be, and the editor mints the same id when a card is switched back
  // on — two schemes for the same objects would only be confusing in the file.
  //
  // The geometry stacks rather than piling every card on one spot. Home ignores
  // it — but an output BOUND to Home before Phase 7 keeps rendering through the
  // layout renderer (setOutputView refuses new bindings, it does not undo old
  // ones), and identical coordinates would draw four cards exactly on top of
  // each other. Filler, but not nonsense.
  let row = 0;
  const card = (config: HomeCardConfig) => ({
    id: config.type,
    x: 0.04, y: 0.04 + row++ * 0.24, w: 0.92, h: 0.2, z: 1,
    config,
    style: {},
  });
  return {
    version: 1 as const,
    canvas: { width: 1920, height: 1080, background: null, fit: "responsive" as const },
    objects: [
      // Live first, so a service that starts while Home is open puts the timer
      // at the top. It is the only card of its mood, so its position among the
      // idle cards never shows.
      card({ type: "home-live-status" }),
      card({ type: "home-next-service" }),
      card({ type: "home-readiness" }),
      card({ type: "home-recent-services" }),
    ],
  };
}

/**
 * Seed Home, and keep an UNEDITED Home on this build's defaults.
 *
 * Two conditions, and the second is the subtle one:
 *
 *  • Home is absent → create it. Obvious.
 *  • Home exists but has never been saved by a human (`layoutRev` unset) → give
 *    it this build's default cards.
 *
 * The second exists because a build can add a card. Home was seeded with two
 * cards and now ships with four; keying purely off existence would leave every
 * install that ran the older build permanently missing the two new ones, with
 * nothing in the UI to explain why — a feature removed by upgrade, silently.
 *
 * `layoutRev` is the right gate because it is incremented by views:setLayout and
 * by nothing else, so it is exactly "a person has changed this". An operator who
 * switches the readiness card off must not find it back next launch — restoring
 * what someone deliberately removed is the same class of bug as deleting what
 * they made — and after their first toggle `layoutRev` is 1, so this never
 * touches their Home again.
 *
 * Returns the views unchanged when there is nothing to do, so callers can
 * compare by reference and skip a write.
 */
export function seedHomeView(views: readonly View[]): View[] {
  const existing = views.find((v) => v.id === HOME_VIEW_ID);
  if (existing) {
    // `!= null`, not truthy: 0 means "saved once, at revision zero" to anyone
    // hand-writing views.json, and resetting their Home on that reading would be
    // the one thing this function must never do.
    if (existing.layoutRev != null) return views as View[];
    // Same cards already? Return the input untouched, so an unedited Home is not
    // rewritten to disk on every single launch.
    const want = defaultHomeLayout().objects.map((o) => o.config.type).join(",");
    const have = (existing.layout?.objects ?? []).map((o) => o.config.type).join(",");
    if (want === have) return views as View[];
    const refreshed = { ...existing, layout: defaultHomeLayout() } as View;
    return views.map((v) => (v.id === HOME_VIEW_ID ? refreshed : v));
  }
  const home: View = {
    id: HOME_VIEW_ID,
    name: "Home",
    kind: "custom",
    ndiSource: null,
    createdAt: new Date(0).toISOString(),
    surface: "console",
    layout: defaultHomeLayout(),
  } as View;
  return [...views, home];
}

/**
 * The views the Screens page lists, and offers to bind to an output.
 *
 * Home is not a screen. It is the operator's front door, edited in its own tab,
 * and it has no geometry — pointed at a wall monitor it would render a stack of
 * cards sized for a browser column. Listing it also invited the trip Phase 7
 * removed: open Screens, find "Home", edit it on a canvas.
 *
 * One helper rather than a filter at each call site, because there are SEVEN and
 * they are not all obvious: the per-output picker, the "Views not on a screen"
 * list, the rail's Consoles group, the embedded-view picker, the default
 * selection, and the two places that COUNT views to ask "has the operator made
 * one of their own yet?" — both of which a seeded Home answered wrongly.
 */
export function screensListViews<T extends { id: string }>(views: readonly T[]): T[] {
  return views.filter((v) => v.id !== HOME_VIEW_ID);
}
