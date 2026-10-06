// Routes that shipped and then moved.
//
// Deleting a URL that has been in an operator's bookmarks - or in a Getting
// Started link - is a 404 for someone who did exactly what the app told them
// to. These render nothing and replace themselves.

import { useEffect } from "react";
import { redirect, useRouter } from "@tanstack/react-router";
import { MOVED_PAGE_PREFIXES, legacyPageRedirect } from "../../main/services/routes/operator-paths";

/** Where each retired path now points. */
export const MOVED_ROUTES: Record<string, string> = {
  // NOT here any more: /plan is a real page again. It folded into Home in Phase
  // 2 and came back out when Home became a grid — a fixed block of PCO controls
  // is furniture on a page whose whole point is that you arrange it.
  // Views and Displays merged into one Screens surface.
  "/views": "/screens",
  "/displays": "/screens",
  // NOT here: /screens/home/edit. It would collide with the /screens/$viewId/edit
  // route, and which one won would come down to TanStack's ranking rather than
  // intent. ViewEditorRoute sends Home home itself.
};

export function makeRedirect(to: string) {
  return function Redirect() {
    const router = useRouter();
    useEffect(() => {
      // `replace` so Back does not bounce off the retired path.
      router.navigate({ to, replace: true });
    }, [router]);
    return null;
  };
}

/**
 * Route patterns for the pages that moved to a new prefix (/scriptview to
 * /servicecue): the prefix itself and everything under it.
 *
 * Not in MOVED_ROUTES because a fixed target cannot carry the rest of the path
 * or the query string, and a display's address is made of both. The server
 * redirects a direct load with a 301 (legacy-page-routes.ts); this is the same
 * answer for an in-app link or a pushState that never reaches the server.
 */
export const MOVED_PAGE_ROUTE_PATTERNS: readonly string[] = MOVED_PAGE_PREFIXES.flatMap(([from]) => [from, `${from}/$`]);

/**
 * `beforeLoad` for those routes: throws a redirect to the new location, so the
 * old page never renders and Back does not bounce off it.
 */
export function redirectMovedPage(location: { pathname: string; search: unknown; hash: string }): never {
  const to = legacyPageRedirect(location.pathname);
  if (to === null) throw new Error(`redirectMovedPage was given ${location.pathname}, which did not move`);
  throw redirect({ to, search: location.search as Record<string, unknown>, hash: location.hash || undefined, replace: true });
}
