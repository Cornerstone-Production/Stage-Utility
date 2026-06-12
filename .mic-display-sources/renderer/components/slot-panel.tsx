import { cn } from "../lib/cn";
import { StatusStrip } from "./status-strip";

interface SlotPanelProps {
  slot: Slot;
  className?: string;
}

function channelLabel(channel: string): string {
  // Pad channel to 2 digits with leading zero if numeric
  const num = parseInt(channel, 10);
  if (!isNaN(num)) return String(num).padStart(2, "0");
  return channel;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

// Small Liquid Glass chip for the channel number
function ChannelChip({ channel }: { channel: string }) {
  return (
    <div
      className="inline-flex items-center justify-center px-2 py-0.5 rounded-full select-none"
      style={{
        background: "rgba(255,255,255,0.12)",
        boxShadow: "0 0 0 1px rgba(255,255,255,0.18), inset 0 1px 0 rgba(255,255,255,0.10)",
        backdropFilter: "blur(8px)",
      }}
    >
      <span
        className="text-callout tabular-nums font-semibold text-white/90 leading-none"
        style={{ textShadow: "0 1px 3px rgba(0,0,0,0.7)" }}
      >
        {channelLabel(channel)}
      </span>
    </div>
  );
}

export function SlotPanel({ slot, className }: SlotPanelProps) {
  const isEmpty = slot.link.kind === "empty";
  const isStatic = slot.link.kind === "static";
  const solidColor = isStatic ? (slot.link as { kind: "static"; label: string; color: string }).color : null;
  const displayName =
    slot.displayName ||
    (isStatic ? (slot.link as { kind: "static"; label: string; color: string }).label : null) ||
    null;

  const hasPhoto = !isStatic && !isEmpty && !!slot.photoUrl;
  const photoSrc = hasPhoto
    ? `/photos?u=${encodeURIComponent(slot.photoUrl!)}`
    : null;

  // Initials avatar: PCO/position slots with a display name but no photo
  const showInitials = !isStatic && !isEmpty && !hasPhoto && !!displayName;

  if (isEmpty) {
    return (
      // Outer wrapper provides the gap spacing — p-1.5 all sides, last child no right padding handled by gap
      <div
        className={cn(
          "relative flex flex-col flex-1 min-w-0 p-1.5 select-none",
          className,
        )}
      >
        {/* Floating glass card */}
        <div
          className="relative flex flex-col items-center justify-center flex-1 overflow-hidden rounded-3xl glass-card"
          style={{ background: "rgba(255,255,255,0.025)" }}
        >
          {/* Muted channel number centered */}
          <ChannelChip channel={slot.channel} />
          <span
            className="mt-2 text-callout font-medium text-white/20 select-none"
          >
            empty
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative flex flex-col flex-1 min-w-0 p-1.5 select-none",
        className,
      )}
    >
      {/* Floating glass card — overflow-hidden for photo crop, rounded corners */}
      <div className="relative flex flex-col flex-1 overflow-hidden rounded-3xl glass-card">
        {/* Photo or solid color background */}
        {photoSrc ? (
          <img
            src={photoSrc}
            alt={displayName ?? undefined}
            className="absolute inset-0 w-full h-full object-cover object-top"
            draggable={false}
          />
        ) : (
          <div
            className="absolute inset-0"
            style={{ backgroundColor: solidColor ?? "#1a1a2e" }}
          />
        )}

        {/* Initials avatar centered when no photo */}
        {showInitials && displayName && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            {/* Frosted glass initials bubble */}
            <div
              className="flex items-center justify-center rounded-full"
              style={{
                width: "clamp(3rem,14cqw,8rem)",
                height: "clamp(3rem,14cqw,8rem)",
                background: "rgba(255,255,255,0.10)",
                boxShadow: "0 0 0 1px rgba(255,255,255,0.15), 0 8px 32px rgba(0,0,0,0.5)",
                backdropFilter: "blur(10px)",
              }}
            >
              <span
                className="font-bold text-white/80 leading-none select-none"
                style={{
                  fontSize: "clamp(1.25rem,5cqw,3.5rem)",
                  textShadow: "0 2px 8px rgba(0,0,0,0.9)",
                }}
              >
                {initials(displayName)}
              </span>
            </div>
          </div>
        )}

        {/* Deep gradient scrim at the bottom — smoother 3-stop fade */}
        <div
          className="absolute inset-x-0 bottom-0 pointer-events-none"
          style={{
            height: "55%",
            background:
              "linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.60) 40%, rgba(0,0,0,0.20) 70%, transparent 100%)",
          }}
        />

        {/* Channel chip — top left, inside card */}
        <div className="relative z-10 p-3">
          <ChannelChip channel={slot.channel} />
        </div>

        {/* Spacer pushes name and strip to bottom */}
        <div className="flex-1" />

        {/* Name + position — on top of the scrim */}
        <div className="relative z-10 px-3 pb-2">
          {/* Very subtle frosted name plate for extra contrast on busy photos */}
          <div
            className="inline-block"
            style={{
              // Subtle text shadow is the primary contrast mechanism; no bg plate needed
            }}
          >
            <span
              className="text-title1 font-semibold text-white leading-tight line-clamp-2 block"
              style={{ textShadow: "0 1px 8px rgba(0,0,0,0.95), 0 2px 20px rgba(0,0,0,0.70)" }}
            >
              {displayName ?? "—"}
            </span>
            {!isStatic && slot.link.kind === "pco" && slot.link.matchBy === "position" && (
              <span
                className="text-[15px] text-white/70 block leading-tight truncate mt-0.5"
                style={{ textShadow: "0 1px 4px rgba(0,0,0,0.85)" }}
              >
                {slot.link.teamPositionName}
              </span>
            )}
          </div>
        </div>

        {/* Status strip — floated at very bottom as a glass pill, only when a device is bound */}
        {slot.device.status !== "none" && (
          <div className="relative z-10">
            <StatusStrip device={slot.device} />
          </div>
        )}
      </div>
    </div>
  );
}
