// The Timer's inspector, drawn as the approved mockup draws it: the source across
// the top, what belongs to that source under it, then the caption and the two
// switches every source shares, then the warning settings (or a sentence saying
// why a baptism has none).
//
// Stacked labels and switch rows rather than the label-left Rows, as the Video
// section is built, because "Show the next item" and "Warn at (seconds left)" do
// not fit beside a 96px label.

import type { LayoutObjectConfig } from "@main/types/views";
import { FieldLabel, Input, NumberInput, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, StackedField, Switch } from "../components/ui";
import { usePropInstances } from "../main/use-dashboard-state";
import {
  BAPTISM_FIELD_OPTIONS,
  TIMER_CAPTION_PLACEHOLDER,
  TIMER_SOURCES,
  type TimerConfig,
} from "../main/timer-config";
import { Segmented } from "./inspector-rows";

/** The sentinel for "the first timer ProPresenter reports", which is `null` in
 *  the config — a Select value cannot be null. */
const FIRST = "__first__";

/** A label on the left, a switch on the right: the row every setting here but
 *  the numbers and pickers uses. */
function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-2.5">
      <FieldLabel>{label}</FieldLabel>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export function TimerInspector({ c, onConfig }: { c: TimerConfig; onConfig: (c: LayoutObjectConfig) => void }) {
  const source = c.source ?? "service";
  const set = (patch: Partial<TimerConfig>) => onConfig({ ...c, ...patch });
  // The timers ProPresenter is running right now, from the instance this one
  // reads. ProPresenter reports only running timers, so a stopped one cannot be
  // listed: with none running the name is typed instead.
  const instances = usePropInstances();
  const running = instances?.status[c.propresenterInstanceId ?? "default"]?.timers ?? [];
  const names = running.map((t) => t.name);
  if (c.timerName && !names.includes(c.timerName)) names.push(c.timerName);

  const warnable = source !== "baptism";
  const warnOn = c.warnSeconds != null;

  return (
    <div className="flex flex-col gap-3.5">
      <StackedField label="Source">
        <Segmented
          label="Source"
          value={source}
          options={TIMER_SOURCES}
          onChange={(v) => set({ source: v })}
        />
      </StackedField>

      {source === "service" && (
        <SwitchRow label="Show the next item" checked={c.nextItem ?? false} onChange={(v) => set({ nextItem: v })} />
      )}

      {source === "propresenter" && (
        <StackedField
          label="Timer"
          description="A second ProPresenter picker appears only when more than one is connected."
        >
          {names.length > 0 ? (
            <Select
              value={c.timerName || FIRST}
              onValueChange={(v) => set({ timerName: v === FIRST ? null : v })}
            >
              <SelectTrigger aria-label="Timer" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={FIRST}>The first running timer</SelectItem>
                {names.map((n) => (
                  <SelectItem key={n} value={n}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              aria-label="Timer"
              value={c.timerName ?? ""}
              placeholder="The first running timer"
              onChange={(e) => set({ timerName: e.target.value.trim() || null })}
            />
          )}
        </StackedField>
      )}

      {source === "baptism" && (
        <StackedField label="Shows">
          <Select value={c.field ?? "live"} onValueChange={(v) => set({ field: v as NonNullable<TimerConfig["field"]> })}>
            <SelectTrigger aria-label="Shows" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {BAPTISM_FIELD_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </StackedField>
      )}

      <div className="flex flex-col gap-3 border-t border-line pt-3.5">
        <StackedField label="Caption">
          <Input
            aria-label="Caption"
            value={c.caption ?? ""}
            placeholder={TIMER_CAPTION_PLACEHOLDER[source]}
            onChange={(e) => set({ caption: e.target.value.trim() ? e.target.value : undefined })}
          />
        </StackedField>
        <SwitchRow
          label={source === "propresenter" ? "Show the timer’s name" : source === "baptism" ? "Show the label" : "Show the sub-line"}
          checked={c.showLabel ?? true}
          onChange={(v) => set({ showLabel: v })}
        />
        {source === "baptism" && (c.showLabel ?? true) && (
          <StackedField label="Label">
            <Input
              aria-label="Label"
              value={c.label ?? ""}
              placeholder="(auto)"
              onChange={(e) => set({ label: e.target.value })}
            />
          </StackedField>
        )}
        <SwitchRow label="Hide when idle" checked={c.hideWhenIdle ?? false} onChange={(v) => set({ hideWhenIdle: v })} />
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-3.5">
        {warnable ? (
          <>
            <SwitchRow
              label="Amber near the end"
              checked={warnOn}
              onChange={(v) => set({ warnSeconds: v ? 60 : undefined })}
            />
            {warnOn && (
              <div className="flex items-center justify-between gap-2.5">
                <FieldLabel className="text-fg-muted font-normal">Warn at (seconds left)</FieldLabel>
                <NumberInput
                  aria-label="Warn at (seconds left)"
                  value={c.warnSeconds ?? 0}
                  step={5}
                  min={0}
                  max={3600}
                  onChange={(v) => set({ warnSeconds: Math.round(v) })}
                  className="w-24"
                />
              </div>
            )}
            <SwitchRow label="Red on overrun" checked={c.redOnOverrun ?? true} onChange={(v) => set({ redOnOverrun: v })} />
          </>
        ) : (
          <p className="text-caption2 text-fg-subtle leading-snug">
            Baptism clocks count up from zero, so there is no end to warn about.
          </p>
        )}
      </div>
    </div>
  );
}
