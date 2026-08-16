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

import { useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { useDashboardState } from "../../main/use-dashboard-state";
import { useStageSettings } from "../use-stage-settings";
import { useOutputPresence } from "./use-output-presence";
import { GettingStarted } from "../../settings/getting-started";
import { PlanSection } from "../../settings/sections/plan-section";
import { flashTarget } from "../flash";
import { AppLink } from "../app-link";
import { HOME_VIEW_ID } from "@main/services/home-view";
import { computePcoTimer } from "../../main/pco-timer";
import { homeMode } from "./home-mode";
import { IdlePanel } from "./idle-panel";
import { LivePanel } from "./live-panel";
import { Commission } from "./commission";

export function HomeRoute() {
  const { pcoLive } = useDashboardState();
  const s = useStageSettings();
  const online = useOutputPresence();
  const router = useRouter();

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

  return (
    <div className="px-5 max-sm:px-3 pt-1 pb-[50vh] max-sm:pb-24 flex flex-col gap-3">
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

      {/* Home is a View now (see main/services/home-view.ts), so it is edited
          like every other surface. The panels below still render the fixed
          arrangement — this link is the door to rearranging it, and the objects
          it offers are the same components these panels draw. */}
      <div className="flex justify-end">
        <AppLink
          to={`/screens/${HOME_VIEW_ID}/edit`}
          className="text-caption1 text-accent hover:underline"
        >
          Edit this dashboard
        </AppLink>
      </div>

      {mode === "live" ? (
        <LivePanel
          pcoLive={pcoLive}
          now={now}
          skewMs={skewMs}
          onlineOutputIds={online}
          outputCount={state.outputs?.length ?? 0}
        />
      ) : (
        <IdlePanel state={state} onlineOutputIds={online} secondsToStart={secondsToStart} />
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
