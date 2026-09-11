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

/**
 * Expand every ON/OFF pair row.
 *
 * A pair is ONE collapsed row in the list and its two halves' editors are
 * mounted only when it is expanded, so a test that opens a half has to open the
 * pair first. Idempotent: a row already open has no `aria-expanded="false"`
 * button left to press.
 */
async function expandPairs(): Promise<void> {
  for (const el of document.querySelectorAll('[data-cue-pair-row] button[aria-expanded="false"]')) {
    await act(async () => {
      (el as HTMLElement).click();
    });
  }
  await settle();
}

/** Open one rule's editor, expanding the pair row it sits inside first. */
async function open(name: string): Promise<void> {
  await expandPairs();
  // BY THE ROW'S OWN MARKER, not by its text: a pair row shows the words the
  // pair is called, and a fixture whose `says` is its cue name puts the same
  // string on the pair row and on the half's card — `getByText` then throws
  // "found multiple elements" rather than opening anything.
  const label = document.querySelector(`[data-rule-name="${name}"]`);
  assert.ok(label, `no row called ${name}`);
  await act(async () => {
    (label.closest("button") as HTMLElement).click();
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

  test("settling shows the commanded state, not the stale reading", async () => {
    // A press was dispatched in the last 8 s; `state` may still be the
    // pre-press value. The pill must show `commanded` and never `unknown`.
    STATES = {
      projectors: {
        on: "projectors_on",
        off: "projectors_off",
        variable: "projectors_state",
        value: "off",
        state: "off",
        settling: true,
        commanded: "on",
      },
    };
    await mount();
    assert.deepEqual(pills(), ["on"], "settling did not show the commanded state");
  });

  test("settling shows the commanded state even when the stale reading is unknown", async () => {
    STATES = {
      projectors: {
        on: "projectors_on",
        off: "projectors_off",
        variable: "projectors_state",
        value: "WARMUP",
        state: "unknown",
        settling: true,
        commanded: "off",
      },
    };
    await mount();
    assert.deepEqual(pills(), ["off"], "a settling row showed unknown instead of the commanded state");
  });

  test("a settling row marks itself and says why, on hover", async () => {
    STATES = {
      projectors: {
        on: "projectors_on",
        off: "projectors_off",
        variable: "projectors_state",
        value: "off",
        state: "off",
        settling: true,
        commanded: "on",
      },
    };
    await mount();
    const pill = document.querySelector("[data-cue-state]");
    assert.equal(pill === null, false, "no settling pill rendered");
    assert.equal(
      pill?.textContent?.includes("…"),
      true,
      "a settling pill did not carry the settling marker",
    );
    assert.equal(
      pill?.getAttribute("title"),
      "Pressed just now; the device has not reported back yet",
    );
  });

  test("a row with no settling field renders exactly as before", async () => {
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
    assert.deepEqual(pills(), ["on"]);
    const pill = document.querySelector("[data-cue-state]");
    assert.equal(pill?.textContent, "on");
    assert.equal(pill?.getAttribute("title"), "projectors_state");
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

  test("CLEARING the select blanks the on and off values too", async () => {
    // The select used to patch `stateVariable` alone, so clearing it left the
    // values behind: rebind the pair to another variable later and it inherits
    // "POWER=ON" from the old one, reporting on for a device that is off with
    // nothing on screen saying where that string came from. This is the PATCH.
    RULES = [
      cue("amps_on", {
        stateVariable: "amps_state",
        stateOnValue: "POWER=ON",
        stateOffValue: "STANDBY",
      }),
      cue("amps_off"),
    ];
    CUSTOM_VARIABLES = ["amps_state"];
    await mount();
    await open("amps_on");
    const { fireEvent } = await import("@testing-library/react");
    const select = document.querySelector('select[aria-label="State variable"]');
    assert.equal(select === null, false, "the state select is not rendered");
    await act(async () => {
      fireEvent.change(select!, { target: { value: "" } });
    });
    await act(async () => {
      screen.getByText("Save").click();
    });
    await settle();
    const patch = requests.find((r) => r.url.includes("/api/automation/rules/rule-amps_on"));
    assert.equal(typeof patch?.body, "string");
    const params = (JSON.parse(String(patch?.body)) as {
      trigger: { params: Record<string, string> };
    }).trigger.params;
    assert.deepEqual(
      {
        stateVariable: params.stateVariable,
        stateOnValue: params.stateOnValue,
        stateOffValue: params.stateOffValue,
      },
      { stateVariable: "", stateOnValue: "", stateOffValue: "" },
    );
  });

  test("choosing a variable keeps the values already typed", async () => {
    // The other half: writing all three keys must not overwrite what is there
    // with the resolved defaults, which would turn a field the operator left
    // alone into one they had filled in.
    RULES = [cue("amps_on", { stateOnValue: "POWER=ON", stateOffValue: "STANDBY" }), cue("amps_off")];
    CUSTOM_VARIABLES = ["amps_state"];
    await mount();
    await open("amps_on");
    const { fireEvent } = await import("@testing-library/react");
    const select = document.querySelector('select[aria-label="State variable"]');
    await act(async () => {
      fireEvent.change(select!, { target: { value: "amps_state" } });
    });
    await act(async () => {
      screen.getByText("Save").click();
    });
    await settle();
    const patch = requests.find((r) => r.url.includes("/api/automation/rules/rule-amps_on"));
    const params = (JSON.parse(String(patch?.body)) as {
      trigger: { params: Record<string, string> };
    }).trigger.params;
    assert.deepEqual(
      {
        stateVariable: params.stateVariable,
        stateOnValue: params.stateOnValue,
        stateOffValue: params.stateOffValue,
      },
      { stateVariable: "amps_state", stateOnValue: "POWER=ON", stateOffValue: "STANDBY" },
    );
  });

  test("a pair with candidates and no binding says it is learning", async () => {
    // A blank State variable with nothing inferred reads as "this pair cannot
    // report its state", which is the opposite of what is about to happen. The
    // hint is the only thing on screen that says a press will bind it.
    RULES = [
      cue("amps_on", {
        stateCandidates: "Rack:status,Rack:mute",
        stateLearning: '{"attempts":0,"observed":{}}',
      }),
      cue("amps_off"),
    ];
    await mount();
    await open("amps_on");
    assert.equal(
      document.body.textContent?.includes(
        "Learning: watching 2 candidates; press the pair on and off once to bind",
      ),
      true,
      "a learning pair said nothing about learning",
    );
  });

  test("a pair that gave up says so, and offers Learn again", async () => {
    RULES = [
      cue("amps_on", { stateCandidates: "", stateLearning: '{"attempts":3,"observed":{},"stopped":"gave-up"}' }),
      cue("amps_off"),
    ];
    await mount();
    await open("amps_on");
    assert.equal(
      document.body.textContent?.includes("Learning gave up after 3 presses"),
      true,
      "learning stopped with nothing on screen saying why",
    );
    assert.equal(document.body.textContent?.includes("Learn again"), true);
  });

  test("a pair with nothing to learn offers no Learn again", async () => {
    // The button is not offered on every pair in the building: nothing has been
    // probed, so there is nothing to forget.
    RULES = [cue("amps_on"), cue("amps_off")];
    await mount();
    await open("amps_on");
    assert.equal(document.body.textContent?.includes("Learn again"), false);
  });

  test("Learn again SAVES the reset, so the next pass probes again", async () => {
    // A control that renders is not a control that does anything. This is the
    // patch it sends: both keys blank, which is what makes the next hourly pass
    // probe a pair whose learning had stopped.
    RULES = [
      cue("amps_on", {
        stateCandidates: "Rack:status",
        stateLearning: '{"attempts":2,"observed":{"Rack:status":{"values":["Standby"]}},"stopped":"bound"}',
        stateVariable: "Rack:status",
        stateOnValue: "Active",
        stateOffValue: "Standby",
      }),
      cue("amps_off"),
    ];
    await mount();
    await open("amps_on");
    await act(async () => {
      screen.getByText("Learn again").click();
    });
    await act(async () => {
      screen.getByText("Save").click();
    });
    await settle();
    const patch = requests.find((r) => r.url.includes("/api/automation/rules/rule-amps_on"));
    const params = (
      JSON.parse(String(patch?.body)) as { trigger: { params: Record<string, string> } }
    ).trigger.params;
    assert.deepEqual(
      {
        candidates: params.stateCandidates,
        learning: params.stateLearning,
        variable: params.stateVariable,
      },
      // The BINDING is left alone: an operator asking to learn again has not
      // asked for the switch to stop reporting in the meantime.
      { candidates: "", learning: "", variable: "Rack:status" },
    );
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

// ── A toggle pair's warning on the State variable field ───────────────────────
//
// Two cues that press the SAME Companion button are a toggle: the state
// variable is the ONLY thing that can tell the two directions apart, so leaving
// it blank is not merely "optimistic", it is a switch that reports the opposite
// of the truth every other press. The field says so, and the hint lives behind
// the row's InfoHint, so this opens it the way an operator does.
describe("the State variable hint on a toggle pair", () => {
  /** Open the InfoHint beside a row label and return the popover's text. */
  async function hintFor(label: string): Promise<string> {
    const span = [...document.querySelectorAll("label > span")].find((el) =>
      (el.textContent ?? "").startsWith(label),
    );
    assert.equal(span === undefined, false, `no row labelled ${label}`);
    const button = span!.querySelector('button[aria-label="More info"]');
    assert.equal(button === null, false, `the ${label} row has no hint`);
    await act(async () => {
      (button as HTMLButtonElement).click();
    });
    await settle();
    return document.body.textContent ?? "";
  }

  test("both halves on one button and nothing bound says Home cannot know which way it went", async () => {
    // `cue()` presses p1 r0 c1 for every rule in this file, so these two halves
    // are one button — which is exactly the imported toggle.
    RULES = [cue("house_lights_on"), cue("house_lights_off")];
    CUSTOM_VARIABLES = ["house_lights_state"];
    await mount();
    await open("house_lights_on");
    const text = await hintFor("State variable");
    assert.equal(
      text.includes(
        "Both halves press the same button. Without a state variable, Home Assistant cannot know which way it went.",
      ),
      true,
    );
  });

  test("once a variable is bound the ordinary hint is back", async () => {
    RULES = [cue("house_lights_on", { stateVariable: "house_lights_state" }), cue("house_lights_off")];
    CUSTOM_VARIABLES = ["house_lights_state"];
    await mount();
    await open("house_lights_on");
    const text = await hintFor("State variable");
    assert.equal(text.includes("Home Assistant cannot know which way it went"), false);
    assert.equal(text.includes("A Companion custom variable your ON/OFF buttons set"), true);
  });

  test('the off value hint says what "*" means, and the on value hint does not', async () => {
    // `*` is legal on the OFF field only — the server refuses it as the on
    // value — so naming it on both would be an invitation to a 400. The hint
    // lives behind the row's InfoHint, opened here the way an operator does.
    //
    // The FIELD ITSELF is verified in a browser rather than here: the popover's
    // placement and whether it is legible over the field below it are not
    // things jsdom can see. See the pull request.
    RULES = [cue("deck_on", { stateVariable: "MA_HyperDeck_01:status", stateOnValue: "Record", stateOffValue: "*" }), cue("deck_off")];
    CUSTOM_VARIABLES = [];
    await mount();
    await open("deck_on");
    const off = await hintFor("Value meaning off");
    assert.equal(off.includes('"*" means anything else — any value that is not the on value'), true);
    const on = await hintFor("Value meaning on");
    assert.equal(on.includes("anything else"), false);
  });

  test("an ordinary pair on two buttons never says it", async () => {
    const off = cue("house_lights_off");
    off.action.params.col = 2;
    RULES = [cue("house_lights_on"), off];
    CUSTOM_VARIABLES = ["house_lights_state"];
    await mount();
    await open("house_lights_on");
    const text = await hintFor("State variable");
    assert.equal(text.includes("Home Assistant cannot know which way it went"), false);
  });
});
