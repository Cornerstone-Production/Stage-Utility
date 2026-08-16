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

import { useEffect, useState, type ReactNode } from "react";
import { Loader2Icon, PencilIcon, CheckIcon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { useDashboardState } from "../../main/use-dashboard-state";
import { useStageSettings } from "../use-stage-settings";
import { useOutputPresence } from "./use-output-presence";
import { GettingStarted } from "../../settings/getting-started";
import { PlanSection } from "../../settings/sections/plan-section";
import { flashTarget } from "../flash";
import { HOME_VIEW_ID } from "@main/services/home-view";
import { LAYOUT_OBJECTS } from "../../main/layout-objects";
import { computePcoTimer } from "../../main/pco-timer";
import { homeMode } from "./home-mode";
import { Commission } from "./commission";
import { HomeEditor } from "./home-editor";
import {
  cardRows,
  isHomeCard,
  reorderCards,
  strayTypes,
  toggleCard,
  visibleCards,
  type HomeCardType,
} from "./home-cards";
import {
  LiveStatusCard,
  NextServiceCard,
  ReadinessCard,
  RecentServicesCard,
} from "./cards";
import { readinessChecks } from "./readiness";

export function HomeRoute() {
  const { pcoLive } = useDashboardState();
  const s = useStageSettings();
  const online = useOutputPresence();
  const router = useRouter();
  const [editing, setEditing] = useState(false);

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
  const objects = home?.layout?.objects ?? [];

  /** Save the card list. Home is the only editor of this view, so there is no
   *  layoutRev to race against — an unconditional save is not a lost edit here,
   *  and passing a stale rev would raise a conflict dialog with itself. */
  function save(next: typeof objects) {
    if (!home?.layout) return;
    void s.handlers.handleSetViewLayout(HOME_VIEW_ID, { ...home.layout, objects: next });
  }

  const cards = visibleCards(objects, mode);

  // Returns an element for EVERY card type — the `never` in the default is what
  // makes that a compile error rather than a blank space on the front page.
  function renderCard(type: HomeCardType): ReactNode {
    switch (type) {
      case "home-live-status":
        return (
          <LiveStatusCard
            pcoLive={pcoLive}
            now={now}
            skewMs={skewMs}
            onlineOutputIds={online}
            outputCount={state.outputs?.length ?? 0}
          />
        );
      case "home-next-service":
        return <NextServiceCard state={state} secondsToStart={secondsToStart} />;
      case "home-readiness":
        return <ReadinessCard checks={readinessChecks(state, online)} />;
      case "home-recent-services":
        return <RecentServicesCard state={state} />;
      default: {
        const _never: never = type;
        void _never;
        return null;
      }
    }
  }

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
          strays={strayTypes(objects).map(
            (t) => LAYOUT_OBJECTS[t as keyof typeof LAYOUT_OBJECTS]?.label ?? t,
          )}
          sensors={s.handlers.sensors}
          onToggle={(t) => save(toggleCard(objects, t))}
          onReorder={(from, to) => save(reorderCards(objects, from, to))}
          onClearStrays={() => save(objects.filter((o) => isHomeCard(o.config.type)))}
        />
      ) : (
        cards.map((t) => <div key={t}>{renderCard(t)}</div>)
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
