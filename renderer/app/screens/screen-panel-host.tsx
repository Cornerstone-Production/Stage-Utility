// The Screen settings panel, wired to the app: the stage state it reads, the
// per-field handlers it writes through, and the pieces that live beside it (the
// new-view dialog, the device claim).
//
// ScreenSettingsPanel itself reads only props and calls only callbacks, so it can
// be driven with no server behind it. This is the one place that knows which
// handler each callback is.

import { useState } from "react";
import { errorMessage } from "@main/services/errors";
import { outputMode, surfaceForMode } from "@main/types/views";

import { SCREEN_PANEL_ID, ScreenSettingsPanel, type PanelDevice, type PanelTarget, type ScreenPanelActions } from "../../settings/sections/screen-settings-panel";
import { NewViewDialog } from "../../settings/sections/new-view-dialog";
import { screenPickerViews } from "../../settings/sections/outputs-section";
import type { SectionHandlers } from "../../settings/types";
import { toast } from "../../components/ui";
import { invoke } from "../../lib/api";
import { useMessageGroups } from "../../main/use-message-groups";
import { useDisplayPresence } from "./use-display-presence";
import { refreshDevices } from "./use-devices";

export function ScreenPanelHost({
  stageState,
  handlers,
  target,
  onClose,
  onOpenMessagingSettings,
}: {
  stageState: StageState;
  handlers: SectionHandlers;
  target: PanelTarget;
  onClose: () => void;
  onOpenMessagingSettings: () => void;
}) {
  const outputs = stageState.outputs ?? [];
  // The same list the cards' pickers use: Home left out, by name.
  const views = screenPickerViews(stageState.views ?? []);
  const connected = useDisplayPresence();
  const messageGroups = useMessageGroups();
  // Which screen asked for a new view, so the one made is pointed at it.
  const [newViewFor, setNewViewFor] = useState<string | null>(null);
  const newViewScreen = newViewFor ? outputs.find((o) => o.id === newViewFor) : undefined;

  async function create(input: Parameters<ScreenPanelActions["onCreate"]>[0], device: PanelDevice | null): Promise<string | null> {
    if (!device) {
      const refused = await handlers.handleCreateScreen(input);
      if (!refused) toast.success(`Created ${input.name ? `"${input.name}"` : "the screen"}. Point a monitor at its address.`);
      return refused;
    }
    // Created and claimed as one call: the server makes the screen, binds the
    // device, and takes the screen back if the binding fails.
    try {
      await invoke("devices:claim", { deviceId: device.id, outputId: null, ...input });
    } catch (err) {
      return errorMessage(err);
    }
    // refreshDevices returns its failure rather than throwing, so it is checked
    // here: a claim that worked but whose refresh did not still has to say the
    // list is stale.
    const failed = await refreshDevices();
    if (failed) toast.error(`Set up, but the list did not reload: ${failed.message}`);
    else toast.success(`Set up ${input.name ? `"${input.name}"` : "the screen"}. The device now shows it.`);
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
    onSetRole: handlers.handleSetOutputRole,
    onSetLocked: handlers.handleSetOutputLocked,
    onSetHideTopBar: handlers.handleSetOutputHideTopBar,
    onSetTextSize: handlers.handleSetOutputTextSize,
    onSetRotation: handlers.handleSetOutputRotation,
    onSetVideoMode: handlers.handleSetOutputVideoMode,
    onSetAllowHls: handlers.handleSetOutputAllowHls,
    onSetGroups: handlers.handleSetOutputGroups,
    onSetShowInSidebar: handlers.handleSetViewShowInSidebar,
    onOpenMessagingSettings,
    onRequestNewView: setNewViewFor,
    onCreate: create,
  };

  return (
    <div id={`${SCREEN_PANEL_ID}-host`} className="lg:sticky lg:top-3 lg:flex lg:max-h-[calc(100dvh-6.5rem)] lg:w-[400px] lg:shrink-0 lg:flex-col">
      <ScreenSettingsPanel
        target={target}
        outputs={outputs}
        views={views}
        baseUrl={stageState.publicUrl || window.location.origin}
        online={target.kind === "edit" && connected.has(target.outputId)}
        messageGroups={messageGroups}
        actions={actions}
        onClose={onClose}
      />
      {/* The same dialog the cards use, told what the new view is FOR: the
          panel's picker is already filtered to the screen's role, and a control
          surface must not be offered a view it cannot show. */}
      <NewViewDialog
        handlers={handlers}
        open={newViewFor !== null}
        fixedSurface={newViewScreen ? surfaceForMode(outputMode(newViewScreen)) : "display"}
        onOpenChange={(o) => { if (!o) setNewViewFor(null); }}
        onCreated={(id) => {
          if (newViewFor) void handlers.handleSetOutputView(newViewFor, id);
          setNewViewFor(null);
        }}
        trigger={<span className="hidden" />}
      />
    </div>
  );
}
