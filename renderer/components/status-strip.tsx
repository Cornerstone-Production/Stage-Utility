import { cn } from "../lib/cn";
import { BatteryFullIcon, BatteryLowIcon, BatteryMediumIcon, MicIcon, HeadphonesIcon } from "lucide-react";

interface StatusStripProps {
  device: SlotDevice;
  /** Hide the RF bars (and frequency); show only the charge bar + level. */
  hideRf?: boolean;
  className?: string;
}

// All sizing inside the strip is driven off one container-relative unit (`--rf`)
// set on the wrapper. Because the slot card establishes [container-type:inline-size],
// the cqi in that clamp resolves against the slot width — so the RF bar grows on a
// 4K column and shrinks in the editor preview, staying proportional everywhere.
const RF_UNIT = "clamp(0.58rem, 6cqi, 1.6rem)";

function BatteryIcon({ level }: { level: number }) {
  const style = { width: "calc(var(--rf) * 1.2)", height: "calc(var(--rf) * 1.2)" };
  if (level >= 60) return <BatteryFullIcon className="text-green-10 shrink-0" style={style} />;
  if (level >= 25) return <BatteryMediumIcon className="text-yellow-10 shrink-0" style={style} />;
  return <BatteryLowIcon className="text-red-10 shrink-0" style={style} />;
}

// Charge level uses the same thresholds as the battery readout / slot status
// (green ≥60, yellow 25–59, red <25) and the same green as the active RF bars,
// so it reads as one family.
function chargeColor(pct: number): string {
  if (pct >= 60) return "bg-green-9";
  if (pct >= 25) return "bg-yellow-9";
  return "bg-red-9";
}

function readoutColor(level: number | null): string {
  if (level === null) return "text-white/30";
  if (level >= 60) return "text-green-10";
  if (level >= 25) return "text-yellow-10";
  return "text-red-10";
}

// A thin charge-level bar sized to sit directly under the 5-bar RF cluster. The
// track is always rendered (so every pill keeps the same height); the fill only
// shows when a battery level is known.
function ChargeBar({ level }: { level: number | null }) {
  return (
    <span
      // Fixed width matching the 5-bar RF cluster, so the bar aligns under the
      // bars and still renders at a sensible size when shown on its own (no RF).
      className="block overflow-hidden rounded-full bg-white/10"
      style={{ width: "calc(var(--rf) * 2.9)", height: "calc(var(--rf) * 0.26)" }}
    >
      {level !== null && (
        <span
          className={cn("block h-full rounded-full transition-all", chargeColor(level))}
          style={{ width: `${Math.max(0, Math.min(100, level))}%` }}
        />
      )}
    </span>
  );
}

function RfBars({ bars }: { bars: number }) {
  // 5 vertical bars with rounded caps; active bars use soft green with a subtle glow.
  // Heights/width/gap are multiples of --rf so the whole cluster scales as one.
  return (
    <span className="flex items-end" style={{ gap: "calc(var(--rf) * 0.2)" }}>
      {Array.from({ length: 5 }).map((_, i) => {
        const active = i < bars;
        return (
          <span
            key={i}
            className={cn(
              "rounded-sm transition-colors shrink-0",
              active ? "bg-green-9" : "bg-white/10",
            )}
            style={{
              width: "calc(var(--rf) * 0.42)",
              height: `calc(var(--rf) * ${(0.6 + i * 0.26).toFixed(2)})`,
              boxShadow: active ? "0 0 6px 1px rgba(74,222,128,0.30)" : undefined,
            }}
          />
        );
      })}
    </span>
  );
}

// Hairline vertical divider between strip segments
function Divider() {
  return <span className="w-px self-stretch bg-white/10 shrink-0" style={{ margin: "0 calc(var(--rf) * 0.2)" }} />;
}

export function StatusStrip({ device, hideRf, className }: StatusStripProps) {
  const micBound = device.status !== "none";
  const showRf = micBound && !hideRf;
  const showFreq = micBound && !hideRf;
  const charge = device.charge;
  const iemCharge = device.iemCharge;
  const hasIem = iemCharge !== null;
  // Offline/manual devices carry a static label (a name) instead of live bars.
  const hasMicLabel = device.label !== null;
  const hasIemLabel = device.iemLabel !== null;

  // Nothing to show (no RF, no charge, no IEM, no offline label) — render nothing
  // rather than an empty pill. slot-panel gates on the same condition.
  if (!showRf && charge === null && iemCharge === null && !hasMicLabel && !hasIemLabel) return null;

  const statusColor =
    device.status === "ok"
      ? "text-green-10"
      : device.status === "warn"
        ? "text-yellow-10"
        : "text-red-10";

  // Readout follows the charge SOURCE (mic battery or charger bay), so the number
  // matches the bar.
  const chargeReadoutColor =
    charge === null
      ? "text-white/30"
      : charge >= 60
        ? "text-green-10"
        : charge >= 25
          ? "text-yellow-10"
          : "text-red-10";

  const valueTextStyle = { fontSize: "calc(var(--rf) * 1.05)" };

  // Charge-only pill (no RF bars, no frequency — e.g. an instrumentalist on a
  // charger bay): center the bar + readout instead of left-aligning them.
  const chargeOnly = !showRf && !showFreq;

  return (
    <div
      className={cn(
        // Solid pill inset from the card edge. It lives inside the opaque info
        // band now, so no heavy backdrop blur is needed (cheaper to render).
        "relative mx-2 mb-2 flex items-center rounded-2xl overflow-hidden glass-dark",
        chargeOnly && "justify-center",
        className,
      )}
      style={{
        ["--rf" as string]: RF_UNIT,
        padding: "calc(var(--rf) * 0.55) calc(var(--rf) * 0.6)",
      }}
    >
      {/* ── RF + charge segment — the 5-bar RF cluster (when shown) with the thin
          charge bar(s) beneath it: the primary (mic / charger), then an optional
          second bar for a bound IEM/PSM pack. With RF hidden or no mic bound, the
          charge bar(s) stand on their own. ── */}
      <div className="flex flex-col items-center justify-center shrink-0" style={{ gap: "calc(var(--rf) * 0.18)" }}>
        {showRf && <RfBars bars={device.rf === null ? 0 : Math.max(0, Math.min(5, Math.round(device.rf)))} />}
        {(showRf || charge !== null) && <ChargeBar level={charge} />}
        {hasIem && <ChargeBar level={iemCharge} />}
      </div>

      {/* ── Frequency segment — only with the RF bars (it's RF info). ── */}
      {showFreq && (
        <>
          <Divider />
          <div className="flex items-center flex-1 min-w-0">
            {device.freq !== null ? (
              <span className={cn("font-bold tabular-nums truncate leading-none", statusColor)} style={valueTextStyle}>
                {device.freq}
              </span>
            ) : (
              <span className="font-bold text-white/25 leading-none" style={valueTextStyle}>—</span>
            )}
          </div>
        </>
      )}

      {/* ── Battery readout(s). With an IEM bound, two labeled rows (mic = handheld,
          headphones = IEM pack); otherwise the single mic/charger battery. ── */}
      {hasIem ? (
        (charge !== null || iemCharge !== null) && (
          <>
            <Divider />
            <div className="flex flex-col justify-center shrink-0" style={{ gap: "calc(var(--rf) * 0.18)" }}>
              {charge !== null && (
                <div className="flex items-center" style={{ gap: "calc(var(--rf) * 0.25)" }}>
                  <MicIcon className={cn("shrink-0", readoutColor(charge))} style={{ width: "calc(var(--rf) * 0.95)", height: "calc(var(--rf) * 0.95)" }} />
                  <span className={cn("font-bold tabular-nums leading-none", readoutColor(charge))} style={valueTextStyle}>{charge}%</span>
                </div>
              )}
              <div className="flex items-center" style={{ gap: "calc(var(--rf) * 0.25)" }}>
                <HeadphonesIcon className={cn("shrink-0", readoutColor(iemCharge))} style={{ width: "calc(var(--rf) * 0.95)", height: "calc(var(--rf) * 0.95)" }} />
                <span className={cn("font-bold tabular-nums leading-none", readoutColor(iemCharge))} style={valueTextStyle}>{iemCharge}%</span>
              </div>
            </div>
          </>
        )
      ) : (
        charge !== null && (
          <>
            <Divider />
            <div className="flex items-center shrink-0" style={{ gap: "calc(var(--rf) * 0.3)" }}>
              <BatteryIcon level={charge} />
              <span className={cn("font-bold tabular-nums leading-none", chargeReadoutColor)} style={valueTextStyle}>
                {charge}%
              </span>
            </div>
          </>
        )
      )}

      {/* ── Offline/manual device labels — a name with no bars (e.g. a PSM 900
          IEM with no network). Mic label sits where a receiver would; the IEM
          label gets the headphones icon. ── */}
      {(hasMicLabel || hasIemLabel) && (
        <>
          {(showRf || charge !== null || iemCharge !== null) && <Divider />}
          <div className="flex flex-col justify-center min-w-0" style={{ gap: "calc(var(--rf) * 0.18)" }}>
            {hasMicLabel && (
              <div className="flex items-center min-w-0" style={{ gap: "calc(var(--rf) * 0.25)" }}>
                <MicIcon className="shrink-0 text-white/60" style={{ width: "calc(var(--rf) * 0.95)", height: "calc(var(--rf) * 0.95)" }} />
                <span className="font-semibold truncate leading-none text-white/85" style={valueTextStyle}>{device.label}</span>
              </div>
            )}
            {hasIemLabel && (
              <div className="flex items-center min-w-0" style={{ gap: "calc(var(--rf) * 0.25)" }}>
                <HeadphonesIcon className="shrink-0 text-white/60" style={{ width: "calc(var(--rf) * 0.95)", height: "calc(var(--rf) * 0.95)" }} />
                <span className="font-semibold truncate leading-none text-white/85" style={valueTextStyle}>{device.iemLabel}</span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
