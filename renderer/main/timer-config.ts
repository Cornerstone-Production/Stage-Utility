// timer-config.ts — what a saved layout object reads as, for the Timer.
//
// The Timer replaced four widgets: `countdown-timer` ("PCO countdown"),
// `home-live-status` ("Service timer"), `pp-timer` ("ProPresenter timer") and
// `baptism-timer`. Saved layouts still hold all four, and always will — views.json
// is a config store, so every snapshot restore, template, saved group and imported
// view file can hand one back.
//
// So the conversion is a READ-TIME mapping, the same reasoning as
// pvp-now-config.ts: a migration in any one store would miss the others, and
// reading the old shape here covers every path an object reaches a screen by.
// Nothing is rewritten; the file keeps the old type until the operator next edits
// the object, and the editor writes `timer` from then on.
//
// No React, no DOM, no registry import (the registry imports this file).
//
// "Looks exactly as it did" is the contract of every mapping below, and it is
// why the converted configs state settings that a NEW Timer would leave to its
// defaults: an old object that never expressed a preference meant the old
// default, which is not always the Timer's.

import type { BaptismTimerField, LayoutObject, LayoutObjectConfig, TimerSource } from "@main/types/views";

export type TimerConfig = Extract<LayoutObjectConfig, { type: "timer" }>;

/**
 * The four types that read as a Timer. A sorted list, one per line: it is also
 * the exact set the render-parity and registry guards expect to have no
 * renderer arm of their own.
 */
export const LEGACY_TIMER_TYPES = [
  "baptism-timer",
  "countdown-timer",
  "home-live-status",
  "pp-timer",
] as const;
export type LegacyTimerType = (typeof LEGACY_TIMER_TYPES)[number];

/** A config as the renderer's switch sees it once the mapping has run: none of
 *  the four, so the type checker proves nothing draws one outside the mapping. */
export type ReadConfig = Exclude<LayoutObjectConfig, { type: LegacyTimerType }>;

/**
 * What differs between the three sources, declared once: the inspector, Home's
 * card menu and the caption rules all read this instead of each testing
 * `source === ...` themselves.
 */
export const TIMER_SOURCE_INFO: Record<
  TimerSource,
  {
    label: string;
    /** The caption a NEW Timer of this source is created with, and the one a
     *  source switch swaps in while the old source's default is still there.
     *  `undefined` is no key at all: the service draws the live item's name. */
    caption: string | undefined;
    /** The wording of the sub-line switch. */
    subSwitch: string;
    /** Ends, so it can go amber near the end and red once over. */
    warns: boolean;
    /** Has a next item to show under the time. */
    nextItem: boolean;
  }
> = {
  service: { label: "Service", caption: undefined, subSwitch: "Show the sub-line", warns: true, nextItem: true },
  propresenter: { label: "ProPresenter", caption: "Stage timer", subSwitch: "Show the timer\u2019s name", warns: true, nextItem: false },
  baptism: { label: "Baptism", caption: "Baptisms", subSwitch: "Show the label", warns: false, nextItem: false },
};

export const TIMER_SOURCES = (Object.keys(TIMER_SOURCE_INFO) as TimerSource[]).map((value) => ({
  value,
  label: TIMER_SOURCE_INFO[value].label,
}));

/** The baptism readouts in the order the inspector lists them, with the words
 *  it uses for them. One list so the picker and the tests cannot differ. */
export const BAPTISM_FIELD_OPTIONS: { value: BaptismTimerField; label: string }[] = [
  { value: "live", label: "The running clock" },
  { value: "testimony", label: "Testimony time" },
  { value: "session", label: "Session time" },
  { value: "average", label: "Average per person" },
  { value: "last", label: "Last person" },
  { value: "phase", label: "Phase" },
  { value: "person", label: "Person (3 of 7)" },
  { value: "count", label: "Count" },
  { value: "total", label: "Total" },
];

/**
 * The Timer with another source chosen. The caption follows the source while it
 * is still the old source's own default; one the operator typed (or cleared)
 * stays. Every other setting is carried, so flipping back loses nothing.
 */
export function withTimerSource(c: TimerConfig, source: TimerSource): TimerConfig {
  const wasDefault = c.caption === TIMER_SOURCE_INFO[timerSource(c)].caption;
  const next: TimerConfig = { ...c, source };
  if (wasDefault) {
    const caption = TIMER_SOURCE_INFO[source].caption;
    if (caption === undefined) delete next.caption;
    else next.caption = caption;
  }
  return next;
}

/** A config with the keys whose value is `undefined` left out, so a converted
 *  object compares and serialises the same as one built by hand. */
function defined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * The Timer a config reads as: itself when it already is one, the equivalent for
 * each of the four retired types, and null for everything else.
 *
 * `caption` is the one setting worth reading twice. A Timer's unset caption is
 * its source's default, but three of the old widgets drew NO caption when none
 * was stored — "absent on objects that already exist, so no layout anybody built
 * gains a caption it did not ask for" — so they convert to an explicit empty
 * string. `home-live-status` is the exception: it always drew the item's name.
 */
export function readTimerConfig(config: LayoutObjectConfig): TimerConfig | null {
  switch (config?.type) {
    case "timer":
      return config;
    case "countdown-timer":
      return defined({
        type: "timer" as const,
        source: "service" as const,
        nextItem: false,
        redOnOverrun: true,
        warnSeconds: config.warnSeconds,
        hideWhenIdle: config.hideWhenIdle,
        caption: config.caption ?? "",
      });
    case "home-live-status":
      return { type: "timer", source: "service", nextItem: true, redOnOverrun: true };
    case "pp-timer":
      return defined({
        type: "timer" as const,
        source: "propresenter" as const,
        redOnOverrun: config.warnStates ?? true,
        timerName: config.timerName,
        propresenterInstanceId: config.propresenterInstanceId,
        hideWhenIdle: config.hideWhenIdle,
        showLabel: config.showLabel ?? true,
        caption: config.caption ?? "",
      });
    case "baptism-timer":
      return defined({
        type: "timer" as const,
        source: "baptism" as const,
        field: config.field,
        // The old readout drew `label ?? the word`, and an EMPTY label is not
        // nullish — so a widget whose label was "" (which is what the registry
        // wrote) drew no sub-line at all although its switch was on. The Timer
        // reads an empty label as "use the word", so the object that drew
        // nothing converts to Show label off rather than gaining a line.
        showLabel: config.showLabel === true && config.label !== "",
        label: config.label,
        caption: config.caption ?? "",
      });
    default:
      return null;
  }
}

/** Where a Timer reads from: its `source`, which absent reads as the service. */
export function timerSource(config: Pick<TimerConfig, "source">): TimerSource {
  return config.source ?? "service";
}

/** The config the renderer's switch reads: the Timer for the four, else itself. */
export function readConfig(config: LayoutObjectConfig): ReadConfig {
  return (readTimerConfig(config) ?? config) as ReadConfig;
}

/**
 * Where a retired Home card sat. A card's size and visibility fall back to its
 * TYPE's registry default when it stores none, and a converted card has a new
 * type, so a card that never stored either would move to the Timer's default
 * tile the moment it was edited. Pinned here at the point the object is written.
 * Held equal to the registry by timer-config.test.ts.
 */
export const LEGACY_HOME: Partial<Record<LegacyTimerType, NonNullable<LayoutObject["home"]>>> = {
  "baptism-timer": { size: "s", when: "live" },
  "home-live-status": { size: "xl", when: "live" },
  "pp-timer": { size: "s", when: "live" },
};

/**
 * The object with its config read as a Timer, for a caller about to WRITE it
 * (an inspector edit, a Home card toggle). `onHome` says it is a Home card, which
 * is what pins the retired card's tile. Returns the object itself when it is not
 * one of the four, so a caller can compare by reference.
 */
export function readTimerObject(o: LayoutObject, onHome = false): LayoutObject {
  const timer = o.config?.type === "timer" ? null : readTimerConfig(o.config);
  if (!timer) return o;
  // Only on Home does a missing `home` mean "the type's default tile": a wall
  // object has none, and gaining one would put a Home tile on a wall layout.
  const pin = onHome ? LEGACY_HOME[o.config.type as LegacyTimerType] : undefined;
  const home = pin ? { ...pin, ...o.home } : o.home;
  return { ...o, config: timer, ...(home ? { home } : {}) };
}

/**
 * The type a config is shown as in the object list, the inspector header and a
 * Home card's menu: a retired timer opens as a Timer, so it is named as one.
 */
export function displayType(config: LayoutObjectConfig): LayoutObjectConfig["type"] {
  return readTimerConfig(config)?.type ?? config.type;
}
