// button-inspector.tsx — the Button widget's config editor.
//
// A Button stores one thing, a command's name (`cue-button`). The Presses control
// (button-presses.tsx, shared with Home's sheet) asks what it presses: a Companion
// button, an app action, or an existing command. The first two write a command
// that belongs to this Button; every press is a command, so Simulate, Disarm and
// the activity log apply to all three.
//
// Label stays and a blank one draws the name of what the Button presses. Show
// device stays for a pair, or a command that has a room to show: the line under the
// label, and the reason when a reading is stale.

import type { LayoutObjectConfig } from "@main/types/views";
import type { CuesLive } from "../main/use-cue-live";
import { cueEntry } from "../main/use-cue-live";
import { ButtonPresses, type CueButtonConfig } from "./button-presses";
import { RowSwitch, RowText } from "./inspector-rows";

export type ButtonConfig = CueButtonConfig;
export { NEW_MANUAL_COMMAND_HREF } from "./button-presses";

/** Whether Show device changes anything: a pair has a reading to show, and a lone
 *  command only has a room line when it has a room. */
export function hasDeviceLine(cues: CuesLive | null, cue: string): boolean {
  const entry = cueEntry(cues, cue);
  if (!entry) return false;
  return entry.kind === "switch" || entry.row.room.trim() !== "";
}

export function ButtonInspector({
  c,
  cues,
  viewId,
  viewName,
  objectId,
  onConfig,
}: {
  c: ButtonConfig;
  /** The command manifest, for the A command list. null until it loads. */
  cues: CuesLive | null;
  /** The view this Button is on (`"home"` for Home), its name, and its own id: which
   *  command belongs to it. */
  viewId: string;
  viewName: string;
  objectId: string;
  onConfig: (c: LayoutObjectConfig) => void;
}) {
  const name = cueEntry(cues, c.cue)?.row.name;
  return (
    <>
      <RowText
        label="Label"
        hint="Blank draws the name of what the Button presses."
        value={c.label ?? ""}
        placeholder={name ?? "What it presses"}
        onChange={(v) => onConfig({ ...c, label: v })}
      />
      <ButtonPresses owner={{ viewId, objectId }} where={viewName} c={c} cues={cues} onConfig={onConfig} />
      {hasDeviceLine(cues, c.cue) && (
        <RowSwitch
          label="Show device"
          hint="The room or device under the label, and the reason when a reading is stale."
          checked={c.showDevice !== false}
          onChange={(v) => onConfig({ ...c, showDevice: v })}
        />
      )}
    </>
  );
}
