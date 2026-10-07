// A screen's message groups on the Screens card: the chips under its name, and
// the Groups submenu in its overflow menu.
//
// Driven through the real card with real events on the real trigger. A test
// over the helper alone would pass while the menu offered nothing: this file
// exists because a control that renders is not a control that does anything.
// What the card must send is the WHOLE new list in the config's order, which is
// what the server stores; a click that sent only the clicked id would turn a
// screen in three groups into a screen in one.
//
// Every id and name below is INVENTED. This is a public repository.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

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

(globalThis as unknown as { fetch: unknown }).fetch = async () => {
  const payload = { scanning: false, seen: [], matches: {}, bound: [], error: null };
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
};

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { OutputRow } = await import("./outputs-section.js");
type OutputRowProps = import("./outputs-section.js").OutputRowProps;
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => { await settle(); teardown(); });
beforeEach(() => { cleanup(); });
afterEach(async () => { cleanup(); await settle(); });

const noop = () => {};
const asyncNoop = async () => {};

const GREEN = { id: "g-11111111", name: "Green room" };
const STAGE = { id: "g-22222222", name: "Stage" };
const BOOTH = { id: "g-33333333", name: "Booth" };
const ALL = [GREEN, STAGE, BOOTH];

function card(over: {
  groups?: string[];
  messageGroups?: OutputRowProps["messageGroups"];
  onSetGroups?: (ids: string[]) => void;
  onOpenMessagingSettings?: () => void;
}) {
  const props: OutputRowProps = {
    output: { id: "display-1", name: "Stage left", viewId: null, ...(over.groups ? { groups: over.groups } : {}) },
    views: [],
    baseUrl: "http://display.invalid",
    online: false,
    struggles: [],
    canRemove: true,
    iconKey: "display-1",
    onRename: noop,
    onSetSlug: asyncNoop,
    onSetView: noop,
    onRenameView: noop,
    onSetLocked: noop,
    onSetHideTopBar: noop,
    onSetAllowHls: noop,
    messageGroups: over.messageGroups ?? { groups: ALL, known: true, failed: false },
    onSetGroups: over.onSetGroups ?? noop,
    onOpenMessagingSettings: over.onOpenMessagingSettings,
    onSetMode: asyncNoop,
    onRefresh: noop,
    onRemove: noop,
    onRequestNewView: noop,
  };
  render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(TooltipProvider, null, React.createElement(OutputRow, props)),
    ),
  );
}

/** Open the overflow menu, then the Groups submenu. */
async function openGroups(): Promise<void> {
  const trigger = screen.getByLabelText(/more actions/i);
  await act(async () => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await settle();
  });
  const sub = screen.getByText("Groups");
  await act(async () => {
    fireEvent.keyDown(sub, { key: "ArrowRight" });
    await settle();
  });
}

const chips = () => [...document.querySelectorAll('[data-testid="screen-groups"] li')].map((li) => li.textContent);

describe("the chips under a screen's name", () => {
  test("name the groups it is in, in the config's order, not the order stored", () => {
    card({ groups: [BOOTH.id, GREEN.id] });
    assert.deepEqual(chips(), ["Green room", "Booth"]);
  });

  test("a screen in no group draws none", () => {
    card({});
    assert.equal(document.querySelector('[data-testid="screen-groups"]'), null);
  });

  test("an id the config no longer holds names nothing and draws nothing", () => {
    card({ groups: [STAGE.id, "g-99999999"] });
    assert.deepEqual(chips(), ["Stage"]);
  });

  test("draw nothing before the groups have been read, rather than a raw id", () => {
    card({ groups: [STAGE.id], messageGroups: { groups: [], known: false, failed: false } });
    assert.equal(document.querySelector('[data-testid="screen-groups"]'), null);
  });
});

describe("the Groups submenu", () => {
  test("has one checkbox per group, checked for the ones this screen is in", async () => {
    card({ groups: [STAGE.id] });
    await openGroups();
    const boxes = screen.getAllByRole("menuitemcheckbox").filter((b) => ALL.some((g) => b.textContent === g.name));
    assert.deepEqual(
      boxes.map((b) => [b.textContent, b.getAttribute("aria-checked")]),
      [["Green room", "false"], ["Stage", "true"], ["Booth", "false"]],
    );
  });

  test("ticking a group sends the whole new list, in the config's order", async () => {
    const sent: string[][] = [];
    card({ groups: [BOOTH.id], onSetGroups: (ids) => sent.push(ids) });
    await openGroups();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Green room" }));
      await settle();
    });
    assert.deepEqual(sent, [[GREEN.id, BOOTH.id]]);
  });

  test("unticking removes only that group", async () => {
    const sent: string[][] = [];
    card({ groups: [GREEN.id, STAGE.id, BOOTH.id], onSetGroups: (ids) => sent.push(ids) });
    await openGroups();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Stage" }));
      await settle();
    });
    assert.deepEqual(sent, [[GREEN.id, BOOTH.id]]);
  });

  test("a stored id the config no longer holds is not sent back", async () => {
    const sent: string[][] = [];
    card({ groups: [STAGE.id, "g-99999999"], onSetGroups: (ids) => sent.push(ids) });
    await openGroups();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Booth" }));
      await settle();
    });
    assert.deepEqual(sent, [[STAGE.id, BOOTH.id]], "the server refuses an id it does not know, so one in the list would fail every later click");
  });

  test("with no groups it says so and links to Settings -> Messages", async () => {
    let opened = 0;
    card({ messageGroups: { groups: [], known: true, failed: false }, onOpenMessagingSettings: () => { opened++; } });
    await openGroups();
    const item = screen.getByText(/No groups yet/);
    await act(async () => {
      fireEvent.click(item);
      await settle();
    });
    assert.equal(opened, 1);
  });

  test("while the groups are unread it does not claim there are none", async () => {
    card({ messageGroups: { groups: [], known: false, failed: false } });
    await openGroups();
    assert.ok(screen.getByText("Loading groups..."));
    assert.equal(screen.queryByText(/No groups yet/), null);
  });

  test("when the read failed it says so rather than claiming there are none", async () => {
    card({ messageGroups: { groups: [], known: true, failed: true } });
    await openGroups();
    assert.ok(screen.getByText("Couldn't load the groups."));
    assert.equal(screen.queryByText(/No groups yet/), null);
  });
});
