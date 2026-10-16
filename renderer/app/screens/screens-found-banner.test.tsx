// The Screens page, through the real route: where its content sits, and the
// banner that names screens found on the network that are not set up.
//
// Driven the way screens-panel-wiring.test.tsx drives the page: the real route,
// the real stage-settings hook and the real api.ts, against a stub fetch standing
// in for the server.
//
// Every id and name below is INVENTED. This is a public repository.
//
// NOT covered here, driven in a browser instead: that "Not set up yet" actually
// sits directly under the buttons below the cards (jsdom loads no stylesheet, so
// the padding classes are asserted, not the pixels they make), the banner's
// pulse and the card's highlight ring, where the page scrolls to, and the
// sidebar count's position in an expanded and a collapsed rail.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eventually, installRenderDom } from "../../test-dom.js";
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

const { render, screen, cleanup, act, fireEvent, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { RouterProvider, createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet } = await import("@tanstack/react-router");
const { TooltipProvider, Toaster, ConfirmHost } = await import("../../components/ui/index.js");
const { DEFAULT_STAGE_STATE } = await import("../../main/test-render-ctx.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");
const { __resetDevicesForTests, refreshDevices } = await import("./use-devices.js");
const { DISMISSED_KEY, __resetDismissedForTests } = await import("./dismissed-found.js");
const { NOT_SET_UP_ID } = await import("./not-set-up.js");
const { ScreensRoute } = await import("./screens-route.js");
const { PageActionsProvider, PageActionsSlot } = await import("../page-actions.js");

type SeenDevice = import("@main/types/kiosk").SeenDevice;
type Output = import("@main/types/views").Output;

const NOW = "2026-01-01T00:00:00.000Z";
const settle = () => new Promise((r) => setTimeout(r, 0));

const PI: SeenDevice = { id: "kiosk-aaaa", macs: [], hostname: "lobby-pi", os: "Linux", ip: "192.0.2.10", firstSeen: 1, lastSeen: 2 };
const SDI: SeenDevice = {
  id: "mac-1.sdi-1", macs: [], hostname: "booth-mini", os: "macOS", ip: "192.0.2.20", firstSeen: 1, lastSeen: 2,
  output: { kind: "decklink", name: "SDI 1 · Card A", port: "SDI 1" },
};
const SCREEN2: SeenDevice = { id: "kiosk-bbbb", macs: [], hostname: "green-room-pi", os: "Linux", ip: "192.0.2.11", firstSeen: 1, lastSeen: 2 };

let fetchStub: ReturnType<typeof stubFetchWithLog>;
/** What the server says it has heard and is not set up here. */
let seen: SeenDevice[];
let bound: unknown[];
let outputs: Output[];
/** The claims the page made, in order. */
let claims: unknown[];

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
  __resetDismissedForTests();
  await settle();
});
beforeEach(() => {
  seen = [];
  bound = [];
  outputs = [{ id: "display-1", name: "Booth panel", viewId: "wall-a" }];
  claims = [];
  localStorage.clear();
  __resetDismissedForTests();
  fetchStub = stubFetchWithLog((url, init) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && url === "/api/devices/claim") {
      // The server makes the screen, binds the device and stops listing it.
      const body = JSON.parse(String(init?.body)) as { deviceId: string; name?: string };
      claims.push(body);
      const id = `display-${outputs.length + 10}`;
      outputs = [...outputs, { id, name: body.name ?? id, viewId: null }];
      bound = [...bound, { id: body.deviceId, outputId: id, macs: [], hostname: "lobby-pi" }];
      seen = seen.filter((d) => d.id !== body.deviceId);
      return ok({ ok: true, displaced: null, outputId: id });
    }
    if (method !== "GET") return ok({ ...DEFAULT_STAGE_STATE });
    if (url === "/api/state") {
      return ok({
        ...DEFAULT_STAGE_STATE,
        outputs,
        views: [{ id: "wall-a", name: "Lobby loop", kind: "custom", surface: "display", createdAt: NOW }],
      });
    }
    if (url === "/api/messages") return ok({ rev: 1, groups: [], messages: [], alerts: [] });
    if (url.startsWith("/api/devices")) return ok({ scanning: true, seen, matches: {}, bound, error: null });
    if (url === "/api/layout-templates" || url === "/api/presets" || url === "/api/integrations/wireless/channels") return ok([]);
    return ok({});
  });
});

async function mountScreens() {
  const root = createRootRoute({ component: () => React.createElement(Outlet) });
  const screens = createRoute({ getParentRoute: () => root, path: "/screens", component: ScreensRoute });
  const elsewhere = createRoute({ getParentRoute: () => root, path: "/elsewhere", component: () => React.createElement("p", null, "Another page") });
  const router = createRouter({
    routeTree: root.addChildren([screens, elsewhere]),
    history: createMemoryHistory({ initialEntries: ["/screens"] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(PageActionsProvider, null, React.createElement(PageActionsSlot), React.createElement(RouterProvider, { router })),
        React.createElement(Toaster),
        React.createElement(ConfirmHost),
      ),
    ),
  );
  await act(async () => {
    await settle();
    await settle();
    await settle();
  });
  await eventually(() => assert.ok(screen.getByRole("button", { name: "Settings" }), "the page never drew"));
  return router;
}

const banner = () => screen.queryByRole("region", { name: "Screens found" });
const inBanner = () => within(banner()!);
const panel = () => within(screen.getByRole("complementary", { name: "Settings" }));
/** The listing changed on the server and the page was told (the kiosk:devices event does this). */
async function serverNowHears(next: SeenDevice[], nowBound: unknown[] = bound): Promise<void> {
  seen = next;
  bound = nowBound;
  await act(async () => {
    await refreshDevices();
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
const stored = () => localStorage.getItem(DISMISSED_KEY);
/** The ids in storage, whatever shape they are kept in. */
const storedIds = (): string[] => Object.keys(JSON.parse(stored() ?? "{}") as Record<string, number>);

describe("the gap under the cards", () => {
  test("the page carries its scroll runway once, on the route, not again inside the cards' section", async () => {
    await mountScreens();
    const withRunway = [...document.querySelectorAll("[class]")].filter((el) => el.classList.contains("pb-[50vh]"));
    assert.equal(
      withRunway.length,
      1,
      `${withRunway.length} elements carry pb-[50vh]: ${withRunway.map((e) => e.getAttribute("data-flash-id") ?? e.className).join(" | ")}`,
    );
    const section = document.querySelector('[data-flash-id="displays-list"]');
    assert.ok(section, "the cards' section never drew");
    assert.equal(section.classList.contains("pb-[50vh]"), false, "half a screen of padding sits under the cards again");
    assert.ok(withRunway[0].contains(section), "the runway is not around the cards: the page would end at its last row");
  });
});

describe("the found-screens banner", () => {
  test("names one screen found, with what it is and where", async () => {
    seen = [PI];
    await mountScreens();
    await eventually(() => assert.ok(banner(), "no banner for a screen that is not set up"));
    assert.ok(inBanner().getByText("A screen was found that is not set up"));
    assert.ok(inBanner().getByText("lobby-pi"));
    assert.equal(inBanner().getByText(/^Display on lobby-pi/).textContent, "Display on lobby-pi 192.0.2.10");
  });

  test("names several, one row each, an output by its own name and kind", async () => {
    seen = [PI, SDI];
    await mountScreens();
    await eventually(() => assert.ok(inBanner().getByText("2 screens were found that are not set up")));
    assert.equal(inBanner().getAllByRole("listitem").length, 2);
    assert.ok(inBanner().getByText("SDI 1 · Card A"));
    assert.equal(inBanner().getByText(/^Video output on booth-mini/).textContent, "Video output on booth-mini 192.0.2.20");
  });

  test("sits between the hint and the cards", async () => {
    seen = [PI];
    await mountScreens();
    await eventually(() => assert.ok(banner()));
    const hint = screen.getByText(/^Each one is a physical screen at its own address/);
    const firstCard = screen.getByLabelText("Display name");
    assert.ok(hint.compareDocumentPosition(banner()!) & Node.DOCUMENT_POSITION_FOLLOWING, "the banner is above the hint");
    assert.ok(banner()!.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING, "the banner is below the cards");
  });

  test("there is no banner when nothing is waiting, and the section says nothing new is on the network", async () => {
    await mountScreens();
    await eventually(() => assert.ok(screen.getByText(/^Nothing new on the network/)));
    assert.ok(banner() === null);
  });

  test("a device set up on another server is under Not set up yet, not in the banner", async () => {
    seen = [{ ...PI, boundTo: "srv-other", unreachable: true }];
    await mountScreens();
    await eventually(() => assert.ok(screen.getByText(/Set up on another server, which it cannot reach\./)));
    assert.ok(banner() === null, "a screen that is set up elsewhere was announced as not set up");
  });

  // The banner's button and the section's must open the SAME panel for a device:
  // both hand the panel what panelDeviceOf makes of it. Compared by the panel's
  // whole text, so a field that one path filled and the other did not shows.
  for (const device of [PI, SDI]) {
    test(`Set up on ${device.output ? "an output" : "a device"} opens the panel the section's button does, and claims nothing`, async () => {
      seen = [device];
      await mountScreens();
      await eventually(() => assert.ok(banner()));
      const aside = () => screen.getByRole("complementary", { name: "Settings" });
      await click(inBanner().getByRole("button", { name: "Set up" }));
      assert.ok(panel().getByText("New screen · step 1 of 2"));
      const viaBanner = aside().textContent;
      const nameViaBanner = (panel().getByLabelText(/^Name/) as HTMLInputElement).value;
      assert.deepEqual(claims, [], "opening the panel claimed the device");

      await click(panel().getByRole("button", { name: "Close" }));
      const section = within(document.getElementById(NOT_SET_UP_ID)!);
      await click(section.getByRole("button", { name: "Set up as a new screen" }));
      assert.equal(aside().textContent, viaBanner, "the two buttons opened different panels");
      assert.equal((panel().getByLabelText(/^Name/) as HTMLInputElement).value, nameViaBanner);
      assert.deepEqual(claims, []);
    });
  }

  test("Set up on an output names the screen for the output", async () => {
    seen = [SDI];
    await mountScreens();
    await eventually(() => assert.ok(banner()));
    await click(inBanner().getByRole("button", { name: "Set up" }));
    assert.equal((panel().getByLabelText(/^Name/) as HTMLInputElement).value, "SDI 1 · Card A");
  });

  test("once the screen is made its card is outlined, and the device leaves the banner", async () => {
    seen = [PI];
    await mountScreens();
    await eventually(() => assert.ok(banner()));
    await click(inBanner().getByRole("button", { name: "Set up" }));
    await click(panel().getByRole("button", { name: "Next" }));
    await click(panel().getByRole("button", { name: "Create screen" }));
    const card = await eventually(() => {
      const el = document.querySelector('[data-flash-id="screen-display-11"]');
      assert.ok(el, "the new screen's card is not on the page");
      assert.ok(el.classList.contains("su-flash"), "the new screen's card was not outlined");
      return el;
    });
    assert.ok(card.textContent?.includes("lobby-pi"));
    await eventually(() => assert.ok(banner() === null, "a screen that was set up is still in the banner"));
  });

  test("See all below scrolls to Not set up yet", async () => {
    seen = [PI];
    const scrolled: string[] = [];
    const proto = Element.prototype as unknown as { scrollIntoView?: () => void };
    const had = Object.getOwnPropertyDescriptor(proto, "scrollIntoView");
    proto.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
    try {
      await mountScreens();
      await eventually(() => assert.ok(banner()));
      await click(inBanner().getByRole("button", { name: "See all below" }));
      assert.deepEqual(scrolled, [NOT_SET_UP_ID]);
    } finally {
      if (had) Object.defineProperty(proto, "scrollIntoView", had);
      else delete proto.scrollIntoView;
    }
  });
});

describe("dismissing", () => {
  test("hides that device from the banner, keeps it under Not set up yet, and is kept for next time", async () => {
    seen = [PI, SCREEN2];
    await mountScreens();
    await eventually(() => assert.ok(inBanner().getByText("2 screens were found that are not set up")));
    await click(inBanner().getAllByRole("button", { name: "Dismiss" })[0]);
    assert.ok(inBanner().getByText("A screen was found that is not set up"));
    assert.ok(inBanner().queryByText("lobby-pi") === null, "the dismissed device is still in the banner");
    assert.ok(inBanner().getByText("green-room-pi"));
    // Still where it can be set up.
    const section = within(document.getElementById(NOT_SET_UP_ID)!);
    assert.equal(section.getAllByRole("button", { name: "Set up as a new screen" }).length, 2);
    assert.deepEqual(storedIds(), [PI.id], "the dismissal was not kept");
    // A new visit to the page.
    cleanup();
    __resetDevicesForTests();
    __resetDismissedForTests(); // a new page load
    await mountScreens();
    await eventually(() => assert.ok(inBanner().getByText("A screen was found that is not set up")));
    assert.ok(inBanner().queryByText("lobby-pi") === null, "a dismissed device came back on the next visit");
  });

  /** The newest Undo on the page. By text: a role query over the whole page, with
   *  its accessible names worked out for every button, took four seconds here. A
   *  toast left open by an earlier test is still in the store, hence the last. */
  const undoButton = (): HTMLButtonElement => {
    const all = screen.getAllByText("Undo");
    const button = all[all.length - 1].closest("button");
    assert.ok(button, "Undo is not a button");
    return button;
  };

  test("a toast offers Undo, which puts it back in the banner and out of storage", async () => {
    seen = [PI];
    await mountScreens();
    await eventually(() => assert.ok(banner()));
    await click(inBanner().getByRole("button", { name: "Dismiss" }));
    assert.ok(banner() === null);
    assert.deepEqual(storedIds(), [PI.id]);
    const undo = await eventually(undoButton);
    assert.ok(screen.getAllByText(/^Dismissed lobby-pi\. It is still under Not set up yet\./).length >= 1);
    await click(undo);
    assert.ok(banner(), "Undo did not bring the banner back");
    assert.equal(stored(), null, "Undo left the dismissal in storage");
  });

  test("Undo works after the banner is gone: leave Screens, press it, come back, and the device is named", async () => {
    // The toast outlives the page that made it. An Undo that belonged to the
    // banner's own state did nothing here, and said nothing.
    seen = [PI];
    const router = await mountScreens();
    await eventually(() => assert.ok(banner()));
    await click(inBanner().getByRole("button", { name: "Dismiss" }));
    await act(async () => { await router.navigate({ to: "/elsewhere" as never }); await settle(); });
    await eventually(() => assert.ok(screen.getByText("Another page")));
    assert.ok(banner() === null);
    await click(await eventually(undoButton));
    assert.equal(stored(), null, "Undo with the banner unmounted left the dismissal in storage");
    __resetDevicesForTests();
    await act(async () => { await router.navigate({ to: "/screens" as never }); await settle(); await settle(); });
    await eventually(() => assert.ok(banner(), "the device is not named after Undo"));
  });

  test("Show dismissed brings every dismissed device back, and says how many are hidden", async () => {
    seen = [PI, SCREEN2];
    await mountScreens();
    await eventually(() => assert.ok(banner()));
    assert.ok(inBanner().queryByRole("button", { name: "Show dismissed" }) === null, "offered with nothing dismissed");
    await click(inBanner().getAllByRole("button", { name: "Dismiss" })[0]);
    assert.ok(inBanner().getByText(/1 more dismissed\./));
    await click(inBanner().getByRole("button", { name: "Show dismissed" }));
    assert.ok(inBanner().getByText("2 screens were found that are not set up"));
    assert.equal(stored(), null);
  });

  test("with every device dismissed there is no banner to carry Show dismissed, and the section still lists them", async () => {
    seen = [PI];
    await mountScreens();
    await eventually(() => assert.ok(banner()));
    await click(inBanner().getByRole("button", { name: "Dismiss" }));
    assert.ok(banner() === null);
    assert.ok(within(document.getElementById(NOT_SET_UP_ID)!).getByRole("button", { name: "Set up as a new screen" }));
  });

  test("a device that stops being listed leaves the banner by itself", async () => {
    seen = [PI, SCREEN2];
    await mountScreens();
    await eventually(() => assert.ok(inBanner().getByText("2 screens were found that are not set up")));
    await serverNowHears([SCREEN2]);
    assert.ok(inBanner().getByText("A screen was found that is not set up"));
    assert.ok(inBanner().queryByText("lobby-pi") === null);
    await serverNowHears([]);
    assert.ok(banner() === null);
  });

  test("a device that is set up (by another operator, say) leaves the banner, and its dismissal is forgotten", async () => {
    seen = [PI];
    await mountScreens();
    await eventually(() => assert.ok(banner()));
    await click(inBanner().getByRole("button", { name: "Dismiss" }));
    assert.deepEqual(storedIds(), [PI.id]);
    await serverNowHears([], [{ id: PI.id, outputId: "display-1", macs: [], hostname: "lobby-pi" }]);
    assert.equal(stored(), null, "a dismissal outlived the device being set up");
    // Released later, it is a new find.
    await serverNowHears([PI], []);
    assert.ok(banner(), "a released device was not named again");
  });

  test("storage that refuses writes: the device is hidden for the visit, and the toast says it will be back", async () => {
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    const realGet = proto.getItem;
    const realSet = proto.setItem;
    const realRemove = proto.removeItem;
    proto.getItem = () => { throw new Error("storage is off"); };
    proto.setItem = () => { throw new Error("storage is off"); };
    proto.removeItem = () => { throw new Error("storage is off"); };
    try {
      seen = [PI, SCREEN2];
      await mountScreens();
      await eventually(() => assert.ok(inBanner().getByText("2 screens were found that are not set up")));
      await click(inBanner().getAllByRole("button", { name: "Dismiss" })[0]);
      assert.ok(inBanner().getByText("A screen was found that is not set up"), "Dismiss did nothing without storage");
      const said = screen.getAllByText(/^Dismissed lobby-pi\./).map((e) => e.textContent ?? "");
      assert.ok(
        said.some((m) => /could not remember that, so it will be back after a reload/.test(m)),
        `a dismissal that was not kept was reported as kept: ${said.join(" | ")}`,
      );
      await click(undoButton());
      assert.ok(inBanner().getByText("2 screens were found that are not set up"), "Undo did not work without storage");
    } finally {
      proto.getItem = realGet;
      proto.setItem = realSet;
      proto.removeItem = realRemove;
    }
  });

  test("a dismissal that was kept is not reported as lost", async () => {
    seen = [PI];
    await mountScreens();
    await eventually(() => assert.ok(banner()));
    await click(inBanner().getByRole("button", { name: "Dismiss" }));
    const said = screen.getAllByText(/^Dismissed lobby-pi\./).map((e) => e.textContent ?? "");
    assert.ok(said.every((m) => !/could not remember/.test(m)), said.join(" | "));
  });

  test("two tabs agree: a dismissal made in another tab hides it here, and clearing storage brings it back", async () => {
    seen = [PI, SCREEN2];
    await mountScreens();
    await eventually(() => assert.ok(inBanner().getByText("2 screens were found that are not set up")));
    // Another tab wrote this; jsdom fires no storage event for it, as a browser
    // does for every OTHER document.
    localStorage.setItem(DISMISSED_KEY, JSON.stringify({ [PI.id]: Date.now() }));
    await act(async () => {
      window.dispatchEvent(new (window as unknown as { StorageEvent: typeof StorageEvent }).StorageEvent("storage", { key: DISMISSED_KEY }));
      await settle();
    });
    assert.ok(inBanner().getByText("A screen was found that is not set up"), "another tab's dismissal did not reach this one");
    assert.ok(inBanner().queryByText("lobby-pi") === null);
    localStorage.clear();
    await act(async () => {
      window.dispatchEvent(new (window as unknown as { StorageEvent: typeof StorageEvent }).StorageEvent("storage", { key: null }));
      await settle();
    });
    assert.ok(inBanner().getByText("2 screens were found that are not set up"), "clearing storage in another tab did not reach this one");
  });

  test("a dismissal in the old shape (a list of ids) still hides its device, and is rewritten as dated on the next change", async () => {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([PI.id]));
    seen = [PI, SCREEN2];
    await mountScreens();
    await eventually(() => assert.ok(banner()));
    assert.ok(inBanner().getByText("A screen was found that is not set up"));
    assert.ok(inBanner().queryByText("lobby-pi") === null, "an old-shape dismissal was lost");
    await click(inBanner().getByRole("button", { name: "Dismiss" }));
    const kept = JSON.parse(stored()!) as Record<string, number>;
    assert.deepEqual(Object.keys(kept).sort(), [SCREEN2.id, PI.id].sort());
    assert.ok(Object.values(kept).every((at) => typeof at === "number" && at > 0));
  });

  test("a device dismissed more than 30 days ago is named again", async () => {
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    localStorage.setItem(DISMISSED_KEY, JSON.stringify({ [PI.id]: old, [SCREEN2.id]: Date.now() }));
    seen = [PI, SCREEN2];
    await mountScreens();
    await eventually(() => assert.ok(banner()));
    assert.ok(inBanner().getByText("lobby-pi"), "a 31-day-old dismissal still hid its device");
    assert.ok(inBanner().queryByText("green-room-pi") === null, "a recent dismissal was dropped");
  });

  test("a device dismissed from the banner says so under Not set up yet", async () => {
    seen = [PI, SDI];
    await mountScreens();
    await eventually(() => assert.ok(banner()));
    const section = () => document.getElementById(NOT_SET_UP_ID)!.textContent ?? "";
    assert.ok(!section().includes("dismissed from the banner"), "a device nobody dismissed was annotated");
    for (const button of inBanner().getAllByRole("button", { name: "Dismiss" })) await click(button);
    const notes = section().match(/dismissed from the banner/g) ?? [];
    assert.equal(notes.length, 2, `${notes.length} of 2 dismissed devices are annotated: ${section()}`);
    assert.match(section(), /Video output · 1080p59\.94 until set · dismissed from the banner/);
    assert.match(section(), /Linux · 192\.0\.2\.10 · dismissed from the banner/);
  });

  test("storage holding something that is not a list of ids reads as nothing dismissed", async () => {
    localStorage.setItem(DISMISSED_KEY, '{"not":"a list"}');
    seen = [PI];
    await mountScreens();
    await eventually(() => assert.ok(banner()));
    cleanup();
    __resetDevicesForTests();
    __resetDismissedForTests();
    localStorage.setItem(DISMISSED_KEY, "not json at all");
    await mountScreens();
    await eventually(() => assert.ok(banner()));
  });
});
