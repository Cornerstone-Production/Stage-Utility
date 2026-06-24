import { useEffect, useMemo, useState } from "react";
import { Loader2Icon } from "lucide-react";

import { invoke } from "../../lib/api";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

/**
 * SPL History — browse past services and their recorded per-item max/avg SPL.
 * Read-only and PCO-free (item titles were snapshotted into each record).
 */
export function SplHistorySection() {
  const [list, setList] = useState<ServiceSplHistory[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<ServiceSplHistory | null>(null);

  useEffect(() => {
    invoke<ServiceSplHistory[]>("spl:listHistory")
      .then((l) => setList(l))
      .catch(() => setList([]));
  }, []);

  useEffect(() => {
    if (!selectedKey) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    invoke<ServiceSplHistory | null>("spl:getHistory", { serviceKey: selectedKey })
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedKey]);

  const items = useMemo(
    () => (detail?.items ?? []).slice().sort((a, b) => a.sequence - b.sequence),
    [detail],
  );

  if (list === null) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2Icon className="size-6 text-gray-8 animate-spin" />
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <div className="flex flex-col gap-2 py-8">
        <p className="text-body text-gray-11">No services recorded yet.</p>
        <p className="text-caption1 text-gray-9">
          SPL is recorded per plan item while a service runs in Planning Center Live with the Smaart
          integration connected.
        </p>
      </div>
    );
  }

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
            {detail.metricKey ? ` · ${detail.metricKey}` : ""}
          </span>
        </div>
        <table className="w-full border-collapse text-caption1">
          <thead className="text-gray-9 text-left border-b border-gray-5">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Item</th>
              <th className="py-1.5 px-3 font-medium text-right w-24">Max</th>
              <th className="py-1.5 pl-3 font-medium text-right w-24">Avg</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.itemId} className="border-b border-gray-4">
                <td className="py-1.5 pr-3 text-gray-12">{it.title || "Untitled"}</td>
                <td className="py-1.5 px-3 text-right tabular-nums text-gray-12">
                  {it.maxSpl != null ? `${Math.round(it.maxSpl)} dB` : "—"}
                </td>
                <td className="py-1.5 pl-3 text-right tabular-nums text-gray-10">
                  {it.avgSpl != null ? `${Math.round(it.avgSpl)} dB` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-caption1 text-gray-9 mb-1">Past services with recorded SPL. Select one to view per-item levels.</p>
      {list.map((s) => {
        const peak = s.items.reduce<number | null>((m, it) => (it.maxSpl == null ? m : m == null ? it.maxSpl : Math.max(m, it.maxSpl)), null);
        return (
          <button
            key={s.serviceKey}
            className="flex items-center justify-between gap-3 rounded-lg border border-gray-5 bg-gray-2 px-3 py-2.5 text-left hover:bg-gray-3 transition-colors"
            onClick={() => setSelectedKey(s.serviceKey)}
          >
            <div className="flex flex-col min-w-0">
              <span className="text-body font-medium text-gray-12 truncate">{s.planTitle ?? s.serviceKey}</span>
              <span className="text-caption2 text-gray-9 truncate">
                {s.seriesTitle ? `${s.seriesTitle} · ` : ""}{fmtDate(s.startedAt)} · {s.items.length} items
              </span>
            </div>
            <span className="shrink-0 tabular-nums text-caption1 text-gray-11">
              {peak != null ? `peak ${Math.round(peak)} dB` : "—"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
