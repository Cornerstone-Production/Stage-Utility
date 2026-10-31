// companion-pane.tsx — pick a Companion button for a Button.
//
// Three ways to the same button, all reading the live Companion export: a search
// over every label on every page, a page dropdown with previous and next arrows
// (an install can have a hundred pages, so the dropdown filters by number or name
// and leaves empty pages out), and the page itself drawn as Companion draws it,
// with its own colours and icons. There are no typed coordinates: a button that is
// not in the export cannot be pressed safely, because the fingerprint refuses it.
//
// The grid shows the page's USED extent, never fewer than 8 by 4, and scrolls
// sideways inside the panel when a page is wider than the panel. A page control
// (page number, up, down) is drawn as a blank key and cannot be picked; a
// reference key is drawn as the button it points at, marked as a reference, and
// picking it presses the reference's own target, as Companion does.
//
// jsdom loads no stylesheet and measures nothing, so the grid's overflow and the
// popover's placement are not unit-tested: they were driven in a browser. What is
// tested is which key a click picks and what it writes.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, SearchIcon } from "lucide-react";

import type { CompanionPageKey, CompanionPageSummary, CompanionPageView } from "@main/services/companion-export";
import { errorMessage } from "@main/services/errors";

import { ErrorNote } from "../components/ui";
import { invoke } from "../lib/api";
import { cn } from "../lib/cn";
import { companionButtonsQuery } from "../lib/companion-buttons";
import { fingerprintFor, type CompanionButton } from "../settings/sections/companion-cues";
import { COMPANION_PRESS, type PressTarget } from "./owned-press";

type PageReply = ({ ok: true } & CompanionPageView) | { ok: false; reason: string };

/** Where the picked button is: the coordinates stored on the Button's own rule. */
export interface PickedCompanion {
  page: number;
  row: number;
  col: number;
  label: string;
}

const MAX_RESULTS = 40;

/** The press action for a picked button, with the identity the reconcile compares. */
export function pressTargetFor(b: CompanionButton): PressTarget {
  return { name: b.label || `p${b.page} r${b.row} c${b.col}`, action: { id: COMPANION_PRESS, params: fingerprintFor(b) } };
}

/** The pages worth listing: an empty page has nothing to pick. */
export function listedPages(pages: readonly CompanionPageSummary[] | undefined): CompanionPageSummary[] {
  return (pages ?? []).filter((p) => p.labelled > 0);
}

/**
 * The listed page next to `page` in a direction, or null at the end of the list.
 * `page` need not be listed: a pick on a page that has since gone empty still steps
 * to the nearest listed one either way, instead of leaving both arrows dead.
 */
export function neighbourPage(pages: readonly CompanionPageSummary[], page: number | null, d: -1 | 1): number | null {
  const sorted = pages.map((p) => p.page).sort((a, b) => a - b);
  if (page === null) return null;
  const found = d === 1 ? sorted.find((n) => n > page) : [...sorted].reverse().find((n) => n < page);
  return found ?? null;
}

/** Pages whose number starts with, or whose name contains, what was typed. */
export function matchingPages(pages: readonly CompanionPageSummary[], typed: string): CompanionPageSummary[] {
  const q = typed.trim().toLowerCase();
  if (!q) return [...pages];
  return pages.filter((p) => String(p.page).startsWith(q) || p.name.toLowerCase().includes(q));
}

/** Labelled buttons whose text contains what was typed, in page order. */
export function matchingButtons(buttons: readonly CompanionButton[], typed: string): CompanionButton[] {
  const q = typed.trim().toLowerCase();
  if (!q) return [];
  return buttons.filter((b) => b.label.toLowerCase().includes(q));
}

export function CompanionPane({
  current,
  onPick,
  disabled,
}: {
  current: PickedCompanion | null;
  onPick: (target: PressTarget) => void;
  /** A write is in flight. */
  disabled?: boolean;
}) {
  const buttonsQ = useQuery(companionButtonsQuery);
  const reply = buttonsQ.data;
  const pages = useMemo(() => listedPages(reply?.pages), [reply]);
  const [chosen, setChosen] = useState<number | null>(null);
  const page = chosen ?? current?.page ?? pages[0]?.page ?? null;

  const pageQ = useQuery({
    queryKey: ["companion:page", page],
    queryFn: () => invoke<PageReply>("companion:page", { page }),
    enabled: page !== null && reply?.ok === true,
  });

  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const hits = useMemo(() => matchingButtons(reply?.buttons ?? [], typed), [reply, typed]);

  function pickAt(at: { page: number; row: number; col: number }) {
    const found = reply?.buttons.find((b) => b.page === at.page && b.row === at.row && b.col === at.col);
    if (!found) {
      // The page was drawn from one read and the list from another, five minutes apart at worst.
      setProblem("That button is not in the list Stage Utility last read from Companion. Refresh it under Settings, Integrations, Companion.");
      return;
    }
    setProblem(null);
    onPick(pressTargetFor(found));
  }

  if (buttonsQ.isError) {
    return <ErrorNote>Could not read Companion: {errorMessage(buttonsQ.error)}</ErrorNote>;
  }
  if (reply && !reply.ok) {
    // A picker that drew an empty page here would read as a Companion with nothing on it.
    return (
      <ErrorNote>
        Could not read Companion&rsquo;s configuration{reply.reason ? `: ${reply.reason}` : ""}. Set the host under Settings, Integrations,
        Companion.
      </ErrorNote>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2" data-companion-pane>
      <span className="relative block">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Find a button by label"
          aria-label="Find a Companion button"
          className="h-8 w-full rounded-md border border-line-strong bg-field pl-8 pr-2.5 text-footnote text-fg placeholder:text-fg-subtle focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
        />
      </span>
      {typed.trim() !== "" && (
        <div role="group" aria-label="Matching buttons" className="flex max-h-40 flex-col overflow-y-auto rounded-md border border-line">
          {hits.length === 0 ? (
            <p className="px-2.5 py-1.5 text-caption1 text-fg-muted">No labelled button matches.</p>
          ) : (
            hits.slice(0, MAX_RESULTS).map((b) => (
              <button
                key={`${b.page}-${b.row}-${b.col}`}
                type="button"
                disabled={disabled}
                onClick={() => {
                  setChosen(b.page);
                  setTyped("");
                  pickAt(b);
                }}
                className="flex min-w-0 items-baseline justify-between gap-2 border-b border-line px-2.5 py-1.5 text-left text-caption1 text-fg last:border-b-0 hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <span className="min-w-0 truncate">{b.label}</span>
                <span className="shrink-0 font-mono text-caption2 text-fg-subtle">
                  {b.pageName} · p{b.page} r{b.row} c{b.col}
                </span>
              </button>
            ))
          )}
          {hits.length > MAX_RESULTS && (
            <p className="px-2.5 py-1.5 text-caption2 text-fg-subtle">{hits.length - MAX_RESULTS} more. Type more of the label.</p>
          )}
        </div>
      )}

      <PageSelect
        pages={pages}
        page={page}
        canPrev={neighbourPage(pages, page, -1) !== null}
        canNext={neighbourPage(pages, page, 1) !== null}
        onPage={setChosen}
        onStep={(d) => {
          const next = neighbourPage(pages, page, d);
          if (next !== null) setChosen(next);
        }}
      />

      <PageBody
        reading={!reply}
        page={page}
        query={pageQ}
        current={current}
        disabled={disabled}
        onPick={pickAt}
      />

      {problem && <ErrorNote>{problem}</ErrorNote>}
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-caption1 text-fg-muted">
        <span className="min-w-0 truncate">{current ? current.label || "Picked" : "Pick a button"}</span>
        {current && (
          <span className="font-mono text-caption2">
            page {current.page} · row {current.row} · column {current.col}
          </span>
        )}
      </div>
    </div>
  );
}

/** What stands under the page dropdown: the page's grid, or the one line that says why there is none. */
function PageBody({
  reading,
  page,
  query,
  current,
  disabled,
  onPick,
}: {
  /** The button list has not answered yet. */
  reading: boolean;
  page: number | null;
  query: UseQueryResult<PageReply>;
  current: PickedCompanion | null;
  disabled?: boolean;
  onPick: (at: { page: number; row: number; col: number }) => void;
}) {
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
  return <PageGrid view={view} current={current} disabled={disabled} onPick={onPick} />;
}

/** The page dropdown with its arrows: filter by number or name, empty pages left out. */
function PageSelect({
  pages,
  page,
  canPrev,
  canNext,
  onPage,
  onStep,
}: {
  pages: readonly CompanionPageSummary[];
  page: number | null;
  canPrev: boolean;
  canNext: boolean;
  onPage: (n: number) => void;
  onStep: (delta: -1 | 1) => void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [hl, setHl] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => matchingPages(pages, typed), [pages, typed]);
  const cur = pages.find((p) => p.page === page);

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

  const stepCls =
    "flex w-8 shrink-0 items-center justify-center rounded-md border border-line-strong text-fg-muted transition-colors " +
    "hover:bg-fill hover:text-fg disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

  return (
    <div ref={root} className="relative flex items-stretch gap-1">
      <button type="button" aria-label="Previous page" disabled={!canPrev} onClick={() => onStep(-1)} className={stepCls}>
        <ChevronLeftIcon className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Companion page"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setHl(0);
          requestAnimationFrame(() => filter.current?.focus());
        }}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-line-strong bg-field px-2.5 py-1.5 text-left text-footnote text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {cur ? (
          <>
            <span className="min-w-[2ch] text-right font-mono text-fg-subtle">{cur.page}</span>
            <span className="min-w-0 flex-1 truncate">{cur.name}</span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-fg-subtle">{pages.length ? "Pick a page" : "No pages"}</span>
        )}
        <ChevronDownIcon className="size-3.5 shrink-0 text-fg-subtle" />
      </button>
      <button type="button" aria-label="Next page" disabled={!canNext} onClick={() => onStep(1)} className={stepCls}>
        <ChevronRightIcon className="size-4" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 flex flex-col gap-1.5 rounded-lg border border-line-strong bg-popover p-1.5 shadow-md">
          <input
            ref={filter}
            type="text"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setHl(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setHl((h) => Math.max(0, Math.min(shown.length - 1, h + (e.key === "ArrowDown" ? 1 : -1))));
              } else if (e.key === "Enter" && shown[hl]) {
                e.preventDefault();
                choose(shown[hl]!.page);
              } else if (e.key === "Escape") {
                // Not the dialog's or the editor's Escape: this one only closes the list.
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
              }
            }}
            placeholder="Page number or name"
            aria-label="Filter pages"
            className="h-8 w-full rounded-md border border-line-strong bg-field px-2.5 text-footnote text-fg placeholder:text-fg-subtle focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
          />
          <div role="listbox" aria-label="Pages" className="flex max-h-60 flex-col overflow-y-auto">
            {shown.length === 0 ? (
              <p className="px-2 py-1 text-caption1 text-fg-subtle">No page matches.</p>
            ) : (
              shown.map((p, i) => (
                <button
                  key={p.page}
                  type="button"
                  role="option"
                  aria-selected={p.page === page}
                  onClick={() => choose(p.page)}
                  className={cn(
                    "flex items-baseline gap-2 rounded px-2 py-1 text-left text-footnote text-fg",
                    p.page === page ? "bg-accent/12" : i === hl ? "bg-fill" : "hover:bg-fill",
                  )}
                >
                  <span className="min-w-[2ch] text-right font-mono text-fg-subtle">{p.page}</span>
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <span className="font-mono text-caption2 text-fg-subtle">{p.labelled}</span>
                </button>
              ))
            )}
          </div>
          <p className="px-2 text-caption2 text-fg-subtle">{pages.length} pages with buttons. Empty pages are left out.</p>
        </div>
      )}
    </div>
  );
}

/** One key's own words: the label, or what the reference points at. */
function keyTitle(k: CompanionPageKey, page: number): string {
  const where = `p${page} r${k.row} c${k.col}`;
  const what = k.label || "(no label)";
  return k.kind === "reference" ? `${what} · reference · ${where}` : `${what} · ${where}`;
}

/** The page, as Companion draws it, scrolling sideways when it is wider than the panel. */
function PageGrid({
  view,
  current,
  disabled,
  onPick,
}: {
  view: CompanionPageView;
  current: PickedCompanion | null;
  disabled?: boolean;
  onPick: (at: { page: number; row: number; col: number }) => void;
}) {
  const byPlace = useMemo(() => new Map(view.keys.map((k) => [`${k.row},${k.col}`, k])), [view]);
  const cells = [];
  for (let r = 0; r < view.rows; r++) {
    for (let c = 0; c < view.cols; c++) {
      const k = byPlace.get(`${r},${c}`);
      if (!k) {
        cells.push(<span key={`${r},${c}`} aria-hidden className="aspect-square rounded-[3px] bg-white/[0.08]" />);
        continue;
      }
      // A reference is picked as what it points at: that is where the press goes.
      const at = k.target ?? { page: view.page, row: k.row, col: k.col };
      const picked = current !== null && current.page === at.page && current.row === at.row && current.col === at.col;
      const style = {
        ...(k.bg ? { backgroundColor: k.bg } : {}),
        ...(k.fg ? { color: k.fg } : {}),
      };
      if (!k.pickable) {
        cells.push(
          <span
            key={`${r},${c}`}
            aria-hidden
            title={k.kind === "page-control" ? "A page control cannot be picked" : undefined}
            style={style}
            className="aspect-square rounded-[3px] bg-white/[0.08] opacity-50"
          />,
        );
        continue;
      }
      cells.push(
        <button
          key={`${r},${c}`}
          type="button"
          role="gridcell"
          data-kind={k.kind}
          data-row={k.row}
          data-col={k.col}
          aria-label={keyTitle(k, view.page)}
          aria-pressed={picked}
          title={keyTitle(k, view.page)}
          disabled={disabled}
          onClick={() => onPick(at)}
          style={style}
          className={cn(
            "relative flex aspect-square min-w-0 flex-col items-center justify-center gap-px overflow-hidden rounded-[3px] bg-white/[0.14] p-0.5 text-center ring-1 ring-inset ring-white/15",
            "text-[9px] font-semibold leading-[1.1] text-white [overflow-wrap:anywhere] hover:brightness-125",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
            picked && "outline outline-2 -outline-offset-2 outline-white ring-2 ring-accent",
          )}
        >
          {k.icon && <img src={k.icon} alt="" className="max-h-[55%] max-w-full object-contain" />}
          <span className="line-clamp-2 min-w-0">{k.label}</span>
          {k.kind === "reference" && (
            <span aria-hidden className="absolute right-px top-px rounded-[2px] bg-black/60 px-[2px] text-[7px] leading-none text-white">
              ref
            </span>
          )}
        </button>,
      );
    }
  }
  return (
    <div className="max-w-full overflow-x-auto rounded-md border border-line-strong bg-black p-1" data-page-grid={view.page}>
      <div
        role="grid"
        aria-label={`Buttons on page ${view.page}`}
        className="grid gap-[3px]"
        // Keys keep a minimum size, so a wide page scrolls inside the panel rather than shrinking to dots.
        style={{ gridTemplateColumns: `repeat(${view.cols}, minmax(2.25rem, 1fr))` }}
      >
        {cells}
      </div>
    </div>
  );
}
