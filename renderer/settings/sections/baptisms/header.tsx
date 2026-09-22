// header.tsx — the Baptisms tab's sticky header: title, recording pill, service
// sub-line, the action group, the stat strip and the section nav.
//
// Mirrors history-service-header.tsx's shape deliberately — sticky band above an
// IntersectionObserver-highlighted nav, over a scroller shared with every other
// route — because it is the same problem (a sticky header that must not swallow
// an anchor jump into the section below it) and a second, differently-behaving
// solution here would only teach an operator that "sections of a page" work
// differently on two tabs for no reason. RecordingPill, useSectionNav and
// HEADER_INSET_VAR are reused outright; StatStrip and CustomizePopover come from
// the same history-chart module every other section's figures use.
//
// NOT unit-tested, for the same reason ServiceHeader is not: `position: sticky`,
// the ResizeObserver measurement below, and the action group's wrap are all
// stylesheet/layout, and jsdom loads no stylesheet and reports every geometry as
// 0. Driven in a real browser instead, light and dark, once a server is running
// to look at. baptismFigures — the actual arithmetic this header displays — is
// tested in figures.test.ts; the pieces borrowed from history-service-header.tsx
// are proven by its own test file.

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { CopyIcon, DownloadIcon } from "lucide-react";

import { cn } from "../../../lib/cn";
import { Button, toast } from "../../../components/ui";
import { copyText } from "../../../lib/clipboard";
import { useServerNow } from "../../../lib/server-clock";
import { fmtClock, fmtDate } from "../../../main/use-baptism-state";
import { RecordingPill, useSectionNav, HEADER_INSET_VAR } from "../history-service-header";
import { CustomizePopover, StatStrip, useStoredKeys, type StatFigure } from "../history-chart";
import {
  BAPTISM_FIGURES,
  BAPTISM_FIGURE_KEYS,
  BAPTISM_FIGURES_STORAGE_KEY,
  DEFAULT_BAPTISM_FIGURES,
  baptismFigures,
} from "./figures";

/** The five sections the nav links to, in page order — Session, People, Past
 *  sessions and Trends are later tasks in this same PR (12 and 13); their ids
 *  are reserved here so the nav does not have to change shape when they land. */
export const BAPTISM_SECTIONS = [
  { id: "s-timer", label: "Timer" },
  { id: "s-session", label: "Session" },
  { id: "s-people", label: "People" },
  { id: "s-past", label: "Past sessions" },
  { id: "s-trends", label: "Trends" },
] as const;

/**
 * What the header says under the title.
 *
 * Reads only BaptismState — never the live PCO plan — because `serviceTitle` is
 * the session's OWN snapshot (taken in start(), kept through finalize()), so a
 * finished session keeps naming the service it actually ran during even after
 * the live plan has moved on to something else. It is null exactly when idle
 * AND no session has ever run this visit (idleState()/reset() clear it
 * together), which is also the only time this returns the bare "No session
 * running".
 */
export function baptismSubline(state: BaptismState): string {
  if (state.phase !== "idle") {
    return state.serviceTitle
      ? `${state.serviceTitle} · ${fmtDate(state.sessionStartedAt ?? "")}`
      : fmtDate(state.sessionStartedAt ?? "");
  }
  if (!state.finishedAt) return "No session running";
  return state.serviceTitle ? `Session finished · ${state.serviceTitle}` : "Session finished";
}

/**
 * A plain-text summary of the current (or just-finished) session — the
 * clipboard target for Copy report.
 *
 * A sibling of buildReport's BAPTISMS section in service-history-section.tsx,
 * not a reuse of it: that one summarizes a FINISHED service's archived
 * sessions (possibly several, matched by service window); this one is the
 * session this page is timing right now, straight off the figures already on
 * screen, so the pasted text can never disagree with the strip beside it.
 */
export function baptismReportText(state: BaptismState, figures: readonly StatFigure[]): string {
  const lines: string[] = [state.serviceTitle ?? "Baptisms"];
  if (state.sessionStartedAt) lines.push(fmtDate(state.sessionStartedAt));
  lines.push("", ...figures.map((f) => `${f.label}: ${f.value}`));
  if (state.people.length) {
    lines.push("", "PEOPLE");
    state.people.forEach((p, i) =>
      lines.push(`${i + 1}. testimony ${fmtClock(p.testimonyMs)} · baptism ${fmtClock(p.baptizeMs)}`),
    );
  }
  return lines.join("\n");
}

export interface BaptismHeaderProps {
  state: BaptismState;
}

export function BaptismHeader({ state }: BaptismHeaderProps) {
  // Ticks only while a session is live — an idle or finished session's figures
  // do not move, and a timer nobody needs is a timer that outlives the page for
  // no reason (this shell is a persistent app, not a route that unmounts).
  const now = useServerNow(1000, state.phase !== "idle");
  const [figureKeys, toggleFigure] = useStoredKeys(BAPTISM_FIGURES_STORAGE_KEY, BAPTISM_FIGURE_KEYS, DEFAULT_BAPTISM_FIGURES);
  const allFigures = useMemo(() => baptismFigures(state, now), [state, now]);
  const shown = useMemo(() => allFigures.filter((f) => figureKeys.includes(f.key)), [allFigures, figureKeys]);

  async function onCopyReport() {
    const ok = await copyText(baptismReportText(state, allFigures));
    if (ok) toast.success("Report copied to clipboard");
    else toast.error("Couldn't copy the report");
  }

  function onExportCsv() {
    // The existing multi-sheet export, scoped to the one sheet this page is
    // about — see GET /api/history/export in history-export.ts.
    window.location.assign("/api/history/export?include=baptisms");
  }

  // The header's own geometry, measured — see HEADER_INSET_VAR's own comment in
  // history-service-header.tsx for why this cannot be a fixed number: the action
  // group wraps to a second line on a narrow window, and the height this header
  // settles at is not the one it first renders at.
  const ref = useRef<HTMLElement | null>(null);
  const [bottom, setBottom] = useState(150);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const write = () => {
      const r = el.getBoundingClientRect();
      const pane = el.closest<HTMLElement>("[data-scroll-restoration-id]");
      const paneTop = pane ? pane.getBoundingClientRect().top : 0;
      root.style.setProperty(HEADER_INSET_VAR, `${Math.max(0, Math.round(r.bottom - paneTop))}px`);
      setBottom(Math.round(r.bottom));
    };
    write();
    const drop = () => root.style.removeProperty(HEADER_INSET_VAR);
    if (typeof ResizeObserver === "undefined") return drop;
    const obs = new ResizeObserver(write);
    obs.observe(el);
    return () => {
      obs.disconnect();
      drop();
    };
  }, []);

  const active = useSectionNav(BAPTISM_SECTIONS.map((s) => s.id), bottom);

  return (
    <header
      ref={ref}
      data-testid="baptism-header"
      className={cn(
        // The app's one scroller is the shell's <main> — see the comment on
        // PAGE_SCROLLER_ID in shell.tsx — so `sticky top-0` pins to its top,
        // immediately under the context bar, exactly like ServiceHeader.
        "sticky top-0 z-20 -mx-1 flex flex-col gap-3 bg-bg px-1 pb-2 pt-1",
        "border-b border-line",
        "before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-4 before:bg-bg before:content-['']",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2">
            <span className="truncate text-title3 font-semibold text-fg">Baptisms</span>
            {state.phase !== "idle" && <RecordingPill />}
          </span>
          <span className="truncate text-caption1 text-fg-muted">{baptismSubline(state)}</span>
        </div>

        <div data-testid="baptism-actions" className="flex flex-wrap items-center gap-2 sm:shrink-0">
          <Button variant="filled" size="small" onClick={onCopyReport} tooltip="Copy a plain-text summary of this session">
            <CopyIcon className="size-3.5 text-fg-muted" /> Copy report
          </Button>
          <Button variant="filled" size="small" onClick={onExportCsv} tooltip="Download every baptism ever recorded, as a spreadsheet">
            <DownloadIcon className="size-3.5 text-fg-muted" /> Export CSV
          </Button>
        </div>
      </div>

      {/* `announce={false}`: these figures change every second while a session
          records, and a polite live region would read all six out on every
          tick — the same reasoning ServiceHeader's own KPI row documents. */}
      <div data-testid="baptism-kpis" className="max-sm:-mx-1 max-sm:px-1">
        <StatStrip
          figures={shown}
          hover={null}
          live={null}
          announce={false}
          right={
            <CustomizePopover
              label="Customize the Baptisms figures"
              groups={[{ id: "figures", label: "Figures", options: BAPTISM_FIGURES.map((f) => ({ ...f })) }]}
              selected={figureKeys}
              onToggle={(key) => {
                const err = toggleFigure(key);
                if (err) toast.error(`Couldn't remember that: ${err.message}`);
              }}
            />
          }
        />
      </div>

      <nav aria-label="Sections of the Baptisms tab" className="flex items-center gap-1 text-caption1">
        {BAPTISM_SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            aria-current={active === s.id ? "true" : undefined}
            className={cn(
              "rounded-md px-2 py-1 transition-colors",
              active === s.id ? "bg-fill text-fg" : "text-fg-muted hover:bg-fill hover:text-fg",
            )}
          >
            {s.label}
          </a>
        ))}
      </nav>
    </header>
  );
}
