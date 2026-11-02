// The widget shelf: every widget, under the canvas, for as long as the editor is open.
//
// It replaced a popover over the canvas. A popover covers the thing you are
// placing widgets onto and did not close when you clicked it; a shelf below the
// preview never covers anything. The groups run down the left and the widgets
// fill the right, so one group is a click and the 57 are one scroll.
//
// What a tile looks like and how it drags is palette.tsx's (WidgetIcon,
// usePaletteDrag): the shelf is a second layout of the same tiles, not a second
// implementation of them.

import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import { LAYOUT_OBJECTS, PALETTE_GROUP_ORDER, widgetMatchesQuery, type PaletteGroup } from "../main/layout-objects";
import { cn } from "../lib/cn";
import { Checkbox } from "../components/ui/checkbox";
import { searchShortcutLabel } from "../components/page-tabs";
import { GROUP_ACCENT, WidgetIcon, usePaletteDrag, type PaletteDragHandlers } from "./palette";

/** The `<input>` types that take typed text, so a find-in-field is not stolen. */
const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);

/**
 * Should this keydown open the shelf's search?
 *
 * Cmd/Ctrl+F, with no other modifier. It works from anywhere in the editor --
 * the canvas, a toolbar button, a checkbox -- except from inside a text field
 * that is not the shelf's own search, so someone finding a word inside a
 * textarea or a name box keeps the browser's find.
 */
export function opensShelfSearch(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "target">, searchEl: HTMLElement | null): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return false;
  if (e.key !== "f" && e.key !== "F") return false;
  const t = e.target as HTMLElement | null;
  if (!t || t === searchEl) return true;
  if (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return false;
  if (t.tagName === "INPUT" && !NON_TEXT_INPUTS.has((t as HTMLInputElement).type)) return false;
  return true;
}

export interface WidgetShelfProps extends PaletteDragHandlers {
  /** Types to offer. The caller filters (superseded types, hide-unconfigured). */
  types: LayoutObjectType[];
  onAdd: (t: LayoutObjectType) => void;
  /** Types whose integration is not set up: dimmed, still usable. */
  dimmed: Set<LayoutObjectType>;
  hideUnconfigured: boolean;
  onToggleHideUnconfigured: () => void;
  folded: boolean;
  onFoldedChange: (folded: boolean) => void;
  /** Bumped by the caller to put the cursor in the search box. The caller
   *  unfolds in the same update, so the box exists by the time this is read. */
  focusSignal: number;
  /** Handed to the caller so its keyboard handler can tell the box from any other field. */
  searchRef: React.RefObject<HTMLInputElement | null>;
  /** Escape from an empty search: back to the canvas. */
  onLeave?: () => void;
}

export function WidgetShelf({
  types, onAdd, dimmed, hideUnconfigured, onToggleHideUnconfigured, folded, onFoldedChange,
  focusSignal, searchRef, onLeave, onDragStart, onDragEnd, onDropAt,
}: WidgetShelfProps) {
  const [q, setQ] = useState("");
  // The widget under the pointer or the keyboard, for the readout.
  const [hover, setHover] = useState<LayoutObjectType | null>(null);
  const [current, setCurrent] = useState<PaletteGroup>(PALETTE_GROUP_ORDER[0]);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const shelfRef = useRef<HTMLElement | null>(null);
  // A click on a group scrolls the pane, and every frame of that scroll would
  // otherwise move `current` through the groups on the way. Held until it settles.
  const jumping = useRef(false);
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (jumpTimer.current) clearTimeout(jumpTimer.current); }, []);
  const { tileProps, ghostEl } = usePaletteDrag({ onDragStart, onDragEnd, onDropAt });

  useEffect(() => {
    if (focusSignal === 0) return;
    // The whole shelf, not just the box: focus alone scrolls only the search into
    // view, and on a short window the widgets would stay below the fold.
    shelfRef.current?.scrollIntoView?.({ block: "nearest" });
    searchRef.current?.focus({ preventScroll: true });
  }, [focusSignal, searchRef]);

  const needle = q.trim();
  const sections = PALETTE_GROUP_ORDER.map((group) => ({
    group,
    items: types.filter((t) => LAYOUT_OBJECTS[t]?.group === group && widgetMatchesQuery(t, needle)),
  }));
  const visible = sections.filter((s) => s.items.length > 0);
  const total = types.length;
  // First in the order they are DRAWN, which is what Enter adds.
  const first = visible[0]?.items[0] ?? null;

  function jumpTo(group: PaletteGroup) {
    setCurrent(group);
    const pane = paneRef.current;
    // Compared rather than put in a selector: a group name carries "/" and "&".
    const sec = pane ? [...pane.querySelectorAll<HTMLElement>("[data-section]")].find((el) => el.dataset.section === group) : undefined;
    if (!pane || !sec) return;
    jumping.current = true;
    if (jumpTimer.current) clearTimeout(jumpTimer.current);
    jumpTimer.current = setTimeout(() => { jumping.current = false; }, 500);
    pane.scrollTop = sec.offsetTop - pane.offsetTop;
  }

  function followScroll() {
    const pane = paneRef.current;
    if (!pane || jumping.current) return;
    let best: PaletteGroup | null = null;
    pane.querySelectorAll<HTMLElement>("[data-section]").forEach((sec) => {
      if (sec.offsetTop - pane.offsetTop <= pane.scrollTop + 8) best = sec.dataset.section as PaletteGroup;
    });
    if (best) setCurrent(best);
  }

  if (folded) {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-2 py-1.5">
        <button
          type="button"
          onClick={() => onFoldedChange(false)}
          aria-expanded={false}
          className="flex items-center gap-1 rounded-md border border-line-strong bg-field px-2.5 py-1 text-caption1 font-medium text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          Widgets <ChevronUpIcon className="size-3.5" />
        </button>
        <span className="text-caption1 text-fg-muted">
          <span className="font-mono">{total}</span> widgets · <kbd className="rounded border border-line-strong px-1 font-mono text-caption2">{searchShortcutLabel()}</kbd> to search
        </span>
      </div>
    );
  }

  return (
    <section ref={shelfRef} aria-label="Widgets" className="@container/shelf flex min-w-0 flex-col rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-2 py-1.5">
        <div className="relative min-w-36 max-w-65 flex-[0_1_260px]">
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (first) onAdd(first);
              } else if (e.key === "Escape") {
                e.preventDefault();
                // Clear first; a second Escape hands the keyboard back.
                if (q) setQ("");
                else { e.currentTarget.blur(); onLeave?.(); }
              }
            }}
            type="search"
            placeholder="Search widgets"
            aria-label="Search widgets"
            aria-keyshortcuts="Meta+F Control+F"
            className={cn(
              "h-7.5 w-full rounded-md border border-line-strong bg-field pl-2.5 pr-12 text-footnote text-fg",
              "placeholder:text-fg-subtle outline-none focus-visible:ring-2 focus-visible:ring-focus",
              // Our own hint sits in this corner; the native clear button would
              // sit under it.
              "[&::-webkit-search-cancel-button]:hidden",
            )}
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-line-strong bg-surface px-1 font-mono text-caption2 text-fg-muted">
            {searchShortcutLabel()}
          </kbd>
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-caption1 text-fg-muted">
          <Checkbox checked={hideUnconfigured} onCheckedChange={() => onToggleHideUnconfigured()} className="size-3.5" />
          Hide what is not set up
        </label>
        <button
          type="button"
          onClick={() => onFoldedChange(true)}
          aria-expanded
          className="ml-auto flex items-center gap-1 rounded-md border border-line-strong bg-field px-2.5 py-1 text-caption1 font-medium text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          Fold <ChevronDownIcon className="size-3.5" />
        </button>
      </div>

      <div className="flex h-[206px] min-w-0">
        <nav aria-label="Widget groups" className="flex w-42.5 shrink-0 flex-col gap-px overflow-y-auto border-r border-line p-1 quiet-scroll @max-[640px]/shelf:w-30">
          {sections.map(({ group, items }) => (
            <button
              key={group}
              type="button"
              onClick={() => jumpTo(group)}
              aria-current={current === group}
              data-empty={items.length === 0}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-caption1 font-medium text-fg-muted coarse:min-h-11",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                current === group && "bg-accent/15 text-fg",
                items.length === 0 && "opacity-40",
              )}
            >
              <i aria-hidden="true" className="size-2 shrink-0 rounded-xs" style={{ background: GROUP_ACCENT[group] }} />
              <span className="truncate">{group}</span>
              <span className="ml-auto font-mono text-caption2 text-fg-subtle">{items.length}</span>
            </button>
          ))}
        </nav>
        <div ref={paneRef} onScroll={followScroll} className="min-w-0 flex-1 overflow-y-auto px-1.5 py-1 quiet-scroll motion-safe:scroll-smooth">
          {visible.length === 0 && <p className="p-3 text-footnote text-fg-muted">No widget matches.</p>}
          {visible.map(({ group, items }) => (
            <div key={group} data-section={group} className="mb-1.5">
              <div className="flex items-center gap-1.5 px-1.5 py-1 text-caption2 font-semibold uppercase tracking-wider text-fg-muted">
                <i aria-hidden="true" className="size-2 shrink-0 rounded-xs" style={{ background: GROUP_ACCENT[group] }} />
                {group}
                <span className="ml-auto font-mono normal-case tracking-normal text-fg-subtle">{items.length}</span>
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-x-1.5 gap-y-px">
                {items.map((t) => {
                  const spec = LAYOUT_OBJECTS[t];
                  return (
                    <button
                      key={t}
                      type="button"
                      {...tileProps(t, onAdd)}
                      aria-label={`${spec.label}: ${spec.blurb}`}
                      onMouseEnter={() => setHover(t)}
                      onMouseLeave={() => setHover((h) => (h === t ? null : h))}
                      onFocus={() => setHover(t)}
                      onBlur={() => setHover((h) => (h === t ? null : h))}
                      className={cn(
                        "flex w-full min-w-0 cursor-grab items-center gap-2 rounded-md px-1.5 py-1 text-left coarse:min-h-11",
                        "transition-colors duration-(--motion-instant) hover:bg-fill active:cursor-grabbing",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                        dimmed.has(t) && "opacity-45",
                        // Enter will add this one, so say so.
                        needle && t === first && "ring-1 ring-inset ring-accent",
                      )}
                    >
                      <WidgetIcon type={t} className="size-5.5" iconClassName="size-3.5" />
                      <span className="truncate text-footnote font-medium text-fg">{spec.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div aria-live="polite" className="flex min-h-7 items-center gap-2 border-t border-line px-2.5 py-1 text-caption1 text-fg-muted">
        {hover ? (
          <>
            <b className="font-semibold text-fg">{LAYOUT_OBJECTS[hover].label}</b>
            <span className="truncate">
              {LAYOUT_OBJECTS[hover].blurb}
              {dimmed.has(hover) && " · its integration is not set up, so it will show nothing yet"}
            </span>
          </>
        ) : needle && first ? (
          <>
            <span>Enter adds</span>
            <b className="font-semibold text-fg">{LAYOUT_OBJECTS[first].label}</b>
          </>
        ) : (
          <span>Hover a widget to read what it shows.</span>
        )}
      </div>
      {ghostEl}
    </section>
  );
}
