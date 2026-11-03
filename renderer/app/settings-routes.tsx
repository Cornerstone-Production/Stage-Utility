// Route components for the sections that need shared state.
//
// Each is a thin wrapper: call useStageSettings(), pass the props the section
// already expects. The sections themselves are untouched, which is the point —
// a section that misbehaves after this is a wiring problem, not a rewritten one.
//
// The prop-free sections (Integrations, Automation, History, Baptisms, Patch,
// ServiceCue) need no wrapper and are routed directly.

import { useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { BrandingSection } from "../settings/sections/branding-section";
import { AdvancedSection } from "../settings/sections/advanced-section";
import { advancedTabPath, DEFAULT_ADVANCED_TAB } from "../settings/sections/advanced-settings";
import { AutomationSection } from "../settings/sections/automation-section";
import { automationTabPath, DEFAULT_AUTOMATION_TAB } from "../settings/sections/automation-tabs";
import { PlanSection } from "../settings/sections/plan-section";
import { MESSAGING_CONFIG_KEY } from "../lib/messaging-config";
import { MessagesSection } from "../settings/sections/messages-section";
import { useStageSettings } from "./use-stage-settings";
import { takeJustUpdated } from "./update-lifecycle";

/** The spinner settings-view showed before stage state arrived. */
function Loading() {
  return (
    <div className="flex items-center justify-center h-full py-16">
      <Loader2Icon className="size-5 text-fg-subtle animate-spin" />
    </div>
  );
}


export function BrandingRoute() {
  const s = useStageSettings();
  if (s.stageLoading || !s.stageState) return <Loading />;
  return <BrandingSection stageState={s.stageState} handlers={s.handlers} />;
}

export function MessagesRoute() {
  const s = useStageSettings();
  const queryClient = useQueryClient();
  // The outputs only say how many screens are in each group, so the page does not
  // wait for them: a stage state that is slow, or never comes, must not leave it
  // on a spinner. Counts appear when they are known.
  return (
    <MessagesSection
      outputs={s.stageState?.outputs}
      // The rule editor's To list is read from the same config: a group added here
      // is on offer there at once, not after its 30 s of staleness.
      onConfigSaved={() => void queryClient.invalidateQueries({ queryKey: MESSAGING_CONFIG_KEY })}
    />
  );
}

/**
 * Bare `/settings/advanced`, which is the General tab. It replaces itself with that
 * tab's own URL rather than drawing the page: the shell titles an exact destination
 * path, and the page draws its own heading, so drawing it here would put "Advanced"
 * twice on screen. Nothing is read or consumed first, so the post-restart banner
 * waits for the page that actually draws.
 */
export function AdvancedRoute() {
  const router = useRouter();
  useEffect(() => {
    router.navigate({ to: advancedTabPath(DEFAULT_ADVANCED_TAB), replace: true });
  }, [router]);
  return <Loading />;
}

/** `/settings/advanced/<tab>`: one page, whose tab is the last segment of the URL. */
export function AdvancedTabRoute() {
  const router = useRouter();
  const { tab } = useParams({ strict: false }) as { tab?: string };
  const s = useStageSettings();
  // Read once, on mount: the banner left behind by the pre-restart page must
  // show exactly once, not on every navigation back to Advanced.
  const [justUpdated, setJustUpdated] = useState(() => takeJustUpdated());
  if (s.stageLoading || !s.stageState) return <Loading />;
  return (
    <AdvancedSection
      tab={tab}
      onTabChange={(next) => void router.navigate({ to: advancedTabPath(next) })}
      stageState={s.stageState}
      updateStatus={s.updateStatus}
      handlers={s.handlers}
      justUpdated={justUpdated}
      onDismissJustUpdated={() => setJustUpdated(null)}
    />
  );
}

/**
 * Bare `/automation`, which is the Commands tab. It replaces itself with that
 * tab's own URL, as Advanced's bare path does, and for the same reason: the
 * page draws its own heading, and the shell titles only an exact destination
 * path. The query string goes with it, because `/automation?new=manual` is a
 * link other pages hold and it opens the New command dialog on arrival.
 */
export function AutomationRoute() {
  const router = useRouter();
  useEffect(() => {
    router.navigate({
      to: automationTabPath(DEFAULT_AUTOMATION_TAB),
      search: router.state.location.search as never,
      replace: true,
    } as never);
  }, [router]);
  return <Loading />;
}

/** `/automation/<tab>`: one page, whose tab is the last segment of the URL. */
export function AutomationTabRoute() {
  const router = useRouter();
  const { tab } = useParams({ strict: false }) as { tab?: string };
  return (
    <AutomationSection
      tab={tab}
      onTabChange={(next) => void router.navigate({ to: automationTabPath(next) })}
    />
  );
}

/**
 * The plan picker, on its own page.
 *
 * It lived on Home until Home became a widget grid, where a fixed block of PCO
 * controls was furniture the operator could neither move nor remove. It is a
 * weekly service task — which service type, which plan — so it sits with History
 * and Baptisms under Services rather than in Advanced, which is where the system
 * settings live. `/plan` is its original URL, restored: it shipped in Phase 1b
 * and has been redirecting to Home ever since.
 */
export function PlanRoute() {
  const s = useStageSettings();
  if (s.stageLoading || !s.stageState) return <Loading />;
  return (
    <PlanSection
      stageState={s.stageState}
      serviceTypes={s.serviceTypes}
      plans={s.plans}
      isRefreshing={s.isRefreshing}
      handlers={s.handlers}
    />
  );
}
