// The Timer's inspector, drawn as the approved mockup draws it: the source across
// the top, what belongs to that source under it, then the caption and the two
// switches every source shares, then the warning settings (or a sentence saying
// why a baptism has none).
//
// Stacked labels and switch rows rather than the label-left Rows, as the Video
// section is built, because "Show the next item" and "Warn at (seconds left)" do
// not fit beside a 96px label.

import type { LayoutObjectConfig } from "@main/types/views";
import { FieldLabel, Input, NumberInput, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, StackedField } from "../components/ui";
import { usePropInstances } from "../main/use-dashboard-state";
import {
  BAPTISM_FIELD_OPTIONS,
  TIMER_SOURCES,
  TIMER_SOURCE_INFO,
  timerSource,
  withTimerSource,
  type TimerConfig,
} from "../main/timer-config";
import { Segmented, StackedSwitch } from "./inspector-rows";

export function TimerInspector({ c, onConfig }: { c: TimerConfig; onConfig: (c: LayoutObjectConfig) => void }) {
  const source = timerSource(c);
  const info = TIMER_SOURCE_INFO[source];
  const set = (patch: Partial<TimerConfig>) => onConfig({ ...c, ...patch });
  // The timers ProPresenter is running right now, from the instance this one
  // reads, offered as suggestions: ProPresenter reports only running timers.
  const instances = usePropInstances();
  const running = instances?.status?.[c.propresenterInstanceId ?? "default"]?.timers ?? [];
  const names = running.map((t) => t.name);
  if (c.timerName && !names.includes(c.timerName)) names.push(c.timerName);

  const warnOn = c.warnSeconds != null;

  return (
    <div className="flex flex-col gap-3.5">
      <StackedField label="Source">
        <Segmented
          label="Source"
          value={source}
          options={TIMER_SOURCES}
          onChange={(v) => onConfig(withTimerSource(c, v))}
        />
      </StackedField>

      {info.nextItem && (
        <StackedSwitch label="Show the next item" checked={c.nextItem ?? false} onChange={(v) => set({ nextItem: v })} />
      )}

      {source === "propresenter" && (
        <StackedField
          label="Timer"
          description="A second ProPresenter picker appears only when more than one is connected."
        >
          {/* Always a text field: typing a name before the service has to work, and
              ProPresenter only reports RUNNING timers, so the reported ones are
              suggestions, never the whole list. */}
          <Input
            aria-label="Timer"
            list="timer-names"
            value={c.timerName ?? ""}
            placeholder="Empty follows the first running timer"
            // Not trimmed as it is typed: a name of two words has a space in the
            // middle of typing it. Trimmed when the field is left.
            onChange={(e) => set({ timerName: e.target.value || null })}
            onBlur={(e) => set({ timerName: e.target.value.trim() || null })}
          />
          <datalist id="timer-names">
            {names.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
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
            // Empty is NO caption, except on a service Timer that has never had
            // one set, which draws the live item's name.
            placeholder={source === "service" && c.caption === undefined ? "The item\u2019s name" : "No caption"}
            onChange={(e) => set({ caption: e.target.value })}
          />
        </StackedField>
        <StackedSwitch
          label={info.subSwitch}
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
        <StackedSwitch label="Hide when idle" checked={c.hideWhenIdle ?? false} onChange={(v) => set({ hideWhenIdle: v })} />
      </div>

      <div className="flex flex-col gap-3 border-t border-line pt-3.5">
        {info.warns ? (
          <>
            <StackedSwitch
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
            <StackedSwitch label="Red on overrun" checked={c.redOnOverrun ?? true} onChange={(v) => set({ redOnOverrun: v })} />
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
