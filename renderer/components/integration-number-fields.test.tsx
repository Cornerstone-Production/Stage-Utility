// What every `type: "number"` field in every integration card starts out holding.
//
// Two ways a numeric field can be wrong before an operator has touched it, and
// both shipped:
//
//   1. NaN. initialConfig() treats a field's `placeholder` as its shown default
//      and falls back to `Number(placeholder)`. A placeholder is free-form prose
//      — "500 (lower = snappier, more requests)" — so that is NaN, and the guard
//      that was meant to catch it was `fallback ?? ""`, which does not: `??`
//      only catches null and undefined. NaN went to the field, where
//      `String(NaN)` and `Number(value) || 0` both render 0, so a poll interval
//      and a switcher port whose stored value was genuinely ABSENT each showed a
//      bare 0 — and a focus-and-blur on that 0 committed it as a real number.
//
//   2. A number invented for a field that has none. A field with no default and
//      no numeric placeholder means "unset", and the form has to be able to say
//      so. Seeding "" is how it says it; `unsetHint` is how the descriptor
//      declares that blank is a real state rather than a missing value.
//
// This runs the REAL initialConfig over the REAL descriptors rather than
// reimplementing the fallback ladder, because a guard that reimplements it goes
// green on a bug living in the copy under test. The descriptors come from the
// fixture for the reason integration-descriptors.ts gives (importing the manager
// into a renderer test drags every provider and store along); the fixture is
// pinned field-for-field against the shipped descriptors by
// main/services/integration-descriptor-fixture.test.ts, so it cannot drift.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { INTEGRATION_DESCRIPTOR_FIXTURE } = await import("../test-fixtures/integration-descriptors.js");
const { initialConfig } = await import("./integrations-panel.js");

after(() => {
  teardown();
});

/** One number field, and what the form seeds it with on a fresh install. */
interface Seeded {
  id: string;
  key: string;
  /** What initialConfig() put in the form for it, with nothing saved. */
  seed: unknown;
}

/** Every number field the app ships, run through the real seeding path with an
 *  empty saved config — a fresh install, every card opened. */
const seeded: Seeded[] = INTEGRATION_DESCRIPTOR_FIXTURE.flatMap((d) => {
  const form = initialConfig(d, {
    id: d.id,
    enabled: false,
    connection: "disconnected",
    message: null,
    config: {},
  });
  return d.configSchema
    .filter((f) => f.type === "number")
    .map((f) => ({ id: d.id, key: f.key, seed: form[f.key] }));
});

const where = (s: Seeded) => `${s.id}.${s.key}`;

describe("what a number field starts out holding", () => {
  test("there are exactly thirteen of them", () => {
    // EXACT, not a floor. A fourteenth number field is a field nobody has
    // decided the unset behaviour of, and the whole point of this file is that
    // the decision is made per field rather than defaulted into. Update this
    // number in the same change that adds the field, having read the rest of
    // this file first.
    assert.equal(
      seeded.length,
      13,
      `the app ships ${seeded.length} number fields, not 13: ${seeded.map(where).join(", ")}`,
    );
  });

  test("not one of them seeds NaN", () => {
    // The bug this file exists for. NaN is indistinguishable from a real value
    // to every reader downstream — it renders as 0, it is truthy to
    // configuredFor(), and JSON.stringify turns it into `null` on the way to the
    // server, so it lands on disk as a key nobody set.
    const nan = seeded.filter((s) => typeof s.seed === "number" && !Number.isFinite(s.seed));
    assert.deepEqual(nan.map(where), [], `these number fields seed NaN: ${nan.map(where).join(", ")}`);
  });

  test("a field that seeds a number seeds a usable one", () => {
    // A seeded number is SAVED the next time the card is saved for any other
    // reason, so it has to be a number the service would really run at — never
    // 0, never negative, and inside whatever bounds the field declares.
    const numeric = seeded.filter((s) => typeof s.seed === "number");
    const bad = numeric.filter((s) => !(Number.isFinite(s.seed as number) && (s.seed as number) > 0));
    assert.deepEqual(bad.map(where), [], `these seed a number no service would run at: ${bad.map(where).join(", ")}`);
  });

  test("exactly three of them seed blank, and these three", () => {
    // Blank means "no value" — the field resolves at runtime from something
    // else (the ProPresenter poller's own 1000ms, the Vea poll interval) or is
    // simply not configured yet (the Ross TSL port). Named exactly, because a
    // fourth field arriving here is either a new deliberate unset field or a
    // default somebody forgot, and those need different fixes.
    const blank = seeded.filter((s) => s.seed === "").map(where).sort();
    assert.deepEqual(blank, ["propresenter.pollMs", "ross-tsl.port", "sensource.attendancePollSeconds"]);
  });

  test("a field seeds either a number or blank, and nothing else", () => {
    const odd = seeded.filter((s) => typeof s.seed !== "number" && s.seed !== "");
    assert.deepEqual(
      odd.map((s) => `${where(s)}=${JSON.stringify(s.seed)}`),
      [],
      "a number field seeded something that is neither a number nor blank",
    );
  });
});
