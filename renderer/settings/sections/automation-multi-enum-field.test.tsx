// A multi-enum param in the rule editor.
//
// `multi-enum` was rendered by the ONE-value Select branch beside `enum`, so a
// param that stores a comma-separated list ("Day of week is", "Applies to", and a
// message's groups) could only ever be given a single value: the dialog offered
// one day, never two. It is a MultiSelect now, and the value it writes is the
// comma-separated string every reader of these params already splits.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND. node:assert builds its
// failure message by inspecting `actual`, and inspecting a live jsdom element
// does not terminate in any useful time.
//
// NOT unit-tested here, and driven in a browser instead: how the popover sits
// under its trigger and scrolls at a long list. jsdom loads no stylesheet and
// reports every offsetHeight as 0.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

const REGISTRY = {
  triggers: [{ id: "service.live", label: "Service goes live", channel: "pco:live", params: [] }],
  conditions: [],
  actions: [
    {
      id: "x.pick",
      label: "Pick some",
      params: [
        {
          key: "days",
          label: "Days",
          type: "multi-enum",
          optional: true,
          options: [
            { value: "0", label: "Sun" },
            { value: "1", label: "Mon" },
            { value: "2", label: "Tue" },
          ],
        },
      ],
    },
  ],
};

let params: Record<string, string | number> = {};
let requests: { method: string; url: string; body: string | null }[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  let body: unknown = {};
  if (method !== "GET") {
    requests.push({ method, url, body: typeof init?.body === "string" ? init.body : null });
    if (method === "PATCH") {
      body = { id: "rule-1", issues: [] };
    }
  } else if (url.includes("/api/automation/registry")) body = REGISTRY;
  else if (url.includes("/api/automation/rules")) {
    body = {
      rules: [
        {
          id: "rule-1",
          name: "Pick days",
          enabled: true,
          trigger: { id: "service.live", params: {} },
          conditions: [],
          action: { id: "x.pick", params },
          cooldownSec: 0,
          oncePerService: false,
          issues: [],
        },
      ],
      settings: { simulate: true, disarmed: false },
    };
  } else if (url.includes("/api/automation/log")) body = { entries: [] };
  else if (url.includes("/api/automation/plan-items")) body = { items: [] };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, fireEvent, screen, within } = await import("@testing-library/react");
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

async function open(): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(AutomationSection, {})),
    ),
  );
  await settle();
  fireEvent.click(screen.getByText("Pick days"));
  await settle();
}

const press = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
  await settle();
};

/** The Days picker's trigger. Its accessible name is the caption then the summary. */
const trigger = (): HTMLElement => screen.getByRole("button", { name: /^Days\b/ });

/** Open the picker and tick a row by its label. */
async function tick(label: string): Promise<void> {
  if (!document.querySelector('[role="dialog"][aria-label="Days"]')) await press(trigger());
  const list = document.querySelector('[role="dialog"][aria-label="Days"]') as HTMLElement;
  assert.ok(list, "the Days list did not open");
  await press(within(list).getByText(label).closest("button") as HTMLElement);
}

const saved = (): { action: { params: Record<string, string> } }[] =>
  requests.filter((r) => r.method === "PATCH").map((r) => JSON.parse(r.body ?? "{}"));

beforeEach(() => {
  params = {};
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

describe("a multi-enum param", () => {
  test("takes more than one value, stored comma-separated in the list's own order", async () => {
    await open();
    // Ticked out of order on purpose: the stored string follows the options, not the clicks.
    await tick("Tue");
    await tick("Sun");
    await press(screen.getByRole("button", { name: "Save" }));
    const writes = saved();
    assert.equal(writes.length, 1, "Save did not write");
    assert.equal(writes[0]!.action.params.days, "0,2");
  });

  test("shows what the rule already has, and unticking removes only that one", async () => {
    params = { days: "0,1,2" };
    await open();
    assert.match(trigger().textContent ?? "", /All \(3\)/);
    await tick("Mon");
    await press(screen.getByRole("button", { name: "Save" }));
    assert.equal(saved()[0]!.action.params.days, "0,2");
  });
});
