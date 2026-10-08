// automation-option-sources.ts — what a param declaring `optionsFrom` is offered.
//
// A trigger, condition or action param whose options can only be known at
// runtime names a SOURCE rather than listing them: `optionsFrom: "osc-targets"`.
// main/types/automation.ts declares the closed set of source names; this module
// is the only thing that answers them, and the rule editor reads nothing else.
//
// ONE RECORD, EXHAUSTIVE OVER THAT SET. `OptionSources` is keyed by the union
// itself, so a tenth source added to ParamDef.optionsFrom is a compile error
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
import { EVERYONE } from "@main/types/messages";
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

/**
 * One source's answer, and why it is short when it is.
 *
 * `notice` is PER SOURCE rather than per field and rather than special-cased for
 * one provider, because ParamField renders every `optionsFrom` param through one
 * generic path: a ProPresenter-only affordance would need a second mechanism the
 * first time another source could be empty for a reason. Two already can —
 * macros when a booth machine did not answer, service types when Planning Center
 * is not set up — and both are the same sentence to an operator: the list you
 * are looking at is not the whole list, and here is why.
 *
 * Absent means "nothing to say", which is the normal case. A source that is
 * simply empty says nothing: "no OSC targets configured" is not news to somebody
 * who has configured none.
 */
export interface OptionSource {
  options: Option[];
  /** Shown under every field this source feeds. Absent when the list is whole. */
  notice?: string;
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
 * here rather than nine copies of the same ternary.
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
  /** `unreachable` names the instances that did not answer. ABSENT on a server
   *  that predates the field, and the notice is simply not shown then — the
   *  renderer must keep working against the older answer. */
  propresenterMacros?: { items?: Option[]; unreachable?: string[] };
  serviceTypes?: { id: string; name: string }[];
  /** Whether Planning Center has credentials at all. `undefined` while stage
   *  state is still in flight, which is NOT the same as false: reading it as
   *  false would flash "Planning Center is not set up" on every page load. */
  pcoConfigured?: boolean;
  /** The app's own display outputs. See the "displays" source below. */
  outputs?: { id: string; name: string }[];
  /** The messaging config, of which only the groups matter here. */
  messagingConfig?: { groups?: { id: string; name: string }[] };
}

/**
 * Why the macro list is short, or undefined when every instance answered.
 *
 * NAMED, not counted: "Chapel did not answer" is something an operator can go
 * and act on and "1 unreachable" is not — the route makes the same argument for
 * sending names in the first place.
 */
function macrosNotice(unreachable: string[]): string | undefined {
  const named = unreachable.filter((n) => typeof n === "string" && n.trim() !== "");
  if (named.length === 0) return undefined;
  return `${named.join(", ")} did not answer. A macro that only lives there is missing from this list.`;
}

/** PURE. Every source's options from one set of answers. */
export function buildOptionSources(a: OptionSourceAnswers): OptionSources {
  return {
    "rosstalk-targets": { options: list(a.rosstalkTargets?.targets).map((t) => ({ value: t.id, label: t.name })) },
    "rosstalk-commands": { options: list(a.rosstalkCommands).map((c) => ({ value: c.id, label: c.label })) },
    "osc-targets": { options: list(a.oscTargets).map((t) => ({ value: t.id, label: t.name })) },
    "plan-items": { options: list(a.planItems?.items) },
    "propresenter-instances": { options: list(a.propresenterInstances?.items) },
    "propresenter-macros": {
      options: list(a.propresenterMacros?.items),
      notice: macrosNotice(list(a.propresenterMacros?.unreachable)),
    },
    // The VALUE is Planning Center's service-type id, which is what
    // `service.type-is` compares `ctx.serviceTypeId` against. Ids are stable in
    // PCO, unlike a plan item's, so one picked today still means this service
    // type next year.
    "service-types": {
      options: list(a.serviceTypes).map((t) => ({ value: t.id, label: t.name })),
      notice:
        a.pcoConfigured === false
          ? "Planning Center is not set up, so there are no service types to offer."
          : undefined,
    },
    // The VALUE is the OUTPUT ID, not the name on the card: display-presence.ts
    // keys its connected set by output id and `display.connected` matches
    // against that set. The param is labelled "Display" and stores an id, so
    // without this list an operator had to read one out of a URL and type it.
    "displays": { options: list(a.outputs).map((o) => ({ value: o.id, label: o.name })) },
    // Everyone first, then the groups in the config's order; the VALUE is the id
    // `POST /api/messages` takes in `to`. Empty until the config has answered,
    // Everyone included: offering one choice while the groups are still loading
    // would mark a saved group as "no longer offered" for as long as that took.
    "message-groups": {
      options: Array.isArray(a.messagingConfig?.groups)
        ? [{ value: EVERYONE, label: "Everyone" }, ...a.messagingConfig.groups.map((g) => ({ value: g.id, label: g.name }))]
        : [],
    },
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
 * is what keeps re-opening the editor off the LAN — the six queries below
 * share that same 30s as their own client-side staleTime (react-query's
 * default is 0), for the same reason: the layout editor's action-button
 * Inspector remounts per selection, so a bare `useQuery` re-fetched all six on
 * every click between buttons, whatever those buttons' actions actually used —
 * selecting between four action buttons with no params at all issued ~28 GETs.
 * 30s trades a little staleness (a target added in Carbonite, an item added to
 * the plan, mid-edit) for not hammering the LAN every click; closing and
 * reopening the editor still forces a fresh read.
 *
 * Stage state and service types go through the app-wide queries so the
 * Automation page shares one cache entry with the rest of settings rather than
 * refetching. `useServiceTypes` is already gated on PCO being configured: on a
 * machine with no credentials the request can only fail, and ungated it filled
 * the server log with handler errors. Neither has a staleTime here: both live
 * in renderer/app/queries.ts, outside this module.
 */
const OPTION_SOURCE_STALE_MS = 30_000;

export function useOptionSources(): OptionSources {
  const { data: rosstalkTargets } = useQuery({
    queryKey: ["rosstalk:targets"],
    queryFn: () => invoke<{ targets: { id: string; name: string }[] }>("rosstalk:targets"),
    staleTime: OPTION_SOURCE_STALE_MS,
  });
  const { data: rosstalkCommands } = useQuery({
    queryKey: ["rosstalk:commands"],
    queryFn: () => invoke<{ id: string; label: string }[]>("rosstalk:commands"),
    staleTime: OPTION_SOURCE_STALE_MS,
  });
  // Local config, so this costs no network — the same shape as rosstalk-targets
  // beside it, which was wired when this was not.
  const { data: oscTargets } = useQuery({
    queryKey: ["osc:listTargets"],
    queryFn: () => invoke<{ id: string; name: string }[]>("osc:listTargets"),
    staleTime: OPTION_SOURCE_STALE_MS,
  });
  const { data: planItems } = useQuery({
    queryKey: ["automation:plan-items"],
    queryFn: () => invoke<{ items: Option[] }>("automation:plan-items"),
    staleTime: OPTION_SOURCE_STALE_MS,
  });
  const { data: propresenterInstances } = useQuery({
    queryKey: ["automation:propresenter-instances"],
    queryFn: () => invoke<{ items: Option[] }>("automation:propresenter-instances"),
    staleTime: OPTION_SOURCE_STALE_MS,
  });
  const { data: propresenterMacros } = useQuery({
    queryKey: ["automation:propresenter-macros"],
    queryFn: () => invoke<{ items: Option[]; unreachable?: string[] }>("automation:propresenter-macros"),
    staleTime: OPTION_SOURCE_STALE_MS,
  });
  // Local config, no network. The Messages settings page saves through a path of
  // its own, so a group added there reaches this list once the 30 seconds pass.
  const { data: messagingConfig } = useQuery({
    queryKey: ["messaging:get"],
    queryFn: () => invoke<{ groups: { id: string; name: string }[] }>("messaging:get"),
    staleTime: OPTION_SOURCE_STALE_MS,
  });
  const { data: stageState } = useStageStateQuery();
  const { data: serviceTypes } = useServiceTypes(stageState);

  const outputs = stageState?.outputs;
  const pcoConfigured = stageState?.pcoConfigured;
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
        pcoConfigured,
        messagingConfig,
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
      pcoConfigured,
      messagingConfig,
    ],
  );
}
