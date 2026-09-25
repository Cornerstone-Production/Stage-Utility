// The action-button object's inspector: picks the action, edits its
// parameters, and sets the label. Its own component (like action-picker.tsx),
// so this can be rendered without mounting the whole Inspector and its
// unrelated hooks (SPL, wireless, people count, PVP, …).

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";
import type { ParamDef } from "@main/types/automation.js";

const teardown = installDom();

const { render, cleanup, fireEvent, waitFor } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ActionButtonInspector } = await import("./action-button-inspector.js");
const { DEFAULT_STAGE_STATE } = await import("../main/test-render-ctx.js");
const { validateParams } = await import("@main/services/automation-param-validation.js");

after(() => {
  cleanup();
  teardown();
});
afterEach(() => cleanup());

const REGISTRY_ACTIONS: { id: string; label: string; params: ParamDef[]; help?: string }[] = [
  { id: "baptism.advance", label: "Advance the baptism timer", params: [], help: "Whatever the panel's own button would do." },
  {
    id: "companion.signal-from-roster",
    label: "Set a Companion signal from the roster",
    params: [
      { key: "signal", label: "Signal name", type: "string" },
      { key: "position", label: "Only this position", type: "string", optional: true },
    ],
  },
  {
    id: "companion.press",
    label: "Press a Companion button",
    params: [
      { key: "page", label: "Page", type: "number", min: 1, max: 999 },
      { key: "row", label: "Row", type: "number", min: 0, max: 99 },
      { key: "col", label: "Column", type: "number", min: 0, max: 99 },
    ],
  },
  {
    id: "osc.send",
    label: "Send an OSC message",
    params: [{ key: "argument", label: "Argument", type: "number", min: 0, max: 7 }],
  },
  {
    id: "rosstalk.command",
    label: "Send a RossTalk command",
    // The exact param Button.dc.html's mockup shows unset ("Target"), so the
    // suffix test below matches the mockup's own wording, not a stand-in.
    params: [{ key: "targetId", label: "Target", type: "enum", optionsFrom: "rosstalk-targets" }],
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

/**
 * The inspector, actually driven — `onConfig` feeds a real `useState`, so a
 * picked action re-renders with what it seeded rather than only recording it
 * in an array. `mount()` above is enough for "what did onConfig receive", but
 * this bug (companion.press's OWN picker misreading a seeded `page: 1` as "a
 * button is chosen") only shows up in what the SCREEN says after the pick —
 * `configs.at(-1)` alone would not have caught it.
 */
function mountStateful(initial: { type: "action-button"; actionId: string; params?: Record<string, unknown>; label?: string }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const configs: (typeof initial)[] = [];
  function Wrapper() {
    const [c, setC] = React.useState(initial);
    return React.createElement(ActionButtonInspector as never, {
      c,
      onConfig: (next: typeof initial) => {
        configs.push(next);
        setC(next);
      },
    });
  }
  const utils = render(React.createElement(QueryClientProvider as never, { client: qc }, React.createElement(Wrapper)));
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

  // The bug this guards: a number field DISPLAYS Number(value ?? spec.min ?? 0)
  // while the stored value stays unset until the operator touches it. Reverting
  // action-button-inspector.tsx's seededParams call back to `params: {}`
  // turns this red. osc.send, not companion.press: companion.press renders
  // through its OWN picker and must never be seeded — see the describe below.
  test("picking an action with number params seeds them into config.params at once", async () => {
    const { container, configs } = mount({ type: "action-button", actionId: "", params: {} });
    await waitFor(() => assert.ok(container.querySelectorAll("option").length > 1));
    fireEvent.change(container.querySelector("select")!, { target: { value: "osc.send" } });
    assert.deepEqual(
      configs.at(-1)?.params,
      { argument: 0 },
      `picking osc.send must seed its number params, got ${JSON.stringify(configs.at(-1)?.params)}`,
    );
  });

  test("an action with no parameters renders none — only the Label field", async () => {
    const { container } = mount({ type: "action-button", actionId: "baptism.advance", params: {} });
    await waitFor(() => assert.ok(container.textContent?.includes("Advance the baptism timer")));
    assert.equal(container.querySelectorAll("input").length, 1);
  });

  // Button.dc.html: "Pick a target. Until then, pressing this button does
  // nothing and says why." — the plain validateParams message ("Pick a
  // target") plus a second sentence that is THIS component's own, because
  // this is the one surface where an operator can press an unconfigured
  // button and have nothing stop them. The rule editor renders the exact
  // same ParamField/validateParams message with no such second sentence —
  // see rule-editor-dialog.test.tsx's own issue-message assertions, unchanged
  // by this file.
  test("a missing field's message names the field, then says why it matters here", async () => {
    const { container } = mount({ type: "action-button", actionId: "rosstalk.command", params: {} });
    await waitFor(() =>
      assert.ok(
        container.textContent?.includes(
          "Pick a target. Until then, pressing this button does nothing and says why.",
        ),
      ),
    );
  });

  // The bug this guards: seedNumberDefaults ran unconditionally, including for
  // companion.press, whose `page` (min 1) then seeded to 1 the instant the
  // action was picked. CompanionPressFields reads page > 0 as "a button is
  // chosen", so the button read "p1 r0 c0" instead of "Choose Companion
  // button…" — with no button ever actually picked, and no way to tell from
  // the screen. Reverting hasCustomParamsPicker to always return false turns
  // this red. Driven with mountStateful, not mount(): the earlier seeding
  // test used mount() and only checked configs.at(-1), which is exactly why
  // this shipped — the SCREEN, not the recorded config, is what was wrong.
  test("picking companion.press shows 'Choose Companion button…', never a seeded coordinate", async () => {
    const { container } = mountStateful({ type: "action-button", actionId: "", params: {} });
    await waitFor(() => assert.ok(container.querySelectorAll("option").length > 1));
    fireEvent.change(container.querySelector("select")!, { target: { value: "companion.press" } });
    await waitFor(() => assert.ok(container.textContent?.includes("Choose Companion button")));
    assert.doesNotMatch(
      container.textContent ?? "",
      /p1 r0 c0/,
      "an unpicked button must never read as a real coordinate",
    );
  });

  // Ties the pick straight to action-button.tsx's own Needs-setup formula
  // (`editing && validateParams(action.params, config.params).length > 0`),
  // rather than just the screen text above. Reverting hasCustomParamsPicker
  // to always return false turns this red: companion.press would have been
  // seeded to {page: 1, row: 0, col: 0}, which validateParams reads as
  // complete, so the layout canvas badge would never have shown on a button
  // whose action nobody had actually chosen yet.
  test("the params a fresh companion.press pick leaves behind still fail validateParams, so the badge would show", async () => {
    const { container, configs } = mountStateful({ type: "action-button", actionId: "", params: {} });
    await waitFor(() => assert.ok(container.querySelectorAll("option").length > 1));
    fireEvent.change(container.querySelector("select")!, { target: { value: "companion.press" } });
    await waitFor(() => assert.ok(container.textContent?.includes("Choose Companion button")));
    const companionPress = REGISTRY_ACTIONS.find((a) => a.id === "companion.press")!;
    const issues = validateParams(companionPress.params, (configs.at(-1)?.params ?? {}) as Record<string, unknown>);
    assert.ok(
      issues.length > 0,
      `expected the freshly-picked, still-unchosen button to fail validation, got zero issues for params ${JSON.stringify(configs.at(-1)?.params)}`,
    );
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
