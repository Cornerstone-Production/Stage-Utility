// header.tsx — the Baptisms tab's sticky header: title, recording pill, service
// sub-line, the action group, the stat strip and the section nav.
//
// Mirrors history-service-header.tsx's shape deliberately — sticky band above an
// IntersectionObserver-highlighted nav, over a scroller shared with every other
// route — because it is the same problem (a sticky header that must not swallow
// an anchor jump into the section below it) and a second, differently-behaving
// solution here would only teach an operator that "sections of a page" work
// differently on two tabs for no reason. RecordingPill, useSectionNav and
// useHeaderInset are reused outright; StatStrip and CustomizePopover come from
// the same history-chart module every other section's figures use.
//
// NOT unit-tested for its LAYOUT, for the same reason ServiceHeader is not:
// `position: sticky`, the ResizeObserver measurement below, and the action
// group's wrap are all stylesheet/layout, and jsdom loads no stylesheet and
// reports every geometry as 0. Driven in a real browser instead, light and
// dark, once a server is running to look at. baptismFigures — the actual
// arithmetic this header displays — is tested in figures.test.ts; the pieces
// borrowed from history-service-header.tsx are proven by its own test file.
// The Rebuild from raw button's LOGIC — which serviceKey it targets, when it
// is disabled and why, and that it confirms before posting — is behaviour,
// not layout, and IS unit-tested in header.test.tsx.

import { useEffect, useMemo, useRef, useState } from "react";
import { CopyIcon, DownloadIcon, WrenchIcon } from "lucide-react";

import { errorMessage } from "@main/services/errors";
import type { BaptismRebuildOutcome } from "@main/services/history-edit";

import { cn } from "../../../lib/cn";
import { invoke, onNotification } from "../../../lib/api";
import { logToServer } from "../../../lib/client-log";
import { Button, confirm, toast } from "../../../components/ui";
import { copyText } from "../../../lib/clipboard";
import { useServerNow } from "../../../lib/server-clock";
import { fmtBaptizeMs, fmtClock, fmtDate } from "../../../main/use-baptism-state";
import { RecordingPill, useSectionNav, useHeaderInset } from "../history-service-header";
import { CustomizePopover, StatStrip, useStoredKeys, type StatFigure } from "../history-chart";
import {
  BAPTISM_FIGURES,
  BAPTISM_FIGURE_KEYS,
  BAPTISM_FIGURES_STORAGE_KEY,
  DEFAULT_BAPTISM_FIGURES,
  baptismFigures,
} from "./figures";

/** The five sections the nav links to, in page order. Session, People, Past
 *  sessions and Trends each render as their own card in baptism-operator.tsx;
 *  their ids are defined here so the nav and the cards cannot disagree about
 *  where a link lands. */
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
    // fmtBaptizeMs, not fmtClock: a mid-testimony entry (baptizeMs 0) must
    // read as a dash here too, matching the People card for the same
    // person — this used to print "baptism 0:00" instead.
    state.people.forEach((p, i) =>
      lines.push(`${i + 1}. testimony ${fmtClock(p.testimonyMs)} · baptism ${fmtBaptizeMs(p.baptizeMs)}`),
    );
  }
  return lines.join("\n");
}

/**
 * What a baptism-only rebuild did, in a sentence — the same "say what
 * changed" discipline describeRebuild uses for History's whole-service one,
 * over the narrower shape rebuildServiceBaptisms answers with.
 *
 * `newer` and `kept` are both "left alone", but for different reasons worth
 * telling apart: `kept` is a session these rows never touched at all; `newer`
 * is one they DID match, and the store's own copy won because it is newer
 * than what the rows can show (a correction made after the service closed).
 * Folding them into one number would hide that the second kind exists at all.
 */
export function describeBaptismRebuild(out: BaptismRebuildOutcome): string {
  const parts = [`${out.updated} updated`, `${out.added} added`];
  if (out.newer > 0) parts.push(`${out.newer} newer than their rows`);
  if (out.kept > 0) parts.push(`${out.kept} left alone`);
  return `Rebuilt from raw: ${parts.join(", ")}`;
}

/**
 * Whether `serviceKey` is being recorded right now, per the SERVER — the
 * exact question `POST /api/baptism/rebuild`'s own 409 answers, asked before
 * the click rather than after. `GET /api/history/live` shares
 * `assertNotLive`'s own expression, so this can never disagree with the
 * server's actual refusal the way a client-side guess once could: reading a
 * just-ended service as still live until the next unrelated tick, or a live
 * one as safe the moment any OTHER service's record happened to broadcast.
 *
 * Re-asked on mount, on every `serviceKey` change, and on every
 * "service-timeline:history" push — a push is a HINT that something changed
 * somewhere, never an answer about this one key. Defaults to `true` (assume
 * live) until the first answer lands, so a click cannot race a still-loading
 * "no" into a 409 the operator did not expect; `null` serviceKey always
 * reads as not-live, since there is nothing to be live.
 */
function useServiceLive(serviceKey: string | null): boolean {
  const [live, setLive] = useState(true);

  useEffect(() => {
    // No effect to run at all for a null key — its "not live" answer is
    // derived below, without a setState-in-effect that would otherwise fire
    // on every render this component mounts with no target.
    if (!serviceKey) return;
    let cancelled = false;
    const ask = () => {
      invoke<{ live: boolean }>("history:live", { serviceKey })
        .then((res) => {
          if (!cancelled) setLive(res.live);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          logToServer("baptism", `could not check whether ${serviceKey} is live: ${errorMessage(err)}`);
          // Left as whatever it last was — see useStatusChannel's own
          // reasoning for why a failed read does not overwrite a good value.
        });
    };
    ask();
    const off = onNotification("service-timeline:history", () => ask());
    return () => {
      cancelled = true;
      off();
    };
  }, [serviceKey]);

  return serviceKey != null && live;
}

/**
 * Why Rebuild from raw is disabled, or `null` when it is not.
 *
 * Pure and exported so each of the three "nothing to target" reasons is
 * provable directly in header.test.tsx: the rendered TOOLTIP text needs
 * Radix's hover machinery to ever reach the DOM (jsdom mounts nothing while a
 * Tooltip is closed), so a test could otherwise only see one shared
 * `disabled=true` and never tell the three states apart. Conflating them
 * would send an operator to reload a page that was actually fine (a load
 * failure), or to look for a "missing" recording that a session simply
 * predates the serviceKey field on (the third case) — neither is "nothing has
 * ever been recorded here", the fourth and only truly empty case.
 */
export function baptismRebuildDisabledReason(args: {
  targetServiceKey: string | null;
  live: boolean;
  sessionsLoadFailed: boolean;
  mostRecentSession: { serviceKey?: string | null } | null;
}): string | null {
  if (args.targetServiceKey != null) {
    return args.live ? "This service is still recording — rebuild once it ends" : null;
  }
  if (args.sessionsLoadFailed) return "Past sessions could not be loaded — reload the page and try again";
  if (args.mostRecentSession) return "The most recent session has no linked service to rebuild from";
  return "Nothing has been recorded yet — there is no service to rebuild";
}

export interface BaptismHeaderProps {
  state: BaptismState;
  /**
   * A hovered Session-chart segment's own figures, replacing the at-rest strip
   * for as long as the pointer is over it — the same swap History's own
   * attendance and sound charts make on hover, relocated to this page's own
   * header strip because the mockup's Session card carries no strip of its own.
   * Null (the default) shows the Customize-selected at-rest figures.
   */
  hoverFigures?: StatFigure[] | null;
  /**
   * Finished sessions, newest first — read only for `sessions[0]`, the
   * service (and its title/date) Rebuild from raw targets when nothing is
   * currently showing.
   */
  sessions: BaptismSession[];
  /** True when the fetch behind `sessions` itself failed — distinct from a
   *  genuinely empty list, so "nothing has been recorded yet" is never shown
   *  for a page that simply could not find out. */
  sessionsLoadFailed?: boolean;
  /** Called after Rebuild from raw actually reaches the server, so Past
   *  sessions and Trends (which read the store, not this page's own live
   *  state) can pick up whatever it changed. */
  onRebuilt: () => void;
}

export function BaptismHeader({
  state,
  hoverFigures = null,
  sessions,
  sessionsLoadFailed = false,
  onRebuilt,
}: BaptismHeaderProps) {
  // Ticks only while a session is live — an idle or finished session's figures
  // do not move, and a timer nobody needs is a timer that outlives the page for
  // no reason (this shell is a persistent app, not a route that unmounts).
  const now = useServerNow(1000, state.phase !== "idle");
  const [figureKeys, toggleFigure] = useStoredKeys(BAPTISM_FIGURES_STORAGE_KEY, BAPTISM_FIGURE_KEYS, DEFAULT_BAPTISM_FIGURES);
  const allFigures = useMemo(() => baptismFigures(state, now), [state, now]);
  const shown = useMemo(() => allFigures.filter((f) => figureKeys.includes(f.key)), [allFigures, figureKeys]);
  const displayed = hoverFigures ?? shown;

  async function onCopyReport() {
    const ok = await copyText(baptismReportText(state, allFigures));
    if (ok) toast.success("Report copied to clipboard");
    else toast.error("Couldn't copy the report");
  }

  function onExport() {
    // The existing multi-sheet .xlsx export, scoped to the one sheet this
    // page is about — see GET /api/history/export in history-export.ts.
    window.location.assign("/api/history/export?include=baptisms");
  }

  // Which service Rebuild from raw targets: the one this page is showing,
  // running or finished (state.serviceKey survives past Finish — see
  // baptismSubline above); failing that, the most recent PAST session's own
  // key. Null when neither exists — nothing has ever been recorded here, or
  // (see disabledReason below) something failed short of an actual key.
  const mostRecentSession = sessions[0] ?? null;
  const targetServiceKey = state.serviceKey ?? mostRecentSession?.serviceKey ?? null;

  // Named for the confirm below — "rebuild this?" is only a real question
  // once the operator can see what "this" is.
  const targetTitle = state.serviceKey ? state.serviceTitle : (mostRecentSession?.title ?? null);
  const targetDate = state.serviceKey ? (state.sessionStartedAt ?? state.finishedAt) : (mostRecentSession?.startedAt ?? null);
  const targetLabel = targetTitle && targetDate ? `${targetTitle} (${fmtDate(targetDate)})`
    : targetTitle ?? (targetDate ? fmtDate(targetDate) : "this service");

  // Whether the SERVICE (not the baptism timer — a finished session's service
  // can still be recording) is live, asked of the server directly — see
  // useServiceLive's own comment for why a client-side guess is not this.
  const rebuildLive = useServiceLive(targetServiceKey);

  const disabledReason = baptismRebuildDisabledReason({
    targetServiceKey,
    live: rebuildLive,
    sessionsLoadFailed,
    mostRecentSession,
  });

  const rebuildTooltip = disabledReason ?? "Recompute this service's baptism sessions from the raw rows in the data archive";

  async function onRebuild() {
    if (!targetServiceKey || disabledReason) return;
    if (!(await confirm({
      title: "Rebuild from raw?",
      message:
        `Recomputes ${targetLabel}'s baptism sessions from the presses recorded in the data archive. ` +
        "Existing sessions are updated, or added to if the rows have one the store does not — never " +
        "deleted, even one these rows cannot reproduce (a session removed from Past sessions can come back).",
      confirmLabel: "Rebuild",
      destructive: true,
    }))) {
      return;
    }
    try {
      const out = await invoke<BaptismRebuildOutcome>("baptism:rebuild", { serviceKey: targetServiceKey });
      onRebuilt();
      toast.success(describeBaptismRebuild(out));
    } catch (e) {
      // Say why. The most likely refusal — the service is still recording —
      // is one the operator can act on, the same reasoning History's own
      // rebuildFromRaw gives for its identical catch.
      toast.error(`Rebuild failed: ${errorMessage(e)}`);
    }
  }

  // The header's own geometry, measured — see useHeaderInset's own doc
  // comment in history-service-header.tsx for why this cannot be a fixed
  // number: the action group wraps to a second line on a narrow window, and
  // the height this header settles at is not the one it first renders at.
  const ref = useRef<HTMLElement | null>(null);
  const bottom = useHeaderInset(ref);
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
          <Button variant="filled" size="small" onClick={onExport} tooltip="Download every baptism ever recorded, as a spreadsheet">
            <DownloadIcon className="size-3.5 text-fg-muted" /> Export
          </Button>
          <Button
            variant="filled"
            size="small"
            disabled={disabledReason != null}
            onClick={() => void onRebuild()}
            tooltip={rebuildTooltip}
          >
            <WrenchIcon className="size-3.5 text-fg-muted" /> Rebuild from raw
          </Button>
        </div>
      </div>

      {/* `announce={false}` at rest: these figures change every second while a
          session records, and a polite live region would read all six out on
          every tick — the same reasoning ServiceHeader's own KPI row
          documents. Hovering a Session-chart segment is the opposite case —
          a static reading that changes only when the pointer moves to a
          different segment — so that swap is announced, like a chart's own
          strip. */}
      <div data-testid="baptism-kpis" className="max-sm:-mx-1 max-sm:px-1">
        <StatStrip
          figures={displayed}
          hover={null}
          live={null}
          announce={hoverFigures != null}
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
