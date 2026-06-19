import { UserRoundIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { StatusStrip } from "./status-strip";
import { BrandLogo } from "./brand-logo";

interface SlotPanelProps {
  slot: Slot;
  /** Optional image shown centered in empty slots (recolored to the kiosk gray). */
  emptySlotLogo?: string | null;
  /** Optional avatar for matched people with no PCO photo; null = built-in silhouette. */
  defaultAvatar?: string | null;
  className?: string;
}

export function SlotPanel({ slot, emptySlotLogo, defaultAvatar, className }: SlotPanelProps) {
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

  // No-photo avatar: PCO/position slots matched to a person but with no photo.
  const showAvatar = !isStatic && !isEmpty && !hasPhoto && !!displayName;

  // A PCO slot that resolved to nobody (no person scheduled, or no matching
  // note) shows the same blank/logo view as a configured empty slot.
  const isUnfilled = isEmpty || (slot.link.kind === "pco" && !slot.displayName);

  if (isUnfilled) {
    return (
      // Outer wrapper provides the gap spacing — p-1.5 all sides, last child no right padding handled by gap
      <div
        className={cn(
          "relative flex flex-col flex-1 min-w-0 p-1.5 select-none",
          className,
        )}
      >
        {/* Empty slot: a barely-there panel. We deliberately skip the .glass-card
            ring (its crisp 1px border bands visibly on the Pi panels against the
            dark fill); just a soft fill so it reads without an outlined rectangle. */}
        <div
          className="relative flex flex-col items-center justify-center flex-1 overflow-hidden rounded-3xl [container-type:inline-size]"
          style={{ background: "rgba(255,255,255,0.02)" }}
        >
          {emptySlotLogo ? (
            <BrandLogo
              logo={emptySlotLogo}
              monochrome
              className="text-white/25"
              // Size to the slot itself (the card is the container), capped so it
              // never exceeds the column width and gets clipped on narrow displays.
              style={{ width: "clamp(2.5rem,55cqw,11rem)", height: "clamp(2.5rem,55cqw,11rem)", maxWidth: "80%" }}
            />
          ) : (
            <span className="text-callout font-medium text-white/20 select-none">empty</span>
          )}
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
      {/* Floating glass card — a contained headshot on top of a macOS-style
          "liquid glass" info panel. [container-type:inline-size] makes every
          cqi/cqw unit inside resolve against THIS card's width, so names/avatar/
          RF bar stay proportional whether the slot is a sliver (preview) or a
          4K column. The card fills the column, but the photo is a fixed square
          at the top (not flex-1), so the face keeps a natural crop instead of
          being vertically stretched; the glass band fills the space below. */}
      <div className="relative flex flex-col flex-1 overflow-hidden rounded-3xl glass-card [container-type:inline-size]">
        {/* ── Photo (top) — a contained, squared headshot. It owns its own box
            (a fixed square, not flex-1 filling the whole tall column), so faces
            keep a natural crop instead of being stretched. The band sits BELOW
            it, never over it. flex-shrink lets it give way on very short cards. ── */}
        <div
          className="relative w-full overflow-hidden"
          style={{ aspectRatio: "1 / 1", flex: "0 1 auto", minHeight: 0 }}
        >
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

          {/* No-photo avatar centered: a custom default avatar if set, else a
              built-in silhouette — both recolored to sit in the theme. */}
          {showAvatar && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              {/* Frosted glass bubble — sized to the slot width via cqi */}
              <div
                className="flex items-center justify-center rounded-full overflow-hidden"
                style={{
                  width: "clamp(2.5rem,34cqi,7rem)",
                  height: "clamp(2.5rem,34cqi,7rem)",
                  background: "rgba(255,255,255,0.10)",
                  boxShadow: "0 0 0 1px rgba(255,255,255,0.15), 0 8px 32px rgba(0,0,0,0.5)",
                  backdropFilter: "blur(10px)",
                }}
              >
                {defaultAvatar ? (
                  <BrandLogo
                    logo={defaultAvatar}
                    monochrome
                    className="text-white/80"
                    style={{ width: "70%", height: "70%" }}
                  />
                ) : (
                  <UserRoundIcon
                    className="text-white/70"
                    style={{ width: "55%", height: "55%" }}
                    strokeWidth={1.75}
                  />
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Info band (bottom) — macOS-26/Tahoe "liquid glass": a translucent,
            heavily-blurred + saturated panel with a bright top hairline and a
            soft inner top highlight. Sits beneath the photo (no overlap). ── */}
        <div
          className="relative z-10 flex flex-col justify-start gap-1 px-3 pt-2.5 pb-2"
          style={{
            background:
              "linear-gradient(180deg, rgba(40,40,52,0.55) 0%, rgba(14,14,20,0.72) 100%)",
            backdropFilter: "blur(28px) saturate(1.7)",
            WebkitBackdropFilter: "blur(28px) saturate(1.7)",
            borderTop: "1px solid rgba(255,255,255,0.12)",
            boxShadow: "inset 0 1px 0 0 rgba(255,255,255,0.14)",
          }}
        >
          <div>
            <span
              className="font-semibold text-white leading-tight line-clamp-2 block"
              style={{ fontSize: "clamp(1rem, 14cqi, 3.4rem)" }}
            >
              {displayName ?? "—"}
            </span>
            {!isStatic && slot.link.kind === "pco" && slot.link.matchBy === "position" && (
              <span
                className="text-white/65 block leading-tight truncate mt-0.5"
                style={{ fontSize: "clamp(0.72rem, 8.5cqi, 1.75rem)" }}
              >
                {slot.link.teamPositionName}
              </span>
            )}
          </div>

          {/* Status strip — only when a device is bound */}
          {slot.device.status !== "none" && <StatusStrip device={slot.device} />}
        </div>
      </div>
    </div>
  );
}
