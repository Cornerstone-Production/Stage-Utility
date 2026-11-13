// plan-following.ts — which Planning Center plan stage plots follow, and, on
// /stageplots, whether Planning Center can be read.
//
// The plan is /patch's: the live or next plan in the stage state (planId). On
// this branch the server clears that plan when a poll of Planning Center fails
// for every service type, so until the server-side hold (its own fix) is
// merged, a single failed poll can flick a venue to its default and back.
//
// useCurrentPlan is the light half, for the editor's This week card: the plan,
// its date and the upcoming list, read once. useFollowedPlan adds what only
// /stageplots needs: it asks for the upcoming list again every minute, and
// whether Planning Center can be read is that list's `unavailable` (the same
// answer the slot editor's plan switcher shows as "Planning Center
// unreachable"), a failed read counting as unavailable too. One unavailable
// answer after a good one does not move the page (nextReach): a volunteer's
// plot must not swap to the default and back on one failed read.
//
// The page draws once the stage state has answered and the upcoming list has
// answered (or failed), or after FIRST_READ_WAIT_MS without it; once drawn it
// never goes back to "Loading…", however long a later read hangs.
//
// Dates are the plan's Planning Center sort date on the app's calendar
// (appZoneOf), never the browser's clock. Not connected is not unreachable:
// with no credentials there is no plan to follow, no notice and no plan badge.

import { useEffect, useMemo, useRef, useState } from "react";

import type { UpcomingPlan } from "@main/types/pco";
import type { PlotOverride } from "@main/types/stageplots";
import { hostTimeZone, zonedDateKey } from "@main/services/app-timezone";
import { errorMessage } from "@main/services/errors";

import { logToServer } from "../../lib/client-log";
import { useResyncOn } from "../../lib/use-resync-on";
import { appZoneOf } from "../../settings/sections/history-trends/trends";
import { planDateLabel } from "../../settings/sections/plan-date-label";
import { useUpcomingPlans } from "../../settings/sections/plan-switcher";
import { pcoConnected, useStageState } from "../use-stage-state";

/** How often /stageplots asks whether Planning Center can be read. */
export const REACH_READ_MS = 60_000;
/** Unavailable answers in a row, after a good one, before the page believes them. */
export const UNREACHABLE_AFTER_READS = 2;
/** How long the first draw waits for the upcoming list before going ahead without it. */
export const FIRST_READ_WAIT_MS = 2000;

/**
 * Whether a plan dated `planDate` is still upcoming at `now`: its day, on the
 * app's calendar, is today or later. A plan from earlier today still counts.
 */
export function isUpcoming(planDate: string, now: number, timeZone: string): boolean {
  const at = Date.parse(planDate);
  return Number.isFinite(at) && zonedDateKey(at, timeZone) >= zonedDateKey(now, timeZone);
}

/** What the page believes about Planning Center, from the reads it has heard. */
export interface Reach {
  unreachable: boolean;
  /** Unavailable (or failed) answers in a row. */
  failedInRow: number;
  /** When the last read heard landed; null before any. */
  lastRead: number | null;
}

export const REACH_UNKNOWN: Reach = { unreachable: false, failedInRow: 0, lastRead: null };

/**
 * The page's belief after one more read. A good read believes Planning Center
 * at once. An unavailable one is believed at once only as the first read the
 * page hears before anything is drawn (nothing on screen to flicker), or while
 * it is already unreachable; otherwise it takes UNREACHABLE_AFTER_READS in a
 * row. The same read seen again changes nothing.
 */
export function nextReach(prev: Reach, read: { at: number; unavailable: boolean }, { drawn = false }: { drawn?: boolean } = {}): Reach {
  if (read.at === prev.lastRead) return prev;
  if (!read.unavailable) return { unreachable: false, failedInRow: 0, lastRead: read.at };
  const failedInRow = prev.failedInRow + 1;
  const unreachable = (prev.lastRead === null && !drawn) || prev.unreachable || failedInRow >= UNREACHABLE_AFTER_READS;
  return { unreachable, failedInRow, lastRead: read.at };
}

export interface CurrentPlan {
  /** Planning Center is connected and the stage state has answered. */
  connected: boolean;
  /** The plan the stage state follows (live or next). Null with none, or not connected. */
  planId: string | null;
  /** planId's sort date: the upcoming list's, else one an override stored. */
  planDate: string | null;
  /** planId's date as the badge and the card show it ("Sun 15 Nov"), else
   *  Planning Center's own words, else null. */
  label: string | null;
  /** The app's zone, for every date shown. */
  timeZone: string;
  /** The upcoming list: the plans the This week card offers. */
  plans: UpcomingPlan[];
  /** Why the upcoming list could not be had: Planning Center unreachable, or the read failed. */
  listProblem: string | null;
}

/** The zone every stage plots date is shown in: the configured one, else
 *  the server's own clock's, never the browser's. The one place stage plots
 *  reads appZoneOf. */
export function useAppZone(): string {
  return appZoneOf(useStageState().state, hostTimeZone());
}

/** The plan stage plots follow, and the upcoming list, read once. */
export function useCurrentPlan(overrides: readonly PlotOverride[]): CurrentPlan {
  const { state, error } = useStageState();
  const connected = pcoConnected(state, error) === true && !!state;
  const list = useUpcomingPlans({ enabled: connected });
  const timeZone = useAppZone();
  const planId = connected ? (state?.planId ?? null) : null;
  const planDate = useMemo(() => {
    if (!planId) return null;
    return list.plans.find((p) => p.planId === planId)?.sortDate ?? overrides.find((o) => o.planId === planId && o.planDate)?.planDate ?? null;
  }, [planId, list.plans, overrides]);
  return {
    connected,
    planId,
    planDate,
    label: planDateLabel(planDate, timeZone, { dates: connected ? (state?.planDates ?? null) : null }),
    timeZone,
    plans: list.plans,
    listProblem: list.unavailable ?? (list.error ? errorMessage(list.error) : null),
  };
}

export interface FollowedPlan extends CurrentPlan {
  /** The plan resolution follows: planId, or null while Planning Center is
   *  unreachable (each venue then shows its default). */
  resolvedPlanId: string | null;
  /** There is a plan to follow and Planning Center cannot be read: the notice
   *  shows and every venue its default. */
  unreachable: boolean;
  /** Whether the page may draw: latched true once it has. */
  known: boolean;
}

/** The plan /stageplots follows, and whether Planning Center can be read. */
export function useFollowedPlan(overrides: readonly PlotOverride[]): FollowedPlan {
  const current = useCurrentPlan(overrides);
  const { isLoading } = useStageState();
  const { connected } = current;
  const list = useUpcomingPlans({ enabled: connected, refetchMs: REACH_READ_MS });
  // The last read heard, good or failed: a failure counts as unavailable.
  const failedLast = list.errorAt > list.readAt;
  const readAt = Math.max(list.readAt, list.errorAt);

  const [drawn, setDrawn] = useState(false);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (drawn || isLoading || !connected || readAt > 0) return;
    const t = setTimeout(() => setWaited(true), FIRST_READ_WAIT_MS);
    return () => clearTimeout(t);
  }, [drawn, isLoading, connected, readAt]);
  const ready = !isLoading && (!connected || readAt > 0 || waited);
  useResyncOn([ready], () => {
    if (ready) setDrawn(true);
  });

  const [reach, setReach] = useState<Reach>(REACH_UNKNOWN);
  useResyncOn([connected, readAt], () => {
    if (!connected) setReach(REACH_UNKNOWN);
    else if (readAt > 0) setReach((prev) => nextReach(prev, { at: readAt, unavailable: failedLast || !!list.unavailable }, { drawn }));
  });

  // Said once per change each way, on the tag the rest of the feature uses:
  // an operator asking why every venue shows its default has the reason on
  // /log, and when it came back. The reason is read from a ref so a new
  // wording within one outage is not a second line.
  const down = connected && reach.unreachable;
  const reason = useRef<string | null>(null);
  const wasDown = useRef(false);
  useEffect(() => {
    reason.current = current.listProblem;
  });
  useEffect(() => {
    if (down && !wasDown.current) {
      logToServer("stageplots", `Planning Center is unreachable (${reason.current ?? "no reason given"}); /stageplots shows each venue's default plot`);
    } else if (!down && wasDown.current) {
      logToServer("stageplots", "Planning Center can be read again; /stageplots follows the live or next plan");
    }
    wasDown.current = down;
  }, [down]);

  const unreachable = down && current.planId !== null;
  return { ...current, resolvedPlanId: unreachable ? null : current.planId, unreachable, known: drawn || ready };
}
