import type { RundownColumn } from "./rundown-table";
import type { CategoryRole } from "../../main/types/scriptview-roles.js";
import { resolveRole, roleAppliesTo } from "./role-resolve";

// Shared column/clock logic for ScriptView, used by both the standalone page and
// the settings preview so they render identically. Resolves a layout's per-element
// toggles, projects the wall-clock per item, and builds the RundownTable columns.

export interface ScriptViewSpec {
  /** Roles to render, already filtered to those this service type defines. */
  columns: CategoryRole[];
  showClock: boolean;
  showLength: boolean;
  showKey: boolean;
  showBpm: boolean;
  showArrangement: boolean;
  showItemNotes: boolean;
  showTotalTime: boolean;
  /** Opt-IN, unlike the others: absent means off, not on. */
  showMaxSpl: boolean;
}

/** Resolve a layout (or the implicit "All columns" default when null) into a spec.
 *  Toggles default ON — undefined means shown, only `false` hides.
 *
 *  `categories` is what THIS service type defines. A role none of whose members appear
 *  there is dropped rather than rendered as an empty column — a name-based column used
 *  to render blank on every service type that called the same thing something else. */
export function resolveScriptViewSpec(
  layout: ScriptViewLayout | null,
  roles: CategoryRole[],
  categories: string[],
): ScriptViewSpec {
  const on = (v: boolean | undefined) => v !== false;
  const byId = new Map(roles.map((r) => [r.id, r]));
  const chosen = layout
    ? (layout.columnRoles ?? []).map((id) => byId.get(id)).filter((r): r is CategoryRole => !!r)
    : roles;
  return {
    columns: chosen.filter((r) => roleAppliesTo(r, categories)),
    showClock: layout ? on(layout.showClock) : true,
    showLength: layout ? on(layout.showLength) : true,
    showKey: layout ? on(layout.showKey) : true,
    showBpm: layout ? on(layout.showBpm) : true,
    showArrangement: layout ? on(layout.showArrangement) : true,
    showItemNotes: layout ? on(layout.showItemNotes) : true,
    showTotalTime: layout ? on(layout.showTotalTime) : true,
    showMaxSpl: layout?.showMaxSpl === true,
  };
}

/** Project each item's start time (epoch ms) by anchoring SERVICE START (or the
 *  first "during" item) to the plan's scheduled service time and walking item
 *  lengths forward + backward. Null when there's no anchor time. */
export function computeClocks(items: PlanItemDTO[], anchorISO: string | null | undefined): Map<string, number> | null {
  if (!anchorISO) return null;
  const anchor = Date.parse(anchorISO);
  const n = items.length;
  if (!Number.isFinite(anchor) || n === 0) return null;

  let ai = items.findIndex((it) => it.itemType === "header" && /\bSERVICE\s+(START|BEGIN)\b|\bSTART OF SERVICE\b/.test(it.title.toUpperCase()));
  if (ai < 0) ai = items.findIndex((it) => it.servicePosition === "during");
  if (ai < 0) ai = 0;

  const start: number[] = new Array(n);
  start[ai] = anchor;
  for (let i = ai + 1; i < n; i++) start[i] = start[i - 1] + (items[i - 1].lengthSec || 0) * 1000;
  for (let i = ai - 1; i >= 0; i--) start[i] = start[i + 1] - (items[i].lengthSec || 0) * 1000;

  const clocks = new Map<string, number>();
  for (let i = 0; i < n; i++) clocks.set(items[i].id, start[i]);
  return clocks;
}

export function fmtLen(sec: number): string {
  if (!sec || sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtTotal(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Format an epoch-ms clock in the plan's timezone (falls back to the viewer's). */
export function fmtClock(ms: number, timeZone?: string | null): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric", minute: "2-digit", second: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
}

export function totalLengthSec(items: PlanItemDTO[]): number {
  return items.reduce((sum, it) => sum + (it.lengthSec > 0 ? it.lengthSec : 0), 0);
}

/** Build the RundownTable columns for a spec. `clocks` (from computeClocks) drives
 *  the Clock column; omit/null to hide it even when showClock is on. `timeZone`
 *  renders the clock in the plan's local time. */
export function buildScriptViewColumns(
  spec: ScriptViewSpec,
  clocks: Map<string, number> | null,
  timeZone?: string | null,
  /** itemId → recorded peak SPL. Absent = the column renders "—" rather than
   *  disappearing, so a layout that asks for it does not silently reflow when
   *  Smaart drops. */
  maxSplByItem?: Map<string, number | null>,
): RundownColumn[] {
  const cols: RundownColumn[] = [];

  if (spec.showClock && clocks) {
    cols.push({
      key: "clock", header: "Clock", width: "6.5rem", cellClassName: "text-fg-subtle font-mono tabular-nums",
      render: (it) => { const ms = clocks.get(it.id); return ms != null ? fmtClock(ms, timeZone) : ""; },
    });
  }

  if (spec.showLength) {
    cols.push({
      key: "len", header: "Time", width: "4.75rem", cellClassName: "text-fg-subtle font-mono tabular-nums",
      render: (it) => { const s = fmtLen(it.lengthSec); return s ? (it.servicePosition === "pre" ? `- ${s}` : s) : ""; },
    });
  }

  cols.push({
    key: "title", header: "Item",
    render: (it, { isCurrent }) => {
      const parts: string[] = [];
      if (spec.showKey && it.songKey) parts.push(`Key ${it.songKey}`);
      if (spec.showBpm && it.bpm) parts.push(`${it.bpm} BPM`);
      if (spec.showArrangement && it.arrangementName) parts.push(it.arrangementName);
      const meta = parts.join("  ·  ");
      return (
        <div className="flex flex-col leading-tight">
          <span className={`font-medium ${isCurrent ? "text-live-11" : "text-fg"}`}>{it.title}</span>
          {meta && <span className="text-caption2 italic text-accent/85">{meta}</span>}
          {spec.showItemNotes && it.description && <span className="text-caption2 text-fg-subtle whitespace-pre-line mt-0.5">{it.description}</span>}
        </div>
      );
    },
  });

  for (const role of spec.columns) {
    cols.push({
      key: `role:${role.id}`,
      header: role.name,
      cellClassName: "text-fg-muted whitespace-pre-line",
      render: (it) => resolveRole(role, it.notesByCategory),
    });
  }

  // Last, like every other rundown put it: it is a measurement of the item, read
  // after the fact, not something you follow along the row.
  if (spec.showMaxSpl) {
    cols.push({
      key: "spl", header: "Max SPL", align: "right", width: "6rem", cellClassName: "text-fg tabular-nums",
      render: (it) => {
        const max = maxSplByItem?.get(it.id);
        return max != null ? `${Math.round(max)} dB` : "—";
      },
    });
  }

  return cols;
}
