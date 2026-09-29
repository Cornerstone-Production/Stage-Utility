// relay-status.tsx — the Video feeds page's own switch and relay status
// line, laid out per the approved design (mockup-v2.html): the pill and the
// switch sit on the page's OWN header row (its h1 and sub-title), and the
// relay's own detail — version, ports, or why it isn't running — is a
// single strip below it, matching mockup-v2.html:363-374 and its CSS at
// 161-195. video-feeds-route.tsx renders RelayPill and RelaySwitch directly
// into its own header row; RelayDetailRow is the strip beneath it.

import type { ReactNode } from "react";
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

export function RelayPill({ relay }: { relay: RelayStatus }) {
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

export function RelaySwitch({
  enabled,
  onToggle,
  toggling,
}: {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  toggling: boolean;
}) {
  return (
    <span className="ml-auto">
      <Switch checked={enabled} disabled={toggling} aria-label="Video feeds on" onCheckedChange={onToggle} />
    </span>
  );
}

/** One item on the detail strip: text, maybe a bold value, baseline-aligned. */
function Detail({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-baseline gap-1.5">{children}</span>;
}

function ChangePortsLink({ onChangePorts }: { onChangePorts: () => void }) {
  return (
    <Detail>
      <button type="button" className="font-medium text-accent hover:underline" onClick={onChangePorts}>
        Change ports in Advanced
      </button>
    </Detail>
  );
}

export function RelayDetailRow({
  relay,
  enabled,
  binaryPresent,
  archivePresent,
  onChangePorts,
}: {
  relay: RelayStatus;
  /** The video INTEGRATION's own enabled flag — never derived from
   *  `relay.state`, which reads "off" both when the switch is off AND when
   *  it is on with no relay feed yet (relay-lifecycle.ts starts nothing
   *  until one exists). The two need different copy. */
  enabled: boolean;
  /** Whether the pinned binary is already on disk — tells "never downloaded
   *  yet" (show the download-size sentence) apart from "downloaded once,
   *  switched off since" (say nothing), which `relay.state` alone cannot. */
  binaryPresent: boolean;
  /** Whether the pinned archive is already in place, extracted or not. */
  archivePresent: boolean;
  onChangePorts: () => void;
}) {
  // item 8: only a port conflict is something "Change ports in Advanced"
  // can fix — an unsupported platform, a failed download, a config write
  // that failed or a plain crash loop all send the operator to a page with
  // nothing on it that helps.
  const showChangePorts = relay.state === "running" || (relay.state === "failing" && relay.kind === "port-conflict");
  // Called as a plain function, NOT `<RelayDetail .../>` — that JSX form
  // always produces a truthy element object (a description of "call this
  // component"), never the null RelayDetail itself sometimes returns, so
  // checking ITS result for null always saw an object and never skipped
  // anything. RelayDetail takes no ref, no children and uses no hooks, so
  // calling it directly is exactly as safe as JSX would be, and actually
  // reads its return value.
  const detail = RelayDetail({ relay, enabled, binaryPresent, archivePresent });
  // item 5: this row used to render its bordered/padded strip
  // unconditionally, so "off, switched off, binary already downloaded" (the
  // one case with nothing to say — RelayDetail returns null and
  // showChangePorts is false) rendered a strip with nothing in it, just a
  // border and padding around empty space.
  if (detail === null && !showChangePorts) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-4 py-3 text-caption1 text-fg-muted">
      {detail}
      {showChangePorts && <ChangePortsLink onChangePorts={onChangePorts} />}
    </div>
  );
}

/** The asset's own file name, sent by the server rather than derived here by
 *  splitting `placeArchiveAt` on "/" — that breaks on Windows, where the
 *  path the server names uses "\". */
function RelayDetail({
  relay,
  enabled,
  binaryPresent,
  archivePresent,
}: {
  relay: RelayStatus;
  enabled: boolean;
  binaryPresent: boolean;
  archivePresent: boolean;
}) {
  if (relay.state === "off") {
    if (enabled) {
      return <Detail>Video is on. The relay starts when a feed pulls from a device or a device pushes to it.</Detail>;
    }
    if (binaryPresent) return null;
    if (archivePresent) {
      return (
        <Detail>
          Turning this on sets up MediaMTX {MEDIAMTX_VERSION} from the archive already in place.
        </Detail>
      );
    }
    return (
      <Detail>
        Turning this on downloads MediaMTX {MEDIAMTX_VERSION}, a {mb(MEDIAMTX_DOWNLOAD_BYTES)} MB download and{" "}
        {mb(MEDIAMTX_DISK_BYTES)} MB on disk.
      </Detail>
    );
  }

  switch (relay.state) {
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
        <Detail>
          <Loader2Icon className="size-3.5 animate-spin text-accent" />
          Starting the relay
        </Detail>
      );
    case "failing":
      return (
        <>
          <Detail>{relay.reason}</Detail>
          {relay.retryAt !== null && <Detail>Next try at {formatClock(relay.retryAt, { seconds: true })}</Detail>}
          {relay.assetName && relay.placeArchiveAt && (
            <Detail>
              Or place {relay.assetName} in {relay.placeArchiveAt} in Stage Utility's data folder by hand.
            </Detail>
          )}
        </>
      );
    case "running":
      return (
        <>
          <Detail>
            Relay <b className="font-medium text-fg">MediaMTX {relay.version}</b>
          </Detail>
          <Detail>
            Inputs <b className="font-medium font-mono text-fg">RTMP {relay.ports.rtmp} · SRT {relay.ports.srt}</b>
          </Detail>
          <Detail>
            Video to screens <b className="font-medium font-mono text-fg">UDP {relay.ports.webrtcUdp}</b>
          </Detail>
        </>
      );
    default:
      return null;
  }
}
