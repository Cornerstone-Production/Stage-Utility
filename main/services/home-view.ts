// Home as a View, so it is edited like every other surface.
//
// Carrying a debt: the design doc promised "Home becomes an editable console once
// edit mode exists (Phase 4)", Phase 2's out-of-scope list repeated it, and
// Phase 4's plan then contained no Home task at all. The deferral was dropped
// when that plan was written.
//
// The doc's premise was also wrong as built. It said "the widgets are identical
// in both cases, so nothing built early is discarded" — but Home's panels were
// bespoke React talking straight to the state hooks, not layout objects. That is
// why this arrives with home-readiness and home-next-service in front of it: the
// widgets had to exist before the layout could.

import type { View } from "@main/types/views";

/** The id of the Home view. Stable, because Home routes to it by name. */
export const HOME_VIEW_ID = "home";

/**
 * Home's starting layout.
 *
 * Deliberately close to what the fixed panel already showed — this is a
 * migration, not a redesign. An operator who never opens the editor should not
 * be able to tell that anything changed.
 */
export function defaultHomeLayout() {
  return {
    version: 1 as const,
    canvas: { width: 1920, height: 1080, background: null, fit: "responsive" as const },
    objects: [
      {
        id: "home-next",
        x: 0.04, y: 0.06, w: 0.92, h: 0.18, z: 1,
        config: { type: "home-next-service" as const },
        style: {},
      },
      {
        id: "home-ready",
        x: 0.04, y: 0.28, w: 0.92, h: 0.44, z: 2,
        config: { type: "home-readiness" as const },
        style: {},
      },
    ],
  };
}

/**
 * Seed Home if it is absent, and never touch it again.
 *
 * Idempotent in the way that matters: it keys off the view EXISTING, not off its
 * contents. An operator who deletes the readiness card must not find it back
 * next launch — restoring what someone deliberately removed is the same class of
 * bug as deleting what they made.
 *
 * Returns the views unchanged when Home is already there, so callers can compare
 * by reference and skip a write.
 */
export function seedHomeView(views: readonly View[]): View[] {
  if (views.some((v) => v.id === HOME_VIEW_ID)) return views as View[];
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
