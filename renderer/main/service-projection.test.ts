// When the service is projected to end.
//
// The pacing widget answers "how far off plan are we"; this answers the version
// an operator actually asks out loud — "when do we get out of here". Same data,
// rearranged, so the interesting properties are the ones about NOT answering:
// a widget that draws a confident wrong time is worse than one that draws a dash.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { projectedServiceEndMs } from "./pco-timer.js";

// Invented ids and titles. Nothing here names a real plan, service type or org.
const T0 = Date.parse("2026-08-30T15:00:00.000Z");

type Item = {
  id: string;
  title: string;
  itemType: string;
  lengthSec: number;
  sequence: number;
  notesByCategory: Record<string, string>;
  description: string | null;
  servicePosition?: string | null;
};

function item(id: string, lengthSec: number, servicePosition?: string): Item {
  return {
    id,
    title: id,
    itemType: "item",
    lengthSec,
    sequence: 0,
    notesByCategory: {},
    description: null,
    ...(servicePosition ? { servicePosition } : {}),
  };
}

function plan(...items: Item[]): PlanItemsDTO {
  return { planId: "plan-1", items: items as unknown as PlanItemDTO[], noteCategories: [] };
}

function live(over: Partial<PcoLiveDTO> = {}): PcoLiveDTO {
  return {
    mode: "item",
    currentItemId: "welcome",
    label: "Welcome",
    lengthSec: 300,
    liveStartAt: new Date(T0).toISOString(),
    targetAt: null,
    serverNow: new Date(T0).toISOString(),
    currentItemTitle: "Welcome",
    nextItemTitle: "Song",
    serviceTimeId: null,
    serviceTimeStartsAt: null,
    ...over,
  } as PcoLiveDTO;
}

// Welcome 5:00, Song 20:00, Message 30:00 — 55 minutes from the top.
const PLAN = plan(item("welcome", 300), item("song", 1200), item("message", 1800));

describe("the projection", () => {
  test("is the live item's planned end plus everything after it", () => {
    const end = projectedServiceEndMs(live(), PLAN, T0);
    assert.equal(end, T0 + 55 * 60 * 1000);
  });

  test("does not move while the live item runs INSIDE its plan", () => {
    // The property that keeps a wall readable. `now + remaining` is the same
    // arithmetic, but computing it that way at each tick is where a 11:32/11:33
    // flicker comes from; a service that is on plan has one answer.
    const at = (sec: number) => projectedServiceEndMs(live(), PLAN, T0 + sec * 1000);
    assert.equal(at(0), at(1));
    assert.equal(at(0), at(299));
  });

  test("is pushed out in real time once the live item runs long", () => {
    // Welcome is 5:00. At 7:30 in we are 2:30 over, and the end has moved by
    // exactly that — this is the "grows while you keep talking" behaviour the
    // drift figure has, expressed as a time.
    const end = projectedServiceEndMs(live(), PLAN, T0 + 450 * 1000);
    assert.equal(end, T0 + (450 + 1200 + 1800) * 1000);
  });

  test("counts from the item PCO says is live, not from the top of the plan", () => {
    const end = projectedServiceEndMs(live({ currentItemId: "song", liveStartAt: new Date(T0).toISOString() }), PLAN, T0);
    assert.equal(end, T0 + (1200 + 1800) * 1000);
  });

  test("leaves out post-service items", () => {
    // "When does the service end" is not "when does the building empty". A plan
    // that marks nothing keeps whatever trails it, which is all it can do.
    const p = plan(item("welcome", 300), item("song", 1200), item("exit-music", 900, "post"));
    assert.equal(projectedServiceEndMs(live(), p, T0), T0 + (300 + 1200) * 1000);
  });

  test("treats a later item with no length as zero rather than refusing", () => {
    // Matches ScriptView's projected clock column: a half-filled-in plan reads
    // early, not blank.
    const p = plan(item("welcome", 300), item("song", 0), item("message", 1800));
    assert.equal(projectedServiceEndMs(live(), p, T0), T0 + (300 + 1800) * 1000);
  });
});

describe("when there is no honest answer", () => {
  const none = (l: PcoLiveDTO | null, p: PlanItemsDTO | null = PLAN, now = T0) =>
    assert.equal(projectedServiceEndMs(l, p, now), null);

  test("nothing is live", () => {
    none(null);
    none(live({ mode: "none", currentItemId: null }));
    none(live({ mode: "preservice", currentItemId: null, liveStartAt: null }));
  });

  test("the service is already over", () => {
    // PCO's own SERVICE END marker. Without this the widget goes on projecting
    // an end for a service that finished, which is the most confident kind of
    // wrong time it could draw.
    none(live({ serviceEnded: true }));
  });

  test("the plan rundown has not loaded", () => {
    none(live(), null);
    none(live(), plan());
  });

  test("the live item is not in the rundown", () => {
    // A plan swapped underneath us, or an item deleted mid-service.
    none(live({ currentItemId: "not-in-this-plan" }));
  });

  test("the live item has no planned length", () => {
    // THE guard. Without the current item's length we do not know when it ends,
    // so no later item's start is known either — and adding up only the items
    // AFTER it reports the end of a service whose clock has not started. Here
    // that would have drawn 15:30 for a service nobody has timed.
    const p = plan(item("welcome", 0), item("song", 1200), item("message", 1800));
    none(live({ lengthSec: null }), p);
  });

  test("but PCO Live's own length rescues a rundown fetched before it was set", () => {
    // The rundown is cached; someone typing a length into PCO mid-service
    // updates the live feed first. Refusing on the stale copy would blank the
    // widget for as long as the cache lived.
    const p = plan(item("welcome", 0), item("song", 1200));
    assert.equal(projectedServiceEndMs(live({ lengthSec: 300 }), p, T0), T0 + (300 + 1200) * 1000);
  });

  test("the live start timestamp is unparseable", () => {
    none(live({ liveStartAt: "not a date" }));
  });
});
