import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { invoke, onNotification, type ApiError } from "../../lib/api";
import { toast } from "../../components/ui";
import { errorMessage } from "@main/services/errors";
import { combineLeq } from "@main/services/spl-leq";
import {
  CustomizePopover,
  HistoryChart,
  hasStoredChoice,
  readStoredKeys,
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

/** Every Smaart metric a record carries, sorted. One definition: the section's
 *  columns, its legend and the service header's peak KPI all ask this. */
function metricKeysOf(record: ServiceSplHistory): string[] {
  const keys = new Set<string>();
  for (const it of record.items) if (it.metrics) for (const k of Object.keys(it.metrics)) keys.add(k);
  if (record.metricKey) keys.add(record.metricKey);
  return Array.from(keys).sort();
}

/**
 * The PRIMARY metric this browser surfaces and what the service peaked at on it.
 *
 * The primary is the first of the operator's chosen metrics that this record
 * actually carries — the same rule `SplDetail` uses for its peak marks and its
 * "Peak <metric>" figure, read from the same localStorage entry, so the header
 * and the section below it can never name different metrics.
 *
 * The four empty cases are told apart because they are four different
 * situations and only one of them is a fault in the recording. A single null
 * had the header saying "no metric recorded" at a service that recorded plenty
 * and whose operator had simply unticked every metric in Customize — which
 * sends whoever reads it to look at the meter.
 *
 * Read rather than hooked: the caller needs one figure, not the whole
 * preference machinery, and `SplDetail` — rendered on the same page — owns the
 * seed from the server. A caller that must not go stale when the choice changes
 * subscribes with `useStoredKeysVersion(SPL_METRICS_STORAGE_KEY)`.
 */
export type ServicePeakLevel =
  | { kind: "level"; metric: string; db: number }
  /** No SPL record at all, or one with no items: nothing was recorded. */
  | { kind: "no-record" }
  /** A record carrying no Smaart metric keys — an empty or legacy capture. */
  | { kind: "no-metrics" }
  /** The record HAS metrics; this browser's selection surfaces none of them. */
  | { kind: "hidden"; available: string[] }
  /** The metric is chosen and present, but no item on it recorded a peak. */
  | { kind: "no-samples"; metric: string };

/**
 * The first of this browser's chosen metrics that `available` actually carries,
 * or null when none of them is there.
 *
 * Exported because two surfaces read it and must agree: a service's peak level
 * (below) and the Trends chart's sound measure, which works from the SPL
 * SUMMARY rather than the full record and so cannot go through
 * `servicePeakLevel`. Two copies of this rule would be two rules the day one of
 * them was tightened, and the symptom would be a chart plotting LCeq under a
 * heading that says LAeq.
 */
export function primaryMetricOf(available: readonly string[]): string | null {
  if (!available.length) return null;
  const chosen = readStoredKeys(SPL_METRICS_STORAGE_KEY, null, defaultVisible([...available]));
  return chosen.find((k) => available.includes(k)) ?? null;
}

export function servicePeakLevel(record: ServiceSplHistory | null): ServicePeakLevel {
  if (!record || !record.items.length) return { kind: "no-record" };
  const all = metricKeysOf(record);
  if (!all.length) return { kind: "no-metrics" };
  const primary = primaryMetricOf(all);
  if (!primary) return { kind: "hidden", available: all };
  const maxes = record.items
    .map((it) => metricStat(it, primary, record)?.max)
    .filter((v): v is number => v != null);
  return maxes.length
    ? { kind: "level", metric: primary, db: Math.max(...maxes) }
    : { kind: "no-samples", metric: primary };
}

/** The metric-list preference, exported so a reader outside this file can
 *  subscribe to it rather than re-deriving the key. */
export { SPL_METRICS_STORAGE_KEY };

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

/**
 * The floor between two live re-reads of the series.
 *
 * There is no timer. The recorder broadcasts `spl:history` on every item change
 * and otherwise at most every five seconds (LIVE_BROADCAST_MS in
 * spl-recorder.ts), so the broadcast IS the clock — a second timer beside it
 * only guaranteed that the whole of spl.csv was read twice per interval per
 * open tab.
 *
 * An item change re-reads immediately, because that is when the shape of the
 * chart changes. A heartbeat carrying the same item re-reads at most this
 * often: the line does grow between items, but a five-second-old tail on a
 * two-hour plot is a third of a pixel.
 */
const LIVE_REFETCH_FLOOR_MS = 10_000;

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
 * What the chart knows about this record's raw samples.
 *
 * ONE value, because the three outcomes are mutually exclusive and a pair of
 * booleans has a fourth combination nobody meant. `asking` is its own state and
 * not "no series yet": without it the per-item step draws for a frame before
 * the real line arrives, and on a record switch the PREVIOUS service's line
 * stays up until the new fetch lands.
 */
type SeriesState =
  | { kind: "asking" }
  /** The route answered; `data.buckets` may still be empty. */
  | { kind: "series"; data: SplSeriesResponse }
  /** 404 — this service has no raw rows at all. The per-item step draws. */
  | { kind: "none" }
  /** Anything else. NOT the per-item step: that would present a partial answer
   *  as the whole one. The strip says the samples could not be read. */
  | { kind: "unavailable" };

/** Whether a failed `invoke` was a 404 rather than a real failure. api.ts puts
 *  the status on the Error for exactly this — telling a chosen answer apart
 *  from a broken one — so this reads the field, never the message text. */
function isNotFound(err: unknown): boolean {
  return (err as ApiError | null)?.status === 404;
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

  const allKeys = useMemo(() => metricKeysOf(detail), [detail]);


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
  /**
   * The planned length of each item, from the TIMELINE record.
   *
   * The sound record does not carry one — `SplItemHistory` has a title, a
   * sequence and per-metric stats and nothing from the plan — so the lane's
   * PLANNED figure read "—" on every segment of the sound chart while the
   * identical lane on the attendance chart filled it in. Keyed by `itemId`
   * alone, like `preById` above: a planned length is a property of the plan
   * item, not of one run of it.
   */
  const plannedById = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const it of timeline?.items ?? []) m.set(it.itemId, it.plannedLengthSec);
    return m;
  }, [timeline]);

  const primaryKey = shownMetrics[0] ?? null;
  const live = detail.endedAt == null;

  // ── The raw series ──
  //
  // ONE state, not a pair. A `raw` and a `noRaw` that move independently have a
  // fourth combination nobody meant — the previous record's series with the new
  // record's `noRaw` — and while a new record's fetch is in flight the old pair
  // still reads "has a series", so the PREVIOUS service's sound line stayed on
  // screen under the new service's heading.
  const [state, setState] = useState<SeriesState>({ kind: "asking" });
  /** The items as of this render, for the subscription below to compare against
   *  without taking `detail` as a dependency. */
  const itemsRef = useRef(detail.items);
  useEffect(() => {
    itemsRef.current = detail.items;
  }, [detail.items]);

  // Reset the moment the RECORD or the METRIC changes, during render rather
  // than in the effect below.
  //
  // An effect runs after the paint, so resetting there shows one frame of the
  // previous service's line under the new service's heading — and the lint rule
  // that forbids a synchronous setState in an effect body is pointing at the
  // same thing. This is React's documented adjust-state-when-props-change
  // pattern: the re-render happens before anything is painted.
  //
  // The call sites ALSO key <SplDetail> on the record, so a service switch
  // remounts and cannot carry any of this over. Both, because this component is
  // exported and a caller that forgets the key should still be correct.
  const askedFor = `${detail.serviceKey}|${primaryKey ?? ""}`;
  const [asking, setAsking] = useState(askedFor);
  if (asking !== askedFor) {
    setAsking(askedFor);
    setState({ kind: "asking" });
  }

  useEffect(() => {
    if (!primaryKey) return;

    let cancelled = false;
    let lastLoadAt = 0;
    const load = () => {
      lastLoadAt = Date.now();
      invoke<SplSeriesResponse>("spl:series", {
        serviceKey: detail.serviceKey,
        metric: primaryKey,
        bucketSec: BUCKET_SEC,
      })
        .then((r) => {
          if (cancelled) return;
          // Shape-checked, not just null-checked. This route is the one thing
          // on the page that can answer with something other than what it
          // promises — a proxy's error page, an older server, a 200 from the
          // wrong route — and a section that throws on `undefined.length` takes
          // the whole History tab down with it.
          setState(Array.isArray(r?.buckets) ? { kind: "series", data: r } : { kind: "unavailable" });
        })
        .catch((err) => {
          if (cancelled) return;
          // A 404 is the EXPECTED answer for a record with no raw rows — one
          // from before the raw layer, or one whose archive was pruned — and it
          // is what selects the per-item fallback. Anything else is a failure,
          // and drawing the fallback for it would present a per-item step as
          // though it were the whole answer. The server logs the reason on a
          // [spl-series] line; the operator gets told the samples are missing,
          // not a quietly different chart.
          setState(isNotFound(err) ? { kind: "none" } : { kind: "unavailable" });
        });
    };
    load();
    if (!live) {
      return () => {
        cancelled = true;
      };
    }

    // No timer. The recorder broadcasts on every item change and otherwise at
    // most every five seconds, so the broadcast is the clock — see
    // LIVE_REFETCH_FLOOR_MS.
    // Seeded from the record ON SCREEN, not from sentinels: the first broadcast
    // after mount usually carries the same items, and starting at null made it
    // look like a change every time — one guaranteed extra read of the whole
    // archive per mount, and the "same item" case never exercised.
    //
    // Through a ref, so the record arriving on the wire does not re-run this
    // effect: `detail` is a NEW object on every broadcast, and listing it here
    // would tear down and rebuild the subscription — and re-read the archive —
    // on each one, which is the thing being removed.
    let lastItemId = itemsRef.current?.[itemsRef.current.length - 1]?.itemId ?? null;
    let lastItemCount = itemsRef.current?.length ?? 0;
    const off = onNotification("spl:history", (p) => {
      const rec = p as ServiceSplHistory | null;
      if (!rec || rec.serviceKey !== detail.serviceKey) return;
      const newestItemId = rec.items?.[rec.items.length - 1]?.itemId ?? null;
      const shapeChanged = newestItemId !== lastItemId || rec.items?.length !== lastItemCount;
      lastItemId = newestItemId;
      lastItemCount = rec.items?.length ?? 0;
      if (shapeChanged || Date.now() - lastLoadAt >= LIVE_REFETCH_FLOOR_MS) load();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [detail.serviceKey, primaryKey, live]);

  const raw = state.kind === "series" ? state.data : null;
  const buckets = raw?.buckets ?? null;
  const hasRaw = buckets != null && buckets.length > 0;

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
    // The per-item fallback, and ONLY for a 404 — see SeriesState. While the
    // fetch is in flight, or when it failed for a real reason, there is no
    // series at all: the step would otherwise flash up for a frame before the
    // real line, and stand in for an answer nobody got.
    : state.kind !== "none"
      ? []
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
      plannedSec: plannedById.get(it.itemId) ?? null,
      actualSec: it.endedAt ? Math.round((Date.parse(it.endedAt) - Date.parse(it.startedAt)) / 1000) : null,
      peakLabel: st?.max != null ? dB(st.max) : null,
    };
  });

  /** What an empty plot MEANS here — "nothing recorded yet" is only one of four
   *  reasons it can be empty, and it is the wrong one for the other three. */
  const emptyNote = noneChosen
    ? "No metric selected — pick one in the legend or in Customize."
    : state.kind === "asking"
      ? "Reading the recorded samples…"
      : state.kind === "unavailable"
        ? "Sound samples unavailable — the recorded samples could not be read. The server log says why, on a [spl-series] line."
        : undefined;

  const figures = noneChosen
    ? [{ key: "none", label: "Sound", value: "No metric selected" }]
    : state.kind === "unavailable"
      ? [{ key: "unavailable", label: "Sound", value: "Samples unavailable" }]
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
        emptyNote={emptyNote}
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
