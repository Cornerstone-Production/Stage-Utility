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
// A side panel docks beside the cards and follows the operator: while it is open,
// a click on a screen or a view moves it there. The Settings button in the page's
// actions opens and closes it, and the choice is remembered per browser.
//
// Everything that list used to own now lives on this page. Creating a view is
// "New view..." in a screen's picker (and a button below the grid); renaming,
// duplicating and deleting are on the view itself; a view no screen shows
// appears under "Views not on a screen" rather than being reachable only from a
// side panel. Manual view REORDERING was dropped on purpose: nothing read the
// order except that one dropdown, which now sorts by name.

import { useRef, useState } from "react";
import { Loader2Icon, PanelRightIcon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { OutputsSection, screenFlashId } from "../../settings/sections/outputs-section";
import { flashTarget } from "../flash";
import { FoundBanner } from "./found-banner";
import { NewViewDialog } from "../../settings/sections/new-view-dialog";
import { assignMadeView } from "../../settings/screen-role-confirm";
import type { ViewSurface } from "@main/types/views";
import { ScreenPanelHost } from "./screen-panel-host";
import type { PanelDevice, PanelTarget } from "../../settings/sections/screen-settings-panel";
import { deleteView, removeScreen } from "../../settings/sections/screen-confirms";
import { Button } from "../../components/ui";
import { usePageActions } from "../page-actions";
import { useStageSettings } from "../use-stage-settings";
import { UnclaimedScreens } from "./unclaimed-screens";
import { usePanelOpen } from "./use-panel-open";

export function ScreensRoute() {
  const s = useStageSettings();
  const router = useRouter();
  // Whether the panel is showing, and what it is on. Held HERE rather than in the
  // cards because things outside the card grid move it: the Add a screen tile, a
  // waiting device's "Set up as a new screen", and the panel itself.
  const [open, setOpen] = usePanelOpen();
  const [panel, setPanel] = useState<PanelTarget | null>(null);
  // Counts starts of a new screen, so pressing Add a screen again resets the form.
  const starts = useRef(0);
  // A screen's picker asked for a new view of this kind: the one dialog for it,
  // wherever the picker is (a card or the panel).
  const [newViewFor, setNewViewFor] = useState<{ outputId: string; surface: ViewSurface } | null>(null);

  // Any selection opens the panel: the operator asked to see it.
  function select(target: PanelTarget | null) {
    setPanel(target);
    setOpen(true);
  }
  function close() {
    setOpen(false);
    // A half-filled new screen is not kept: closing creates nothing. Nor is the note
    // after one that was made.
    setPanel((p) => (p?.kind === "new" ? null : p?.kind === "edit" ? { kind: "edit", outputId: p.outputId } : p));
  }

  usePageActions(
    <Button
      variant="filled"
      size="medium"
      aria-pressed={open}
      onClick={() => (open ? close() : setOpen(true))}
      tooltip="Show or hide the settings panel"
      className={open ? "border border-accent/55 bg-accent/12" : "border border-line-strong"}
    >
      <PanelRightIcon className="size-4" />
      Settings
    </Button>,
    [open],
  );

  if (s.stageLoading || !s.stageState) {
    return (
      <div className="flex items-center justify-center h-full py-16">
        <Loader2Icon className="size-5 text-fg-subtle animate-spin" />
      </div>
    );
  }

  const outputs = s.stageState.outputs ?? [];
  const newTarget = (device: PanelDevice | null): PanelTarget => ({
    kind: "new",
    device,
    start: ++starts.current,
    // A device is named for itself; an output of a Mac output helper for the
    // output, since all of a Mac's outputs share its hostname. A screen from the
    // Add tile is left unnamed, and the server names it "Display N" from the id it
    // gets: a count of the screens here repeats a name once one has been removed,
    // and an id is never reused.
    defaultName: device ? device.name || device.hostname || "New screen" : "",
  });
  function editLayout(viewId: string) {
    // Select it too, so the editor's slot state resolves against the right
    // view the moment it mounts.
    s.setSelectedViewId(viewId);
    router.navigate({ to: `/screens/${viewId}/edit` as never });
  }
  const state = s.stageState;
  function requestRemoveScreen(outputId: string) {
    const output = state.outputs?.find((o) => o.id === outputId);
    if (!output) return;
    void removeScreen({ output, state: { outputs: state.outputs ?? [], views: state.views ?? [] }, handlers: s.handlers });
  }
  function requestDeleteView(viewId: string) {
    const view = state.views?.find((v) => v.id === viewId);
    if (view) void deleteView({ view, outputs: state.outputs ?? [], handlers: s.handlers });
  }
  const addScreen = () => select(newTarget(null));
  const requestNewView = (outputId: string, surface: ViewSurface) => setNewViewFor({ outputId, surface });

  return (
    <div className="pb-[50vh] max-sm:pb-24 lg:flex lg:items-start lg:gap-4">
      <div className="min-w-0 flex-1">
        <OutputsSection
          // The same call the section's "Set up as a new screen" makes: the panel
          // opens on a new screen for the device, and nothing is made until it
          // finishes.
          banner={<FoundBanner onSetUp={(device) => select(newTarget(device))} />}
          stageState={s.stageState}
          handlers={s.handlers}
          serviceTypes={s.serviceTypes}
          panelOpen={open}
          selected={open ? panel : null}
          onSelect={select}
          onAddScreen={addScreen}
          onRequestNewView={requestNewView}
          onEditLayout={editLayout}
          onRemoveScreen={requestRemoveScreen}
          onDeleteView={requestDeleteView}
        />
        {/* Screens found on the network that are not set up yet. Here rather than
            on a tab of their own: this page exists BECAUSE Views and Displays used
            to be separate tabs, and a Kiosks tab recreated that split one level
            down. */}
        {/* Claiming "as a new screen" opens the panel instead of creating at once:
            a spare machine booting must not mint a screen nobody asked for, and a
            screen made in one click had no say in its view or its name. */}
        <UnclaimedScreens outputs={outputs} onSetUpNew={(device) => select(newTarget(device))} />
      </div>
      <NewViewDialog
        handlers={s.handlers}
        open={newViewFor !== null}
        fixedSurface={newViewFor?.surface}
        onOpenChange={(o) => { if (!o) setNewViewFor(null); }}
        onCreated={(id, name) => {
          // Assign it straight to the screen that asked: "+ New wall view" in a picker
          // is one action rather than create-then-go-find-it.
          const output = newViewFor && outputs.find((o) => o.id === newViewFor.outputId);
          if (output) {
            void assignMadeView({
              output,
              views: state.views ?? [],
              made: { id, name, surface: newViewFor.surface },
              setView: (viewId, expectSurface) => s.handlers.handleSetOutputView(output.id, viewId, expectSurface),
            });
          }
          setNewViewFor(null);
        }}
        trigger={<span className="hidden" />}
      />
      {open && (
        <ScreenPanelHost
          stageState={s.stageState}
          handlers={s.handlers}
          target={panel}
          onClose={close}
          onSelect={select}
          onAddScreen={addScreen}
          onRequestNewView={requestNewView}
          onCreated={(outputId, viewMade) => {
            // The panel stays open, on the screen that now exists, and its card is
            // scrolled to and outlined so the operator sees where it went.
            setPanel(outputId ? { kind: "edit", outputId, created: { viewMade } } : null);
            if (outputId) flashTarget(screenFlashId(outputId));
          }}
          onEditLayout={editLayout}
          onRemoveScreen={requestRemoveScreen}
          onDeleteView={requestDeleteView}
          onOpenMessagingSettings={() => router.navigate({ to: "/settings/messages" as never })}
        />
      )}
    </div>
  );
}
