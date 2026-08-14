// Bare `/settings`, and the landing point for legacy `#hash` deep links.
//
// The old panel opened on a tab decided by the hash. There is no panel now, so
// this route resolves the hash to a route and replaces itself with it.

import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { Loader2Icon } from "lucide-react";
import { legacyHashRoute, SETTINGS_INDEX_ROUTE } from "./legacy-hash";

export function SettingsIndexRoute() {
  const router = useRouter();

  useEffect(() => {
    const target = legacyHashRoute(window.location.hash) ?? SETTINGS_INDEX_ROUTE;
    // `replace` so an old bookmark does not leave a /settings entry behind that
    // Back would bounce off. The old panel used replaceState for the same
    // reason: tab switches stayed out of the history stack.
    router.navigate({ to: target, replace: true });
  }, [router]);

  return (
    <div className="flex items-center justify-center h-full py-16">
      <Loader2Icon className="size-5 text-fg-subtle animate-spin" />
    </div>
  );
}
