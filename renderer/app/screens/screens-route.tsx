// Screens — every physical screen, what it shows, and whether it is on.
//
// Views and Displays were separate tabs and the join between them lived in the
// operator's head. This merges the two SURFACES; the data model is untouched
// and correct: a View is content, an Output is a screen, one View drives many.
//
// Every handler comes from useStageSettings unchanged, so a control that
// misbehaves here is a wiring problem rather than a rewritten one. The View
// library and its editor are the existing ViewsSection, rendered below the
// cards rather than reimplemented.

import { Loader2Icon, MonitorIcon, PencilIcon, TriangleAlertIcon } from "lucide-react";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue, Tooltip } from "../../components/ui";
import { ViewsSection } from "../../settings/sections/views-section";
import { OutputsSection } from "../../settings/sections/outputs-section";
import { useStageSettings } from "../use-stage-settings";
import { useOutputPresence } from "../home/use-output-presence";
import { screenRows, type ScreenRow } from "./screen-rows";
import { cn } from "../../lib/cn";

function ScreenCard({
  row,
  views,
  onAssign,
  onEdit,
}: {
  row: ScreenRow;
  views: View[];
  onAssign: (viewId: string) => void;
  onEdit: () => void;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3.5 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span
          className={cn("size-2 rounded-full shrink-0", row.online ? "bg-live-9" : "bg-fg-faint")}
          aria-hidden="true"
        />
        <span className="text-body font-semibold text-fg truncate flex-1">{row.name}</span>
        <span className="text-caption1 text-fg-subtle shrink-0">
          {row.online ? "Online" : "Offline"}
        </span>
      </div>

      {/* Opening the display is a full navigation to a chrome-free page, and a
          new tab so the operator does not lose their place here. This is the
          honest answer to "what is actually on that wall". */}
      <a
        href={`/${row.path}`}
        target="_blank"
        rel="noopener noreferrer"
        className="group relative block aspect-video rounded-lg border border-line bg-black overflow-hidden"
      >
        <span className="absolute inset-0 grid place-items-center text-caption1 text-white/70">
          {row.missingView ? "" : (row.viewName ?? "Nothing assigned")}
        </span>
        <span className="absolute inset-0 grid place-items-center bg-black/55 text-caption1 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          Open display
        </span>
      </a>

      <div className="flex items-center gap-2">
        <Select value={row.viewId ?? ""} onValueChange={onAssign}>
          <SelectTrigger className="h-7 flex-1 min-w-0 text-caption1">
            <SelectValue placeholder="Pick a view" />
          </SelectTrigger>
          <SelectContent>
            {views.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {row.missingView && (
          // A deleted View leaves the Output pointing at nothing. Silent, and
          // the screen shows a placeholder with no explanation.
          <Tooltip label="This screen points at a view that no longer exists">
            <TriangleAlertIcon className="size-4 text-warn-11 shrink-0" />
          </Tooltip>
        )}

        <Tooltip label={row.editableLayout ? "Edit this view's layout" : "Only custom views have a layout to edit"}>
          <button
            type="button"
            onClick={onEdit}
            disabled={!row.editableLayout}
            aria-label="Edit layout"
            className="shrink-0 rounded-lg p-1.5 text-fg-subtle transition-colors hover:bg-fill hover:text-fg disabled:opacity-35 disabled:hover:bg-transparent"
          >
            <PencilIcon className="size-4" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

export function ScreensRoute() {
  const s = useStageSettings();
  const online = useOutputPresence();

  if (s.stageLoading || !s.stageState) {
    return (
      <div className="flex items-center justify-center h-full py-16">
        <Loader2Icon className="size-5 text-fg-subtle animate-spin" />
      </div>
    );
  }

  const state = s.stageState;
  const rows = screenRows(state, online);
  const views = state.views ?? [];

  return (
    <div className="flex flex-col gap-6 pb-[50vh] max-sm:pb-24">
      <section className="px-5 max-sm:px-3 pt-1">
        {rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center">
            <MonitorIcon className="size-6 text-fg-faint mx-auto" />
            <p className="text-body text-fg mt-2">No screens yet</p>
            <p className="text-caption1 text-fg-subtle mt-1">
              Point a monitor at this address, then pick which display it is from Home.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((row) => (
              <ScreenCard
                key={row.outputId}
                row={row}
                views={views}
                onAssign={(viewId) => s.handlers.handleSetOutputView(row.outputId, viewId)}
                onEdit={() => {
                  // The layout editor lives in the View library below, keyed by
                  // selection — so editing a screen's layout is selecting its
                  // View there rather than a separate editor route.
                  if (row.viewId) s.setSelectedViewId(row.viewId);
                  document.querySelector("[data-flash-id='views-list']")?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  });
                }}
              />
            ))}
          </div>
        )}
      </section>

      {/* Screen management — add, rename, reorder, lock, remove, refresh — is
          still OutputsSection. The cards above are the at-a-glance join that
          did not exist before; they do not yet own those six controls, and
          dropping them to make the page tidier would be losing features to
          gain a layout. Folding them into the cards is a later pass. */}
      <OutputsSection stageState={state} handlers={s.handlers} />

      {/* The View library and its editor, unchanged. */}
      <ViewsSection
        stageState={state}
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
