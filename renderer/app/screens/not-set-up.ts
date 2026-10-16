// What counts as "found, and not set up", and how the Screens banner describes
// and remembers it. Pure, so the banner, the sidebar count and the Not set up
// yet section cannot disagree about which devices those are.

import type { SeenDevice } from "@main/types/kiosk";
import type { PanelDevice } from "../../settings/sections/screen-settings-panel";

/** The id of the Not set up yet section, which the banner's "See all below"
 *  scrolls to. */
export const NOT_SET_UP_ID = "not-set-up-yet";

/**
 * The devices a person could set up: everything heard that is not set up on
 * ANOTHER server. A device that says it belongs to one it cannot reach is listed
 * under Not set up yet (it can be recovered from there) but it is not "a screen
 * that is not set up": it is set up, and counting it would leave a number in the
 * sidebar for as long as that server stayed down.
 */
export function notSetUp(seen: readonly SeenDevice[]): SeenDevice[] {
  return seen.filter((d) => !d.boundTo);
}

/**
 * What "Set up as a new screen" hands the Screen settings panel for a device.
 * One definition for the section's button and the banner's, so the two cannot
 * open the panel on different things. An output is named for itself ("SDI 1 ·
 * Card A"), not for the Mac it shares with its siblings: four screens called
 * booth-mini are no use.
 */
export function panelDeviceOf(device: SeenDevice): PanelDevice {
  return { id: device.id, hostname: device.hostname, ip: device.ip, name: device.output?.name };
}

/** A device as the banner's row reads it. */
export interface FoundRow {
  name: string;
  /** "Video output" for an SDI port, "Display" for everything else. */
  kind: string;
  /** The machine it is on, when it said. */
  machine: string | undefined;
  address: string;
}

export function foundRow(d: SeenDevice): FoundRow {
  return {
    name: d.output?.name ?? (d.hostname || "Unconfigured screen"),
    kind: d.output?.kind === "decklink" ? "Video output" : "Display",
    machine: d.hostname || undefined,
    address: d.ip,
  };
}

/** The banner's title: one screen, or how many. */
export function foundTitle(count: number): string {
  return count === 1 ? "A screen was found that is not set up" : `${count} screens were found that are not set up`;
}
