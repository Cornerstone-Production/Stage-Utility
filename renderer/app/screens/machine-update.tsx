// What a screen's machine says about its own updates: a Mac running the output
// helper, or a Windows kiosk. One reading for the two places that show it, the
// screen card's device strip and the Device section of Screen settings.
//
// The sentence is the server's (machine-updates.ts `describe`), so the card, the
// panel and the /log line cannot drift apart. What is decided here is only how it
// looks, and which button, if any, can change it.

import { useState } from "react";

import { invoke } from "../../lib/api";
import { toast } from "../../components/ui";
import { Button } from "../../components/ui/button";
import { errorMessage } from "@main/services/errors";
import type { MachineUpdate } from "@main/services/machine-updates";
import type { PublicDevice } from "@main/services/kiosk-devices-store";
import type { OutputHealth } from "@main/types/output-health";
import { LISTENING_GRACE_MS, listeningFor, refreshDevices, type DevicesPayload } from "./use-devices";

/** The machine a device id belongs to. A helper output is `<mac id>.<output key>`
 *  and the output that took over a Chrome kiosk is the bare `<mac id>`; a Windows
 *  kiosk is its own id. */
export function machineOf(deviceId: string): string {
  const dot = deviceId.indexOf(".");
  return dot < 0 ? deviceId : deviceId.slice(0, dot);
}

export type UpdateTone = "muted" | "info" | "warn" | "danger";

export interface UpdateReading {
  /** The sentence a person reads. */
  text: string;
  tone: UpdateTone;
  /** The short word beside it in Screen settings. */
  badge: string;
  /** The button that changes the answer, when one would. */
  action?: "Update now" | "Try again";
  machine?: string;
}

/**
 * How a screen's machine is doing, or null when there is nothing worth saying.
 *
 * A helper output whose Mac is reporting health but has never checked for updates
 * runs a helper installed before automatic updates: that is the one machine that
 * needs a person, once, so it is said, but only once the server has been listening
 * for longer than a check takes to come round: just after the server restarts,
 * every Mac is one it has not heard from yet. A Mac that is off says nothing here;
 * its screen already reads offline.
 */
export function readUpdate(
  device: Pick<PublicDevice, "id" | "output">,
  data: Pick<DevicesPayload, "updatesListeningFor" | "readAt"> & { updates: MachineUpdate[]; health: OutputHealth[] },
  now = Date.now(),
): UpdateReading | null {
  const machine = machineOf(device.id);
  const m = data.updates.find((u) => u.machine === machine);
  if (!m) {
    if (!device.output || !data.health.some((h) => machineOf(h.deviceId) === machine)) return null;
    // The server's own duration, carried forward by this browser's own clock: the
    // two clocks are never compared. useDevices wakes the page when this passes.
    const heard = listeningFor(data, now);
    if (heard === null || heard < LISTENING_GRACE_MS) return null;
    return { text: "Helper version unknown. Run the macOS installer once, at the Mac, to turn on its updates", tone: "muted", badge: "Not updating" };
  }
  if (m.state === "local-network") return { text: m.reason, tone: "warn", badge: "Updated", machine };
  if (m.update) {
    if (m.state === "retrying") return { text: m.reason, tone: "warn", badge: "Retrying", machine };
    const waiting = m.state === "no-session" || m.state === "not-running";
    return { text: m.reason, tone: "info", badge: waiting ? "Waiting" : "Updating", machine };
  }
  switch (m.waitingOn) {
    case "current":
      return { text: m.reason, tone: "muted", badge: m.state === "updated" ? "Updated" : "Up to date", machine };
    case "failed":
      return { text: m.reason, tone: "danger", badge: "Failed", action: "Try again", machine };
    case "off":
      return { text: m.reason, tone: "info", badge: "Behind", action: "Update now", machine };
    default:
      return { text: m.reason, tone: "info", badge: "Waiting", machine };
  }
}

export const TONE_CLASS: Record<UpdateTone, string> = {
  muted: "text-fg-subtle",
  info: "text-fg-muted",
  warn: "text-warn-11",
  danger: "text-danger-11",
};

/** Update now, or Try again. The machine acts at its next check, within five
 *  minutes; the listing says so as soon as the server has the request. */
export async function requestUpdate(machine: string): Promise<void> {
  try {
    await invoke("devices:requestUpdate", { machine });
    const failed = await refreshDevices();
    if (failed) toast.error(`Asked, but the list did not reload: ${failed.message}`);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

/** The button, with its own busy state, in the look of the Device section's
 *  Release. requestUpdate says its own failure, so nothing here can throw. */
export function UpdateButton({ reading }: { reading: UpdateReading }) {
  const [busy, setBusy] = useState(false);
  const { action, machine } = reading;
  if (!action || !machine) return null;
  return (
    <Button
      type="button"
      variant="transparent"
      size="small"
      className="border border-line-strong font-medium text-fg"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await requestUpdate(machine);
        setBusy(false);
      }}
    >
      {action}
    </Button>
  );
}
