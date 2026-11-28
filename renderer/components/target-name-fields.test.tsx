// The name field on each integration's target card (OSC, RossTalk, wireless): a
// refused rename puts the saved name back, an emptied field is put back without a
// write, and a refusal is said out loud.
//
// The saved name does not change when a rename is refused, so nothing that follows
// it would put the field back: it would show a name the server does not have until
// the page was reloaded. Driven through the real panels with fetch stubbed.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND: node:assert inspects its
// operand on failure, and inspecting a live jsdom element does not terminate.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, reply, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider, Toaster } = await import("./ui/index.js");
const { OscTargetsPanel } = await import("./osc-targets-panel.js");
const { RossTalkTargetsPanel } = await import("./rosstalk-targets-panel.js");
const { WirelessConnectionsPanel } = await import("./wireless-connections-panel.js");

after(() => unmountAndTeardown(cleanup, teardown));
/** Every test's query client, cleared after it: an unmounted query keeps a garbage-collection timer that holds the process open for minutes. */
const clients: InstanceType<typeof QueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const c of clients.splice(0)) c.clear();
});

const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
const lastToast = () => {
  const all = [...document.querySelectorAll(".text-footnote")];
  return all.length ? text(all[all.length - 1]) : "NO TOAST";
};

interface Panel {
  name: string;
  element: () => React.ReactElement;
  label: string;
  saved: string;
  /** The list reads, by URL suffix. */
  reads: Record<string, unknown>;
  /** The rename's PATCH URL. */
  update: string;
  /** The tag a refused save logs under. */
  logTag: string;
}

const PANELS: Panel[] = [
  {
    name: "OSC",
    element: () => React.createElement(OscTargetsPanel),
    label: "Target name",
    saved: "Console",
    reads: {
      "/api/osc/targets": [{ id: "t1", name: "Console", enabled: true, config: { host: "192.0.2.2", port: 8000 }, connection: "disconnected" }],
      "/api/osc/feedback-port": { port: 9000 },
    },
    update: "/api/osc/targets/t1",
    logTag: "osc",
  },
  {
    name: "RossTalk",
    element: () => React.createElement(RossTalkTargetsPanel),
    label: "Target name",
    saved: "Switcher",
    reads: {
      "/api/rosstalk/targets": { targets: [{ id: "r1", name: "Switcher", enabled: true, config: { host: "192.0.2.3", port: 7788, family: "carbonite" }, connection: "disconnected" }], simulate: false },
      "/api/rosstalk/commands": [],
    },
    update: "/api/rosstalk/targets/r1",
    logTag: "rosstalk",
  },
  {
    name: "wireless",
    element: () => React.createElement(WirelessConnectionsPanel),
    label: "Connection name",
    saved: "Receivers",
    reads: {
      "/api/wireless/providers": [],
      "/api/wireless/connections": [{ id: "w1", name: "Receivers", providerId: "none", enabled: true, config: {} }],
      "/api/wireless/meter-rate": { ms: 1000 },
    },
    update: "/api/wireless/connections/w1",
    logTag: "wireless",
  },
];

function stub(panel: Panel) {
  const writes: unknown[] = [];
  const f = stubFetchWithLog((url, init) => {
    if (init?.method === "PATCH" && url.endsWith(panel.update)) {
      writes.push(JSON.parse(String(init.body ?? "{}")));
      return reply(400, { error: "That name is taken" });
    }
    const hit = Object.entries(panel.reads).find(([suffix]) => url.endsWith(suffix));
    return ok(hit ? hit[1] : {});
  });
  return { writes, logs: f.logs, restore: f.restore };
}

async function mount(panel: Panel): Promise<HTMLInputElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, panel.element(), React.createElement(Toaster)),
    ),
  );
  await settle();
  return eventually(() => {
    const input = screen.getByRole("textbox", { name: panel.label }) as HTMLInputElement;
    assert.equal(input.value, panel.saved, "the target never loaded");
    return input;
  });
}

async function typeAndLeave(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
  await settle();
  await settle();
}

for (const panel of PANELS) {
  describe(`the ${panel.name} name field`, () => {
    test("a refused rename puts the saved name back and says why", async () => {
      const net = stub(panel);
      try {
        const input = await mount(panel);
        await typeAndLeave(input, "Renamed");
        assert.equal(net.writes.length, 1, "the rename was never sent");
        await eventually(() => assert.equal(input.value, panel.saved, "a refused name was left in the field"));
        await eventually(() => assert.match(lastToast(), /That name is taken/));
        assert.ok(
          net.logs.some((l) => l.tag === panel.logTag && /That name is taken/.test(l.message)),
          `no [${panel.logTag}] line for the refusal: ${JSON.stringify(net.logs)}`,
        );
      } finally {
        net.restore();
      }
    });

    test("an emptied field is put back, and nothing is sent", async () => {
      const net = stub(panel);
      try {
        const input = await mount(panel);
        await typeAndLeave(input, "   ");
        assert.equal(input.value, panel.saved, "an emptied name was left in the field");
        assert.deepEqual(net.writes, [], "an emptied name was sent");
      } finally {
        net.restore();
      }
    });
  });
}

// Every other RossTalk write awaited a bare invoke, so a refusal rejected unhandled:
// no toast and nothing in /log. Remove and Add stand for the four.
describe("the RossTalk panel's other writes", () => {
  const panel = PANELS.find((p) => p.name === "RossTalk")!;
  test("a refused remove or add says why, and logs it", async () => {
    const f = stubFetchWithLog((url, init) => {
      if ((init?.method === "DELETE" && url.endsWith("/api/rosstalk/targets/r1")) || (init?.method === "POST" && url.endsWith("/api/rosstalk/targets"))) {
        return reply(500, { error: "Store is read-only" });
      }
      const hit = Object.entries(panel.reads).find(([suffix]) => url.endsWith(suffix));
      return ok(hit ? hit[1] : {});
    });
    try {
      await mount(panel);
      fireEvent.click(screen.getByRole("button", { name: "Remove target" }));
      await eventually(() => assert.match(lastToast(), /Could not remove .*Store is read-only/));
      fireEvent.click(screen.getByRole("button", { name: /Add target/ }));
      await eventually(() => assert.match(lastToast(), /Could not add .*Store is read-only/));
      assert.equal(f.logs.filter((l) => l.tag === "rosstalk" && /Store is read-only/.test(l.message)).length, 2, JSON.stringify(f.logs));
    } finally {
      f.restore();
    }
  });
});
