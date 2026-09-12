// The two sections of the rules list, and the pair row that carries a cue's
// Home Assistant switch.
//
// What is guarded, and why each is a bug rather than a nicety:
//
//  - A HIDDEN CUE IS UNDER "EVERYTHING ELSE", and flipping its switch moves it.
//    The sections are the only place the app says which cues Home Assistant has
//    been told about; a cue in the wrong one is the operator being told the
//    opposite of the truth.
//  - A PAIR IS ONE ROW, and opens ONE editor holding both halves. Two rows —
//    or two stacked editors — for one switch is the list disagreeing with Home
//    Assistant about what a pair is, which is exactly the confusion
//    cue-pairs.ts exists to end.
//  - EITHER HALF'S NAME FINDS THE PAIR. A search for the off cue that hid the
//    row it lives on would be a pair unreachable by half its own names.
//  - A SECTION WITH NO ROWS IS NOT RENDERED, so a query that matches only cues
//    does not leave an empty "Everything else" heading behind.
//  - THE PAIR'S SWITCH WRITES THE ON HALF. The flag lives on the ON half (see
//    cue-pairs.ts); written to the off rule it would be read only as a
//    fallback, and a pair whose ON half says nothing would hide — until the
//    operator touched the ON half, which would silently un-hide it.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND — see
// automation-rule-row.test.tsx for why.
//
// NOT unit-tested, and driven in a browser instead: that the search bar sticks
// to the top of the pane and rows scroll under it, that the hairline under it
// separates it from the first row, and that the editor dialog's footer stays on
// screen while its body scrolls. jsdom loads no stylesheet and reports every
// offsetHeight as 0, so `position: sticky`, a background and a max height are
// not observable in it at all — asserting the class string would only say the
// class is spelled how it is spelled.

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
      ],
    },
    { id: "pco.plan-item", label: "A plan item starts", channel: "pco:plan", params: [] },
  ],
  conditions: [],
  actions: [
    { id: "companion.press", label: "Press a Companion button", params: [] },
    { id: "log.message", label: "Write a log message", params: [] },
  ],
};

const cue = (name: string, params: Record<string, string | number> = {}): StubRule => ({
  id: `rule-${name}`,
  name: `Rule ${name}`,
  enabled: true,
  trigger: { id: CALL_TRIGGER_ID, params: { name, ...params } },
  conditions: [],
  action: { id: "companion.press", params: { page: 1, row: 0, col: 1 } },
  cooldownSec: 0,
  oncePerService: false,
});

/** A rule that is not a cue at all — the other half of "Everything else". */
const planRule = (name: string): StubRule => ({
  id: `rule-${name}`,
  name,
  enabled: true,
  trigger: { id: "pco.plan-item", params: {} },
  conditions: [],
  action: { id: "log.message", params: {} },
  cooldownSec: 0,
  oncePerService: false,
});

let RULES: StubRule[] = [];
let requests: { url: string; body: string | null }[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (init?.method && init.method !== "GET") {
    requests.push({ url, body: typeof init.body === "string" ? init.body : null });
    // A write answers with the rules AS THEY NOW ARE, and the stub applies the
    // patch — the section refetches after a save, and a stub that answered with
    // the old rules would make every "it moved" assertion pass or fail on the
    // refetch rather than on the write.
    const id = url.split("/").pop() ?? "";
    const patch = JSON.parse(init.body as string) as { trigger?: StubRule["trigger"] };
    RULES = RULES.map((r) => (r.id === id ? { ...r, ...patch } : r));
  }
  let body: unknown = {};
  if (url.includes("/api/automation/registry")) body = REGISTRY;
  else if (url.includes("/api/automation/rules")) {
    body = { rules: RULES, settings: { simulate: true, disarmed: false } };
  } else if (url.includes("/api/automation/log")) body = { entries: [] };
  else if (url.includes("/api/automation/plan-items")) body = { items: [] };
  else if (url.includes("/api/rosstalk/targets")) body = { targets: [] };
  else if (url.includes("/api/rosstalk/commands")) body = [];
  else if (url.includes("/api/cues/tokens")) body = { tokens: [] };
  else if (url.includes("/api/cues/states")) body = { ok: true, checkedAt: "x", states: {} };
  else if (url.includes("/api/companion/pairs")) {
    body = { ok: true, pairs: [], buttons: [], customVariables: [] };
  } else if (url.includes("/api/companion/buttons")) body = { ok: true, buttons: [] };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
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

/** The section titles on screen, in order. */
const sectionTitles = (): string[] =>
  [...document.querySelectorAll("[data-rule-section]")].map(
    (el) => el.getAttribute("data-rule-section") ?? "",
  );

/** The rows under one section: pair rows by base, rule cards by rule name. */
function rowsUnder(title: string): string[] {
  const section = document.querySelector(`[data-rule-section="${title}"]`);
  if (!section) return [];
  const out: string[] = [];
  for (const el of section.querySelectorAll("[data-cue-pair-row], [data-rule-name]")) {
    // A rule card INSIDE an expanded pair row is not a row of the section.
    if (el.hasAttribute("data-rule-name") && el.closest("[data-cue-pair-row]")) continue;
    out.push(el.getAttribute("data-cue-pair-row") ?? el.getAttribute("data-rule-name") ?? "");
  }
  return out;
}

/** How many rule editors are mounted. The dialog is the only thing that mounts one. */
const openEditors = (): number => document.querySelectorAll("[data-rule-editor]").length;

/** The Home Assistant switches on screen — one per open editor, never per half. */
const homeSwitches = (): number =>
  document.querySelectorAll('[aria-label="Shown in Home Assistant"]').length;

const searchField = (): HTMLInputElement =>
  document.querySelector('[aria-label="Search rules"]') as HTMLInputElement;

async function type(text: string) {
  await act(async () => {
    fireEvent.change(searchField(), { target: { value: text } });
  });
  await settle();
}

async function click(el: Element | null, what: string) {
  assert.ok(el, `nothing to click: ${what}`);
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

/** Open one rule's editor by its stored name. */
async function openCard(name: string) {
  const label = document.querySelector(`[data-rule-name="${name}"]`);
  assert.ok(label, `no card called ${name}`);
  await click(label.closest("button"), name);
}

const homeSwitch = (): HTMLElement | null =>
  document.querySelector('[aria-label="Shown in Home Assistant"]');

/** What the Home Assistant switch in the open editor reads. */
const homeSwitchState = (): string =>
  homeSwitch()?.getAttribute("aria-checked") ?? homeSwitch()?.getAttribute("data-state") ?? "none";

beforeEach(() => {
  RULES = [];
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

describe("the two sections", () => {
  test("a shown cue is under Home Assistant and a hidden one is not", async () => {
    RULES = [cue("take_screens"), cue("house_lights", { homeAssistant: "hidden" })];
    await mount();
    assert.deepEqual(sectionTitles(), ["Home Assistant", "Everything else"]);
    assert.deepEqual(rowsUnder("Home Assistant"), ["Rule take_screens"]);
    assert.deepEqual(rowsUnder("Everything else"), ["Rule house_lights"]);
  });

  test("a rule with another trigger is under Everything else, after the cues", async () => {
    RULES = [planRule("Lights at item 3"), cue("stage_wash", { homeAssistant: "hidden" })];
    await mount();
    assert.deepEqual(rowsUnder("Home Assistant"), []);
    assert.deepEqual(rowsUnder("Everything else"), ["Rule stage_wash", "Lights at item 3"]);
  });

  test("a section with no rows is not rendered at all", async () => {
    RULES = [cue("take_screens"), cue("house_lights")];
    await mount();
    assert.deepEqual(sectionTitles(), ["Home Assistant"]);
  });

  test("turning the switch off moves the cue, and saves `hidden`", async () => {
    RULES = [cue("take_screens")];
    await mount();
    await openCard("Rule take_screens");
    assert.equal(homeSwitchState(), "true");

    await click(homeSwitch(), "the Home Assistant switch");
    // The switch edits the DRAFT, exactly as the service guard does, so the
    // section moves only once Save is pressed.
    await click(
      [...document.querySelectorAll("button")].find((b) => b.textContent === "Save") ?? null,
      "Save",
    );

    const saved = requests.find((r) => r.url.includes("/api/automation/rules/"));
    assert.ok(saved, "nothing was saved");
    assert.match(saved.body ?? "", /"homeAssistant":"hidden"/);
    assert.deepEqual(rowsUnder("Home Assistant"), []);
    assert.deepEqual(rowsUnder("Everything else"), ["Rule take_screens"]);
  });
});

describe("a pair", () => {
  beforeEach(() => {
    RULES = [
      cue("projectors_on", { says: "the projectors on" }),
      cue("projectors_off"),
      cue("take_screens"),
    ];
  });

  test("is ONE row, named by the words, showing both cue names", async () => {
    await mount();
    assert.deepEqual(rowsUnder("Home Assistant"), ["projectors", "Rule take_screens"]);
    const row = document.querySelector('[data-cue-pair-row="projectors"]');
    assert.equal(row?.querySelector("[data-cue-pair-name]")?.textContent, "the projectors");
    assert.match(row?.textContent ?? "", /projectors_on \/ projectors_off/);
  });

  test("mounts no editor until it is pressed, and then exactly ONE", async () => {
    // Two editors for one pair is the list disagreeing with Home Assistant
    // about what a pair is — and it was two, stacked, when the row expanded.
    await mount();
    assert.equal(openEditors(), 0);
    await click(document.querySelector('[aria-label="the projectors pair"]'), "the pair row");
    assert.equal(openEditors(), 1);
    assert.equal(homeSwitches(), 1, "the pair's Home Assistant switch rendered more than once");
  });

  test("shows for a query that matches only its OFF half", async () => {
    await mount();
    await type("projectors_off");
    assert.deepEqual(rowsUnder("Home Assistant"), ["projectors"]);
    assert.deepEqual(sectionTitles(), ["Home Assistant"]);
  });

  test("hidden, it moves whole — neither half is left behind", async () => {
    RULES = [
      cue("projectors_on", { says: "the projectors on", homeAssistant: "hidden" }),
      cue("projectors_off"),
      cue("take_screens"),
    ];
    await mount();
    assert.deepEqual(rowsUnder("Home Assistant"), ["Rule take_screens"]);
    assert.deepEqual(rowsUnder("Everything else"), ["projectors"]);
  });

  test("the pair's switch writes the ON half's rule, and the ON half FIRST", async () => {
    await mount();
    await click(document.querySelector('[aria-label="the projectors pair"]'), "the pair row");
    // One switch for the pair, in "This pair" — an operator who found none on
    // one of the halves would hide one direction of a thing with one entity.
    assert.equal(homeSwitchState(), "true");

    await click(homeSwitch(), "the Home Assistant switch");
    await click(
      [...document.querySelectorAll("button")].find((b) => b.textContent === "Save") ?? null,
      "Save",
    );

    // BOTH halves are written, the ON half first: the flag lives there (see
    // cue-pairs.ts), and a failure on the second leaves the pair's own settings
    // saved rather than an off rule claiming settings the on rule lost.
    const saved = requests.filter((r) => r.url.includes("/api/automation/rules/"));
    assert.deepEqual(
      saved.map((r) => r.url.split("/").pop()),
      ["rule-projectors_on", "rule-projectors_off"],
    );
    assert.match(saved[0]?.body ?? "", /"homeAssistant":"hidden"/);
    assert.equal(
      /"homeAssistant":"hidden"/.test(saved[1]?.body ?? ""),
      false,
      "the off half was hidden too; the flag belongs on the on half alone",
    );
    assert.deepEqual(rowsUnder("Everything else"), ["projectors"]);
  });
});
