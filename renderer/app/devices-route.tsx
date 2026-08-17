// Devices — the hardware.
//
// Screens is about OUTPUTS: what shows what. This is about the machines: which
// box is which, is it alive, and what is it showing. A dead Pi swapped for a new
// one is a Devices action; changing what Left Mic Display shows is a Screens one.
//
// Unclaimed sorts first. A screen that just booted is the thing somebody is
// standing next to, and it is the only row on this page with any urgency.

import { useCallback, useEffect, useMemo, useState } from "react";

import { invoke, onNotification } from "../lib/api";
import { useStageState } from "../main/use-stage-state";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../components/ui/select";
import { cn } from "../lib/cn";
import { usePageActions } from "./page-actions";
import type { SeenDevice } from "@main/types/kiosk";
import type { PublicDevice } from "@main/services/kiosk-devices-store";

interface DevicesPayload {
  scanning: boolean;
  scanEndsAt: number | null;
  /** Tokens are never sent to a client — see withoutTokens. */
  bound: PublicDevice[];
  seen: SeenDevice[];
  /** Unclaimed device id → bound device ids sharing a MAC. A hint, never a bind. */
  matches: Record<string, string[]>;
}

const EMPTY: DevicesPayload = { scanning: false, scanEndsAt: null, bound: [], seen: [], matches: {} };

/** The page holds a scan open for as long as it is on screen — the house rule
 *  about gating work on whether anyone is subscribed, applied to a UDP socket. */
const HOLDER = "devices-page";

export function DevicesRoute() {
  const [data, setData] = useState<DevicesPayload>(EMPTY);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { state } = useStageState();
  const outputs = useMemo(() => state?.outputs ?? [], [state?.outputs]);

  const refresh = useCallback(async () => {
    try {
      setData(await invoke<DevicesPayload>("devices:list"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Hold a scan open while this page is mounted, and close it on the way out so
  // a page nobody is looking at is not keeping a socket busy.
  useEffect(() => {
    void invoke("devices:scan", { holder: HOLDER }).then(refresh);
    const keepAlive = setInterval(() => void invoke("devices:scan", { holder: HOLDER }), 30_000);
    return () => {
      clearInterval(keepAlive);
      void invoke("devices:scan", { holder: HOLDER, stop: true });
    };
  }, [refresh]);

  useEffect(() => onNotification("kiosk:devices", () => void refresh()), [refresh]);

  usePageActions(
    <Button variant="filled" size="medium" onClick={() => void invoke("devices:scan", {}).then(refresh)}>
      Scan for devices
    </Button>,
    [refresh],
  );

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try {
      await fn();
      await refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const claim = (deviceId: string, outputId: string) =>
    act(deviceId, () => invoke("devices:claim", { deviceId, outputId }));
  const release = (deviceId: string) => act(deviceId, () => invoke("devices:release", { deviceId }));

  const outputName = (id: string) => outputs.find((o) => o.id === id)?.name ?? id;
  const nothing = data.bound.length === 0 && data.seen.length === 0;

  return (
    <div className="pt-1 pb-[50vh] max-sm:pb-24 flex flex-col gap-3">
      {error && (
        <p className="rounded-lg border border-danger-9/40 bg-danger-9/10 px-3 py-2 text-footnote text-danger-11">
          {error}
        </p>
      )}

      {data.scanning && (
        <p className="flex items-center gap-2 text-caption1 text-accent">
          <span className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" aria-hidden="true" />
          Scanning for devices on the network
        </p>
      )}

      {nothing ? (
        <EmptyState
          title="No devices yet"
          hint={
            "Install the kiosk agent on a screen and it appears here while scanning. " +
            "Discovery is off until you switch it on in Advanced."
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          {/* Unclaimed first — the only rows on this page with any urgency. */}
          {data.seen.map((d) => (
            <Row
              key={d.id}
              title={d.hostname || "Unconfigured display"}
              tag={d.boundTo ? "Bound elsewhere" : "Unclaimed"}
              tone={d.boundTo ? "warn" : "new"}
              sub={
                d.boundTo
                  ? `${d.os ?? "Unknown"} · bound to another server, which it cannot reach`
                  : `${d.os ?? "Unknown"} · waiting to be assigned`
              }
              hint={
                (data.matches[d.id] ?? []).length > 0
                  ? `Looks like ${data.matches[d.id]
                      .map((id) => data.bound.find((b) => b.id === id)?.label ?? id)
                      .join(", ")} — same MAC address.`
                  : undefined
              }
              ids={[d.ip, d.id, d.macs[0]]}
              action={
                <Select
                  value=""
                  onValueChange={(outputId: string) => void claim(d.id, outputId)}
                  disabled={busy === d.id}
                >
                  <SelectTrigger className="w-44">
                    <SelectValue placeholder={d.boundTo ? "Force claim…" : "Assign an output…"} />
                  </SelectTrigger>
                  <SelectContent>
                    {outputs.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
          ))}

          {data.bound.map((d) => (
            <Row
              key={d.id}
              title={d.label || d.hostname || d.id}
              sub={`${d.os ?? "Unknown"} · ${d.hostname ?? "unknown host"}`}
              showing={outputName(d.outputId)}
              ids={[d.ip, d.id, d.macs[0]]}
              action={
                <Button
                  variant="transparent"
                  size="small"
                  disabled={busy === d.id}
                  onClick={() => void release(d.id)}
                >
                  Release
                </Button>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  title, sub, tag, tone, showing, ids, action, hint,
}: {
  title: string;
  sub: string;
  tag?: string;
  tone?: "new" | "warn";
  showing?: string;
  ids: (string | undefined)[];
  action: React.ReactNode;
  hint?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3.5 border-b border-line px-4 py-3.5 last:border-b-0",
        tone === "new" && "bg-accent/[0.07]",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-2 size-2 shrink-0 rounded-full",
          tone === "new" ? "bg-accent" : tone === "warn" ? "bg-warn-9" : "bg-live-9",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-callout font-semibold text-fg">{title}</span>
          {tag && (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-caption2 font-semibold uppercase tracking-wider",
                tone === "warn" ? "bg-warn-9/15 text-warn-11" : "bg-accent/15 text-accent",
              )}
            >
              {tag}
            </span>
          )}
        </div>
        <div className="text-caption1 text-fg-muted">{sub}</div>
        {hint && <div className="mt-1.5 text-caption1 text-warn-11">{hint}</div>}
      </div>
      <div className="hidden min-w-0 text-right sm:block">
        {showing && <div className="text-caption1 text-fg">{showing}</div>}
        <div className="truncate font-mono text-caption2 text-fg-subtle">
          {ids.filter(Boolean).join(" · ")}
        </div>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
