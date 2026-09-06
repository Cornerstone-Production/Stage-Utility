// service-pacing.ts — the Service pacing widget's drift math, extracted so
// History can share it and so an operator's pacing reset (pacingResetAt) has one
// implementation instead of a second copy drifting in from the widget.
//
// `ServiceTimeline` is ambient — see renderer/types.d.ts.

/**
 * Live cumulative drift: how far ahead/behind the whole schedule is right NOW.
 *
 * actualElapsed (wall-clock since the counted baseline) minus the planned
 * position (sum of planned lengths of finished counted items + the live item's
 * elapsed, capped at its planned length). Result carries slippage forward from
 * earlier items and only grows "behind" once the current item runs past its
 * plan. Negative = ahead, positive = behind. `null` when there is no honest
 * answer (no recording, or no live item to anchor the baseline).
 *
 * Reproduces the widget's original math exactly when `tl.pacingResetAt` is
 * null (see service-pacing.test.ts's byte-identical fixture) — this file only
 * adds the reset rule on top of it:
 *
 *   - an item that started before the reset does not count toward pacing, same
 *     as if it were excluded by the counted filter
 *   - an item still LIVE at reset time is kept (that is the point of
 *     resetting mid-item), but its elapsed is measured from the reset instant
 *     rather than its own start
 *   - the baseline start moves forward to the reset instant when the first
 *     remaining item began before it
 */
export function servicePacing(tl: ServiceTimeline | null, serverNowMs: number): { deltaSec: number | null } {
  if (!tl) return { deltaSec: null };

  const resetMs = tl.pacingResetAt ? Date.parse(tl.pacingResetAt) : NaN;
  const hasReset = Number.isFinite(resetMs);

  // Counted items only — exclude pre-service/buffer padding (a per-item
  // override wins, else default to not-pre-service), mirroring History.
  const items = tl.items.filter((it) => (typeof it.counted === "boolean" ? it.counted : !(it.preService ?? false)));

  // The reset rule: an item that had already ENDED before the reset no longer
  // counts. The currently live item is never dropped this way — only its
  // elapsed start is clamped forward, below — because resetting mid-item is
  // exactly how an operator stops a long-running item from dragging pacing.
  const scoped = hasReset ? items.filter((it) => it.endedAt == null || Date.parse(it.startedAt) >= resetMs) : items;

  const firstStartMs = scoped[0]?.startedAt ? Date.parse(scoped[0].startedAt) : NaN;
  const startMs = Number.isFinite(firstStartMs) ? (hasReset ? Math.max(firstStartMs, resetMs) : firstStartMs) : NaN;

  let plannedElapsed = 0;
  let live: { startedAt: string; plannedLengthSec: number | null } | null = null;
  for (const it of scoped) {
    // Finished items add their planned length; an item PCO gave no planned
    // time falls back to its actual so it reads neutral (not "behind").
    if (it.endedAt != null) plannedElapsed += it.plannedLengthSec ?? it.actualDurationSec ?? 0;
    else if (it.startedAt) live = it;
  }

  if (!live || !Number.isFinite(startMs)) return { deltaSec: null };

  const liveStartMs = Date.parse(live.startedAt);
  const liveBaselineMs = hasReset ? Math.max(liveStartMs, resetMs) : liveStartMs;
  const liveElapsed = Math.max(0, (serverNowMs - liveBaselineMs) / 1000);
  const livePlanned = live.plannedLengthSec ?? liveElapsed;
  plannedElapsed += Math.min(liveElapsed, livePlanned);

  return { deltaSec: (serverNowMs - startMs) / 1000 - plannedElapsed };
}
