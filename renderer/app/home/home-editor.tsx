// Home's editor — the controls that sit ON the grid, and the sheet that adds to it.
//
// Editing happens in place: cards stay where they are and grow a size picker and
// a remove button on hover. A separate list of rows would have been easier to
// build and would have shown an arrangement you could not see, which is the
// thing the grid exists to fix.
//
// It replaces the show/hide toggles. Nothing is lost — the palette IS the list
// of widgets that are off — and three things are gained: how big, in what order,
// and when.

import { useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon, GripVerticalIcon } from "lucide-react";

import { LAYOUT_OBJECTS, PALETTE_GROUP_ORDER } from "../../main/layout-objects";
import type { HomeCardSize, HomeVisibility, LayoutObject } from "@main/types/views";
import { DialogOverlay } from "../../components/ui/dialog";
import { cn } from "../../lib/cn";
import { SIZES, SIZE_ORDER, WHEN_LABELS, defaultSize, sizeOf, whenOf } from "./home-cards";

/** Types whose whole purpose is canvas geometry, which Home does not have. */
const CANVAS_ONLY = new Set(["container", "shape"]);

/** The controls drawn over one card while editing. */
export function CardChrome({
  card,
  onSize,
  onWhen,
  onRemove,
  onDragStart,
  onDragOver,
  onDrop,
  dragging,
}: {
  card: LayoutObject;
  onSize: (s: HomeCardSize) => void;
  onWhen: (w: HomeVisibility) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  dragging: boolean;
}) {
  const label = LAYOUT_OBJECTS[card.config.type as keyof typeof LAYOUT_OBJECTS]?.label ?? card.config.type;
  const when = whenOf(card);
  const size = sizeOf(card);
  return (
    <div
      // The whole card is the drag handle and the drop target, so a drag can
      // start and land anywhere on it rather than only on a grip the size of a
      // thumbnail.
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => { e.preventDefault(); onDragOver(); }}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
      className={cn(
        "absolute inset-0 cursor-grab rounded-xl ring-1 ring-inset ring-transparent transition-colors",
        "hover:ring-accent/60 focus-within:ring-accent/60 active:cursor-grabbing",
        dragging && "opacity-40",
      )}
    >
      <span className="absolute left-1.5 top-1.5 text-fg-subtle opacity-0 transition-opacity group-hover/card:opacity-100">
        <GripVerticalIcon className="size-3.5" />
      </span>

      <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-lg border border-line bg-bg/95 p-0.5 opacity-0 shadow-sm backdrop-blur transition-opacity focus-within:opacity-100 group-hover/card:opacity-100">
        {SIZE_ORDER.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSize(s)}
            aria-pressed={s === size}
            aria-label={`${label}: ${SIZES[s].label}`}
            title={`${SIZES[s].label} — ${SIZES[s].w}×${SIZES[s].h}`}
            className={cn(
              "grid h-5 min-w-6 place-items-center rounded-[5px] px-1 text-caption2 font-semibold transition-colors",
              s === size ? "bg-accent text-white" : "text-fg-subtle hover:text-fg",
            )}
          >
            {s.toUpperCase()}
          </button>
        ))}
                <span className="mx-0.5 h-4 w-px bg-line" />
        <select
          value={when}
          onChange={(e) => onWhen(e.target.value as HomeVisibility)}
          aria-label={`${label}: when to show it`}
          className="h-5 rounded-[5px] bg-transparent px-1 text-caption2 text-fg-subtle outline-none hover:text-fg"
        >
          {(Object.keys(WHEN_LABELS) as HomeVisibility[]).map((w) => (
            <option key={w} value={w}>{WHEN_LABELS[w]}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          className="grid h-5 w-5 place-items-center rounded-[5px] text-fg-subtle transition-colors hover:bg-danger-9 hover:text-white"
        >
          <XIcon className="size-3" />
        </button>
      </div>

      {/* Which mood this card belongs to, when it is not "always" — so a card on
          the page today that will vanish on Sunday says so rather than looking
          broken when it goes. */}
      {when !== "always" && (
        <span className="absolute bottom-1.5 left-1.5 rounded-full border border-line bg-bg/90 px-1.5 py-px text-caption2 text-fg-subtle opacity-0 transition-opacity group-hover/card:opacity-100">
          {WHEN_LABELS[when]}
        </span>
      )}
    </div>
  );
}

/** The add sheet: every widget in the app, at any of the four sizes. */
export function AddWidgetSheet({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (type: string, size: HomeCardSize) => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();

  const groups = PALETTE_GROUP_ORDER.map((g) => ({
    group: g,
    items: Object.entries(LAYOUT_OBJECTS)
      .filter(([, s]) => s.group === g && !s.retired)
      // Canvas-only types. A container groups objects so they move and scale
      // together and a shape divides up a screen — both are answers to "where do
      // things sit", which on Home is the grid's job. Offering them here would
      // be offering a control that does nothing.
      .filter(([t]) => !CANVAS_ONLY.has(t))
      .filter(([t, s]) =>
        !needle || s.label.toLowerCase().includes(needle) || t.includes(needle) || s.blurb.toLowerCase().includes(needle),
      ),
  })).filter((g) => g.items.length > 0);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-full max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col",
            "rounded-xl border border-line-strong bg-bg p-5 shadow-xl",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <DialogPrimitive.Title className="text-subheadline font-semibold text-fg">Add a widget</DialogPrimitive.Title>
          <DialogPrimitive.Description className="mb-3 mt-0.5 text-caption1 text-fg-subtle">
            Every widget in the app. Pick a size — the highlighted one is where that widget usually starts.
          </DialogPrimitive.Description>

          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search widgets…"
            className="mb-2 w-full rounded-lg border border-line bg-surface px-3 py-2 text-footnote text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
          />

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {groups.length === 0 && (
              <p className="p-6 text-center text-caption1 text-fg-subtle">Nothing matches “{q}”.</p>
            )}
            {groups.map(({ group, items }) => (
              <div key={group}>
                <p className="px-1 pb-1 pt-3 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
                  {group}
                </p>
                {items.map(([t, spec]) => (
                  <div key={t} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-fill">
                    <span className="min-w-0 flex-1">
                      <span className="block text-footnote font-medium leading-tight text-fg">{spec.label}</span>
                      <span className="block truncate text-caption2 text-fg-subtle">{spec.blurb}</span>
                    </span>
                    <span className="flex shrink-0 gap-1">
                      {SIZE_ORDER.map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => onAdd(t, s)}
                          aria-label={`Add ${spec.label} as ${SIZES[s].label}`}
                          title={`${SIZES[s].label} — ${SIZES[s].w}×${SIZES[s].h}`}
                          className={cn(
                            "rounded-md border px-1.5 py-1 text-caption2 font-semibold transition-colors",
                            s === defaultSize(t)
                              ? "border-accent/50 text-accent hover:bg-accent hover:text-white"
                              : "border-line text-fg-subtle hover:border-fg-subtle hover:text-fg",
                          )}
                        >
                          {s.toUpperCase()}
                        </button>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <DialogPrimitive.Close
            aria-label="Close"
            className="absolute right-3 top-3 grid size-7 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-fill hover:text-fg"
          >
            <XIcon className="size-4" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

