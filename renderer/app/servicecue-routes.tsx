// The two ServiceCue pages a volunteer opens, as routes: in a module of their own
// because two route tables mount them. The operator app's (destinations.tsx) imports
// every page in the app, which the public viewer must not.

import { useParams } from "@tanstack/react-router";

import { ServiceCueIndex } from "../main/servicecue-index-view";
import { ServiceCuePlan } from "../main/servicecue-plan-view";

/** The tablet's launcher, which is also the public page's. */
export const SERVICECUE_LANDING_PATH = "/servicecue";

/**
 * A rundown. `/servicecue/presets` is a literal segment and cannot collide with
 * `$serviceType/$layout`, which is three deep.
 */
export const SERVICECUE_PLAN_PATH = "/servicecue/$serviceType/$layout";

/**
 * ServiceCuePlan takes its service type and layout as props, because the kiosk
 * router read them out of `window.location` and passed them down. Under a real
 * router they are route params, so this adapter supplies them.
 *
 * `strict: false` because this component is declared away from its route
 * definition; the params are validated by the route's path pattern.
 */
export function ServiceCuePlanRoute() {
  const params = useParams({ strict: false }) as {
    serviceType?: string;
    layout?: string;
  };
  return (
    <ServiceCuePlan
      serviceTypeParam={params.serviceType ?? ""}
      layoutParam={params.layout ?? ""}
    />
  );
}

/** The tablet's ServiceCue launcher: chromeless, so it draws its own heading. */
export function ServiceCueShared() {
  return <ServiceCueIndex standalone />;
}
