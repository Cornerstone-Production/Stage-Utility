// Routes that shipped and then moved.
//
// Deleting a URL that has been in an operator's bookmarks - or in a Getting
// Started link - is a 404 for someone who did exactly what the app told them
// to. These render nothing and replace themselves.

import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

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
