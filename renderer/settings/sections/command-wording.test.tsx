// The word "cue" does not come back on the automation surfaces.
//
// A rule called by name is a COMMAND on screen. The API (/api/cues/...), the stored
// `cue` field, the `cue-button` type, Home Assistant and the log tags still say
// `cue`, and none of that is on these pages. What an operator reads is.
//
// This renders the real pages against the real routes and reads EVERYTHING visible
// off each one: the text, plus the aria-label, title, placeholder and alt of every
// element, in portals too (a dialog, a select's list). The surfaces:
//
//  - the Commands tab, with a command that has a former name (the badge row)
//  - the Access tab (Calling commands, the Home Assistant config)
//  - the New command dialog on every step it has before Create
//  - a command's editor, with its Former names row and its trigger's field labels
//    (those labels come from the server's registry, not from this repo's JSX)
//  - the Button inspector's A command pane
//
// A source-text scan could not do this: the trigger's label is a string in main/,
// and a "cue" in a comment or an identifier would trip it. This reads the DOM.
//
// ALLOWED is the exact strings that may say cue. It is empty: nothing on these
// surfaces is about a ProVideoPlayer or ProPresenter cue. A string that must be
// added there says why, in this comment, or the review refuses it.
//
// NOT covered, and driven in a browser instead: the Companion dialog's import
// lists (they need a Companion export) and Home's Presses sheet.

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "su-command-wording-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

import { eventually, installRenderDom, settle } from "../../test-dom.js";
const teardown = installRenderDom();

const { automationRoutes } = await import("../../../main/services/routes/automation-routes.js");
const { cueRoutes } = await import("../../../main/services/routes/cue-routes.js");
const { viewRoutes } = await import("../../../main/services/routes/view-routes.js");
const { stateRoutes } = await import("../../../main/services/routes/state-routes.js");
const { callRoute } = await import("../../../main/services/routes/route-harness.js");
const { automationEngine } = await import("../../../main/services/automation-engine.js");
const { stageController } = await import("../../../main/services/stage-controller.js");
const { installRealRoutesFetch } = await import("../../test-fixtures/real-routes-fetch.js");

installRealRoutesFetch(
  [
    { prefix: "/api/automation/", handler: automationRoutes },
    { prefix: "/api/cues", handler: cueRoutes },
    { prefix: "/api/views", handler: viewRoutes },
    { prefix: "/api/state", handler: stateRoutes },
  ],
  callRoute,
);

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { AutomationSection } = await import("./automation-section.js");
const { ButtonInspector } = await import("../../editor/button-inspector.js");
const { manifest } = await import("../../test-fixtures/button-server.js");

type View = import("../../../main/types/views.js").View;
const ctl = stageController as unknown as { state: { views: View[] }; broadcast: () => void; recomputeResolved: () => void };
ctl.broadcast = () => {};
ctl.recomputeResolved = () => {};

/** Exact strings allowed to say cue. Empty on purpose; see the header. */
const ALLOWED: readonly string[] = [];

const CUE = /\bcues?\b/i;

/** Everything an operator can read or hear on the page: text and the attributes a screen reader or a tooltip says. */
function visible(): string[] {
  const out: string[] = [];
  const text = document.body.textContent ?? "";
  out.push(...text.split(/\s{2,}|\n/).map((s) => s.trim()).filter(Boolean));
  for (const el of document.body.querySelectorAll("*")) {
    for (const a of ["aria-label", "title", "placeholder", "alt", "aria-description"]) {
      const v = el.getAttribute(a);
      if (v) out.push(v);
    }
  }
  return out;
}

function assertNoCue(where: string): void {
  const found = visible().filter((s) => CUE.test(s) && !ALLOWED.includes(s));
  assert.deepEqual(found, [], `"cue" is on screen in ${where}`);
}

let client: InstanceType<typeof QueryClient> | null = null;
const client_ = () => (client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));

async function mountTab(tab: "commands" | "access") {
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client: client_() },
      React.createElement(TooltipProvider, null, React.createElement(AutomationSection, { tab })),
    ),
  );
  await settle();
  await settle();
  await settle();
  return view;
}

async function press(el: Element | null | undefined, what: string) {
  assert.ok(el, `nothing to press: ${what}`);
  await act(async () => {
    fireEvent.click(el as HTMLElement);
  });
  await settle();
  await settle();
}
const button = (text: string): HTMLButtonElement | null =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;

before(async () => {
  await automationEngine.init();
});
after(async () => {
  cleanup();
  client?.clear();
  await settle();
  teardown();
  await fs.rm(TMP, { recursive: true, force: true });
});
beforeEach(async () => {
  for (const r of automationEngine.listRules()) await automationEngine.removeRule(r.id);
  ctl.state = { ...ctl.state, views: [] };
  await automationEngine.addRule({
    name: "Stage reset",
    enabled: true,
    trigger: { id: "call.by-name", params: { name: "stage_reset", aliases: "old_reset", says: "reset the stage" } },
    conditions: [],
    action: { id: "log.message", params: { message: "x" } },
    cooldownSec: 2,
    oncePerService: false,
  });
});
afterEach(async () => {
  cleanup();
  client?.clear();
  await settle();
});

describe("no cue on screen", () => {
  test("the Commands tab", async () => {
    await mountTab("commands");
    assert.ok(document.querySelector('[data-rule-name="Stage reset"]'), "the command did not render, so the check saw nothing");
    assertNoCue("the Commands tab");
  });

  test("the Access tab", async () => {
    await mountTab("access");
    assert.ok(visible().some((s) => /Calling commands/.test(s)), "the Access tab did not render its card");
    assertNoCue("the Access tab");
  });

  test("a command's editor, and the registry labels in it", async () => {
    await mountTab("commands");
    await press(document.querySelector('[data-rule-name="Stage reset"]')?.closest("button"), "the command's row");
    assert.ok(document.querySelector("[data-rule-editor]"), "the editor did not open");
    assert.ok(visible().some((s) => /Command name/.test(s)), "the editor did not show the trigger's name field");
    assertNoCue("a command's editor");
  });

  test("the New command dialog: Kind, then every step to Review", async () => {
    await mountTab("commands");
    await press(button("New command"), "New command");
    assert.ok(document.querySelector("[data-new-cue]"), "the dialog did not open");
    assertNoCue("the New command dialog's first step");
    // The dialog opens past Kind, so Kind's own heading, help and choices are only
    // on screen when its stepper entry is pressed.
    await press(document.querySelector('[data-step="kind"]'), "the Kind step");
    assert.equal(document.querySelector("[data-step-body]")?.getAttribute("data-step-body"), "kind", "the Kind step did not open");
    assertNoCue("the New command dialog's Kind step");
    await press(document.querySelector('[data-kind="manual"]'), "Manual command");
    await press(button("Next"), "Next past Kind");
    // An action with one required field, then Next to the end: each step has its own heading and help.
    for (const h of [...document.querySelectorAll("[data-picker-group]")]) {
      if (document.querySelector('[data-picker-option="log.message"]')) break;
      await press(h, "a picker heading");
    }
    await press(document.querySelector('[data-picker-option="log.message"]'), "log.message");
    assertNoCue("the New command dialog's action step");
    const message = [...document.querySelectorAll("label")].find((l) => (l.textContent ?? "").startsWith("Message"))?.querySelector("input");
    assert.ok(message, "no Message field");
    await act(async () => {
      fireEvent.change(message as HTMLInputElement, { target: { value: "hello" } });
    });
    await settle();
    let reached = "";
    for (let i = 0; i < 8; i++) {
      const next = button("Next") ?? button("Skip");
      if (!next || next.disabled) break;
      await press(next, "Next");
      reached = document.querySelector("[data-step-heading]")?.textContent ?? "";
      assertNoCue(`the New command dialog, step "${reached}"`);
    }
    assert.equal(reached, "Review", "the walk did not reach Review, so its rows were not read");
  });

  test("the Button inspector's A command pane", async () => {
    const qc = client_();
    const Harness = () =>
      React.createElement(ButtonInspector as never, {
        c: { type: "cue-button", cue: "stage_reset", showDevice: true },
        cues: manifest(),
        viewId: "booth",
        viewName: "Booth console",
        objectId: "o1",
        draftObjects: [],
        onConfig: () => {},
      });
    render(React.createElement(QueryClientProvider as never, { client: qc }, React.createElement(Harness)));
    await settle();
    const seg = [...document.querySelectorAll('[aria-label="Presses"] button')].find((b) => b.textContent === "A command");
    await press(seg, "A command");
    await eventually(() => assert.ok(document.querySelector("select, [role=combobox]"), "the command picker did not render"));
    assertNoCue("the Button inspector's A command pane");
  });
});
