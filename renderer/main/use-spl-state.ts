import { useCallback, useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";
import { useStatusChannel } from "./use-status-channel";

/**
 * Live SPL state from Smaart, pushed on the "spl:metrics" channel. Hydrates once
 * on mount (the channel only broadcasts on change) then stays live. Shared by the
 * dashboard SPL card and the custom-layout SPL object.
 *
 * Ordering between the hydrate and the first push is useStatusChannel's job —
 * see the note there for the staleness this used to have. Smaart in particular
 * keeps its snapshot current between throttled broadcasts, so at an equal rev
 * the read can be the fresher of the two and must still apply.
 */
export function useSplState(enabled = true): SplMetricsDTO | null {
  const read = useCallback(() => invoke<SplMetricsDTO>("spl:getMetrics"), []);
  return useStatusChannel<SplMetricsDTO>(read, "spl:metrics", enabled);
}

/**
 * The in-progress per-item SPL recording for the live service, pushed on the
 * "spl:history" channel. Hydrates once on mount then stays live. null when
 * nothing is recording.
 */
export function useSplHistory(): ServiceSplHistory | null {
  const [history, setHistory] = useState<ServiceSplHistory | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<ServiceSplHistory | null>("spl:getHistoryCurrent")
      .then((h) => {
        if (!cancelled && h) setHistory(h);
      })
      .catch(() => {
        /* nothing recording yet — ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return onNotification("spl:history", (p) => setHistory(p as ServiceSplHistory | null));
  }, []);

  return history;
}

/**
 * Resolve a single SPL reading from a meters map. With no `meterId`, picks the
 * first meter; with no `metricKey`, prefers a sensible default metric, else the
 * first available. Returns the numeric value + the resolved labels, or null.
 */
export function resolveSplValue(
  spl: SplMetricsDTO | null,
  meterId?: string | null,
  metricKey?: string | null,
): { value: number; metricKey: string; meterLabel: string } | null {
  if (!spl || !spl.connected) return null;
  const ids = Object.keys(spl.meters);
  if (ids.length === 0) return null;
  const id = meterId && spl.meters[meterId] ? meterId : ids[0];
  const meter = spl.meters[id];
  if (!meter) return null;

  const keys = Object.keys(meter.metrics);
  if (keys.length === 0) return null;
  const key =
    metricKey && metricKey in meter.metrics
      ? metricKey
      : (PREFERRED_METRICS.find((k) => k in meter.metrics) ?? keys[0]);
  const value = meter.metrics[key];
  if (typeof value !== "number") return null;

  return { value, metricKey: key, meterLabel: meter.channelName || meter.deviceName || id };
}

/** Default metric preference when none is configured (A-weighted, slow → broadband). */
const PREFERRED_METRICS = ["SPL A Slow", "SPL A Fast", "LAeq 10", "SPL Slow", "SPL Fast"];
