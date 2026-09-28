// relay-status.tsx — the Video feeds page's own switch and relay status
// line, at the top of the "Video feeds settings" card (mockup-v2.html).
//
// The switch is the integration's `enabled` flag (useIntegrations()), not
// anything video-service.ts carries — a switched-on video with no relay feed
// yet still reads "off" here (relay-lifecycle.ts starts nothing until one
// exists), which is the whole point of keeping the two separate.

import { Loader2Icon } from "lucide-react";

import type { RelayStatus } from "@main/types/video";
import { MEDIAMTX_DISK_BYTES, MEDIAMTX_DOWNLOAD_BYTES, MEDIAMTX_VERSION } from "@main/services/video/mediamtx-pin";

import { Switch } from "../../components/ui";
import { formatClock } from "../../lib/clock-format";
import { cn } from "../../lib/cn";

const mb = (bytes: number) => Math.round(bytes / 1_000_000);

/** The header pill: the design's "Relay running" style for `running`, and a
 *  quiet/warn/danger tint for every other state — the same tint language
 *  feed-list.tsx's own FeedPill uses for one feed's status, applied here to
 *  the relay as a whole. */
function relayPill(relay: RelayStatus): { label: string; tint: string; dot: string } {
  switch (relay.state) {
    case "running":
      return { label: "Relay running", tint: "bg-live-9/12 text-green-11 [.dark_&]:text-live-11", dot: "bg-live-9" };
    case "starting":
      return { label: "Relay starting", tint: "bg-accent/12 text-accent", dot: "bg-current" };
    case "downloading":
      return { label: "Downloading the relay", tint: "bg-accent/12 text-accent", dot: "bg-current" };
    case "failing":
      return { label: "Relay error", tint: "bg-danger-9/11 text-danger-11", dot: "bg-current" };
    case "off":
      return { label: "Relay off", tint: "bg-fill text-fg-muted", dot: "bg-current" };
  }
}

function RelayPill({ relay }: { relay: RelayStatus }) {
  const pill = relayPill(relay);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-caption1 font-medium",
        pill.tint,
      )}
    >
      <span className={cn("size-1.5 rounded-full", pill.dot)} />
      {pill.label}
    </span>
  );
}

/** The asset's own file name — the last path segment of `placeArchiveAt`,
 *  which every failure branch that names one already builds as
 *  `<downloads dir>/<asset name>` (acquire.ts). */
function assetName(placeArchiveAt: string): string {
  return placeArchiveAt.split("/").pop() || placeArchiveAt;
}

function RelayDetail({ relay }: { relay: RelayStatus }) {
  switch (relay.state) {
    case "off":
      return (
        <p className="text-caption1 text-fg-muted">
          Turning this on downloads MediaMTX {MEDIAMTX_VERSION}, a {mb(MEDIAMTX_DOWNLOAD_BYTES)} MB download and{" "}
          {mb(MEDIAMTX_DISK_BYTES)} MB on disk.
        </p>
      );
    case "downloading": {
      const pct = relay.totalBytes > 0 ? Math.round((relay.receivedBytes / relay.totalBytes) * 100) : 0;
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-caption2 text-gray-11">
            <span className="flex items-center gap-1.5">
              <Loader2Icon className="size-3.5 animate-spin text-accent" />
              Downloading MediaMTX {MEDIAMTX_VERSION}
            </span>
            <span className="tabular-nums text-gray-10">{pct}%</span>
          </div>
          <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-gray-a4">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-(--motion-settled) ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      );
    }
    case "starting":
      return (
        <p className="flex items-center gap-1.5 text-caption1 text-fg-muted">
          <Loader2Icon className="size-3.5 animate-spin text-accent" />
          Starting the relay
        </p>
      );
    case "failing":
      return (
        <p className="text-caption1 text-fg-muted">
          {relay.reason}
          {relay.retryAt !== null && <> — next try at {formatClock(relay.retryAt, { seconds: true })}</>}
          {relay.placeArchiveAt && (
            <>
              {" "}
              Or place {assetName(relay.placeArchiveAt)} at {relay.placeArchiveAt} by hand.
            </>
          )}
        </p>
      );
    case "running":
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption1 text-fg-muted">
          <span>
            Relay <b className="font-medium text-fg">MediaMTX {relay.version}</b>
          </span>
          <span>
            Inputs <b className="font-mono text-fg">RTMP {relay.ports.rtmp} · SRT {relay.ports.srt}</b>
          </span>
          <span>
            Video to screens <b className="font-mono text-fg">UDP {relay.ports.webrtcUdp}</b>
          </span>
        </div>
      );
  }
}

export function RelayStatusHeader({
  relay,
  enabled,
  onToggle,
  toggling,
  onChangePorts,
}: {
  relay: RelayStatus;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  toggling: boolean;
  /** Opens Advanced's Video relay ports card. */
  onChangePorts: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-line px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <RelayPill relay={relay} />
        <span className="ml-auto">
          <Switch
            checked={enabled}
            disabled={toggling}
            aria-label="Video feeds on"
            onCheckedChange={onToggle}
          />
        </span>
      </div>
      <RelayDetail relay={relay} />
      {relay.state === "running" && (
        <button
          type="button"
          className="self-start text-caption1 font-medium text-accent hover:underline"
          onClick={onChangePorts}
        >
          Change ports in Advanced
        </button>
      )}
    </div>
  );
}
