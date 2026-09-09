// Where the plan switcher's arrows go, in both modes.
//
// This is the whole of the switcher's behaviour that can point somebody at the
// wrong board: the sequence per mode, whether Default is on it, and what happens
// at the ends. All of it is plain functions over plain data, so all of it is
// driven here rather than through a rendered control.
//
// The ends matter as much as the middle. A wrapping arrow — one that walks off
// the end of the week and reappears at the start — is how an operator editing
// next Sunday lands on last Wednesday without noticing they moved.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  decodeTarget,
  encodeTarget,
  sameTarget,
  stepTarget,
  switcherOptions,
  switcherSequence,
  UPCOMING_DROPDOWN_LIMIT,
  type EditingTarget,
} from "./plan-switcher-step.js";

const SUN = "st-sun";
const YOUTH = "st-youth";

function plan(planId: string, serviceTypeId: string, iso: string): UpcomingPlan {
  return {
    serviceTypeId,
    serviceTypeName: serviceTypeId === SUN ? "Sunday" : "Youth",
    planId,
    title: "Service",
    sortDate: iso,
    dates: null,
    isCurrent: false,
  };
}

/** Server order: already sorted by date across types, which is what the arrows
 *  walk. Wed youth, Sun morning, Wed youth, Sun morning. */
const PLANS: UpcomingPlan[] = [
  plan("y1", YOUTH, "2026-09-09T23:00:00Z"),
  plan("s1", SUN, "2026-09-13T14:00:00Z"),
  plan("y2", YOUTH, "2026-09-16T23:00:00Z"),
  plan("s2", SUN, "2026-09-20T14:00:00Z"),
];

const at = (serviceTypeId: string | null, planId: string | null): EditingTarget => ({ serviceTypeId, planId });

describe("the sequence, within a type", () => {
  test("is that type's Default and then its plans by date", () => {
    assert.deepEqual(
      switcherSequence(PLANS, "within-type", SUN).map((e) => e.planId),
      [null, "s1", "s2"],
      "Default is a stop on the sequence, not a separate control — stepping back from the earliest plan is how you reach the standing board",
    );
  });

  test("carries no other type's plans", () => {
    assert.deepEqual(
      switcherSequence(PLANS, "within-type", YOUTH).map((e) => e.planId),
      [null, "y1", "y2"],
    );
  });

  test("is empty with no service type at all", () => {
    assert.deepEqual(switcherSequence(PLANS, "within-type", null), []);
  });
});

describe("the sequence, upcoming", () => {
  test("is every type's plans in the server's date order", () => {
    assert.deepEqual(
      switcherSequence(PLANS, "upcoming", SUN).map((e) => e.planId),
      ["y1", "s1", "y2", "s2"],
    );
  });

  test("has no Default on it — those live in the dropdown", () => {
    assert.equal(
      switcherSequence(PLANS, "upcoming", SUN).some((e) => e.planId === null),
      false,
      "a Default between two dates breaks the 'these arrows walk the week' reading the mode exists for",
    );
  });
});

describe("stepping, within a type", () => {
  test("forward from Default reaches the first plan", () => {
    assert.deepEqual(stepTarget(PLANS, "within-type", at(SUN, null), 1), at(SUN, "s1"));
  });

  test("back from the first plan reaches Default", () => {
    assert.deepEqual(
      stepTarget(PLANS, "within-type", at(SUN, "s1"), -1),
      at(SUN, null),
      "skipping Default here leaves the standing board unreachable from the arrows",
    );
  });

  test("does not wrap off the front", () => {
    assert.equal(stepTarget(PLANS, "within-type", at(SUN, null), -1), null);
  });

  test("does not wrap off the back", () => {
    assert.equal(
      stepTarget(PLANS, "within-type", at(SUN, "s2"), 1),
      null,
      "wrapping is how somebody editing next Sunday lands on last Wednesday without noticing",
    );
  });

  test("never leaves the chosen type", () => {
    assert.deepEqual(stepTarget(PLANS, "within-type", at(SUN, "s1"), 1), at(SUN, "s2"));
  });
});

describe("stepping, upcoming", () => {
  test("crosses service types in date order", () => {
    assert.deepEqual(stepTarget(PLANS, "upcoming", at(YOUTH, "y1"), 1), at(SUN, "s1"));
    assert.deepEqual(stepTarget(PLANS, "upcoming", at(SUN, "s1"), 1), at(YOUTH, "y2"));
  });

  test("does not wrap at either end", () => {
    assert.equal(stepTarget(PLANS, "upcoming", at(YOUTH, "y1"), -1), null);
    assert.equal(stepTarget(PLANS, "upcoming", at(SUN, "s2"), 1), null);
  });

  test("a Default target enters the list at its OWN type's first plan", () => {
    assert.deepEqual(
      stepTarget(PLANS, "upcoming", at(SUN, null), 1),
      at(SUN, "s1"),
      "entering at the top of the week would move an operator to a service type they were not editing",
    );
  });

  test("and stepping back from a Default lands before that type's first plan", () => {
    assert.deepEqual(stepTarget(PLANS, "upcoming", at(SUN, null), -1), at(YOUTH, "y1"));
    assert.equal(stepTarget(PLANS, "upcoming", at(YOUTH, null), -1), null);
  });
});

describe("stepping with nothing to step through", () => {
  test("an empty list has nowhere to go in either direction", () => {
    assert.equal(stepTarget([], "upcoming", at(SUN, "s1"), 1), null);
    assert.equal(stepTarget([], "upcoming", at(SUN, "s1"), -1), null);
    assert.equal(
      stepTarget([], "within-type", at(SUN, null), 1),
      null,
      "with Planning Center unreachable the arrows must be dead, not silently moving",
    );
  });
});

describe("the dropdown's options", () => {
  test("within a type they are exactly the sequence", () => {
    const o = switcherOptions(PLANS, "within-type", at(SUN, "s1"));
    assert.deepEqual(o.plans.map((e) => e.planId), [null, "s1", "s2"]);
    assert.deepEqual(o.defaults, []);
  });

  test("upcoming, they start at the current target and list every type's default", () => {
    const o = switcherOptions(PLANS, "upcoming", at(SUN, "s1"));
    assert.deepEqual(o.plans.map((e) => e.planId), ["s1", "y2", "s2"]);
    assert.deepEqual(o.defaults.map((e) => e.serviceTypeId), [YOUTH, SUN]);
  });

  test("upcoming, they are capped", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      plan(`p${i}`, SUN, new Date(Date.UTC(2026, 8, 1) + i * 86400000).toISOString()),
    );
    const o = switcherOptions(many, "upcoming", at(SUN, "p0"));
    assert.equal(o.plans.length, UPCOMING_DROPDOWN_LIMIT);
  });

  test("a default whose type has no plans is still selectable in its own dropdown", () => {
    const o = switcherOptions(PLANS, "upcoming", at("st-lonely", null));
    assert.equal(
      o.defaults.some((e) => e.serviceTypeId === "st-lonely"),
      true,
      "a native select whose value is not among its options renders blank, which reads as no plan at all",
    );
  });
});

describe("a target as a select value", () => {
  test("round-trips a plan and a default", () => {
    assert.deepEqual(decodeTarget(encodeTarget(at(SUN, "s1"))), at(SUN, "s1"));
    assert.deepEqual(decodeTarget(encodeTarget(at(SUN, null))), at(SUN, null));
  });

  test("an id containing the separator does not decode into a different target", () => {
    const odd = at("st|weird", "plan|1");
    assert.deepEqual(decodeTarget(encodeTarget(odd)), odd);
  });

  test("sameTarget distinguishes a type's default from its plan", () => {
    assert.equal(sameTarget(at(SUN, null), at(SUN, "s1")), false);
    assert.equal(sameTarget(at(SUN, "s1"), at(YOUTH, "s1")), false);
    assert.equal(sameTarget(at(SUN, "s1"), at(SUN, "s1")), true);
  });
});
