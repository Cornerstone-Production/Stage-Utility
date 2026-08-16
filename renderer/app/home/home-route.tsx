// Home, at the root URL.
//
// Replaces the display picker, which was a list of links. Two states, chosen by
// whether PCO reports a service running — see home-mode.ts for why "none" is a
// payload rather than an absence.
//
// Plan folds into here: its service-type and plan selection is what the context
// bar carries on every page anyway, and the rest is what an operator wants on
// the front door. `/plan` redirects here rather than 404ing, since it shipped
// as a URL in Phase 1b.
//
// The cards are Home's View (main/services/home-view.ts), read for presence and
// ORDER only — Home has no canvas, and editing it happens right here rather than
// on one. What sits below the cards is not editable and is not meant to be: the
// plan picker mutates PCO selection and the commissioning panel hands out
// display URLs. Both are front-door utilities, not dashboard cards, and neither
// belongs on a wall.

import { useEffect, useRef, useState } from "react";
import { Loader2Icon, PencilIcon, CheckIcon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { useDashboardState } from "../../main/use-dashboard-state";
import { useStageSettings } from "../use-stage-settings";
import { useOutputPresence } from "./use-output-presence";
import { GettingStarted } from "../../settings/getting-started";
import { PlanSection } from "../../settings/sections/plan-section";
import { flashTarget } from "../flash";
import { HOME_VIEW_ID, defaultHomeLayout } from "@main/services/home-view";
import type { LayoutObject } from "@main/types/views";
import { computePcoTimer } from "../../main/pco-timer";
import { homeMode } from "./home-mode";
import { Commission } from "./commission";
import { HomeEditor } from "./home-editor";
import { cardRows, reorderCards, toggleCard, visibleCards } from "./home-cards";
import { HomeCard } from "./cards";

export function HomeRoute() {
  const { pcoLive } = useDashboardState();
  const s = useStageSettings();
  const online = useOutputPresence();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  /** The card list as the operator has it, ahead of the server. See `save`. */
  const [pending, setPending] = useState<LayoutObject[] | null>(null);
  /** The same list, readable synchronously inside one React batch. Written in
   *  `save` only — never during a render. */
  const editRef = useRef<LayoutObject[] | null>(null);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    // Cleanup is load-bearing: the shell is persistent, so an interval that
    // outlives this route runs for the whole service.
    return () => clearInterval(id);
  }, []);

  // Skew between this client and the server, recomputed whenever a pco:live
  // arrives. Same pattern as dashboard-view.tsx and the context bar.
  const [skewMs, setSkewMs] = useState(0);
  useResyncOn([pcoLive?.serverNow], () => {
    if (pcoLive?.serverNow) setSkewMs(Date.parse(pcoLive.serverNow) - Date.now());
  });

  // The server has caught up — stop preferring the optimistic copy, so an edit
  // made anywhere else (a restored snapshot, a second tab) is not masked forever.
  const savedRev = s.stageState?.views?.find((v) => v.id === HOME_VIEW_ID)?.layoutRev ?? 0;
  useResyncOn([savedRev], () => {
    setPending(null);
    editRef.current = null;
  });

  if (s.stageLoading || !s.stageState) {
    return (
      <div className="flex items-center justify-center h-full py-16">
        <Loader2Icon className="size-5 text-fg-subtle animate-spin" />
      </div>
    );
  }

  const state = s.stageState;
  // Seconds to the service start, for the pre-service window. computePcoTimer
  // already does the skew-corrected maths for both modes, so this reads the
  // countdown it produces rather than parsing targetAt again.
  const timer = computePcoTimer(pcoLive, now, skewMs);
  const secondsToStart = timer?.mode === "preservice" ? timer.seconds : null;
  const mode = homeMode(pcoLive, secondsToStart);

  const home = (state.views ?? []).find((v) => v.id === HOME_VIEW_ID);
  // A Home whose layout was cleared (a hand-edited views.json, a kind change)
  // gets this build's default rather than an editor whose switches do nothing.
  const layout = home?.layout ?? defaultHomeLayout();
  // `pending` is what the operator has done since the last server round-trip.
  // WITHOUT it, every edit was computed from the server's copy, so two changes
  // inside one round-trip both built on the pre-edit array: switching two cards
  // off in quick succession brought the first one back, and a switch followed by
  // a drag moved the wrong card. Cleared when the server's revision advances.
  const objects = pending ?? layout.objects;

  /**
   * Apply a change to the card list and store it.
   *
   * Takes an updater, not a finished array, and applies it to the NEWEST list
   * rather than whatever this render closed over. Two things could make that
   * stale, and both happened:
   *
   *  • across a round-trip — `pending`, the operator's copy, until the server
   *    catches up. Switching two cards off in succession otherwise brought the
   *    first one back, and a switch followed by a drag moved the wrong card.
   *  • within one React batch — `editRef`, written here and never during a
   *    render, because two handlers can both run before anything re-renders.
   *
   * No layoutRev: Home has one editor — this one — so there is nothing to
   * conflict with, and passing a rev would raise a conflict dialog with itself.
   */
  function save(update: (objs: readonly LayoutObject[]) => LayoutObject[]) {
    const next = update(editRef.current ?? objects);
    editRef.current = next;
    setPending(next);
    s.handlers
      .handleSetViewLayout(HOME_VIEW_ID, { ...layout, objects: next })
      // Not a swallowed failure: handleSetViewLayout has already told the
      // operator. This drops the optimistic copy so the page snaps back to what
      // was actually stored, rather than showing an edit that did not land.
      .catch(() => {
        setPending(null);
        editRef.current = null;
      });
  }

  const cards = visibleCards(objects, mode);

  return (
    <div className="pt-1 pb-[50vh] max-sm:pb-24 flex flex-col gap-3">
      {!state.onboardingDismissed && (
        <GettingStarted
          stageState={state}
          onNavigate={(path: string, flash?: string) => {
            router.navigate({ to: path });
            if (flash) flashTarget(flash);
          }}
          onDismiss={s.handleDismissOnboarding}
        />
      )}

      {home && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setEditing((e) => !e)}
            className="inline-flex items-center gap-1.5 text-caption1 text-accent hover:underline"
          >
            {editing ? <CheckIcon className="size-3.5" /> : <PencilIcon className="size-3.5" />}
            {editing ? "Done" : "Edit cards"}
          </button>
        </div>
      )}

      {editing && home ? (
        <HomeEditor
          rows={cardRows(objects)}
          sensors={s.handlers.sensors}
          onToggle={(t) => save((objs) => toggleCard(objs, t))}
          onReorder={(from, to) => save((objs) => reorderCards(objs, from, to))}
        />
      ) : (
        cards.map((t) => (
          <HomeCard
            key={t}
            type={t}
            state={state}
            pcoLive={pcoLive}
            now={now}
            skewMs={skewMs}
            // Live presence, not the state snapshot: the shell is subscribed
            // anyway, so Home's readiness check reflects a screen dropping off
            // the moment it happens.
            onlineOutputIds={online}
            secondsToStart={secondsToStart}
          />
        ))
      )}

      <PlanSection
        stageState={state}
        serviceTypes={s.serviceTypes}
        plans={s.plans}
        isRefreshing={s.isRefreshing}
        handlers={s.handlers}
      />

      {/* The display picker's actual job. A freshly-pointed monitor lands on
          Home now, so commissioning has to live somewhere an operator can find
          it — one extra click, a few times a year. */}
      <Commission state={state} />
    </div>
  );
}
