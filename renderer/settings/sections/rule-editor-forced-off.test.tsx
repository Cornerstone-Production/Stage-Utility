// The rule editor's "forced off" flow: a save that finds issues stores the
// rule OFF (automation-routes.ts's forcedOff()), and the dialog offers to turn
// it back on once every field is fixed.
//
// The bug this guards: the offer applied unconditionally — "if forcedOff and
// no issues, send enabled:true" — with no regard for what the Enabled switch
// on screen actually read. An operator who explicitly switched a broken rule
// off, or a rule that was never on in the first place (every Add rule starts
// off), got enabled behind their back the moment the field was fixed and Save
// was pressed again. Reverting either `onDraft.enabled`/`offDraft.enabled`
// gate in save(), or the matching `onWillReenable`/`offWillReenable` gate on
// the footer, turns the tests below red.
//
// Driven through the REAL RuleEditorDialog against a stub fetch that computes
// issues with the real ruleIssues (automation-routes.ts's own PATCH logic,
// faithfully: a bare enabled:true patch over issues is refused with 409;
// anything else saves with enabled forced to false while issues remain).

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom, settle } from "../../test-dom.js";
import { ruleIssues, type RuleStepsLike } from "@main/services/automation-param-validation";
import type { ParamDef } from "@main/types/automation";
import type { OptionSources } from "./automation-option-sources.js";

const teardown = installRenderDom();

const REGISTRY = {
  triggers: [
    {
      id: "pco.item-reached",
      label: "Plan reaches an item",
      channel: "pco:live",
      params: [{ key: "title", label: "Item title contains", type: "string" }] as ParamDef[],
    },
  ],
  conditions: [] as { id: string; label: string; params: ParamDef[] }[],
  actions: [
    { id: "log.message", label: "Write a log message", params: [{ key: "message", label: "Message", type: "string" }] as ParamDef[] },
  ],
};
const lookup = (kind: "trigger" | "condition" | "action", id: string) => {
  const list = kind === "trigger" ? REGISTRY.triggers : kind === "condition" ? REGISTRY.conditions : REGISTRY.actions;
  const s = list.find((x) => x.id === id);
  return s ? { label: s.label, params: s.params } : null;
};

interface StubRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { id: string; params: Record<string, string> };
  conditions: never[];
  action: { id: string; params: Record<string, string> };
  cooldownSec: number;
  oncePerService: boolean;
}

let SERVER: StubRule;
let patches: Record<string, unknown>[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (_input: unknown, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  if (method === "PATCH") {
    // automation-routes.ts's real PATCH logic, faithfully: a candidate is the
    // server's current record merged with the patch, re-validated, and a bare
    // "turn it on" over issues is the one refusal — everything else saves,
    // forced off while issues remain.
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    patches.push(body);
    const candidate = { ...SERVER, ...body } as unknown as RuleStepsLike;
    const issues = ruleIssues(candidate, lookup);
    const onlyAsksToEnable = body.enabled === true && Object.keys(body).length === 1;
    if (issues.length > 0 && onlyAsksToEnable) {
      const e = { error: "This rule needs setup before it can be turned on", code: "invalid-params", issues };
      return { ok: false, status: 409, statusText: "Conflict", json: async () => e, text: async () => JSON.stringify(e) };
    }
    const patch = issues.length > 0 ? { ...body, enabled: false } : body;
    Object.assign(SERVER, patch);
    const answered = { ...SERVER, issues: ruleIssues(SERVER as unknown as RuleStepsLike, lookup) };
    return { ok: true, status: 200, json: async () => answered, text: async () => JSON.stringify(answered) };
  }
  const body: unknown = {};
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { RuleEditorDialog } = await import("./rule-editor-dialog.js");

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(RuleEditorDialog, {
          target: { kind: "rule", rule: structuredClone(SERVER) },
          onClose: () => {},
          registry: REGISTRY,
          optionSources: {} as OptionSources,
          customVariables: [],
          appSources: [],
          pvpLayers: [],
          inferredFor: () => null,
          onChanged: () => {},
        }),
      ),
    ),
  );
  await settle();
}

const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
const enabledSwitch = () => document.querySelector('[aria-label="Rule enabled"]') as HTMLElement;
const titleInput = () =>
  [...document.querySelectorAll("label")].find((l) => l.textContent?.includes("Item title contains"))!.querySelector("input")!;
async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await settle();
}

beforeEach(() => {
  patches = [];
});
afterEach(async () => {
  cleanup();
  await settle();
});
after(() => teardown());

const base = (enabled: boolean): StubRule => ({
  id: "r1",
  name: "Doors cue",
  enabled,
  trigger: { id: "pco.item-reached", params: {} }, // title missing — an issue
  conditions: [],
  action: { id: "log.message", params: { message: "hi" } },
  cooldownSec: 30,
  oncePerService: false,
});

describe("a save that turned the rule off over an issue", () => {
  test("A: enabled with an issue; forced off; operator switches Enabled OFF, fixes the field, saves — it must stay off", async () => {
    SERVER = base(true);
    await mount();
    await click(button("Save"));
    assert.equal(SERVER.enabled, false, "first save should have been forced off");

    await click(enabledSwitch());
    assert.equal(enabledSwitch().getAttribute("aria-checked"), "false", "switch should now show OFF");
    await act(async () => {
      fireEvent.change(titleInput(), { target: { value: "Doors" } });
    });
    await settle();
    await click(button("Save"));

    assert.equal(SERVER.enabled, false, "the operator switched it OFF and the save turned it back ON");
    const last = patches.at(-1);
    assert.equal(last?.enabled, false, `the second save's patch must ask for OFF, not re-add enabled:true, got ${JSON.stringify(last)}`);
  });

  test("B: OFF as Add rule creates it, with an issue; operator never touches Enabled; saves twice — it must stay off", async () => {
    SERVER = base(false);
    await mount();
    await click(button("Save"));
    assert.equal(enabledSwitch().getAttribute("aria-checked"), "false");

    await act(async () => {
      fireEvent.change(titleInput(), { target: { value: "Doors" } });
    });
    await settle();
    assert.equal(
      (document.body.textContent ?? "").includes("Save to turn it back on"),
      false,
      "the footer promised to re-enable a rule that was never on",
    );
    await click(button("Save"));

    assert.equal(SERVER.enabled, false, "a rule that was never on, with its switch showing OFF, was enabled by the save");
    const last = patches.at(-1);
    assert.equal(
      last?.enabled,
      undefined,
      `a half never touched must not gain an enabled key at all, got ${JSON.stringify(last)}`,
    );
  });

  test("control: switch stays ON throughout — the fixed field DOES turn it back on", async () => {
    SERVER = base(true);
    await mount();
    await click(button("Save"));
    assert.equal(SERVER.enabled, false, "first save should have been forced off");
    assert.equal(enabledSwitch().getAttribute("aria-checked"), "true", "the switch itself still reads ON");

    await act(async () => {
      fireEvent.change(titleInput(), { target: { value: "Doors" } });
    });
    await settle();
    assert.equal((document.body.textContent ?? "").includes("Save to turn it back on"), true, "the footer must offer to re-enable when the switch still reads on");
    await click(button("Save"));

    assert.equal(SERVER.enabled, true, "a switch left ON, once its field is fixed, must turn back on");
  });
});
