// Screens found on the network that are not set up yet.
//
// This lives on the Screens page rather than a tab of its own, and that is the
// whole point. Screens exists BECAUSE Views and Displays were separate tabs and
// the join between them lived in the operator's head — putting kiosk devices on
// a third tab recreated exactly that split one level down. A screen you just
// plugged in belongs where you would look for a screen.
//
// It does NOT create outputs on its own. A device that boots is not a screen the
// operator asked for: a spare Pi powered on mid-service would mint a phantom
// entry, and deleting it would not stick because the Pi keeps announcing itself.
// Creation stays an explicit act; this section is where you take it.

import { useEffect, useState } from "react";

import { invoke } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../../components/ui/select";
import { cn } from "../../lib/cn";
import { useDevices, refreshDevices, describeScreen } from "./use-devices";
import type { Output } from "@main/types/views";

/** The page holds a scan open while it is on screen — work gated on somebody
 *  actually looking, which is the house rule applied to a UDP socket. */
const HOLDER = "screens-page";

export function UnclaimedScreens({ outputs }: { outputs: Output[] }) {
  const data = useDevices();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // An action this section took, or a background refresh that failed. Both are
  // "the list you are looking at may be wrong", so both go in the same banner.
  const error = actionError ?? data.error?.message ?? null;

  useEffect(() => {
    void invoke("devices:scan", { holder: HOLDER }).then(() => refreshDevices());
    // The scan expires on its own so a forgotten tab cannot leave the responder
    // answering forever; this renews it while the page is genuinely on screen.
    const keepAlive = setInterval(() => void invoke("devices:scan", { holder: HOLDER }), 30_000);
    return () => {
      clearInterval(keepAlive);
      void invoke("devices:scan", { holder: HOLDER, stop: true });
    };
  }, []);

  async function claim(deviceId: string, outputId: string | null, newName?: string) {
    setBusy(deviceId);
    try {
      await invoke("devices:claim", { deviceId, outputId, newName });
      // refreshDevices returns its failure rather than throwing, so it is
      // checked here instead of being caught below. A claim that worked but
      // whose refresh did not still has to say the list is stale.
      const failed = await refreshDevices();
      setActionError(failed && `Set up, but the list did not reload: ${failed.message}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  // Nothing found and nothing to report: say nothing at all rather than adding
  // an empty box to a page that already has content. An error is worth a box
  // even with no rows — it is the reason there are no rows.
  if (data.seen.length === 0 && !error) return null;

  return (
    <section className="mt-6">
      <header className="mb-2 flex items-center gap-2">
        <h2 className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
          Not set up yet
        </h2>
        <span className="text-caption1 text-fg-muted">· found on the network</span>
        {data.scanning && (
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse"
          />
        )}
      </header>

      {error && (
        <p className="mb-2 rounded-lg border border-danger-9/40 bg-danger-9/10 px-3 py-2 text-footnote text-danger-11">
          {error}
        </p>
      )}

      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        {data.seen.map((d) => {
          const looksLike = (data.matches[d.id] ?? [])
            .map((id) => data.bound.find((b) => b.id === id)?.label ?? id)
            .join(", ");
          return (
            <div
              key={d.id}
              className={cn(
                "flex flex-wrap items-start gap-3 border-b border-line px-4 py-3.5 last:border-b-0",
                d.boundTo ? "bg-warn-9/[0.06]" : "bg-accent/[0.06]",
              )}
            >
              <span
                aria-hidden="true"
                className={cn("mt-2 size-2 shrink-0 rounded-full", d.boundTo ? "bg-warn-9" : "bg-accent")}
              />
              <div className="min-w-0 flex-1">
                <div className="text-callout font-semibold text-fg">
                  {d.hostname || "Unconfigured screen"}
                </div>
                <div className="text-caption1 text-fg-muted">
                  {[d.os, d.ip, describeScreen(d.screen)].filter(Boolean).join(" · ")}
                </div>
                {d.boundTo && (
                  <div className="mt-1 text-caption1 text-warn-11">
                    Set up on another server, which it cannot reach.
                  </div>
                )}
                {looksLike && (
                  <div className="mt-1 text-caption1 text-warn-11">
                    Looks like {looksLike} — same MAC address.
                  </div>
                )}
                <div className="mt-0.5 truncate font-mono text-caption2 text-fg-subtle">
                  {d.id}
                  {d.macs[0] ? ` · ${d.macs[0]}` : ""}
                </div>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {/* The two things you can mean, kept apart on purpose: a brand new
                    screen, or a replacement for one that already exists. */}
                <Button
                  variant="accent"
                  size="small"
                  disabled={busy === d.id}
                  onClick={() => void claim(d.id, null, d.hostname || "New screen")}
                >
                  Set up as a new screen
                </Button>
                <Select
                  value=""
                  onValueChange={(outputId: string) => void claim(d.id, outputId)}
                  disabled={busy === d.id}
                >
                  <SelectTrigger className="w-52">
                    <SelectValue placeholder="Use for an existing screen…" />
                  </SelectTrigger>
                  <SelectContent>
                    {outputs.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
