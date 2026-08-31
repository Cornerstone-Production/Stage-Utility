// icon-menu.tsx — the icon set on its own, for a place that has no colour to set.
//
// The Screens cards edit an icon and its colour in ONE panel, because both
// belong to the card. The console rail does not: its icons take the rail's own
// active/inactive colour like every other tab, so a colour control there would
// set something nothing draws. What is left is the set, and this is the smallest
// thing that can host it.
//
// A PORTAL, and that is the point. The rail's rows are <button> elements, and
// the first attempt rendered an interactive control inside one — nested buttons,
// which is invalid, and the outer button swallowed the click and navigated.
// Reported as the page refreshing whenever an icon was touched. Nothing
// interactive goes inside that button now: the row shows a plain glyph, and the
// menu opens beside it from the document body.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { IconGrid } from "./icon-grid";
// The Tab cycle the expanded-tile overlay uses. Focus INTO the menu is IconGrid's
// own: it puts the caret in its search field on mount, because typing is how a
// set that size is used. Focus back out belongs to whoever owns the open state —
// this component is unmounted by the close and cannot restore anything.
import { trapTab } from "../lib/dialog-focus";

/** Roughly the panel's size, for keeping it on screen before it has rendered. */
const W = 268;
const H = 300;

export function IconMenu({
  anchor,
  current,
  onPick,
  onClear,
  onClose,
  label,
}: {
  anchor: HTMLElement | null;
  current?: string | null;
  onPick: (name: string) => void;
  onClear: () => void;
  onClose: () => void;
  label: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Measured after mount rather than guessed, so a menu opened from the bottom
  // of the rail still opens onto something.
  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const h = panel.current?.offsetHeight ?? H;
    const w = panel.current?.offsetWidth ?? W;
    setPos({
      top: Math.max(8, Math.min(r.bottom + 6, window.innerHeight - h - 8)),
      left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)),
    });
  }, [anchor]);

  // Same manners as every other floating panel here.
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (panel.current?.contains(e.target as Node)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={panel}
      data-icon-menu=""
      role="dialog"
      aria-label={label}
      aria-modal="true"
      // Tab cycles inside. A portal is rendered at the END of document.body, so
      // without this a Tab out of the grid landed in the browser chrome and a
      // Shift+Tab walked the whole rail behind the menu.
      onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => trapTab(panel.current, e)}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, width: W, visibility: pos ? "visible" : "hidden" }}
      className="fixed z-[100] rounded-lg border border-line-strong bg-popover/95 p-3 shadow-2xl backdrop-blur-xl"
      // A PORTAL IS NOT AN ESCAPE FROM BUBBLING. React sends events up the
      // REACT tree, not the DOM one, so a click in here still reached the rail
      // row this menu is rendered from — picking an icon navigated to that
      // console. The menu sits over the page and owns its own clicks.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <IconGrid
        current={current}
        onPick={(name) => { onPick(name); onClose(); }}
        onClear={() => { onClear(); onClose(); }}
      />
    </div>,
    document.body,
  );
}
