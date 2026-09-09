// A bound pair's real state, on the rules-list row and in the rule editor.
//
// Both halves are one line of wiring in automation-section.tsx and both fail
// silently:
//
//  - the ROW. A pill that is not rendered looks exactly like a pair that has no
//    binding, and the only other place the state appears is inside Home
//    Assistant. It goes on the `_on` half and nowhere else: one pair is one
//    thing, and the `_off` row saying the same word again reads as two devices.
//  - the FIELDS. `State variable` is offered on the `_on` half of a pair and
//    nowhere else, because a binding on a cue with no partner reads a variable
//    that nothing ever shows. Offered everywhere it would be a setting that
//    saves and does nothing.
//
// And the gate: with no pair bound, NOTHING requests /api/cues/states. That is
// what keeps an install that does not use this from polling Companion every ten
// seconds forever, and it is not observable anywhere but here.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND. node:assert builds its
// failure message by inspecting `actual`, and inspecting a live jsdom element
// does not terminate in any useful time — a sibling file ran for 81.5 s on one
// such assertion and was killed with no line number.
//
// NOT unit-tested here, and driven in a browser instead: that `on` reads green,
// `off` grey and `unknown` amber, that the reason appears on hover, and that the
// pill sits inside the row's own button so pressing it opens the editor. jsdom
// loads no stylesheet and has no pointer, so none of those is observable in it.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

interface StubRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { id: string; params: Record<string, string | number> };
  conditions: never[];
  action: { id: string; params: Record<string, string | number> };
  cooldownSec: number;
  oncePerService: boolean;
}

const CALL_TRIGGER_ID = "call.by-name";

const REGISTRY = {
  triggers: [
    {
      id: CALL_TRIGGER_ID,
      label: "Called by name (voice or HTTP)",
      channel: "cue:call",
      params: [
        { key: "name", label: "Cue name", type: "string" },
        { key: "says", label: "Spoken as", type: "string", optional: true },
        { key: "stateVariable", label: "State variable", type: "string", optional: true },
        { key: "stateOnValue", label: "Value meaning on", type: "string", optional: true },
        { key: "stateOffValue", label: "Value meaning off", type: "string", optional: true },
      ],
    },
  ],
  conditions: [],
  actions: [
    { id: "companion.press", label: "Press a Companion button", params: [] },
    { id: "log.message", label: "Write a log message", params: [] },
  ],
};

const cue = (name: string, params: Record<string, string | number> = {}): StubRule => ({
  id: `rule-${name}`,
  name,
  enabled: true,
  trigger: { id: CALL_TRIGGER_ID, params: { name, says: name, ...params } },
  conditions: [],
  action: { id: "companion.press", params: { page: 1, row: 0, col: 1 } },
  cooldownSec: 0,
  oncePerService: false,
});

let RULES: StubRule[] = [];
let STATES: Record<string, unknown> = {};
let CUSTOM_VARIABLES: string[] = [];
/** When set, /api/cues/states answers this status with this `error` body. */
let STATES_FAILS: { status: number; error: string } | null = null;
/** Every URL the stub was asked for, so the gate can be asserted. */
let urls: string[] = [];
let requests: { url: string; body: string | null }[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  urls.push(url);
  if (init?.method && init.method !== "GET") {
    requests.push({ url, body: typeof init.body === "string" ? init.body : null });
  }
  let body: unknown = {};
  if (url.includes("/api/automation/registry")) body = REGISTRY;
  else if (url.includes("/api/automation/rules")) {
    body = { rules: RULES, settings: { simulate: false, disarmed: false } };
  } else if (url.includes("/api/automation/log")) body = { entries: [] };
  else if (url.includes("/api/automation/plan-items")) body = { items: [] };
  else if (url.includes("/api/rosstalk/targets")) body = { targets: [] };
  else if (url.includes("/api/rosstalk/commands")) body = [];
  else if (url.includes("/api/cues/tokens")) body = { tokens: [] };
  else if (url.includes("/api/cues/states")) {
    if (STATES_FAILS) {
      const failure = STATES_FAILS;
      return {
        ok: false,
        status: failure.status,
        statusText: "Internal Server Error",
        json: async () => ({ error: failure.error }),
        text: async () => JSON.stringify({ error: failure.error }),
      };
    }
    body = { ok: true, checkedAt: "x", states: STATES };
  }
  else if (url.includes("/api/companion/pairs")) {
    body = { ok: true, pairs: [], buttons: [], customVariables: CUSTOM_VARIABLES };
  } else if (url.includes("/api/companion/buttons")) body = { ok: true, buttons: [] };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { AutomationSection } = await import("./automation-section.js");

const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

let client: InstanceType<typeof QueryClient> | null = null;

async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(AutomationSection, {})),
    ),
  );
  await settle();
  return view;
}

/** Every state pill's word, in row order. */
const pills = (): string[] =>
  [...document.querySelectorAll("[data-cue-state]")].map(
    (el) => el.getAttribute("data-cue-state") ?? "",
  );

/**
 * Every state pill on the list, by the pair it belongs to.
 *
 * By `data-cue-pair` rather than `data-cue-state`, because the failure this
 * catches renders a pill with NO state: a row that read its state off the
 * prototype chain got `Object.prototype.constructor`, which is truthy, and
 * React drops an attribute whose value is undefined — so counting states could
 * not see it at all.
 */
const pairPills = (): string[] =>
  [...document.querySelectorAll("[data-cue-pair]")].map(
    (el) => el.getAttribute("data-cue-pair") ?? "",
  );

/** The pills' titles, which is where the reason lives. */
const titles = (): string[] =>
  [...document.querySelectorAll("[data-cue-state]")].map((el) => el.getAttribute("title") ?? "");

/** Open one rule's editor by pressing its row. */
async function open(name: string): Promise<void> {
  await act(async () => {
    screen.getByText(name).click();
  });
  await settle();
}

/** The accessible names of every field the open editor renders. */
const fieldNames = (): string[] =>
  [...document.querySelectorAll("input[aria-label], select[aria-label]")].map(
    (el) => el.getAttribute("aria-label") ?? "",
  );

beforeEach(() => {
  RULES = [];
  STATES = {};
  CUSTOM_VARIABLES = [];
  STATES_FAILS = null;
  urls = [];
  requests = [];
});
afterEach(async () => {
  cleanup();
  client?.clear();
  await settle();
});
after(async () => {
  cleanup();
  await settle();
  teardown();
});

describe("the state pill on the rules list", () => {
  beforeEach(() => {
    RULES = [cue("projectors_on", { stateVariable: "projectors_state" }), cue("projectors_off")];
  });

  test("on, off and unknown each show as themselves, on the _on row only", async () => {
    for (const state of ["on", "off", "unknown"] as const) {
      STATES = {
        projectors: {
          on: "projectors_on",
          off: "projectors_off",
          variable: "projectors_state",
          value: state === "unknown" ? "WARMUP" : state,
          state,
          ...(state === "unknown" ? { reason: 'value "WARMUP" matches neither "on" nor "off"' } : {}),
        },
      };
      await mount();
      assert.deepEqual(pills(), [state], `the ${state} pill is on the wrong number of rows`);
      cleanup();
      client?.clear();
      await settle();
    }
  });

  test("the reason is on the pill for hover, and the variable when there is none", async () => {
    STATES = {
      projectors: {
        on: "projectors_on",
        off: "projectors_off",
        variable: "projectors_state",
        value: null,
        state: "unknown",
        reason: "no such custom variable in Companion",
      },
    };
    await mount();
    assert.deepEqual(titles(), ["projectors_state: no such custom variable in Companion"]);
  });

  test("a pair the route said nothing about shows no pill", async () => {
    // Companion unreachable, or the route not yet answered. A pill that guessed
    // would be the optimism this feature exists to remove.
    STATES = {};
    await mount();
    assert.deepEqual(pills(), []);
  });
});

describe("a pair whose base is a prototype key", () => {
  test("an UNBOUND constructor pair shows no pill while another pair does", async () => {
    // The base is half of a cue name, so `states["constructor"]` reached
    // Object.prototype and came back with a function. Truthy, so the row grew a
    // pill: an amber dot with no word, for a pair the route said nothing about.
    // Another pair IS bound, so the query runs and the answer is real.
    RULES = [
      cue("constructor_on"),
      cue("constructor_off"),
      cue("projectors_on", { stateVariable: "projectors_state" }),
      cue("projectors_off"),
    ];
    STATES = {
      projectors: {
        on: "projectors_on",
        off: "projectors_off",
        variable: "projectors_state",
        value: "on",
        state: "on",
      },
    };
    await mount();
    assert.deepEqual(pairPills(), ["projectors"]);
    assert.deepEqual(pills(), ["on"]);
  });

  test("a BOUND __proto__ pair the route answered for does show its pill", async () => {
    // The other half of the same bug: the key has to be usable, not refused.
    RULES = [
      cue("__proto___on", { stateVariable: "proto_state" }),
      cue("__proto___off"),
    ];
    // Object.fromEntries, NOT `{ __proto__: … }`: an object literal with that
    // key sets the prototype instead of adding a property, which is the very
    // bug one level down. This is the shape JSON.parse gives the real page.
    STATES = Object.fromEntries([
      [
        "__proto__",
        {
          on: "__proto___on",
          off: "__proto___off",
          variable: "proto_state",
          value: "off",
          state: "off",
        },
      ],
    ]);
    await mount();
    assert.deepEqual(pairPills(), ["__proto__"]);
    assert.deepEqual(pills(), ["off"]);
  });
});

describe("the poll is gated on there being a binding", () => {
  test("an UNBOUND pair never requests the states route", async () => {
    RULES = [cue("projectors_on"), cue("projectors_off")];
    await mount();
    assert.equal(
      urls.some((u) => u.includes("/api/cues/states")),
      false,
      "an install with no state bindings polled Companion anyway",
    );
    assert.deepEqual(pills(), []);
  });

  test("a bound pair does request it", async () => {
    RULES = [cue("projectors_on", { stateVariable: "projectors_state" }), cue("projectors_off")];
    await mount();
    assert.equal(urls.filter((u) => u.includes("/api/cues/states")).length, 1);
  });
});

describe("when the states route itself fails", () => {
  test("one muted line says so, and no pill guesses", async () => {
    // Not a pair reading unknown — that has its own amber pill and its own
    // reason. The route failing showed NOTHING: the pills stopped appearing,
    // which looks exactly like a set of pairs with no bindings at all.
    RULES = [cue("projectors_on", { stateVariable: "projectors_state" }), cue("projectors_off")];
    STATES_FAILS = { status: 500, error: "Companion is unreachable" };
    await mount();
    const line = document.querySelector("[data-cue-state-error]");
    assert.equal(line === null, false, "a failed cue-state read said nothing at all");
    assert.equal(line?.textContent, "Cue state unavailable: Companion is unreachable");
    assert.deepEqual(pairPills(), [], "a pill appeared for a state nobody read");
  });

  test("no bindings means no line, whatever the route would have said", async () => {
    // The query is not even enabled, so there is nothing to report and a line
    // would be a failure invented for an install that does not use this.
    RULES = [cue("projectors_on"), cue("projectors_off")];
    STATES_FAILS = { status: 500, error: "Companion is unreachable" };
    await mount();
    assert.equal(document.querySelector("[data-cue-state-error]"), null);
  });
});

describe("the state fields in the rule editor", () => {
  test("appear on the _on half of a pair", async () => {
    RULES = [cue("projectors_on", { stateVariable: "projectors_state" }), cue("projectors_off")];
    CUSTOM_VARIABLES = ["projectors_state", "lobby_tvs"];
    await mount();
    await open("projectors_on");
    const names = fieldNames();
    assert.equal(names.includes("State variable"), true);
    // The two value fields only once something is bound — they are meaningless
    // on their own.
    assert.equal(names.includes("Value meaning on"), true);
    assert.equal(names.includes("Value meaning off"), true);
  });

  test("do NOT appear on the _off half", async () => {
    RULES = [cue("projectors_on", { stateVariable: "projectors_state" }), cue("projectors_off")];
    CUSTOM_VARIABLES = ["projectors_state"];
    await mount();
    await open("projectors_off");
    assert.equal(
      fieldNames().includes("State variable"),
      false,
      "the _off half inherits the binding; a second field for it is two settings for one pair",
    );
  });

  test("do NOT appear on a cue with no partner", async () => {
    RULES = [cue("house_lights_on")];
    CUSTOM_VARIABLES = ["house_lights_state"];
    await mount();
    await open("house_lights_on");
    assert.equal(fieldNames().includes("State variable"), false);
  });

  test("the value fields are hidden until a variable is chosen", async () => {
    RULES = [cue("amps_on"), cue("amps_off")];
    CUSTOM_VARIABLES = ["amps_state"];
    await mount();
    await open("amps_on");
    const names = fieldNames();
    assert.equal(names.includes("State variable"), true);
    assert.equal(names.includes("Value meaning on"), false);
  });

  test("choosing a variable saves it on the _on rule", async () => {
    // A control that renders is not a control that does anything — the named
    // scar in this repo. This is the PATCH the editor sends.
    RULES = [cue("amps_on"), cue("amps_off")];
    CUSTOM_VARIABLES = ["amps_state"];
    await mount();
    await open("amps_on");
    const { fireEvent } = await import("@testing-library/react");
    // Queried by attribute, not by label text: the row's label also holds an
    // InfoHint button, so getByLabelText("State variable") matches two nodes.
    const select = document.querySelector('select[aria-label="State variable"]');
    assert.equal(select === null, false, "the state select is not rendered");
    await act(async () => {
      fireEvent.change(select!, { target: { value: "amps_state" } });
    });
    await act(async () => {
      screen.getByText("Save").click();
    });
    await settle();
    const patch = requests.find((r) => r.url.includes("/api/automation/rules/rule-amps_on"));
    assert.equal(typeof patch?.body, "string");
    assert.equal(
      JSON.parse(String(patch?.body)).trigger.params.stateVariable,
      "amps_state",
    );
  });
});
