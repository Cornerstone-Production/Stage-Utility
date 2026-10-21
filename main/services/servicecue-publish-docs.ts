// servicecue-publish-docs.ts — the pure half of what leaves the building.
//
// What the public page may know is decided here and nowhere else: which StageState
// fields, which part of the live position and the SPL recording, which service types
// and plans, which image. Kept apart from the publisher so each decision can be driven
// directly, with no network and no clock.
//
// Every projection is an allowlist, never a denylist: the state carries the server's
// LAN address, every screen and view, and the live position carries every item's title
// and due time. A field that is not named here cannot leave by being forgotten.

import { createHash } from "node:crypto";

import { startOfZonedDay, zonedDateKey } from "./app-timezone.js";
import { sortUpcoming } from "./upcoming-plans.js";
import type { PcoLiveDTO, ServiceCueConfig, ServiceSplHistory, ServiceTypeDTO, StageState, UpcomingPlan, UpcomingPlansDTO } from "../types/stage.js";
import { ASSET_PATH_PREFIX, PUBLIC_STATE_FIELDS, isAssetName, isPublishId, type PublicState } from "../types/servicecue-publish.js";

/**
 * The StageState a page may see: the allowlisted fields and no others, with the zone the
 * app's clocks actually run in.
 *
 * `timezone` is the EFFECTIVE zone, never null. The state holds the operator's own
 * setting, which is null while the app follows the host's clock, and a page that read
 * null would draw every clock in the VISITOR'S zone, the "Not updating" bar included.
 */
export function publicState(state: StageState, effectiveTimeZone: string): PublicState {
  const out: Record<string, unknown> = {};
  for (const field of PUBLIC_STATE_FIELDS) out[field] = state[field];
  out.timezone = effectiveTimeZone;
  return out as unknown as PublicState;
}

/**
 * What the public ServiceCue pages read of the live position. Sorted. The countdown
 * (renderer/main/pco-timer.ts computePcoTimer), the live highlight (servicecue-body.tsx
 * useServiceCueRender: `mode`, `currentItemId`) and the clock (useServerClock: `serverNow`)
 * read exactly these. `itemSchedule`, `planTimes`, the item titles and the service time are
 * the rundown's and the automation engine's, and stay in the building.
 */
export const PUBLIC_LIVE_FIELDS = ["currentItemId", "label", "lengthSec", "liveStartAt", "mode", "serverNow", "targetAt"] as const satisfies readonly (keyof PcoLiveDTO)[];

export type PublicLive = Pick<PcoLiveDTO, (typeof PUBLIC_LIVE_FIELDS)[number]>;

export function publicLive(live: PcoLiveDTO): PublicLive {
  const out: Record<string, unknown> = {};
  for (const field of PUBLIC_LIVE_FIELDS) out[field] = live[field];
  return out as unknown as PublicLive;
}

/** The text a live position is compared by: everything the page reads but the clock, which moves on every push. */
export function liveFingerprint(live: PublicLive): string {
  return JSON.stringify({ ...live, serverNow: undefined });
}

/**
 * What the public ServiceCue pages read of the SPL recording: each item's id and its peak,
 * for the optional Max SPL column (use-spl-state.ts useSplHistory). Sorted.
 */
export const PUBLIC_SPL_FIELDS = ["items"] as const;
export const PUBLIC_SPL_ITEM_FIELDS = ["itemId", "maxSpl"] as const;

export interface PublicSpl {
  items: { itemId: string; maxSpl: number | null }[];
}

export function publicSpl(spl: ServiceSplHistory): PublicSpl {
  return {
    items: spl.items.map((item) => {
      const out: Record<string, unknown> = {};
      for (const field of PUBLIC_SPL_ITEM_FIELDS) out[field] = item[field];
      return out as unknown as PublicSpl["items"][number];
    }),
  };
}

/**
 * The service types the landing page shows, in its order.
 *
 * Exactly the ServiceCue config's ids: the landing page lists those and no others, so
 * nothing else is published. An id the page could not carry in a document key is dropped,
 * and a repeat is counted once.
 */
export function landingTypeIds(config: ServiceCueConfig): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of config.serviceTypeIds ?? []) {
    if (!isPublishId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** The service types the landing page shows, from every type Planning Center has. */
export function landingTypes(all: ServiceTypeDTO[], ids: readonly string[]): ServiceTypeDTO[] {
  const wanted = new Set(ids);
  return all.filter((t) => wanted.has(t.id));
}

// ── The plans the page's switcher offers ─────────────────────────────────────

/** A plan the page has been given, and how many complete plan lists in a row have not had it. */
export interface KnownPlan {
  plan: UpcomingPlan;
  missing: number;
}

/** A plan that is not in this many complete lists in a row is taken off the page (unless its date has already passed, which takes it off at once). */
export const DROP_AFTER_MISSING = 3;

const planKey = (p: UpcomingPlan): string => `${p.serviceTypeId}:${p.planId}`;

/** Has this plan's date gone by? A plan with no date has not: nothing says it is over. */
export function datePassed(plan: UpcomingPlan, todayStartMs: number): boolean {
  const at = plan.sortDate ? Date.parse(plan.sortDate) : NaN;
  return Number.isFinite(at) && at < todayStartMs;
}

/** The start of today in the app's zone, for datePassed and the upcoming count. */
export function startOfToday(timeZone: string, now = Date.now()): number {
  return startOfZonedDay(zonedDateKey(now, timeZone), timeZone);
}

/**
 * The plans the page has been given, after a fresh plan list.
 *
 * The list is the truth about a plan it holds, and nothing like it about a plan it does not:
 * a type whose read failed, or whose recent plans did, is MISSING plans, and taking them off
 * the page for that deletes rundowns a volunteer may be looking at. So:
 *   - a plan in the list is kept, as the list has it;
 *   - a plan of a type the list marked incomplete is kept as it was;
 *   - any other plan not in the list is dropped when its date has passed, or when it has been
 *     absent from DROP_AFTER_MISSING complete lists in a row;
 *   - a plan of a type no longer on the landing page is dropped.
 */
export function mergePlans(prev: readonly KnownPlan[], list: UpcomingPlansDTO, landingIds: readonly string[], todayStartMs: number): KnownPlan[] {
  const landing = new Set(landingIds);
  const incomplete = new Set(list.incompleteTypeIds ?? []);
  const fresh = list.plans.filter((p) => landing.has(p.serviceTypeId) && isPublishId(p.planId));
  const inList = new Set(fresh.map(planKey));
  const out: KnownPlan[] = fresh.map((plan) => ({ plan, missing: 0 }));
  for (const known of prev) {
    if (inList.has(planKey(known.plan)) || !landing.has(known.plan.serviceTypeId)) continue;
    if (incomplete.has(known.plan.serviceTypeId)) {
      out.push(known);
      continue;
    }
    const missing = known.missing + 1;
    if (datePassed(known.plan, todayStartMs) || missing >= DROP_AFTER_MISSING) continue;
    out.push({ plan: known.plan, missing });
  }
  const order = new Map(sortUpcoming(out.map((k) => k.plan)).map((p, i) => [planKey(p), i]));
  return out.sort((a, b) => order.get(planKey(a.plan))! - order.get(planKey(b.plan))!);
}

/**
 * The switcher list as the page is given it.
 *
 * `isCurrent` is the plan the machine follows NOW, not when the plan was last read, and
 * `cacheAgeMs` is pinned: it is how old the app's own cache happens to be, grows between
 * refreshes, and would make the document different every time it is read.
 */
export function upcomingDoc(plans: readonly UpcomingPlan[], followed: { typeId: string | null; planId: string | null }): UpcomingPlansDTO {
  return {
    plans: plans.map((p) => ({ ...p, isCurrent: p.serviceTypeId === followed.typeId && p.planId === followed.planId })),
    cacheAgeMs: 0,
  };
}

/** How many of the plans are today's or later. The ones from last week are in the switcher too, but they are not upcoming. */
export function countUpcoming(plans: readonly UpcomingPlan[], todayStartMs: number): number {
  return plans.filter((p) => p.sortDate !== null && !datePassed(p, todayStartMs)).length;
}

/**
 * The image file a state's logo points at, when it is a stored image.
 *
 * The page asks for `/branding-images/<name>`, the same address the app serves it at, so
 * the name is kept. A logo that is anything else (a data URL from an install that has not
 * migrated yet, or null) has no file to send.
 */
export function brandingAssetName(appLogo: unknown): string | null {
  if (typeof appLogo !== "string" || !appLogo.startsWith(ASSET_PATH_PREFIX)) return null;
  const name = appLogo.slice(ASSET_PATH_PREFIX.length);
  return isAssetName(name) ? name : null;
}

/** A short stable fingerprint of a document's text. */
export function docHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
