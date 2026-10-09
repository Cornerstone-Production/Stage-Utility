// A screen shown by an output of a Mac output helper, from the click to the
// server and back to the card, through the real Screens route.
//
// screen-settings-panel.test.tsx drives the panel with injected callbacks and
// screen-device-output.test.tsx drives the strip with a prop, so neither sees the
// chain between them: the panel's control, the host's callback, the settings
// hook, api.ts's request, and the state that comes back to the card. A rotation
// that rendered and sent the wrong field, or a Format whose answer never reached
// the card's strip, stayed green in both. This mounts the route against a stub
// fetch standing in for the server, which applies a PATCH to its outputs the way
// the server does, and asserts on the requests AND on what the card then reads.
//
// Also here, because it is the same route: the name a Not set up yet output gets
// as a new screen, and the card's warning when its output is falling behind.
//
// Every id and name is invented. Layout (the dashed machine card, the warning's
// colours) is not asserted: jsdom loads no stylesheet, so those were checked in a
// browser.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";
import { ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

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

const { render, screen, cleanup, fireEvent, act, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet } = await import("@tanstack/react-router");
const { TooltipProvider, Toaster, ConfirmHost } = await import("../../components/ui/index.js");
const { DEFAULT_STAGE_STATE } = await import("../../main/test-render-ctx.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");
const { __resetDevicesForTests } = await import("./use-devices.js");
const { ScreensRoute } = await import("./screens-route.js");

type Output = import("@main/types/views").Output;
type View = import("@main/types/views").View;

const NOW = "2026-01-01T00:00:00.000Z";
const WALL: View = { id: "wall-a", name: "Lobby loop", kind: "custom", surface: "display", createdAt: NOW };

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => {
  cleanup();
  await settle();
  teardown();
});
afterEach(async () => {
  cleanup();
  fetchStub.restore();
  __resetReplayCacheForTests();
  __resetDevicesForTests();
  await settle();
});

const MAC = "02:aa:00:bb:11:cc";
const SDI = (n: number) => ({ kind: "decklink", name: `SDI ${n} · Card A`, port: `SDI ${n}`, modes: ["1080p59.94", "1080p50", "720p50"] });
const HDMI = { kind: "display", name: "HDMI 1 · Monitor", port: "HDMI 1" };

let fetchStub: ReturnType<typeof stubFetchWithLog>;
let outputs: Output[];
let bound: unknown[];
let seen: unknown[];
let health: unknown[];
/** Every write the page made, in order. */
let writes: { method: string; url: string; body: unknown }[];

beforeEach(() => {
  __resetDevicesForTests();
  outputs = [
    { id: "display-1", name: "Main stage left", viewId: "wall-a" },
    { id: "display-2", name: "Lobby", viewId: "wall-a" },
  ];
  bound = [
    { id: "m.sdi-1", outputId: "display-1", macs: [MAC], hostname: "booth-mini", ip: "192.0.2.40", output: SDI(1) },
    { id: "m.hdmi-1", outputId: "display-2", macs: [MAC], hostname: "booth-mini", ip: "192.0.2.40", output: HDMI, screen: { w: 1920, h: 1080 } },
  ];
  seen = [];
  health = [];
  writes = [];
  fetchStub = stubFetchWithLog((url, init) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (/^\/api\/(outputs|views|devices\/claim)/.test(url)) writes.push({ method, url, body });
      // What the server does with a PATCH: it keeps the field, and answers with
      // the state. The card then reads it from there.
      const patched = url.match(/^\/api\/outputs\/([^/]+)$/);
      if (method === "PATCH" && patched && body) {
        outputs = outputs.map((o) => (o.id === patched[1] ? { ...o, ...body } : o));
      }
      return ok(state());
    }
    if (url === "/api/state") return ok(state());
    if (url === "/api/messages") return ok({ rev: 1, groups: [], messages: [], alerts: [] });
    if (url.startsWith("/api/devices")) return ok({ scanning: false, seen, matches: {}, bound, health });
    if (url === "/api/layout-templates" || url === "/api/presets" || url === "/api/integrations/wireless/channels") return ok([]);
    return ok({});
  });
});

const state = () => ({ ...DEFAULT_STAGE_STATE, outputs, views: [WALL] });

async function mountScreens() {
  const root = createRootRoute({ component: () => React.createElement(Outlet) });
  const screens = createRoute({ getParentRoute: () => root, path: "/screens", component: ScreensRoute });
  const messages = createRoute({ getParentRoute: () => root, path: "/settings/messages", component: () => React.createElement("p", null, "Messages settings") });
  const router = createRouter({
    routeTree: root.addChildren([screens, messages]),
    history: createMemoryHistory({ initialEntries: ["/screens"] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(RouterProvider, { router }), React.createElement(Toaster), React.createElement(ConfirmHost)),
    ),
  );
  await act(async () => {
    await settle();
    await settle();
    await settle();
  });
}

const click = async (el: Element) => {
  await act(async () => {
    fireEvent.click(el);
    await settle();
    await settle();
  });
};
const choose = async (el: Element, value: string) => {
  await act(async () => {
    fireEvent.change(el, { target: { value } });
    await settle();
    await settle();
  });
};

/** Open this screen's menu, then its Screen settings panel. */
async function openSettings(screenName: string): Promise<void> {
  const trigger = screen.getByLabelText(`More actions for ${screenName}`);
  await act(async () => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await settle();
  });
  const item = screen.getByRole("menuitem", { name: "Screen settings…" });
  await act(async () => {
    fireEvent.pointerDown(item, { button: 0, ctrlKey: false });
    fireEvent.pointerUp(item, { button: 0, ctrlKey: false });
    fireEvent.click(item);
    await settle();
  });
}

const panel = () => within(screen.getByRole("complementary", { name: "Screen settings" }));
const rotation = () => within(panel().getByRole("group", { name: "Rotation" }));

describe("Rotation and Format, from the panel to the card", () => {
  test("a rotation PATCHes THAT screen's rotation, and nothing else", async () => {
    await mountScreens();
    await openSettings("Main stage left");
    await click(rotation().getByRole("button", { name: "90°" }));
    assert.deepEqual(writes, [{ method: "PATCH", url: "/api/outputs/display-1", body: { rotation: 90 } }]);
  });

  test("a display screen is rotated the same way, and offers no Format", async () => {
    await mountScreens();
    await openSettings("Lobby");
    assert.equal(panel().queryByRole("combobox", { name: "Format" }) !== null, false, "a display offers a video mode");
    await click(rotation().getByRole("button", { name: "180°" }));
    assert.deepEqual(writes, [{ method: "PATCH", url: "/api/outputs/display-2", body: { rotation: 180 } }]);
  });

  test("a Format PATCHes videoMode, and the card's strip then reads that mode", async () => {
    await mountScreens();
    assert.ok(screen.getByText("booth-mini · SDI 1 · 1080p59.94"), "the strip does not start on the house mode");
    await openSettings("Main stage left");
    await choose(panel().getByRole("combobox", { name: "Format" }), "720p50");
    assert.deepEqual(writes, [{ method: "PATCH", url: "/api/outputs/display-1", body: { videoMode: "720p50" } }]);
    assert.ok(screen.getByText("booth-mini · SDI 1 · 720p50"), "the card's strip never read the mode the server kept");
  });

  test("a display's strip reads the size, with no video mode in it", async () => {
    await mountScreens();
    assert.ok(screen.getByText("booth-mini · HDMI 1 · 1920 × 1080"));
  });
});

describe("a Not set up yet output, set up as a new screen", () => {
  beforeEach(() => {
    seen = [{ id: "n.sdi-2", macs: [MAC.replace("cc", "dd")], hostname: "spare-mini", os: "macOS 26", ip: "192.0.2.41", firstSeen: 1, lastSeen: 2, output: SDI(2) }];
  });

  test("is named for the output, not for the Mac it shares with its siblings", async () => {
    await mountScreens();
    await click(await screen.findByRole("button", { name: "Set up as a new screen" }));
    await click(panel().getByRole("button", { name: "Next" }));
    await click(panel().getByRole("button", { name: "Next" }));
    assert.equal((panel().getByLabelText("Name") as HTMLInputElement).value, "SDI 2 · Card A");
    await click(panel().getByRole("button", { name: "Create screen" }));
    const claims = writes.filter((w) => w.url === "/api/devices/claim");
    assert.deepEqual(claims, [{
      method: "POST",
      url: "/api/devices/claim",
      body: { deviceId: "n.sdi-2", outputId: null, name: "SDI 2 · Card A", mode: "display" },
    }]);
  });
});

describe("an output falling behind", () => {
  const report = (over: Record<string, unknown>) => ({ deviceId: "m.sdi-1", fps: 59.94, repeated: 12.4, dropped: 41, at: 1, receivedAt: 2, struggling: true, ...over });

  test("puts a warning on ITS screen's card, naming the port, what the report shows and what to check", async () => {
    health = [report({})];
    await mountScreens();
    const box = await screen.findByText(/Struggling on SDI 1\./);
    assert.equal(
      box.parentElement?.textContent,
      "Struggling on SDI 1. 12% of its frames repeated because the page ran late. The card has dropped 41 frames since the output opened. Check the Mac's load and how much this screen's view draws.",
    );
    assert.equal(screen.getAllByText(/Struggling on/).length, 1, "the other screen's card has one too");
  });

  test("says nothing for an output that is keeping up", async () => {
    health = [report({ struggling: false })];
    await mountScreens();
    await screen.findByText("booth-mini · SDI 1 · 1080p59.94");
    assert.equal(screen.queryByText(/Struggling on/) !== null, false, "a healthy output was called struggling");
  });
});
