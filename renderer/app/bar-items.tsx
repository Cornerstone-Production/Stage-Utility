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
    hint: "Counts what is disconnected. Shows nothing when everything is fine.",
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

/** Valid ids from a saved config, in the saved order.
 *
 *  Unknown ids are SKIPPED rather than rendered blank: a downgrade, or an
 *  integration removed, can leave a saved order naming something this build does
 *  not have, and a hole in the bar is worse than a shorter bar.
 *
 *  An empty or entirely-unknown result falls back to the default, because a bar
 *  that renders nothing reads as broken rather than as configured. */
export function visibleBarItems(saved: readonly string[] | undefined): BarItemId[] {
  const known = (saved ?? []).filter((id): id is BarItemId => id in BAR_ITEMS);
  return known.length > 0 ? known : DEFAULT_BAR_ORDER;
}

/** Type-safe helper so callers do not index BAR_ITEMS with a bare string. */
export function barItem(id: BarItemId): BarItem {
  return BAR_ITEMS[id];
}

export type { ReactNode };
