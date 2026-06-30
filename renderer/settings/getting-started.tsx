import { CheckCircle2Icon, CircleIcon, XIcon, RocketIcon } from "lucide-react";

import { Button } from "../components/ui";

interface Step {
  label: string;
  hint: string;
  done: boolean;
  /** Settings section to jump to when "Set up" is clicked. */
  section: string;
}

/**
 * First-run "Getting started" checklist. Shown at the top of the Plan section
 * until the core steps are done or the operator dismisses it (machine-wide, via
 * `stageState.onboardingDismissed`). Operator-only; never on a kiosk display.
 */
export function GettingStarted({
  stageState,
  onNavigate,
  onDismiss,
}: {
  stageState: StageState;
  onNavigate: (sectionId: string) => void;
  onDismiss: () => void;
}) {
  const routedDisplay = stageState.outputs.some((o) => o.viewId);
  const steps: Step[] = [
    {
      label: "Connect Planning Center",
      hint: "Enter your PCO app credentials so plans, items, and the live countdown flow in.",
      done: stageState.pcoConfigured,
      section: "integrations",
    },
    {
      label: "Select a service & plan",
      hint: "Pick the service type and the plan this machine should follow.",
      done: !!stageState.planId,
      section: "plan",
    },
    {
      label: "Route a display",
      hint: "Point a screen at a View (mic slots, dashboard, transcription, or a custom layout).",
      done: routedDisplay,
      section: "displays",
    },
  ];

  // Auto-hide once everything's set up — the checklist has done its job.
  if (steps.every((s) => s.done)) return null;

  return (
    <div className="px-5 max-sm:px-3 pt-5 max-sm:pt-4">
      <div className="rounded-xl border border-gray-a5 bg-gray-2 p-4">
        <div className="flex items-start gap-2">
          <RocketIcon className="size-4 text-blue-10 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-headline font-semibold text-gray-12">Getting started</div>
            <div className="text-caption1 text-gray-10">A few steps to get this machine ready for a service.</div>
          </div>
          <Button variant="transparent" size="small" iconOnly onClick={onDismiss} aria-label="Dismiss getting started" tooltip="Dismiss">
            <XIcon className="size-3.5 text-gray-9" />
          </Button>
        </div>

        <div className="mt-3 flex flex-col gap-1.5">
          {steps.map((step) => (
            <div key={step.label} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
              {step.done ? (
                <CheckCircle2Icon className="size-4 shrink-0 text-green-10" />
              ) : (
                <CircleIcon className="size-4 shrink-0 text-gray-7" />
              )}
              <div className="flex-1 min-w-0">
                <div className={`text-body ${step.done ? "text-gray-10 line-through" : "text-gray-12"}`}>{step.label}</div>
                {!step.done && <div className="text-caption2 text-gray-9 leading-snug">{step.hint}</div>}
              </div>
              {!step.done && (
                <Button variant="filled" size="small" onClick={() => onNavigate(step.section)}>
                  Set up
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
