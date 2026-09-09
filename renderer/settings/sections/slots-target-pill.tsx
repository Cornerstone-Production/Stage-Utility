// Default | <this plan> — which of a board's two targets the editor is on.
//
// A mic board has a DEFAULT per service type (what the type comes back to) and,
// optionally, an override for the current Planning Center plan. This pill picks
// which one the grid below shows and saves to.
//
// One component and one hook, shared by both editors: a slots-kind View's editor
// and an inline slots-grid object's. They keep their boards in the same file
// under the same rules, and the last time this shape existed twice the two
// copies drifted.

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, ButtonGroup, toast, confirm } from "../../components/ui";
import { invoke as ipc } from "../../lib/api";
import { useStageState } from "../../main/use-stage-state";

/** Which board the editor is showing. Not the wire shape — see `SlotsTarget`. */
export type SlotsTargetSide = "default" | "plan";

/**
 * "Wed Sep 13" from the plan's PCO sort_date.
 *
 * Falls back to the plan's dates AS PLANNING CENTER WORDS THEM when there is no
 * sort_date to format — parsing that string into a weekday would be guessing at
 * a format somebody typed, and a wrong date on this pill points a save at the
 * wrong week.
 */
export function planLabel(
  planSortDate: string | null,
  planDates: string | null,
  timeZone: string | null,
): string {
  if (planSortDate) {
    const at = Date.parse(planSortDate);
    if (Number.isFinite(at)) {
      return new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        timeZone: timeZone ?? undefined,
      }).format(at);
    }
  }
  return planDates ?? "This plan";
}

/** "Saved slots for Wed Sep 13 · Cornerstone Youth" / "Saved the … default". */
export function savedMessage(side: SlotsTargetSide, label: string, serviceTypeName: string | null): string {
  if (side === "plan") {
    return serviceTypeName ? `Saved slots for ${label} · ${serviceTypeName}` : `Saved slots for ${label}`;
  }
  return serviceTypeName ? `Saved the ${serviceTypeName} default` : "Saved the default";
}

/**
 * The service type and plan are IN the key.
 *
 * A board is plan- and type-dependent, so when the plan advances under an open
 * editor — auto mode does that on its own, and the state arrives over SSE — the
 * key changes and the two boards are re-read. Keyed rather than refetched from
 * an effect because `useResyncOn` runs during render, where a fetch cannot go.
 */
const targetsKey = (scope: SlotsScope, key: string, serviceTypeId: string | null, planId: string | null) =>
  ["slots:targets", scope, key, serviceTypeId, planId];

/**
 * Everything the pill and its two actions need for one board.
 *
 * `side` is state here rather than in each editor because the SAVE has to agree
 * with it: the editor asks for the wire target, and there is exactly one place
 * that turns a side into one.
 */
export function useSlotsTarget(scope: SlotsScope, key: string) {
  const { state } = useStageState();
  const queryClient = useQueryClient();

  const serviceTypeId = state?.serviceTypeId ?? null;
  const planId = state?.planId ?? null;

  const { data: targets } = useQuery({
    queryKey: targetsKey(scope, key, serviceTypeId, planId),
    queryFn: () => ipc<SlotTargetsDTO>("slots:targets", { scope, key }),
    enabled: !!key,
  });

  // From the SSE state, which is already in hand — not from the query, which is
  // a round trip away. Reading them off `targets` made the pill open on Default
  // and flip to the plan a frame later, every time.
  const hasPlan = !!planId;
  const hasOverride = targets?.overrideSlots != null;

  // Opens on the current plan when there is one, because that is the board the
  // screens are showing and so the one an edit almost always means.
  const [ownSide, setOwnSide] = useState<SlotsTargetSide | null>(null);
  const side: SlotsTargetSide = ownSide ?? (hasPlan ? "plan" : "default");
  // A plan side with no plan is not selectable — an operator who was on it when
  // the plan cleared must not be left saving to a target that does not exist.
  const effectiveSide: SlotsTargetSide = side === "plan" && !hasPlan ? "default" : side;

  const label = planLabel(
    targets?.planSortDate ?? null,
    targets?.planDates ?? state?.planDates ?? null,
    state?.timezone ?? null,
  );

  /** The rows the grid should show for the current side. */
  const slotsForSide: Slot[] | null = !targets
    ? null
    : effectiveSide === "plan"
      ? (targets.overrideSlots ?? targets.defaultSlots)
      : targets.defaultSlots;

  /** The wire target for a save on the current side. */
  function wireTarget(): Record<string, unknown> | undefined {
    // The LIVE type and plan, so a save cannot land on a plan that has since
    // advanced. Omitted with no service type, which is the server's own "there is
    // nowhere to persist to".
    if (!serviceTypeId) return undefined;
    if (effectiveSide === "plan" && planId) {
      return { kind: "plan", planId, serviceTypeId };
    }
    return { kind: "default", serviceTypeId };
  }

  function announceSaved(): void {
    // The amber case — a target that is not the plan the screens follow — cannot
    // happen yet: the pill only offers the CURRENT plan. The variant is chosen
    // here so the plan switcher can make it reachable without touching a toast
    // call site. `toast.info` because there is no amber variant to reach for.
    const offTarget = false;
    const message = savedMessage(effectiveSide, label, state?.serviceTypeName ?? null);
    if (offTarget) toast.info(message);
    else toast.success(message);
  }

  async function invalidate(): Promise<void> {
    // Prefix match: the key carries the type and plan, and a caller invalidating
    // after a write does not care which of them it was keyed by.
    await queryClient.invalidateQueries({ queryKey: ["slots:targets", scope, key] });
  }

  /** Revert to default — drop this plan's override. */
  async function revert(): Promise<boolean> {
    if (!planId) return false;
    const ok = await confirm({
      title: `Revert ${label} to the default?`,
      message: `The slots saved for ${label} are deleted and this screen goes back to the ${state?.serviceTypeName ?? "service type"} default.`,
      confirmLabel: "Revert",
      destructive: true,
    });
    if (!ok) return false;
    try {
      const next = await ipc<StageState>("slots:clearOverride", { scope, key, planId });
      queryClient.setQueryData(["stage:getState"], next);
      await invalidate();
      setOwnSide("default");
      toast.success(`Reverted ${label} to the default.`);
      return true;
    } catch (err) {
      toast.error(`Failed to revert: ${String(err)}`);
      return false;
    }
  }

  /** Set as default — promote this plan's board onto the service type. */
  async function promote(): Promise<boolean> {
    if (!planId) return false;
    const ok = await confirm({
      title: `Make ${label} the default?`,
      message: `The ${state?.serviceTypeName ?? "service type"} default is replaced by the slots saved for ${label}, and ${label} stops being an exception.`,
      confirmLabel: "Set as default",
      destructive: true,
    });
    if (!ok) return false;
    try {
      const next = await ipc<StageState>("slots:promoteOverride", { scope, key, planId });
      queryClient.setQueryData(["stage:getState"], next);
      await invalidate();
      setOwnSide("default");
      toast.success(`${label} is now the ${state?.serviceTypeName ?? "service type"} default.`);
      return true;
    } catch (err) {
      toast.error(`Failed to set as default: ${String(err)}`);
      return false;
    }
  }

  return {
    targets,
    side: effectiveSide,
    setSide: setOwnSide,
    hasPlan,
    hasOverride,
    label,
    slotsForSide,
    wireTarget,
    announceSaved,
    invalidate,
    revert,
    promote,
  };
}

/**
 * The pill itself.
 *
 * `onSwitch` returns false to refuse the switch — the editors use it to ask
 * about unsaved edits first, the same way leaving the page does. Switching with
 * a buffer full of edits and losing them silently is the one failure this
 * control can cause.
 */
export function SlotsTargetPill({
  side,
  label,
  hasPlan,
  hasOverride,
  disabled,
  onSwitch,
  onRevert,
  onPromote,
}: {
  side: SlotsTargetSide;
  label: string;
  hasPlan: boolean;
  hasOverride: boolean;
  disabled?: boolean;
  onSwitch: (next: SlotsTargetSide) => void;
  onRevert: () => void;
  onPromote: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <ButtonGroup role="group" aria-label="Which slots to edit">
        <Button
          variant={side === "default" ? "accent" : "filled"}
          aria-pressed={side === "default"}
          size="small"
          disabled={disabled}
          title="The board this service type comes back to every week"
          onClick={() => onSwitch("default")}
        >
          Default
        </Button>
        <Button
          variant={side === "plan" ? "accent" : "filled"}
          aria-pressed={side === "plan"}
          size="small"
          disabled={disabled || !hasPlan}
          title={
            hasPlan
              ? "Slots for this plan only — the next plan goes back to the default"
              : "No plan is selected, so there is nothing to make an exception for"
          }
          onClick={() => onSwitch("plan")}
        >
          {label}
          {hasOverride && (
            <span
              className="ml-1 rounded px-1 text-caption2 bg-amber-4 text-amber-11"
              data-slots-edited="true"
            >
              edited
            </span>
          )}
        </Button>
      </ButtonGroup>
      {/* Both discard something, so both confirm. Only offered when there IS an
          override — "Revert to default" with nothing to revert is a dead button. */}
      {hasOverride && (
        <>
          <Button variant="filled" size="small" disabled={disabled} onClick={onRevert}>
            Revert to default
          </Button>
          <Button variant="filled" size="small" disabled={disabled} onClick={onPromote}>
            Set as default
          </Button>
        </>
      )}
    </div>
  );
}
