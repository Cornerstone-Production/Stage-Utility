// One view's editor, on its own route.
//
// Editing used to mean selecting a view in a master list beside the editor, so
// opening it scrolled the page and shifted the editor out of reach. A view now
// has its own URL: the editor is the whole page, and the Screens cards are the
// list.
//
// This renders ViewDetail directly rather than a list-plus-detail screen
// hidden. A hidden component is one nobody uses and nobody maintains, and this
// codebase has already orphaned two editors that way.

import { useEffect } from "react";
import { Loader2Icon, ChevronLeftIcon } from "lucide-react";
import { useParams, useRouter } from "@tanstack/react-router";
import { HOME_VIEW_ID, screensListViews } from "@main/services/home-view";
import { AppLink } from "../app-link";
import { ViewDetail } from "../../settings/sections/view-detail";
import { useStageSettings } from "../use-stage-settings";

export function ViewEditorRoute() {
  const params = useParams({ strict: false }) as { viewId?: string };
  // PINNED to the view in the URL. Without it this hook instance defaults to
  // the first view, and the slot editor below both reads and saves through that
  // selection -- so editing the second slots view saved its slots onto the first.
  const s = useStageSettings(params.viewId);
  const router = useRouter();

  // Home is not edited here. Phase 6 pointed at this route and Phase 7 replaced
  // it with an Edit toggle in Home's own tab — nobody places pixels on a home
  // dashboard. The URL shipped, so it lands on the page that owns the editor
  // rather than 404ing. Handled here rather than in MOVED_ROUTES: a static
  // /screens/home/edit route would collide with this dynamic one.
  const isHome = params.viewId === HOME_VIEW_ID;
  useEffect(() => {
    if (isHome) router.navigate({ to: "/", replace: true });
  }, [isHome, router]);
  if (isHome) return null;

  if (s.stageLoading || !s.stageState) {
    return (
      <div className="flex items-center justify-center h-full py-16">
        <Loader2Icon className="size-5 text-fg-subtle animate-spin" />
      </div>
    );
  }

  // Home excluded: `canDelete` below is "is this the operator's last view?", and
  // counting a view they cannot see or delete would answer that wrong.
  const views = screensListViews(s.stageState.views ?? []);
  const view = views.find((v) => v.id === params.viewId);

  if (!view) {
    // A deleted view, or a stale link. Says so rather than rendering an empty
    // editor that looks like a loading state that never finishes.
    return (
      <div className="py-10 text-center">
        <p className="text-body text-fg">That view no longer exists.</p>
        <AppLink to="/screens" className="text-caption1 text-accent hover:underline mt-2 inline-block">
          Back to Screens
        </AppLink>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="pb-2">
        <AppLink
          to="/screens"
          className="inline-flex items-center gap-1 text-caption1 text-fg-muted hover:text-fg transition-colors"
        >
          <ChevronLeftIcon className="size-3.5" />
          Screens
        </AppLink>
      </div>
      <div className="flex-1 min-h-0">
        {/* Keyed by id so switching views resets the editor's local field state,
            exactly as the master-detail did. */}
        <ViewDetail
          key={view.id}
          view={view}
          // Arrived here from a screen's "Edit layout": go straight in.
          startEditing
          stageState={s.stageState}
          wirelessChannels={s.wirelessChannels}
          teamPositions={s.teamPositions}
          layoutTemplates={s.layoutTemplates}
          localSlots={s.localSlots}
          slotsDirty={s.slotsDirty}
          isSavingSlots={s.isSavingSlots}
          resolvedDraftSlots={s.resolvedDraftSlots}
          slotPresets={s.slotPresets}
          canDelete={views.length > 1}
          handlers={s.handlers}
        />
      </div>
    </div>
  );
}
