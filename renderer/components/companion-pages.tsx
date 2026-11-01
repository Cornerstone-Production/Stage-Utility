// companion-pages.tsx — Companion's pages, drawn once, for every screen that shows them.
//
// The Button inspector's Companion pane picks a button from a page; Browse buttons in
// the Companion dialog only looks. They are the same page, so they are the same code:
//
//  - <CompanionPageSelect>: the page dropdown with its arrows. An install can have a
//    hundred pages and more than half are empty, so the list filters by number or name
//    and leaves the empty ones out, and the arrows step over them.
//  - <CompanionPageGrid>: the page as Companion draws it, in its own colours and icons,
//    over its USED extent (never fewer than 8 by 4). The columns are `minmax(0, 1fr)`:
//    keys shrink to fit the box and the page never scrolls sideways. Under it a readout
//    names the hovered or focused key in full (a key's own label is clipped), and at
//    rest the picked one. With no `pick` every key is a plain div; with one, a key
//    that can be picked is a button.
//  - <CompanionPageBody>: one page's grid, read from the server, for every screen that
//    draws a page it can pick from (the inspector, its large dialog).
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
// jsdom loads no stylesheet and measures nothing, so the keys' size, the grid fitting its
// box and the popover's placement are driven in a browser, not unit-tested.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import type { CompanionPageKey, CompanionPageSummary, CompanionPageView } from "@main/services/companion-export";
import { errorMessage } from "@main/services/errors";
import { plural } from "@main/services/plural";

import { invoke } from "../lib/api";
import { cn } from "../lib/cn";
import { ErrorNote } from "./ui";

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
  /** The picked key when it is on another page, so the readout can still name it at rest. */
  current?: { text: string; page: number; row: number; col: number } | null;
  /**
   * Tick mode: a click toggles a key instead of choosing one, so any number can be picked
   * (`isPicked` is "ticked" and a ticked key wears a check). A key `isOffered` says no to is
   * drawn dimmed and is not a control; one that is `isLocked` (already imported) is drawn,
   * marked, and cannot be ticked.
   */
  tick?: {
    isOffered: (at: { page: number; row: number; col: number }) => boolean;
    isLocked: (at: { page: number; row: number; col: number }) => boolean;
  };
}

/** What a key says, on one line: its text as Companion draws it, line breaks as spaces. */
export const keyText = (k: Pick<CompanionPageKey, "text">): string => k.text.replace(/\s*\n\s*/g, " ");

/** One key's own words: its text, or what the reference points at. */
function keyTitle(k: CompanionPageKey, page: number): string {
  const where = `p${page} r${k.row} c${k.col}`;
  const what = keyText(k) || "(no label)";
  return k.kind === "reference" ? `${what} · reference · ${where}` : `${what} · ${where}`;
}

/** The blank key: an empty place, a page control, a key that cannot be picked. */
const BLANK = "aspect-square rounded-[3px] bg-(--su-companion-key)";

/** What is drawn on a key, picked or not: its icon, its label, the mark of a reference. */
function KeyFace({ k, large }: { k: CompanionPageKey; large: boolean }): ReactNode {
  return (
    <>
      {k.icon && <img src={k.icon} alt="" draggable={false} className="min-h-0 max-h-[55%] max-w-full flex-1 object-contain" />}
      <span
        className={cn(
          "w-full min-w-0 whitespace-pre-line [overflow-wrap:anywhere]",
          k.icon ? "line-clamp-1" : large ? "line-clamp-4" : "line-clamp-3",
          // Companion's own size, when it has one. It is set here and not on the key, because a
          // container-query unit on the container itself resolves against the container ABOVE
          // it, which is no container at all.
          k.size !== null && (large ? OWN_SIZE_LARGE : OWN_SIZE),
        )}
      >
        {k.text}
      </span>
      {k.kind === "reference" && (
        <span
          aria-hidden="true"
          className="absolute left-px top-px rounded-[2px] bg-(--su-companion-canvas)/60 px-[2px] text-[7px] leading-none text-(--su-companion-key-fg)"
        >
          ref
        </span>
      )}
    </>
  );
}

const KEY_CHROME =
  "relative flex aspect-square min-w-0 flex-col items-center justify-center gap-px overflow-hidden rounded-[3px] p-0.5 text-center " +
  "bg-(--su-companion-key) text-(--su-companion-key-fg) font-semibold leading-[1.1] [container-type:inline-size]";

/**
 * Auto-fit text is a fixed small size. Companion's own size is its percentage of a 60 point
 * key: 14 points (23.3) on a 72 pixel key is 14 pixels, so a percentage is 0.83% of the key's
 * width. It never goes under the auto-fit size: a key drawn at a third of its real size would
 * otherwise carry type nobody can read, and the readout under the grid says the rest.
 */
const AUTO_SIZE = "text-[9px]";
const OWN_SIZE = "text-[length:max(9px,calc(var(--key-size)*0.83cqw))]";
/** The same, in the large dialog, where there is room to read a label in full. */
const AUTO_SIZE_LARGE = "text-[12px]";
const OWN_SIZE_LARGE = "text-[length:max(12px,calc(var(--key-size)*0.83cqw))]";

/** WCAG relative luminance of a #rrggbb colour, or null when it is not one. */
function luminance(hex: string): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** --su-companion-key in styles.css: what a key with no background of its own is drawn on. */
const DEFAULT_KEY_BG = "#1c1c1c";

/** Below this a label is not readable. Companion draws such a key by letting a feedback set the live text colour. */
const MIN_TEXT_CONTRAST = 2;

/**
 * The text colour a key is drawn in. A button's own text colour is often the same as its
 * background (black on black) because a feedback sets the real one live, and an export
 * carries only the static look: with under 2:1 between them the text is drawn in white or
 * black, whichever contrasts with the background.
 */
export function readableText(bg: string | null, fg: string | null): string | null {
  if (!fg) return fg;
  // No colour of its own: the key is drawn on --su-companion-key.
  const b = luminance(bg ?? DEFAULT_KEY_BG);
  const f = luminance(fg);
  if (b === null || f === null || contrast(b, f) >= MIN_TEXT_CONTRAST) return fg;
  return contrast(b, 1) >= contrast(b, 0) ? "#ffffff" : "#000000";
}

const ALIGN_H = { left: "flex-start", center: "center", right: "flex-end" } as const;
const ALIGN_V = { top: "flex-start", center: "center", bottom: "flex-end" } as const;

/**
 * Companion's own look for a key, set per key because it is Companion's, not the app's:
 * its colours, where its text sits, and (as a custom property the size class reads) its size.
 */
const colours = (k: CompanionPageKey): CSSProperties => {
  const fg = readableText(k.bg, k.fg);
  return {
    ...(k.bg ? { backgroundColor: k.bg } : {}),
    ...(fg ? { color: fg } : {}),
    ...(k.halign ? { alignItems: ALIGN_H[k.halign], textAlign: k.halign } : {}),
    ...(k.valign ? { justifyContent: ALIGN_V[k.valign] } : {}),
    ...(k.size !== null ? ({ "--key-size": k.size } as CSSProperties) : {}),
  };
};

/** The size class of a key; a key with a size of its own overrides it on its text (see KeyFace). */
const sizeClass = (large: boolean): string => (large ? AUTO_SIZE_LARGE : AUTO_SIZE);

export function CompanionPageGrid({ view, pick, size }: { view: CompanionPageView; pick?: CompanionPick; size?: "large" }) {
  const large = size === "large";
  const byPlace = useMemo(() => new Map<string, CompanionPageKey>(view.keys.map((k) => [`${k.row},${k.col}`, k])), [view]);
  // The key the pointer is over or focus is on: the readout names it in full.
  const [active, setActive] = useState<string | null>(null);
  const hover = (id: string) => ({
    onMouseEnter: () => setActive(id),
    onFocus: () => setActive(id),
    onMouseLeave: () => setActive((a) => (a === id ? null : a)),
    onBlur: () => setActive((a) => (a === id ? null : a)),
  });
  const cells: ReactNode[] = [];
  let pickedKey: CompanionPageKey | null = null;
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
          <div key={id} data-companion-key={where} data-key-kind={k.kind} title={keyTitle(k, view.page)} style={colours(k)} className={cn(KEY_CHROME, sizeClass(large))} {...hover(id)}>
            <KeyFace k={k} large={large} />
          </div>,
        );
        continue;
      }
      // A reference is picked as what it points at: that is where the press goes.
      const at = k.target ?? { page: view.page, row: k.row, col: k.col };
      if (!k.pickable || (pick.tick && !pick.tick.isOffered(at))) {
        // Drawn, dimmed, and not a control: it presses (or imports) nothing.
        cells.push(
          <span key={id} aria-hidden="true" data-companion-key={where} title={keyTitle(k, view.page)} style={colours(k)} className={cn(KEY_CHROME, sizeClass(large), "opacity-50")} {...hover(id)}>
            <KeyFace k={k} large={large} />
          </span>,
        );
        continue;
      }
      if (pick.tick?.isLocked(at)) {
        // Already imported: marked, and not a control.
        cells.push(
          <span
            key={id}
            role="img"
            data-companion-key={where}
            data-imported=""
            aria-label={`${keyTitle(k, view.page)} · already imported`}
            title={`${keyTitle(k, view.page)} · already imported`}
            style={colours(k)}
            className={cn(KEY_CHROME, sizeClass(large), "opacity-60")}
            {...hover(id)}
          >
            <KeyFace k={k} large={large} />
            <span aria-hidden="true" className="absolute inset-x-0 bottom-0 bg-(--su-companion-canvas)/70 text-center text-[7px] leading-tight text-(--su-companion-key-fg)">
              imported
            </span>
          </span>,
        );
        continue;
      }
      const picked = pick.isPicked(at);
      // The readout names the key itself rather than a reference to it, when both are drawn.
      if (picked && (pickedKey === null || (pickedKey.kind === "reference" && k.kind !== "reference"))) pickedKey = k;
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
            sizeClass(large),
            "hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
            picked && (pick.tick ? "ring-2 ring-inset ring-accent" : "outline outline-2 -outline-offset-2 outline-(--su-companion-key-fg) ring-2 ring-accent"),
          )}
          {...hover(id)}
        >
          <KeyFace k={k} large={large} />
          {pick.tick && picked && (
            <span aria-hidden="true" data-ticked="" className="absolute right-0.5 top-0.5 flex size-[11px] items-center justify-center rounded-[3px] bg-accent text-on-accent">
              <CheckIcon className="size-2" strokeWidth={3} />
            </span>
          )}
        </button>,
      );
    }
  }

  // What the line under the grid says: the key being looked at, else the picked one.
  const looked = active !== null ? byPlace.get(active) : undefined;
  const shown = looked
    ? { text: keyText(looked), where: `p${view.page} r${looked.row} c${looked.col}${looked.kind === "reference" ? " · ref" : ""}` }
    : pick?.tick
      ? null // many keys are ticked, so there is no one key to name at rest
      : pickedKey
        ? { text: keyText(pickedKey), where: `p${view.page} r${pickedKey.row} c${pickedKey.col}` }
        : pick?.current
          ? { text: pick.current.text, where: `p${pick.current.page} r${pick.current.row} c${pick.current.col}` }
          : null;

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-1.5">
      <div data-page-grid={view.page} className="max-w-full rounded-md border border-(--su-companion-line) bg-(--su-companion-canvas) p-1">
        <div
          role={pick ? "grid" : "img"}
          aria-label={pick ? `Buttons on page ${view.page}` : `Companion page ${view.page}, ${pageName(view)}, read from Companion's export`}
          className="grid gap-[3px]"
          // minmax(0, ...): a key has no minimum width, so the page shrinks to its box and never scrolls sideways.
          style={{ gridTemplateColumns: `repeat(${view.cols}, minmax(0, 1fr))` }}
        >
          {cells}
        </div>
      </div>
      <div data-key-readout="" className={cn("flex min-h-[34px] items-start justify-between gap-2 text-caption1 text-fg-muted", large && "text-footnote")}>
        {shown ? (
          <>
            <b className="min-w-0 font-semibold text-fg [overflow-wrap:anywhere]">{shown.text || "(no label)"}</b>
            <span className="shrink-0 whitespace-nowrap font-mono text-caption2 tabular-nums">{shown.where}</span>
          </>
        ) : (
          <span>Hover a key to read its full name.</span>
        )}
      </div>
    </div>
  );
}

/** The reply of `companion:page`: a page's keys, or the one sentence that says why there are none. */
type PageReply = ({ ok: true } & CompanionPageView) | { ok: false; reason: string };

/**
 * What stands under a page dropdown: the page's grid, or the one line that says why
 * there is none. `reading` is the button list still being read, which the page waits for.
 */
export function CompanionPageBody({
  page,
  reading,
  pick,
  size,
}: {
  page: number | null;
  reading: boolean;
  pick?: CompanionPick;
  size?: "large";
}) {
  const query = useQuery({
    queryKey: ["companion:page", page],
    queryFn: () => invoke<PageReply>("companion:page", { page }),
    enabled: page !== null && !reading,
  });
  const quiet = "py-3 text-center text-caption1 text-fg-muted";
  if (reading) return <p className={quiet}>Reading Companion…</p>;
  // Checked before the query: with no page there is nothing to ask for, and a disabled
  // query reads as pending for ever.
  if (page === null) return <p className={quiet}>Companion has no page with buttons on it.</p>;
  if (query.isPending) return <p className={quiet}>Reading Companion…</p>;
  if (query.isError) return <ErrorNote>Could not read page {page}: {errorMessage(query.error)}</ErrorNote>;
  const view = query.data;
  if (!view) return <p className={quiet}>Companion has no page with buttons on it.</p>;
  if (!view.ok) return <ErrorNote>Could not read page {page}: {view.reason}</ErrorNote>;
  return <CompanionPageGrid view={view} pick={pick} size={size} />;
}
