// servicecue-body.tsx — the ServiceCue rundown, everything except navigation.
//
// Extracted so the standalone page, the `script` View-kind and the layout object
// are not three renderings that agree — they are one rendering, called three
// times. The requirement was "nothing should look different between them", and
// the only way to make that true rather than merely currently-true is to leave
// no second copy of the markup to drift.
//
// The derivation moved with it, which matters more than the JSX. Deciding when a
// plan counts as live is subtle — a plan gets the live feed only when it is the
// app's ACTIVE plan, and it is only actually running when the PCO controller
// sits on an item, because the pre-service countdown is not "live". Two copies
// of that rule would disagree eventually, and the symptom would be a rundown
// highlighting a row on a service that is not running.
//
// What stays with each caller is navigation: the page's back arrow and layout
// switcher move you between pages, which has no meaning inside a layout. They
// are passed in as slots so the header markup itself is still shared.

import { Loader2Icon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { BrandLogo } from "../components/brand-logo";
import { computePcoTimer, fmtDuration, startsInTimer } from "./pco-timer";
import { RundownTable } from "./rundown-table";
import { useSplHistory } from "./use-spl-state";
import {
  buildServiceCueColumns,
  computeClocks,
  fmtTotal,
  resolveServiceCueSpec,
  totalLengthSec,
} from "./servicecue-columns";
import type { CategoryRole } from "../../main/types/servicecue-roles.js";
import { clockParts, formatClock } from "../lib/clock-format";

export function fmtSvcTime(iso: string, timeZone?: string | null): string {
  return formatClock(iso, { timeZone });
}

/**
 * Everything the rundown renders from, derived once.
 *
 * A hook rather than props so no caller can compute one of these differently —
 * `currentItemId` in particular, which is null unless this plan is BOTH the
 * active one and currently on an item.
 */
export function useServiceCueRender(
  rundown: ServiceCueRundownDTO | null,
  layout: ServiceCueLayout | null,
  roles: CategoryRole[],
  pcoLive: PcoLiveDTO | null,
  now: number,
) {
  const items = useMemo(() => rundown?.items ?? [], [rundown?.items]);
  const spec = useMemo(() => resolveServiceCueSpec(layout, roles, rundown?.noteCategories ?? []), [layout, roles, rundown?.noteCategories]);
  const clocks = useMemo(() => computeClocks(items, rundown?.serviceTimes?.[0]), [items, rundown?.serviceTimes]);
  // Recorded peak SPL per item, for the optional Max SPL column. Subscribed here
  // rather than by each caller so the column behaves the same on the page, on a
  // display and inside a layout — the `script` View-kind used to be the only
  // surface that had it, which is exactly how it became a second rundown.
  const splHistory = useSplHistory();
  const maxSplByItem = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const it of splHistory?.items ?? []) m.set(it.itemId, it.maxSpl);
    return m;
  }, [splHistory?.items]);
  const columns = useMemo(
    () => buildServiceCueColumns(spec, clocks, rundown?.timeZone, maxSplByItem),
    [spec, clocks, rundown?.timeZone, maxSplByItem],
  );

  // Only the app's active plan gets the live feed; a service is actually LIVE
  // only when the PCO controller is on a plan item (preservice countdown ≠ live).
  const isActivePlan = !!rundown?.isActivePlan;
  const liveNow = isActivePlan && pcoLive?.mode === "item";
  // The live timer belongs to the app's plan alone. Any other plan, one browsed
  // to or the next one of a type the app is not on, counts down to its own start
  // instead, and never shows Remaining or Over.
  const timer = isActivePlan ? computePcoTimer(pcoLive, now) : startsInTimer(rundown?.serviceTimes, now);

  return {
    items,
    spec,
    columns,
    isActivePlan,
    liveNow,
    timer,
    over: !!timer?.over,
    currentItemId: liveNow ? pcoLive?.currentItemId ?? null : null,
    svcTimes: (rundown?.serviceTimes ?? []).map((t) => fmtSvcTime(t, rundown?.timeZone)).filter(Boolean).join("  ·  "),
  };
}

export type ServiceCueRender = ReturnType<typeof useServiceCueRender>;

/**
 * The rundown itself: the scroll region, its three empty states, and the table.
 *
 * Deliberately owns no height: it is `flex-1 min-h-0` and takes what its parent
 * gives it. The page gives it the space under a 56px header; a layout object
 * wraps it in a full-height flex column and gives it the object's box. Nothing
 * in here assumes it owns the screen, which is the whole reason it can be
 * embedded at all.
 *
 * The class list is deliberately UNCHANGED from the page it came out of. An
 * earlier draft added `h-full` so it would fill a box on its own — which inside
 * the page's `h-[100dvh]` column means 100% of the FULL height rather than the
 * height left under the header, quietly pushing the last rows past the clip.
 * The `sticky bottom-0` footer hides that, so it looks fine and scrolls short.
 * Height belongs to the parent; the caller supplies it.
 */
export function ServiceCueBody({
  rundown,
  roles,
  layout,
  render,
  error,
  notice,
  textSizeClass,
  textScale,
  autoScroll,
}: {
  rundown: ServiceCueRundownDTO | null;
  roles: CategoryRole[];
  layout: ServiceCueLayout | null;
  render: ServiceCueRender;
  error?: string | null;
  /** Why there is no rundown when nothing FAILED — Planning Center not being
   *  connected — said in the plan's own quiet voice rather than as an error. */
  notice?: string | null;
  /** Row text sizing. Default is the page's viewport-relative clamp; pass "" to
   *  inherit the container's font-size instead, which is how a layout object
   *  gets a size that tracks the box it was given rather than the screen. */
  textSizeClass?: string;
  /** The operator's text size as a multiplier on top of `textSizeClass` (1.5 =
   *  150%). Scales the rundown only, never the header. Absent = 1. */
  textScale?: number;
  /** Keep the live PCO item scrolled into view. Absent = on, which is what the
   *  standalone page has always done. */
  autoScroll?: boolean;
}) {
  const { items, spec, columns, currentItemId } = render;
  // An error only wins when there is nothing else to show. A rundown refetches
  // on a timer, so a single failed poll — a PCO 429, a Wi-Fi blip, the server
  // restarting — used to replace a perfectly good rundown on a stage monitor
  // with red text until the next success up to a minute later. The plan has not
  // changed; the last one we read is still the right answer. Report the failure
  // only when it leaves the operator with nothing.
  const showError = error && !rundown;
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {showError ? (
        <div role="alert" className="flex items-center justify-center h-full text-red-10 text-body px-6 text-center">{error}</div>
      ) : notice && !rundown ? (
        <div className="flex items-center justify-center h-full text-fg-faint text-body px-6 text-center">{notice}</div>
      ) : !rundown ? (
        <div className="flex items-center justify-center h-full"><Loader2Icon className="size-8 text-fg-subtle animate-spin" /></div>
      ) : items.length === 0 ? (
        <div className="flex items-center justify-center h-full text-fg-faint text-body">
          {rundown.planId ? "No items in this plan" : "No upcoming plan for this service type"}
        </div>
      ) : (
        <RundownTable
          items={items}
          columns={columns}
          currentItemId={currentItemId}
          itemTypeColors={rundown?.itemTypeColors}
          rowColor={layout?.rowColor}
          accentRole={layout?.accentRole ?? null}
          roles={roles}
          {...(textSizeClass != null ? { textSizeClass } : {})}
          {...(textScale != null ? { textScale } : {})}
          {...(autoScroll != null ? { autoScroll } : {})}
          footer={spec.showTotalTime ? <span>{fmtTotal(totalLengthSec(items))} <span className="text-fg-subtle">· total time</span></span> : undefined}
        />
      )}
    </div>
  );
}

/**
 * The header bar: plan identity on the left, live state and clock on the right.
 *
 * `nav` and `trailing` are slots for the things that are navigation rather than
 * information — the page fills them with its back arrow and layout switcher, a
 * layout object fills neither. Everything between them is identical wherever it
 * renders.
 */
export function ServiceCueHeader({
  rundown,
  render,
  appLogo,
  appLogoMonochrome,
  now,
  timeZone,
  nav,
  afterIdentity,
  trailing,
}: {
  rundown: ServiceCueRundownDTO | null;
  render: ServiceCueRender;
  appLogo?: string | null;
  /** Branding's monochrome toggle. Hardcoded true in the first draft, which
   *  made the setting dead on this surface while every other screen honoured it.
   *  Defaults true so a caller that does not know about it looks unchanged. */
  appLogoMonochrome?: boolean;
  now: number;
  /** The zone the clock reads in: the app's own, unset = the viewer's. */
  timeZone?: string | null;
  nav?: ReactNode;
  /** Right after the plan's title block: the page's plan switcher. */
  afterIdentity?: ReactNode;
  trailing?: ReactNode;
}) {
  const { liveNow, timer, over, svcTimes } = render;
  const clock = clockParts(now, { timeZone });

  // The page's header carries a plan switcher and a text-size control on top of
  // what a display's does, which stops fitting below ~1100px with a real plan
  // title (measured: wraps at 1024 once the series name is more than a few
  // words). The clock gives way first, since the machine's own screen shows one;
  // the Remaining/Over countdown stays, as it is what an operator reads during a
  // service. The title is held to a share of the width so it truncates instead of
  // forcing a wrap, and below what still fits the bar wraps rather than clipping.
  // `min-h-14` is the old fixed height whenever nothing wraps.
  const crowded = afterIdentity ? "max-[1100px]:hidden" : "";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 min-h-14 py-1 shrink-0 border-b border-line bg-black/40">
      {nav}
      <div className={`flex items-center gap-2 min-w-0 ${afterIdentity ? "max-w-[clamp(6rem,24vw,22rem)]" : ""}`}>
        {appLogo && <BrandLogo logo={appLogo} monochrome={appLogoMonochrome ?? true} className="size-6 rounded text-fg" />}
        <div className="flex flex-col min-w-0 leading-tight">
          <span className="text-caption1 font-title text-fg truncate">{rundown?.planSeriesTitle ?? rundown?.planTitle ?? "ServiceCue"}</span>
          <span className="text-caption2 text-fg-subtle truncate">
            {[rundown?.planSeriesTitle ? rundown?.planTitle : null, rundown?.planDates, svcTimes || null].filter(Boolean).join("  ·  ")}
          </span>
        </div>
      </div>
      {afterIdentity}
      <div className="ml-auto flex items-center gap-4 tabular-nums">
        {liveNow && (
          <span className="flex items-center gap-1.5 text-caption2 font-semibold uppercase tracking-wider text-live-11">
            <span className="size-2 rounded-full bg-live-9" /> Live
          </span>
        )}
        {timer && (
          <div className="flex flex-col items-end leading-none">
            <span className="text-caption2 uppercase tracking-wider text-fg-subtle">{over ? "Over" : timer.mode === "preservice" ? "Starts in" : "Remaining"}</span>
            <span className={`text-title3 font-medium ${over ? "text-red-10" : "text-live-11"}`}>{fmtDuration(timer.seconds)}</span>
          </div>
        )}
        <div className={`flex flex-col items-end leading-none ${crowded}`}>
          <span className="text-caption2 uppercase tracking-wider text-fg-subtle">Clock</span>
          <span className="text-title3 font-medium text-fg">{clock.head}<span className="text-fg-subtle text-[0.7em]">{clock.seconds}{clock.tail}</span></span>
        </div>
        {trailing}
      </div>
    </div>
  );
}
