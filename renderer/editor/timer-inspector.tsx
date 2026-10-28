// The Timer's inspector, drawn as the approved mockup draws it: the source across
// the top, what belongs to that source under it, then the caption and the two
// switches every source shares, then the warning settings (or a sentence saying
// why a baptism has none).
//
// Built from the shared rows, like every other widget's inspector. A label too
// long to sit beside its control ("Warn at (seconds left)") goes above it on its
// own, and the Timer field takes the full width for its long placeholder.

import type { LayoutObjectConfig } from "@main/types/views";
import { Input } from "../components/ui";
import {
  BAPTISM_FIELD_OPTIONS,
  TIMER_SOURCES,
  TIMER_SOURCE_INFO,
  timerSource,
  withTimerSource,
  type TimerConfig,
} from "../main/timer-config";
import { Row, RowNumber, RowSelect, RowSwitch, RowText, RowToggle } from "./inspector-rows";

export function TimerInspector({
  c,
  onConfig,
  propInstances,
}: {
  c: TimerConfig;
  onConfig: (c: LayoutObjectConfig) => void;
  /** The parent Inspector's read of the ProPresenter instances, so this does not
   *  open a second one. */
  propInstances: PropInstancesDTO | null;
}) {
  const source = timerSource(c);
  const info = TIMER_SOURCE_INFO[source];
  const set = (patch: Partial<TimerConfig>) => onConfig({ ...c, ...patch });
  // The timers ProPresenter is running right now, from the instance this one
  // reads, offered as suggestions: ProPresenter reports only running timers.
  const running = propInstances?.status?.[c.propresenterInstanceId ?? "default"]?.timers ?? [];
  const names = running.map((t) => t.name);
  if (c.timerName && !names.includes(c.timerName)) names.push(c.timerName);

  const warnOn = c.warnSeconds != null;

  return (
    <div className="flex flex-col gap-2.5">
      <RowToggle label="Source" value={source} options={TIMER_SOURCES} onChange={(v) => onConfig(withTimerSource(c, v))} />

      {info.nextItem && (
        <RowSwitch label="Show the next item" checked={c.nextItem ?? false} onChange={(v) => set({ nextItem: v })} />
      )}

      {source === "propresenter" && (
        <Row
          label="Timer"
          stacked
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
            onBlur={(e) => {
              // Leaving the field untouched writes nothing: a write marks the layout
              // unsaved, pushes an undo step and converts a retired widget.
              const trimmed = e.target.value.trim();
              if (trimmed === (c.timerName ?? "")) return;
              set({ timerName: trimmed || null });
            }}
          />
          <datalist id="timer-names">
            {names.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </Row>
      )}

      {source === "baptism" && (
        <RowSelect
          label="Shows"
          value={c.field ?? "live"}
          options={BAPTISM_FIELD_OPTIONS}
          onChange={(v) => set({ field: v as NonNullable<TimerConfig["field"]> })}
        />
      )}

      <div className="flex flex-col gap-2.5 border-t border-line pt-3">
        <RowText
          label="Caption"
          value={c.caption ?? ""}
          // Empty is NO caption, except on a service Timer that has never had
          // one set, which draws the live item's name.
          placeholder={source === "service" && c.caption === undefined ? "The item\u2019s name" : "No caption"}
          onChange={(v) => set({ caption: v })}
        />
        {info.subSwitch && (
          <RowSwitch label={info.subSwitch} checked={c.showLabel ?? true} onChange={(v) => set({ showLabel: v })} />
        )}
        {source === "baptism" && (c.showLabel ?? true) && (
          <RowText label="Label" value={c.label ?? ""} placeholder="(auto)" onChange={(v) => set({ label: v })} />
        )}
        <RowSwitch label="Hide when idle" checked={c.hideWhenIdle ?? false} onChange={(v) => set({ hideWhenIdle: v })} />
      </div>

      <div className="flex flex-col gap-2.5 border-t border-line pt-3">
        {info.warns ? (
          <>
            <RowSwitch label="Amber near the end" checked={warnOn} onChange={(v) => set({ warnSeconds: v ? 60 : undefined })} />
            {warnOn && (
              <RowNumber
                label="Warn at (seconds left)"
                value={c.warnSeconds ?? 0}
                step={5}
                min={0}
                max={3600}
                onChange={(v) => set({ warnSeconds: Math.round(v) })}
              />
            )}
            <RowSwitch label="Red on overrun" checked={c.redOnOverrun ?? true} onChange={(v) => set({ redOnOverrun: v })} />
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
