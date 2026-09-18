import { Fragment, useEffect, useMemo, useState } from "react";

import { invoke } from "../../lib/api";
import { toast } from "../../components/ui";
import { errorMessage } from "@main/services/errors";
import { combineLeq } from "@main/services/spl-leq";
import {
  CustomizePopover,
  HistoryChart,
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

/** The item a church service's level is usually asked about. Matched on the
 *  title because PCO's item_type does not distinguish a sermon from any other
 *  non-song item, and every plan here names it one of these. */
const MESSAGE_TITLE = /\b(message|sermon|teaching|preach)/i;

/**
 * SPL History — browse past services and their recorded levels. Every Smaart
 * metric is recorded; the operator chooses which to surface here.
 *
 * WHAT THE LINE IS. The SPL recorder persists one stat block PER PLAN ITEM, not
 * a sample series — there is no per-second SPL anywhere in the record, and the
 * `spl:history` broadcast carries the same per-item shape. So the chart's line
 * is a STEP: each item's Leq held flat across that item's own window. It is the
 * honest drawing of what was stored, and it lines up exactly with the item lane
 * beneath it. The same limitation is why an item's peak mark sits at the middle
 * of its block rather than at the loudest instant: the instant is not recorded.
 */
export function SplDetail({ detail, timeline }: { detail: ServiceSplHistory; timeline?: ServiceTimeline | null }) {
  const [visible, setVisible] = useState<string[]>([]);
  useEffect(() => {
    invoke<{ metrics: string[] }>("spl:getVisibleMetrics")
      .then((r) => setVisible(r.metrics ?? []))
      .catch((err) => {
        // The list is a preference, not the data — falling back to the default
        // selection is right. Saying so is also right: a browser that silently
        // ignored the operator's saved metrics looks like the server lost them.
        setVisible([]);
        toast.error(`Could not read the saved Smaart metrics: ${errorMessage(err)}`);
      });
  }, []);
  async function toggleMetric(key: string) {
    const next = visible.includes(key) ? visible.filter((k) => k !== key) : [...visible, key];
    setVisible(next);
    try {
      await invoke("spl:setVisibleMetrics", { metrics: next });
    } catch (err) {
      toast.error(`Could not save that metric choice: ${errorMessage(err)}`);
    }
  }

  const [figureKeys, storeFigure] = useStoredKeys(FIGURES_STORAGE_KEY, FIGURE_KEYS, DEFAULT_FIGURES);
  function toggleFigure(key: string) {
    const err = storeFigure(key);
    if (err) toast.error(`Could not remember that choice: ${errorMessage(err)}`);
  }

  const allKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const it of detail.items) if (it.metrics) for (const k of Object.keys(it.metrics)) keys.add(k);
    if (detail.metricKey) keys.add(detail.metricKey);
    return Array.from(keys).sort();
  }, [detail]);
  const shownMetrics = useMemo(() => {
    const filtered = visible.filter((k) => allKeys.includes(k));
    return filtered.length ? filtered : defaultVisible(allKeys);
  }, [visible, allKeys]);
  const items = useMemo(() => detail.items.slice().sort((a, b) => a.sequence - b.sequence), [detail]);

  const preById = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const it of timeline?.items ?? []) m.set(it.itemId, it.preService ?? false);
    return m;
  }, [timeline]);

  const primaryKey = shownMetrics[0] ?? null;

  const series: ChartSeries[] = shownMetrics.map((key, i) => ({
    id: key,
    label: key,
    color: i === 0 ? "var(--color-accent)" : SECONDARY_COLORS[(i - 1) % SECONDARY_COLORS.length],
    role: i === 0 ? "primary" : "secondary",
    // NO FILL, unlike attendance. A fill runs to the axis floor, and a dB axis
    // has no floor that means anything — the band is chosen to frame the data,
    // so the fill's depth would say only where the axis happens to start.
    dashed: i > 0,
    // A step is not a sample series and has no gap to break across: the default
    // rule split the line in the MIDDLE of every item longer than three minutes,
    // which is most of them.
    gapMs: Infinity,
    format: (v: number) => dB(v),
    points: stepPoints(items, detail, key),
  }));

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

  const figures = SOUND_FIGURES.filter((f) => figureKeys.includes(f.key)).map((f) => ({
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
        window={{ startedAt: detail.startedAt, endedAt: detail.endedAt }}
        yScale={{ kind: "db" }}
        figures={figures}
        live={detail.endedAt == null}
        ariaLabel="Recorded sound level per plan item across the service"
        customize={
          <CustomizePopover
            label="Customize sound"
            groups={[
              { id: "figures", label: "Figures", options: SOUND_FIGURES.map((f) => ({ ...f })) },
              { id: "metrics", label: "Smaart metrics", options: allKeys.map((k) => ({ key: k, label: k })) },
            ]}
            selected={[...figureKeys, ...shownMetrics]}
            onToggle={(key) => (FIGURE_KEYS.includes(key as (typeof FIGURE_KEYS)[number]) ? toggleFigure(key) : toggleMetric(key))}
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

/** Colours for the second and later metrics. Neutral-to-warm, never purple. */
const SECONDARY_COLORS = ["var(--color-fg-muted)", "var(--color-warn-11)", "var(--color-info-11)"];

/**
 * One metric as a step line: its Leq held flat across each item's own window.
 *
 * Two points per item — its start and its end — so an item with no reading
 * leaves a hole rather than a slope into the next one.
 */
function stepPoints(items: SplItemHistory[], record: ServiceSplHistory, key: string): ChartPoint[] {
  const out: ChartPoint[] = [];
  for (const it of items) {
    const st = metricStat(it, key, record);
    const v = st?.leq ?? st?.max ?? null;
    const t0 = Date.parse(it.startedAt);
    const t1 = it.endedAt ? Date.parse(it.endedAt) : t0;
    if (v == null || !Number.isFinite(t0)) continue;
    out.push({ t: t0, v });
    if (Number.isFinite(t1) && t1 > t0) out.push({ t: t1, v });
  }
  return out.sort((a, b) => a.t - b.t);
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
