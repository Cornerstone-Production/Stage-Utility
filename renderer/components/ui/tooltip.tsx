import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "../../lib/cn";
import { useCoarsePointer } from "../../lib/use-media-query";

/**
 * A short label for a control that shows no text of its own — an icon button, a
 * truncated name, a disabled action that needs a reason.
 *
 * This replaces the native `title` attribute, which the browser draws itself and
 * which cannot be styled to match anything around it.
 *
 * It opens on hover and on keyboard focus. On a MOUSE, deliberately NOT on
 * click — a click is the control underneath doing its own thing, and the
 * tooltip has nothing to add to it. (Radix's own Trigger actually closes an
 * open tooltip on any click, hover-opened or not — right for "I hovered then
 * clicked the button", the case this line is really about.)
 *
 * On a COARSE pointer — a finger, which has no hover — a tap on the trigger
 * instead toggles the tooltip open, since hover can never open it any other
 * way there; the trigger's own tap-driven click still reaches the control
 * underneath, unswallowed. The next tap anywhere else closes it, the way a
 * popover would. Much of this app runs on tablets propped next to a console,
 * so a tooltip still must never be the ONLY place something is said —
 * anything an operator must know needs to be visible, or in an `InfoHint`,
 * whose blurb opens on click on every pointer type.
 *
 * Use this for a LABEL. For a sentence or two of explanation, use `InfoHint`.
 *
 * ```tsx
 * <Tooltip label="Send to back">
 *   <IconButton icon={SendToBackIcon} />
 * </Tooltip>
 * ```
 */
export function Tooltip({
  label,
  children,
  side = "top",
  className,
}: {
  /** The text to show. Nothing renders when this is empty. */
  label: React.ReactNode;
  /** The control being labeled. Must forward a ref and its props. */
  children: React.ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
}) {
  const coarse = useCoarsePointer();
  const [open, setOpen] = React.useState(false);
  const triggerWrap = React.useRef<HTMLSpanElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  // Set for the duration of a touch/pen gesture on the trigger, so the click
  // and (possible) focus event that follow the SAME tap know to stand down —
  // see the two handlers below for why each needs it.
  const inTouchGesture = React.useRef(false);

  // Close on the NEXT tap anywhere else, once a tap has opened it — a tap on
  // the trigger itself is handled by the toggle below instead, so this only
  // ever fires for a tap genuinely outside both the trigger and the (portaled)
  // content.
  React.useEffect(() => {
    if (!coarse || !open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && (triggerWrap.current?.contains(target) || contentRef.current?.contains(target))) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [coarse, open]);

  // An empty label would otherwise open a bare floating box on hover.
  if (label == null || label === "" || label === false) return children;

  const trigger = (
    <TooltipPrimitive.Trigger
      asChild
      {...(coarse
        ? {
            // The toggle itself lives here, on pointerdown — not on click (see
            // `onClick` below for why click cannot be where this decision is
            // made). Radix's own Trigger has an internal pointerdown handler
            // too (`if (context.open) context.onClose()`), but it only ever
            // fires when the tooltip is ALREADY open — exactly the case where
            // our own toggle is also closing it, so the two agree instead of
            // fighting. A mouse pointerdown is left alone entirely — plugging
            // one into an otherwise-coarse device keeps its ordinary hover
            // behaviour.
            onPointerDown: (e: React.PointerEvent) => {
              if (e.pointerType === "mouse") return;
              inTouchGesture.current = true;
              setOpen((o) => !o);
            },
            // Radix's Trigger ALSO closes an open tooltip on every click,
            // unconditionally (see the doc comment above) — including the
            // click this same tap is about to synthesize right after the
            // pointerdown above. Left alone, a tap that just opened the
            // tooltip would have it closed again before the tap even
            // finished. Only suppressed for the touch/pen gesture that owns
            // it; a real mouse click keeps closing a hover-opened tooltip the
            // way it always has. This does not touch the CHILD's own click
            // handler — Slot calls that separately and always, which is what
            // "the trigger's own click still fires" means here — only a
            // genuine native default action on this same click (a bare
            // `<a href>`'s navigation) would be skipped too, and the surface
            // this applies to under a coarse pointer is icon buttons with no
            // default action of their own.
            onClick: (e: React.MouseEvent) => {
              if (!inTouchGesture.current) return;
              inTouchGesture.current = false;
              e.preventDefault();
            },
            // Some browsers focus a button on tap. Radix's Trigger opens on
            // focus unconditionally unless its OWN pointerdown handler ran
            // first (it tracks that with a ref of its own) — which we just
            // prevented above, so nothing stops this from re-opening a
            // tooltip our own pointerdown just closed. Same suppression, same
            // reason: only for the gesture that owns it.
            onFocus: (e: React.FocusEvent) => {
              if (!inTouchGesture.current) return;
              e.preventDefault();
            },
          }
        : {})}
    >
      {children}
    </TooltipPrimitive.Trigger>
  );

  return (
    <TooltipPrimitive.Root {...(coarse ? { open, onOpenChange: setOpen } : {})}>
      {coarse ? (
        // A plain wrapper, not a new interactive element: `inline-flex` so it
        // measures the same as the child did (same trick Button.tsx uses for
        // a disabled button's tooltip wrapper). It exists only to give the
        // outside-tap listener above something to test containment against —
        // Radix's own Trigger asChild renders no DOM node of its own to hang
        // a ref on.
        <span ref={triggerWrap} className="inline-flex">
          {trigger}
        </span>
      ) : (
        trigger
      )}
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          ref={coarse ? contentRef : undefined}
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            // Matches InfoHint's surface, so the two read as one system.
            "z-50 max-w-[18rem] rounded-lg border border-line-strong bg-popover px-2.5 py-1.5",
            "text-caption1 leading-snug text-fg-muted shadow-md backdrop-blur-xl",
            "data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0",
            "data-[state=delayed-open]:zoom-in-95",
            className,
          )}
        >
          {label}
          <TooltipPrimitive.Arrow className="fill-gray-a6" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
