// The machine showing a screen, on that screen's own card.
//
// This is the other half of folding Kiosks into Screens. A bound device is not a
// separate thing to administer — it is an attribute of the screen, the same way
// its URL and its view are — so it reads on the card rather than on a page you
// have to remember exists. Release lives here too, because releasing is
// something you do TO a screen.
//
// Renders nothing when no device is bound, which is every screen an operator
// opens in a browser tab by hand.

import { useState } from "react";

import { invoke } from "../../lib/api";
import { Tooltip, toast } from "../../components/ui";
import { errorMessage } from "@main/services/errors";
import { useDevices, refreshDevices, describeScreen } from "./use-devices";

export function ScreenDevice({ outputId, name }: { outputId: string; name: string }) {
  const { bound } = useDevices();
  const [busy, setBusy] = useState(false);
  const device = bound.find((d) => d.outputId === outputId);
  if (!device) return null;

  const size = describeScreen(device.screen);

  async function release() {
    if (!device) return;
    setBusy(true);
    try {
      await invoke("devices:release", { deviceId: device.id });
      // Returns its failure rather than throwing — a release that worked but did
      // not reload leaves a card claiming a machine that is no longer bound.
      const failed = await refreshDevices();
      if (failed) toast.error(`Released, but the list did not reload: ${failed.message}`);
      // Said out loud because nothing else on the card changes visibly except
      // this strip disappearing, and a strip disappearing reads like a bug.
      toast.success(`${name} released — the screen goes back to waiting`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 border-t border-line px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-caption1 text-fg-muted">
          {device.label || device.hostname || "Set up on a device"}
          {size && <span className="text-fg-subtle"> · {size}</span>}
        </div>
        <div className="truncate font-mono text-caption2 text-fg-faint">{device.id}</div>
      </div>
      <Tooltip label="Unbind the machine. The screen keeps its view and its URL.">
        <button
          type="button"
          disabled={busy}
          onClick={() => void release()}
          className="shrink-0 rounded-md px-2 py-1 text-caption1 text-fg-muted transition-colors hover:bg-fill hover:text-danger-11 disabled:opacity-50"
        >
          Release
        </button>
      </Tooltip>
    </div>
  );
}
