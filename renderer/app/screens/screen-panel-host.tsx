// The Screen settings panel, wired to the app: the stage state it reads, the
// per-field handlers it writes through, and the pieces that live beside it (the
// new-view dialog, the device claim).
//
// ScreenSettingsPanel itself reads only props and calls only callbacks, so it can
// be driven with no server behind it. This is the one place that knows which
// handler each callback is.

import { useQueryClient } from "@tanstack/react-query";
import type { ViewSurface } from "@main/types/views";

import { SCREEN_PANEL_ID, ScreenSettingsPanel, type PanelDevice, type PanelTarget, type ScreenPanelActions } from "../../settings/sections/screen-settings-panel";
import { screenPickerViews } from "../../settings/sections/outputs-section";
import type { CreateScreenOutcome, SectionHandlers } from "../../settings/types";
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
  onClose: () => void;
  onSelect: (target: PanelTarget) => void;
  onAddScreen: () => void;
  /** A screen was made: the panel moves to it. */
  onCreated: (outputId: string | null, viewMade: boolean) => void;
  onEditLayout: (viewId: string) => void;
  /** A screen's picker asked for a new view of this kind. */
  onRequestNewView: (outputId: string, surface: ViewSurface) => void;
  onRemoveScreen: (outputId: string) => void;
  onDeleteView: (viewId: string) => void;
  onOpenMessagingSettings: () => void;
}

export function ScreenPanelHost({
  stageState,
  handlers,
  target,
  onClose,
  onSelect,
  onAddScreen,
  onCreated,
  onEditLayout,
  onRequestNewView,
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

  async function create(input: Parameters<ScreenPanelActions["onCreate"]>[0], device: PanelDevice | null): Promise<CreateScreenOutcome> {
    // Created and claimed as one call for a device (the server makes the screen,
    // binds the device, and takes the screen back if the binding fails).
    const outcome = device ? await handlers.handleClaimDevice(device.id, input) : await handlers.handleCreateScreen(input);
    if (outcome.refused) return outcome;
    if (device) {
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
    }
    // The note after it offers the layout of a view that was made with the screen.
    onCreated(outcome.outputId, input.newView !== undefined);
    return outcome;
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
    onRequestNewView,
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
        actions={actions}
        onClose={onClose}
      />
    </div>
  );
}
