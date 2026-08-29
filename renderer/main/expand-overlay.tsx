// Tap a tile, it grows to fill the screen. Escape, or the back control, and it
// goes home.
//
// A PORTAL AND NO NAVIGATION, and that pairing is the design. Routing to the
// display would work and would then need a way back that survives a reload, a
// deep link, and somebody's muscle memory for the browser's back button. An
// overlay never leaves the page, so "back" is closing it — there is nothing to
// restore because nothing was lost.
//
// FLIP, the same technique home-grid uses to slide cards: measure the tile,
// apply the inverse transform so the overlay starts exactly on top of it, then
// release it on the next frame and let a transition carry it out. Without it the
// overlay appears instantly at full size and reads as the page having jumped
// somewhere, which is the thing an animation is here to prevent.
//
// THE EXPAND CONTROL IS A SIBLING OF THE TILE'S CONTENT, NEVER ITS ANCESTOR.
// An embedded tile can hold its own controls — a checklist, live controls, an
// OSC button — and a `<button>` wrapped around them swallows their clicks. This
// repository has shipped that bug twice. So the affordance is one small corner
// button beside the body: exactly one interactive layer for expanding, and every
// control inside the tile still gets its own press. A full-bleed `absolute
// inset-0` hit area would have been the same bug with a different tag name.
//
// Interactive surfaces only. A wall display gets no control at all — not a
// disabled one — because an overlay opened by a passer-by in the auditorium
// stays open until somebody walks over and closes it.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Maximize2Icon, XIcon } from "lucide-react";

import { useEmbedBoxHeight } from "./embed-box";

const OPEN_MS = 260;

/** Everything a Tab can land on inside the panel. */
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function useExpand(enabled: boolean) {
  const tileRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const controlRef = useRef<HTMLButtonElement | null>(null);
  const [wanted, setWanted] = useState(false);

  // Adjusted during render, which is React's documented alternative to an
  // effect that closes on the way past. Whatever shuts the gate — a surface
  // that stops being interactive, a screen blacked out under an expanded tile
  // — must not leave an overlay stranded with no control able to reopen it,
  // and must not spring the panel back open by itself when the gate reopens.
  // Deriving `expanded` as well means the close lands in the SAME render rather
  // than one commit later.
  if (wanted && !enabled) setWanted(false);
  const expanded = wanted && enabled;

  const close = useCallback(() => setWanted(false), []);
  const open = useCallback(() => setWanted(true), []);

  // The expanded copy is drawn against the PANEL, not the tile. The tile's
  // measured height is what makes a quarter-height box render its child at a
  // quarter scale; carried into a full-screen panel it would draw the same
  // postage stamp in the middle of the screen, which is the one thing expanding
  // is for. Same hook the tiles measure with, so there is one answer to "how big
  // is this box".
  const { ref: bodyRef, height: bodyHeight } = useEmbedBoxHeight(expanded ? "expanded" : null);

  // Escape, plus a real control in the overlay. Both, because a control surface
  // is a touchscreen more often than not and has no Escape key at all.
  useEffect(() => {
    if (!expanded) return;
    // No stopPropagation: this listens on `document`, which is the end of the
    // bubble path, so it would stop nothing — and the sibling listeners it looks
    // like it is defending against are on the same node and would need
    // stopImmediatePropagation. A call that reads as a guard and is not one is
    // worse than no call.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded, close]);

  // Focus MOVES into the panel and comes back out again.
  //
  // The control that opened the overlay unmounts on open, so focus fell to
  // <body>: a keyboard operator's next Tab started at the top of the page,
  // BEHIND the panel, walking every tile the panel is covering. Tab is trapped
  // inside the panel for the same reason, and focus is returned to the tile on
  // close so the next key press carries on where it was.
  // Written as one effect on both edges rather than an effect with a cleanup:
  // the node to return focus to is the one on the page WHEN THE PANEL CLOSES,
  // and a cleanup that reads a ref at that moment is the pattern the exhaustive
  // -deps rule (correctly, in general) warns about.
  const wasExpanded = useRef(false);
  useEffect(() => {
    if (expanded) {
      wasExpanded.current = true;
      closeRef.current?.focus();
      return;
    }
    if (!wasExpanded.current) return;
    wasExpanded.current = false;
    // The expand control REMOUNTS as the panel goes away, so the node to return
    // to is the new one — the old button was unmounted by the render that
    // opened the panel. `isConnected` covers the closes where it does not come
    // back: the surface stopped being interactive, or the screen went dark.
    if (controlRef.current?.isConnected) controlRef.current.focus();
  }, [expanded]);

  /** Tab cycles within the panel — see the focus effect above. */
  function trapTab(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => !el.hasAttribute("disabled") && el.tabIndex !== -1,
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    // Wrapping both ways, and also when focus is not in the panel at all —
    // otherwise Tab from outside walks the covered page.
    if (e.shiftKey && (active === first || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  // FLIP: start on the tile, end filling the screen.
  useLayoutEffect(() => {
    if (!expanded) return;
    const panel = panelRef.current;
    const from = tileRef.current?.getBoundingClientRect();
    if (!panel || !from) return;

    // Reduced motion still opens and still closes; it just arrives rather than
    // travels.
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduced) return;

    const to = panel.getBoundingClientRect();
    // A zero-sized panel means the layout has not happened yet (jsdom, a
    // display:none ancestor). Dividing by it produces an Infinity scale that
    // pins the panel off-screen for the length of the transition.
    if (to.width < 1 || to.height < 1) return;

    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const sx = from.width / to.width;
    const sy = from.height / to.height;

    panel.style.transformOrigin = "top left";
    panel.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    panel.style.transition = "none";

    // Two frames, exactly as home-grid's useSlideOnMove does it: one to let the
    // browser take the inverted position as the start, one to release it. A
    // single frame is sometimes coalesced with the style write above and the
    // panel appears at full size with no transition at all.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        panel.style.transition = `transform ${OPEN_MS}ms cubic-bezier(0.2, 0.6, 0.2, 1)`;
        panel.style.transform = "none";
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [expanded]);

  /**
   * The affordance, or nothing at all on a wall.
   *
   * Bottom-right rather than top-right: a screen tile's top edge is its label
   * bar, and a control sat on the screen's name is a control that hides the one
   * thing the tile is captioned with.
   */
  function control(title: string): ReactNode {
    if (!enabled || expanded) return null;
    return (
      <button
        ref={controlRef}
        type="button"
        onClick={open}
        aria-label={`Expand ${title}`}
        className="absolute bottom-1 right-1 z-10 flex size-7 items-center justify-center rounded-md border border-line bg-bg/80 text-fg-subtle shadow-sm backdrop-blur transition-colors hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Maximize2Icon className="size-3.5" />
      </button>
    );
  }

  /**
   * @param render called with the PANEL's measured height — 0 until the first
   *   measurement lands, which is one commit. Handing the height to the caller
   *   instead would mean handing it straight back in, and a hook whose output is
   *   also its input is a loop somebody has to trace.
   */
  function overlay(render: (panelH: number) => ReactNode, title: string): ReactNode {
    if (!expanded) return null;
    return createPortal(
      <div
        data-expand-overlay=""
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={trapTab}
        // z-90: above every piece of app chrome (which tops out at z-50) and
        // BELOW the z-100 layer the toasts, context menus and pickers use. An
        // expanded tile still holds live controls, and a toast reporting that
        // one of them failed, painted underneath the panel, is a failure the
        // operator never sees.
        className="fixed inset-0 z-[90] flex flex-col bg-bg/95 p-3 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div
          ref={panelRef}
          className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-2xl"
        >
          <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
            {/* Which tile this came from. A producer wall is a dozen boxes that
                look alike, and a full-screen one with no name on it is a puzzle
                rather than an answer. */}
            <span className="truncate text-caption1 font-semibold uppercase tracking-wider text-fg-subtle">
              {title}
            </span>
            <button
              ref={closeRef}
              type="button"
              onClick={close}
              aria-label={`Close ${title}`}
              className="ml-auto rounded-md p-1.5 text-fg-subtle transition-colors hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <XIcon className="size-4" />
            </button>
          </div>
          <div ref={bodyRef} className="min-h-0 flex-1">
            {render(bodyHeight)}
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  // Only what the tiles use. `open`, `close` and the panel's height are all
  // reachable from inside — through `control`, the overlay's own header and the
  // render callback — and a hook that hands back more surface than anyone calls
  // is surface that drifts.
  return { tileRef, control, overlay };
}
