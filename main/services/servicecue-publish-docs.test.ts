// The pure half of what leaves the building: what the public may see of the state, the live position, the SPL
// recording and the plan list. One table to a function, and every list that must stay exact is literal, sorted,
// one entry to a line, so two branches adding a field touch different lines and a count cannot hide an add plus a remove.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DROP_AFTER_MISSING,
  PUBLIC_LIVE_FIELDS,
  PUBLIC_SPL_FIELDS,
  PUBLIC_SPL_ITEM_FIELDS,
  brandingAssetName,
  countUpcoming,
  datePassed,
  docHash,
  landingTypeIds,
  landingTypes,
  liveFingerprint,
  mergePlans,
  publicLive,
  publicSpl,
  publicState,
  upcomingDoc,
  type KnownPlan,
} from "./servicecue-publish-docs.js";
import { fixtureState, LIVE, PLANS, SPL, TYPES } from "./fixtures/publish-source.js";
import type { UpcomingPlan, UpcomingPlansDTO } from "../types/stage.js";

const DAY = 86_400_000;
const NOW = Date.parse("2099-11-01T12:00:00Z");
const TODAY = Date.parse("2099-11-01T00:00:00Z");

const plan = (typeId: string, planId: string, sortDate: string | null = "2099-11-08T15:00:00Z"): UpcomingPlan => ({
  serviceTypeId: typeId,
  serviceTypeName: `Type ${typeId}`,
  planId,
  title: `Plan ${planId}`,
  sortDate,
  dates: null,
  isCurrent: false,
});
const list = (plans: UpcomingPlan[], incompleteTypeIds?: string[]): UpcomingPlansDTO => ({ plans, cacheAgeMs: 0, ...(incompleteTypeIds ? { incompleteTypeIds } : {}) });
const known = (plans: UpcomingPlan[], missing = 0): KnownPlan[] => plans.map((p) => ({ plan: p, missing }));
const keys = (k: KnownPlan[]) => k.map((x) => `${x.plan.serviceTypeId}/${x.plan.planId}:${x.missing}`);

describe("what the public may see of the state", () => {
  it("is exactly these fields, with the zone the app's clocks run in", () => {
    const out = publicState(fixtureState({ timezone: null }), "Pacific/Auckland");
    assert.deepEqual(Object.keys(out).sort(), ["accentColor", "appLogo", "appLogoMonochrome", "hourCycle", "pcoConfigured", "timezone"]);
    assert.equal(out.timezone, "Pacific/Auckland", "the state's own null, or a zone it names, was published");
    assert.equal(publicState(fixtureState({ timezone: "Canary/Host" }), "America/Denver").timezone, "America/Denver");
  });
});

describe("what the public may see of the live position", () => {
  it("is exactly the fields the public pages read, whatever else the position carries", () => {
    // One field to a line, sorted. Adding one to the projection is a change to what leaves the building, and goes red here.
    assert.deepEqual([...PUBLIC_LIVE_FIELDS], ["currentItemId", "label", "lengthSec", "liveStartAt", "mode", "serverNow", "targetAt"]);
    const out = publicLive(LIVE);
    assert.deepEqual(Object.keys(out).sort(), [...PUBLIC_LIVE_FIELDS]);
    assert.equal(/canary/i.test(JSON.stringify(out)), false, "a field the public pages do not read was projected");
    assert.deepEqual(out, {
      currentItemId: LIVE.currentItemId,
      label: LIVE.label,
      lengthSec: LIVE.lengthSec,
      liveStartAt: LIVE.liveStartAt,
      mode: LIVE.mode,
      serverNow: LIVE.serverNow,
      targetAt: LIVE.targetAt,
    });
  });

  it("is compared without the clock, which moves on every push", () => {
    const later = publicLive({ ...LIVE, serverNow: "2099-11-01T15:09:00.000Z" });
    assert.equal(liveFingerprint(later), liveFingerprint(publicLive(LIVE)));
    assert.notEqual(liveFingerprint(publicLive({ ...LIVE, currentItemId: "item-2" })), liveFingerprint(publicLive(LIVE)));
    assert.notEqual(liveFingerprint(publicLive({ ...LIVE, mode: "none" })), liveFingerprint(publicLive(LIVE)));
  });
});

describe("what the public may see of the SPL recording", () => {
  it("is each item's id and peak, and nothing else of it", () => {
    assert.deepEqual([...PUBLIC_SPL_FIELDS], ["items"]);
    assert.deepEqual([...PUBLIC_SPL_ITEM_FIELDS], ["itemId", "maxSpl"]);
    const out = publicSpl(SPL);
    assert.deepEqual(Object.keys(out), ["items"]);
    assert.deepEqual(out.items.map((i) => Object.keys(i).sort()), [["itemId", "maxSpl"]]);
    assert.deepEqual(out, { items: [{ itemId: "item-1", maxSpl: 97 }] });
    assert.equal(/canary/i.test(JSON.stringify(out)), false, "a field the public pages do not read was projected");
  });
});

describe("the service types and plans the landing page offers", () => {
  it("lists the types on the landing page in its order, once each, and none a document key could not carry", () => {
    const cases: [string[], string[]][] = [
      [["200", "100", "200", "x1", "", "12345678901234567890123"], ["200", "100"]],
      [[], []],
    ];
    for (const [ids, want] of cases) assert.deepEqual(landingTypeIds({ serviceTypeIds: ids }), want, JSON.stringify(ids));
    assert.deepEqual(landingTypeIds({} as never), []);
    assert.deepEqual(landingTypes(TYPES, ["200", "100"]).map((t) => t.id), ["100", "200"]);
  });

  it("keeps a plan the list has, as the list has it", () => {
    const merged = mergePlans(known([plan("100", "1")], 2), list([{ ...plan("100", "1"), dates: "Renamed" }, plan("100", "2")]), ["100"], TODAY);
    assert.deepEqual(keys(merged), ["100/1:0", "100/2:0"]);
    assert.equal(merged[0]!.plan.dates, "Renamed");
  });

  it("keeps the plans of a type the list could not read in full, and counts nothing against them", () => {
    const prev = known([plan("100", "1"), plan("200", "2")], 1);
    const merged = mergePlans(prev, list([plan("100", "1")], ["200"]), ["100", "200"], TODAY);
    assert.deepEqual(keys(merged), ["100/1:0", "200/2:1"]);
  });

  it("drops a plan after it is missing from three complete lists in a row, and not before", () => {
    let merged = known([plan("100", "1"), plan("100", "2")]);
    for (let i = 1; i < DROP_AFTER_MISSING; i++) {
      merged = mergePlans(merged, list([plan("100", "1")]), ["100"], TODAY);
      assert.deepEqual(keys(merged), ["100/1:0", `100/2:${i}`], `after ${i} complete lists without it`);
    }
    merged = mergePlans(merged, list([plan("100", "1")]), ["100"], TODAY);
    assert.deepEqual(keys(merged), ["100/1:0"]);
  });

  it("does not count an absence while the type was not read in full, so three lists in a row means complete ones", () => {
    let merged = known([plan("100", "1"), plan("100", "2")]);
    merged = mergePlans(merged, list([plan("100", "1")]), ["100"], TODAY);
    merged = mergePlans(merged, list([plan("100", "1")], ["100"]), ["100"], TODAY);
    merged = mergePlans(merged, list([plan("100", "1")]), ["100"], TODAY);
    assert.deepEqual(keys(merged), ["100/1:0", "100/2:2"], "an incomplete list counted as an absence");
  });

  it("drops a plan at once when its date has passed, and one with no date is never over", () => {
    const yesterday = new Date(TODAY - DAY).toISOString();
    const merged = mergePlans(known([plan("100", "old", yesterday), plan("100", "undated", null)]), list([]), ["100"], TODAY);
    assert.deepEqual(keys(merged), ["100/undated:1"]);
    assert.equal(datePassed(plan("100", "x", yesterday), TODAY), true);
    assert.equal(datePassed(plan("100", "x", new Date(TODAY).toISOString()), TODAY), false, "today's plan is not over");
    assert.equal(datePassed(plan("100", "x", null), TODAY), false);
  });

  it("drops the plans of a type taken off the landing page, and offers none of a type that was never on it", () => {
    const merged = mergePlans(known([plan("100", "1"), plan("200", "2")]), list([plan("100", "1"), plan("300", "3")]), ["100"], TODAY);
    assert.deepEqual(keys(merged), ["100/1:0"]);
  });

  it("is in the order the app's switcher walks, soonest first", () => {
    const later = plan("100", "91", "2099-12-01T00:00:00Z");
    const sooner = plan("200", "92", "2099-11-02T00:00:00Z");
    assert.deepEqual(keys(mergePlans([], list([later, sooner]), ["100", "200"], TODAY)), ["200/92:0", "100/91:0"]);
  });
});

describe("the switcher list the page is given", () => {
  it("flags the plan the machine follows now, and pins the cache age that would change the text on every read", () => {
    const doc = upcomingDoc(PLANS, { typeId: "100", planId: "1002" });
    assert.equal(doc.cacheAgeMs, 0);
    assert.deepEqual(doc.plans.filter((p) => p.isCurrent).map((p) => p.planId), ["1002"]);
    assert.deepEqual(upcomingDoc(PLANS, { typeId: null, planId: null }).plans.filter((p) => p.isCurrent), []);
  });

  it("counts only the plans that are today's or later: last week's are in the list and are not upcoming", () => {
    const plans = [plan("100", "last", new Date(TODAY - 3 * DAY).toISOString()), plan("100", "today", new Date(NOW).toISOString()), plan("100", "next"), plan("100", "undated", null)];
    assert.equal(countUpcoming(plans, TODAY), 2);
  });
});

describe("the logo and the fingerprints", () => {
  it("names the stored image a logo points at, and none for anything else", () => {
    const cases: [unknown, string | null][] = [
      ["/branding-images/0123456789abcdef.png", "0123456789abcdef.png"],
      ["/branding-images/a.svg", "a.svg"],
      ["/branding-images/../secrets.bin", null],
      ["/branding-images/", null],
      ["/branding-images/.", null],
      ["/other/0123456789abcdef.png", null],
      ["data:image/png;base64,AAAA", null],
      [null, null],
      [42, null],
    ];
    for (const [logo, name] of cases) assert.equal(brandingAssetName(logo), name, String(logo));
  });

  it("fingerprints a text the same way every time, and differently for another", () => {
    assert.equal(docHash("a"), docHash("a"));
    assert.notEqual(docHash("a"), docHash("b"));
    assert.match(docHash("a"), /^[0-9a-f]{16}$/);
  });
});
