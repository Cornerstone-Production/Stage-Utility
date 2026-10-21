// publish-source.ts — a ServiceCue install, as the publisher reads one.
//
// Three service types: 100 and 200 are on the landing page, 300 is not. Type 100 has two plans in
// its switcher (1001, which the app follows, and 1002), type 200 has one, and 300 has one that must
// never leave. The state, the live position and the SPL recording carry fields that must never leave
// either, each named for what it is so a leak reads plainly in a failure.

import type {
  PcoLiveDTO,
  ServiceCueLayout,
  ServiceCueRundownDTO,
  ServiceSplHistory,
  ServiceTypeDTO,
  StageState,
  UpcomingPlan,
  UpcomingPlansDTO,
} from "../../types/stage.js";
import type { CategoryRole } from "../../types/servicecue-roles.js";
import type { PublishSource } from "../servicecue-publisher.js";

export const TYPES: ServiceTypeDTO[] = [
  { id: "100", name: "Weekend" },
  { id: "200", name: "Youth" },
  { id: "300", name: "Hidden" },
];

/** The type that is not on the landing page, and its one plan: what a funeral on a weekday looks like. */
export const HIDDEN = { typeId: "300", planId: "3001" };

const plan = (serviceTypeId: string, planId: string, isCurrent = false, sortDate = "2099-11-01T15:00:00Z"): UpcomingPlan => ({
  serviceTypeId,
  serviceTypeName: TYPES.find((t) => t.id === serviceTypeId)!.name,
  planId,
  title: `Plan ${planId}`,
  sortDate,
  dates: "November 1, 2099",
  isCurrent,
});

export const PLANS: UpcomingPlan[] = [plan("100", "1001", true), plan("100", "1002"), plan("200", "2001"), plan("300", HIDDEN.planId)];

/** The plan each type opens on with no choice made. */
const DEFAULT_PLAN: Record<string, string> = { "100": "1001", "200": "2001", "300": "3001" };

export const LAYOUTS: ServiceCueLayout[] = [
  { id: "svl1", name: "Audio", order: 0, columnRoles: ["role-audio"] },
  { id: "svl2", name: "Video", order: 1, columnRoles: ["role-video"] },
];

export const ROLES: CategoryRole[] = [{ id: "role-audio", name: "Audio", members: ["Audio"] }];

/** The live position of the followed plan: the fields the public pages read, and canaries in the ones they do not. */
export const LIVE: PcoLiveDTO = {
  mode: "item",
  currentItemId: "item-1",
  label: "Welcome",
  itemType: "canary-item-type",
  lengthSec: 120,
  liveStartAt: "2099-11-01T15:04:00.000Z",
  targetAt: null,
  serverNow: "2099-11-01T15:05:00.000Z",
  currentItemTitle: "Canary Item Title",
  nextItemTitle: "Canary Next Title",
  serviceTimeId: "canary-time",
  serviceTimeStartsAt: "2099-11-01T15:00:00.000Z",
  itemSchedule: [{ title: "Canary Schedule Item", dueAt: "2099-11-01T15:10:00.000Z", exact: true }],
  planTimes: [{ id: "canary-plan-time", name: "Canary Rehearsal", timeType: "rehearsal", startsAt: "2099-10-31T19:00:00.000Z" }],
};

/** The recording of the followed plan: item ids and their peaks are public, everything else is canary. */
export const SPL: ServiceSplHistory = {
  serviceKey: "100:1001:canary-time",
  serviceTypeId: "100",
  planId: "1001",
  planTitle: "Canary Plan Title",
  seriesTitle: "Canary Series",
  serviceDate: "2099-11-01",
  serviceTimeId: "canary-time",
  serviceTimeStartsAt: "2099-11-01T15:00:00.000Z",
  meterId: "canary-meter",
  metricKey: "canary-metric",
  startedAt: "2099-11-01T15:00:00.000Z",
  endedAt: null,
  items: [
    {
      itemId: "item-1",
      title: "Canary Song",
      sequence: 0,
      metrics: { "canary-metric": { max: 97, avg: 90, leq: 91, count: 10 } },
      maxSpl: 97,
      leqSpl: 90,
      itemType: "canary-item-type",
      sampleCount: 10,
      startedAt: "2099-11-01T15:00:00.000Z",
      endedAt: null,
    },
  ],
};

/** A state with everything the page may see, and a canary in everything it may not. */
export function fixtureState(over: Partial<Record<string, unknown>> = {}): StageState {
  return {
    pcoConfigured: true,
    accentColor: "#2e6691",
    appLogo: "/branding-images/0123456789abcdef.png",
    appLogoMonochrome: true,
    hourCycle: "12h",
    timezone: "America/Chicago",
    // None of these may leave the building. The custom tab icon is one: its image is served by
    // a route the page does not have, so the tab follows the logo.
    appIcon192: "/branding-images/canary-icon.png",
    appName: "Canary Name",
    lanUrl: "http://canary-lan.invalid:8788",
    remoteUrl: "http://canary-remote.invalid:8788",
    publicUrl: "https://canary-public.invalid",
    hostTimezone: "Canary/Host",
    serviceTypeId: "100",
    planId: "1001",
    views: [{ id: "canary-view" }],
    outputs: [{ id: "canary-output" }],
    notesByObject: { canary: { text: "canary note" } },
    ...over,
  } as unknown as StageState;
}

export interface FixtureSource extends PublishSource {
  /** What the source was asked, for a test that says what was not read. */
  calls: {
    rundown: { typeId: string; planId: string | null; at: number }[];
    serviceTypes: number;
    upcoming: number;
    inFlight: number;
    peakInFlight: number;
  };
  /** Mutable: a test edits these between cycles. */
  data: {
    landing: string[];
    layouts: ServiceCueLayout[];
    state: StageState;
    /** The zone the app's clocks run in, which is not the state's own `timezone` while that is null. */
    timeZone: string;
    live: PcoLiveDTO | null;
    spl: ServiceSplHistory | null;
    plans: UpcomingPlan[];
    /** The types the plan list says it could not read in full. */
    incomplete: string[];
    tight: boolean;
    /** Between the service windows, with the schedule known. */
    dormant: boolean;
    /** Held open for this long inside a rundown read, so overlap would show. */
    rundownMs: number;
    /** A rundown read for this plan id throws. */
    failPlan: string | null;
    unavailable: string | null;
    images: Map<string, { data: Uint8Array; mime: string }>;
  };
}

export function fixtureSource(): FixtureSource {
  const calls: FixtureSource["calls"] = { rundown: [], serviceTypes: 0, upcoming: 0, inFlight: 0, peakInFlight: 0 };
  const data: FixtureSource["data"] = {
    // Derived, not written out: service-type-allowlist.test.ts keeps a list of ids from being
    // baked into any source file, and these are invented ones that would only look like one.
    landing: TYPES.filter((t) => t.name !== "Hidden").map((t) => t.id),
    layouts: LAYOUTS,
    state: fixtureState(),
    timeZone: "America/Chicago",
    live: LIVE,
    spl: SPL,
    plans: PLANS,
    incomplete: [],
    tight: false,
    dormant: false,
    rundownMs: 0,
    failPlan: null,
    unavailable: null,
    images: new Map(),
  };
  return {
    calls,
    data,
    config: async () => ({ serviceTypeIds: data.landing }),
    layouts: async () => data.layouts,
    roles: async () => ROLES,
    state: () => data.state,
    timeZone: () => data.timeZone,
    live: () => data.live,
    spl: () => data.spl,
    serviceTypes: async () => {
      calls.serviceTypes++;
      return TYPES;
    },
    upcoming: async (): Promise<UpcomingPlansDTO> => {
      calls.upcoming++;
      return {
        plans: data.plans,
        cacheAgeMs: 1234,
        ...(data.unavailable ? { unavailable: data.unavailable } : {}),
        ...(data.incomplete.length ? { incompleteTypeIds: data.incomplete } : {}),
      };
    },
    rundown: async (typeId, planId) => {
      calls.rundown.push({ typeId, planId, at: performance.now() });
      calls.inFlight++;
      calls.peakInFlight = Math.max(calls.peakInFlight, calls.inFlight);
      try {
        if (data.rundownMs) await new Promise((r) => setTimeout(r, data.rundownMs));
        if (planId !== null && planId === data.failPlan) throw new Error("Planning Center returned 503");
        const resolved = planId ?? DEFAULT_PLAN[typeId] ?? null;
        return {
          serviceTypeId: typeId,
          planId: resolved,
          planTitle: `Plan ${resolved}`,
          planSeriesTitle: null,
          planDates: null,
          items: [],
          noteCategories: [],
          serviceTimes: [],
          timeZone: "America/Chicago",
          isActivePlan: false,
          isDefaultPlan: resolved === DEFAULT_PLAN[typeId],
        } satisfies ServiceCueRundownDTO;
      } finally {
        calls.inFlight--;
      }
    },
    pcoTight: () => data.tight,
    dormant: () => data.dormant,
    brandingImage: async (name) => data.images.get(name) ?? null,
  };
}
