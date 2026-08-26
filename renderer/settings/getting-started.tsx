import { CheckCircle2Icon, CircleIcon, XIcon, RocketIcon } from "lucide-react";

import { Button } from "../components/ui";
import { screensListViews } from "@main/services/home-view";

interface Step {
  label: string;
  hint: string;
  done: boolean;
  /** Route to jump to when the step is clicked. */
  path: string;
  /** `data-flash-id` of the control on that route to outline on arrival. */
  flash?: string;
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
  onNavigate: (path: string, flash?: string) => void;
  onDismiss: () => void;
}) {
  // A fresh install already ships one View and one routed Output, so "is anything
  // routed?" was true before the operator had done anything — the step arrived
  // pre-ticked and taught nothing. Both view steps therefore measure going BEYOND
  // that default: a View you made, and a screen pointed at it.
  // Home is excluded from the count. It is seeded on every install, so counting
  // it made this step read "done" on a fresh box — exactly the pre-ticked step
  // the comment above was written to stop.
  const madeOwnView = screensListViews(stageState.views).length > 1;
  const routedOwnView = madeOwnView && stageState.outputs.some((o) => o.viewId);
  const steps: Step[] = [
    {
      label: "Connect Planning Center",
      hint: "Enter your PCO app credentials so plans, items, and the live countdown flow in.",
      done: stageState.pcoConfigured,
      path: "/settings/integrations",
      flash: "pco-credentials",
    },
    {
      label: "Select a service & plan",
      hint: "Pick the service type and the plan this machine should follow.",
      done: !!stageState.planId,
      path: "/plan",
      flash: "plan-selection",
    },
    {
      label: "Create a view",
      hint: "Build what a screen shows — mic slots, a dashboard, transcription, or a custom layout.",
      done: madeOwnView,
      path: "/views",
      flash: "views-list",
    },
    {
      label: "Route a display",
      hint: "Point a screen at the View you built.",
      done: routedOwnView,
      path: "/displays",
      flash: "displays-list",
    },
  ];

  // Auto-hide once everything's set up — the checklist has done its job.
  if (steps.every((s) => s.done)) return null;

  return (
    <div className="pt-5 max-sm:pt-4">
      <div className="rounded-xl border border-gray-a5 bg-gray-2 p-4">
        <div className="flex items-start gap-2">
          <RocketIcon className="size-4 text-accent mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-headline font-semibold text-gray-12">Getting started</div>
            <div className="text-caption1 text-gray-10">A few steps to get this machine ready for a service.</div>
          </div>
          <Button variant="transparent" size="small" iconOnly onClick={onDismiss} aria-label="Dismiss getting started" tooltip="Dismiss">
            <XIcon className="size-3.5 text-gray-9" />
          </Button>
        </div>

        <div className="mt-3 flex flex-col gap-1.5">
          {/* The whole row is the target, not just the button — the label reads as the
              thing to act on, so clicking it should do what clicking "Set up" does.
              A done step stays clickable so you can go back and look at it. */}
          {steps.map((step) => (
            <button
              key={step.label}
              type="button"
              onClick={() => onNavigate(step.path, step.flash)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-gray-a3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {step.done ? (
                <CheckCircle2Icon className="size-4 shrink-0 text-green-10" />
              ) : (
                <CircleIcon className="size-4 shrink-0 text-gray-7" />
              )}
              <div className="flex-1 min-w-0">
                <div className={`text-body ${step.done ? "text-gray-10 line-through" : "text-gray-12"}`}>{step.label}</div>
                {!step.done && <div className="text-caption2 text-gray-9 leading-snug">{step.hint}</div>}
              </div>
              {/* Styled as the filled Button rather than being one: the row itself is
                  already a button, and nesting one inside another is invalid HTML
                  (the inner control becomes unreachable for keyboard users). */}
              {!step.done && (
                <span className="shrink-0 inline-flex items-center justify-center rounded-md h-6 px-2 text-caption1 font-medium bg-fill text-fg">
                  Set up
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
