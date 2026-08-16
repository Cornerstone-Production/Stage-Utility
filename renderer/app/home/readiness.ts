// "What is not ready for Sunday" — the question the app could not answer.
//
// Pure, so it is testable without rendering, and so each check can say what to
// DO about itself rather than only that it failed. Landing on the right page
// still leaves you hunting; every failing check therefore carries a route, and
// where a specific control fixes it, a flash target too (see flash.ts).
//
// Deliberately not a score or a percentage. An operator on a Thursday wants the
// list of things to fix, not a number that says 80%.

import { screensListViews } from "@main/services/home-view";

export interface ReadinessCheck {
  /** Stable key. Duplicates would render one check twice and hide another. */
  id: string;
  label: string;
  /** What the current state actually is — the reason, not a restatement. */
  detail: string;
  ok: boolean;
  /** Where to fix it. Present on every check that can fail. */
  route?: string;
  /** `data-flash-id` of the control that fixes it, when one control does. */
  flash?: string;
}

/**
 * @param state  Current stage state.
 * @param onlineOutputIds  Output ids currently connected, from the
 *   `displays:presence` channel. Empty is a legitimate answer (nothing is on),
 *   not an error.
 */
export function readinessChecks(
  state: StageState,
  onlineOutputIds: readonly string[],
): ReadinessCheck[] {
  const online = new Set(onlineOutputIds);
  const outputs = state.outputs ?? [];
  // Home excluded: it is seeded on every install, so counting it would tick "a
  // view of your own" before the operator had made one, and inflate the count
  // shown beside it by one forever.
  const views = screensListViews(state.views ?? []);

  const unassigned = outputs.filter((o) => !o.viewId);
  const offline = outputs.filter((o) => !online.has(o.id));

  return [
    {
      id: "pco",
      label: "Planning Center connected",
      detail: state.pcoConfigured
        ? (state.serviceTypeName ?? "connected")
        : "no credentials yet — plans and the live countdown need this",
      ok: state.pcoConfigured,
      route: "/settings/integrations",
      flash: "pco-credentials",
    },
    {
      id: "plan",
      label: "A plan selected",
      // Degrades rather than throwing: a fresh install has no plan AND no PCO,
      // and that is the only time anyone sees this list.
      detail: state.planTitle ?? (state.pcoConfigured ? "no plan chosen" : "connect Planning Center first"),
      ok: !!state.planId,
      route: "/",
      flash: "plan-selection",
    },
    {
      id: "views",
      label: "A view of your own",
      // A fresh install ships one View, so "any views?" is true before the
      // operator has done anything. Measuring going BEYOND the default is what
      // Getting Started does, for the same reason.
      detail: views.length > 1 ? `${views.length} views` : "only the one that shipped with the app",
      ok: views.length > 1,
      route: "/screens",
      flash: "views-list",
    },
    {
      id: "assigned",
      label: "Every screen has a view",
      detail:
        outputs.length === 0
          ? "no screens set up yet"
          : unassigned.length === 0
            ? `${outputs.length} screen${outputs.length === 1 ? "" : "s"} routed`
            : `${unassigned.map((o) => o.name).join(", ")} showing nothing`,
      ok: outputs.length > 0 && unassigned.length === 0,
      route: "/screens",
    },
    {
      id: "online",
      label: "Screens online",
      detail:
        outputs.length === 0
          ? "no screens set up yet"
          : offline.length === 0
            ? `all ${outputs.length} connected`
            : `${offline.map((o) => o.name).join(", ")} not connected`,
      ok: outputs.length > 0 && offline.length === 0,
      route: "/screens",
    },
  ];
}

/** The checks that still need attention, in the order they should be fixed. */
export function outstanding(checks: readonly ReadinessCheck[]): ReadinessCheck[] {
  return checks.filter((c) => !c.ok);
}
