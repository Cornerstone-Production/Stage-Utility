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
import { ConnectSection } from "../settings/sections/connect-section";
import { BrandingSection } from "../settings/sections/branding-section";
import { AdvancedSection } from "../settings/sections/advanced-section";
import { PlanSection } from "../settings/sections/plan-section";
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
