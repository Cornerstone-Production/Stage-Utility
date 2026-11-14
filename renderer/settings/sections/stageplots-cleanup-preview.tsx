// stageplots-cleanup-preview.tsx — a background's Before and After, large.
//
// A press on either thumbnail in the background's detail grows it, from where it
// sits, into a large view over the dimmed page (CLEANUP_PREVIEW_MS). Before | After
// at the top, or the left and right arrow keys, switch between the kept source and
// the web image in place, cross-faded, so the clean-up reads at full size. Escape,
// the close button or a press on the dimmed page shrinks it back into the
// thumbnail of whichever image it shows. With reduced motion it opens and closes
// without the grow.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "lucide-react";

import type { BackgroundView } from "@main/types/stageplots";

import { cn } from "../../lib/cn";
import { prefersReducedMotion } from "../../lib/reduced-motion";
import { formatBytes } from "../../main/stageplots/doc-helpers";
import { Mono } from "../../main/stageplots/mono";
import { iconButton } from "./stageplots-shared";

export type CleanupSide = "before" | "after";

/** How long the grow and the shrink take. */
export const CLEANUP_PREVIEW_MS = 260;

/** The bar over the image and the line under it, in px: what the large view adds to the image's height. */
const CHROME_PX = 44 + 28;

type Box = { left: number; top: number; width: number; height: number };

function boxOf(el: Element | null | undefined): Box | null {
  const r = el?.getBoundingClientRect();
  return r && r.width > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
}

/** The large view's box: as wide as the window allows (at most 1100 px), the image at its own shape, centred. */
function targetBox(aspect: number): Box {
  const maxW = Math.min(window.innerWidth - 48, 1100);
  const maxH = window.innerHeight - 64;
  const width = Math.max(240, Math.min(maxW, (maxH - CHROME_PX) * aspect));
  const height = Math.min(maxH, width / aspect + CHROME_PX);
  return { left: (window.innerWidth - width) / 2, top: (window.innerHeight - height) / 2, width, height };
}

/** The two images, in the order they are listed everywhere: the kept source, then the web image. */
export const SIDES: { side: CleanupSide; label: string; src: (background: BackgroundView) => string }[] = [
  { side: "before", label: "Before", src: (b) => b.sourceUrl },
  { side: "after", label: "After", src: (b) => b.url },
];

export function CleanupPreview({
  background,
  side: initial,
  thumbOf,
  onClose,
  kindLabel,
}: {
  background: BackgroundView;
  side: CleanupSide;
  /** The thumbnail each side grows from and shrinks back into. */
  thumbOf: (side: CleanupSide) => HTMLElement | null;
  onClose: () => void;
  /** "PNG", "JPEG" or "PDF": what was uploaded. */
  kindLabel: string;
}) {
  const aspect = background.converted.width / Math.max(1, background.converted.height);
  // Read once: the grow and the shrink of one opening agree.
  const [animate] = useState(() => !prefersReducedMotion());
  const [side, setSide] = useState<CleanupSide>(initial);
  // Without motion it opens at its full size; with it, at the thumbnail's, and grows on the next frame.
  const [open, setOpen] = useState(!animate);
  const [box, setBox] = useState<Box | null>(() => (animate ? boxOf(thumbOf(initial)) : targetBox(aspect)));
  const closing = useRef(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  // The shrink's timer: cleared if the preview goes away first (its background deleted), so
  // it never calls onClose, or focuses a thumbnail, on a view that is no longer there.
  const shrink = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (shrink.current !== null) window.clearTimeout(shrink.current);
    },
    [],
  );

  useLayoutEffect(() => {
    if (!animate) return;
    const id = requestAnimationFrame(() => {
      setBox(targetBox(aspect));
      setOpen(true);
    });
    return () => cancelAnimationFrame(id);
  }, [aspect, animate]);

  useEffect(() => closeRef.current?.focus({ preventScroll: true }), []);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const back = thumbOf(side);
    setOpen(false);
    const done = () => {
      onClose();
      back?.focus({ preventScroll: true });
    };
    const to = boxOf(back);
    if (!animate || !to) return done();
    setBox(to);
    shrink.current = window.setTimeout(done, CLEANUP_PREVIEW_MS);
  }, [animate, onClose, side, thumbOf]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        setSide((s) => (s === "before" ? "after" : "before"));
      }
    };
    const onResize = () => !closing.current && setBox(targetBox(aspect));
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    };
  }, [close, aspect]);

  const meta =
    side === "before"
      ? background.pdfPage && background.pdfPages
        ? `Source · page ${background.pdfPage} of ${background.pdfPages} of the PDF`
        : `Source · ${kindLabel} · ${formatBytes(background.original.bytes)}`
      : `Web image · WebP · ${formatBytes(background.converted.bytes)} · ${background.converted.width} × ${background.converted.height}`;
  const motion = animate ? `${CLEANUP_PREVIEW_MS}ms cubic-bezier(0.2,0.6,0.2,1)` : "0ms";

  return createPortal(
    <>
      <div
        aria-hidden
        onClick={close}
        className="fixed inset-0 z-[150] bg-black/55"
        style={{ opacity: open ? 1 : 0, transition: `opacity ${motion}` }}
        data-testid="cleanup-scrim"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${background.name}: before and after clean-up`}
        data-testid="cleanup-preview"
        className="fixed z-[151] flex flex-col overflow-hidden border border-line-strong bg-surface shadow-[var(--su-shadow-2)]"
        style={
          {
            ...(box ?? targetBox(aspect)),
            borderRadius: open ? 14 : 6,
            transition: ["left", "top", "width", "height", "border-radius"].map((p) => `${p} ${motion}`).join(", "),
          } as CSSProperties
        }
      >
        <div className={cn("flex items-center gap-2.5 border-b border-line py-2 pr-2 pl-3.5 transition-opacity", open ? "opacity-100" : "opacity-0")}>
          <b className="truncate text-footnote font-semibold">{background.name}</b>
          <span role="group" aria-label="Show" className="inline-flex gap-0.5 rounded-lg bg-fill p-0.5">
            {SIDES.map((s) => (
              <button
                key={s.side}
                type="button"
                aria-pressed={side === s.side}
                onClick={() => setSide(s.side)}
                className="rounded-md px-2.5 py-[3px] text-caption1 text-fg-muted aria-pressed:bg-surface aria-pressed:text-fg aria-pressed:shadow-[var(--su-shadow-1)]"
              >
                {s.label}
              </button>
            ))}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-subtle" data-testid="cleanup-meta">
            <Mono text={meta} />
          </span>
          <button ref={closeRef} type="button" className={cn(iconButton, "size-7")} aria-label="Close" onClick={close}>
            <XIcon className="size-4" />
          </button>
        </div>
        <div className="relative min-h-0 flex-1 bg-[var(--su-plot-paper)]">
          {SIDES.map((s) => (
            <img
              key={s.side}
              src={s.src(background)}
              alt={s.side === side ? `${background.name}, ${s.label.toLowerCase()} clean-up` : ""}
              aria-hidden={s.side !== side}
              className="absolute inset-0 h-full w-full object-contain"
              style={{ opacity: s.side === side ? 1 : 0, transition: `opacity ${animate ? 200 : 0}ms` }}
            />
          ))}
        </div>
        <p className={cn("m-0 border-t border-line px-3.5 py-1.5 text-[11px] text-fg-subtle transition-opacity", open ? "opacity-100" : "opacity-0")}>
          ← → to switch · Esc to close
        </p>
      </div>
    </>,
    document.body,
  );
}
