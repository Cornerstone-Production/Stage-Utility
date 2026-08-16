import type { LayoutObjectType } from "@main/types/views";

/**
 * The object types that render through the shared Readout.
 *
 * Its own module so it can be asserted on without importing the renderer, which
 * drags in React and every integration hook. The guard that used to name
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
