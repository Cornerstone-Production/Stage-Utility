import { cn } from "../lib/cn";
import { SignalIcon, BatteryFullIcon, BatteryLowIcon, BatteryMediumIcon, RadioIcon } from "lucide-react";

interface StatusStripProps {
  device: SlotDevice;
  className?: string;
}

function BatteryIcon({ level }: { level: number }) {
  if (level >= 60) return <BatteryFullIcon className="size-7 text-green-10 shrink-0" />;
  if (level >= 25) return <BatteryMediumIcon className="size-7 text-yellow-10 shrink-0" />;
  return <BatteryLowIcon className="size-7 text-red-10 shrink-0" />;
}

function RfBars({ bars }: { bars: number }) {
  // 5 vertical bars with rounded caps; active bars use soft green with a subtle glow
  return (
    <span className="flex items-end gap-[3px] shrink-0">
      {Array.from({ length: 5 }).map((_, i) => {
        const active = i < bars;
        return (
          <span
            key={i}
            className={cn(
              "w-2 rounded-sm transition-colors",
              active
                ? "bg-green-9"
                : "bg-white/10",
            )}
            style={{
              height: `${10 + i * 5}px`,
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
  return <span className="w-px self-stretch bg-white/10 shrink-0 mx-1" />;
}

export function StatusStrip({ device, className }: StatusStripProps) {
  const hasDevice = device.status !== "none";

  // "awaiting device" — muted glass tile (note: slot-panel only renders this
  // component when device.status !== "none", so this branch is a safety guard)
  if (!hasDevice) {
    return (
      <div
        className={cn(
          "relative mx-2 mb-2 flex items-center justify-center gap-2 px-4 py-3",
          "rounded-2xl overflow-hidden",
          "glass-dark glass-sheen",
          className,
        )}
        style={{ backdropFilter: "blur(12px) saturate(1.5)" }}
      >
        <RadioIcon className="size-5 text-white/25 shrink-0" />
        <span className="text-callout tabular-nums text-white/30 truncate select-none">
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

  return (
    <div
      className={cn(
        // Floating pill inset from the card edge
        "relative mx-2 mb-2 flex items-center gap-0 px-3 py-3",
        "rounded-2xl overflow-hidden",
        "glass-dark glass-sheen",
        className,
      )}
      style={{ backdropFilter: "blur(16px) saturate(1.8)" }}
    >
      {/* ── RF segment ── */}
      <div className="flex items-center justify-center shrink-0 px-1">
        {device.rf !== null ? (
          <RfBars bars={Math.max(0, Math.min(5, Math.round(device.rf)))} />
        ) : (
          <SignalIcon className={cn("size-6 shrink-0", statusColor)} />
        )}
      </div>

      <Divider />

      {/* ── Frequency segment ── */}
      <div className="flex items-center flex-1 min-w-0 px-2">
        {device.freq !== null ? (
          <span
            className={cn(
              "text-title2 font-bold tabular-nums truncate leading-none",
              statusColor,
            )}
          >
            {device.freq}
          </span>
        ) : (
          <span className="text-title2 font-bold text-white/25 leading-none">—</span>
        )}
      </div>

      <Divider />

      {/* ── Battery segment ── */}
      <div className="flex items-center gap-1.5 shrink-0 px-1">
        {device.battery !== null ? (
          <>
            <BatteryIcon level={device.battery} />
            <span className={cn("text-title2 font-bold tabular-nums leading-none", batteryColor)}>
              {device.battery}%
            </span>
          </>
        ) : (
          <span className="text-title2 font-bold text-white/25 leading-none">—</span>
        )}
      </div>
    </div>
  );
}
