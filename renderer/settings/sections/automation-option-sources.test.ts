// Every runtime option source a shipped param names is answered, and nothing else is.
//
// A param declaring `optionsFrom: "<source>"` with nothing answering that name
// renders a select holding "Pick one…" and no options at all: the trigger,
// condition or action carrying it cannot be configured, on any install, ever.
// Two of the eight sources were in that state — `osc-targets` from the day
// `osc.send` was written, and `service-types` on the "Service type is"
// condition — and the whole suite was green over both.
//
// THIS IS THE SECOND OF TWO GUARDS, and the weaker one. The first is the type
// checker: `OptionSources` in automation-option-sources.ts is
// `Record<NonNullable<ParamDef["optionsFrom"]>, …>`, so a ninth source added to
// main/types/automation.ts is a compile error until `buildOptionSources`
// answers it. `npm test` runs under tsx, which strips types without checking
// them, so that half only fires under `npx tsc --noEmit`.
//
// What this adds, and what no type can say: whether the union has a member no
// param actually uses. That is a source the renderer fetches and nothing reads —
// a query on every visit to the Automation page for a dropdown that does not
// exist. EXACT SET EQUALITY both ways, and an exact count, because a subset
// assertion is precisely what let `osc-targets` survive on every install since
// it shipped.
//
// Reads the REAL registries, not a fixture: a fixture is a fourth copy of the
// list and would go green on the drift it exists to catch.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AUTOMATION_ACTIONS } from "@main/services/automation-actions";
import { AUTOMATION_CONDITIONS } from "@main/services/automation-conditions";
import { AUTOMATION_TRIGGERS } from "@main/services/automation-triggers";
import type { ParamDef } from "@main/types/automation";

import { OPTION_SOURCE_KEYS, buildOptionSources } from "./automation-option-sources.js";

/** Every `optionsFrom` any shipped trigger, condition or action param declares. */
function sourcesTheRegistriesAskFor(): string[] {
  const defs: { params: ParamDef[] }[] = [
    ...Object.values(AUTOMATION_TRIGGERS),
    ...Object.values(AUTOMATION_CONDITIONS),
    ...Object.values(AUTOMATION_ACTIONS),
  ];
  const used = new Set<string>();
  for (const def of defs) {
    for (const param of def.params) if (param.optionsFrom) used.add(param.optionsFrom);
  }
  return [...used].sort();
}

/**
 * The eight sources, sorted, one per line. A bare count cannot tell an add plus
 * a remove from no change; a sorted list also merges cleanly when two branches
 * each wire up a different source.
 */
const EXPECTED_SOURCES = [
  "displays",
  "osc-targets",
  "plan-items",
  "propresenter-instances",
  "propresenter-macros",
  "rosstalk-commands",
  "rosstalk-targets",
  "service-types",
];

describe("runtime option sources", () => {
  test("the renderer answers exactly the sources the registries ask for", () => {
    assert.deepEqual([...OPTION_SOURCE_KEYS].sort(), sourcesTheRegistriesAskFor());
  });

  test("eight sources, exactly", () => {
    // An exact set, not a bare count. Change this list only alongside a source
    // that a registry param really names.
    assert.deepEqual(
      [...OPTION_SOURCE_KEYS].sort(),
      EXPECTED_SOURCES,
      "a source was added or removed; update EXPECTED_SOURCES deliberately",
    );
    assert.deepEqual(sourcesTheRegistriesAskFor(), EXPECTED_SOURCES);
  });

  test("every source answers with an array, including from nothing at all", () => {
    // `buildOptionSources({})` is what a page renders with before any query has
    // come back, and what OPTION_SOURCE_KEYS is read off. A source that threw
    // or answered undefined here would take the whole Automation section down
    // on mount rather than render one empty dropdown.
    const sources = buildOptionSources({});
    for (const key of OPTION_SOURCE_KEYS) {
      assert.equal(Array.isArray(sources[key].options), true, `${key} answered with no array`);
      assert.deepEqual(sources[key].options, []);
    }
  });

  test("a source that answers with an object yields an empty list, not a throw", () => {
    // Every source goes through the same `list()` guard. An error body, a route
    // that changed shape or a mocked fetch with no case for this URL is an
    // OBJECT, and `?? []` does not catch one — it reached `.map` and threw
    // inside a useMemo, which unmounts the section and leaves the operator a
    // blank page where their rules were.
    const junk = { error: "not configured" } as never;
    const sources = buildOptionSources({
      rosstalkTargets: { targets: junk },
      rosstalkCommands: junk,
      oscTargets: junk,
      planItems: { items: junk },
      propresenterInstances: { items: junk },
      propresenterMacros: { items: junk },
      serviceTypes: junk,
      outputs: junk,
    });
    for (const key of OPTION_SOURCE_KEYS) assert.deepEqual(sources[key].options, []);
  });

  test("service types and displays carry the id the engine compares against", () => {
    // Both were unanswered, and both store an ID while showing a NAME:
    // `service.type-is` compares ctx.serviceTypeId, and display.connected
    // matches display-presence.ts's set, which is keyed by output id. A source
    // built the other way round would offer a list that looks right and matches
    // nothing.
    const sources = buildOptionSources({
      serviceTypes: [{ id: "st-1", name: "Sunday Morning" }],
      outputs: [{ id: "out-1", name: "Lobby Wall" }],
    });
    assert.deepEqual(sources["service-types"].options, [{ value: "st-1", label: "Sunday Morning" }]);
    assert.deepEqual(sources["displays"].options, [{ value: "out-1", label: "Lobby Wall" }]);
  });
});
