// window-editor.tsx — when a schedule is open, and how that reads at a glance.
//
// describeWindow is the only place an operator sees what a schedule DOES without
// opening it, so it has to be honest about the cases that look wrong at face
// value — a window ending before it starts runs into the next day, and one with
// no days selected never runs at all.

import type { ServiceTypeDTO } from "@main/types/stage";
import type { SignageWindow } from "@main/types/signage";

import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { NumberInput } from "../../components/ui/number-input";
import { DAY_NAMES } from "./week-layout";
import { Switch } from "../../components/ui/switch";
import { SelectField } from "./select-field";

/** Sunday first, matching Date.prototype.getDay and the stored day numbers. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-12-24" as "Dec 24". Parsed by hand rather than through Date, which
 *  would interpret a bare date as UTC and shift it a day in western zones. */
function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

function describeDays(days: readonly number[] | undefined): string {
  if (!days) return "";
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 0) return "no days selected";
  if (sorted.length === 7) return "Every day";
  // A range only when the days really are consecutive — forcing "Sun, Wed" into
  // "Sun-Wed" would claim two days it does not run.
  const consecutive = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (consecutive && sorted.length > 2) {
    return `${DAY_NAMES[sorted[0]]}-${DAY_NAMES[sorted[sorted.length - 1]]}`;
  }
  return sorted.map((d) => DAY_NAMES[d]).join(", ");
}

/** The clock part, saying so when it runs past midnight. */
function describeHours(start: string, end: string): string {
  const wraps = end <= start;
  return `${start}-${end}${wraps ? " (next day)" : ""}`;
}

/** One line describing when this window is open. */
export function describeWindow(w: SignageWindow): string {
  switch (w.kind) {
    case "always":
      return "Always";

    case "weekly": {
      const days = describeDays(w.days);
      if (days === "no days selected") return "Never — no days selected";
      return `${days} ${describeHours(w.start, w.end)}`;
    }

    case "dates": {
      const range = `${shortDate(w.from)} - ${shortDate(w.to)}`;
      const days = w.days?.length ? `${describeDays(w.days)} ` : "";
      return `${range}, ${days}${describeHours(w.start, w.end)}`;
    }

    case "once":
      return `${shortDate(w.date)}, ${describeHours(w.start, w.end)}`;

    case "pco": {
      const held = w.liveExtension ? ", held while live" : "";
      return `PCO plan times, ${w.leadMinutes} min before to ${w.trailMinutes} min after${held}`;
    }
  }
}

const KINDS = [
  { value: "always", label: "Always" },
  { value: "weekly", label: "Weekly" },
  { value: "dates", label: "Date range" },
  { value: "once", label: "One-off" },
  { value: "pco", label: "Planning Center plan times" },
];

/** A fresh window of each kind, so switching kind never leaves a half-filled one. */
function blankWindow(kind: string, serviceTypeId: string): SignageWindow {
  switch (kind) {
    case "weekly":
      return { kind: "weekly", days: [0], start: "05:00", end: "13:00" };
    case "dates":
      return { kind: "dates", from: "", to: "", start: "08:00", end: "20:00" };
    case "once":
      return { kind: "once", date: "", start: "08:00", end: "20:00" };
    case "pco":
      return { kind: "pco", serviceTypeId, leadMinutes: 60, trailMinutes: 30, liveExtension: true };
    default:
      return { kind: "always" };
  }
}

export function WindowEditor({
  window: w,
  serviceTypes,
  onChange,
}: {
  window: SignageWindow;
  serviceTypes: ServiceTypeDTO[];
  onChange: (w: SignageWindow) => void;
}) {
  const days = w.kind === "weekly" || w.kind === "dates" ? (w.days ?? []) : [];
  const toggleDay = (d: number) => {
    if (w.kind !== "weekly" && w.kind !== "dates") return;
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
    onChange({ ...w, days: next });
  };

  return (
    <div className="flex flex-col gap-3">
      <SelectField
        label="When"
        value={w.kind}
        onChange={(k) => onChange(blankWindow(k, serviceTypes[0]?.id ?? ""))}
        options={KINDS}
      />

      {w.kind === "weekly" || w.kind === "dates" ? (
        <div className="flex flex-col gap-1">
          <span className="text-caption1 text-fg-muted">Days</span>
          <div className="flex flex-wrap gap-2">
            {DAY_NAMES.map((name, d) => (
              <label key={name} className="flex items-center gap-1.5 text-footnote text-fg">
                <Checkbox checked={days.includes(d)} onCheckedChange={() => toggleDay(d)} />
                {name}
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {w.kind === "dates" ? (
        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-caption1 text-fg-muted">From</span>
            <Input type="date" value={w.from} onChange={(e) => onChange({ ...w, from: e.target.value })} />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-caption1 text-fg-muted">To</span>
            <Input type="date" value={w.to} onChange={(e) => onChange({ ...w, to: e.target.value })} />
          </label>
        </div>
      ) : null}

      {w.kind === "once" ? (
        <label className="flex flex-col gap-1">
          <span className="text-caption1 text-fg-muted">Date</span>
          <Input type="date" value={w.date} onChange={(e) => onChange({ ...w, date: e.target.value })} />
        </label>
      ) : null}

      {w.kind === "weekly" || w.kind === "dates" || w.kind === "once" ? (
        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-caption1 text-fg-muted">Start</span>
            <Input type="time" value={w.start} onChange={(e) => onChange({ ...w, start: e.target.value })} />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-caption1 text-fg-muted">End</span>
            <Input type="time" value={w.end} onChange={(e) => onChange({ ...w, end: e.target.value })} />
          </label>
        </div>
      ) : null}

      {w.kind === "pco" ? (
        <>
          <SelectField
            label="Service type"
            value={w.serviceTypeId}
            onChange={(v) => onChange({ ...w, serviceTypeId: v })}
            options={serviceTypes.map((t) => ({ value: t.id, label: t.name }))}
            placeholder="Pick a service type"
          />
          <div className="flex gap-2">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-caption1 text-fg-muted">Minutes before</span>
              <NumberInput
                value={w.leadMinutes}
                min={0}
                max={1440}
                onChange={(v) => onChange({ ...w, leadMinutes: v })}
              />
            </label>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-caption1 text-fg-muted">Minutes after</span>
              <NumberInput
                value={w.trailMinutes}
                min={0}
                max={1440}
                onChange={(v) => onChange({ ...w, trailMinutes: v })}
              />
            </label>
          </div>
          <label className="flex items-center gap-2">
            <Switch
              checked={w.liveExtension}
              onCheckedChange={(on) => onChange({ ...w, liveExtension: on })}
            />
            <span className="text-footnote text-fg">Stay on while the service is live</span>
          </label>
          <p className="text-caption2 text-fg-subtle">
            Holds the window open past its end while Planning Center reports this service type live,
            so a service running long does not blank the screens mid-service.
          </p>
        </>
      ) : null}
    </div>
  );
}
