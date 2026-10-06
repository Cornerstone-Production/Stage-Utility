// What the ScriptView page's plan switcher decides, as plain data: which plans an
// arrow walks, what a pasted link names, where that plan lives, and the
// countdown a plan that is not the app's shows. The page driving all of it is
// scriptview-plan-switcher.test.tsx.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { startsInTimer } from "./pco-timer.js";
import { dropdownPlans, parsePlanLink, placePastedPlan, plansOfType, stepPlan } from "./scriptview-plan-choice.js";

function plan(serviceTypeId: string, planId: string, serviceTypeName = serviceTypeId): UpcomingPlan {
  return { serviceTypeId, serviceTypeName, planId, title: planId, sortDate: null, dates: null, isCurrent: false };
}

// Weekend and Youth interleave by date, as the server's one list does.
const LIST = [plan("w", "1", "Weekend"), plan("y", "2", "Youth"), plan("w", "3", "Weekend"), plan("w", "4", "Weekend")];

describe("the plans an arrow walks", () => {
  test("are this type's, in the list's own order", () => {
    assert.deepEqual(plansOfType(LIST, "w").map((p) => p.planId), ["1", "3", "4"]);
    assert.deepEqual(dropdownPlans(plansOfType(LIST, "w"), "w").map((e) => e.planId), ["1", "3", "4"]);
  });

  test("never include a Default stop, which is a slots board and not a rundown", () => {
    assert.equal(dropdownPlans(plansOfType(LIST, "w"), "w").some((e) => e.planId === null), false);
  });

  test("step to the neighbour, skip another type's plan, and stop at the ends", () => {
    const w = plansOfType(LIST, "w");
    assert.equal(stepPlan(w, "w", "3", 1), "4");
    assert.equal(stepPlan(w, "w", "3", -1), "1");
    assert.equal(stepPlan(w, "w", "1", -1), null);
    assert.equal(stepPlan(w, "w", "4", 1), null);
  });

  test("from a plan the list does not carry, forward enters at the first plan and back has nowhere to go", () => {
    const w = plansOfType(LIST, "w");
    assert.equal(stepPlan(w, "w", "999", 1), "1");
    assert.equal(stepPlan(w, "w", "999", -1), null);
    assert.equal(stepPlan(w, "w", null, 1), "1");
  });

  test("with no plans there is nowhere to go", () => {
    assert.equal(stepPlan([], "w", "1", 1), null);
    assert.deepEqual(plansOfType(LIST, null), []);
  });
});

describe("a pasted link", () => {
  test("names the plan in Planning Center's own spelling", () => {
    assert.deepEqual(parsePlanLink("https://services.planningcenteronline.com/plans/12345678"), { planId: "12345678", serviceTypeId: null });
    assert.deepEqual(parsePlanLink("  https://services.planningcenteronline.com/plans/12345678/live?x=1 "), { planId: "12345678", serviceTypeId: null });
  });

  test("and in the longer spelling that carries its service type", () => {
    assert.deepEqual(parsePlanLink("https://services.planningcenteronline.com/service_types/55/plans/12345678"), { planId: "12345678", serviceTypeId: "55" });
  });

  test("names nothing when the text is not a plan link", () => {
    for (const bad of ["", "hello", "https://example.com/plans/new", "plans/", "12345678", "https://services.planningcenteronline.com/service_types/55", "https://services.planningcenteronline.com/plans/123abc"]) {
      assert.equal(parsePlanLink(bad), null, `"${bad}" is not a plan link`);
    }
  });
});

describe("where a pasted plan lives", () => {
  test("a plan the list puts under this type is this type's", () => {
    assert.deepEqual(placePastedPlan({ planId: "3", serviceTypeId: null }, LIST, "w"), { where: "here", planId: "3" });
  });

  test("a plan the list puts under another type opens that type's page, by the list's name for it", () => {
    assert.deepEqual(placePastedPlan({ planId: "2", serviceTypeId: null }, LIST, "w"), {
      where: "elsewhere",
      planId: "2",
      serviceTypeId: "y",
      serviceTypeName: "Youth",
    });
  });

  test("the long spelling names its type when the list does not know the plan", () => {
    assert.deepEqual(placePastedPlan({ planId: "77", serviceTypeId: "z" }, LIST, "w"), {
      where: "elsewhere",
      planId: "77",
      serviceTypeId: "z",
      serviceTypeName: null,
    });
  });

  test("the list outranks the link's own type", () => {
    assert.deepEqual(placePastedPlan({ planId: "3", serviceTypeId: "y" }, LIST, "w"), { where: "here", planId: "3" });
  });

  test("a plan nothing places is taken as this type's, and the rundown read says whether it is", () => {
    assert.deepEqual(placePastedPlan({ planId: "77", serviceTypeId: null }, LIST, "w"), { where: "here", planId: "77" });
  });
});

describe("a plan that is not the app's counts down to its own start", () => {
  const NOW = Date.parse("2026-10-05T12:00:00Z");

  test("by the first service time", () => {
    const t = startsInTimer(["2026-10-06T12:00:00Z", "2026-10-07T12:00:00Z"], NOW);
    assert.equal(t?.mode, "preservice");
    assert.equal(t?.seconds, 86_400);
    assert.equal(t?.over, false);
  });

  test("and has nothing to count once it has started, or when it has no time", () => {
    assert.equal(startsInTimer(["2026-10-05T11:00:00Z"], NOW), null);
    assert.equal(startsInTimer([], NOW), null);
    assert.equal(startsInTimer(undefined, NOW), null);
    assert.equal(startsInTimer(["not a date"], NOW), null);
  });
});
