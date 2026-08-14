// The rail's contents and the router's route tree, from one list.
//
// Two lists would let a destination exist in the rail with no route (a dead
// link) or a route with no rail entry (an unreachable page). routes.test.tsx
// asserts this set matches the server's OPERATOR_PATHS exactly.

import type { FunctionComponent, ReactNode } from "react";
import { useParams } from "@tanstack/react-router";
import {
  CableIcon,
  ClockIcon,
  DropletIcon,
  ListChecksIcon,
  PlugIcon,
  ZapIcon,
} from "lucide-react";

import { PatchView } from "../main/patch-view";
import { ScriptViewIndex } from "../main/scriptview-index-view";
import { ScriptViewPlan } from "../main/scriptview-plan-view";
import { BaptismOperator } from "../main/baptism-operator";
import { ServiceHistorySection } from "../settings/sections/service-history-section";
import { AutomationSection } from "../settings/sections/automation-section";
import { IntegrationsSection } from "../settings/sections/integrations-section";

export interface Destination {
  /** Route path. Nested routes use the top-level segment for rail grouping. */
  path: string;
  label: string;
  icon: ReactNode;
  /** TanStack routes take function components; ComponentType would admit classes. */
  Component: FunctionComponent;
}

export const DESTINATIONS: readonly Destination[] = [
  {
    path: "/patch",
    label: "Patch",
    icon: <CableIcon className="size-4" />,
    // The volunteer-facing read view, NOT the settings editor. These are
    // different surfaces; the editor is reached from within this one.
    Component: PatchView,
  },
  {
    path: "/scriptview",
    label: "ScriptView",
    icon: <ListChecksIcon className="size-4" />,
    Component: ScriptViewIndex,
  },
  {
    path: "/history",
    label: "History",
    icon: <ClockIcon className="size-4" />,
    // The same component the settings tab renders. history-view.tsx was a
    // 38-line wrapper around it and is deleted once this route exists.
    Component: ServiceHistorySection,
  },
  {
    path: "/baptism",
    label: "Baptisms",
    icon: <DropletIcon className="size-4" />,
    Component: BaptismOperator,
  },
  {
    path: "/automation",
    label: "Automation",
    icon: <ZapIcon className="size-4" />,
    Component: AutomationSection,
  },
  {
    path: "/integrations",
    label: "Integrations",
    icon: <PlugIcon className="size-4" />,
    Component: IntegrationsSection,
  },
];

/**
 * ScriptViewPlan takes its service type and layout as props, because the kiosk
 * router read them out of `window.location` and passed them down. Under a real
 * router they are route params, so this adapter supplies them.
 *
 * `strict: false` because this component is declared away from its route
 * definition; the params are validated by the route's path pattern.
 */
function ScriptViewPlanRoute() {
  const params = useParams({ strict: false }) as {
    serviceType?: string;
    layout?: string;
  };
  return (
    <ScriptViewPlan
      serviceTypeParam={params.serviceType ?? ""}
      layoutParam={params.layout ?? ""}
    />
  );
}

/** Nested routes that are reachable but not listed in the rail. */
export const NESTED_ROUTES: readonly { path: string; Component: FunctionComponent }[] = [
  { path: "/scriptview/$serviceType/$layout", Component: ScriptViewPlanRoute },
];
