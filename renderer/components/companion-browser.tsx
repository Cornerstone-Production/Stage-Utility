// companion-browser.tsx — Browse buttons: Companion's pages, read-only, as its own
// export draws them.
//
// For finding out what Stage Utility can press and what it will call it, without
// opening a rule. One page at a time, in a grid of its used extent (never fewer than
// 8 by 4, scrolling sideways inside the card when a page is wider than fits), with
// Companion's own colours and icons. There are ~100 pages and more than half are
// empty on a real install, so the page control is a dropdown that filters by number
// or name, with previous and next arrows over the pages that have buttons and the
// empty ones left out.
//
// Read-only: nothing here picks, presses or writes. Mounted only while the card's
// Browse buttons is on, so Companion is not read for a page nobody opened.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import type { CompanionPageKey, CompanionPageSummary } from "@main/services/companion-export";
import { errorMessage } from "@main/services/errors";
import { plural } from "@main/services/plural";

import { invoke } from "../lib/api";
import { cn } from "../lib/cn";

type ButtonsReply = { ok: true; pages: CompanionPageSummary[] } | { ok: false; reason: string };
type PageReply =
  | { ok: true; page: number; name: string; cols: number; rows: number; keys: CompanionPageKey[] }
  | { ok: false; reason: string };

/** The pages that have buttons, in page order. Empty pages are left out of the dropdown and the arrows alike. */
export function listedPages(pages: readonly CompanionPageSummary[]): CompanionPageSummary[] {
  return pages.filter((p) => p.labelled > 0).sort((a, b) => a.page - b.page);
}

/** The pages a filter keeps: a number (exactly or as a prefix) or any part of the name. A blank filter keeps all. */
export function filterPages(pages: readonly CompanionPageSummary[], query: string): CompanionPageSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...pages];
  return pages.filter((p) => String(p.page).startsWith(q) || p.name.toLowerCase().includes(q));
}

/** The page the arrow reaches from `page`, or null at the end. Over the listed pages, so an empty one is never stopped on. */
export function neighbour(pages: readonly CompanionPageSummary[], page: number, step: 1 | -1): number | null {
  const at = pages.findIndex((p) => p.page === page);
  return pages[at + step]?.page ?? null;
}

const pageName = (p: Pick<CompanionPageSummary, "page" | "name">) => p.name.trim() || `Page ${p.page}`;

function Key({ k, page }: { k: CompanionPageKey | undefined; page: number }) {
  // An empty key, and a page control (page number, up, down): drawn as a blank key, since neither presses anything.
  if (!k || k.kind === "page-control") {
    return <div className="aspect-square rounded-[3px] bg-(--su-companion-key)" aria-hidden="true" />;
  }
  const where = `p${page} r${k.row} c${k.col}`;
  const title =
    k.kind === "reference" && k.target
      ? `${k.label} · ${where}, a reference to p${k.target.page} r${k.target.row} c${k.target.col}`
      : `${k.label} · ${where}`;
  return (
    <div
      data-companion-key={where}
      data-key-kind={k.kind}
      title={title}
      // Companion's own colours: set per key, because they are Companion's, not the app's.
      style={{ ...(k.bg ? { backgroundColor: k.bg } : {}), ...(k.fg ? { color: k.fg } : {}) }}
      className={cn(
        "relative flex aspect-square min-w-0 flex-col items-center justify-center gap-px overflow-hidden rounded-[3px] p-0.5 text-center",
        "bg-(--su-companion-key) text-(--su-companion-key-fg)",
      )}
    >
      {k.icon && <img src={k.icon} alt="" className="min-h-0 w-full flex-1 object-contain" draggable={false} />}
      <span
        className={cn(
          "w-full break-words text-[9px] font-semibold leading-[1.1]",
          k.icon ? "line-clamp-1" : "line-clamp-4",
        )}
      >
        {k.label}
      </span>
      {k.kind === "reference" && (
        <span aria-hidden="true" className="absolute right-0.5 top-0 text-[9px] leading-none opacity-70">
          ↪
        </span>
      )}
    </div>
  );
}

function PageGrid({ page }: { page: number }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ["companion:page", page],
    queryFn: () => invoke<PageReply>("companion:page", { page }),
  });
  if (isLoading) return <p className="py-6 text-center text-caption1 text-fg-muted">Reading page {page}…</p>;
  if (error) return <p className="text-caption1 text-danger-11">Could not read page {page}: {errorMessage(error)}</p>;
  if (!data) return null;
  if (!data.ok) return <p className="text-caption1 text-danger-11">Could not read page {page}: {data.reason}</p>;
  const keys = new Map(data.keys.map((k) => [`${k.row},${k.col}`, k] as const));
  const cells: React.ReactNode[] = [];
  for (let r = 0; r < data.rows; r++) {
    for (let c = 0; c < data.cols; c++) cells.push(<Key key={`${r},${c}`} k={keys.get(`${r},${c}`)} page={page} />);
  }
  return (
    <>
      {/* The grid keeps a minimum key size and scrolls sideways inside this box when a page is wider than the card. */}
      <div
        role="img"
        aria-label={`Companion page ${page}, ${pageName(data)}, read from Companion's export`}
        className="overflow-x-auto rounded-md border border-(--su-companion-line) bg-(--su-companion-canvas) p-1"
      >
        <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${data.cols}, minmax(2.75rem, 1fr))` }}>
          {cells}
        </div>
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-caption1 text-fg-muted">
        <span>Read from Companion's export</span>
        <span className="font-mono tabular-nums">
          page {page} · {data.cols} × {data.rows}
        </span>
      </div>
    </>
  );
}

/** The page dropdown: a button naming the page, and under it a filter and the list. Keyboard: type, arrows, Enter, Escape. */
function PagePicker({
  pages,
  page,
  onPick,
}: {
  pages: readonly CompanionPageSummary[];
  page: number;
  onPick: (page: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [hl, setHl] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const shown = useMemo(() => filterPages(pages, filter), [pages, filter]);
  const current = pages.find((p) => p.page === page);

  // Outside press closes it, as a menu does.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const choose = (p: number) => {
    onPick(p);
    setOpen(false);
    setFilter("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setHl((h) => Math.max(0, Math.min(shown.length - 1, h + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" && shown[hl]) {
      e.preventDefault();
      choose(shown[hl]!.page);
    } else if (e.key === "Escape") {
      // Closes this list and nothing behind it: the dialog it sits in marks `[data-escape-first]`
      // as the thing Escape belongs to (see integrations-panel.tsx), and focus goes back to the button.
      e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
  };

  const step = (by: 1 | -1) => {
    const next = neighbour(pages, page, by);
    if (next !== null) onPick(next);
  };
  const stepClass =
    "grid w-8 shrink-0 place-items-center rounded-md border border-line-strong text-fg-muted transition-colors " +
    "hover:bg-fill hover:text-fg disabled:opacity-35 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus";

  return (
    <div ref={root} className="relative flex items-stretch gap-1">
      <button type="button" className={stepClass} aria-label="Previous page" disabled={neighbour(pages, page, -1) === null} onClick={() => step(-1)}>
        <ChevronLeftIcon className="size-4" />
      </button>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Companion page"
        onClick={() => {
          setOpen((o) => !o);
          setHl(Math.max(0, pages.findIndex((p) => p.page === page)));
          setFilter("");
        }}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-line-strong bg-field px-2.5 py-1.5 text-left text-footnote text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus"
      >
        <span className="min-w-[2ch] text-right font-mono tabular-nums text-fg-subtle">{page}</span>
        <span className="min-w-0 flex-1 truncate">{current ? pageName(current) : `Page ${page}`}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      </button>
      <button type="button" className={stepClass} aria-label="Next page" disabled={neighbour(pages, page, 1) === null} onClick={() => step(1)}>
        <ChevronRightIcon className="size-4" />
      </button>

      {open && (
        <div
          data-escape-first=""
          className="absolute inset-x-0 top-full z-20 mt-1 flex flex-col gap-1.5 rounded-lg border border-line-strong bg-popover p-1.5 shadow-lg"
        >
          <input
            autoFocus
            type="text"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setHl(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Page number or name"
            aria-label="Filter pages"
            autoComplete="off"
            spellCheck={false}
            className="h-8 rounded-md border border-line-strong bg-field px-2.5 text-footnote text-fg placeholder:text-gray-a8 focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
          />
          <div role="listbox" aria-label="Pages" className="flex max-h-60 flex-col overflow-auto">
            {shown.length === 0 ? (
              <p className="px-2 py-1.5 text-caption1 text-fg-muted">No page matches</p>
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
                    "flex items-baseline gap-2 rounded-md px-2 py-1 text-left text-footnote text-fg",
                    i === hl && "bg-fill",
                    p.page === page && "bg-accent/12",
                  )}
                >
                  <span className="min-w-[2ch] text-right font-mono tabular-nums text-fg-subtle">{p.page}</span>
                  <span className="min-w-0 flex-1 truncate">{pageName(p)}</span>
                  <span className="font-mono text-caption2 tabular-nums text-fg-subtle">{p.labelled}</span>
                </button>
              ))
            )}
          </div>
          <p className="px-2 text-caption1 text-fg-subtle">
            {plural(pages.length, "page")} with buttons · empty pages left out
          </p>
        </div>
      )}
    </div>
  );
}

export function CompanionBrowser() {
  const { data, error, isLoading } = useQuery({
    queryKey: ["companion:browse-pages"],
    queryFn: () => invoke<ButtonsReply>("companion:buttons"),
  });
  const [picked, setPicked] = useState<number | null>(null);
  const pages = useMemo(() => (data?.ok ? listedPages(data.pages) : []), [data]);

  if (isLoading) return <p className="text-caption1 text-fg-muted">Reading Companion's pages…</p>;
  if (error) return <p className="text-caption1 text-danger-11">Could not read Companion: {errorMessage(error)}</p>;
  if (!data) return null;
  if (!data.ok) return <p className="text-caption1 text-danger-11">Could not read Companion: {data.reason}</p>;
  if (pages.length === 0) return <p className="text-caption1 text-fg-muted">Companion has no page with a labelled button.</p>;

  // A page that has since gone empty falls back to the first listed one rather than drawing nothing.
  const page = pages.some((p) => p.page === picked) ? picked! : pages[0]!.page;
  return (
    <div className="flex flex-col gap-2" data-companion-browser="">
      <PagePicker pages={pages} page={page} onPick={setPicked} />
      <PageGrid page={page} />
    </div>
  );
}
