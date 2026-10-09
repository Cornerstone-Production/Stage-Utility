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
import { errorMessage } from "@main/services/errors";

import { invoke } from "../../lib/api";
import { logToServer } from "../../lib/client-log";
import { Button } from "../../components/ui/button";
import { ErrorNote } from "../../components/ui/error-note";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../../components/ui/select";
import { cn } from "../../lib/cn";
import { useDevices, refreshDevices, describeScreen } from "./use-devices";
import { outputModeLine } from "./output-helpers";
import { useDisplayPresence } from "./use-display-presence";
import { groupByMachine, type Machine, type MachineRow } from "./machine-groups";
import type { DeviceOutput, SeenDevice } from "@main/types/kiosk";
import type { Output } from "@main/types/views";
import type { PanelDevice } from "../../settings/sections/screen-settings-panel";

/** The page holds a scan open while it is on screen — work gated on somebody
 *  actually looking, which is the house rule applied to a UDP socket. */
const HOLDER = "screens-page";

export function UnclaimedScreens({
  outputs,
  onSetUpNew,
}: {
  outputs: Output[];
  /** "Set up as a new screen": open the Screen settings panel for this device.
   *  The screen is made, and the device claimed, when the panel finishes. */
  onSetUpNew: (device: PanelDevice) => void;
}) {
  const data = useDevices();
  const connected = useDisplayPresence();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  // An action this section took, a scan that could not start, or a background
  // refresh that failed. All are "the list you are looking at may be wrong", so
  // all go in the same banner.
  const error = actionError ?? scanError ?? data.error?.message ?? null;

  useEffect(() => {
    let cancelled = false;
    // Unanswered, this section stays empty, which reads exactly like a network
    // with nothing on it — so a failed scan goes on screen and to /log.
    const scan = () =>
      invoke("devices:scan", { holder: HOLDER })
        .then(() => {
          if (!cancelled) setScanError(null);
        })
        .catch((err: unknown) => {
          logToServer("screens", `the device scan failed: ${errorMessage(err)}`);
          if (!cancelled) setScanError(`Couldn't look for screens on the network: ${errorMessage(err)}`);
        });
    void scan().then(() => refreshDevices());
    // The scan expires on its own so a forgotten tab cannot leave the responder
    // answering forever; this renews it while the page is genuinely on screen.
    const keepAlive = setInterval(() => void scan(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(keepAlive);
      // Nobody is left to tell, and the scan expires on its own regardless.
      void invoke("devices:scan", { holder: HOLDER, stop: true }).catch((err: unknown) =>
        logToServer("screens", `the device scan could not be stopped, it will expire on its own: ${errorMessage(err)}`),
      );
    };
  }, []);

  async function claim(deviceId: string, outputId: string) {
    setBusy(deviceId);
    try {
      await invoke("devices:claim", { deviceId, outputId });
      // refreshDevices returns its failure rather than throwing, so it is
      // checked here instead of being caught below. A claim that worked but
      // whose refresh did not still has to say the list is stale.
      const failed = await refreshDevices();
      setActionError(failed && `Set up, but the list did not reload: ${failed.message}`);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  // Nothing found and nothing to report: say nothing at all rather than adding
  // an empty box to a page that already has content. An error is worth a box
  // even with no rows — it is the reason there are no rows.
  if (data.seen.length === 0 && !error) return null;

  const { machines, plain } = groupByMachine(data.seen, data.bound);
  const lookedLikeNames = (id: string) =>
    (data.matches[id] ?? []).map((m) => data.bound.find((b) => b.id === m)?.label ?? m).join(", ");

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

      {error && <ErrorNote className="mb-2">{error}</ErrorNote>}

      {machines.map((m) => (
        <MachineCard
          key={m.key}
          machine={m}
          outputs={outputs}
          connected={connected}
          busy={busy}
          lookedLikeNames={lookedLikeNames}
          onSetUpNew={onSetUpNew}
          onClaim={(deviceId, outputId) => void claim(deviceId, outputId)}
        />
      ))}

      {plain.length > 0 && (
        <div className={cn("overflow-hidden rounded-xl border border-line bg-surface", machines.length > 0 && "mt-3")}>
          {plain.map((d) => {
            const looksLike = lookedLikeNames(d.id);
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

                <DeviceActions
                  device={d}
                  outputs={outputs}
                  busy={busy === d.id}
                  onSetUpNew={onSetUpNew}
                  onClaim={(outputId) => void claim(d.id, outputId)}
                />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** The two things you can mean, kept apart on purpose: a brand new screen, or a
 *  replacement for one that already exists. */
function DeviceActions({ device, outputs, busy, onSetUpNew, onClaim, describedBy }: {
  device: SeenDevice;
  outputs: Output[];
  busy: boolean;
  onSetUpNew: (device: PanelDevice) => void;
  onClaim: (outputId: string) => void;
  /** The id of the text naming this device, for when the page offers the same two
   *  actions for several of them. */
  describedBy?: string;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <Button
        variant="accent"
        size="small"
        disabled={busy}
        aria-describedby={describedBy}
        // An output is named for itself ("SDI 1 · Card A"), not for the Mac it
        // shares with its siblings: four screens called booth-mini are no use.
        onClick={() => onSetUpNew({ id: device.id, hostname: device.hostname, ip: device.ip, name: device.output?.name })}
      >
        Set up as a new screen
      </Button>
      <Select value="" onValueChange={onClaim} disabled={busy}>
        <SelectTrigger className="w-52" aria-describedby={describedBy}>
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
  );
}

/** What an output is, in a line. A DeckLink port sends a mode the screen will
 *  have, so it says the house one until the screen is set; a display says what
 *  the Mac is driving it at, when it has said. */
function outputLine(output: DeviceOutput, device: SeenDevice): string {
  const mode = outputModeLine(output, undefined, device.screen);
  return output.kind === "decklink" ? `Video output · ${mode} until set` : ["Display", mode].filter(Boolean).join(" · ");
}

function OutputIcon({ kind }: { kind: DeviceOutput["kind"] }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "border-[1.5px] border-fg-muted",
        kind === "decklink" ? "ml-0.5 size-3.5 rounded-full" : "h-3 w-[18px] rounded-[2px]",
      )}
    />
  );
}

/**
 * One Mac and its outputs, as the helper announced them.
 *
 * The outputs share a MAC and a hostname, so four look-alike rows would be four
 * copies of the same line and a same-MAC warning on every one. Grouped, the Mac is
 * said once and each output is told apart by what it is. Outputs already set up
 * stay in the list, dimmed, so "SDI 1 is Main stage left" reads beside "SDI 2 is
 * not set up".
 */
function MachineCard({ machine, outputs, connected, busy, lookedLikeNames, onSetUpNew, onClaim }: {
  machine: Machine;
  outputs: Output[];
  connected: ReadonlySet<string>;
  busy: string | null;
  lookedLikeNames: (id: string) => string;
  onSetUpNew: (device: PanelDevice) => void;
  onClaim: (deviceId: string, outputId: string) => void;
}) {
  return (
    <div className="mt-3 rounded-xl border border-dashed border-line-strong bg-surface px-3.5 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2.5">
        <b className="text-callout font-semibold text-fg">{machine.hostname || "Unconfigured Mac"}</b>
        <span className="font-mono text-caption2 text-fg-subtle">
          {[machine.os, machine.ip].filter(Boolean).join(" · ")}
        </span>
      </div>
      <div className="mt-2.5 grid gap-1.5">
        {machine.rows.map((row) => (
          <OutputRow
            key={row.device.id}
            row={row}
            outputs={outputs}
            connected={connected}
            busy={busy}
            lookedLikeNames={lookedLikeNames}
            onSetUpNew={onSetUpNew}
            onClaim={onClaim}
          />
        ))}
      </div>
      <p className="mt-2.5 text-caption1 text-fg-subtle">
        The Mac&apos;s main display (the one with the menu bar) is not offered: it stays the Mac&apos;s desktop unless it is
        switched on in the helper.
      </p>
    </div>
  );
}

function OutputRow({ row, outputs, connected, busy, lookedLikeNames, onSetUpNew, onClaim }: {
  row: MachineRow;
  outputs: Output[];
  connected: ReadonlySet<string>;
  busy: string | null;
  lookedLikeNames: (id: string) => string;
  onSetUpNew: (device: PanelDevice) => void;
  onClaim: (deviceId: string, outputId: string) => void;
}) {
  const output = row.device.output!;
  const titleId = `output-${row.device.id}`;
  const base = "grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[9px] border border-line bg-bg px-2.5 py-2 max-sm:grid-cols-[22px_minmax(0,1fr)]";

  if (row.state === "bound") {
    const screen = outputs.find((o) => o.id === row.device.outputId);
    const mode = outputModeLine(output, screen?.videoMode, row.device.screen);
    const showing = connected.has(row.device.outputId);
    return (
      <div className={cn(base, "opacity-55")}>
        <OutputIcon kind={output.kind} />
        <div className="min-w-0">
          <b className="block truncate text-footnote font-semibold text-fg">{output.name}</b>
          <span className="block truncate text-caption1 text-fg-subtle">
            Set up as &ldquo;{screen?.name ?? row.device.outputId}&rdquo;{mode && ` · ${mode}`}
          </span>
        </div>
        <span className="rounded-full border border-line-strong px-2 text-caption2 text-fg-muted max-sm:col-span-full">
          {showing ? "Showing" : "Offline"}
        </span>
      </div>
    );
  }

  const d = row.device;
  const looksLike = lookedLikeNames(d.id);
  return (
    <div className={base}>
      <OutputIcon kind={output.kind} />
      <div className="min-w-0">
        <b id={titleId} className="block truncate text-footnote font-semibold text-fg">{output.name}</b>
        <span className="block truncate text-caption1 text-fg-subtle">{outputLine(output, d)}</span>
        {d.boundTo && (
          <span className="block text-caption1 text-warn-11">Set up on another server, which it cannot reach.</span>
        )}
        {/* Only ever a device that is not itself an output: its siblings share
            its MAC and are not what it might be replacing. See /api/devices. */}
        {looksLike && (
          <span className="block text-caption1 text-warn-11">Looks like {looksLike} — same MAC address.</span>
        )}
      </div>
      <div className="max-sm:col-span-full">
        <DeviceActions
          device={d}
          outputs={outputs}
          busy={busy === d.id}
          describedBy={titleId}
          onSetUpNew={onSetUpNew}
          onClaim={(outputId) => onClaim(d.id, outputId)}
        />
      </div>
    </div>
  );
}
