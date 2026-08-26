import type { LayoutObjectType, LayoutHAlign } from "./views.js";

/**
 * The object types that render through the shared Readout.
 *
 * In main/types beside the capability record rather than in the renderer: the
 * load-time migration that strips never-chosen alignment needs the same set, and
 * one definition two consumers share cannot drift the way two copies would.
 *
 * Also means it can be asserted on without importing the renderer, which drags
 * in React and every integration hook. The guard that used to name
 * `StatusDot` and `RecordingFill` in a regex now checks membership here — a set
 * the renderer actually branches on, rather than words in a file.
 *
 * Two jobs:
 *
 *  1. A type in here owns its own caption, because Readout draws it as the first
 *     line of the composition. ObjectContent must not ALSO wrap it in the older
 *     Captioned, which would render the caption twice.
 *  2. It is the record of what has moved, so what has not is visible.
 */
export const IDIOM_TYPES = new Set<LayoutObjectType>([
  "clock",
  "countdown-timer",
  "service-pacing",
  "pp-timer",
  "slide-progress",
  "section-chip",
  "people-counter",
  "record-status",
  "obs-status",
  "reaper-status",
  "integration-status",
  "wireless-summary",
  "wireless-channel",
  "spl-meter",
  "baptism-timer",
]);

/**
 * Readouts that are deliberately NOT in the set, and why.
 *
 * `charger-battery` renders one row per bay and `people-panel` a grid of metric
 * tiles. Both are LISTS, not single readouts — squeezing either into
 * caption/value/sub would mean picking one row and dropping the rest, which is a
 * feature removal wearing a restyle's clothes. They keep their own layout; what
 * they should eventually take from the idiom is its type treatment, which is a
 * separate change from this one.
 *
 * `people-graph`, `slots-grid`, `service-order`, `transcript-strip`, the notes
 * and checklist objects, the buttons and the media objects are not readouts at
 * all.
 */


/**
 * How a readout aligns, when nothing has said otherwise.
 *
 * LEFT. Three stacked lines of different sizes only read as one object when they
 * share an edge; centred, they read as three things that happen to be near each
 * other. It is the composition Home's cards use and the reason the idiom looks
 * the way it does.
 *
 * A default, though — not a rule. `textAlign` still governs, so a custom view
 * can centre a particular widget. Task 9 first hard-coded left into the
 * composition, which quietly broke that control everywhere.
 */
export const DEFAULT_READOUT_ALIGN: LayoutHAlign = "left";

/*
 * There was an `isNeverChosenAlign` here, and it is deliberately gone.
 *
 * The object registry used to write `textAlign: "center"` into every object it
 * created, so a load-time pass stripped it to make DEFAULT_READOUT_ALIGN mean
 * something. The trouble is that the file cannot tell the two apart: a centre
 * the registry wrote and a centre the operator picked in the inspector are the
 * same three characters. So the pass deleted the operator's choice on every
 * restart — that is, on every update — and it was reported exactly that way.
 *
 * The registry no longer writes it (see defaultStyle in layout-objects.ts), so
 * nothing new acquires one. An old layout keeps whatever it has, which renders
 * the way it always rendered, and the operator can change it. Leaving a stale
 * default alone is a smaller cost than deleting a decision, every time.
 */


/**
 * The translucent card grounds every object created before Phase 7 carries,
 * mapped to the opaque value that replaces each.
 *
 * Same shape as the never-chosen alignment above: the object registry wrote
 * these into every object at creation, so they are a default nobody picked. A
 * card at 4% white does not occlude — put a status widget over a transcript and
 * the text reads straight through, which looks exactly like the widget being
 * drawn underneath. Paint order was verified correct while that was happening.
 *
 * Each opaque value is the exact blend of the translucent one over the kiosk
 * black, so a card looks unchanged on a bare canvas and now covers what is
 * behind it. Lives here rather than in the renderer's registry so the load-time
 * migration can share the one definition.
 */
export const LEGACY_TRANSLUCENT_GROUNDS: Readonly<Record<string, string>> = {
  "rgba(255,255,255,0.04)": "#141414",
  "rgba(45,212,150,0.08)": "#0d1a15",
  "rgba(229,72,77,0.10)": "#201011",
  "rgba(255,197,61,0.08)": "#1e190e",
  // The "Elevated" surface look, which carried its own translucent ground.
  "rgba(255,255,255,0.06)": "#191919",
};

/** The opaque ground that replaces a never-chosen translucent one, or null when
 *  the background is anything else — including one the operator chose. */
export function opaqueGroundFor(background: string | null | undefined): string | null {
  if (!background) return null;
  return LEGACY_TRANSLUCENT_GROUNDS[background.replace(/\s+/g, "")] ?? null;
}
