// trends-card.tsx — the Baptisms tab's Trends card: four tiles over the last
// TREND_WINDOW sessions against the TREND_WINDOW before, so a planner can
// answer "how long do baptisms take" from history instead of guessing off one
// Sunday. See trends.ts for the arithmetic and for why
// COMPARABLE_ABOVE/TrendMeasure do not carry over from history-trends.
//
// NAMED trends-card.tsx, not trends.tsx, deliberately matching
// history-trends/trends-card.tsx beside history-trends/trends.ts: a renderer
// import resolves an extensionless specifier before trying ".tsx", so a
// trends.tsx living next to this file's trends.ts made every `from "./trends"`
// resolve to the arithmetic module and drop this component silently. Proven
// while writing this file's own test, not guessed — `./trends.js` resolved to
// trends.ts's exports, missing TrendsCard entirely, until the rename.
//
// Sparkline and TREND_WINDOW are History's own, reused as-is rather than a
// second copy. pctChange/pctLabel (History's OWN trends-card.tsx, a sibling
// module of the same name one directory over) are reused for the one tile
// that IS a percentage comparison — Baptized per service, where "more" is the
// same kind of good news History's own Attendance tile colours green. The
// other three tiles compare an absolute clock delta and are never coloured
// good or bad: there is no agreed "right direction" for a testimony, a baptism
// or a whole segment getting longer or shorter, unlike a count of people.
//
// The mockup's own Trends section is static illustrative markup — the numbers
// on it are hand-typed, never computed by its script — so this reads it for
// STRUCTURE (four tiles, a sparkline, a headline, a change figure, a short
// caption) rather than for its exact sample figures, and drops its per-tile
// captions' editorial claims about the data ("...steady") that this component
// has no way to know are true.
//
// NOT unit-tested: whether a tile's caption or change figure actually FITS
// without wrapping at a narrow width — jsdom lays nothing out. What IS tested,
// in trends-card.test.tsx: baptismTrendPoint's reduction from a session, and
// fmtClockDelta's formatting at both sides of the one-minute boundary.

import { cn } from "../../../lib/cn";
import { baptismStats } from "../../../lib/link-baptisms";
import { fmtClock } from "../../../main/use-baptism-state";
import { Sparkline } from "../history-trends/sparkline";
import { TREND_WINDOW } from "../history-trends/trends";
import { pctChange, pctLabel, noPriorCaption } from "../history-trends/trends-card";
import { baptismTrends, type BaptismTrendPoint, type BaptismTrendTile } from "./trends";

/** "+4s" · "−3s" · "+5:02" · "0s" — a duration CHANGE, signed and compact
 *  under a minute rather than always "0:04". The three duration tiles compare
 *  this instead of a percentage — see the module comment. */
export function fmtClockDelta(ms: number): string {
  const rounded = Math.round(ms);
  if (rounded === 0) return "0s";
  const sign = rounded > 0 ? "+" : "−";
  const abs = Math.abs(rounded);
  return abs < 60_000 ? `${sign}${Math.round(abs / 1000)}s` : `${sign}${fmtClock(abs)}`;
}

/**
 * A finished session, reduced to one BaptismTrendPoint — or null when its
 * start time will not parse, the same defensiveness trendClock's own callers
 * apply rather than plotting a point at NaN. Exported for its own test: the
 * arithmetic in trends.ts is only as honest as what feeds it.
 *
 * Also null when NOBODY was baptized (final review, Important 3): an ordinary
 * Finish during the testimonies, a Finish while armed, or a test run finished
 * instead of reset all log a real session with a real wall clock and nothing
 * baptized. Counted in, each fed `avgBaptismSec: 0` and its own short wall
 * clock into every tile's average — measured against three real sessions plus
 * one such session, "Avg baptism" moved from 45s to 33.75s and "Whole
 * segment" from 25 to 19.25 minutes. A session that baptized nobody is left
 * out of the trend entirely, not folded in at zero: TrendsCard's four tiles
 * all read off this ONE point per session, so excluding it here is what keeps
 * every tile — not just "Baptized per service" — honest about the same set
 * of real sessions.
 */
export function baptismTrendPoint(s: BaptismSession): BaptismTrendPoint | null {
  const t = Date.parse(s.startedAt);
  if (!Number.isFinite(t)) return null;
  const finish = Date.parse(s.finishedAt);
  const stats = baptismStats([s]);
  if (stats.people === 0) return null;
  return {
    t,
    baptized: stats.people,
    avgTestimonySec: stats.avgTestimonySec,
    avgBaptismSec: stats.avgBaptismSec,
    wholeSegmentSec: Number.isFinite(finish) ? Math.max(0, (finish - t) / 1000) : 0,
  };
}

export interface TrendsCardProps {
  sessions: readonly BaptismSession[];
  /** The sessions list failed to load — the same guard Past sessions applies
   *  to the identical fetch, so a network blip cannot read as "no history". */
  loadError?: boolean;
}

/** One tile's change, already decided and coloured — or null when there is
 *  nothing to compare against, or nothing sensible to divide by (a percentage
 *  tile whose prior average rounds to zero or less). */
interface TrendChange {
  text: string;
  tone: "ok" | "danger" | "muted";
}

export function TrendsCard({ sessions, loadError = false }: TrendsCardProps) {
  const points = sessions.map(baptismTrendPoint).filter((p): p is BaptismTrendPoint => p != null);
  const trends = baptismTrends(points);

  return (
    <section id="s-trends" className="su-card flex flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="text-body font-semibold text-fg">Trends</h2>
        <span className="flex-1" />
        <span className="text-caption1 text-fg-subtle">last {TREND_WINDOW} baptism services</span>
      </div>
      <div className="p-4">
        {loadError ? (
          <p role="alert" className="text-caption1 text-danger-11">
            Trends could not be loaded — see the server log.
          </p>
        ) : points.length === 0 ? (
          <p className="text-caption1 text-fg-muted">No baptism sessions recorded yet.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile
              label="Baptized per service"
              tile={trends.baptized}
              color="var(--color-accent)"
              caption="avg per service, this window"
              fmtValue={(v) => v.toFixed(1)}
              change={(latest, prior) => {
                const pct = pctChange(latest, prior, 1);
                return pct == null ? null : { text: pctLabel(pct, 0), tone: pct >= 0 ? "ok" : "danger" };
              }}
            />
            <Tile
              label="Avg testimony"
              tile={trends.avgTestimonySec}
              color="var(--color-accent)"
              caption="how long people talk"
              fmtValue={(v) => fmtClock(v * 1000)}
              change={(latest, prior) => ({ text: fmtClockDelta((latest - prior) * 1000), tone: "muted" })}
            />
            <Tile
              label="Avg baptism"
              tile={trends.avgBaptismSec}
              color="var(--color-live-9)"
              caption="per person, press to press"
              fmtValue={(v) => fmtClock(v * 1000)}
              change={(latest, prior) => ({ text: fmtClockDelta((latest - prior) * 1000), tone: "muted" })}
            />
            <Tile
              label="Whole segment"
              tile={trends.wholeSegmentSec}
              color="var(--color-accent)"
              caption="what to budget on the plan"
              fmtValue={(v) => fmtClock(v * 1000)}
              change={(latest, prior) => ({ text: fmtClockDelta((latest - prior) * 1000), tone: "muted" })}
            />
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * What the change slot says when there is no change figure — two different
 * facts that used to share one caption ("no prior window yet"):
 *
 * - no prior window exists at all (tile.prior is null, below MIN_PRIOR_DAYS)
 * - a full prior window exists but averaged (rounds to) zero, so a percentage
 *   change has no basis to divide by (see pctChange) — reachable today only
 *   by "Baptized per service", the one tile that IS a percentage.
 *
 * The prior-vs-zero decision itself is noPriorCaption, shared with
 * history-trends/trends-card.tsx's own tiles, which have the identical
 * ambiguity behind a different "no latest value at all" fallback.
 */
function noChangeCaption(tile: BaptismTrendTile): string {
  if (tile.latest == null) return "—";
  return noPriorCaption(tile.prior != null);
}

function Tile({
  label,
  tile,
  color,
  caption,
  fmtValue,
  change,
}: {
  label: string;
  tile: BaptismTrendTile;
  color: string;
  caption: string;
  fmtValue: (v: number) => string;
  change: (latest: number, prior: number) => TrendChange | null;
}) {
  const delta = tile.latest != null && tile.prior != null ? change(tile.latest, tile.prior) : null;
  return (
    <div data-trend-tile={label} className="flex flex-col gap-1.5 rounded-lg border border-line bg-fill/40 px-3 py-2.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">{label}</span>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span data-trend-value className="font-mono text-[26px] font-semibold leading-none tabular-nums text-fg">
          {tile.latest == null ? "—" : fmtValue(tile.latest)}
        </span>
        <span
          data-trend-change
          className={cn(
            "text-caption1",
            delta == null
              ? "text-fg-subtle"
              : delta.tone === "ok"
                ? "text-ok-11"
                : delta.tone === "danger"
                  ? "text-danger-11"
                  : "text-fg-subtle",
          )}
        >
          {delta ? delta.text : noChangeCaption(tile)}
        </span>
      </div>
      <Sparkline
        values={tile.recent}
        label={`${label}, the last ${tile.recent.length} service${tile.recent.length === 1 ? "" : "s"}`}
        color={color}
        width={140}
        height={32}
      />
      <span className="text-caption2 text-fg-subtle">{caption}</span>
    </div>
  );
}
