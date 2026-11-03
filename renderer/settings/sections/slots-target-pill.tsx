// The words the Mic slots page and the plan switcher use for a target: a plan's
// short date, "the Weekend", the save message and the discard question.
//
// ONE copy of each, because there are several callers and the same phrase written
// twice is how one of them stays wrong. (This file also holds the type that names
// the two sides, so it stays importable on its own: the public ServiceCue bundle
// takes it, and servicecue-public-build.test.ts pins that.)

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { confirm, toast } from "../../components/ui";
import { invoke as ipc } from "../../lib/api";
import { useStageState } from "../../main/use-stage-state";
import { useEditingTarget } from "./editing-target";

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

/**
 * "the Weekend" / "The Gathering" / "the service type".
 *
 * A service type's name is whatever somebody typed into Planning Center, and
 * some of them open with an article — five different strings said
 * "the The Gathering default". `capital` is for a sentence that starts with it.
 *
 * ONE copy, because there are five callers: the save toast, the revert
 * confirmation, the promote confirmation, the promote toast and the preview
 * caption. The same phrase written five times is how one of them stays wrong.
 */
export function namedType(serviceTypeName: string | null, capital = false): string {
  const name = serviceTypeName ?? "service type";
  if (/^the\s/i.test(name)) return capital ? name.charAt(0).toUpperCase() + name.slice(1) : name;
  return `${capital ? "The" : "the"} ${name}`;
}

/** "Saved slots for Wed Sep 13 · Youth Night" / "Saved the … default". */
export function savedMessage(side: SlotsTargetSide, label: string, serviceTypeName: string | null): string {
  if (side === "plan") {
    return serviceTypeName ? `Saved slots for ${label} · ${serviceTypeName}` : `Saved slots for ${label}`;
  }
  return serviceTypeName ? `Saved ${namedType(serviceTypeName)} default` : "Saved the default";
}

/**
 * "Switching loses what is in the buffer — still switch?"
 *
 * ONE copy, because there are four callers: the pill's two sides, the plan
 * switcher's arrows, its dropdown and its Now button, in two editors. The same
 * question asked in four slightly different words is how one of them ends up not
 * asking it at all.
 */
export async function confirmDiscardSlotEdits(): Promise<boolean> {
  return confirm({
    title: "Discard unsaved slot changes?",
    message: "Switching boards re-reads the saved slots, so anything unsaved here is lost.",
    confirmLabel: "Discard",
    destructive: true,
  });
}

/**
 * The service type and plan are IN the key.
 *
 * A board is plan- and type-dependent, so when the plan advances under an open
 * editor — auto mode does that on its own, and the state arrives over SSE — the
 * key changes and the layouts are re-read.
 */
export const boardTargetsKey = (boardId: string, serviceTypeId: string | null, planId: string | null) =>
  ["boards:targets", boardId, serviceTypeId, planId] as const;

/**
 * Which target the Mic slots page is editing: the plan the switcher is on, which
 * side of it (the service type's default or the plan's own), what to call them,
 * and the wire target a save carries.
 *
 * Read off ONE board's targets, because everything it takes from them (the plan's
 * date, the service type's name) is the same for every board. `side` is state here
 * because the SAVE has to agree with it: the editor asks for the wire target, and
 * there is exactly one place that turns a side into one.
 */
export function useSlotsTarget(boardId: string) {
  const { state } = useStageState();
  // Which plan is being edited — the machine's own until the switcher is moved.
  // The machine's plan is still `editing.live`, and nothing here writes it.
  const editing = useEditingTarget();

  const serviceTypeId = editing.target.serviceTypeId;
  const planId = editing.target.planId;

  const { data: targets } = useQuery({
    queryKey: boardTargetsKey(boardId, serviceTypeId, planId),
    // The target is IN the request. Without it the server answers for the plan the
    // machine is on, so stepping the switcher would relabel the page and leave the
    // grid showing the previous week's rows.
    queryFn: () => ipc<SlotTargetsDTO>("boards:targets", { id: boardId, serviceTypeId, planId }),
    enabled: !!boardId && !!serviceTypeId,
  });

  const hasPlan = !!planId;

  // Opens on the current plan when there is one, because that is the layout the
  // screens are showing and so the one an edit almost always means.
  const [ownSide, setOwnSide] = useState<SlotsTargetSide | null>(null);
  // The chosen side SURVIVES a target change, deliberately. Resetting it when the
  // type or plan changes also fires when stage state first hydrates — null ids
  // becoming real ones is a change — and that put the editor back on the plan
  // side one frame after an operator had pressed Default. A plan side with no plan
  // is corrected by `effectiveSide` below, which is the only case that has to be
  // handled at all.
  const side: SlotsTargetSide = ownSide ?? (hasPlan ? "plan" : "default");
  // A plan side with no plan is not selectable — an operator who was on it when
  // the plan cleared must not be left saving to a target that does not exist.
  const effectiveSide: SlotsTargetSide = side === "plan" && !hasPlan ? "default" : side;

  // The date of the plan BEING EDITED. Stage state is a fallback only while the
  // editor is on the machine's own plan, where it is the same plan and covers a
  // cold start before the first read lands. Off it, that fallback put the LIVE
  // plan's date on the page while another week was being edited — and on a Default
  // target, which has no plan at all, it named a date on a disabled button.
  const label = planLabel(
    targets?.planSortDate ?? null,
    targets?.planDates ?? (editing.onLive ? (state?.planDates ?? null) : null),
    state?.timezone ?? null,
  );

  /**
   * The service type BEING EDITED, named. Stage state is a fallback only while the
   * editor is on the machine's own type, for the same reason `label` above treats
   * it that way: off it, the fallback named another type's default with the live
   * type's name.
   */
  const typeName =
    targets?.serviceTypeName ??
    (serviceTypeId === (state?.serviceTypeId ?? null) ? (state?.serviceTypeName ?? null) : null);

  /** The wire target for a save on the current side. */
  function wireTarget(): Record<string, unknown> | undefined {
    // The type and plan being EDITED, which is the machine's own until the
    // switcher moves it. Omitted with no service type, which is the server's own
    // "there is nowhere to persist to".
    if (!serviceTypeId) return undefined;
    if (effectiveSide === "plan" && planId) {
      // The plan's date travels with the save. The server fills it in for the
      // CURRENT plan and cannot for any other, and an override with no date is
      // one the 30-day prune can never age out.
      return { kind: "plan", planId, serviceTypeId, sortDate: targets?.planSortDate ?? null };
    }
    return { kind: "default", serviceTypeId };
  }

  /** Say what was saved. `detail` follows the message (how many boards). */
  function announceSaved(detail?: string): void {
    // Amber whenever the editor is not on the plan the machine is following: the
    // save was real, and it changed nothing on any screen. Judged on the SWITCHER
    // target, not on the side — saving the default of the live plan's own type is
    // an ordinary thing to do and reads green. `toast.info` because there is no
    // amber variant to reach for.
    const message = savedMessage(effectiveSide, label, typeName) + (detail ? ` · ${detail}` : "");
    if (!editing.onLive) toast.info(message);
    else toast.success(message);
  }

  return {
    targets,
    /** Where the editor is pointed, and whether that is the machine's own plan. */
    editing,
    side: effectiveSide,
    setSide: setOwnSide,
    hasPlan,
    label,
    typeName,
    wireTarget,
    announceSaved,
  };
}
