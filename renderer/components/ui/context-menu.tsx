// A right-click menu, drawn by us.
//
// It cannot be the system menu: a web page can only SUPPRESS the browser's
// context menu, never add to it. So this is styled to sit beside macOS's own —
// translucent, hairline-bordered, tight type, shortcut hints right-aligned — and
// behaves like one: Escape closes, a click anywhere else closes, and it flips
// rather than running off the screen.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon } from "lucide-react";

import { cn } from "../../lib/cn";

export interface ContextMenuItem {
  /** A separator; every other field is ignored. */
  separator?: boolean;
  label?: string;
  /** Right-aligned hint, e.g. "⌘C". Never a control — purely a reminder. */
  shortcut?: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onSelect?: () => void;
  /**
   * A checkable item, showing a tick when on.
   *
   * The menu STAYS OPEN when one is picked, the way a platform menu of view
   * options does — turning three things off is three right-clicks otherwise.
   * `onSelect` must therefore be safe to call repeatedly.
   */
  checked?: boolean;
  /** Nested items. A submenu opens on hover, like the platform menus do. */
  items?: ContextMenuItem[];
}

const ITEM_CLS =
  "flex w-full items-center gap-2 rounded-[5px] px-2 py-[3px] text-left text-footnote " +
  "text-fg outline-none disabled:pointer-events-none disabled:text-fg-subtle";

function MenuList({ items, onClose }: { items: ContextMenuItem[]; onClose: () => void }) {
  return (
    <div
      className={cn(
        "min-w-[190px] rounded-[9px] border border-line-strong p-1 shadow-2xl",
        "bg-popover/95 backdrop-blur-xl",
      )}
      role="menu"
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={`sep-${i}`} className="my-1 h-px bg-line" role="separator" />
        ) : item.items?.length ? (
          <SubmenuItem
            key={item.label ?? i}
            item={item as ContextMenuItem & { items: ContextMenuItem[] }}
            onClose={onClose}
          />
        ) : (
          <button
            key={item.label ?? i}
            type="button"
            role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={item.checked}
            disabled={item.disabled}
            className={cn(
              ITEM_CLS,
              // danger → red, not amber. `warn` is caution ("unsaved changes");
              // `danger` is destructive ("this deletes something"). Delete was
              // highlighting amber, which reads as a warning you can proceed
              // through rather than the last step before losing work.
              !item.disabled && (item.danger ? "hover:bg-danger-9 hover:text-white" : "hover:bg-fill-active"),
            )}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect?.();
              // A checkable item leaves the menu open — see `checked`.
              if (item.checked === undefined) onClose();
            }}
          >
            {item.checked === undefined ? (
              item.icon
            ) : (
              // A fixed-width gutter rather than a conditional tick, so the
              // labels in a list of toggles line up whatever is on.
              //
              // CheckIcon, not a literal ✓. Every other tick in the app is that
              // icon; a text glyph renders at the font's own weight and sits on
              // its own baseline, so it read lighter and lower than the ticks
              // next to it.
              <span className="flex w-3 shrink-0 items-center justify-center text-accent" aria-hidden>
                {item.checked ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
              </span>
            )}
            <span className="flex-1 truncate">{item.label}</span>
            {item.shortcut && <span className="ml-3 tabular-nums text-fg-subtle">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}

/**
 * One item that opens a submenu on hover — pulled out of `MenuList`'s
 * `.map()` because each one needs its OWN ref and its OWN open/flip state,
 * not a shared array of them keyed by index.
 *
 * Opens to the right and down by default, and flips to whichever side of
 * ITSELF actually has room once the real size is known — measured, not
 * estimated, for the same reason the root menu's own flip is (see
 * `ContextMenu` below): the item list is caller-supplied and its size
 * varies, from a two-line toggle to a long "Metric" list a multi-band
 * Smaart rig reports.
 *
 * Local `open` state also drops the race the old shared-index version
 * needed a defensive check for: if this item's mouseleave and a sibling's
 * mouseenter land in the order enter-then-leave, a single shared "which one
 * is open" index has the leave clobber the sibling's just-set value back to
 * closed. Two independent booleans have nothing to clobber.
 */
function SubmenuItem({
  item,
  onClose,
}: {
  item: ContextMenuItem & { items: ContextMenuItem[] };
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<{ h: "left" | "right"; v: "up" | "down" }>({ h: "right", v: "down" });

  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    setSide({
      h: r.right > window.innerWidth - pad ? "left" : "right",
      v: r.bottom > window.innerHeight - pad ? "up" : "down",
    });
  }, [open, item.items]);

  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className={cn(ITEM_CLS, "hover:bg-fill-active")} role="menuitem">
        {item.icon}
        <span className="flex-1 truncate">{item.label}</span>
        <span className="text-fg-subtle">›</span>
      </button>
      {open && (
        <div
          ref={ref}
          className={cn(
            "absolute z-10",
            side.h === "right" ? "left-full" : "right-full",
            side.v === "down" ? "top-0" : "bottom-0",
          )}
          style={{ [side.h === "right" ? "marginLeft" : "marginRight"]: 2 }}
        >
          <MenuList items={item.items} onClose={onClose} />
        </div>
      )}
    </div>
  );
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Flip back inside the viewport once the real size is known. Measured rather
  // than estimated: the item list is caller-supplied and its height varies.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    setPos({
      left: x + r.width > window.innerWidth - pad ? Math.max(pad, x - r.width) : x,
      top: y + r.height > window.innerHeight - pad ? Math.max(pad, y - r.height) : y,
    });
  }, [x, y, items]);

  useEffect(() => {
    // Dismiss on a pointerdown OUTSIDE the menu.
    //
    // The `contains` check is the whole fix: this listener runs in the capture
    // phase, so an unfiltered close() fired on the pointerdown of a click on a
    // menu ITEM, unmounting the menu before the click could reach the button.
    // Every item — Delete, Copy, Duplicate, Add object — looked normal, hovered
    // normally, and did nothing at all.
    const close = (e: Event) => {
      const target = e.target as Node | null;
      if (target && ref.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    // Capture phase: close before the canvas beneath can act on the same click,
    // so dismissing the menu never also starts a selection or moves an object.
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("wheel", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-[100]"
      style={{ left: pos.left, top: pos.top }}
      // The menu's own clicks must not reach the window listener above.
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuList items={items} onClose={onClose} />
    </div>
  );
}
