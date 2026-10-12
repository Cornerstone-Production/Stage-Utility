// The Screen settings panel, wired to the app: the stage state it reads, the
// per-field handlers it writes through, and the pieces that live beside it (the
// new-view dialog, the device claim).
//
// ScreenSettingsPanel itself reads only props and calls only callbacks, so it can
// be driven with no server behind it. This is the one place that knows which
// handler each callback is.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "@main/services/errors";
import { screenIsControlSurface, type ViewSurface } from "@main/types/views";

import { SCREEN_PANEL_ID, ScreenSettingsPanel, assignNewView, type PanelDevice, type PanelTarget, type ScreenPanelActions } from "../../settings/sections/screen-settings-panel";
import { NewViewDialog } from "../../settings/sections/new-view-dialog";
import { screenPickerViews } from "../../settings/sections/outputs-section";
import type { SectionHandlers } from "../../settings/types";
import { toast } from "../../components/ui";
import { invoke } from "../../lib/api";
import { useMessageGroups } from "../../main/use-message-groups";
import { useDisplayPresence } from "./use-display-presence";
import { refreshDevices } from "./use-devices";
import { QUERY_KEYS } from "../queries";

/** What the host needs of the page around it. */
export interface ScreenPanelHostProps {
  stageState: StageState;
  handlers: SectionHandlers;
  /** What the panel is on; null for nothing selected. */
  target: PanelTarget | null;
  /** The screen made a moment ago, so its panel says so. */
  created: { outputId: string; viewMade: boolean } | null;
  onClose: () => void;
  onSelect: (target: PanelTarget) => void;
  onAddScreen: () => void;
  /** A screen was made: the panel moves to it. */
  onCreated: (outputId: string | null, viewMade: boolean) => void;
  onEditLayout: (viewId: string) => void;
  onRemoveScreen: (outputId: string) => void;
  onDeleteView: (viewId: string) => void;
  onOpenMessagingSettings: () => void;
}

export function ScreenPanelHost({
  stageState,
  handlers,
  target,
  created,
  onClose,
  onSelect,
  onAddScreen,
  onCreated,
  onEditLayout,
  onRemoveScreen,
  onDeleteView,
  onOpenMessagingSettings,
}: ScreenPanelHostProps) {
  const queryClient = useQueryClient();
  const outputs = stageState.outputs ?? [];
  // The same list the cards' pickers use: Home left out, by name.
  const views = screenPickerViews(stageState.views ?? []);
  const connected = useDisplayPresence();
  const messageGroups = useMessageGroups();
  // Which screen asked for a new view, and of which kind, so the one made is
  // pointed at it.
  const [newViewFor, setNewViewFor] = useState<{ outputId: string; surface: ViewSurface } | null>(null);
  const newViewScreen = newViewFor ? outputs.find((o) => o.id === newViewFor.outputId) : undefined;

  async function create(input: Parameters<ScreenPanelActions["onCreate"]>[0], device: PanelDevice | null): Promise<string | null> {
    // Whether a view is made with the screen: the note after it offers its layout.
    const viewMade = input.newView !== undefined;
    if (!device) {
      const { refused, outputId } = await handlers.handleCreateScreen(input);
      if (!refused) onCreated(outputId, viewMade);
      return refused;
    }
    // Created and claimed as one call: the server makes the screen, binds the
    // device, and takes the screen back if the binding fails.
    let outputId: string | null;
    try {
      const claimed = await invoke<{ outputId?: string }>("devices:claim", { deviceId: device.id, outputId: null, ...input });
      outputId = claimed?.outputId ?? null;
    } catch (err) {
      return errorMessage(err);
    }
    // refreshDevices returns its failure rather than throwing, so it is checked
    // here: a claim that worked but whose refresh did not still has to say the
    // list is stale.
    const failed = await refreshDevices();
    if (failed) toast.error(`Set up, but the list did not reload: ${failed.message}`);
    else toast.success(`Set up ${input.name ? `"${input.name}"` : "the screen"}. The device now shows it.`);
    // A claim answers with the screen's id, not the state, so the page reads the
    // state once more before the panel moves to a screen it does not list yet.
    // (A failed read is not an error here: the broadcast brings the screen in.)
    await queryClient.refetchQueries({ queryKey: QUERY_KEYS.stageState });
    onCreated(outputId, viewMade);
    return null;
  }

  // The handlers themselves: each already reports its own failure, so there is
  // nothing to wrap. Only the slug is not one of them, because the panel shows a
  // refused link beside the field rather than in a toast.
  const actions: ScreenPanelActions = {
    onRename: handlers.handleRenameOutput,
    onSetSlug: async (id, slug) => {
      await invoke("outputs:setSlug", { id, slug });
    },
    onSetView: handlers.handleSetOutputView,
    onSetLocked: handlers.handleSetOutputLocked,
    onSetHideTopBar: handlers.handleSetOutputHideTopBar,
    onSetTextSize: handlers.handleSetOutputTextSize,
    onSetRotation: handlers.handleSetOutputRotation,
    onSetVideoMode: handlers.handleSetOutputVideoMode,
    onSetAllowHls: handlers.handleSetOutputAllowHls,
    onSetGroups: handlers.handleSetOutputGroups,
    onSetShowInSidebar: handlers.handleSetViewShowInSidebar,
    onOpenMessagingSettings,
    onRequestNewView: (outputId, surface) => setNewViewFor({ outputId, surface }),
    onCreate: create,
    onSelect,
    onAddScreen,
    onEditLayout,
    onRemoveScreen,
    onRenameView: handlers.handleRenameView,
    onSetViewSurface: handlers.handleSetViewSurface,
    onDuplicateView: async (id) => {
      const copy = await handlers.handleDuplicateView(id);
      if (copy) onSelect({ kind: "view", viewId: copy });
    },
    onDeleteView,
  };

  return (
    <div id={`${SCREEN_PANEL_ID}-host`} className="lg:sticky lg:top-3 lg:flex lg:max-h-[calc(100dvh-6.5rem)] lg:w-[400px] lg:shrink-0 lg:flex-col">
      <ScreenSettingsPanel
        target={target}
        outputs={outputs}
        views={views}
        baseUrl={stageState.publicUrl || window.location.origin}
        online={target?.kind === "edit" && connected.has(target.outputId)}
        messageGroups={messageGroups}
        created={created}
        actions={actions}
        onClose={onClose}
      />
      {/* The same dialog the cards use, told what the new view is FOR: the kind the
          operator asked for, which may not be the kind the screen shows now (and
          then it is asked about before the screen is pointed at it). */}
      <NewViewDialog
        handlers={handlers}
        open={newViewFor !== null}
        fixedSurface={newViewFor?.surface}
        onOpenChange={(o) => { if (!o) setNewViewFor(null); }}
        onCreated={(id, name) => {
          if (newViewFor && newViewScreen) {
            void assignNewView(newViewScreen, { surface: newViewFor.surface, name }, screenIsControlSurface(newViewScreen, stageState.views ?? []), () => {
              void handlers.handleSetOutputView(newViewScreen.id, id);
            });
          }
          setNewViewFor(null);
        }}
        trigger={<span className="hidden" />}
      />
    </div>
  );
}
