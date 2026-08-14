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

import { Loader2Icon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { OutputsSection } from "../../settings/sections/outputs-section";
import { ViewsSection } from "../../settings/sections/views-section";
import { useStageSettings } from "../use-stage-settings";

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

      {/* The view manager, PENDING INTEGRATION - not hidden.
          The cards above and the per-view editor route now cover the main flow
          (see a screen, edit its layout on its own page). What still lives only
          here is creating a view, duplicating one, reordering them, and reaching
          a view that no screen currently shows. Until those have a home on this
          page, deleting this would take four capabilities with it - and hiding
          it would leave a component nobody uses and nobody maintains, which is
          how two editors were already orphaned once.
          reachable.test.ts fails if this stops being rendered, so it cannot be
          quietly dropped or quietly forgotten. */}
      <ViewsSection
        stageState={s.stageState}
        wirelessChannels={s.wirelessChannels}
        teamPositions={s.teamPositions}
        layoutTemplates={s.layoutTemplates}
        selectedViewId={s.selectedViewId}
        setSelectedViewId={s.setSelectedViewId}
        localSlots={s.localSlots}
        slotsDirty={s.slotsDirty}
        isSavingSlots={s.isSavingSlots}
        resolvedDraftSlots={s.resolvedDraftSlots}
        slotPresets={s.slotPresets}
        handlers={s.handlers}
      />
    </div>
  );
}
