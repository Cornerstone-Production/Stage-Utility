// The Commands tab: one list of commands, with Home Assistant, Voice and any time
// as badges, and the pair row that carries a command's Home Assistant switch.
//
// What is guarded, and why each is a bug rather than a nicety:
//
//  - THE HOME ASSISTANT BADGE IS THE ONLY PLACE THE LIST SAYS which commands
//    Home Assistant has been told about. A hidden command carrying it, or a shown
//    one missing it, is the operator being told the opposite of the truth. The
//    list used to say it by splitting into two sections; it is one list now, so
//    the badge has to.
//  - A RULE WITH ANOTHER TRIGGER IS NOT A COMMAND. It lives on the Rules tab, and
//    a Commands tab that listed it would put an automatic rule where "called by
//    name" is the whole description.
//  - A PAIR IS ONE ROW, and opens ONE editor holding both halves. Two rows — or
//    two stacked editors — for one switch is the list disagreeing with Home
//    Assistant about what a pair is, which is exactly the confusion
//    cue-pairs.ts exists to end.
//  - EITHER HALF'S NAME FINDS THE PAIR, on the Search tab. A search for the off
//    command that hid the row it lives on would be a pair unreachable by half its
//    own names.
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
    if (init.method === "PATCH") {
      // The real route's shape: the rule's own fields, flat, plus `issues` —
      // not a { rule, issues } wrapper. Every stub rule here already carries
      // every param its own action/trigger needs.
      const rule = RULES.find((r) => r.id === id);
      const answered = { ...rule, issues: [] };
      return { ok: true, status: 200, json: async () => answered, text: async () => JSON.stringify(answered) };
    }
  }
  let body: unknown = {};
  if (url.includes("/api/automation/registry")) body = REGISTRY;
  else if (url.includes("/api/automation/rules")) {
    body = { rules: RULES.map((r) => ({ ...r, issues: [] })), settings: { simulate: true, disarmed: false } };
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

async function mount(tab: "commands" | "rules" | "search" = "commands") {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(AutomationSection, { tab })),
    ),
  );
  await settle();
  return view;
}

/** The rows on screen, in order: a pair by its base, a command or rule by its stored name. */
function rows(): string[] {
  const out: string[] = [];
  for (const el of document.querySelectorAll("[data-cue-pair-row], [data-rule-name]")) {
    out.push(el.getAttribute("data-cue-pair-row") ?? el.getAttribute("data-rule-name") ?? "");
  }
  return out;
}

/** Which of the row's badges are showing, by the name each carries. */
function badgesOf(row: string): string[] {
  const el =
    document.querySelector(`[data-cue-pair-row="${row}"]`) ??
    document.querySelector(`[data-rule-name="${row}"]`)?.closest("[data-rule-row]");
  assert.ok(el, `no row called ${row}`);
  return [...el.querySelectorAll("[data-command-badge]")].map((b) => b.getAttribute("data-command-badge") ?? "");
}

/** How many rule editors are mounted. The dialog is the only thing that mounts one. */
const openEditors = (): number => document.querySelectorAll("[data-rule-editor]").length;

/** The Home Assistant switches on screen — one per open editor, never per half. */
const homeSwitches = (): number =>
  document.querySelectorAll('[aria-label="Shown in Home Assistant"]').length;

const searchField = (): HTMLInputElement =>
  document.querySelector('[aria-label="Search automation"]') as HTMLInputElement;

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

describe("the Commands list", () => {
  test("a shown command carries the Home Assistant badge and a hidden one does not", async () => {
    RULES = [cue("take_screens"), cue("house_lights", { homeAssistant: "hidden" })];
    await mount();
    assert.deepEqual(rows(), ["Rule house_lights", "Rule take_screens"]);
    assert.ok(badgesOf("Rule take_screens").includes("home-assistant"));
    assert.ok(!badgesOf("Rule house_lights").includes("home-assistant"));
  });

  test("there is one list: no Home Assistant or Everything else section", async () => {
    RULES = [cue("take_screens"), cue("house_lights", { homeAssistant: "hidden" })];
    await mount();
    assert.equal(document.querySelectorAll("[data-rule-section]").length, 0);
    assert.ok(!/Everything else/.test(document.body.textContent ?? ""));
  });

  test("a command with a spoken name carries the Voice badge", async () => {
    RULES = [cue("take_screens", { says: "take the screens" }), cue("house_lights")];
    await mount();
    assert.ok(badgesOf("Rule take_screens").includes("voice"));
    assert.ok(!badgesOf("Rule house_lights").includes("voice"));
  });

  test("a rule with another trigger is on the Rules tab, not in Commands", async () => {
    RULES = [planRule("Lights at item 3"), cue("stage_wash", { homeAssistant: "hidden" })];
    await mount("commands");
    assert.deepEqual(rows(), ["Rule stage_wash"]);
    cleanup();
    await mount("rules");
    assert.deepEqual(rows(), ["Lights at item 3"]);
  });

  test("turning the switch off removes the badge, and saves `hidden`", async () => {
    RULES = [cue("take_screens")];
    await mount();
    await openCard("Rule take_screens");
    assert.equal(homeSwitchState(), "true");

    await click(homeSwitch(), "the Home Assistant switch");
    // The switch edits the DRAFT, exactly as the service guard does, so the
    // badge goes only once Save is pressed.
    await click(
      [...document.querySelectorAll("button")].find((b) => b.textContent === "Save") ?? null,
      "Save",
    );

    const saved = requests.find((r) => r.url.includes("/api/automation/rules/"));
    assert.ok(saved, "nothing was saved");
    assert.match(saved.body ?? "", /"homeAssistant":"hidden"/);
    assert.ok(!badgesOf("Rule take_screens").includes("home-assistant"));
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
    assert.deepEqual(rows(), ["projectors", "Rule take_screens"]);
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

  test("shows on Search for a query that matches only its OFF half", async () => {
    await mount("search");
    await type("projectors_off");
    assert.deepEqual(rows(), ["projectors"]);
  });

  test("hidden, it loses its Home Assistant badge whole — neither half keeps one", async () => {
    RULES = [
      cue("projectors_on", { says: "the projectors on", homeAssistant: "hidden" }),
      cue("projectors_off"),
      cue("take_screens"),
    ];
    await mount();
    assert.deepEqual(rows(), ["projectors", "Rule take_screens"]);
    assert.ok(!badgesOf("projectors").includes("home-assistant"));
    assert.ok(badgesOf("Rule take_screens").includes("home-assistant"));
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
    assert.ok(!badgesOf("projectors").includes("home-assistant"));
  });
});
