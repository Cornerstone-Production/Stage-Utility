// companion-pages.tsx — Companion's pages, drawn once, for every screen that shows them.
//
// The Button inspector's Companion pane picks a button from a page; Browse buttons in
// the Companion dialog only looks. They are the same page, so they are the same code:
//
//  - <CompanionPageSelect>: the page dropdown with its arrows. An install can have a
//    hundred pages and more than half are empty, so the list filters by number or name
//    and leaves the empty ones out, and the arrows step over them.
//  - <CompanionPageGrid>: the page as Companion draws it, in its own colours and icons,
//    over its USED extent (never fewer than 8 by 4), scrolling sideways inside its box
//    when the page is wider. With no `pick` every key is a plain div; with one, a key
//    that can be picked is a button.
//
// Companion's look is the `--su-companion-*` tokens and each key's own colours, which
// are Companion's data. Nothing here is a hard-coded colour.
//
// ESCAPE. The list is a popover of its own, inside something that also answers Escape:
// the integration dialog (Radix, a capture-phase listener) and the layout editor's
// inspector. Escape pressed in the list's filter closes the list and nothing behind it:
// it stops the event for a bubble-phase listener, and the list is marked
// `data-escape-first` so a capture-phase owner (the dialog) can see the press began there
// and leave it alone. Focus goes back to the button that opened it.
//
// jsdom loads no stylesheet and measures nothing, so the grid's overflow and the
// popover's placement are driven in a browser, not unit-tested.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import type { CompanionPageKey, CompanionPageSummary, CompanionPageView } from "@main/services/companion-export";
import { plural } from "@main/services/plural";

import { cn } from "../lib/cn";

// ── The page list ────────────────────────────────────────────────────────────

/** The pages worth listing, in page order: an empty page has nothing on it. */
export function listedPages(pages: readonly CompanionPageSummary[] | undefined): CompanionPageSummary[] {
  return (pages ?? []).filter((p) => p.labelled > 0).sort((a, b) => a.page - b.page);
}

/** Pages whose number starts with, or whose name contains, what was typed. A blank filter keeps all. */
export function filterPages(pages: readonly CompanionPageSummary[], typed: string): CompanionPageSummary[] {
  const q = typed.trim().toLowerCase();
  if (!q) return [...pages];
  return pages.filter((p) => String(p.page).startsWith(q) || p.name.toLowerCase().includes(q));
}

/**
 * The listed page next to `page` in a direction, or null at the end of the list.
 * `page` need not be listed: a pick on a page that has since gone empty still steps to
 * the nearest listed one either way, instead of leaving both arrows dead.
 */
export function neighbourPage(pages: readonly CompanionPageSummary[], page: number | null, step: -1 | 1): number | null {
  if (page === null) return null;
  const sorted = pages.map((p) => p.page).sort((a, b) => a - b);
  const found = step === 1 ? sorted.find((n) => n > page) : [...sorted].reverse().find((n) => n < page);
  return found ?? null;
}

/** A page's name, or "Page N" when Companion has not named it. */
export const pageName = (p: Pick<CompanionPageSummary, "page" | "name">): string => p.name.trim() || `Page ${p.page}`;

// ── The page dropdown ────────────────────────────────────────────────────────

const STEP =
  "flex w-8 shrink-0 items-center justify-center rounded-md border border-line-strong text-fg-muted transition-colors " +
  "hover:bg-fill hover:text-fg disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

/** `pages` are the LISTED pages (see listedPages); `page` is the one showing, or null for none. */
export function CompanionPageSelect({
  pages,
  page,
  onPage,
}: {
  pages: readonly CompanionPageSummary[];
  page: number | null;
  onPage: (page: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [hl, setHl] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const shown = useMemo(() => filterPages(pages, typed), [pages, typed]);
  const cur = pages.find((p) => p.page === page);
  const prev = neighbourPage(pages, page, -1);
  const next = neighbourPage(pages, page, 1);

  // An outside press closes it, as a Select does.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  function choose(n: number) {
    onPage(n);
    setOpen(false);
    setTyped("");
  }

  function onFilterKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setHl((h) => Math.max(0, Math.min(shown.length - 1, h + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" && shown[hl]) {
      e.preventDefault();
      choose(shown[hl]!.page);
    } else if (e.key === "Escape") {
      // Closes this list only. See the header.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
  }

  return (
    <div ref={root} className="relative flex items-stretch gap-1">
      <button type="button" aria-label="Previous page" disabled={prev === null} onClick={() => prev !== null && onPage(prev)} className={STEP}>
        <ChevronLeftIcon className="size-4" />
      </button>
      <button
        ref={trigger}
        type="button"
        aria-label="Companion page"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setHl(0);
          setTyped("");
        }}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-line-strong bg-field px-2.5 py-1.5 text-left text-footnote text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {cur ? (
          <>
            <span className="min-w-[2ch] text-right font-mono tabular-nums text-fg-subtle">{cur.page}</span>
            <span className="min-w-0 flex-1 truncate">{pageName(cur)}</span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-fg-subtle">{pages.length ? "Pick a page" : "No pages"}</span>
        )}
        <ChevronDownIcon className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      </button>
      <button type="button" aria-label="Next page" disabled={next === null} onClick={() => next !== null && onPage(next)} className={STEP}>
        <ChevronRightIcon className="size-4" />
      </button>

      {open && (
        <div
          data-escape-first=""
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 flex flex-col gap-1.5 rounded-lg border border-line-strong bg-popover p-1.5 shadow-md"
        >
          <input
            autoFocus
            type="text"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setHl(0);
            }}
            onKeyDown={onFilterKey}
            placeholder="Page number or name"
            aria-label="Filter pages"
            autoComplete="off"
            spellCheck={false}
            className="h-8 w-full rounded-md border border-line-strong bg-field px-2.5 text-footnote text-fg placeholder:text-fg-subtle focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
          />
          <div role="listbox" aria-label="Pages" className="flex max-h-60 flex-col overflow-y-auto">
            {shown.length === 0 ? (
              <p className="px-2 py-1 text-caption1 text-fg-subtle">No page matches</p>
            ) : (
              shown.map((p, i) => (
                <button
                  key={p.page}
                  type="button"
                  role="option"
                  aria-selected={p.page === page}
                  data-page-option={p.page}
                  onClick={() => choose(p.page)}
                  onMouseEnter={() => setHl(i)}
                  ref={(el) => {
                    if (el && i === hl) el.scrollIntoView?.({ block: "nearest" });
                  }}
                  className={cn(
                    "flex items-baseline gap-2 rounded px-2 py-1 text-left text-footnote text-fg",
                    p.page === page ? "bg-accent/12" : i === hl && "bg-fill",
                  )}
                >
                  <span className="min-w-[2ch] text-right font-mono tabular-nums text-fg-subtle">{p.page}</span>
                  <span className="min-w-0 flex-1 truncate">{pageName(p)}</span>
                  <span className="font-mono text-caption2 tabular-nums text-fg-subtle">{p.labelled}</span>
                </button>
              ))
            )}
          </div>
          <p className="px-2 text-caption2 text-fg-subtle">{plural(pages.length, "page")} with buttons · empty pages left out</p>
        </div>
      )}
    </div>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

/** What the grid needs to let keys be picked. Without it the grid is read-only. */
export interface CompanionPick {
  /** A key was picked: where a press goes (a reference's own target, not the reference). */
  onPick: (at: { page: number; row: number; col: number }) => void;
  /** Whether this place is the one already picked. */
  isPicked: (at: { page: number; row: number; col: number }) => boolean;
  /** A write is in flight. */
  disabled?: boolean;
}

/** One key's own words: the label, or what the reference points at. */
function keyTitle(k: CompanionPageKey, page: number): string {
  const where = `p${page} r${k.row} c${k.col}`;
  const what = k.label || "(no label)";
  return k.kind === "reference" ? `${what} · reference · ${where}` : `${what} · ${where}`;
}

/** The blank key: an empty place, a page control, a key that cannot be picked. */
const BLANK = "aspect-square rounded-[3px] bg-(--su-companion-key)";

/** What is drawn on a key, picked or not: its icon, its label, the mark of a reference. */
function KeyFace({ k }: { k: CompanionPageKey }): ReactNode {
  return (
    <>
      {k.icon && <img src={k.icon} alt="" draggable={false} className="min-h-0 max-h-[55%] max-w-full flex-1 object-contain" />}
      <span className={cn("w-full min-w-0 [overflow-wrap:anywhere]", k.icon ? "line-clamp-1" : "line-clamp-3")}>{k.label}</span>
      {k.kind === "reference" && (
        <span
          aria-hidden="true"
          className="absolute right-px top-px rounded-[2px] bg-(--su-companion-canvas)/60 px-[2px] text-[7px] leading-none text-(--su-companion-key-fg)"
        >
          ref
        </span>
      )}
    </>
  );
}

const KEY_CHROME =
  "relative flex aspect-square min-w-0 flex-col items-center justify-center gap-px overflow-hidden rounded-[3px] p-0.5 text-center " +
  "bg-(--su-companion-key) text-(--su-companion-key-fg) text-[9px] font-semibold leading-[1.1]";

/** Companion's own colours for a key: set per key, because they are Companion's, not the app's. */
const colours = (k: CompanionPageKey) => ({
  ...(k.bg ? { backgroundColor: k.bg } : {}),
  ...(k.fg ? { color: k.fg } : {}),
});

export function CompanionPageGrid({ view, pick }: { view: CompanionPageView; pick?: CompanionPick }) {
  const byPlace = useMemo(() => new Map<string, CompanionPageKey>(view.keys.map((k) => [`${k.row},${k.col}`, k])), [view]);
  const cells: ReactNode[] = [];
  for (let r = 0; r < view.rows; r++) {
    for (let c = 0; c < view.cols; c++) {
      const id = `${r},${c}`;
      const k = byPlace.get(id);
      if (!k || k.kind === "page-control") {
        cells.push(<span key={id} aria-hidden="true" className={BLANK} />);
        continue;
      }
      const where = `p${view.page} r${k.row} c${k.col}`;
      if (!pick) {
        cells.push(
          <div key={id} data-companion-key={where} data-key-kind={k.kind} title={keyTitle(k, view.page)} style={colours(k)} className={KEY_CHROME}>
            <KeyFace k={k} />
          </div>,
        );
        continue;
      }
      if (!k.pickable) {
        // Drawn, dimmed, and not a control: it presses nothing.
        cells.push(
          <span key={id} aria-hidden="true" data-companion-key={where} title={keyTitle(k, view.page)} style={colours(k)} className={cn(KEY_CHROME, "opacity-50")}>
            <KeyFace k={k} />
          </span>,
        );
        continue;
      }
      // A reference is picked as what it points at: that is where the press goes.
      const at = k.target ?? { page: view.page, row: k.row, col: k.col };
      const picked = pick.isPicked(at);
      cells.push(
        <button
          key={id}
          type="button"
          role="gridcell"
          data-companion-key={where}
          data-kind={k.kind}
          data-row={k.row}
          data-col={k.col}
          aria-label={keyTitle(k, view.page)}
          aria-pressed={picked}
          title={keyTitle(k, view.page)}
          disabled={pick.disabled}
          onClick={() => pick.onPick(at)}
          style={colours(k)}
          className={cn(
            KEY_CHROME,
            "hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
            picked && "outline outline-2 -outline-offset-2 outline-(--su-companion-key-fg) ring-2 ring-accent",
          )}
        >
          <KeyFace k={k} />
        </button>,
      );
    }
  }
  return (
    <div
      data-page-grid={view.page}
      className="max-w-full overflow-x-auto rounded-md border border-(--su-companion-line) bg-(--su-companion-canvas) p-1"
    >
      <div
        role={pick ? "grid" : "img"}
        aria-label={pick ? `Buttons on page ${view.page}` : `Companion page ${view.page}, ${pageName(view)}, read from Companion's export`}
        className="grid gap-[3px]"
        // Keys keep a minimum size, so a wide page scrolls inside its box rather than shrinking to dots.
        style={{ gridTemplateColumns: `repeat(${view.cols}, minmax(2.25rem, 1fr))` }}
      >
        {cells}
      </div>
    </div>
  );
}
