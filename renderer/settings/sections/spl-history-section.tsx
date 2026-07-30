import { Fragment, useEffect, useMemo, useState } from "react";
import { Tooltip } from "../../components/ui/tooltip";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { ChevronLeftIcon, ChevronRightIcon, Trash2Icon, Volume2Icon } from "lucide-react";

import { invoke } from "../../lib/api";
import { confirm, EmptyState, SkeletonRows } from "../../components/ui";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function fmtTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** A YYYY-MM-DD day label (local), for grouping/navigating recorded services. */
function fmtDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

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

/** Highest value of one metric across a whole service. */
function serviceMetricMax(s: ServiceSplHistory, key: string): number | null {
  let m: number | null = null;
  for (const it of s.items) {
    const st = metricStat(it, key, s);
    if (st?.max != null) m = m == null ? st.max : Math.max(m, st.max);
  }
  return m;
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

/**
 * SPL History — browse past services and their recorded per-item levels. Every
 * Smaart metric is recorded; the operator chooses which to surface here. Services
 * are grouped by day with prev/next-day navigation, and back-to-back services on
 * one day are kept separate (one record per PCO service-time occurrence).
 */
export function SplHistorySection() {
  const [list, setList] = useState<ServiceSplHistory[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<ServiceSplHistory | null>(null);
  const [visible, setVisible] = useState<string[]>([]);
  const [day, setDay] = useState<string | null>(null);

  useEffect(() => {
    invoke<ServiceSplHistory[]>("spl:listHistory")
      .then((l) => setList(l))
      .catch(() => setList([]));
    invoke<{ metrics: string[] }>("spl:getVisibleMetrics")
      .then((r) => setVisible(r.metrics ?? []))
      .catch(() => setVisible([]));
  }, []);

  useResyncOn([selectedKey], () => {
    if (!selectedKey) setDetail(null);
  });

  useEffect(() => {
    if (!selectedKey) return;
    let cancelled = false;
    invoke<ServiceSplHistory | null>("spl:getHistory", { serviceKey: selectedKey })
      .then((d) => !cancelled && setDetail(d))
      .catch(() => !cancelled && setDetail(null));
    return () => {
      cancelled = true;
    };
  }, [selectedKey]);

  // All metric keys ever recorded — drives the surface-these picker.
  const allKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const s of list ?? []) {
      for (const it of s.items) if (it.metrics) for (const k of Object.keys(it.metrics)) keys.add(k);
      if (s.metricKey) keys.add(s.metricKey);
    }
    return Array.from(keys).sort();
  }, [list]);

  const shownMetrics = useMemo(() => {
    const filtered = visible.filter((k) => allKeys.includes(k));
    return filtered.length ? filtered : defaultVisible(allKeys);
  }, [visible, allKeys]);

  // Days that have recordings, newest first — for the date navigator.
  const days = useMemo(() => {
    const set = new Set<string>();
    for (const s of list ?? []) set.add(s.serviceDate);
    return Array.from(set).sort((a, b) => (a < b ? 1 : -1));
  }, [list]);

  useResyncOn([days, day], () => {
    if (day == null && days.length > 0) setDay(days[0]);
  });

  const dayServices = useMemo(
    () => (list ?? []).filter((s) => s.serviceDate === day),
    [list, day],
  );

  const items = useMemo(
    () => (detail?.items ?? []).slice().sort((a, b) => a.sequence - b.sequence),
    [detail],
  );

  async function deleteService(key: string, title: string) {
    if (!(await confirm({ title: "Delete recording?", message: `Delete the SPL recording for "${title}"? This can't be undone.`, confirmLabel: "Delete", destructive: true }))) return;
    setList((prev) => (prev ? prev.filter((s) => s.serviceKey !== key) : prev));
    if (selectedKey === key) setSelectedKey(null);
    try {
      await invoke("spl:deleteHistory", { serviceKey: key });
    } catch {
      // Reload from the server if the delete failed so the UI reflects truth.
      invoke<ServiceSplHistory[]>("spl:listHistory")
        .then((l) => setList(l))
        .catch(() => {});
    }
  }

  async function toggleMetric(key: string) {
    const base = shownMetrics;
    const next = base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
    setVisible(next);
    try {
      await invoke("spl:setVisibleMetrics", { metrics: next });
    } catch {
      /* best-effort persist */
    }
  }

  if (list === null) {
    return (
      <div className="py-6">
        <SkeletonRows rows={5} />
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <div className="py-8">
        <EmptyState
          icon={<Volume2Icon />}
          title="No services recorded yet"
          hint="SPL is recorded per plan item while a service runs in Planning Center Live with the Smaart integration connected."
        />
      </div>
    );
  }

  // ── Detail view: one service, per-item levels for each surfaced metric. ──
  if (detail) {
    return (
      <div className="flex flex-col gap-4">
        <button
          className="self-start text-caption1 text-blue-11 hover:underline"
          onClick={() => setSelectedKey(null)}
        >
          ← All services
        </button>
        <div className="flex flex-col">
          <span className="text-title3 font-semibold text-gray-12">{detail.planTitle ?? detail.serviceKey}</span>
          <span className="text-caption1 text-gray-9">
            {detail.seriesTitle ? `${detail.seriesTitle} · ` : ""}
            {fmtDate(detail.startedAt)}
            {fmtTime(detail.serviceTimeStartsAt ?? detail.startedAt)
              ? ` · ${fmtTime(detail.serviceTimeStartsAt ?? detail.startedAt)}`
              : ""}
          </span>
        </div>
        <MetricPicker allKeys={allKeys} shown={shownMetrics} onToggle={toggleMetric} />
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-caption1">
            <thead className="text-gray-9 text-left border-b border-gray-5">
              <tr>
                <th className="py-1.5 pr-3 font-medium">Item</th>
                {shownMetrics.map((k) => (
                  <th key={k} className="py-1.5 px-3 font-medium text-right whitespace-nowrap" colSpan={2}>
                    {k}
                  </th>
                ))}
              </tr>
              <tr className="text-gray-8">
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
                <tr key={it.itemId} className="border-b border-gray-4">
                  <td className="py-1.5 pr-3 text-gray-12 whitespace-nowrap">{it.title || "Untitled"}</td>
                  {shownMetrics.map((k) => {
                    const st = metricStat(it, k, detail);
                    return (
                      <FragmentCells key={k} max={st?.max ?? null} leq={st?.leq ?? null} />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ── List view: services for the selected day, with day navigation. ──
  const dayIdx = day ? days.indexOf(day) : -1;
  return (
    <div className="flex flex-col gap-3">
      <MetricPicker allKeys={allKeys} shown={shownMetrics} onToggle={toggleMetric} />

      <div className="flex items-center justify-between gap-2">
        <button
          className="rounded-md border border-gray-5 p-1.5 text-gray-11 enabled:hover:bg-gray-3 disabled:opacity-40"
          disabled={dayIdx < 0 || dayIdx >= days.length - 1}
          onClick={() => setDay(days[dayIdx + 1])}
          aria-label="Earlier day"
        >
          <ChevronLeftIcon className="size-4" />
        </button>
        <span className="text-body font-medium text-gray-12">{day ? fmtDay(day) : "—"}</span>
        <button
          className="rounded-md border border-gray-5 p-1.5 text-gray-11 enabled:hover:bg-gray-3 disabled:opacity-40"
          disabled={dayIdx <= 0}
          onClick={() => setDay(days[dayIdx - 1])}
          aria-label="Later day"
        >
          <ChevronRightIcon className="size-4" />
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {dayServices.map((s) => (
          <div
            key={s.serviceKey}
            className="flex items-center gap-1 rounded-lg border border-gray-5 bg-gray-2 pr-1.5 hover:bg-gray-3 transition-colors"
          >
            <button
              className="flex flex-1 min-w-0 items-center justify-between gap-3 px-3 py-2.5 text-left"
              onClick={() => setSelectedKey(s.serviceKey)}
            >
              <div className="flex flex-col min-w-0">
                <span className="text-body font-medium text-gray-12 truncate">{s.planTitle ?? s.serviceKey}</span>
                <span className="text-caption2 text-gray-9 truncate">
                  {fmtTime(s.serviceTimeStartsAt ?? s.startedAt) ? `${fmtTime(s.serviceTimeStartsAt ?? s.startedAt)} · ` : ""}
                  {s.seriesTitle ? `${s.seriesTitle} · ` : ""}
                  {s.items.length} items
                </span>
              </div>
              <span className="shrink-0 tabular-nums text-caption1 text-gray-11 text-right">
                {shownMetrics.map((k) => {
                  const v = serviceMetricMax(s, k);
                  return v == null ? null : (
                    <span key={k} className="ml-3 whitespace-nowrap">
                      <span className="text-gray-9">{k} </span>
                      {Math.round(v)}
                    </span>
                  );
                })}
              </span>
            </button>
            <Tooltip label="Delete recording">
              <button
                className="shrink-0 rounded-md p-2 text-gray-9 hover:bg-gray-4 hover:text-red-11 transition-colors"
                onClick={() => deleteService(s.serviceKey, s.planTitle ?? s.serviceKey)}
                aria-label={`Delete recording for ${s.planTitle ?? "service"}`}
              >
                <Trash2Icon className="size-4" />
              </button>
            </Tooltip>
          </div>
        ))}
        {dayServices.length === 0 && <p className="text-caption1 text-gray-9">No services on this day.</p>}
      </div>
    </div>
  );
}

/** The full per-item SPL detail (metric picker + Max/Leq-per-metric table) for one
 *  service record. Self-contained (owns the surfaced-metric selection, persisted to
 *  the server) so the unified History tab can embed it. Metric keys come from THIS
 *  record's items. */
export function SplDetail({ detail }: { detail: ServiceSplHistory }) {
  const [visible, setVisible] = useState<string[]>([]);
  useEffect(() => {
    invoke<{ metrics: string[] }>("spl:getVisibleMetrics")
      .then((r) => setVisible(r.metrics ?? []))
      .catch(() => setVisible([]));
  }, []);
  async function toggleMetric(key: string) {
    const next = visible.includes(key) ? visible.filter((k) => k !== key) : [...visible, key];
    setVisible(next);
    try {
      await invoke("spl:setVisibleMetrics", { metrics: next });
    } catch {
      /* best-effort persist */
    }
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

  if (!items.length || allKeys.length === 0) {
    return <p className="text-caption1 text-gray-9">No per-item SPL recorded for this service.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <MetricPicker allKeys={allKeys} shown={shownMetrics} onToggle={toggleMetric} />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-caption1">
          <thead className="text-gray-9 text-left border-b border-gray-5">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Item</th>
              {shownMetrics.map((k) => (
                <th key={k} className="py-1.5 px-3 font-medium text-right whitespace-nowrap" colSpan={2}>
                  {k}
                </th>
              ))}
            </tr>
            <tr className="text-gray-8">
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
              <tr key={it.itemId} className="border-b border-gray-4">
                <td className="py-1.5 pr-3 text-gray-12 whitespace-nowrap">{it.title || "Untitled"}</td>
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

/** Two right-aligned dB cells (Max, Leq) for one metric. Leq is blank on records
 *  made before energy averaging, rather than showing the old linear mean. */
function FragmentCells({ max, leq }: { max: number | null; leq: number | null }) {
  return (
    <>
      <td className="py-1.5 px-3 text-right tabular-nums text-gray-12">{dB(max)}</td>
      <td className="py-1.5 px-3 text-right tabular-nums text-gray-10">{dB(leq)}</td>
    </>
  );
}

/** Toggle chips for which metrics to surface. */
function MetricPicker({
  allKeys,
  shown,
  onToggle,
}: {
  allKeys: string[];
  shown: string[];
  onToggle: (key: string) => void;
}) {
  if (allKeys.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-caption2 text-gray-9">Show metrics</span>
      <div className="flex flex-wrap gap-1.5">
        {allKeys.map((k) => {
          const on = shown.includes(k);
          return (
            <button
              key={k}
              onClick={() => onToggle(k)}
              className={`rounded-full border px-2.5 py-1 text-caption2 transition-colors ${
                on
                  ? "border-blue-7 bg-blue-3 text-blue-11"
                  : "border-gray-5 bg-gray-2 text-gray-10 hover:bg-gray-3"
              }`}
            >
              {k}
            </button>
          );
        })}
      </div>
    </div>
  );
}
