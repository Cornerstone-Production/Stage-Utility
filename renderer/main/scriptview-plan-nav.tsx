import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, LinkIcon } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";
import { dropdownPlans, parsePlanLink, placePastedPlan, planWhen, plansOfType, stepPlan } from "./scriptview-plan-choice";

// ‹ plan ▾ › and its Following / Browsing badge, in the ServiceCue page's header.
//
// It moves THIS PAGE. It never writes the app's plan: every handler below ends in
// `onSelect`, which the page turns into a search param and nothing else. Which
// plan the stage displays follow is the Plan page's job, same as the slots
// editor's switcher this one is built from (plan-switcher.tsx).
//
// The dropdown is a Popover, not a Select, for the reason position-picker.tsx
// gives: a field has to live inside it. It is not portalled, so it stays inside
// the page's `kiosk-surface` and keeps that surface's always-dark tokens; a
// portal would land it under <body>, which in the light theme is the light ones.

const ICON_BUTTON = "text-fg-muted hover:bg-white/10 hover:text-fg active:bg-white/15";

export interface ScriptViewPlanNavProps {
  /** This page's service type, resolved. */
  serviceTypeId: string;
  serviceTypeName: string | null;
  /** The shared `plans:upcoming` list, every service type in it. */
  plans: UpcomingPlan[];
  /** False until the list's first answer lands; the arrows stay inert till then. */
  plansLoaded: boolean;
  /** The plan the page is on, or is loading: the `?plan=` choice, else what the
   *  rundown resolved to. Null before either is known. */
  currentPlanId: string | null;
  /** The plan the page would follow with no choice made, when known. */
  followedPlanId: string | null;
  /** True on the followed plan, false while browsing. */
  following: boolean;
  /** What to call the current plan when the list does not carry it. */
  fallbackLabel: string | null;
  timeZone: string | null;
  /** A plan to browse to, or null for "back to live". */
  onSelect: (planId: string | null) => void;
  /** A pasted link whose plan belongs to another service type. */
  onOpenElsewhere: (serviceTypeId: string, serviceTypeName: string | null, planId: string) => void;
}

export function ScriptViewPlanNav(props: ScriptViewPlanNavProps) {
  const { serviceTypeId, serviceTypeName, plans, plansLoaded, currentPlanId, followedPlanId, following, fallbackLabel, timeZone, onSelect, onOpenElsewhere } = props;
  const typePlans = plansOfType(plans, serviceTypeId);
  const stops = dropdownPlans(typePlans, serviceTypeId);
  // Inert until both the list and the current plan are known: with the plan
  // still loading, `stepTarget` would read "no plan" as "before the first one"
  // and send the forward arrow to the earliest plan in the list.
  const known = plansLoaded && currentPlanId !== null;
  const back = known ? stepPlan(typePlans, serviceTypeId, currentPlanId, -1) : null;
  const forward = known ? stepPlan(typePlans, serviceTypeId, currentPlanId, 1) : null;

  const [open, setOpen] = useState(false);
  const [pasted, setPasted] = useState("");
  const [pasteProblem, setPasteProblem] = useState<string | null>(null);

  const current = stops.find((e) => e.planId === currentPlanId) ?? null;
  const label = (() => {
    if (!current) return fallbackLabel ?? (currentPlanId ? "Loading plan…" : "No plan");
    const when = planWhen(current.sortDate, timeZone);
    const at = [when.date, when.time].filter(Boolean).join(", ");
    return [current.title || current.dates, at || null].filter(Boolean).join(" · ");
  })();

  function choose(planId: string): void {
    setOpen(false);
    if (planId !== currentPlanId) onSelect(planId);
  }

  function submitPaste(): void {
    const link = parsePlanLink(pasted);
    if (!link) {
      setPasteProblem("That doesn't look like a Planning Center plan link.");
      return;
    }
    const where = placePastedPlan(link, plans, serviceTypeId);
    setPasted("");
    setPasteProblem(null);
    setOpen(false);
    if (where.where === "elsewhere") onOpenElsewhere(where.serviceTypeId, where.serviceTypeName, where.planId);
    else if (where.planId !== currentPlanId) onSelect(where.planId);
  }

  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1" data-plan-nav>
      <Button variant="transparent" iconOnly touchTargetY className={ICON_BUTTON} aria-label="Previous plan" disabled={!back} onClick={() => back && onSelect(back)}>
        <ChevronLeftIcon className="size-3.5" />
      </Button>

      <PopoverPrimitive.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setPasteProblem(null);
        }}
      >
        <PopoverPrimitive.Trigger asChild>
          <Button
            variant="filled"
            className="max-w-[min(16rem,34vw)] max-[900px]:max-w-[10.5rem] justify-between gap-2 border border-line bg-white/[0.06] px-2.5 font-normal text-fg hover:bg-white/10"
            aria-haspopup="listbox"
            aria-label="Choose a plan"
          >
            <span className="truncate">{label}</span>
            <ChevronDownIcon className="size-3 shrink-0 text-fg-muted" />
          </Button>
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          className="z-50 w-[min(380px,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-line-strong bg-[var(--kiosk-surface-1)] shadow-lg"
        >
          <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
            <LinkIcon className="size-3.5 shrink-0 text-fg-subtle" />
            <input
              autoFocus
              value={pasted}
              onChange={(e) => {
                setPasted(e.target.value);
                setPasteProblem(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitPaste();
                }
              }}
              placeholder="Paste a Planning Center plan link"
              aria-label="Paste a Planning Center plan link"
              className="min-w-0 flex-1 bg-transparent text-footnote text-fg outline-none placeholder:text-fg-faint"
            />
            <span className="text-caption2 text-fg-subtle">Enter</span>
          </div>
          {pasteProblem && (
            <p role="alert" className="border-b border-danger-9/40 bg-danger-9/10 px-3 py-2 text-caption1 text-danger-11">
              {pasteProblem}
            </p>
          )}
          <PlanList
            stops={stops}
            loaded={plansLoaded}
            groupLabel={serviceTypeName}
            currentPlanId={currentPlanId}
            followedPlanId={followedPlanId}
            timeZone={timeZone}
            onChoose={choose}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Root>

      <Button variant="transparent" iconOnly touchTargetY className={ICON_BUTTON} aria-label="Next plan" disabled={!forward} onClick={() => forward && onSelect(forward)}>
        <ChevronRightIcon className="size-3.5" />
      </Button>

      <div className="ml-1.5 flex items-center gap-1.5">
        {following ? (
          <span
            data-plan-badge="following"
            className="inline-flex items-center gap-1.5 rounded-full bg-live-9/12 px-2 py-[3px] text-caption2 font-semibold uppercase leading-none tracking-wider text-live-11"
          >
            <i className="size-1.5 rounded-full bg-live-9" />
            Following
          </span>
        ) : (
          <>
            <span
              data-plan-badge="browsing"
              className="inline-flex items-center rounded-full bg-warn-11/12 px-2 py-[3px] text-caption2 font-semibold uppercase leading-none tracking-wider text-warn-11"
            >
              Browsing
            </span>
            <Button variant="filled" size="small" className="whitespace-nowrap border border-line-strong bg-transparent hover:bg-white/10" onClick={() => onSelect(null)}>
              Back to live
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function PlanList({
  stops,
  loaded,
  groupLabel,
  currentPlanId,
  followedPlanId,
  timeZone,
  onChoose,
}: {
  stops: ReturnType<typeof dropdownPlans>;
  loaded: boolean;
  groupLabel: string | null;
  currentPlanId: string | null;
  followedPlanId: string | null;
  timeZone: string | null;
  onChoose: (planId: string) => void;
}) {
  // Open on the current plan, not the top of the list.
  function centreSelected(list: HTMLDivElement | null): void {
    const row = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (list && row) list.scrollTop = row.offsetTop - (list.clientHeight - row.offsetHeight) / 2;
  }

  if (!loaded) return <p className="px-3 py-3 text-footnote text-fg-subtle">Loading plans…</p>;
  if (stops.length === 0) {
    return <p className="px-3 py-3 text-footnote text-fg-subtle">No plans for this service type in the next 60 days.</p>;
  }
  return (
    <div ref={centreSelected} role="listbox" aria-label="Plans" className="relative max-h-72 overflow-y-auto pb-1.5">
      {groupLabel && <div className="px-3 pb-1 pt-2 text-caption2 font-semibold uppercase tracking-wider text-fg-faint">{groupLabel}</div>}
      {stops.map((e) => {
        const when = planWhen(e.sortDate, timeZone);
        const selected = e.planId === currentPlanId;
        return (
          <button
            key={e.planId}
            type="button"
            role="option"
            aria-selected={selected}
            onClick={() => e.planId && onChoose(e.planId)}
            className={cn(
              "flex w-full items-center gap-2.5 px-3 py-2 text-left outline-none hover:bg-white/10 focus-visible:bg-white/10",
              selected && "bg-accent/30",
            )}
          >
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="flex items-center text-footnote font-medium text-fg">
                <span className="truncate">{e.title || e.dates || "Plan"}</span>
                {e.planId === followedPlanId && (
                  <span className="ml-1.5 inline-flex shrink-0 items-center gap-1 rounded-full bg-live-9/12 px-1.5 py-[2px] text-caption2 font-semibold uppercase leading-none tracking-wider text-live-11">
                    <i className="size-1.5 rounded-full bg-live-9" />
                    Following
                  </span>
                )}
              </span>
              <span className="text-caption1 text-fg-subtle">{when.date ?? e.dates ?? ""}</span>
            </span>
            {when.time && <span className="shrink-0 font-mono text-caption2 text-fg-subtle">{when.time}</span>}
          </button>
        );
      })}
    </div>
  );
}
