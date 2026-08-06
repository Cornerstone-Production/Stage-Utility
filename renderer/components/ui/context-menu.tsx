// A right-click menu, drawn by us.
//
// It cannot be the system menu: a web page can only SUPPRESS the browser's
// context menu, never add to it. So this is styled to sit beside macOS's own —
// translucent, hairline-bordered, tight type, shortcut hints right-aligned — and
// behaves like one: Escape closes, a click anywhere else closes, and it flips
// rather than running off the screen.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

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
  /** Nested items. A submenu opens on hover, like the platform menus do. */
  items?: ContextMenuItem[];
}

const ITEM_CLS =
  "flex w-full items-center gap-2 rounded-[5px] px-2 py-[3px] text-left text-footnote " +
  "text-fg outline-none disabled:pointer-events-none disabled:text-fg-subtle";

function MenuList({
  items,
  onClose,
  depth = 0,
}: {
  items: ContextMenuItem[];
  onClose: () => void;
  depth?: number;
}) {
  const [openSub, setOpenSub] = useState<number | null>(null);

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
          <div
            key={item.label ?? i}
            className="relative"
            onMouseEnter={() => setOpenSub(i)}
            onMouseLeave={() => setOpenSub((cur) => (cur === i ? null : cur))}
          >
            <button type="button" className={cn(ITEM_CLS, "hover:bg-fill-active")} role="menuitem">
              {item.icon}
              <span className="flex-1 truncate">{item.label}</span>
              <span className="text-fg-subtle">›</span>
            </button>
            {openSub === i && (
              // Submenus open to the right, and to the LEFT once there is not room —
              // a menu opened near the right edge is the common case on a wide canvas.
              <div
                className={cn(
                  "absolute top-0 z-10",
                  depth > 0 || typeof window === "undefined" ? "left-full" : "left-full",
                )}
                style={{ marginLeft: 2 }}
              >
                <MenuList items={item.items} onClose={onClose} depth={depth + 1} />
              </div>
            )}
          </div>
        ) : (
          <button
            key={item.label ?? i}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={cn(
              ITEM_CLS,
              !item.disabled && (item.danger ? "hover:bg-warn-9 hover:text-white" : "hover:bg-fill-active"),
            )}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect?.();
              onClose();
            }}
          >
            {item.icon}
            <span className="flex-1 truncate">{item.label}</span>
            {item.shortcut && <span className="ml-3 tabular-nums text-fg-subtle">{item.shortcut}</span>}
          </button>
        ),
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
    const close = () => onClose();
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
