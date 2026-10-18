// button-inspector.tsx — the Button widget's config editor.
//
// The palette offers ONE Button. Underneath it are two stored types that still
// exist exactly as before — a cue-button (fires a cue, shows its device) and an
// action-button (runs one registry action inline) — and the Does control at the
// top of this panel is what switches a widget between them. Nothing is migrated:
// a saved layout's widgets load as whichever type they were, and this panel reads
// the type to decide which half of itself to draw.
//
// Switching rewrites the stored config with the new `type` and keeps the label.
// What cannot carry over is dropped: going to Run an action loses the cue and
// Show device; going to Fire a cue loses the action and its parameters. The
// look and the place are not in the config at all (they are `style` and
// geometry), so they are untouched.

import { StackedField } from "../components/ui";
import type { LayoutObjectConfig } from "@main/types/views";
import type { CuesLive } from "../main/use-cue-live";
import { ActionButtonInspector } from "./action-button-inspector";
import { CuePicker } from "./cue-picker";
import { RowSwitch, RowText, Segmented } from "./inspector-rows";

type CueButtonConfig = Extract<LayoutObjectConfig, { type: "cue-button" }>;
type ActionButtonConfig = Extract<LayoutObjectConfig, { type: "action-button" }>;
export type ButtonConfig = CueButtonConfig | ActionButtonConfig;

/** Where "+ New manual cue…" goes. The Automation page opens its creation flow
 *  for `new=manual` and shows the page as it is on a build that predates that. */
export const NEW_MANUAL_CUE_HREF = "/automation?new=manual";

/** The same widget set to Fire a cue: the label is kept, the cue starts unbound
 *  unless one is given, and the action and its parameters are dropped. */
export function toCueButton(c: ButtonConfig, cue = ""): CueButtonConfig {
  return {
    type: "cue-button",
    cue,
    ...(c.label !== undefined ? { label: c.label } : {}),
    showDevice: true,
  };
}

/** The same widget set to Run an action: the label is kept, and the cue and Show
 *  device are dropped. */
export function toActionButton(c: ButtonConfig): ActionButtonConfig {
  return {
    type: "action-button",
    actionId: "",
    params: {},
    ...(c.label !== undefined ? { label: c.label } : {}),
  };
}

export function ButtonInspector({
  c,
  cues,
  onConfig,
}: {
  c: ButtonConfig;
  /** The cue manifest, for the dropdown. null until it loads. */
  cues: CuesLive | null;
  onConfig: (c: LayoutObjectConfig) => void;
}) {
  const cueMode = c.type === "cue-button";
  return (
    <>
      <StackedField
        label="Does"
        description={
          cueMode
            ? "A cue is shared: its Run button, Home Assistant, voice and every button bound to it fire the same thing."
            : "The action lives on this button alone."
        }
      >
        <Segmented
          label="Does"
          value={cueMode ? "cue" : "action"}
          options={[
            { value: "cue", label: "Fire a cue" },
            { value: "action", label: "Run an action" },
          ]}
          onChange={(v) => {
            if ((v === "cue") === cueMode) return;
            onConfig(v === "cue" ? toCueButton(c) : toActionButton(c));
          }}
        />
      </StackedField>

      {c.type === "cue-button" ? (
        <>
          <StackedField
            label="Cue"
            description="Your own cues come from the Automation page. Built in cues drive OBS, REAPER, ProVideoPlayer and the app itself with no rule behind them."
          >
            <CuePicker cues={cues} value={c.cue} onChange={(v) => onConfig({ ...c, cue: v })} />
            <a
              href={NEW_MANUAL_CUE_HREF}
              target="_blank"
              rel="noopener noreferrer"
              className="self-start rounded text-footnote text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              + New manual cue…
            </a>
          </StackedField>
          <RowSwitch
            label="Show device"
            hint="The room or device under the label, and the reason when a reading is stale."
            checked={c.showDevice !== false}
            onChange={(v) => onConfig({ ...c, showDevice: v })}
          />
          <RowText
            label="Label"
            hint="Blank uses the cue's own name."
            value={c.label ?? ""}
            placeholder="Cue's name"
            onChange={(v) => onConfig({ ...c, label: v })}
          />
        </>
      ) : (
        <ActionButtonInspector c={c} onConfig={onConfig} />
      )}
    </>
  );
}
