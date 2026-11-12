// servicecue-server.ts — a ServiceCue settings server for the layouts page's tests.
//
// It keeps what the real one keeps (layouts, roles, which service types the landing
// page shows) and saves them by the store's own rules: prepareLayoutsSave for the
// layouts, cleanRoles for the roles, and the seed route's "add a role for each
// category no role covers". Planning Center's half (service types, each type's note
// categories, a plan) is whatever the test hands it.
//
// Every request is recorded, so a test can say which writes went out and in what order.

import { cleanRoles, seedRoles } from "../../main/services/servicecue-roles-store.js";
import { prepareLayoutsSave } from "../../main/services/servicecue-slug.js";
import type { ServiceCueLayout } from "../../main/types/pco.js";
import type { CategoryRole } from "../../main/types/servicecue-roles.js";
import { ok, stubFetchWithLog, type ClientLogLine } from "./fetch-log.js";

export interface ServiceCueServerSetup {
  layouts?: ServiceCueLayout[];
  roles?: CategoryRole[];
  shown?: string[];
  types?: { id: string; name: string }[];
  /** Each service type's note categories. */
  cats?: Record<string, string[]>;
  rundown?: (typeId: string) => unknown;
  views?: { id: string; name: string; serviceCueLayoutId?: string | null }[];
  pcoConfigured?: boolean;
  /** Answer a route yourself: return (or resolve to) undefined to fall through to the
   *  default, which is how a test holds a request back and then lets it answer as usual. */
  override?: (url: string, init?: RequestInit) => unknown;
}

export interface Request {
  method: string;
  path: string;
  body: unknown;
}

const EMPTY_RUNDOWN = {
  planId: null, planTitle: null, planSeriesTitle: null, planDates: null, items: [],
  noteCategories: [], serviceTimes: [], timeZone: null, isActivePlan: false, isDefaultPlan: true,
};

export function serviceCueServer(setup: ServiceCueServerSetup = {}): {
  requests: Request[];
  logs: ClientLogLine[];
  layouts: () => ServiceCueLayout[];
  roles: () => CategoryRole[];
  shown: () => string[];
  restore: () => void;
} {
  let layouts = prepareLayoutsSave(setup.layouts ?? [], []);
  let roles = cleanRoles(setup.roles ?? []);
  let shown = setup.shown ?? [];
  const cats = setup.cats ?? {};
  const requests: Request[] = [];
  const f = stubFetchWithLog(async (url, init) => {
    const u = new URL(url, "http://x");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path: u.pathname, body });
    const own = await setup.override?.(url, init);
    if (own !== undefined) return own;
    const typeId = u.searchParams.get("serviceTypeId") ?? "";
    switch (`${method} ${u.pathname}`) {
      case "GET /api/state":
        return ok({ pcoConfigured: setup.pcoConfigured ?? true, views: setup.views ?? [] });
      case "GET /api/service-types":
        return ok(setup.types ?? []);
      case "GET /api/servicecue/layouts":
        return ok(layouts);
      case "POST /api/servicecue/layouts":
        layouts = prepareLayoutsSave((body as { layouts: ServiceCueLayout[] }).layouts, layouts);
        return ok(layouts);
      case "GET /api/servicecue/roles":
        return ok(roles);
      case "POST /api/servicecue/roles":
        roles = cleanRoles((body as { roles: CategoryRole[] }).roles);
        return ok(roles);
      case "POST /api/servicecue/roles/seed": {
        const covered = new Set(roles.flatMap((r) => r.members.map((m) => m.trim().toLowerCase())));
        const missing = (cats[(body as { serviceTypeId: string }).serviceTypeId] ?? []).filter((c) => !covered.has(c.trim().toLowerCase()));
        roles = [...roles, ...seedRoles(missing, roles.map((r) => r.id))];
        return ok(roles);
      }
      case "GET /api/servicecue/config":
        return ok({ serviceTypeIds: shown });
      case "POST /api/servicecue/config":
        shown = (body as { serviceTypeIds: string[] }).serviceTypeIds;
        return ok({ serviceTypeIds: shown });
      case "GET /api/servicecue/note-categories":
        return ok(cats[typeId] ?? []);
      case "GET /api/servicecue/rundown":
        return ok(setup.rundown?.(typeId) ?? { ...EMPTY_RUNDOWN, serviceTypeId: typeId });
      case "GET /api/servicecue/publish":
        return ok({ enabled: false, url: "", token: "", status: { state: "off" } });
      default:
        return ok({});
    }
  });
  return {
    requests,
    logs: f.logs,
    layouts: () => [...layouts].sort((a, b) => a.order - b.order),
    roles: () => roles,
    shown: () => shown,
    restore: f.restore,
  };
}
