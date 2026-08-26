// Screens — every physical screen, what it shows, and whether it is on.
//
// Views and Displays were separate tabs and the join between them lived in the
// operator's head. One card per screen answers both, with a LIVE preview of
// what that screen is actually rendering.
//
// The card is OutputsSection's OutputRow, extended — not a parallel
// implementation. A first pass here built its own card grid and immediately had
// fewer controls than the thing it sat above, plus a picker whose placeholder
// was a selectable empty value that the server rejected. Extending the one that
// already worked is why every control survived.
//
// The Views master list is gone: editing a view is its own route, so opening
// the editor no longer scrolls the page and shifts it out of reach.
//
// Everything that list used to own now lives on this page. Creating a view is
// "New view..." in a screen's picker (and a button below the grid); renaming,
// duplicating and deleting are on the view itself; a view no screen shows
// appears under "Views not on a screen" rather than being reachable only from a
// side panel. Manual view REORDERING was dropped on purpose: nothing read the
// order except that one dropdown, which now sorts by name.

import { Loader2Icon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { OutputsSection } from "../../settings/sections/outputs-section";
import { useStageSettings } from "../use-stage-settings";
import { UnclaimedScreens } from "./unclaimed-screens";

export function ScreensRoute() {
  const s = useStageSettings();
  const router = useRouter();

  if (s.stageLoading || !s.stageState) {
    return (
      <div className="flex items-center justify-center h-full py-16">
        <Loader2Icon className="size-5 text-fg-subtle animate-spin" />
      </div>
    );
  }

  return (
    <div className="pb-[50vh] max-sm:pb-24">
      <OutputsSection
        stageState={s.stageState}
        handlers={s.handlers}
        onEditLayout={(viewId) => {
          // Select it too, so the editor's slot state resolves against the right
          // view the moment it mounts.
          s.setSelectedViewId(viewId);
          router.navigate({ to: `/screens/${viewId}/edit` as never });
        }}
      />
      {/* Screens found on the network that are not set up yet. Here rather than
          on a tab of their own: this page exists BECAUSE Views and Displays used
          to be separate tabs, and a Kiosks tab recreated that split one level
          down. */}
      {/* Claiming may CREATE an output; the page renders from stageState, which
          the server broadcasts on change, so nothing needs pulling back here. */}
      <UnclaimedScreens outputs={s.stageState.outputs} />
    </div>
  );
}
