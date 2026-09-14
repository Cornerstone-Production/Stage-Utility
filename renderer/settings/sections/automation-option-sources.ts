// automation-option-sources.ts — what a param declaring `optionsFrom` is offered.
//
// A trigger, condition or action param whose options can only be known at
// runtime names a SOURCE rather than listing them: `optionsFrom: "osc-targets"`.
// main/types/automation.ts declares the closed set of source names; this module
// is the only thing that answers them, and the rule editor reads nothing else.
//
// ONE RECORD, EXHAUSTIVE OVER THAT SET. `OptionSources` is keyed by the union
// itself, so a ninth source added to ParamDef.optionsFrom is a compile error
// here until it is answered. That is the guarantee this file exists for: two of
// the eight had no answer at all, and each was a select offering "Pick one…" and
// nothing else —
//
//   osc-targets     the `osc.send` action could not be configured on any install
//                   from the day it shipped (fixed in 177a1f93)
//   service-types   the "Service type is" condition, same shape, still dead
//   displays        the display connect/disconnect triggers, whose param stores
//                   an output ID and offered no list to pick one from
//
// A subset type would have caught none of them. automation-option-sources.test.ts
// closes the other half: that the union has no member no registry param uses.

import { useMemo } from "react";

import type { ParamDef } from "@main/types/automation";
import { invoke } from "../../lib/api";
import { useQuery } from "@tanstack/react-query";
import { useServiceTypes, useStageStateQuery } from "../../app/queries";

/** One runtime option source's name — the closed set ParamDef declares. */
export type OptionSourceKey = NonNullable<ParamDef["optionsFrom"]>;

/** One choice in a select or a datalist. */
export interface Option {
  value: string;
  label: string;
}

/** One source's answer. */
export interface OptionSource {
  options: Option[];
}

/** Every source, answered. Exhaustive by type — see the header. */
export type OptionSources = Record<OptionSourceKey, OptionSource>;

/**
 * An option source's answer as an ARRAY, whatever came back.
 *
 * `?? []` guards null and undefined and nothing else, so a source that answered
 * with an object — an error body, a route that changed shape, a mocked fetch
 * with no case for this URL — reached `.map` and threw inside the useMemo. That
 * is not a missing dropdown: it unmounts the whole Automation section and the
 * operator gets a blank page where their rules were. Every source goes through
 * here rather than eight copies of the same ternary.
 */
function list<T>(v: T[] | undefined): T[] {
  return Array.isArray(v) ? v : [];
}

/**
 * What the queries below answered, as they answered it.
 *
 * Every field optional and every shape the RAW wire shape, because that is what
 * a half-loaded page and a server mid-upgrade actually hand over. Taken as one
 * argument so {@link buildOptionSources} is pure and the key list below can be
 * read off the real record without rendering anything.
 */
export interface OptionSourceAnswers {
  rosstalkTargets?: { targets?: { id: string; name: string }[] };
  rosstalkCommands?: { id: string; label: string }[];
  oscTargets?: { id: string; name: string }[];
  planItems?: { items?: Option[] };
  propresenterInstances?: { items?: Option[] };
  propresenterMacros?: { items?: Option[] };
  serviceTypes?: { id: string; name: string }[];
  /** The app's own display outputs. See the "displays" source below. */
  outputs?: { id: string; name: string }[];
}

/** PURE. Every source's options from one set of answers. */
export function buildOptionSources(a: OptionSourceAnswers): OptionSources {
  return {
    "rosstalk-targets": { options: list(a.rosstalkTargets?.targets).map((t) => ({ value: t.id, label: t.name })) },
    "rosstalk-commands": { options: list(a.rosstalkCommands).map((c) => ({ value: c.id, label: c.label })) },
    "osc-targets": { options: list(a.oscTargets).map((t) => ({ value: t.id, label: t.name })) },
    "plan-items": { options: list(a.planItems?.items) },
    "propresenter-instances": { options: list(a.propresenterInstances?.items) },
    "propresenter-macros": { options: list(a.propresenterMacros?.items) },
    // The VALUE is Planning Center's service-type id, which is what
    // `service.type-is` compares `ctx.serviceTypeId` against. Ids are stable in
    // PCO, unlike a plan item's, so one picked today still means this service
    // type next year.
    "service-types": { options: list(a.serviceTypes).map((t) => ({ value: t.id, label: t.name })) },
    // The VALUE is the OUTPUT ID, not the name on the card: display-presence.ts
    // keys its connected set by output id and `display.connected` matches
    // against that set. The param is labelled "Display" and stores an id, so
    // without this list an operator had to read one out of a URL and type it.
    "displays": { options: list(a.outputs).map((o) => ({ value: o.id, label: o.name })) },
  };
}

/**
 * Every source name, read off the real record rather than restated.
 *
 * A second hand-written list would be a second thing to forget, which is the
 * failure this module is fixing. automation-option-sources.test.ts asserts this
 * equals — exactly, both ways — the set of `optionsFrom` values the three
 * shipped registries actually ask for.
 */
export const OPTION_SOURCE_KEYS = Object.keys(buildOptionSources({})) as OptionSourceKey[];

/**
 * Every source, live.
 *
 * The three that cost a network call outside this box — plan items, the
 * ProPresenter pair — each answer with a list whatever the booth machines are
 * doing (an unreachable one yields an empty list, never an error), so none can
 * stop the editor opening. The macro read is cached server-side for 30s, which
 * is what keeps re-opening the editor off the LAN.
 *
 * Stage state and service types go through the app-wide queries so the
 * Automation page shares one cache entry with the rest of settings rather than
 * refetching. `useServiceTypes` is already gated on PCO being configured: on a
 * machine with no credentials the request can only fail, and ungated it filled
 * the server log with handler errors.
 */
export function useOptionSources(): OptionSources {
  const { data: rosstalkTargets } = useQuery({
    queryKey: ["rosstalk:targets"],
    queryFn: () => invoke<{ targets: { id: string; name: string }[] }>("rosstalk:targets"),
  });
  const { data: rosstalkCommands } = useQuery({
    queryKey: ["rosstalk:commands"],
    queryFn: () => invoke<{ id: string; label: string }[]>("rosstalk:commands"),
  });
  // Local config, so this costs no network — the same shape as rosstalk-targets
  // beside it, which was wired when this was not.
  const { data: oscTargets } = useQuery({
    queryKey: ["osc:listTargets"],
    queryFn: () => invoke<{ id: string; name: string }[]>("osc:listTargets"),
  });
  const { data: planItems } = useQuery({
    queryKey: ["automation:plan-items"],
    queryFn: () => invoke<{ items: Option[] }>("automation:plan-items"),
  });
  const { data: propresenterInstances } = useQuery({
    queryKey: ["automation:propresenter-instances"],
    queryFn: () => invoke<{ items: Option[] }>("automation:propresenter-instances"),
  });
  const { data: propresenterMacros } = useQuery({
    queryKey: ["automation:propresenter-macros"],
    queryFn: () => invoke<{ items: Option[] }>("automation:propresenter-macros"),
  });
  const { data: stageState } = useStageStateQuery();
  const { data: serviceTypes } = useServiceTypes(stageState);

  const outputs = stageState?.outputs;
  return useMemo(
    () =>
      buildOptionSources({
        rosstalkTargets,
        rosstalkCommands,
        oscTargets,
        planItems,
        propresenterInstances,
        propresenterMacros,
        serviceTypes,
        outputs,
      }),
    [
      rosstalkTargets,
      rosstalkCommands,
      oscTargets,
      planItems,
      propresenterInstances,
      propresenterMacros,
      serviceTypes,
      outputs,
    ],
  );
}
