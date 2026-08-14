// Routes that shipped and then moved.
//
// Deleting a URL that has been in an operator's bookmarks - or in a Getting
// Started link - is a 404 for someone who did exactly what the app told them
// to. These render nothing and replace themselves.

import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

/** Where each retired path now points. */
export const MOVED_ROUTES: Record<string, string> = {
  // Plan folded into Home in Phase 2.
  "/plan": "/",
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
