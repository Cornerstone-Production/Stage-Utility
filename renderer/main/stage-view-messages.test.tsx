// Stage messages on a kiosk screen, driven through the real StageView.
//
// What a Messages widget follows is the screen it is drawn ON, and the only
// thing that can say so is StageView handing the resolved output's id and groups
// down through the layout renderer. A unit test of the widget cannot see that
// hand-off (it is given its groups); this one can, so the plumbing is asserted
// here: a real screen follows its own groups, and a Screens-card preview — a
// picture of a screen, not one — follows none.
//
// Driven the way stage-view-paths.test.tsx drives StageView: a stubbed `fetch`
// feeding the real hooks, and the real location. How it LOOKS is not asserted
// (jsdom loads no stylesheet); it was compared to the mockup in a browser.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";
import { EVERYONE, type MessagesState, type StageMessage } from "@main/types/messages";

const teardown = installDom();

class StubEventSource {
  static readonly CONNECTING = 0;
  readyState = 0;
  onmessage: unknown = null;
  onerror: unknown = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

let stateBody: unknown = null;
let messagesBody: MessagesState | null = null;
const posted: { url: string; body: unknown }[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (init?.method === "POST") posted.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
  if (url === "/api/state") return { ok: true, status: 200, json: async () => stateBody, text: async () => "" };
  if (url === "/api/messages") return { ok: true, status: 200, json: async () => messagesBody, text: async () => "" };
  return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
};

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { render, cleanup, act, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { StageView } = await import("./stage-view.js");
const { __resetForTests } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests } = await import("../lib/api.js");
const { TooltipProvider } = await import("../components/ui/tooltip-provider.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => {
  cleanup();
  await settle();
  teardown();
});
beforeEach(() => {
  cleanup();
  __resetForTests();
  __resetReplayCacheForTests();
  posted.length = 0;
});
afterEach(async () => {
  cleanup();
  await settle();
});

// ---- fixtures ---------------------------------------------------------------

const GREEN = "g-00000001";
const STAGE = "g-00000002";
const GROUPS = [
  { id: GREEN, name: "Green room" },
  { id: STAGE, name: "Stage" },
];

function message(n: number, to: string[], text: string): StageMessage {
  return {
    id: n.toString(16).padStart(16, "0"),
    at: Date.now() - 60_000,
    to,
    text,
    alert: false,
    alertUntil: null,
    clearedAt: null,
    from: "Producer console",
    replies: [],
  };
}

function messagesState(messages: StageMessage[]): MessagesState {
  return { rev: 1, groups: GROUPS, quickMessages: [], quickReplies: ["Copy"], messages, alerts: [] };
}

/** A display routed to one custom view holding one widget. */
function stageState(widget: Record<string, unknown>, over: { groups?: string[]; mode?: string; blackout?: boolean } = {}) {
  return {
    serviceTypeName: "Weekend", planTitle: "A plan", planSeriesTitle: null, planDates: null,
    showQr: false, remoteUrl: null, appName: "Stage Utility", appLogo: null,
    appLogoMonochrome: false, emptySlotLogo: null, defaultAvatar: null,
    pcoConfigured: true, hourCycle: "12h", accentColor: null,
    views: [{
      id: "v1", name: "Wall", kind: "custom",
      layout: {
        canvas: { width: 1920, height: 1080, background: null },
        objects: [{ id: "w1", x: 0, y: 0, w: 1, h: 1, z: 0, config: widget }],
      },
    }],
    outputs: [{ id: "display-1", name: "Stage left", viewId: "v1", groups: over.groups ?? [], ...(over.mode ? { mode: over.mode } : {}) }],
    resolvedByOutput: {
      "display-1": {
        viewId: "v1", kind: "custom", ndiSource: null, viewName: "Wall",
        blackout: over.blackout ?? false, locked: false, hideTopBar: false, allowHls: true,
        groups: over.groups ?? [], textSize: null,
      },
    },
    slotsByView: {}, slotsByLayoutObject: {}, notesByObject: {},
    barItems: [], savedColors: [], captionChannelColors: {},
    allowedServiceTypeIds: [], checklistNoteCategories: [], checklistNoteTeams: [],
  };
}

async function showScreen(path: string, state: unknown): Promise<HTMLElement> {
  window.history.replaceState({}, "", path);
  stateBody = state;
  __resetForTests();
  let container!: HTMLElement;
  await act(async () => {
    container = render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(TooltipProvider, null, React.createElement(StageView)),
      ),
    ).container;
    await settle();
    await settle();
  });
  return container;
}

const says = (c: HTMLElement, text: string) => (c.textContent ?? "").includes(text);

// ---- the Messages widget follows the screen it is on ------------------------

describe("a Messages widget follows the screen StageView says it is", () => {
  const widget = { type: "messages" };

  test("a real screen shows the messages for its own groups, and not another group's", async () => {
    messagesBody = messagesState([
      message(1, [GREEN], "for the green room"),
      message(2, [STAGE], "for the stage"),
      message(3, [EVERYONE], "for everyone"),
    ]);
    const c = await showScreen("/display-1", stageState(widget, { groups: [GREEN] }));
    assert.ok(says(c, "for the green room"), c.textContent ?? "");
    assert.ok(says(c, "for everyone"), c.textContent ?? "");
    assert.ok(!says(c, "for the stage"), "drew a message sent to a group this screen is not in");
  });

  test("a Screens-card preview is no screen, so it follows no group", async () => {
    // The same view, previewed standing in for the SAME screen: it must not take
    // that screen's groups. It would otherwise draw (and, on a panel, answer for)
    // messages the Screens page has no business answering.
    messagesBody = messagesState([message(1, [GREEN], "for the green room")]);
    const c = await showScreen("/preview-v1?output=display-1", stageState(widget, { groups: [GREEN] }));
    assert.ok(says(c, "Messages"), "the widget drew nothing at all");
    assert.ok(!says(c, "for the green room"), "a preview drew a screen's messages");
    assert.ok(!says(c, "No messages"), "a preview claimed no messages for groups it has none of");
  });

  test("its own groups override the screen's", async () => {
    messagesBody = messagesState([message(1, [GREEN], "for the green room"), message(2, [STAGE], "for the stage")]);
    const c = await showScreen("/display-1", stageState({ type: "messages", groups: [STAGE] }, { groups: [GREEN] }));
    assert.ok(says(c, "for the stage") && !says(c, "for the green room"), c.textContent ?? "");
  });
});

// ---- the composer signs as the screen it is on --------------------------------

describe("a Message composer on a screen", () => {
  const composer = { type: "message-composer" };
  const press = (el: Element | undefined) => act(async () => { fireEvent.click(el!); });
  const named = (c: HTMLElement, name: string) => [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);

  async function sendFrom(path: string, state: unknown): Promise<HTMLElement> {
    messagesBody = { ...messagesState([]), quickMessages: ["Walk now"] };
    const c = await showScreen(path, state);
    await press(named(c, "Green room"));
    await press(named(c, "Walk now"));
    await press(named(c, "Send"));
    return c;
  }

  test("a panel sends as the screen's own name", async () => {
    await sendFrom("/display-1", stageState(composer, { groups: [GREEN], mode: "panel" }));
    const sent = posted.filter((p) => p.url === "/api/messages");
    assert.equal(sent.length, 1, "the press did not reach the server");
    assert.deepEqual(sent[0].body, { to: [GREEN], text: "Walk now", alert: false, from: "Stage left" });
  });

  test("a display (the default mode) draws it and cannot send", async () => {
    await sendFrom("/display-1", stageState(composer, { groups: [GREEN] }));
    assert.equal(posted.filter((p) => p.url === "/api/messages").length, 0, "a wall display sent a message");
  });

  test("a Screens-card preview of a panel cannot send either", async () => {
    await sendFrom("/preview-v1?output=display-1", stageState(composer, { groups: [GREEN], mode: "panel" }));
    assert.equal(posted.filter((p) => p.url === "/api/messages").length, 0, "the Screens page sent a message by being looked at");
  });
});
