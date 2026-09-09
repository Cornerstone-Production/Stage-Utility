// ‹ name ▾ › — which board the editor is editing.
//
// It moves the EDITOR. It never changes which plan the screens follow; that is
// the Plan page's job and nothing here writes it. The badge says which of the two
// you are looking at: `live` while the editor is on the plan the machine is
// following, `editing` while it is anywhere else.
//
// One component, used in the slots-View editor's header, the inline grid's, and
// the layout editor's toolbar. The target it reads and writes lives in
// editing-target.ts, so all three agree without any of them owning it.

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Button, Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../../components/ui";
import { invoke as ipc } from "../../lib/api";
import { useStageState } from "../../main/use-stage-state";
import { useEditingTarget } from "./editing-target";
import { planLabel } from "./slots-target-pill";
import {
  decodeTarget,
  encodeTarget,
  stepTarget,
  switcherOptions,
  typeName,
  type EditingTarget,
  type SwitcherEntry,
} from "./plan-switcher-step";

/** How far ahead the switcher looks. Two months covers anything planned. */
const UPCOMING_DAYS = 60;

/**
 * The list the arrows walk.
 *
 * `staleTime` matches the server's own cache, so a switcher mounted three times
 * while an operator moves between editors does not re-ask for a list the server
 * would answer from memory anyway.
 */
export function useUpcomingPlans() {
  const { data } = useQuery({
    queryKey: ["plans:upcoming", UPCOMING_DAYS],
    queryFn: () => ipc<UpcomingPlansDTO>("plans:upcoming", { days: UPCOMING_DAYS }),
    staleTime: 5 * 60 * 1000,
  });
  return {
    plans: data?.plans ?? [],
    unavailable: data?.unavailable ?? null,
    /** Undefined until the first answer lands; the arrows stay inert until then. */
    loaded: data !== undefined,
  };
}

/** "Wed Sep 10 · Cornerstone Youth", or "Cornerstone Youth default". */
function entryLabel(entry: SwitcherEntry, timeZone: string | null, withType: boolean): string {
  if (entry.planId === null) {
    return entry.serviceTypeName ? `${entry.serviceTypeName} default` : "Default";
  }
  const date = planLabel(entry.sortDate, entry.dates, timeZone);
  return withType && entry.serviceTypeName ? `${date} · ${entry.serviceTypeName}` : date;
}

export function PlanSwitcher({ disabled }: { disabled?: boolean }) {
  const { state } = useStageState();
  const editing = useEditingTarget();
  const { plans, unavailable, loaded } = useUpcomingPlans();
  const mode: PlanSwitcherMode = state?.planSwitcherMode ?? "upcoming";
  const timeZone = state?.timezone ?? null;
  const target = editing.target;

  const back = stepTarget(plans, mode, target, -1);
  const forward = stepTarget(plans, mode, target, 1);
  const options = switcherOptions(plans, mode, target);

  // Every allowed service type the list carries, for within-type mode's middle.
  const types: { id: string; name: string }[] = [];
  for (const p of plans) {
    if (!types.some((t) => t.id === p.serviceTypeId)) {
      types.push({ id: p.serviceTypeId, name: p.serviceTypeName });
    }
  }
  if (target.serviceTypeId && !types.some((t) => t.id === target.serviceTypeId)) {
    types.push({ id: target.serviceTypeId, name: state?.serviceTypeName ?? "This service type" });
  }

  const currentLabel =
    target.planId === null
      ? `${typeName(plans, target.serviceTypeId) ?? state?.serviceTypeName ?? "Service type"} default`
      : entryLabel(
          options.plans.find((e) => e.planId === target.planId) ?? {
            serviceTypeId: target.serviceTypeId ?? "",
            // The machine's own plan is labelled from stage state, which always
            // has it — the list may not, during an outage.
            serviceTypeName: state?.serviceTypeName ?? "",
            planId: target.planId,
            sortDate: null,
            dates: state?.planDates ?? null,
            title: state?.planTitle ?? "",
          },
          timeZone,
          true,
        );

  const inert = !!disabled || !loaded;

  function go(next: EditingTarget | null): void {
    if (!next) return;
    void editing.setTarget(next);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-plan-switcher={mode}>
      <div className="flex items-center gap-1">
        <Button
          variant="filled"
          size="small"
          aria-label="Previous plan"
          disabled={inert || !back}
          onClick={() => go(back)}
        >
          <ChevronLeftIcon className="size-3.5 text-gray-9" />
        </Button>

        {mode === "within-type" ? (
          // The middle names the TYPE; the arrows walk that type's plans, Default
          // first. Switching type lands on that type's default, which is the one
          // stop every type is guaranteed to have.
          <Select
            value={target.serviceTypeId ?? ""}
            disabled={inert || types.length === 0}
            onValueChange={(id: string) => go({ serviceTypeId: id, planId: null })}
          >
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Service type…" />
            </SelectTrigger>
            <SelectContent>
              {types.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Select
            value={encodeTarget(target)}
            disabled={inert}
            onValueChange={(v: string) => go(decodeTarget(v))}
          >
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Plan…" />
            </SelectTrigger>
            <SelectContent>
              {/* The current target is always among the options — a native select
                  whose value is not in its list renders blank, which reads as "no
                  plan" rather than "a plan the list has not got". */}
              {!options.plans.some((e) => e.planId === target.planId) && target.planId && (
                <SelectItem value={encodeTarget(target)}>{currentLabel}</SelectItem>
              )}
              {options.plans.map((e) => (
                <SelectItem key={encodeTarget(e)} value={encodeTarget(e)}>
                  {entryLabel(e, timeZone, true)}
                </SelectItem>
              ))}
              {options.defaults.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Defaults…</SelectLabel>
                  {options.defaults.map((e) => (
                    <SelectItem key={encodeTarget(e)} value={encodeTarget(e)}>
                      {entryLabel(e, timeZone, false)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
        )}

        <Button
          variant="filled"
          size="small"
          aria-label="Next plan"
          disabled={inert || !forward}
          onClick={() => go(forward)}
        >
          <ChevronRightIcon className="size-3.5 text-gray-9" />
        </Button>
      </div>

      {/* Green while the editor is on the plan the screens follow; amber the rest
          of the time. The one thing an operator has to be able to read at a
          glance before pressing Save. */}
      <span
        className={
          editing.onLive
            ? "rounded px-1.5 py-0.5 text-caption2 bg-green-4 text-green-11"
            : "rounded px-1.5 py-0.5 text-caption2 bg-amber-4 text-amber-11"
        }
        data-plan-switcher-badge={editing.onLive ? "live" : "editing"}
      >
        {editing.onLive ? "live" : "editing"}
      </span>

      <Button
        variant="filled"
        size="small"
        disabled={inert || editing.onLive}
        title="Back to the plan the screens are following"
        onClick={() => void editing.goLive()}
      >
        Now
      </Button>

      {unavailable && (
        <span className="text-caption2 text-amber-10" title={unavailable}>
          Planning Center unreachable
        </span>
      )}
    </div>
  );
}
