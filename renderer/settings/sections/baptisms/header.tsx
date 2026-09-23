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
//
// useServiceLive, baptismRebuildDisabledReason, rebuildTargetLabel and
// runBaptismRebuild are exported for timer-card.tsx's save-failure note:
// each failed session gets its own Rebuild action for its own serviceKey,
// never state.serviceKey, and has to confirm, recheck and report a rebuild
// exactly the way this header does — reusing these rather than writing a
// second copy is the whole point.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyIcon, DownloadIcon, WrenchIcon } from "lucide-react";

import { errorMessage } from "@main/services/errors";
import type { BaptismRebuildOutcome } from "@main/services/history-edit";

import { cn } from "../../../lib/cn";
import { invoke, onNotification, type ApiError } from "../../../lib/api";
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
  if (out.disagreeing > 0) parts.push(`${out.disagreeing} disagreeing with the rows`);
  if (out.invalid > 0) parts.push(`${out.invalid} could not be read`);
  if (out.kept > 0) parts.push(`${out.kept} left alone`);
  // A rebuild never evicts an existing session to make room (see
  // baptismStore.mergeRebuilt) — at the MAX_SESSIONS cap it simply stops
  // adding new ones, and says so, rather than silently discarding them.
  if (out.full > 0) parts.push(`the store is full, so ${out.full} were not added`);
  return `Rebuilt from raw: ${parts.join(", ")}`;
}

/** How often to re-ask while blocked and nothing has told us to — see
 *  useServiceLive's own comment for what this backstops. */
const LIVE_RECHECK_MS = 30_000;

/** The server's own answer to "is this service live", from this page's point
 *  of view: `checking` while a target's first answer for this render is still
 *  in flight (including right after a target change, before its own answer
 *  has arrived — see useServiceLive), `failed` when the ask itself could not
 *  be answered, and `live`/`not-live` otherwise. All but `not-live` disable
 *  the button; baptismRebuildDisabledReason gives each its own reason. */
export type LiveStatus = "checking" | "live" | "not-live" | "failed";

interface LiveCheck {
  status: LiveStatus;
  /** Ask again right now and update `status` to match, returning the fresh
   *  answer — called immediately before posting, so a confirm dialog left
   *  open across the target starting to record again cannot walk a stale
   *  "not live" into the very 409 this exists to avoid. */
  recheck: () => Promise<LiveStatus>;
  /** The POST route refused with 409 despite the recheck above having just
   *  said otherwise — the write itself is the one true answer; reflect it
   *  without a further round trip. */
  markLive: () => void;
}

/**
 * Whether `serviceKey` is being recorded right now, answered by the SERVER —
 * `GET /api/history/live`, which shares `assertNotLive`'s own expression, so
 * the ROUTE and the refusal can never disagree with each other. This hook's
 * OWN cached copy of that answer can still be stale for as long as it takes
 * to ask again: a network round trip has latency, and a push is only ever a
 * HINT that something changed, not an answer about this one key.
 *
 * Re-asked on mount, on every `serviceKey` change, and on every
 * "service-timeline:history" push. Two things narrow the remaining gap
 * rather than close it outright, because nothing client-side can:
 *
 *   - a slow backstop interval, while the answer is anything but "not live"
 *     (INCLUDING "checking" — an answer for the current target can still be
 *     lost, below, and if it is there is otherwise nothing left to ever ask
 *     again), for the two ways a service can stop recording with no push
 *     ever following it (the live-poller's attendance tick still busy on the
 *     exact closing instant, or no ticks at all for a while — a dropped PCO
 *     poll, or the plan deselected);
 *   - `recheck`/`markLive`, above, for the moment right before and right at
 *     the POST itself.
 *
 * Every answer, from any of the four places that can produce one (the
 * mount/key-change effect, the backstop, `recheck`, `markLive`), is accepted
 * ONLY for whichever key is still the current target — see `accept` below.
 * An in-flight ask for a PREVIOUS target has no cancellation on the promise
 * itself (only `clearInterval`/`clearTimeout` stop FUTURE ticks, never one
 * already in flight), so a slow answer for A landing after the target has
 * already moved on to B, and already gotten its OWN fresh "not live" answer,
 * would otherwise overwrite B's correct answer with A's — leaving B stuck
 * reading `checking` with no interval running to ever ask again, because the
 * backstop itself was written to skip scheduling while checking.
 *
 * A target CHANGE reads as `checking` in the SAME render it happens, never
 * the previous key's answer for even one extra render: derived below rather
 * than set synchronously in the effect, because a target change inheriting
 * the old key's "not live" long enough for a click to land is exactly the
 * race this hook exists to close. A null key always reads as `not-live`,
 * since there is nothing to be live.
 */
export function useServiceLive(serviceKey: string | null): LiveCheck {
  const [answer, setAnswer] = useState<{ key: string | null; status: LiveStatus }>({ key: null, status: "not-live" });
  // The one true "what are we asking about right now", read at the moment an
  // async answer is about to be written — never the STALE value a `.then()`
  // closure captured back when the ask started. Written in an effect, not
  // during render: nothing here needs it to be current for THIS render, only
  // for whichever async callback reads it later, after every effect for this
  // render (including this one) has already run.
  const targetRef = useRef(serviceKey);
  useEffect(() => {
    targetRef.current = serviceKey;
  }, [serviceKey]);

  const ask = useCallback(async (key: string): Promise<LiveStatus> => {
    try {
      const res = await invoke<{ live: boolean }>("history:live", { serviceKey: key });
      return res.live ? "live" : "not-live";
    } catch (err) {
      logToServer("baptism", `could not check whether ${key} is live: ${errorMessage(err)}`);
      return "failed";
    }
  }, []);

  /** Write an answer only if `key` is still the current target — an answer
   *  for a key the target has since moved away from is not stale data worth
   *  keeping, it is the answer to a question nobody is asking anymore. */
  const accept = useCallback((key: string, next: LiveStatus) => {
    if (targetRef.current === key) setAnswer({ key, status: next });
  }, []);

  const status: LiveStatus = serviceKey == null ? "not-live" : answer.key === serviceKey ? answer.status : "checking";

  useEffect(() => {
    if (!serviceKey) return;
    let cancelled = false;
    const run = () => {
      ask(serviceKey).then((next) => {
        if (!cancelled) accept(serviceKey, next);
      });
    };
    run();
    const off = onNotification("service-timeline:history", () => {
      if (!cancelled) run();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [serviceKey, ask, accept]);

  // The slow backstop — see this hook's own comment. Cleared (not merely a
  // no-op) the moment the answer is "not live": a service that ended does
  // not spend the rest of the visit polling a question it already has the
  // answer to, on a page that stays open far longer than any one service.
  useEffect(() => {
    if (!serviceKey || status === "not-live") return;
    const id = setInterval(() => {
      ask(serviceKey).then((next) => accept(serviceKey, next));
    }, LIVE_RECHECK_MS);
    return () => clearInterval(id);
  }, [serviceKey, status, ask, accept]);

  return {
    status,
    recheck: async () => {
      if (!serviceKey) return "not-live";
      const next = await ask(serviceKey);
      accept(serviceKey, next);
      return next;
    },
    markLive: () => {
      if (serviceKey) accept(serviceKey, "live");
    },
  };
}

/**
 * Why Rebuild from raw is disabled, or `null` when it is not.
 *
 * Pure and exported so each reason is provable directly in header.test.tsx
 * without needing Radix's hover machinery to reach a rendered tooltip (jsdom
 * mounts a Tooltip's content only while it is open — see this file's own
 * comment; a few of the tests below drive that open with a real focus event
 * where the exact rendered text matters, but the exhaustive "every reason is
 * distinct" check calls this function directly). Conflating any of these
 * would send an operator to reload a page that was actually fine (a load
 * failure), to look for a "missing" recording that a session simply predates
 * the serviceKey field on, or to wait out a recording that already ended
 * because the last check of it happened to fail.
 */
export function baptismRebuildDisabledReason(args: {
  targetServiceKey: string | null;
  liveStatus: LiveStatus;
  sessionsLoadFailed: boolean;
  mostRecentSession: { serviceKey?: string | null } | null;
}): string | null {
  if (args.targetServiceKey != null) {
    switch (args.liveStatus) {
      case "live":
        return "This service is still recording — rebuild once it ends";
      case "checking":
        return "Checking whether this service is still recording…";
      case "failed":
        return "Could not check whether this service is still recording — try again shortly";
      case "not-live":
        return null;
    }
  }
  if (args.sessionsLoadFailed) return "Past sessions could not be loaded — reload the page and try again";
  if (args.mostRecentSession) return "The most recent session has no linked service to rebuild from";
  return "Nothing has been recorded yet — there is no service to rebuild";
}

/**
 * How Rebuild from raw names its target in a confirm dialog: title and date
 * together when both exist, whichever one exists alone, or a neutral
 * fallback when neither does. Shared so the header's own action and each
 * save-failure entry's own (which has a date from its session id but never
 * a title) describe "this service" the same way rather than two slightly
 * different sentences drifting apart.
 */
export function rebuildTargetLabel(title: string | null, date: string | null): string {
  return title && date ? `${title} (${fmtDate(date)})` : (title ?? (date ? fmtDate(date) : "this service"));
}

/**
 * Confirm before writing, naming the service — the exact dialog this header
 * has always shown, pulled out so the save-failure note's per-entry Rebuild
 * action reuses the same wording rather than a second copy of it.
 */
async function confirmBaptismRebuild(targetLabel: string): Promise<boolean> {
  return confirm({
    title: "Rebuild from raw?",
    message:
      `Recomputes ${targetLabel}'s baptism sessions from the presses recorded in the data archive. ` +
      "Existing sessions are updated, or added to if the rows have one the store does not — never " +
      "deleted, even one these rows cannot reproduce (a session removed from Past sessions can come back).",
    confirmLabel: "Rebuild",
    destructive: true,
  });
}

/**
 * Confirm, recheck liveness right before the write, POST, and report — the
 * one place this repo posts to POST /api/baptism/rebuild, so the header's
 * own action and the save-failure note's per-entry one cannot refuse,
 * confirm or report a rebuild differently. `liveCheck` is always the
 * CALLER's own `useServiceLive()`: the header's targetServiceKey and a
 * failed entry's own serviceKey are never the same question, and each needs
 * its own answer rather than sharing one hook instance.
 */
export async function runBaptismRebuild(args: {
  serviceKey: string;
  targetLabel: string;
  liveCheck: LiveCheck;
  onRebuilt: () => void;
}): Promise<void> {
  if (!(await confirmBaptismRebuild(args.targetLabel))) return;
  // Asked again, right now: the confirm dialog can sit open long enough for
  // the target to start recording, and posting into that would be a race
  // the operator did not cause. Only an outright "live" answer refuses here
  // — "failed" or a slow "not live" are not reasons to hold back a POST the
  // server will refuse on its own if it has to.
  if ((await args.liveCheck.recheck()) === "live") {
    toast.error("This service started recording again — rebuild once it ends");
    return;
  }
  try {
    const out = await invoke<BaptismRebuildOutcome>("baptism:rebuild", { serviceKey: args.serviceKey });
    args.onRebuilt();
    toast.success(describeBaptismRebuild(out));
  } catch (e) {
    // A 409 is a DECISION, not one failure — the route answers it for two
    // opposite reasons (ServiceIsLiveError and NoRawRowsError both refuse
    // with 409), and treating every 409 as "started recording again" is its
    // own bug: a service recorded before the raw layer existed has a
    // timeline record but no baptism.csv at all, which is exactly this
    // page's own fallback target on a freshly upgraded server until the
    // first new session lands — every click toasted the live-service
    // message, flipped the button to "still recording," and re-enabled it
    // within 30 seconds only to repeat. The server's own `code` on the
    // response tells the two apart.
    const code = (e as ApiError)?.code;
    if (code === "live") {
      // The recheck above narrows the race but cannot close it: the service
      // can still start recording in the moment between that check and this
      // POST landing. Reflect that without waiting for yet another round
      // trip, rather than the generic failure message.
      args.liveCheck.markLive();
      toast.error("This service started recording again — rebuild once it ends");
      return;
    }
    if (code === "no-raw-rows") {
      // Not a liveness problem at all — leave the button exactly as it was
      // and say what the server actually refused on.
      toast.error(errorMessage(e));
      return;
    }
    toast.error(`Rebuild failed: ${errorMessage(e)}`);
  }
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
  const targetLabel = rebuildTargetLabel(targetTitle, targetDate);

  // Whether the SERVICE (not the baptism timer — a finished session's service
  // can still be recording) is live, asked of the server directly — see
  // useServiceLive's own comment for why a client-side guess is not this.
  const liveCheck = useServiceLive(targetServiceKey);

  const disabledReason = baptismRebuildDisabledReason({
    targetServiceKey,
    liveStatus: liveCheck.status,
    sessionsLoadFailed,
    mostRecentSession,
  });

  const rebuildTooltip = disabledReason ?? "Recompute this service's baptism sessions from the raw rows in the data archive";

  async function onRebuild() {
    if (!targetServiceKey || disabledReason) return;
    await runBaptismRebuild({ serviceKey: targetServiceKey, targetLabel, liveCheck, onRebuilt });
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
