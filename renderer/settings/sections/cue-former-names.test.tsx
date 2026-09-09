// The names a cue used to answer to, in the rules list and in the rule editor.
//
// A cue is renamed when its Companion button is relabelled, and the OLD name
// stays live so an already pasted Home Assistant config keeps working. Two
// things about that are assertable as strings, and both are silent when wrong:
//
//  - the rules list says "was <old>". Without it the only place the former name
//    exists is the rules file, so an operator reading a row called `screens_on`
//    has no way to know that the URL in their config says `projectors_on`.
//  - the remove REALLY REMOVES IT. A chip with an X that edits nothing is this
//    repo's named scar — a `+ row` button once shipped adding a row the same
//    code filtered straight back out — so the assertion here is on the PATCH
//    body the server would receive, not on the chip disappearing.
//
// NOT unit-tested here, and driven in a browser instead: that "was …" reads as
// quiet rather than as a second title, and that a long list of former names
// truncates instead of pushing the Test button off the row. jsdom loads no
// stylesheet and reports every offsetHeight as 0, so neither is observable in it
// at all.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND. node:assert builds its
// failure message by inspecting `actual`, and inspecting a live jsdom element
// does not terminate in any useful time — a sibling file ran for 81.5 s on one
// such assertion and was killed with no line number.

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

/** The registry the section renders its fields from, cut to what it reads. */
const REGISTRY = {
  triggers: [
    {
      id: CALL_TRIGGER_ID,
      label: "Called by name (voice or HTTP)",
      channel: "cue:call",
      params: [
        { key: "name", label: "Cue name", type: "string" },
        { key: "aliases", label: "Former names", type: "string", optional: true },
        { key: "says", label: "Spoken as", type: "string", optional: true },
      ],
    },
  ],
  conditions: [],
  actions: [{ id: "log.message", label: "Write a log message", params: [] }],
};

let RULES: StubRule[] = [];
/** Every request the stub was handed, so a PATCH body can be read back. */
let requests: { url: string; method: string; body: string | null }[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  requests.push({
    url,
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? init.body : null,
  });
  let body: unknown = {};
  if (url.includes("/api/automation/registry")) body = REGISTRY;
  else if (url.includes("/api/automation/rules")) {
    body = { rules: RULES, settings: { simulate: true, disarmed: false } };
  } else if (url.includes("/api/automation/log")) body = { entries: [] };
  else if (url.includes("/api/automation/plan-items")) body = { items: [] };
  else if (url.includes("/api/rosstalk/targets")) body = { targets: [] };
  // An ARRAY: this endpoint answers a bare list, and an object here crashes the
  // section's option memo rather than failing an assertion.
  else if (url.includes("/api/rosstalk/commands")) body = [];
  else if (url.includes("/api/cues/tokens")) body = { tokens: [] };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, fireEvent, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { AutomationSection } = await import("./automation-section.js");

/** Several macrotasks: the queries, their re-renders and the portals are turns. */
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
  // The operator app wraps everything in a TooltipProvider (renderer/app/index.tsx),
  // and the section's InfoHints are tooltips.
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

/** A renamed cue: it answers to `screens_on` and still to `projectors_on`. */
const renamed = (aliases = "projectors_on"): StubRule => ({
  id: "rule-1",
  name: "Screens ON",
  enabled: true,
  trigger: { id: CALL_TRIGGER_ID, params: { name: "screens_on", says: "the screens", aliases } },
  conditions: [],
  action: { id: "log.message", params: { message: "x" } },
  cooldownSec: 0,
  oncePerService: false,
});

/** The former names the row says, as one string. */
const rowSays = (): string =>
  document.querySelector("[data-cue-former-names]")?.textContent?.trim() ?? "";

/** The chips the editor lists, from the attribute rather than the nodes. */
const chips = (): string =>
  document.querySelector("[data-cue-former-list]")?.getAttribute("data-cue-former-list") ?? "";

beforeEach(() => {
  requests = [];
  RULES = [renamed()];
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

describe("the rules list", () => {
  test("says what a renamed cue used to be called", async () => {
    await mount();
    assert.equal(rowSays(), "was projectors_on");
  });

  test("names every former name, in order", async () => {
    RULES = [renamed("projectors_on,beamers_on")];
    await mount();
    assert.equal(rowSays(), "was projectors_on, beamers_on");
  });

  test("and says nothing at all for a cue nobody has renamed", async () => {
    RULES = [renamed("")];
    await mount();
    assert.equal(
      document.querySelector("[data-cue-former-names]"),
      null,
      "a cue with no former names got a 'was' of its own",
    );
  });
});

describe("the rule editor", () => {
  /** Open the rule's editor by pressing its row. */
  async function open(): Promise<void> {
    await mount();
    fireEvent.click(screen.getByText("Screens ON"));
    await settle();
  }

  test("lists the former names as chips", async () => {
    RULES = [renamed("projectors_on,beamers_on")];
    await open();
    assert.equal(chips(), "projectors_on,beamers_on");
  });

  test("REMOVING one posts the rule without it", async () => {
    // The whole point. A chip with an X that only hides the chip would pass a
    // test that read the DOM back, and the former name would still resolve.
    RULES = [renamed("projectors_on,beamers_on")];
    await open();

    fireEvent.click(screen.getByLabelText("Remove former name projectors_on"));
    await settle();
    assert.equal(chips(), "beamers_on", "the draft did not change");

    requests = [];
    fireEvent.click(screen.getByText("Save"));
    await settle();

    const patch = requests.find((r) => r.method === "PATCH");
    assert.ok(patch, `no PATCH was sent; got ${requests.map((r) => `${r.method} ${r.url}`).join(", ")}`);
    assert.ok(patch.url.endsWith("/api/automation/rules/rule-1"), patch.url);
    const sent = JSON.parse(patch.body ?? "{}") as {
      trigger: { params: { aliases: string; name: string } };
    };
    assert.equal(sent.trigger.params.aliases, "beamers_on");
    // And nothing else about the cue moved.
    assert.equal(sent.trigger.params.name, "screens_on");
  });

  test("removing the last one posts an empty list, not a stale one", async () => {
    await open();
    fireEvent.click(screen.getByLabelText("Remove former name projectors_on"));
    await settle();
    fireEvent.click(screen.getByText("Save"));
    await settle();

    const patch = requests.find((r) => r.method === "PATCH");
    assert.ok(patch, "no PATCH was sent");
    const sent = JSON.parse(patch.body ?? "{}") as { trigger: { params: { aliases: string } } };
    assert.equal(sent.trigger.params.aliases, "");
  });

  test("the former names are NOT a text field", async () => {
    // A comma-joined list of live URLs in an <input> is one typo away from a
    // switch in Home Assistant that stops resolving.
    await open();
    const labels = screen.getAllByText("Former names").length;
    assert.equal(labels, 1, "the generic string field is rendering alongside the chips");
    assert.equal(
      document.querySelectorAll("input[value='projectors_on']").length,
      0,
      "the former names are editable as text",
    );
  });
});
