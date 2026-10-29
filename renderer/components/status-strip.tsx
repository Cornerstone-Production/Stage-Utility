import type { CSSProperties, ReactNode } from "react";
import { clamp } from "@main/services/clamp";
import { cn } from "../lib/cn";
import { EarIcon, HeadphonesIcon, MicIcon } from "lucide-react";

/**
 * The slot card's readout rows and photo badges.
 *
 * Every size is a multiple of --px, one pixel of the approved mockup (a card about
 * 258 wide), written in cqmin. The card is a size container, so cqmin is the
 * smaller of its width and height: the same proportions in the editor preview, on
 * a 1080p column and on a 4K one, and a short wide card shrinks its text rather
 * than letting it cover the photo.
 *
 * --px has to be set on an element INSIDE the card, never on the card itself (a
 * container's own cq units resolve against the container above it), and not inside
 * `.slot-photo`, which is a container of its own and would measure the photo box
 * instead. That is why the badge layer is a sibling of the photo, not a child.
 */
export const PX_UNIT = { ["--px" as string]: "0.388cqmin" } as CSSProperties;
const px = (n: number) => `calc(var(--px) * ${n})`;
/** Text never drops under this, however small the preview. */
const text = (n: number) => `max(0.6rem, ${px(n)})`;

/** A mic or IEM battery under this puts a red edge on the whole card. */
export const LOW_BATTERY = 25;

// One set of thresholds everywhere: green >=60, amber 25-59, red <25.
function levelColor(pct: number): string {
  if (pct >= 60) return "text-green-10";
  if (pct >= 25) return "text-yellow-10";
  return "text-red-10";
}

function RfBars({ bars }: { bars: number }) {
  return (
    <span className="flex items-end" style={{ gap: px(3) }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          className={cn("block shrink-0", i < bars ? "bg-green-9" : "bg-white/10")}
          style={{ width: px(6), minWidth: 2, height: px(8 + i * 3.5), borderRadius: px(2) }}
        />
      ))}
    </span>
  );
}

/** The fixed-width lead of a row: the bars for a live mic, an icon otherwise. */
function Lead({ children }: { children: ReactNode }) {
  return (
    <span className="flex shrink-0 items-center justify-center" style={{ width: px(42) }}>
      {children}
    </span>
  );
}

const rowStyle: CSSProperties = { gap: px(10), fontSize: text(17) };
const MONO = "font-mono tabular-nums font-bold leading-none";
const iconStyle: CSSProperties = { width: px(18), height: px(18) };

interface StatusRowsProps {
  device: SlotDevice;
  /** "strip": live telemetry rows. "offline": the manual labels only, no bars, no
   *  percent. slot-strip-mode.ts decides which, or neither. */
  mode: "strip" | "offline";
  /** Drop the RF bars and the frequency; keep the charge. */
  hideRf?: boolean;
}

/**
 * Flat rows under the name: the mic row (RF bars, label or frequency, battery %)
 * and, when an IEM is bound, the IEM row (headphones, label, battery %). No nested
 * pill. An offline device is the same rows with its label and nothing else.
 */
export function StatusRows({ device, mode, hideRf }: StatusRowsProps) {
  const offline = mode === "offline";
  const showRf = !offline && device.status !== "none" && !hideRf;
  const charge = offline ? null : device.charge;
  const iemCharge = offline ? null : device.iemCharge;

  // The middle of the mic row. Live: the manual label if there is one (it takes the
  // frequency's place), else the frequency. RF hidden: nothing, as the frequency is
  // RF information. Offline: the label, which is why the row exists.
  let micText: ReactNode = null;
  if (offline) {
    if (device.label !== null) micText = <span className="font-semibold text-fg">{device.label || "Offline"}</span>;
  } else if (showRf) {
    const statusColor =
      device.status === "ok" ? "text-green-10" : device.status === "warn" ? "text-yellow-10" : "text-red-10";
    if (device.label) micText = <span className={cn("font-bold", statusColor)}>{device.label}</span>;
    else if (device.freq !== null) micText = <span className={cn(MONO, statusColor)}>{device.freq}</span>;
    else micText = <span className="font-bold text-fg-faint">—</span>;
  }

  const showMicRow = offline ? micText !== null : showRf || charge !== null;
  const iemLabel = offline
    ? device.iemLabel !== null
      ? device.iemLabel || "Offline"
      : null
    : (device.iemLabel ?? (iemCharge !== null ? "IEM" : null));
  const showIemRow = iemLabel !== null;
  if (!showMicRow && !showIemRow) return null;

  return (
    <div
      className="flex flex-col"
      data-slot-rows=""
      style={{ ...PX_UNIT, gap: px(8), paddingTop: px(12), borderTop: "1px solid rgba(255,255,255,0.08)" }}
    >
      {showMicRow && (
        <div className="flex items-center" data-slot-row="mic" style={rowStyle}>
          <Lead>
            {showRf ? (
              <RfBars bars={device.rf === null ? 0 : clamp(Math.round(device.rf), 0, 5)} />
            ) : (
              <MicIcon className="text-fg-muted" style={iconStyle} aria-hidden />
            )}
          </Lead>
          <span className="min-w-0 flex-1 truncate leading-none">{micText}</span>
          {charge !== null && <span className={cn(MONO, levelColor(charge))}>{charge}%</span>}
        </div>
      )}
      {showIemRow && (
        <div className="flex items-center" data-slot-row="iem" style={rowStyle}>
          <Lead>
            <HeadphonesIcon className="text-fg-muted" style={iconStyle} aria-hidden />
          </Lead>
          <span className={cn("min-w-0 flex-1 truncate font-mono font-semibold leading-none", offline ? "text-fg" : "text-fg-muted")}>
            {iemLabel}
          </span>
          {iemCharge !== null && <span className={cn(MONO, levelColor(iemCharge))}>{iemCharge}%</span>}
        </div>
      )}
    </div>
  );
}

/** The capsule plate: a microphone and the capsule model, in mono. */
export function CapsulePlate({ capsule, style }: { capsule: string; style?: CSSProperties }) {
  return (
    <span
      data-slot-badge="capsule"
      className="inline-flex max-w-full items-center"
      style={{
        ...PX_UNIT,
        height: px(36),
        gap: px(7),
        padding: `0 ${px(12)} 0 ${px(10)}`,
        borderRadius: px(10),
        background: "rgba(0,0,0,0.62)",
        border: "1px solid rgba(255,255,255,0.16)",
        ...style,
      }}
    >
      <MicIcon className="shrink-0" style={{ width: px(16), height: px(16), color: "rgba(255,255,255,0.75)" }} aria-hidden />
      <span className="truncate font-mono font-bold leading-none text-white" style={{ fontSize: text(18) }}>
        {capsule}
      </span>
    </span>
  );
}

/**
 * The badges on the photo: channel top-left, own-in-ears top-right and, unless the
 * card draws it in its scrim, the capsule plate bottom-left. Neutral white on dark
 * glass, deliberately: nothing on stage carries the brand accent.
 */
export function PhotoBadges({
  channel,
  ownIems,
  capsule,
  plate,
}: {
  channel: string;
  ownIems: boolean;
  capsule: string | null;
  /** Draw the plate here. False when the card puts it in its scrim instead. */
  plate: boolean;
}) {
  const ch = channel.trim();
  return (
    <div className="pointer-events-none absolute inset-0 z-[1]" style={PX_UNIT} data-slot-badges="">
      {ch !== "" && (
        <span
          data-slot-badge="channel"
          className="absolute inline-flex items-center justify-center font-mono font-semibold"
          style={{
            top: px(12),
            left: px(12),
            height: px(30),
            minWidth: px(30),
            maxWidth: "45%",
            padding: `0 ${px(9)}`,
            borderRadius: px(9),
            background: "rgba(0,0,0,0.55)",
            border: "1px solid rgba(255,255,255,0.14)",
            fontSize: text(15),
            color: "rgba(255,255,255,0.80)",
          }}
        >
          <span className="truncate">{ch}</span>
        </span>
      )}
      {ownIems && (
        <span
          data-slot-badge="ears"
          role="img"
          aria-label="Brings own in-ears"
          className="absolute flex items-center justify-center"
          style={{
            top: px(12),
            right: px(12),
            width: px(34),
            height: px(34),
            borderRadius: 999,
            background: "rgba(255,255,255,0.18)",
            boxShadow: "0 0 0 2px rgba(0,0,0,0.45)",
          }}
        >
          <EarIcon style={{ width: px(19), height: px(19), color: "#ffffff" }} strokeWidth={2.2} aria-hidden />
        </span>
      )}
      {plate && capsule && <CapsulePlate capsule={capsule} style={{ position: "absolute", left: px(12), bottom: px(12), maxWidth: `calc(100% - ${px(24)})` }} />}
    </div>
  );
}
