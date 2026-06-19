import { cn } from "../lib/cn";
import { SignalIcon, BatteryFullIcon, BatteryLowIcon, BatteryMediumIcon, RadioIcon } from "lucide-react";

interface StatusStripProps {
  device: SlotDevice;
  className?: string;
}

// All sizing inside the strip is driven off one container-relative unit (`--rf`)
// set on the wrapper. Because the slot card establishes [container-type:inline-size],
// the cqi in that clamp resolves against the slot width — so the RF bar grows on a
// 4K column and shrinks in the editor preview, staying proportional everywhere.
const RF_UNIT = "clamp(0.6rem, 6.5cqi, 1.7rem)";

function BatteryIcon({ level }: { level: number }) {
  const style = { width: "calc(var(--rf) * 1.4)", height: "calc(var(--rf) * 1.4)" };
  if (level >= 60) return <BatteryFullIcon className="text-green-10 shrink-0" style={style} />;
  if (level >= 25) return <BatteryMediumIcon className="text-yellow-10 shrink-0" style={style} />;
  return <BatteryLowIcon className="text-red-10 shrink-0" style={style} />;
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
  return <span className="w-px self-stretch bg-white/10 shrink-0" style={{ margin: "0 calc(var(--rf) * 0.3)" }} />;
}

export function StatusStrip({ device, className }: StatusStripProps) {
  const hasDevice = device.status !== "none";

  // "awaiting device" — muted glass tile (note: slot-panel only renders this
  // component when device.status !== "none", so this branch is a safety guard)
  if (!hasDevice) {
    return (
      <div
        className={cn(
          "relative mx-2 mb-2 flex items-center justify-center gap-2 px-4 py-2",
          "rounded-2xl overflow-hidden glass-dark",
          className,
        )}
        style={{ ["--rf" as string]: RF_UNIT }}
      >
        <RadioIcon className="text-white/25 shrink-0" style={{ width: "calc(var(--rf) * 1.1)", height: "calc(var(--rf) * 1.1)" }} />
        <span
          className="tabular-nums text-white/30 truncate select-none"
          style={{ fontSize: "calc(var(--rf) * 0.95)" }}
        >
          awaiting device
        </span>
      </div>
    );
  }

  const statusColor =
    device.status === "ok"
      ? "text-green-10"
      : device.status === "warn"
        ? "text-yellow-10"
        : "text-red-10";

  const batteryColor =
    device.battery === null
      ? "text-white/30"
      : device.battery >= 60
        ? "text-green-10"
        : device.battery >= 25
          ? "text-yellow-10"
          : "text-red-10";

  const valueTextStyle = { fontSize: "calc(var(--rf) * 1.25)" };

  return (
    <div
      className={cn(
        // Solid pill inset from the card edge. It lives inside the opaque info
        // band now, so no heavy backdrop blur is needed (cheaper to render).
        "relative mx-2 mb-2 flex items-center rounded-2xl overflow-hidden glass-dark",
        className,
      )}
      style={{
        ["--rf" as string]: RF_UNIT,
        padding: "calc(var(--rf) * 0.55) calc(var(--rf) * 0.6)",
      }}
    >
      {/* ── RF segment ── */}
      <div className="flex items-center justify-center shrink-0">
        {device.rf !== null ? (
          <RfBars bars={Math.max(0, Math.min(5, Math.round(device.rf)))} />
        ) : (
          <SignalIcon className={cn("shrink-0", statusColor)} style={{ width: "calc(var(--rf) * 1.2)", height: "calc(var(--rf) * 1.2)" }} />
        )}
      </div>

      <Divider />

      {/* ── Frequency segment ── */}
      <div className="flex items-center flex-1 min-w-0">
        {device.freq !== null ? (
          <span
            className={cn("font-bold tabular-nums truncate leading-none", statusColor)}
            style={valueTextStyle}
          >
            {device.freq}
          </span>
        ) : (
          <span className="font-bold text-white/25 leading-none" style={valueTextStyle}>—</span>
        )}
      </div>

      <Divider />

      {/* ── Battery segment ── */}
      <div className="flex items-center shrink-0" style={{ gap: "calc(var(--rf) * 0.3)" }}>
        {device.battery !== null ? (
          <>
            <BatteryIcon level={device.battery} />
            <span className={cn("font-bold tabular-nums leading-none", batteryColor)} style={valueTextStyle}>
              {device.battery}%
            </span>
          </>
        ) : (
          <span className="font-bold text-white/25 leading-none" style={valueTextStyle}>—</span>
        )}
      </div>
    </div>
  );
}
