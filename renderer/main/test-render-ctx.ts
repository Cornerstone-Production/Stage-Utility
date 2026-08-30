// A LayoutRenderCtx for a test, TYPED — which is the whole point of the file.
//
// Five test files each built this by hand and cast it `as never`. That cast
// silently defeated the property the context was designed around: `embedChain`
// is a REQUIRED field precisely so a surface cannot forget it, because a
// forgotten one reports "nothing above me" and makes a cycle undetectable. With
// the cast in place, adding a required field broke no test, and the hand-built
// contexts drifted out of shape without anybody being told.
//
// So this returns a real `LayoutRenderCtx`, with no cast. Add a required field
// to the interface and this file stops compiling — which is the notification.

import type { LayoutRenderCtx } from "./layout-renderer";

/**
 * A StageState with every field at a quiet (off/empty) default. Exported so a
 * test can spread it into its own fixture and override only the fields its
 * scenario actually varies, instead of restating the whole shape.
 */
export const DEFAULT_STAGE_STATE: StageState = {
  serviceTypeId: null,
  serviceTypeName: null,
  planMode: "auto",
  planId: null,
  planTitle: null,
  planSeriesTitle: null,
  planDates: null,
  views: [],
  outputs: [],
  slotsByView: {},
  barItems: [],
  savedColors: [],
  notesByObject: {},
  slotsByLayoutObject: {},
  resolvedByOutput: {},
  pcoConfigured: false,
  lastRefreshedAt: null,
  remoteUrl: null,
  lanUrl: null,
  showQr: false,
  kioskDiscovery: false,
  allowedServiceTypeIds: [],
  checklistNoteCategories: [],
  checklistNoteTeams: [],
  appName: "",
  accentColor: null,
  appLogo: null,
  appLogoMonochrome: false,
  emptySlotLogo: null,
  defaultAvatar: null,
  ndiEnabled: false,
  publicUrl: null,
  captionChannelColors: {},
  chargerBays: [],
  autoUpdate: { mode: "manual", dayOfWeek: null, hour: 0 },
  reconnectSchedule: { enabled: false, leadMin: 0, tailMin: 0, dormantMin: 0 },
  taperWindow: { preMin: 0, postMin: 0 },
  timezone: null,
  hourCycle: "24h",
  hostTimezone: "UTC",
  onboardingDismissed: false,
};

/** Every field at a quiet default; override only what a test is about. */
export function makeRenderCtx(overrides: Partial<LayoutRenderCtx> = {}): LayoutRenderCtx {
  return {
    state: DEFAULT_STAGE_STATE,
    propresenter: null,
    propInstances: null,
    pcoLive: null,
    planItems: null,
    transcript: [],
    spl: null,
    obs: null,
    reaper: null,
    pvp: null,
    pvpSkewMs: 0,
    resi: null,
    youtube: null,
    osc: null,
    scores: null,
    peopleCount: null,
    serviceLow: null,
    serviceAttendance: null,
    servicePeak: null,
    servicePeakAttendance: null,
    baptism: null,
    serviceTimeline: null,
    integrations: [],
    integrationLabels: {},
    wireless: [],
    now: 0,
    skewMs: 0,
    ndiSource: null,
    H: 1080,
    interactive: false,
    placed: undefined,
    home: false,
    embedChain: [],
    insideEmbedTile: false,
    onlineOutputIds: [],
    ...overrides,
  };
}
