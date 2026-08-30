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

import {
  ClockIcon,
  CalendarIcon,
  TimerIcon,
  ListIcon,
  PlugZapIcon,
  CircleDotIcon,
  RadioTowerIcon,
  MoveHorizontalIcon,
  SquareIcon,
  TrophyIcon,
  type LucideIcon,
} from "lucide-react";

export type BarItemId =
  | "clock"
  | "plan"
  | "live-timer"
  | "current-item"
  | "integration-health"
  | "recording"
  | "streaming"
  | "scores";

/**
 * A flexible space, as a position in the saved order.
 *
 * It draws nothing and takes all the room going, which is what pushes whatever
 * follows it away from whatever precedes it. macOS's toolbar editor calls the
 * same thing "Flexible Space", and it behaves the same way here — including that
 * you can use more than one. Two of them share the slack equally, which is the
 * only way to centre a group.
 *
 * It is a position in the order rather than a per-item `side` property because
 * `side` cannot express "centred", and because a spacer is a thing you can see
 * and drag in the configurator where a boolean on an item is not.
 *
 * It is NOT in BAR_ITEMS: it shows no reading, so it is not an item.
 */
export const BAR_SPACER = "spacer" as const;
export type BarSpacer = typeof BAR_SPACER;

/** What the spacer was called before it could repeat. Read, never written. */
const LEGACY_SPACER = "split";

/**
 * A fixed gap.
 *
 * The flexible spacer decides ALIGNMENT — it eats the slack, which is what
 * pushes a group to an edge. This decides DISTANCE, and the two are not
 * substitutes: capping the flexible one so a group sits closer would leave the
 * uneaten slack after that group, so it would no longer reach the edge at all.
 *
 * One width, and repeatable, exactly as macOS does it. A size control would be
 * a number to tune on a strip whose whole job is to be glanced at.
 */
export const BAR_SPACE = "space" as const;
export type BarSpace = typeof BAR_SPACE;

/** A row of the saved order: an item, a flexible spacer, or a fixed gap. */
export type BarRowId = BarItemId | BarSpacer | BarSpace;

/** The two things in the palette that show no reading. */
export function isBarGap(id: BarRowId): id is BarSpacer | BarSpace {
  return id === BAR_SPACER || id === BAR_SPACE;
}

export interface BarItem {
  id: BarItemId;
  /** Shown in the chooser, not in the bar. */
  label: string;
  icon: LucideIcon;
  /** What it says about itself in the chooser, so the choice is informed. */
  hint: string;
  /**
   * THE EXCEPTION to "nothing appears or disappears". Set on `scores` alone.
   *
   * The rule the other seven keep is that an item with nothing to report says
   * so, because a strip that rearranges itself is a strip an operator cannot
   * learn the shape of. That rule is right for them: the clock, the plan, the
   * timer, the health count, the recorders and the stream ALWAYS have something
   * true to say, so their resting state is a reading, not an absence.
   *
   * Scores is not like them. For most of the year no followed team is playing,
   * so a permanent "No games" is not a reading — it is a word that never
   * changes, sitting on a strip where every other entry means something. The
   * honest rendering of "nothing is on" is nothing.
   *
   * The reflow this re-admits is bounded in a way the old one was not: the
   * capsule appears when a followed game goes live and leaves when it ends, a
   * handful of times a season, rather than integration health arriving the
   * moment something broke. context-bar.tsx drops the whole row when an item
   * renders empty, so a vanishing item leaves no gap and no dangling separator.
   *
   * The guard in context-bar.test.tsx reads THIS FLAG: every item without it
   * must still be proven never to vanish, and the set carrying it is asserted
   * exactly, so a second item cannot quietly join the exception.
   */
  canBeEmpty?: true;
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
  streaming: {
    id: "streaming",
    label: "Streaming",
    icon: RadioTowerIcon,
    hint: "Whether Resi, YouTube or OBS is live — and for how long.",
  },
  recording: {
    id: "recording",
    label: "Recording",
    icon: CircleDotIcon,
    hint: "Whether OBS or REAPER is rolling — and whether one is connected but stopped.",
  },
  scores: {
    id: "scores",
    label: "Live scores",
    icon: TrophyIcon,
    hint: "A followed team's score while the game is on. Click it for the full card. Shows nothing the rest of the time.",
    // The one item allowed to render nothing. See canBeEmpty for why this is an
    // amendment to the no-reflow rule rather than an escape from it.
    canBeEmpty: true,
  },
};

/**
 * How the spacer presents itself in the configurator.
 *
 * Beside BAR_ITEMS rather than in it: the palette needs a label and an icon for
 * it, but nothing else does, and putting it in the registry would oblige the
 * renderer to handle an "item" that shows no reading.
 */
export const BAR_SPACER_ITEM: Omit<BarItem, "id"> = {
  label: "Flexible space",
  icon: MoveHorizontalIcon,
  hint: "Pushes what follows it away from what comes before. Use two to centre a group.",
};

/** How the fixed gap presents itself in the configurator. */
export const BAR_SPACE_ITEM: Omit<BarItem, "id"> = {
  label: "Space",
  icon: SquareIcon,
  hint: "A fixed gap, for holding two groups apart without pushing either to an edge. Use two for a wider one.",
};

/**
 * What a bar nobody has configured shows.
 *
 * The arrangement the bar shipped with: the plan on the left, service state on
 * the right. Integration health and recording are opt-in rather than added to
 * everyone's bar without asking.
 */
export const DEFAULT_BAR_ORDER: BarRowId[] = ["plan", BAR_SPACER, "current-item", "live-timer"];

/**
 * Where the spacer goes in a bar saved before spacers existed.
 *
 * The side used to be INFERRED at render time: the first of these present, and
 * everything after it, was pushed right. The rule is gone from rendering — it
 * survives here only to place a spacer where an existing bar already had its
 * cut, so no install's bar moves when it upgrades.
 *
 * Do not add to this. A new item's position is wherever the operator drags it.
 */
const LEGACY_RIGHT: ReadonlySet<string> = new Set([
  "live-timer",
  "current-item",
  "integration-health",
  "recording",
]);

/** Put a spacer where the inferred rule used to cut. No service-state item means
 *  the old bar packed everything left, so the spacer goes on the end. */
function withLegacySpacer(rows: readonly BarRowId[]): BarRowId[] {
  const at = rows.findIndex((id) => LEGACY_RIGHT.has(id));
  const cut = at === -1 ? rows.length : at;
  return [...rows.slice(0, cut), BAR_SPACER, ...rows.slice(cut)];
}

/** Adjacent FLEXIBLE spacers collapse: two in a row split the slack between two
 *  points that are the same point, so the second only pads the saved order.
 *
 *  Fixed gaps are left alone — two of them in a row is a wider gap, which is
 *  the only way to ask for one. */
function collapseSpacers(rows: readonly BarRowId[]): BarRowId[] {
  return rows.filter((id, i) => id !== BAR_SPACER || rows[i - 1] !== BAR_SPACER);
}

/**
 * Valid rows from a saved config, in the saved order.
 *
 * Unknown ids are SKIPPED rather than rendered blank: a downgrade, or an
 * integration removed, can leave a saved order naming something this build does
 * not have, and a hole in the bar is worse than a shorter bar.
 *
 * An empty or entirely-unknown result falls back to the default, because a bar
 * that renders nothing reads as broken rather than as configured.
 *
 * A saved order with NO spacer predates them, and gets one where the old rule
 * cut. That inference is safe only because `normalizeBarRows` — which is what
 * the configurator saves through — always writes at least one: an operator who
 * wants everything hard left gets a trailing spacer, which looks identical and
 * keeps "no spacer" meaning "not yet migrated" for good.
 */
export function visibleBarItems(saved: readonly string[] | undefined): BarRowId[] {
  const rows = (saved ?? []).flatMap((id): BarRowId[] => {
    if (id === BAR_SPACER || id === LEGACY_SPACER) return [BAR_SPACER];
    if (id === BAR_SPACE) return [BAR_SPACE];
    return id in BAR_ITEMS ? [id as BarItemId] : [];
  });
  // Gaps are not readings. A bar of nothing but spacing is an empty bar.
  if (!rows.some((id) => !isBarGap(id))) return DEFAULT_BAR_ORDER;
  if (!rows.includes(BAR_SPACER)) return withLegacySpacer(rows);
  return collapseSpacers(rows);
}

/**
 * What the configurator saves.
 *
 * Collapses adjacent spacers, and guarantees at least one — see
 * `visibleBarItems` for why that last part is load-bearing rather than tidiness.
 */
export function normalizeBarRows(rows: readonly BarRowId[]): BarRowId[] {
  const out = collapseSpacers(rows);
  return out.includes(BAR_SPACER) ? out : [...out, BAR_SPACER];
}
