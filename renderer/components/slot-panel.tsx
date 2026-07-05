import { useState, useEffect } from "react";
import { UserRoundIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { StatusStrip, OfflinePill } from "./status-strip";
import { BrandLogo } from "./brand-logo";

interface SlotPanelProps {
  slot: Slot;
  /** Optional image shown centered in empty slots (recolored to the kiosk gray). */
  emptySlotLogo?: string | null;
  /** Optional avatar for matched people with no PCO photo; null = built-in silhouette. */
  defaultAvatar?: string | null;
  /** Photo-forward layout: the photo fills the whole card and the name/position/RF
   *  sit on a transparent gradient scrim at the bottom instead of a solid band that
   *  butts below the photo. Used on the condensed phone grid so the photo stays big. */
  overlay?: boolean;
  className?: string;
}

export function SlotPanel({ slot, emptySlotLogo, defaultAvatar, overlay = false, className }: SlotPanelProps) {
  const isEmpty = slot.link.kind === "empty";
  const isStatic = slot.link.kind === "static";
  const solidColor = isStatic ? (slot.link as { kind: "static"; label: string; color: string }).color : null;
  const displayName =
    slot.displayName ||
    (isStatic ? (slot.link as { kind: "static"; label: string; color: string }).label : null) ||
    null;

  const hasPhoto = !isStatic && !isEmpty && !!slot.photoUrl;

  // Photo loads can fail transiently (the /photos proxy 404s when PCO is briefly
  // unreachable; it self-heals on the next request since failures aren't cached).
  // Retry once with a cache-busting query before falling back to the avatar, so a
  // single blip never leaves a permanently blank slot.
  const [imgAttempt, setImgAttempt] = useState(0);
  const [imgFailed, setImgFailed] = useState(false);
  // Reset retry/fail state whenever the underlying photo URL changes.
  useEffect(() => {
    setImgAttempt(0);
    setImgFailed(false);
  }, [slot.photoUrl]);

  const photoSrc =
    hasPhoto && !imgFailed
      ? `/photos?u=${encodeURIComponent(slot.photoUrl!)}${imgAttempt > 0 ? `&r=${imgAttempt}` : ""}`
      : null;

  function handleImgError() {
    // First failure: retry once (forces the proxy to re-fetch). Second: give up.
    if (imgAttempt < 1) setImgAttempt((n) => n + 1);
    else setImgFailed(true);
  }

  // No-photo avatar: PCO/position slots matched to a person with no photo, OR a
  // slot whose photo failed to load after a retry (graceful fallback, not blank).
  const showAvatar = !isStatic && !isEmpty && !!displayName && (!hasPhoto || imgFailed);

  // A PCO slot that resolved to nobody (no person scheduled, or no matching
  // note) shows the same blank/logo view as a configured empty slot.
  const isUnfilled = isEmpty || (slot.link.kind === "pco" && !slot.displayName);

  if (isUnfilled) {
    return (
      // Outer wrapper provides the gap spacing — p-1.5 all sides, last child no right padding handled by gap
      <div
        className={cn(
          "relative flex flex-col flex-1 min-w-0 p-1.5 select-none [container-type:inline-size]",
          className,
        )}
      >
        {/* Empty slot: a barely-there panel. We deliberately skip the .glass-card
            ring (its crisp 1px border bands visibly on the Pi panels against the
            dark fill); just a soft fill so it reads without an outlined rectangle. */}
        <div
          className="relative flex flex-col items-center justify-center flex-1 overflow-hidden [container-type:inline-size]"
          // Radius is purely relative to the slot's own width (cqi) so it renders at
          // the SAME proportion in the editor preview, the live display, and the
          // standalone view — an absolute clamp broke that in fill mode (no transform).
          style={{ background: "rgba(255,255,255,0.02)", borderRadius: "7cqi" }}
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
        "relative flex flex-col flex-1 min-w-0 p-1.5 select-none [container-type:inline-size]",
        className,
      )}
    >
      {/* Floating glass card — the photo fills the top and extends DOWN until it
          meets the info card at the bottom; the two are separate stacked regions,
          so the photo never sits behind the name/RF card. [container-type:inline-size]
          makes every cqi/cqw unit inside resolve against THIS card's width, so
          names/avatar/RF bar stay proportional from preview sliver to 4K column. */}
      <div
        className="relative flex flex-col flex-1 overflow-hidden glass-card [container-type:inline-size]"
        style={{ borderRadius: "7cqi" }}
      >
        {/* ── Photo (top) — fills all the space above the info card and stops at
            its top edge (object-cover crops the photo, never overlapping the
            card). flex-1 so it grows to meet the card no matter the slot height. ── */}
        <div className="relative flex-1 min-h-0 overflow-hidden">
          {photoSrc ? (
            <img
              src={photoSrc}
              alt={displayName ?? undefined}
              className="absolute inset-0 w-full h-full object-cover object-top"
              draggable={false}
              onError={handleImgError}
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

        {/* ── Info card (bottom). Stacked mode: a SOLID opaque panel the photo
            butts up to (image never shows behind it), macOS-26/Tahoe styling.
            Overlay mode (phone grid): an absolute, transparent→dark gradient
            scrim over the bottom of the photo, so the photo fills the whole card
            and stays visible while the name/RF remain legible. ── */}
        <div
          className={
            overlay
              ? "absolute inset-x-0 bottom-0 z-10 flex flex-col justify-end gap-0.5 px-3 pt-10 pb-2"
              : "relative z-10 flex flex-col justify-start gap-1 px-3 pt-2.5 pb-2"
          }
          style={
            overlay
              ? { background: "linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.5) 45%, rgba(0,0,0,0.88) 100%)" }
              : {
                  background: "linear-gradient(180deg, rgb(26,27,34) 0%, rgb(15,16,21) 100%)",
                  borderTop: "1px solid rgba(255,255,255,0.12)",
                  boxShadow: "inset 0 1px 0 0 rgba(255,255,255,0.14)",
                }
          }
        >
          <div>
            <span
              className="font-semibold text-white leading-tight line-clamp-2 block"
              // Stacked mode reserves two lines (2 × 1.25 leading-tight) so one- and
              // two-line names yield the SAME card height, keeping photo bottoms /
              // position / RF aligned across the row. Overlay mode sits at the bottom
              // of the photo, so no reservation is needed (and avoids a tall scrim).
              style={{ fontSize: "clamp(1rem, 14cqi, 3.4rem)", minHeight: overlay ? undefined : "2.5em" }}
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

          {/* Offline pill — a manually-assigned (offline) mic and/or IEM shows as
              its own pill in place of the RF pill; only surfaces when an offline
              device is set (Device channel → Offline). */}
          {(slot.device.label !== null || slot.device.iemLabel !== null) && (
            <OfflinePill micLabel={slot.device.label} iemLabel={slot.device.iemLabel} />
          )}

          {/* Status strip — live telemetry (RF / charge / IEM battery). Suppressed
              when the mic itself is offline (the offline pill takes its place). */}
          {slot.device.label === null &&
            ((slot.device.status !== "none" && !slot.hideRf) ||
              slot.device.charge !== null ||
              slot.device.iemCharge !== null) && (
              <StatusStrip device={slot.device} hideRf={slot.hideRf} />
            )}
        </div>
      </div>
    </div>
  );
}
