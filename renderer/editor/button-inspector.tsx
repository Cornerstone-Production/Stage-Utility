// button-inspector.tsx — the Button widget's config editor.
//
// The palette offers ONE Button over two stored types: a cue-button (fires a cue,
// shows its device) and an action-button (runs one registry action inline). The
// Does control at the top switches a widget between them by rewriting its config
// with the other `type`; this panel reads the type to decide which half to draw.
// The label carries over; the cue and Show device, or the action and its
// parameters, do not. Look and place are `style` and geometry, not config, and
// are untouched.
//
// "Make it a cue" lifts the action into a manual cue (make-it-a-cue.ts) and
// rebinds this widget to it.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button, ErrorNote, StackedField, toast } from "../components/ui";
import { validateParams } from "@main/services/automation-param-validation";
import type { LayoutObjectConfig } from "@main/types/views";
import { automationRegistryQuery } from "../lib/automation-registry";
import { useLatestRef } from "../lib/use-latest-ref";
import type { CuesLive } from "../main/use-cue-live";
import { ActionButtonInspector } from "./action-button-inspector";
import { CuePicker } from "./cue-picker";
import { RowSwitch, RowText, Segmented } from "./inspector-rows";
import { makeCueFromAction } from "./make-it-a-cue";

type CueButtonConfig = Extract<LayoutObjectConfig, { type: "cue-button" }>;
type ActionButtonConfig = Extract<LayoutObjectConfig, { type: "action-button" }>;
export type ButtonConfig = CueButtonConfig | ActionButtonConfig;

/** Where "+ New manual cue…" goes: the Automation page, which opens its cue
 *  creation flow for `new=manual` once it handles that, and is just the page until
 *  then. */
export const NEW_MANUAL_CUE_HREF = "/automation?new=manual";

/** The same widget set to Fire a cue: the label is kept, the cue starts unbound
 *  unless one is given, and the action and its parameters are dropped. */
function toCueButton(c: ButtonConfig, cue = ""): CueButtonConfig {
  return {
    type: "cue-button",
    cue,
    ...(c.label !== undefined ? { label: c.label } : {}),
    showDevice: true,
  };
}

/** The same widget set to Run an action: the label is kept, and the cue and Show
 *  device are dropped. */
function toActionButton(c: ButtonConfig): ActionButtonConfig {
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
  const does = cueMode ? "cue" : "action";
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
          value={does}
          options={[
            { value: "cue", label: "Fire a cue" },
            { value: "action", label: "Run an action" },
          ]}
          onChange={(v) => {
            if (v === does) return;
            onConfig(v === "cue" ? toCueButton(c) : toActionButton(c));
          }}
        />
      </StackedField>

      {cueMode ? (
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
        <ActionButtonInspector c={c} onConfig={onConfig} beforeLabel={<MakeItACue c={c} onConfig={onConfig} />} />
      )}
    </>
  );
}

/**
 * "Make it a cue", for a Button set to Run an action.
 *
 * Disabled until the action is one the registry knows and its fields are
 * complete: the server would otherwise save the new rule turned off, and a Button
 * bound to a cue that refuses is worse than the Button it replaced.
 */
function MakeItACue({ c, onConfig }: { c: ActionButtonConfig; onConfig: (c: LayoutObjectConfig) => void }) {
  const { data: registry } = useQuery(automationRegistryQuery);
  const action = registry?.actions.find((a) => a.id === c.actionId) ?? null;
  const ready = !!action && validateParams(action.params, (c.params ?? {}) as Record<string, string | number>).length === 0;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The write takes a moment, and the label can be typed into meanwhile: the
  // rebind uses the widget as it is when the write lands, not as it was at the click.
  const latest = useLatestRef(c);

  async function make() {
    if (!action || busy) return;
    setBusy(true);
    setError(null);
    const made = await makeCueFromAction({
      label: c.label ?? "",
      actionId: c.actionId,
      actionLabel: action.label,
      params: c.params,
    });
    setBusy(false);
    if (!made.ok) {
      // The widget is left exactly as it was; the reason stays on screen.
      setError(made.error);
      return;
    }
    onConfig(toCueButton(latest.current, made.cue));
    toast.success(`Made the cue "${made.cue}"`);
  }

  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <Button variant="filled" size="small" disabled={!ready || busy} onClick={make}>
        {busy ? "Making…" : "Make it a cue"}
      </Button>
      <span className="text-caption2 leading-snug text-fg-muted">
        Turns this action into a manual cue named after the button, and points the button at it, so Home Assistant or
        another console can fire it too.
        {!ready && " Choose an action and fill in its fields first."}
      </span>
      {error && <ErrorNote className="w-full">{error}</ErrorNote>}
    </div>
  );
}
