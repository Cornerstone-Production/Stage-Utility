// Route components for the sections that need shared state.
//
// Each is a thin wrapper: call useStageSettings(), pass the props the section
// already expects. The sections themselves are untouched, which is the point —
// a section that misbehaves after this is a wiring problem, not a rewritten one.
//
// The prop-free sections (Integrations, Automation, History, Baptisms, Patch,
// ScriptView) need no wrapper and are routed directly.

import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { PlanSection } from "../settings/sections/plan-section";
import { ViewsSection } from "../settings/sections/views-section";
import { OutputsSection } from "../settings/sections/outputs-section";
import { ConnectSection } from "../settings/sections/connect-section";
import { BrandingSection } from "../settings/sections/branding-section";
import { AdvancedSection } from "../settings/sections/advanced-section";
import { GettingStarted } from "../settings/getting-started";
import { useStageSettings } from "./use-stage-settings";
import { takeJustUpdated } from "./update-lifecycle";
import { flashTarget } from "./flash";

/** The spinner settings-view showed before stage state arrived. */
function Loading() {
  return (
    <div className="flex items-center justify-center h-full py-16">
      <Loader2Icon className="size-5 text-fg-subtle animate-spin" />
    </div>
  );
}

export function PlanRoute() {
  const s = useStageSettings();
  const router = useRouter();
  if (s.stageLoading || !s.stageState) return <Loading />;
  return (
    <div className="px-5 max-sm:px-3 pt-5 max-sm:pt-4 pb-[50vh] max-sm:pb-24">
      {!s.stageState.onboardingDismissed && (
        <GettingStarted
          stageState={s.stageState}
          // Was navigateToSection(id, flash) - a tab switch plus a highlight.
          // Now a route change plus the same highlight, which has to wait for
          // the destination to render before it can find its target.
          onNavigate={(path: string, flash?: string) => {
            router.navigate({ to: path });
            if (flash) flashTarget(flash);
          }}
          onDismiss={s.handleDismissOnboarding}
        />
      )}
      <PlanSection
        stageState={s.stageState}
        serviceTypes={s.serviceTypes}
        plans={s.plans}
        isRefreshing={s.isRefreshing}
        handlers={s.handlers}
      />
    </div>
  );
}

export function ViewsRoute() {
  const s = useStageSettings();
  if (s.stageLoading || !s.stageState) return <Loading />;
  return (
    <ViewsSection
      stageState={s.stageState}
      wirelessChannels={s.wirelessChannels}
      teamPositions={s.teamPositions}
      layoutTemplates={s.layoutTemplates}
      selectedViewId={s.selectedViewId}
      setSelectedViewId={s.setSelectedViewId}
      localSlots={s.localSlots}
      slotsDirty={s.slotsDirty}
      isSavingSlots={s.isSavingSlots}
      resolvedDraftSlots={s.resolvedDraftSlots}
      slotPresets={s.slotPresets}
      handlers={s.handlers}
    />
  );
}

export function DisplaysRoute() {
  const s = useStageSettings();
  if (s.stageLoading || !s.stageState) return <Loading />;
  return <OutputsSection stageState={s.stageState} handlers={s.handlers} />;
}

export function ConnectRoute() {
  const s = useStageSettings();
  if (s.stageLoading || !s.stageState) return <Loading />;
  return <ConnectSection stageState={s.stageState} handlers={s.handlers} />;
}

export function BrandingRoute() {
  const s = useStageSettings();
  if (s.stageLoading || !s.stageState) return <Loading />;
  return <BrandingSection stageState={s.stageState} handlers={s.handlers} />;
}

export function AdvancedRoute() {
  const s = useStageSettings();
  // Read once, on mount: the banner left behind by the pre-restart page must
  // show exactly once, not on every navigation back to Advanced.
  const [justUpdated, setJustUpdated] = useState(() => takeJustUpdated());
  if (s.stageLoading || !s.stageState) return <Loading />;
  return (
    <AdvancedSection
      stageState={s.stageState}
      updateStatus={s.updateStatus}
      handlers={s.handlers}
      justUpdated={justUpdated}
      onDismissJustUpdated={() => setJustUpdated(null)}
    />
  );
}
