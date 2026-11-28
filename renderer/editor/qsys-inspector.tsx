// qsys-inspector.tsx — the inspector's options for the ten Q-SYS objects.
//
// In the shared rows every other widget's inspector uses. Each binding is chosen
// in the Core browser (qsys-core-browser.tsx), filtered to what that field can
// take: an object that writes offers only allowlisted, writable controls; one that
// reads offers every control of the right kind. A list (presets, selector buttons)
// never gets an empty row: "Add" opens the browser first, and a row exists only
// once it has a control.

import { useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from "lucide-react";

import { addressOf, isWritable, type QsysBinding, type QsysDensity } from "@main/types/qsys";
import type { LayoutObjectConfig } from "@main/types/views";
import { Button } from "../components/ui";
import {
  allowKey,
  CoreLoadNotice,
  fitsKind,
  hasChoices,
  QsysCoreBrowser,
  useQsysCoreLoad,
  type CatalogComponent,
  type CatalogControl,
  type QsysBrowseKind,
  type QsysCoreLoad,
} from "./qsys-core-browser";
import { channelLabel, channelsOf, isGainBlock, matchGainBlock, matchStrip, problemWords, type Eligibility, type StripChannel, type StripSlot } from "./qsys-strip";
import { Row, RowNumber, RowSwitch, RowText, RowToggle, Section } from "./inspector-rows";

export type QsysConfig = Extract<LayoutObjectConfig, { type: `qsys-${string}` }>;
type Of<T extends QsysConfig["type"]> = Extract<QsysConfig, { type: T }>;
type Item = { label: string; binding: QsysBinding };

export const isQsysConfig = (c: LayoutObjectConfig): c is QsysConfig => c.type.startsWith("qsys-");

/** A new binding keeps the control that lights it: choosing another target is not choosing another lamp. */
const rebind = (old: QsysBinding | null | undefined, next: QsysBinding | null): QsysBinding | null =>
  next && old?.indicator ? { ...next, indicator: old.indicator } : next;

function Bind({
  label,
  hint,
  kind,
  writable,
  value,
  onChange,
  clearable,
}: {
  clearable?: boolean;
  label: string;
  hint?: string;
  kind: QsysBrowseKind;
  writable: boolean;
  value: QsysBinding | null | undefined;
  onChange: (b: QsysBinding | null) => void;
}) {
  return (
    <Row label={label} hint={hint} stacked>
      <QsysCoreBrowser kind={kind} writable={writable} value={value ?? null} onChange={(b) => onChange(rebind(value, b))} label={label} clearable={clearable} />
    </Row>
  );
}

/** A separate control that says whether an object is lit: a snapshot's match, an LED. */
function LitBy({ binding, onChange }: { binding: QsysBinding; onChange: (b: QsysBinding) => void }) {
  return (
    <Row label="Lit by" hint="A separate control that says whether this is on, such as a snapshot's match. Without one it is lit by its own control when that is on or off." stacked>
      <QsysCoreBrowser
        kind="boolean"
        writable={false}
        label="Lit by"
        placeholder="Its own control"
        value={binding.indicator ? { ...binding.indicator } : null}
        onChange={(b) => {
          const { indicator: _gone, ...rest } = binding;
          onChange(b ? { ...rest, indicator: addressOf(b) } : rest);
        }}
      />
    </Row>
  );
}

/**
 * A list of labelled controls: triggers for presets; for a selector's buttons,
 * triggers or on/off controls (`press`). Adding picks the control first, and the
 * row's label starts as the name the Core draws on it, else the control's name.
 */
function Items({
  title,
  addLabel,
  items,
  onChange,
  kind = "trigger",
}: {
  title: string;
  addLabel: string;
  items: Item[];
  onChange: (items: Item[]) => void;
  kind?: "trigger" | "press";
}) {
  const set = (i: number, patch: Partial<Item>) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...items];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-2.5">
      <Section label={title} />
      {items.map((it, i) => (
        <div key={i} className="flex flex-col gap-1.5 rounded-md border border-line p-2" data-qsys-item={i}>
          <RowText label="Label" value={it.label} onChange={(v) => set(i, { label: v })} />
          <Bind label="Control" kind={kind} writable clearable={false} value={it.binding} onChange={(b) => b && set(i, { binding: b })} />
          <LitBy binding={it.binding} onChange={(b) => set(i, { binding: b })} />
          <div className="flex justify-end gap-1">
            <Button variant="transparent" size="small" iconOnly disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${it.label || "item"} up`}>
              <ArrowUpIcon className="size-3.5" />
            </Button>
            <Button variant="transparent" size="small" iconOnly disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${it.label || "item"} down`}>
              <ArrowDownIcon className="size-3.5" />
            </Button>
            <Button variant="transparent" size="small" iconOnly onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`Remove ${it.label || "item"}`}>
              <Trash2Icon className="size-3.5 text-fg-muted" />
            </Button>
          </div>
        </div>
      ))}
      <QsysCoreBrowser
        kind={kind}
        writable
        label={addLabel}
        placeholder={addLabel}
        value={null}
        onChange={(b, legend) => b && onChange([...items, { label: legend ?? b.control, binding: b }])}
      />
    </div>
  );
}

const DENSITY = [
  { value: "standard", label: "Standard" },
  { value: "dense", label: "Dense" },
] as const;

export function QsysInspector({ c, onConfig, onBreakApart }: { c: QsysConfig; onConfig: (c: LayoutObjectConfig) => void; onBreakApart?: () => void }) {
  switch (c.type) {
    case "qsys-fader":
      return <FaderInspector c={c} onConfig={onConfig} />;
    case "qsys-meter":
      return <MeterInspector c={c} onConfig={onConfig} />;
    case "qsys-mute":
      return (
        <Bind label="Mute control" hint="An on and off control. On is muted." kind="boolean" writable value={c.binding} onChange={(b) => onConfig({ ...c, binding: b })} />
      );
    case "qsys-button":
      return <ButtonInspector c={c} onConfig={onConfig} />;
    case "qsys-switch":
      return <SwitchInspector c={c} onConfig={onConfig} />;
    case "qsys-presets":
      return (
        <div className="flex flex-col gap-2.5">
          <Items title="Presets" addLabel="Add preset" items={c.items} onChange={(items) => onConfig({ ...c, items })} />
          <Bind label="Previous" hint="An optional trigger that steps back, drawn as a Previous button after the presets." kind="trigger" writable value={c.previous} onChange={(b) => onConfig({ ...c, previous: b })} />
        </div>
      );
    case "qsys-selector":
      return <SelectorInspector c={c} onConfig={onConfig} />;
    case "qsys-label":
      return (
        <div className="flex flex-col gap-2.5">
          <Bind label="Text control" hint="Shows this control's text from the Core." kind="string" writable={false} value={c.binding} onChange={(b) => onConfig({ ...c, binding: b })} />
          <RowText label="Text" hint="Text typed here is shown instead of the Core's." value={c.text} onChange={(text) => onConfig({ ...c, text })} />
        </div>
      );
    case "qsys-strip":
      return <StripInspector c={c} onConfig={onConfig} onBreakApart={onBreakApart} />;
    case "qsys-status":
      return null;
  }
}

function FaderInspector({ c, onConfig }: { c: Of<"qsys-fader">; onConfig: (c: LayoutObjectConfig) => void }) {
  return (
    <div className="flex flex-col gap-2.5">
      <Bind label="Level control" hint="A numeric control with a range. Only allowlisted controls with write limits are offered." kind="gain" writable value={c.binding} onChange={(b) => onConfig({ ...c, binding: b })} />
      <RowToggle label="Direction" value={c.orientation} options={[{ value: "vertical", label: "Vertical" }, { value: "horizontal", label: "Horizontal" }]} onChange={(orientation) => onConfig({ ...c, orientation })} />
      <DensityRow value={c.density} onChange={(density) => onConfig({ ...c, density })} />
      <RowSwitch label="Show dB" checked={c.showDb} onChange={(showDb) => onConfig({ ...c, showDb })} />
      <RowSwitch label="Step buttons" hint="Plus and minus buttons beside the fader." checked={c.steps} onChange={(steps) => onConfig({ ...c, steps })} />
      {c.steps && <RowNumber label="Step size" value={c.stepDb} step={0.5} min={0.5} max={12} suffix="dB" onChange={(stepDb) => onConfig({ ...c, stepDb })} />}
    </div>
  );
}

function MeterInspector({ c, onConfig }: { c: Of<"qsys-meter">; onConfig: (c: LayoutObjectConfig) => void }) {
  return (
    <div className="flex flex-col gap-2.5">
      <Bind label="Meter control" kind="meter" writable={false} value={c.binding} onChange={(b) => onConfig({ ...c, binding: b })} />
      <RowToggle label="Show as" value={c.form} options={[{ value: "bar", label: "Bar" }, { value: "number", label: "Number" }]} onChange={(form) => onConfig({ ...c, form })} />
      {c.form === "bar" ? (
        <Bind label="Second channel" hint="A second bar beside the first, for a stereo pair." kind="meter" writable={false} value={c.binding2} onChange={(b) => onConfig({ ...c, binding2: b })} />
      ) : (
        <RowText label="Unit" hint="Drawn under the number, such as LKFS." value={c.unit ?? ""} onChange={(unit) => onConfig({ ...c, unit: unit || undefined })} />
      )}
    </div>
  );
}

function ButtonInspector({ c, onConfig }: { c: Of<"qsys-button">; onConfig: (c: LayoutObjectConfig) => void }) {
  // Saved on the object: it decides which controls the browser offers, and whether the
  // server leases the press (main/types/qsys.ts panelHasMomentary). Absent is a trigger.
  const momentary = c.press === "momentary";
  return (
    <div className="flex flex-col gap-2.5">
      <RowToggle
        label="Control type"
        hint="A trigger fires once when pressed. A momentary is an on and off control held on while it is pressed. Changing it clears the control."
        value={momentary ? "momentary" : "trigger"}
        options={[{ value: "trigger", label: "Trigger" }, { value: "momentary", label: "Momentary" }]}
        onChange={(v) => {
          if ((v === "momentary") === momentary) return;
          const { press: _was, ...rest } = c;
          onConfig({ ...rest, binding: null, ...(v === "momentary" ? { press: "momentary" as const } : {}) });
        }}
      />
      <Bind label="Control" kind={momentary ? "boolean" : "trigger"} writable value={c.binding} onChange={(b) => onConfig({ ...c, binding: b })} />
      {c.binding && <LitBy binding={c.binding} onChange={(b) => onConfig({ ...c, binding: b })} />}
      <RowText label="Label" hint="Empty shows the control's name." value={c.label} onChange={(label) => onConfig({ ...c, label })} />
      <RowSwitch label="Hold to confirm" hint="Press and hold for a second to send. A control the allowlist marks hold asks for this whatever this says." checked={c.hold} onChange={(hold) => onConfig({ ...c, hold })} />
    </div>
  );
}

function SwitchInspector({ c, onConfig }: { c: Of<"qsys-switch">; onConfig: (c: LayoutObjectConfig) => void }) {
  const [picked, setPicked] = useState<"one" | "two">(c.binding ? "one" : c.onBinding || c.offBinding ? "two" : "one");
  const two = picked === "two";
  return (
    <div className="flex flex-col gap-2.5">
      <RowToggle
        label="Made of"
        hint="One on and off control, or a pair of triggers (on and off). Changing it clears the other kind's controls."
        value={picked}
        options={[{ value: "one", label: "One control" }, { value: "two", label: "On and off" }]}
        onChange={(v) => {
          setPicked(v);
          onConfig(v === "one" ? { ...c, onBinding: null, offBinding: null } : { ...c, binding: null });
        }}
      />
      {!two && <Bind label="Control" kind="boolean" writable value={c.binding} onChange={(b) => onConfig({ ...c, binding: b })} />}
      {two && (
        <>
          <Bind label="On trigger" kind="trigger" writable value={c.onBinding} onChange={(b) => onConfig({ ...c, onBinding: b })} />
          {c.onBinding && <LitBy binding={c.onBinding} onChange={(b) => onConfig({ ...c, onBinding: b })} />}
          <Bind label="Off trigger" kind="trigger" writable value={c.offBinding} onChange={(b) => onConfig({ ...c, offBinding: b })} />
          {!c.onBinding?.indicator && (
            <>
              <RowText label="On words" hint="Shown on the On button while the Core reports no state." value={c.onLabel ?? ""} placeholder="On" onChange={(v) => onConfig({ ...c, onLabel: v || undefined })} />
              <RowText label="Off words" value={c.offLabel ?? ""} placeholder="Off" onChange={(v) => onConfig({ ...c, offLabel: v || undefined })} />
            </>
          )}
        </>
      )}
      <RowText label="Label" value={c.label} onChange={(label) => onConfig({ ...c, label })} />
    </div>
  );
}

function StripInspector({ c, onConfig, onBreakApart }: { c: Of<"qsys-strip">; onConfig: (c: LayoutObjectConfig) => void; onBreakApart?: () => void }) {
  return (
    <div className="flex flex-col gap-2.5">
      <StripFill c={c} onConfig={onConfig} />
      <Bind label="Name" hint="Shown above the fader from this text control. A label typed below wins." kind="string" writable={false} value={c.name} onChange={(name) => onConfig({ ...c, name })} />
      <RowText label="Label" value={c.label} onChange={(label) => onConfig({ ...c, label })} />
      <Bind label="Level" kind="gain" writable value={c.gain} onChange={(gain) => onConfig({ ...c, gain })} />
      <Bind label="Mute" kind="boolean" writable value={c.mute} onChange={(mute) => onConfig({ ...c, mute })} />
      <Bind label="Meter" kind="meter" writable={false} value={c.meter} onChange={(meter) => onConfig({ ...c, meter })} />
      <Bind label="Second meter" hint="A second channel beside the first." kind="meter" writable={false} value={c.meter2} onChange={(meter2) => onConfig({ ...c, meter2 })} />
      <DensityRow value={c.density} onChange={(density) => onConfig({ ...c, density })} />
      {onBreakApart && (
        <Button variant="transparent" onClick={onBreakApart} aria-label="Break apart" tooltip="Replace this strip with a label, fader, meter and mute you can place separately">
          Break apart
        </Button>
      )}
    </div>
  );
}

/** Standard or the staff panel's dense strip; absent is standard. */
function DensityRow({ value, onChange }: { value: QsysDensity | undefined; onChange: (d: QsysDensity | undefined) => void }) {
  return (
    <RowToggle
      label="Density"
      hint="Dense is the staff panel's narrow strip, with a dB scale."
      value={value ?? "standard"}
      options={DENSITY}
      onChange={(v) => onChange(v === "dense" ? "dense" : undefined)}
    />
  );
}

/** Whether the Core reports a control with a list of choices: read once. Nothing is offered that the Core did not say. */
function useCoreHasChoices(): boolean {
  const load = useQsysCoreLoad(1, false);
  return load.state === "ready" && load.components.some((comp) => comp.controls.some(hasChoices));
}

function SelectorInspector({ c, onConfig }: { c: Of<"qsys-selector">; onConfig: (c: LayoutObjectConfig) => void }) {
  const coreHasChoices = useCoreHasChoices();
  return (
    <div className="flex flex-col gap-2.5">
      {/* The choice-list mode only where the Core reports choices (or one is already bound, so it can be seen and cleared). */}
      {(coreHasChoices || c.binding) && (
        <Bind
          label="Choice list"
          hint="A control with a list of choices. Used when there are no buttons below."
          kind="choice"
          writable
          value={c.binding}
          onChange={(b) => onConfig({ ...c, binding: b })}
        />
      )}
      <Items title="Buttons" addLabel="Add button" kind="press" items={c.items} onChange={(items) => onConfig({ ...c, items })} />
    </div>
  );
}

const SLOTS: StripSlot[] = ["gain", "meter", "meter2", "mute", "name"];

/** The browser's rule for what may fill a strip slot, over one component. */
function eligibilityOver(comp: CatalogComponent, load: Extract<QsysCoreLoad, { state: "ready" }>): Eligibility {
  const control = (name: string): CatalogControl | undefined => comp.controls.find((x) => x.Name === name);
  return (slot, name) => {
    const ctl = control(name);
    if (!ctl) return "wrong-kind";
    if (slot === "gain" || slot === "mute") {
      const entry = load.allow?.get(allowKey(comp.name, name));
      if (!entry) return "not-allowed";
      if (!isWritable(ctl, entry)) return "not-writable";
      return fitsKind(slot === "gain" ? "gain" : "boolean", comp.type, ctl) ? "ok" : "wrong-kind";
    }
    // The same rule as the field's own Core browser, so the fill never offers what the field would not list.
    return fitsKind(slot === "name" ? "string" : "meter", comp.type, ctl) ? "ok" : "wrong-kind";
  };
}

/** Bind a whole channel at once: pick a component, then a channel; the fields fill from the control names. */
function StripFill({ c, onConfig }: { c: Of<"qsys-strip">; onConfig: (c: LayoutObjectConfig) => void }) {
  const [open, setOpen] = useState(false);
  /** Bumped on each open, so each open reads the Core afresh. */
  const [opened, setOpened] = useState(0);
  const load = useQsysCoreLoad(open ? opened : null, true);
  const [component, setComponent] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const namesOf = (comp: CatalogComponent) => comp.controls.map((x) => x.Name);
  const withChannels = load.state === "ready" ? load.components.filter((comp) => channelsOf(namesOf(comp)).length > 0 || isGainBlock(comp.type, namesOf(comp))) : [];
  const comp = withChannels.find((x) => x.name === component);

  const gainBlock = comp ? isGainBlock(comp.type, namesOf(comp)) : false;

  /** `channel` is null for a Gain block, which is one channel with no number. */
  const apply = (channel: StripChannel | null) => {
    if (!comp || load.state !== "ready") return;
    const eligible = eligibilityOver(comp, load);
    const m = channel ? matchStrip(namesOf(comp), channel, eligible) : matchGainBlock(namesOf(comp), eligible);
    const at = (slot: StripSlot) => (m[slot].control ? { component: comp.name, control: m[slot].control } : null);
    onConfig({ ...c, name: at("name"), gain: at("gain"), mute: at("mute"), meter: at("meter"), meter2: at("meter2") ?? undefined });
    // A second meter is optional; saying it is missing would be noise.
    setNotes(SLOTS.filter((s) => s !== "meter2" && m[s].problem).map((s) => problemWords(s, m[s].problem!)));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Button variant="soft" aria-expanded={open} onClick={() => { setOpen((o) => !o); setOpened((n) => n + 1); }}>
        Bind a channel
      </Button>
      {open && (
        <div className="flex flex-col gap-1.5 rounded-md border border-line p-2" data-qsys-strip-fill>
          <CoreLoadNotice load={load} />
          {load.state === "ready" && (withChannels.length === 0 ? (
            <p className="text-caption2 text-fg-muted">No component has controls named like a channel (input.3.gain, output.1.mute, text.display.3), and none is a Gain block.</p>
          ) : (
            <>
              <select aria-label="Component" className="h-7 rounded-md border border-line-strong bg-field px-2 text-footnote font-mono" value={component} onChange={(e) => setComponent(e.target.value)}>
                <option value="">Choose a component</option>
                {withChannels.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
              </select>
              {comp && (
                <div className="flex flex-wrap gap-1" role="group" aria-label="Channel">
                  {gainBlock && <Button variant="filled" size="small" onClick={() => apply(null)}>Gain block</Button>}
                  {!gainBlock && channelsOf(namesOf(comp)).map((ch) => (
                    <Button key={`${ch.side}${ch.n}`} variant="filled" size="small" onClick={() => apply(ch)}>{channelLabel(ch)}</Button>
                  ))}
                </div>
              )}
            </>
          ))}
          {notes.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-caption2 text-fg-muted" data-qsys-fill-notes>
              {notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
