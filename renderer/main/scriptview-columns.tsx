import type { RundownColumn } from "./rundown-table";

// Shared column/clock logic for ScriptView, used by both the standalone page and
// the settings preview so they render identically. Resolves a layout's per-element
// toggles, projects the wall-clock per item, and builds the RundownTable columns.

export interface ScriptViewSpec {
  columns: string[];
  showClock: boolean;
  showLength: boolean;
  showKey: boolean;
  showBpm: boolean;
  showArrangement: boolean;
  showItemNotes: boolean;
  showTotalTime: boolean;
}

/** Resolve a layout (or the implicit "All columns" default when null) into a spec.
 *  Toggles default ON — undefined means shown, only `false` hides. */
export function resolveScriptViewSpec(layout: ScriptViewLayout | null, allCats: string[]): ScriptViewSpec {
  const on = (v: boolean | undefined) => v !== false;
  return {
    columns: layout ? layout.columns : allCats,
    showClock: layout ? on(layout.showClock) : true,
    showLength: layout ? on(layout.showLength) : true,
    showKey: layout ? on(layout.showKey) : true,
    showBpm: layout ? on(layout.showBpm) : true,
    showArrangement: layout ? on(layout.showArrangement) : true,
    showItemNotes: layout ? on(layout.showItemNotes) : true,
    showTotalTime: layout ? on(layout.showTotalTime) : true,
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

export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function totalLengthSec(items: PlanItemDTO[]): number {
  return items.reduce((sum, it) => sum + (it.lengthSec > 0 ? it.lengthSec : 0), 0);
}

/** Build the RundownTable columns for a spec. `clocks` (from computeClocks) drives
 *  the Clock column; omit/null to hide it even when showClock is on. */
export function buildScriptViewColumns(spec: ScriptViewSpec, clocks: Map<string, number> | null): RundownColumn[] {
  const cols: RundownColumn[] = [];

  if (spec.showClock && clocks) {
    cols.push({
      key: "clock", header: "Clock", width: "6.5rem", cellClassName: "text-white/55 tabular-nums",
      render: (it) => { const ms = clocks.get(it.id); return ms != null ? fmtClock(ms) : ""; },
    });
  }

  if (spec.showLength) {
    cols.push({
      key: "len", header: "Time", width: "4.75rem", cellClassName: "text-white/55 tabular-nums",
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
          <span className={`font-medium ${isCurrent ? "text-[#7fe3c4]" : "text-white/90"}`}>{it.title}</span>
          {meta && <span className="text-caption2 italic text-[#8ab4ff]/85">{meta}</span>}
          {spec.showItemNotes && it.description && <span className="text-caption2 text-white/55 whitespace-pre-line mt-0.5">{it.description}</span>}
        </div>
      );
    },
  });

  for (const c of spec.columns) {
    cols.push({ key: `note:${c}`, header: c, cellClassName: "text-white/60 whitespace-pre-line", render: (it) => it.notesByCategory[c] ?? "" });
  }

  return cols;
}
