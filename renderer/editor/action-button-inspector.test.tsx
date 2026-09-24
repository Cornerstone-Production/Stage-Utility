// The action-button object's inspector: picks the action, edits its
// parameters, and sets the label. Its own component (like action-picker.tsx),
// so this can be rendered without mounting the whole Inspector and its
// unrelated hooks (SPL, wireless, people count, PVP, …).

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent, waitFor } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ActionButtonInspector } = await import("./action-button-inspector.js");
const { DEFAULT_STAGE_STATE } = await import("../main/test-render-ctx.js");

after(() => {
  cleanup();
  teardown();
});
afterEach(() => cleanup());

const REGISTRY_ACTIONS = [
  { id: "baptism.advance", label: "Advance the baptism timer", params: [], help: "Whatever the panel's own button would do." },
  {
    id: "companion.signal-from-roster",
    label: "Set a Companion signal from the roster",
    params: [
      { key: "signal", label: "Signal name", type: "string" },
      { key: "position", label: "Only this position", type: "string", optional: true },
    ],
  },
];

(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
  const u = String(url);
  const body = u.includes("/api/automation/registry")
    ? { triggers: [], conditions: [], actions: REGISTRY_ACTIONS }
    : u.includes("/api/state")
      ? DEFAULT_STAGE_STATE
      : u.includes("/api/rosstalk/targets") || u.includes("rosstalk-targets")
        ? { targets: [] }
        : { ok: true, detail: "" };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

function mount(c: { type: "action-button"; actionId: string; params?: Record<string, unknown>; label?: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const configs: typeof c[] = [];
  const utils = render(
    React.createElement(
      QueryClientProvider as never,
      { client: qc },
      React.createElement(ActionButtonInspector as never, {
        c,
        onConfig: (next: typeof c) => configs.push(next),
      }),
    ),
  );
  return { ...utils, configs };
}

describe("the action-button inspector", () => {
  test("picking an action writes its id into config.actionId, clearing old params", async () => {
    const { container, configs } = mount({ type: "action-button", actionId: "", params: { stale: "x" } });
    await waitFor(() => assert.ok(container.querySelectorAll("option").length > 1));
    fireEvent.change(container.querySelector("select")!, { target: { value: "baptism.advance" } });
    assert.equal(configs.at(-1)?.actionId, "baptism.advance");
    assert.deepEqual(configs.at(-1)?.params, {});
  });

  test("an action with parameters renders a field per parameter, and typing writes it into config.params", async () => {
    const { container, configs } = mount({ type: "action-button", actionId: "companion.signal-from-roster", params: {} });
    // Waits for the REGISTRY's answer specifically, not just any input — the
    // Label field's own input renders immediately, before the fetch resolves,
    // and satisfied a weaker wait here without the param fields ever existing.
    await waitFor(() => assert.ok(container.textContent?.includes("Signal name")));
    assert.ok(container.textContent?.includes("Only this position"), "expected a field per parameter");
    // Three inputs: Signal name, Only this position, and the Label field.
    const inputs = container.querySelectorAll("input");
    assert.equal(inputs.length, 3, `expected one input per parameter plus the label, saw ${inputs.length}`);
    fireEvent.change(inputs[0]!, { target: { value: "dante_tb" } });
    assert.equal(configs.at(-1)?.params?.signal, "dante_tb");
  });

  test("an action with no parameters renders none — only the Label field", async () => {
    const { container } = mount({ type: "action-button", actionId: "baptism.advance", params: {} });
    await waitFor(() => assert.ok(container.textContent?.includes("Advance the baptism timer")));
    assert.equal(container.querySelectorAll("input").length, 1);
  });

  test("typing a label writes it into config.label", async () => {
    const { container, configs } = mount({ type: "action-button", actionId: "baptism.advance" });
    await waitFor(() => assert.ok(container.textContent?.includes("Advance the baptism timer")));
    const labelInput = [...container.querySelectorAll("input")].find(
      (i) => (i as HTMLInputElement).placeholder === "Advance the baptism timer",
    ) as HTMLInputElement;
    assert.ok(labelInput, "the label field should placeholder the action's own label once it is chosen");
    fireEvent.change(labelInput, { target: { value: "ADVANCE" } });
    assert.equal(configs.at(-1)?.label, "ADVANCE");
  });
});
