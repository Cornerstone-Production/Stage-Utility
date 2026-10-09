// A screen's message groups on the Screens card: the chips under its name.
//
// Choosing the groups moved from a submenu of the card's overflow menu into the
// Screen settings panel (screen-settings-panel.test.tsx, "the message groups"),
// where the whole new list is sent in the config's order. The card keeps only the
// chips, which are context for the screen and not something to work from.
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

const { render, cleanup } = await import("@testing-library/react");
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
}) {
  const props: OutputRowProps = {
    output: { id: "display-1", name: "Stage left", viewId: null, ...(over.groups ? { groups: over.groups } : {}) },
    views: [],
    baseUrl: "http://display.invalid",
    online: false,
    struggles: [],
    lags: [],
    canRemove: true,
    iconKey: "display-1",
    onRename: noop,
    onSetView: noop,
    onRenameView: noop,
    messageGroups: over.messageGroups ?? { groups: ALL, known: true, failed: false },
    onSetMode: asyncNoop,
    onOpenSettings: noop,
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
