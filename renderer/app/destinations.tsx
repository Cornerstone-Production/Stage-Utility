// The rail's contents and the router's route tree, from one list.
//
// Two lists would let a destination exist in the rail with no route (a dead
// link) or a route with no rail entry (an unreachable page). routes.test.tsx
// asserts this set matches the server's OPERATOR_PATHS exactly.
//
// Two lists exist here, not one, and the split is meaningful: DESTINATIONS is
// work, SETTINGS_DESTINATIONS is configuration you touch once. That is the whole
// point of the phase — History is a place you go, not a tab inside a thing
// called Settings.

import type { FunctionComponent, ReactNode } from "react";
import { useParams } from "@tanstack/react-router";
import {
  CableIcon,
  HouseIcon,
  ClockIcon,
  CalendarIcon,
  DropletIcon,
  ListChecksIcon,
  MonitorIcon,
  PaletteIcon,
  PlugIcon,
  SlidersHorizontalIcon,
  ZapIcon,
} from "lucide-react";

import { PatchView } from "../main/patch-view";
import { ScriptViewIndex } from "../main/scriptview-index-view";
import { ScriptViewPlan } from "../main/scriptview-plan-view";
import { BaptismOperator } from "../main/baptism-operator";
import { ServiceHistorySection } from "../settings/sections/service-history-section";
import { AutomationSection } from "../settings/sections/automation-section";
import { IntegrationsSection } from "../settings/sections/integrations-section";
import { PatchSection } from "../settings/sections/patch-section";
import { HomeRoute } from "./home/home-route";
import { ScreensRoute } from "./screens/screens-route";
import { ConsoleRoute } from "./console-route";
import { ViewEditorRoute } from "./screens/view-editor-route";
import { ScriptViewSection } from "../settings/sections/scriptview-section";
import {
  AdvancedRoute,
  BrandingRoute,
  PlanRoute,
} from "./settings-routes";

export interface Destination {
  /** Route path. Nested routes use the top-level segment for rail grouping. */
  path: string;
  label: string;
  /** Subtitle under the page title. Mirrors the old SECTION_DESC, so the same
   *  surface is described the same way wherever it is reached from. */
  description: string;
  icon: ReactNode;
  /** TanStack routes take function components; ComponentType would admit classes. */
  Component: FunctionComponent;
}

/** Work surfaces — the rail proper. */
export const DESTINATIONS: readonly Destination[] = [
  {
    path: "/",
    label: "Home",
    description: "This week's service, and what still needs setting up.",
    icon: <HouseIcon className="size-4" />,
    Component: HomeRoute,
  },
  {
    path: "/screens",
    label: "Screens",
    description: "Every physical screen, what it shows, and whether it is on.",
    icon: <MonitorIcon className="size-4" />,
    Component: ScreensRoute,
  },
  {
    path: "/scriptview",
    label: "ScriptView",
    description: "Pick a service to open its rundown.",
    icon: <ListChecksIcon className="size-4" />,
    Component: ScriptViewIndex,
  },
  {
    path: "/patch",
    label: "Patch",
    description: "This week's inputs and outputs — what's set, and what changed.",
    icon: <CableIcon className="size-4" />,
    // The volunteer-facing read view, NOT the settings editor. These are
    // different surfaces; the editor is reached from within this one.
    Component: PatchView,
  },
  {
    path: "/automation",
    label: "Automation",
    description: "When something happens in Stage, do something to a device.",
    icon: <ZapIcon className="size-4" />,
    Component: AutomationSection,
  },
  {
    path: "/plan",
    label: "Plan",
    description: "Which service and plan this machine follows.",
    icon: <CalendarIcon className="size-4" />,
    Component: PlanRoute,
  },
  {
    // The OPERATOR's history: edit times, merge a split service, delete. This is
    // what the old Settings → History tab was, and it keeps every control.
    //
    // Not at /history, which is a link handed to volunteers — it is tiled on the
    // display picker and listed under Connect → Tools. When the settings window
    // was folded into the app, this page took that URL and the read-only page
    // that used to own it was deleted, so the shared link silently gained Edit
    // times, Merge and Delete. Two surfaces again, as before.
    path: "/history/manage",
    label: "History",
    description: "Every service you've run — timing and attendance.",
    icon: <ClockIcon className="size-4" />,
    Component: ServiceHistorySection,
  },
  {
    path: "/baptism",
    label: "Baptisms",
    description: "Time testimonies and baptisms live. Splits, totals and averages can go on a display, with the “Baptism timer” layout object.",
    icon: <DropletIcon className="size-4" />,
    Component: BaptismOperator,
  },
];

/**
 * Configuration — reached under Settings rather than from the rail proper.
 *
 * Integrations moved from `/integrations` (where Phase 1a briefly put it) to
 * `/settings/integrations`: it is set-up-once configuration, not work. The old
 * path never shipped, so nothing is redirected.
 */
export const SETTINGS_DESTINATIONS: readonly Destination[] = [
  {
    path: "/settings/integrations",
    label: "Integrations",
    description: "Connect the gear and services that run your service.",
    icon: <PlugIcon className="size-4" />,
    Component: IntegrationsSection,
  },
  {
    path: "/settings/branding",
    label: "Branding",
    description: "Your organization's name, logo, and accent color.",
    icon: <PaletteIcon className="size-4" />,
    Component: BrandingRoute,
  },
  {
    path: "/settings/advanced",
    label: "Advanced",
    description: "Updates, network address, capture windows, and full config.",
    icon: <SlidersHorizontalIcon className="size-4" />,
    Component: AdvancedRoute,
  },
];

/** Every routed destination, work and configuration alike. */
export const ALL_DESTINATIONS: readonly Destination[] = [
  ...DESTINATIONS,
  ...SETTINGS_DESTINATIONS,
];

/**
 * Nav clusters. Each group answers one question, which is what an earlier set of
 * labels did not: "Output" had collected anything screen-adjacent (Patch is a
 * document, Integrations are devices), and "Identity" had become the bucket for
 * whatever fit nowhere.
 *
 * Deferred in Phase 1a because six destinations needed no grouping. The rail
 * now carries twelve.
 */
/** Home sits above the groups rather than inside one — it is the front door. */
export const UNGROUPED_PATHS = ["/"];

export const NAV_GROUPS: { label: string; paths: string[] }[] = [
  // What is shown. Patch belongs here because volunteers READ it at /patch; the
  // "output" in its description is XLR, not a display.
  { label: "Content", paths: ["/scriptview", "/patch"] },
  // Where it shows.
  { label: "Screens", paths: ["/screens"] },
  // What it talks to. Automation rules act ON integrations.
  { label: "Devices", paths: ["/automation"] },
  // A service you ran — one live, one recorded.
  { label: "Services", paths: ["/plan", "/history/manage", "/baptism"] },
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

/**
 * Nested routes that are reachable but not listed in the rail.
 *
 * The two editors live here rather than as rail entries because each is the
 * back of a surface that IS in the rail: you open Patch to read this week's
 * patch and edit it from there. Routing only the viewers is exactly how both
 * editors became unreachable when Settings dissolved — see reachable.test.ts.
 *
 * `/patch/edit` and `/scriptview/presets` are literal segments and cannot
 * collide with `$serviceType/$layout`, which is three deep.
 */
/**
 * Service history WITHOUT the destructive controls.
 *
 * The link volunteers are given: tiled on the display picker, listed under
 * Connect → Tools, and documented in docs/display-urls.md. It renders the same
 * section the operator's page does, so any change to History shows up in both —
 * just without Edit times, Merge or Delete.
 */
function ServiceHistoryShared() {
  return <ServiceHistorySection readOnly />;
}

export const NESTED_ROUTES: readonly { path: string; Component: FunctionComponent }[] = [
  // The shared read-only history. /history/manage is the operator's, in the rail.
  { path: "/history", Component: ServiceHistoryShared },
  { path: "/scriptview/$serviceType/$layout", Component: ScriptViewPlanRoute },
  { path: "/scriptview/presets", Component: ScriptViewSection },
  { path: "/patch/edit", Component: PatchSection },
  // A view's editor is its own page rather than a panel beside a master list.
  { path: "/screens/$viewId/edit", Component: ViewEditorRoute },
  // A console, in the shell. Phase 3 gave a View a surface but gave a console
  // nowhere to be: it rendered only on a panel Output, which meant the one
  // surface built for the operator was the one the operator could not open.
  { path: "/consoles/$viewId", Component: ConsoleRoute },
];
