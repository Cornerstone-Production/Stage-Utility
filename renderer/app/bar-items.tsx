// The context bar's items, as a registry.
//
// A fixed bar was right while there were four things to show and one place they
// came from. It stops being right the moment another integration lands: every
// new one would have to edit the bar's JSX, and whoever added it would decide by
// hand whether it belonged.
//
// EXHAUSTIVENESS IS COMPILER-ENFORCED. `BarItemId` is a union and BAR_ITEMS is a
// Record keyed by it, so a new id without an entry fails `tsc`. That is the
// requirement the design doc singles out, because this becomes another place a
// new integration has to register itself and source-scanning guards here have
// repeatedly passed while missing entries.
//
// Items share DATA HOOKS with the layout objects, not components: the recording
// item and the OBS-status object both read use-obs-state, and the recording item
// reuses Home's recordingStat() rather than making the same judgement twice. A
// compact strip and a free-form canvas box are different presentations of the
// same fact.

import type { ReactNode } from "react";
import {
  ClockIcon,
  CalendarIcon,
  TimerIcon,
  ListIcon,
  PlugZapIcon,
  CircleDotIcon,
  type LucideIcon,
} from "lucide-react";

export type BarItemId =
  | "clock"
  | "plan"
  | "live-timer"
  | "current-item"
  | "integration-health"
  | "recording";

/**
 * The alignment split, as a position in the saved order.
 *
 * The bar has one left group and one right group, and this is where the cut
 * falls: everything before it sits left, everything from it on sits right.
 *
 * It is a saved position rather than a per-item `side` property because the two
 * groups are contiguous by construction — there is no left, right, left — and a
 * `side` field would let an operator ask for one. It is NOT in BAR_ITEMS: it
 * shows no reading, so it is not an item, and keeping it out is what stops the
 * renderer having to special-case a row that draws nothing.
 */
export const BAR_SPLIT = "split" as const;
export type BarSplit = typeof BAR_SPLIT;

/** A row of the saved order: an item, or the split. */
export type BarRowId = BarItemId | BarSplit;

export interface BarItem {
  id: BarItemId;
  /** Shown in the chooser, not in the bar. */
  label: string;
  icon: LucideIcon;
  /** What it says about itself in the chooser, so the choice is informed. */
  hint: string;
}

/**
 * Every item the bar can show.
 *
 * Rendering lives in context-bar.tsx: this is the catalogue and the ORDER
 * default, deliberately data-only so the chooser can read it without importing
 * the bar.
 */
export const BAR_ITEMS: Record<BarItemId, BarItem> = {
  clock: {
    id: "clock",
    label: "Clock",
    icon: ClockIcon,
    hint: "The current time.",
  },
  plan: {
    id: "plan",
    label: "Service type and plan",
    icon: CalendarIcon,
    hint: "Which service, and which plan is active.",
  },
  "live-timer": {
    id: "live-timer",
    label: "Live state and timer",
    icon: TimerIcon,
    hint: "Whether a service is running, and the countdown.",
  },
  "current-item": {
    id: "current-item",
    label: "Current plan item",
    icon: ListIcon,
    hint: "What Planning Center says is happening now.",
  },
  "integration-health": {
    id: "integration-health",
    label: "Integration health",
    icon: PlugZapIcon,
    hint: "Counts what is disconnected. Click it to see which.",
  },
  recording: {
    id: "recording",
    label: "Recording",
    icon: CircleDotIcon,
    hint: "Whether OBS or REAPER is rolling — and whether one is connected but stopped.",
  },
};

/**
 * What a bar nobody has configured shows.
 *
 * The four the bar shipped with, in the order it shipped them, so an install
 * that never opens the chooser looks exactly as it does today. The two new items
 * are opt-in rather than added to everyone's bar without asking.
 */
export const DEFAULT_BAR_ORDER: BarItemId[] = ["plan", "current-item", "live-timer"];

/**
 * Where the split goes in a bar saved before the split existed.
 *
 * Until now the side was INFERRED at render time: the first of these present,
 * and everything after it, was pushed right. That rule is gone from rendering —
 * it survives here only to place the divider where an existing bar already had
 * its cut, so no install's bar moves when it upgrades.
 *
 * Do not add to this. A new item's side is wherever the operator drags it.
 */
const LEGACY_RIGHT: ReadonlySet<string> = new Set([
  "live-timer",
  "current-item",
  "integration-health",
  "recording",
]);

/** Put the split where the inferred rule used to cut. No service-state item
 *  means the old bar packed everything left, so the split goes on the end. */
function withLegacySplit(items: readonly BarItemId[]): BarRowId[] {
  const at = items.findIndex((id) => LEGACY_RIGHT.has(id));
  const cut = at === -1 ? items.length : at;
  return [...items.slice(0, cut), BAR_SPLIT, ...items.slice(cut)];
}

/** Valid rows from a saved config, in the saved order, with exactly one split.
 *
 *  Unknown ids are SKIPPED rather than rendered blank: a downgrade, or an
 *  integration removed, can leave a saved order naming something this build does
 *  not have, and a hole in the bar is worse than a shorter bar.
 *
 *  An empty or entirely-unknown result falls back to the default, because a bar
 *  that renders nothing reads as broken rather than as configured.
 *
 *  Exactly one split, always — a config with none predates it, and one with two
 *  was hand-edited. Both would otherwise render a bar whose alignment depends on
 *  which split the renderer happened to see last. */
export function visibleBarItems(saved: readonly string[] | undefined): BarRowId[] {
  const rows = (saved ?? []).filter(
    (id): id is BarRowId => id === BAR_SPLIT || id in BAR_ITEMS,
  );
  const items = rows.filter((id): id is BarItemId => id !== BAR_SPLIT);
  if (items.length === 0) return withLegacySplit(DEFAULT_BAR_ORDER);
  if (!rows.includes(BAR_SPLIT)) return withLegacySplit(items);

  let kept = false;
  return rows.filter((id) => {
    if (id !== BAR_SPLIT) return true;
    if (kept) return false;
    kept = true;
    return true;
  });
}

/**
 * The items to render, and the index the right-hand group starts at.
 *
 * Pure and separate from the bar so the alignment is testable without rendering
 * React — the split's whole job is which side things land on, and a rule nobody
 * can assert on is how the inferred one drifted out of anyone's understanding.
 *
 * `splitAt` of -1, or of `ids.length`, both mean everything sits left.
 */
export function barRows(rows: readonly BarRowId[]): { ids: BarItemId[]; splitAt: number } {
  const ids: BarItemId[] = [];
  let splitAt = -1;
  for (const id of rows) {
    if (id === BAR_SPLIT) splitAt = ids.length;
    else ids.push(id);
  }
  return { ids, splitAt };
}

/** Type-safe helper so callers do not index BAR_ITEMS with a bare string. */
export function barItem(id: BarItemId): BarItem {
  return BAR_ITEMS[id];
}

export type { ReactNode };
