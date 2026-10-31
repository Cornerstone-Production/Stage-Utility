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
import { Switch, Tooltip, toast } from "../../components/ui";
import { errorMessage } from "@main/services/errors";
import type { PublicDevice } from "@main/services/kiosk-devices-store";
import type { DeviceOutput } from "@main/types/kiosk";
import { useDevices, refreshDevices, describeScreen } from "./use-devices";
import { outputModeLine, outputSwitchState } from "./output-helpers";
import { readUpdate, TONE_CLASS } from "./machine-update";
import { cn } from "../../lib/cn";

/**
 * Unbind a device from the screen it shows, and say so. One function for the two
 * places that offer it, the card's strip and the Device section of Screen
 * settings, so a release reads and fails the same from either.
 */
export async function releaseDevice(deviceId: string, screenName: string): Promise<void> {
  try {
    await invoke("devices:release", { deviceId });
    // Returns its failure rather than throwing — a release that worked but did
    // not reload leaves a card claiming a machine that is no longer bound.
    const failed = await refreshDevices();
    if (failed) toast.error(`Released, but the list did not reload: ${failed.message}`);
    // Said out loud because nothing else on the card changes visibly except
    // this strip disappearing, and a strip disappearing reads like a bug.
    toast.success(`${screenName} released — the screen goes back to waiting`);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

/** Switch one output of a Mac helper on or off, and say so if it fails. The Mac
 *  hears it in the answer to its next health post. One function for the card and
 *  Screen settings, so both fail the same way. */
export async function setOutputEnabled(deviceId: string, enabled: boolean): Promise<void> {
  try {
    await invoke("devices:setEnabled", { deviceId, enabled });
    // The same refetch a release does: this page reads the stored value back.
    const failed = await refreshDevices();
    if (failed) toast.error(`Switched, but the list did not reload: ${failed.message}`);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

/** What the strip says an output of a Mac output helper is: the Mac, the port
 *  and what it is sending. A DeckLink port sends the mode the screen is set to;
 *  a display runs at whatever the Mac drives it at. */
function outputSummary(device: PublicDevice & { output: DeviceOutput }, videoMode: string | undefined): string {
  const { output } = device;
  const mode = outputModeLine(output, videoMode, device.screen);
  return [device.hostname || device.label || "Set up on a device", output.port, mode].filter(Boolean).join(" · ");
}

export function ScreenDevice({ outputId, name, videoMode }: { outputId: string; name: string; videoMode?: string }) {
  const data = useDevices();
  const [busy, setBusy] = useState(false);
  const device = data.bound.find((d) => d.outputId === outputId);
  if (!device) return null;
  // The machine's own software: a Mac helper's version and whether it is following
  // this server, or a Windows kiosk's launcher. One line, the server's sentence.
  const update = readUpdate(device, data);

  const size = describeScreen(device.screen);
  const output = device.output;
  const sw = output ? outputSwitchState(device, data.health.find((h) => h.deviceId === device.id)) : null;

  const deviceId = device.id;
  async function release() {
    setBusy(true);
    try {
      await releaseDevice(deviceId, name);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2 border-t border-line px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-caption1 text-fg-muted">
          {device.output ? (
            outputSummary({ ...device, output: device.output }, videoMode)
          ) : (
            <>
              {device.label || device.hostname || "Set up on a device"}
              {size && <span className="text-fg-subtle"> · {size}</span>}
            </>
          )}
        </div>
        {/* A Mac's reason can carry a path with no break in it, and the card is
            narrow: it wraps anywhere, stops at three lines, and says the rest on
            hover. Screen settings shows it whole. */}
        {update && (
          <div title={update.text} className={cn("mt-0.5 line-clamp-3 text-caption1 [overflow-wrap:anywhere]", TONE_CLASS[update.tone])}>
            {update.text}
          </div>
        )}
        <div className="truncate font-mono text-caption2 text-fg-faint">{device.id}</div>
      </div>
      {output && sw && (
        <div className="flex shrink-0 items-center gap-2">
          <span className={cn("text-caption1", sw.pending ? "text-warn-11" : "text-fg-muted")}>{sw.label}</span>
          <Switch
            checked={sw.on}
            aria-label={`Output on ${output.port}`}
            onCheckedChange={(v: boolean) => void setOutputEnabled(device.id, v)}
          />
        </div>
      )}
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
