import { Fragment, useEffect, useMemo, useState } from "react";

import { invoke } from "../../lib/api";
import { onNotification } from "../../lib/api";
import { toast } from "../../components/ui";
import { errorMessage } from "@main/services/errors";
import { combineLeq } from "@main/services/spl-leq";
import {
  CustomizePopover,
  HistoryChart,
  hasStoredChoice,
  seedStoredKeys,
  serviceWindowOf,
  useStoredKeys,
  type ChartPoint,
  type ChartSeries,
  type LaneItem,
} from "./history-chart";

/** Per-metric stat for an item, with legacy single-metric fallback. */
function metricStat(item: SplItemHistory, key: string, record: ServiceSplHistory): SplMetricStat | null {
  const m = item.metrics?.[key];
  if (m) return m;
  // Legacy records stored a single metric under record.metricKey. Their stored mean
  // was an arithmetic average of decibels, which understates a dynamic item by up to
  // 15 dB, so it is deliberately not carried over as a level — those rows show no Leq.
  if (record.metricKey === key) {
    return { max: item.maxSpl, avg: null, leq: item.leqSpl ?? null, count: item.sampleCount };
  }
  return null;
}

/** When the user hasn't chosen, show a sensible default: an SPL metric + an LAeq metric. */
function defaultVisible(keys: string[]): string[] {
  const out: string[] = [];
  const spl = keys.find((k) => /spl/i.test(k));
  const laeq = keys.find((k) => /laeq/i.test(k));
  if (spl) out.push(spl);
  if (laeq && laeq !== spl) out.push(laeq);
  return out.length ? out : keys.slice(0, 2);
}

function dB(v: number | null): string {
  return v == null ? "—" : `${Math.round(v)} dB`;
}

/** Which at-rest figures the sound strip shows. Its own localStorage entry: the
 *  metric LIST is an operator-level setting kept on the server (it decides what
 *  is recorded into view across every browser), while which figures one person
 *  wants in their strip is a view preference, like attendance's. */
const SOUND_FIGURES = [
  { key: "peak", label: "Peak" },
  { key: "loudest", label: "Loudest item" },
  { key: "message", label: "Message Leq" },
  { key: "service", label: "Service Leq" },
  { key: "items", label: "Items" },
] as const;
const FIGURE_KEYS = SOUND_FIGURES.map((f) => f.key);
const FIGURES_STORAGE_KEY = "spl:visibleFigures";
const DEFAULT_FIGURES = ["peak", "loudest", "message"];

/** The two lines the real sample series draws. Their own per-browser entry,
 *  beside the figures, for the same reason: which of the two a person wants on
 *  screen is a view preference, not a recording setting. */
const SOUND_SERIES = [
  { key: "max", label: "Peak" },
  { key: "avg", label: "Average" },
] as const;
const SERIES_KEYS = SOUND_SERIES.map((s) => s.key);
const SERIES_STORAGE_KEY = "spl:visibleSeries";
const DEFAULT_SERIES = ["max", "avg"];

/**
 * Which Smaart metrics this browser surfaces — the table's columns, the
 * fallback chart's lines, and which one is the primary the peak marks and the
 * strip's figures read.
 *
 * PER BROWSER, like every other preference in this module. It used to be
 * `settingsStore.splVisibleMetrics`, server-wide, so one person clicking a
 * legend entry changed what everybody saw — and worse, an empty server list is
 * indistinguishable from "never chosen", so unticking the last metric sprang
 * both defaults back.
 *
 * The server setting is NOT deleted: it is read once to seed this entry
 * (`seedStoredKeys`), so an operator's existing selection survives the move.
 * Nothing writes it any more. It stays in settings rather than being removed —
 * it is the operator's own choice, and deleting an operator's data to tidy
 * something up is not a thing this repo does. Re-exposing it as an
 * organisation-wide default belongs with a control in the Integrations panel,
 * which is new UI and not this change.
 */
const SPL_METRICS_STORAGE_KEY = "spl:visibleMetrics";

/** How often the chart re-reads the series while the record is still open. The
 *  recorder appends to spl.csv continuously; ten seconds is two ticks of the
 *  meter and a cheap read of one file. */
const LIVE_POLL_MS = 10_000;

/** The bucket width asked for. The server widens it for a long service. */
const BUCKET_SEC = 5;

/** The item a church service's level is usually asked about. Matched on the
 *  title because PCO's item_type does not distinguish a sermon from any other
 *  non-song item, and every plan here names it one of these. */
const MESSAGE_TITLE = /\b(message|sermon|teaching|preach)/i;

/** One bucket of the raw series — see main/services/spl-series.ts. */
interface SplBucket {
  t: number;
  max: number;
  avg: number;
}
interface SplSeriesResponse {
  metric: string;
  metrics: string[];
  bucketSec: number;
  buckets: SplBucket[];
}

/**
 * SPL History — browse past services and their recorded levels. Every Smaart
 * metric is recorded; the operator chooses which to surface here.
 *
 * WHAT THE LINE IS. The chart reads the RAW samples through
 * `GET /api/spl/history/:key/series`, which buckets `spl.csv` — a reading per
 * second — into a few hundred points and gives each bucket its loudest reading
 * and its energy average. Those are the primary and the dashed secondary line.
 *
 * When that route answers 404 the service has no raw rows at all: a record from
 * before the raw layer existed, or one whose archive was pruned. Only then does
 * the chart fall back to a per-item STEP, each item's Leq held flat across the
 * time it ran, which is the honest drawing of the only thing left. The fallback
 * draws one run per item — consecutive items abut, so no gap rule separates
 * them, and one item's level is not a slope into the next one's.
 */
export function SplDetail({
  detail,
  timeline,
  attendance,
}: {
  detail: ServiceSplHistory;
  timeline?: ServiceTimeline | null;
  attendance?: ServiceAttendance | null;
}) {
  const [figureKeys, storeFigure] = useStoredKeys(FIGURES_STORAGE_KEY, FIGURE_KEYS, DEFAULT_FIGURES);
  function toggleFigure(key: string) {
    const err = storeFigure(key);
    if (err) toast.error(`Could not remember that choice: ${errorMessage(err)}`);
  }
  const [seriesKeys, storeSeries] = useStoredKeys(SERIES_STORAGE_KEY, SERIES_KEYS, DEFAULT_SERIES);
  function toggleSeries(key: string) {
    const err = storeSeries(key);
    if (err) toast.error(`Could not remember that choice: ${errorMessage(err)}`);
  }

  const allKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const it of detail.items) if (it.metrics) for (const k of Object.keys(it.metrics)) keys.add(k);
    if (detail.metricKey) keys.add(detail.metricKey);
    return Array.from(keys).sort();
  }, [detail]);


  /**
   * The metrics this browser shows.
   *
   * `null` for the allow-list: the metrics one service carries are not the ones
   * another does, and filtering against the record on screen would drop every
   * metric the CURRENT service happens not to have the next time the choice was
   * written. The per-record filter happens below, on the way to the screen.
   *
   * The fallback is this record's own default pair, so a browser that has never
   * chosen gets something sensible — and an operator who has unticked every
   * metric keeps an EMPTY list, which is a real choice and not a request for the
   * defaults back. `readStoredKeys` draws exactly that line.
   */
  const [storedMetrics, storeMetric, reloadMetrics] = useStoredKeys(
    SPL_METRICS_STORAGE_KEY,
    null,
    defaultVisible(allKeys),
  );
  const shownMetrics = useMemo(
    () => storedMetrics.filter((k) => allKeys.includes(k)),
    [storedMetrics, allKeys],
  );
  /** No metric chosen at all, as opposed to a record that recorded none. */
  const noneChosen = storedMetrics.length === 0;

  // Take the server's list over, once, for a browser that has never chosen.
  // Before the first render, so the hook below reads the seeded value rather
  // than the defaults for one frame.
  const [seeded, setSeeded] = useState(() => hasStoredChoice(SPL_METRICS_STORAGE_KEY));
  useEffect(() => {
    if (seeded) return;
    let cancelled = false;
    invoke<{ metrics: string[] }>("spl:getVisibleMetrics")
      .then((r) => {
        if (cancelled) return;
        // An EMPTY server list means nobody ever chose there either — leave this
        // browser with no stored choice so it takes the per-record defaults,
        // rather than freezing "show nothing" into it.
        if (r.metrics?.length) {
          seedStoredKeys(SPL_METRICS_STORAGE_KEY, r.metrics);
          // The hook read the store before this landed, so it is holding the
          // defaults. Without this re-read the seeded selection does not appear
          // until the page is opened again.
          reloadMetrics();
        }
        setSeeded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setSeeded(true);
        toast.error(`Could not read the saved Smaart metrics: ${errorMessage(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [seeded, reloadMetrics]);

  function toggleMetric(key: string) {
    const err = storeMetric(key);
    if (err) toast.error(`Could not remember that choice: ${errorMessage(err)}`);
  }

  const items = useMemo(() => detail.items.slice().sort((a, b) => a.sequence - b.sequence), [detail]);
  const preById = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const it of timeline?.items ?? []) m.set(it.itemId, it.preService ?? false);
    return m;
  }, [timeline]);

  const primaryKey = shownMetrics[0] ?? null;
  const live = detail.endedAt == null;

  // ── The raw series ──
  const [raw, setRaw] = useState<SplSeriesResponse | null>(null);
  /** null = not asked yet; true = the route said 404, so there are no raw rows. */
  const [noRaw, setNoRaw] = useState(false);
  useEffect(() => {
    if (!primaryKey) return;
    let cancelled = false;
    const load = () => {
      invoke<SplSeriesResponse>("spl:series", {
        serviceKey: detail.serviceKey,
        metric: primaryKey,
        bucketSec: BUCKET_SEC,
      })
        .then((r) => {
          if (cancelled) return;
          setRaw(r);
          setNoRaw(false);
        })
        .catch(() => {
          // A 404 is the expected answer for an old record and is not worth a
          // toast; it is what selects the per-item fallback below. Any other
          // failure lands here too and takes the same path, because the outcome
          // for the operator is identical: this service has no line, and the
          // step is drawn instead of an empty plot.
          if (!cancelled) setNoRaw(true);
        });
    };
    load();
    if (!live) return () => { cancelled = true; };
    // While the record is open the recorder keeps appending to spl.csv. Poll,
    // and also refetch the moment the record itself is broadcast, so a new item
    // shows up without waiting out the interval.
    const timer = setInterval(load, LIVE_POLL_MS);
    const off = onNotification("spl:history", (p) => {
      const rec = p as ServiceSplHistory | null;
      if (rec && rec.serviceKey === detail.serviceKey) load();
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      off();
    };
  }, [detail.serviceKey, primaryKey, live]);

  // Shape-checked, not just null-checked. The series route is the one thing on
  // this page that can answer with something other than what it promises — a
  // proxy's error page, an older server, a 200 from the wrong route — and a
  // section that throws on `undefined.length` takes the whole History tab down
  // with it. A malformed answer is treated exactly as no answer: the per-item
  // fallback draws.
  const buckets = raw && Array.isArray(raw.buckets) ? raw.buckets : null;
  const hasRaw = !noRaw && buckets != null && buckets.length > 0;

  const series: ChartSeries[] = hasRaw && raw
    ? [
      {
        id: "max",
        label: `${raw.metric} peak`,
        color: "var(--color-accent)",
        role: "primary",
        fill: true,
        on: seriesKeys.includes("max"),
        format: (v) => dB(v),
        points: buckets.map((b) => ({ t: b.t, v: b.max })),
      },
      {
        id: "avg",
        label: `${raw.metric} average`,
        color: "var(--color-fg-muted)",
        role: "secondary",
        dashed: true,
        on: seriesKeys.includes("avg"),
        format: (v) => dB(v),
        points: buckets.map((b) => ({ t: b.t, v: b.avg })),
      },
    ]
    // EVERY metric the record carries, each saying whether it is on — not just
    // the shown ones. A pre-filtered list leaves the legend unable to name a
    // metric the operator switched off, so it can never come back, which is the
    // one thing a toggle has to be able to do. Attendance has always done this.
    : allKeys.map((key, i) => {
      const runs = stepRuns(items, detail, key);
      const primary = key === primaryKey;
      return {
        id: key,
        label: key,
        color: primary ? "var(--color-accent)" : SECONDARY_COLORS[i % SECONDARY_COLORS.length],
        role: primary ? ("primary" as const) : ("secondary" as const),
        // NO FILL, unlike attendance. A fill runs to the axis floor, and a dB
        // axis has no floor that means anything — the band is chosen to frame
        // the data, so the fill's depth would say only where the axis starts.
        dashed: !primary,
        on: shownMetrics.includes(key),
        format: (v: number) => dB(v),
        runs,
        points: runs.flat(),
      };
    });

  const laneItems: LaneItem[] = items.map((it) => {
    const st = primaryKey ? metricStat(it, primaryKey, detail) : null;
    return {
      itemId: it.itemId,
      title: it.title,
      sequence: it.sequence,
      startedAt: it.startedAt,
      endedAt: it.endedAt,
      preService: preById.get(it.itemId) ?? false,
      plannedSec: null,
      actualSec: it.endedAt ? Math.round((Date.parse(it.endedAt) - Date.parse(it.startedAt)) / 1000) : null,
      peakLabel: st?.max != null ? dB(st.max) : null,
    };
  });

  const figures = noneChosen
    ? [{ key: "none", label: "Sound", value: "No metric selected" }]
    : SOUND_FIGURES.filter((f) => figureKeys.includes(f.key)).map((f) => ({
      key: f.key,
      label: f.key === "peak" && primaryKey ? `Peak ${primaryKey}` : f.label,
      value: figureValue(f.key, items, detail, primaryKey),
      color: f.key === "peak" ? "var(--color-accent)" : undefined,
    }));

  if (!items.length || allKeys.length === 0) {
    return <p className="text-caption1 text-fg-muted">No per-item SPL recorded for this service.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      <HistoryChart
        series={series}
        items={laneItems}
        window={serviceWindowOf({ timeline, attendance })}
        yScale={{ kind: "db" }}
        figures={figures}
        live={live}
        ariaLabel={
          hasRaw
            ? "Recorded sound level across the service"
            : "Recorded sound level per plan item across the service"
        }
        // An empty chart because nobody picked a metric is not an empty chart
        // because nothing was recorded, and the default sentence says the
        // second. The legend below still lists every metric, so the way out is
        // one click away.
        emptyNote={noneChosen ? "No metric selected — pick one in the legend or in Customize." : undefined}
        // The legend's meaning follows the mode, because the series do: with a
        // raw series it toggles peak and average, and on the per-item fallback
        // it toggles which Smaart metrics are drawn. Either way it is wired to
        // the SAME handler the matching Customize group uses.
        onToggleSeries={hasRaw ? toggleSeries : toggleMetric}
        customize={
          <CustomizePopover
            label="Customize sound"
            groups={[
              { id: "lines", label: "Chart", options: hasRaw ? SOUND_SERIES.map((s) => ({ ...s })) : [] },
              { id: "figures", label: "Figures", options: SOUND_FIGURES.map((f) => ({ ...f })) },
              { id: "metrics", label: "Smaart metrics", options: allKeys.map((k) => ({ key: k, label: k })) },
            ]}
            selected={[...(hasRaw ? seriesKeys : []), ...figureKeys, ...shownMetrics]}
            onToggle={(key) => {
              if (hasRaw && SERIES_KEYS.includes(key as (typeof SERIES_KEYS)[number])) return toggleSeries(key);
              if (FIGURE_KEYS.includes(key as (typeof FIGURE_KEYS)[number])) return toggleFigure(key);
              return toggleMetric(key);
            }}
          />
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-caption1">
          <thead className="text-fg-muted text-left border-b border-line">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Item</th>
              {shownMetrics.map((k) => (
                <th key={k} className="py-1.5 px-3 font-medium text-right whitespace-nowrap" colSpan={2}>
                  {k}
                </th>
              ))}
            </tr>
            <tr className="text-fg-subtle">
              <th />
              {shownMetrics.map((k) => (
                <Fragment key={k}>
                  <th className="py-1 px-3 font-normal text-right w-20">Max</th>
                  <th className="py-1 px-3 font-normal text-right w-20">Leq</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={`${it.itemId}:${it.sequence}`} className="border-b border-line">
                <td className="py-1.5 pr-3 text-fg whitespace-nowrap">{it.title || "Untitled"}</td>
                {shownMetrics.map((k) => {
                  const st = metricStat(it, k, detail);
                  return <FragmentCells key={k} max={st?.max ?? null} leq={st?.leq ?? null} />;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Colours for the second and later metrics on the per-item fallback.
 *  Neutral-to-warm, never purple. */
const SECONDARY_COLORS = ["var(--color-fg-muted)", "var(--color-warn-11)", "var(--color-info-11)"];

/**
 * The per-item fallback: one metric as a step, ONE RUN PER ITEM.
 *
 * A run per item, in the record's own item order, rather than one series sorted
 * by time. Items can OVERLAP — a recorder that reopened an item, or a service
 * whose occurrence split was missed — and a globally sorted edge list then walks
 * back and forth across the overlap and draws a W through it.
 *
 * An item with no reading for this metric contributes no run, so it leaves a
 * hole rather than a slope across it.
 */
export function stepRuns(items: SplItemHistory[], record: ServiceSplHistory, key: string): ChartPoint[][] {
  const runs: ChartPoint[][] = [];
  for (const it of items) {
    const st = metricStat(it, key, record);
    const v = st?.leq ?? st?.max ?? null;
    const t0 = Date.parse(it.startedAt);
    if (v == null || !Number.isFinite(t0)) continue;
    const t1 = it.endedAt ? Date.parse(it.endedAt) : NaN;
    runs.push(Number.isFinite(t1) && t1 > t0 ? [{ t: t0, v }, { t: t1, v }] : [{ t: t0, v }]);
  }
  return runs;
}

function figureValue(
  key: string,
  items: SplItemHistory[],
  record: ServiceSplHistory,
  primaryKey: string | null,
): string {
  if (!primaryKey) return "—";
  const stats = items.map((it) => ({ it, st: metricStat(it, primaryKey, record) }));
  switch (key) {
    case "peak": {
      const maxes = stats.map((s) => s.st?.max).filter((v): v is number => v != null);
      return maxes.length ? dB(Math.max(...maxes)) : "—";
    }
    case "loudest": {
      let best: { title: string; v: number } | null = null;
      for (const { it, st } of stats) {
        if (st?.max != null && (!best || st.max > best.v)) best = { title: it.title || "Untitled", v: st.max };
      }
      return best ? best.title : "—";
    }
    case "message": {
      const hit = stats.find(({ it }) => MESSAGE_TITLE.test(it.title ?? ""));
      return hit?.st?.leq != null ? dB(hit.st.leq) : "—";
    }
    case "service":
      return dB(combineLeq(stats.map(({ st }) => ({ leq: st?.leq ?? null, count: st?.count ?? 0 }))));
    case "items":
      return String(items.length);
    default:
      return "—";
  }
}

/** Two right-aligned dB cells (Max, Leq) for one metric. Leq is blank on records
 *  made before energy averaging, rather than showing the old linear mean. */
function FragmentCells({ max, leq }: { max: number | null; leq: number | null }) {
  return (
    <>
      <td className="py-1.5 px-3 text-right tabular-nums text-fg">{dB(max)}</td>
      <td className="py-1.5 px-3 text-right tabular-nums text-fg-muted">{dB(leq)}</td>
    </>
  );
}
