// The app's colour control.
//
// Replaces `<input type="color">` everywhere. That control is an OS panel: it
// ignores the app's theme, it cannot express an alpha — so a translucent ground
// had to be typed as a string somewhere else — and on a wall-mounted touch
// screen it opens a system window over a live dashboard.
//
// This is a popover the app owns: saturation square, hue and opacity sliders, a
// hex box, and the palette the app is actually built from. It commits as you
// drag, so the canvas behind it updates live rather than on close.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, PlusIcon, XIcon } from "lucide-react";

import { cn } from "../../lib/cn";
import { useSavedColors } from "./use-saved-colors";
import {
  formatColor,
  hsvaToRgba,
  isDark,
  parseColor,
  parseTypedColor,
  rgbaToHsva,
  type Hsva,
  type Rgba,
} from "./color-math";

/**
 * The palette, and the reason there is one.
 *
 * These are the colours the app is built from — the same reds, greens and ambers
 * a recording widget, an over-time countdown and a warning already use. A wall
 * that picks its own approximate red for one widget looks like a mistake next to
 * the one the app painted. Picking is still free; this is what it starts from.
 */
const SWATCHES: { value: string; label: string }[] = [
  { value: "#ffffff", label: "White" },
  { value: "#9a9aa2", label: "Grey" },
  { value: "#141414", label: "Near black" },
  { value: "#e5484d", label: "Red" },
  { value: "#ffc53d", label: "Amber" },
  { value: "#2dd496", label: "Green" },
  { value: "#3b82f6", label: "Blue" },
  { value: "#a78bfa", label: "Violet" },
];

/** A checkerboard, so a translucent colour reads as translucent rather than as
 *  a paler one. */
const CHECKS =
  "repeating-conic-gradient(rgba(255,255,255,0.22) 0% 25%, rgba(0,0,0,0.22) 0% 50%) 50% / 8px 8px";

function Slider({
  value,
  max,
  onChange,
  background,
  label,
  thumbColor,
}: {
  value: number;
  max: number;
  onChange: (v: number) => void;
  background: string;
  label: string;
  thumbColor: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pick = useCallback(
    (clientX: number) => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      onChange(Math.min(max, Math.max(0, ((clientX - r.left) / r.width) * max)));
    },
    [max, onChange],
  );
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pick(e.clientX);
  };
  return (
    <div
      ref={ref}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && pick(e.clientX)}
      // Arrow keys, because a colour is a thing people nudge. Shift for a bigger
      // step, the way every other numeric control in the app behaves.
      onKeyDown={(e) => {
        const step = (e.shiftKey ? 10 : 1) * (max / 100);
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); onChange(Math.max(0, value - step)); }
        if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); onChange(Math.min(max, value + step)); }
      }}
      className="relative h-3 w-full cursor-pointer rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      style={{ background }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md"
        // Inset by half a thumb at each end, so the handle at zero sits ON the
        // track rather than half outside it.
        style={{ left: `calc(8px + ${value / max} * (100% - 16px))`, background: thumbColor }}
      />
    </div>
  );
}

/**
 * The panel, as its own component so that opening it MOUNTS it.
 *
 * Its draft starts from the stored colour and then belongs to the drag: hue and
 * saturation cannot be recovered from a colour that has gone black or grey —
 * both collapse to the same rgb — so dragging into a corner and back out would
 * otherwise lose the hue the operator was working on. Mounting fresh each time
 * is what makes that local state correct without an effect syncing it.
 */
function ColorPanel({
  initial,
  allowAlpha,
  label,
  onChange,
  anchor,
}: {
  initial: Rgba;
  allowAlpha: boolean;
  label: string;
  onChange: (css: string) => void;
  /** The swatch this panel belongs to, for placing it. */
  anchor: HTMLElement | null;
}) {
  const id = useId();
  const saved = useSavedColors();
  const [draft, setDraft] = useState<Hsva>(() => rgbaToHsva(initial));
  const [typed, setTyped] = useState<string | null>(null);

  const commit = (next: Hsva) => {
    setDraft(next);
    setTyped(null);
    onChange(formatColor(hsvaToRgba(next)));
  };

  const svRef = useRef<HTMLDivElement>(null);
  const pickSV = (clientX: number, clientY: number) => {
    const el = svRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    commit({
      ...draft,
      s: Math.min(1, Math.max(0, (clientX - r.left) / r.width)),
      v: 1 - Math.min(1, Math.max(0, (clientY - r.top) / r.height)),
    });
  };

  const current = hsvaToRgba(draft);
  const swatchCss = formatColor(current);
  const hueCss = formatColor(hsvaToRgba({ h: draft.h, s: 1, v: 1, a: 1 }));

  /**
   * Placed against the viewport, in a portal on the body.
   *
   * As a child of the swatch it was clipped by whatever the swatch sat in — the
   * inspector's scrolling column — and, on a row near the bottom, covered by the
   * panel beside it: visible, and not clickable. z-index cannot help, because
   * the ancestors it needs to beat are in a different stacking context.
   *
   * Flips above the swatch when there is no room below, so a control at the foot
   * of a long panel still opens onto something.
   */
  const PANEL_W = 224;
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const h = panelRef.current?.offsetHeight ?? 320;
      const below = a.bottom + 8;
      const top = below + h > window.innerHeight - 8 ? Math.max(8, a.top - h - 8) : below;
      const left = Math.min(Math.max(8, a.right - PANEL_W), window.innerWidth - PANEL_W - 8);
      setPos({ top, left });
    };
    place();
    // A scroll or a resize moves the swatch; the panel has to go with it rather
    // than hang where the swatch used to be.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      data-color-panel=""
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, width: PANEL_W, visibility: pos ? "visible" : "hidden" }}
      className={cn(
        "fixed z-[100] rounded-lg p-3",
        "border border-line-strong bg-popover/95 shadow-2xl backdrop-blur-xl",
        "flex flex-col gap-2.5",
      )}
    >
      {/* Saturation and value. The two gradients over a pure hue are the
          standard construction, and they cost nothing to draw. */}
      <div
        ref={svRef}
        role="application"
        aria-label={`${label} saturation and brightness`}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); pickSV(e.clientX, e.clientY); }}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && pickSV(e.clientX, e.clientY)}
        className="relative h-28 w-full cursor-crosshair rounded-md"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), ${hueCss}`,
        }}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
          style={{ left: `${draft.s * 100}%`, top: `${(1 - draft.v) * 100}%`, background: swatchCss }}
        />
      </div>

      <Slider
        label={`${label} hue`}
        value={draft.h}
        max={360}
        onChange={(h) => commit({ ...draft, h })}
        thumbColor={hueCss}
        background="linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)"
      />

      {allowAlpha && (
        <Slider
          label={`${label} opacity`}
          value={draft.a}
          max={1}
          onChange={(a) => commit({ ...draft, a })}
          thumbColor={swatchCss}
          background={`linear-gradient(to right, transparent, ${formatColor({ ...current, a: 1 })}), ${CHECKS}`}
        />
      )}

      <input
        id={id}
        value={typed ?? swatchCss}
        spellCheck={false}
        aria-label={`${label} value`}
        onChange={(e) => {
          setTyped(e.target.value);
          const rgb = parseTypedColor(e.target.value);
          // Only once it IS a colour: a field that lurched through three wrong
          // colours while six characters were typed would be worse than the one
          // being replaced.
          if (rgb) {
            setDraft(rgbaToHsva(rgb));
            onChange(formatColor(rgb));
          }
        }}
        onBlur={() => setTyped(null)}
        className={cn(
          "min-w-0 rounded-md border border-line bg-fill px-2 py-1",
          "font-mono text-caption1 text-fg",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        )}
      />

      {/* A fixed eight columns, not a wrap: at this width the row was one swatch
          short and the last one dropped to a line of its own. */}
      {/* THE APP'S palette. The operator's own is below it, and the two are kept
          apart on purpose: one is what a widget usually ought to be, the other is
          what this church's stage happens to be this year. */}
      <div className="grid grid-cols-8 gap-1.5 border-t border-line pt-2.5">
        {SWATCHES.map((sw) => {
          const rgb = parseColor(sw.value)!;
          const on = formatColor({ ...rgb, a: draft.a >= 1 ? 1 : draft.a }) === swatchCss;
          return (
            <button
              key={sw.value}
              type="button"
              title={sw.label}
              aria-label={sw.label}
              aria-pressed={on}
              onClick={() => commit({ ...rgbaToHsva(rgb), a: draft.a })}
              className="flex size-5 items-center justify-center rounded-full border border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              style={{ background: sw.value }}
            >
              {on && (
                <CheckIcon
                  className="size-3"
                  // The mark has to be legible on the swatch it sits on, and one
                  // fixed colour disappears on half of them.
                  style={{ color: isDark(rgb) ? "#fff" : "#000" }}
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-line pt-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
            Saved
          </span>
          <button
            type="button"
            onClick={() => void saved.toggle(swatchCss)}
            aria-pressed={saved.has(swatchCss)}
            aria-label={saved.has(swatchCss) ? "Forget this colour" : "Save this colour"}
            title={saved.has(swatchCss) ? "Forget this colour" : "Save this colour"}
            className={cn(
              "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-caption2 transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
              saved.has(swatchCss) ? "text-fg-muted hover:bg-fill hover:text-fg" : "text-accent hover:bg-fill",
            )}
          >
            {/* One control, not a plus AND a delete: whether this colour is kept
                is a yes or a no, and the button says which it currently is. */}
            {saved.has(swatchCss) ? <XIcon className="size-3" /> : <PlusIcon className="size-3" />}
            {saved.has(swatchCss) ? "Forget" : "Save"}
          </button>
        </div>

        {saved.colors.length === 0 ? (
          <p className="text-caption2 text-fg-subtle">
            Colours you save are kept here, on every screen.
          </p>
        ) : (
          <div className="grid max-h-[4.5rem] grid-cols-8 gap-1.5 overflow-y-auto">
            {saved.colors.map((c) => {
              const rgb = parseColor(c);
              const on = c === swatchCss;
              return (
                <button
                  key={c}
                  type="button"
                  title={c}
                  aria-label={c}
                  aria-pressed={on}
                  onClick={() => rgb && commit(rgbaToHsva(rgb))}
                  className="flex aspect-square w-full items-center justify-center rounded-full border border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  // Over the checkerboard, so a kept translucent colour reads as
                  // the translucent colour it is.
                  style={{ background: `linear-gradient(${c}, ${c}), ${CHECKS}` }}
                >
                  {on && rgb && <CheckIcon className="size-3" style={{ color: isDark(rgb) ? "#fff" : "#000" }} />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function ColorField({
  value,
  onChange,
  allowAlpha = true,
  fallback = "#ffffff",
  label = "Colour",
  className,
}: {
  value: string | null | undefined;
  onChange: (css: string) => void;
  /** Off where the stored field cannot carry one (a text colour reads better
   *  opaque, and an alpha there only ever produces grey mush). */
  allowAlpha?: boolean;
  /** What to show when the stored value is absent or is a token this cannot
   *  resolve — a var() has no numbers to put on a slider. */
  fallback?: string;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  // In STATE, not a ref: the panel is placed from this element, so the render
  // that opens it has to be the render that knows where it is.
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const parsed = parseColor(value) ?? parseColor(fallback) ?? { r: 255, g: 255, b: 255, a: 1 };

  // Close on a click elsewhere or on Escape — the same manners as every other
  // floating panel here.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      // The panel is on the body now, so "inside" is either of the two.
      if (wrap.current?.contains(t)) return;
      if ((t as HTMLElement).closest?.("[data-color-panel]")) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const swatchCss = formatColor(parsed);

  return (
    <div ref={wrap} className={cn("relative inline-flex", className)}>
      <button
        ref={setTrigger}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "size-7 shrink-0 rounded-md border border-line-strong transition-shadow",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
          open && "ring-2 ring-accent",
        )}
        // The checkerboard under the colour, so 4% white reads as nearly clear
        // rather than as a slightly different grey.
        style={{ background: `linear-gradient(${swatchCss}, ${swatchCss}), ${CHECKS}` }}
      />

      {open && (
        <ColorPanel initial={parsed} allowAlpha={allowAlpha} label={label} onChange={onChange} anchor={trigger} />
      )}
    </div>
  );
}
