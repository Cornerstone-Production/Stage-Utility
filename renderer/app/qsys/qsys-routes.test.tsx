// The Q-SYS panel pages, through the real route components against a stubbed
// server: /qsys/<slug> (the panel full screen), /qsys/manage (the operator's page)
// and the not-found panel. Which paths hide the chrome is pinned in
// active-page.test.tsx, against the real router.
//
// What is asserted is what the page says and what it sends: the header's
// connection line, the offline card's words, the manage page's sections, and
// that a woken page sends nothing until it has read the Core's state again.
//
// NOT unit-tested here, and checked in a browser instead: how the pages LOOK.
// jsdom loads no stylesheet and lays nothing out, so the kiosk surface's colours,
// the header's height, the card's place over the layout and the panel grid's
// columns all read as nothing here. Those were driven in a real page against a
// fake Core.
//
// The new pages and the Q-SYS store run through the React Compiler, as the built
// app runs them (react-compiler-hook.ts): a read outside a hook's snapshot works
// uncompiled and freezes compiled.
//
// Every name and id is invented.
//
// A DOM node is never handed to assert as a value: on a failure the reporter
// inspects it, walks the whole jsdom graph and the run dies with no message.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { compileWithReactCompiler } from "../../test-fixtures/react-compiler-hook.js";
import { installDom, unmountAndTeardown } from "../../test-dom.js";
import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";
import { ok, reply, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";

const compiled = compileWithReactCompiler((url) => /\/renderer\/(app|main)\/qsys\/[^/]+\.tsx?$/.test(url) && !/\.test\.tsx?$/.test(url));
const teardown = installDom();
(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
};
(window as unknown as { matchMedia: unknown }).matchMedia = () => ({
  matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
});
(window.HTMLElement.prototype as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({
  x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 200, width: 200, height: 200,
});

const { render, cleanup, fireEvent, act, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } = await import("@tanstack/react-router");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { QsysPanelRoute, OFFLINE_BODY, OFFLINE_TITLE, NO_CORE_TITLE, __setOfflineOverlayDelayForTests } = await import("./qsys-panel-route.js");
const { QsysManageRoute, QsysManagePanelRoute } = await import("./qsys-manage-route.js");
const { __resetForTests: resetStageState } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests, __sseFallback } = await import("../../lib/api.js");
const { __resetQsysPanelsForTests } = await import("../../main/qsys/use-qsys-values.js");
const { slugTakenMessage } = await import("@main/types/qsys");
const { ConfirmHost } = await import("../../components/ui/confirm-dialog.js");

after(() => unmountAndTeardown(cleanup, teardown));

const MIX = "Lobby_Mixer";
const NOW = "2026-01-01T00:00:00.000Z";
const block = (kind: "volunteer" | "staff", slug: string) => ({ kind, slug, siblings: [], returnAfterMin: 5 });
const layoutWith = (...configs: unknown[]) => ({
  version: 1,
  canvas: { width: 1920, height: 1080, background: null },
  objects: configs.map((config, i) => ({ id: `o${i}`, x: 0, y: 0, w: 0.2, h: 0.5, z: 1, config, style: {} })),
});
const MUTE = { type: "qsys-mute", binding: { component: MIX, control: "mute" } };
const METER = { type: "qsys-meter", binding: { component: MIX, control: "meter" }, form: "bar" };

const ZONE = { id: "v-zone", name: "Zone 1", kind: "custom", surface: "console", createdAt: NOW, layout: layoutWith(MUTE, METER), qsys: block("volunteer", "zone-1") };
const BOOTH = { id: "v-booth", name: "Booth", kind: "custom", surface: "console", createdAt: NOW, layout: layoutWith(MUTE), qsys: block("staff", "booth") };

interface Server {
  views: unknown[];
  status: { connected: boolean; state: "connected" | "reconnecting" | "offline"; configured: boolean; designName: string | null; isEmulator: boolean | null };
  ready: boolean;
  values: Record<string, unknown>;
  holdReads: ((release: () => void) => void) | null;
  reads: number;
  writes: Record<string, unknown>[];
  subscribes: string[][];
  bindings: { status: number; body: unknown };
  patches: { url: string; body: Record<string, unknown> }[];
  patchAnswer: { status: number; body: unknown };
  puts: Record<string, unknown>[];
  posts: Record<string, unknown>[];
  allow: { entries: unknown[]; invalid: string | null; rev: string };
  repairs: unknown[];
  pinSet: boolean;
  pinPuts: unknown[];
}

let server: Server;
function freshServer(): Server {
  return {
    views: [ZONE, BOOTH],
    status: { connected: true, state: "connected", configured: true, designName: "Main design", isEmulator: true },
    ready: true,
    values: { mute: false, meter: -30 },
    holdReads: null,
    reads: 0,
    writes: [],
    subscribes: [],
    bindings: { status: 200, body: [] },
    patches: [],
    patchAnswer: { status: 200, body: {} },
    puts: [],
    posts: [],
    allow: structuredClone(ALLOW),
    repairs: [],
    pinSet: false,
    pinPuts: [],
  };
}

const ALLOW = {
  rev: "r1",
  entries: [
    { component: MIX, control: "gain", label: "", min: -100, max: 20, confirm: "none" },
    { component: MIX, control: "mute", label: "", min: null, max: null, confirm: "none" },
  ],
  invalid: null as string | null,
};
const CATALOG = { designCode: "d1", components: [{ name: MIX, type: "mixer", controls: [{ Name: "mute", Type: "Boolean" }, { Name: "meter", Type: "Float", ValueMin: -100, ValueMax: 20 }] }] };

const f = stubFetchWithLog((url, init) => {
  if (url.includes("/api/state")) return ok({ views: server.views, outputs: [], appName: "Stage Utility" });
  if (url.includes("/api/events/subscribe")) {
    server.subscribes.push((JSON.parse(String(init?.body ?? "{}")) as { channels: string[] }).channels);
    return ok({});
  }
  if (url.startsWith("/api/qsys/values")) {
    server.reads++;
    const answer = () => ok({ ready: server.ready, values: Object.entries(server.values).map(([control, value]) => ({ component: MIX, control, value, string: String(value) })) });
    const hold = server.holdReads;
    if (hold) return new Promise((resolve) => hold(() => resolve(answer())));
    return answer();
  }
  if (url === "/api/qsys/status") return ok(server.status);
  if (url === "/api/qsys/allowlist" && init?.method === "PUT") {
    const body = JSON.parse(String(init.body ?? "{}")) as { entries: unknown[]; rev?: string };
    // As the server does: a save naming a revision other than the stored one is refused.
    if (body.rev !== undefined && body.rev !== server.allow.rev) return reply(409, { error: "the allowlist was changed since this list was read", code: "rev-changed" });
    server.puts.push(body);
    server.allow = { entries: body.entries, invalid: null, rev: `r${server.puts.length + 1}` };
    return ok({ entries: body.entries, rev: server.allow.rev });
  }
  if (url === "/api/qsys/allowlist") return ok(server.allow);
  if (url === "/api/qsys/pin" && init?.method === "PUT") {
    const { pin } = JSON.parse(String(init.body ?? "{}")) as { pin: unknown };
    server.pinPuts.push(pin);
    server.pinSet = pin !== null;
    return ok({ set: server.pinSet });
  }
  if (url === "/api/qsys/pin") return ok({ set: server.pinSet });
  if (url === "/api/qsys/panel-repairs") return ok(server.repairs);
  if (url === "/api/qsys/catalog") return ok(CATALOG);
  if (url === "/api/qsys/bindings") return reply(server.bindings.status, server.bindings.body);
  if (url === "/api/qsys/write") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    server.writes.push(body);
    return ok({ ok: true, value: body.value, string: String(body.value), clamped: false });
  }
  if (url === "/api/views" && init?.method === "POST") {
    server.posts.push(JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>);
    return reply(201, { views: server.views, outputs: [] });
  }
  if (url.startsWith("/api/views/") && init?.method === "PATCH") {
    server.patches.push({ url, body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown> });
    return reply(server.patchAnswer.status, server.patchAnswer.body);
  }
  return ok({});
});
after(async () => {
  await new Promise((r) => setTimeout(r, 300));
  f.restore();
});

beforeEach(() => {
  server = freshServer();
  __resetReplayCacheForTests();
  __resetQsysPanelsForTests();
  __sseFallback.noteStream(true);
  __setOfflineOverlayDelayForTests(50, 150);
});
afterEach(() => {
  cleanup();
  resetStageState();
});

const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

let client: InstanceType<typeof QueryClient>;

async function open(path: string) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const root = createRootRoute();
  const routes = [
    createRoute({ getParentRoute: () => root, path: "/qsys/manage", component: QsysManageRoute }),
    createRoute({ getParentRoute: () => root, path: "/qsys/manage/$slug", component: QsysManagePanelRoute }),
    createRoute({ getParentRoute: () => root, path: "/qsys/$slug", component: QsysPanelRoute }),
  ];
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(RouterProvider, { router }),
    ),
  );
  await wait(60);
}

const line = () => document.querySelector("[data-connection-line]")?.textContent ?? "";
const muteButton = () => document.querySelector('[data-qsys-object="qsys-mute"] button') as HTMLElement;
const muteState = () => (document.querySelector('[data-qsys-object="qsys-mute"]') as HTMLElement).dataset.state;
const pushStatus = (p: Server["status"]) => act(() => FakeEventSource.last!.push("qsys:status", p));

describe("Q-SYS panel pages", () => {
  test("the pages and the panel store run through the React Compiler here", () => {
    assert.deepEqual(compiled(), [
      "fader-scale.ts",
      "meter-tween.ts",
      "qsys-cog-menu.tsx",
      "qsys-manage-route.tsx",
      "qsys-objects.tsx",
      "qsys-panel-route.tsx",
      "qsys-paths.ts",
      "use-auto-return.ts",
      "use-qsys-status.ts",
      "use-qsys-values.ts",
    ]);
  });

  test("/qsys/<slug> draws the panel: its name, the connection line, and live objects", async () => {
    await open("/qsys/zone-1");
    assert.equal(document.querySelector("h1")?.textContent, "Zone 1");
    assert.equal(line(), "Connected to sound system");
    assert.equal(muteState(), "live");
    assert.equal(document.querySelector("[data-qsys-offline]") !== null, false);
    assert.equal(screen.queryByText(/Edit/) !== null, false, "a panel opened full screen offers no way into the editor");
  });

  test("a volunteer panel's meters come on the volunteer channel, a staff panel's on the staff one", async () => {
    await open("/qsys/zone-1");
    await wait(250);
    const volunteer = server.subscribes.at(-1) ?? [];
    assert.ok(volunteer.includes("qsys:meters:volunteer"), `subscribed: ${JSON.stringify(volunteer)}`);
    assert.ok(!volunteer.includes("qsys:meters:staff"), "the volunteer panel also took the staff rate");
    cleanup();
    await open("/qsys/booth");
    await wait(250);
    assert.ok((server.subscribes.at(-1) ?? []).includes("qsys:meters:staff"));
  });

  test("an unknown slug shows a not-found panel, not a blank page", async () => {
    let releaseState: () => void = () => {};
    const real = globalThis.fetch;
    // Hold the views: until they are known, nothing says "not found".
    globalThis.fetch = ((input: unknown, init?: RequestInit) =>
      String(input).includes("/api/state") ? new Promise((resolve) => (releaseState = () => resolve(real(input as string, init)))) : real(input as string, init)) as typeof fetch;
    try {
      await open("/qsys/no-such-panel");
      assert.equal(document.querySelector("[data-qsys-not-found]") !== null, false, "said not found before the views were read");
      releaseState();
      await wait(60);
      const nf = document.querySelector("[data-qsys-not-found]");
      assert.ok(nf, "a blank page");
      assert.match(nf!.textContent ?? "", /There is no panel here/);
      assert.match(nf!.textContent ?? "", /\/qsys\/no-such-panel/);
      assert.equal(nf!.querySelector("a") !== null, false, "a volunteer's not-found page links into the app");
    } finally {
      globalThis.fetch = real;
    }
  });

  test("when the Core cannot be reached, the offline card says so in the approved words, and the panel takes no input", async () => {
    await open("/qsys/zone-1");
    server.status = { ...server.status, connected: false, state: "reconnecting", designName: null };
    server.ready = false;
    pushStatus(server.status);
    await wait(10);
    assert.equal(document.querySelector("[data-qsys-offline]") !== null, false, "a blip shorter than the delay covered the panel");
    await wait(80);
    const card = document.querySelector("[data-qsys-offline]");
    assert.ok(card, "no offline card");
    assert.match(card!.textContent ?? "", new RegExp(OFFLINE_TITLE));
    assert.ok((card!.textContent ?? "").includes(OFFLINE_BODY));
    assert.equal(OFFLINE_TITLE, "Audio controls are offline");
    assert.equal(OFFLINE_BODY, "This page can't reach the sound system, so nothing here will change anything. Use the Q-SYS panel on the wall, or find a tech.");
    assert.equal(line(), "Sound system offline");
    act(() => {
      fireEvent.click(muteButton());
    });
    await wait(20);
    assert.equal(server.writes.length, 0, "an offline panel wrote");
    // Back: the card goes, and input opens once the panel is read again.
    server.status = { ...server.status, connected: true, state: "connected", designName: "Main design" };
    server.ready = true;
    pushStatus(server.status);
    await wait(60);
    assert.equal(document.querySelector("[data-qsys-offline]") !== null, false);
    assert.equal(line(), "Connected to sound system");
  });

  test("with no Core set up, the panel says so, its objects are disabled, and a volunteer panel has no way to settings", async () => {
    server.status = { connected: false, state: "offline", configured: false, designName: null, isEmulator: null };
    server.ready = false;
    await open("/qsys/zone-1");
    const strip = document.querySelector("[data-qsys-no-core]");
    assert.ok(strip, "no warning");
    assert.match(strip!.textContent ?? "", new RegExp(NO_CORE_TITLE));
    assert.equal(strip!.querySelector("a") !== null, false, "a volunteer panel links to settings");
    assert.equal(muteState(), "offline");
    assert.equal(document.querySelector("[data-qsys-offline]") !== null, false, "no Core is not an outage");
    cleanup();
    __resetQsysPanelsForTests();
    await open("/qsys/booth");
    assert.equal(document.querySelector("[data-qsys-no-core] a")?.getAttribute("href"), "/settings/integrations", "a staff panel has the link");
    cleanup();
    __resetQsysPanelsForTests();
    await open("/qsys/manage/zone-1");
    assert.equal(document.querySelector("[data-qsys-no-core] a")?.getAttribute("href"), "/settings/integrations", "the shell has the link");
    assert.ok(screen.getByText("Edit"), "the panel stays editable in the shell");
    // The shell's context bar names the page; the panel's header does not say it twice.
    assert.equal(document.querySelectorAll("[data-qsys-panel] h1").length, 0);
    assert.match(line(), /No Q-SYS Core is set up/);
  });

  test("after the page was hidden, values re-hydrate before input is accepted", async () => {
    await open("/qsys/zone-1");
    assert.equal(muteState(), "live");
    const reads = server.reads;
    // An iPad sleeps; meanwhile a UCI mutes it.
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => {
      document.dispatchEvent(new window.Event("visibilitychange"));
    });
    server.values.mute = true;
    // It wakes, and its read of the Core's state is slow to come back.
    let release: () => void = () => {};
    server.holdReads = (r) => (release = r);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    act(() => {
      document.dispatchEvent(new window.Event("visibilitychange"));
    });
    await wait(60);
    assert.ok(server.reads > reads, "the woken page did not read the Core's state");
    assert.equal(muteState(), "offline", "the panel took input before the read landed");
    assert.equal(line(), "Reconnecting to sound system");
    act(() => {
      fireEvent.click(muteButton());
    });
    await wait(20);
    assert.equal(server.writes.length, 0, "a tap before the read landed was sent");
    server.holdReads = null;
    release();
    await wait(60);
    assert.equal(muteState(), "live");
    assert.equal(line(), "Connected to sound system");
    assert.equal(muteButton().getAttribute("aria-pressed"), "true", "it shows the Core's value from the read, the UCI's mute");
    act(() => {
      fireEvent.click(muteButton());
    });
    await wait(20);
    assert.deepEqual(server.writes.map((w) => w.value), [false], "a tap after the read writes once (positive control)");
  });
});

describe("a panel that loses Stage Utility", () => {
  test("after the page's own stream has been down a while, the offline card covers it; back, it reads before input", async () => {
    await open("/qsys/zone-1");
    assert.equal(muteState(), "live");
    act(() => __sseFallback.noteStream(false));
    await wait(60);
    assert.equal(document.querySelector("[data-qsys-offline]") !== null, false, "a short drop covered the panel");
    assert.equal(line(), "Reconnecting to sound system");
    await wait(150);
    const card = document.querySelector("[data-qsys-offline]");
    assert.equal(card !== null, true, "no card while the page could not reach Stage Utility");
    assert.ok((card!.textContent ?? "").includes(OFFLINE_BODY));
    assert.equal(line(), "Sound system offline");
    // Back, but its read is slow: no card, and no input until the read lands.
    let release: () => void = () => {};
    server.holdReads = (r) => (release = r);
    server.values.mute = true;
    act(() => __sseFallback.noteStream(true));
    await wait(60);
    assert.equal(document.querySelector("[data-qsys-offline]") !== null, false, "the card stayed after the stream came back");
    assert.equal(muteState(), "offline", "input opened before the read landed");
    act(() => {
      fireEvent.click(muteButton());
    });
    await wait(20);
    assert.equal(server.writes.length, 0, "a tap before the read was sent");
    server.holdReads = null;
    release();
    await wait(60);
    assert.equal(muteState(), "live");
    assert.equal(muteButton().getAttribute("aria-pressed"), "true", "it shows the Core's value from the read");
  });
});

describe("/qsys/manage", () => {
  test("a restored backup's repaired panel addresses are said; Home is never offered as a panel", async () => {
    server.repairs = [{ viewId: "v-x", name: "Zone 1 copy", from: "zone-1", to: "zone-1-2", why: "shared" }];
    const HOME = { id: "home", name: "Home", kind: "custom", surface: "console", createdAt: NOW, layout: layoutWith(MUTE) };
    server.views = [ZONE, BOOTH, HOME];
    await open("/qsys/manage");
    await wait(60);
    assert.match(document.querySelector("[data-qsys-repairs]")?.textContent ?? "", /"Zone 1 copy" shared \/qsys\/zone-1 with an earlier panel, so it opens at \/qsys\/zone-1-2 now/);
    assert.equal(screen.queryByText("Make it a panel") !== null, false, "Home was offered as a panel");
  });

  test("an allowlist save carries the revision it read: over a list changed elsewhere it is refused, said, and Discard shows the new list", async () => {
    await open("/qsys/manage");
    await wait(60);
    act(() => {
      fireEvent.change(screen.getByLabelText(`Max for ${MIX} gain`), { target: { value: "0" } });
      fireEvent.blur(screen.getByLabelText(`Max for ${MIX} gain`));
    });
    // Another operator saves meanwhile.
    server.allow = { entries: [{ component: MIX, control: "gain", label: "", min: -50, max: 10, confirm: "none" }], invalid: null, rev: "elsewhere" };
    act(() => {
      fireEvent.click(screen.getByText("Save the allowlist"));
    });
    await wait(40);
    assert.equal(server.puts.length, 0, "the save overwrote someone else's list");
    assert.match(document.querySelector('section[aria-label="Allowlist"] [role="alert"]')?.textContent ?? "", /changed somewhere else/);
    act(() => {
      fireEvent.click(screen.getByText("Discard"));
    });
    await wait(10);
    assert.equal((screen.getByLabelText(`Min for ${MIX} gain`) as HTMLInputElement).value, "-50");
  });

  test("panel settings kept aside are shown; one on a custom console restores, one on a display says what to do first", async () => {
    const kept = { kind: "volunteer", slug: "lobby" };
    const WALL = { id: "v-wall", name: "Lobby wall", kind: "custom", surface: "display", createdAt: NOW, layout: layoutWith(), qsysInactive: [kept] };
    const SPARE = { id: "v-spare", name: "Spare", kind: "custom", surface: "console", createdAt: NOW, layout: layoutWith(), qsysInactive: [{ kind: "staff", slug: "spare" }] };
    server.views = [ZONE, BOOTH, WALL, SPARE];
    await open("/qsys/manage");
    await wait(60);
    const box = document.querySelector("[data-qsys-kept-aside]")!;
    assert.match(box.textContent ?? "", /Lobby wall.*\/qsys\/lobby.*Make it a custom console first/);
    assert.deepEqual([...box.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim()), ["Restore as panel"], "a display was offered a restore");
    act(() => {
      fireEvent.click(screen.getByText("Restore as panel"));
    });
    await wait(40);
    assert.equal(server.patches.at(-1)?.url, "/api/views/v-spare");
    assert.deepEqual(server.patches.at(-1)?.body, { qsys: { kind: "staff", slug: "spare", siblings: [], returnAfterMin: 5 } });
  });

  test("in the shell, a panel's header carries its address and kind", async () => {
    await open("/qsys/manage/zone-1");
    assert.match(document.querySelector("[data-qsys-shell-note]")?.textContent ?? "", /\/qsys\/zone-1.*Volunteer panel/);
  });

  test("/qsys/manage lists panels with kind, binding problems, connection, allowlist, PIN and rates", async () => {
    server.bindings = {
      status: 200,
      body: [
        { panelId: "v-booth", objectId: "o0", address: { component: MIX, control: "gone" }, problem: "missing-control" },
        { panelId: "v-booth", objectId: "o1", address: { component: MIX, control: "free" }, problem: "not-allowed" },
      ],
    };
    await open("/qsys/manage");
    await wait(60);
    const zone = document.querySelector('[data-qsys-panel-card="zone-1"]')!;
    const booth = document.querySelector('[data-qsys-panel-card="booth"]')!;
    assert.match(zone.textContent ?? "", /Zone 1/);
    assert.match(zone.textContent ?? "", /\/qsys\/zone-1/);
    assert.equal(zone.querySelector("[data-kind]")?.textContent, "Volunteer panel");
    assert.equal(zone.querySelector("[data-problems]") !== null, false);
    assert.equal(booth.querySelector("[data-kind]")?.textContent, "Staff panel");
    assert.equal(booth.querySelector("[data-problems]")?.textContent, "2 binding problems");
    assert.equal(zone.querySelector("a")?.getAttribute("href"), "/qsys/manage/zone-1");
    assert.match(document.querySelector("[data-qsys-connection]")?.textContent ?? "", /Connected to Main design \(Emulate\)/);
    assert.match(document.querySelector("[data-qsys-allowlist]")?.textContent ?? "", /Lobby_Mixer mute/);
    assert.ok(screen.getByText("Add all controls Zone 1 uses"), "no add-all for a panel");
    const report = document.querySelector('[data-qsys-bindings="ok"]')!;
    assert.match(report.textContent ?? "", /Booth.*Lobby_Mixer gone.*no such control/);
    assert.ok(document.querySelector("[data-qsys-pin]"), "no staff PIN section");
    assert.equal(document.querySelector("[data-qsys-rates]")?.getAttribute("href"), "/settings/integrations");
  });

  test("a panel's sibling that no panel has is listed, once and by name, and is not an error", async () => {
    server.views = [
      { ...ZONE, qsys: { ...block("volunteer", "zone-1"), siblings: ["booth", "gone-1", "gone-2"] } },
      BOOTH,
    ];
    await open("/qsys/manage");
    await wait(60);
    const gaps = document.querySelector("[data-qsys-missing-siblings]");
    assert.ok(gaps, "a sibling that does not exist is not reported");
    assert.match(gaps!.textContent ?? "", /Zone 1: gone-1, gone-2/);
    assert.equal((gaps!.textContent ?? "").includes("booth"), false, "a sibling that exists was reported missing");
    cleanup();
    __resetQsysPanelsForTests();
    server.views = [ZONE, BOOTH];
    await open("/qsys/manage");
    await wait(60);
    assert.equal(document.querySelector("[data-qsys-missing-siblings]"), null, "nothing is missing and something is said");
  });

  test("the binding report says when the check could not run, and when there is no Core to check against", async () => {
    // Both are 503 from the server (main/services/routes/qsys-routes.test.ts); the code tells them apart.
    server.bindings = { status: 503, body: { error: "the binding check could not run: the saved views or the allowlist could not be read; see /log", code: "check-failed" } };
    await open("/qsys/manage");
    await wait(60);
    const failed = document.querySelector('[data-qsys-bindings="failed"]')?.textContent ?? "";
    assert.match(failed, /^The binding check could not run: the saved views or the allowlist could not be read/, "a check that could not run read as no Core, or said so twice");
    cleanup();
    server.bindings = { status: 503, body: { error: "the Q-SYS Core is not connected", code: "not-connected" } };
    await open("/qsys/manage");
    await wait(60);
    assert.match(document.querySelector('[data-qsys-bindings="offline"]')?.textContent ?? "", /Connect a Core/);
  });

  test("slugs are unique: saving a duplicate is refused with a message", async () => {
    // The server's refusal, word for word (main/services/routes/qsys-panel-block-route.test.ts proves it refuses).
    const message = slugTakenMessage("zone-1", { name: "Zone 1" });
    server.patchAnswer = { status: 400, body: { error: message } };
    await open("/qsys/manage");
    await wait(60);
    act(() => {
      fireEvent.click(screen.getByLabelText("Settings for Booth"));
    });
    await wait(20);
    const address = screen.getByLabelText("Address") as HTMLInputElement;
    act(() => {
      fireEvent.change(address, { target: { value: "zone-1" } });
    });
    act(() => {
      fireEvent.click(screen.getByText("Save"));
    });
    await wait(40);
    assert.deepEqual(server.patches.at(-1)?.body, { qsys: { kind: "staff", slug: "zone-1", siblings: [], returnAfterMin: 5 } });
    assert.equal(document.querySelector("[data-qsys-refused]")?.textContent, message, "the refusal was not shown");
    assert.ok(screen.getByLabelText("Address"), "the dialog closed on a refused save");
  });

  test("the allowlist: a limit edited and saved, a row removed and saved; an empty box touched marks nothing edited", async () => {
    await open("/qsys/manage");
    await wait(60);
    const rows = () => [...document.querySelectorAll("[data-qsys-allowlist] tbody tr")] as HTMLElement[];
    const boxes = (row: HTMLElement) => [...row.querySelectorAll("input")] as HTMLInputElement[];
    // The mute row's empty Min, focused and left: NumberInput reports nothing for a
    // click in and out, so the list is not marked edited and Add-all stays enabled.
    const muteMin = boxes(rows()[1])[0];
    act(() => {
      fireEvent.focus(muteMin);
      fireEvent.blur(muteMin);
    });
    await wait(10);
    assert.equal(screen.queryByText("Save the allowlist") !== null, false, "touching an empty box marked the list edited");
    assert.equal((screen.getByText("Add all controls Zone 1 uses") as HTMLButtonElement).disabled, false);
    // Tighten the gain's max and save.
    const gainMax = boxes(rows()[0])[1];
    act(() => {
      fireEvent.change(gainMax, { target: { value: "0" } });
      fireEvent.blur(gainMax);
    });
    await wait(10);
    assert.equal((screen.getByText("Add all controls Zone 1 uses") as HTMLButtonElement).disabled, true, "add-all over unsaved edits");
    act(() => {
      fireEvent.click(screen.getByText("Save the allowlist"));
    });
    await wait(40);
    assert.deepEqual((server.puts.at(-1)!.entries as { max: unknown }[]).map((e) => e.max), [0, null]);
    assert.equal(screen.queryByText("Save the allowlist") !== null, false, "still edited after a save");
    // Remove the mute and save.
    act(() => {
      fireEvent.click(screen.getByLabelText(`Remove ${MIX} mute`));
    });
    act(() => {
      fireEvent.click(screen.getByText("Save the allowlist"));
    });
    await wait(40);
    assert.deepEqual((server.puts.at(-1)!.entries as { control: string }[]).map((e) => e.control), ["gain"]);
    assert.equal(rows().length, 1);
  });

  test("a panel's settings save its kind and address and keep its siblings and return time", async () => {
    server.views = [{ ...ZONE, qsys: { kind: "volunteer", slug: "zone-1", siblings: ["booth"], returnAfterMin: 9 } }, BOOTH];
    await open("/qsys/manage");
    await wait(60);
    act(() => {
      fireEvent.click(screen.getByLabelText("Settings for Zone 1"));
    });
    await wait(20);
    act(() => {
      fireEvent.click(screen.getByLabelText(/Staff panel/));
    });
    act(() => {
      fireEvent.change(screen.getByLabelText("Address"), { target: { value: "zone-one" } });
    });
    act(() => {
      fireEvent.click(screen.getByText("Save"));
    });
    await wait(40);
    assert.deepEqual(server.patches.at(-1)?.body, { qsys: { kind: "staff", slug: "zone-one", siblings: ["booth"], returnAfterMin: 9 } });
    assert.equal(screen.queryByLabelText("Address") !== null, false, "the dialog stayed open after a save");
  });

  test("a panel's settings choose the panels its cog lists and how long a device may be away", async () => {
    server.views = [
      { ...ZONE, qsys: { kind: "volunteer", slug: "zone-1", siblings: ["gone"], returnAfterMin: 5 } },
      BOOTH,
      { ...BOOTH, id: "v-lobby", name: "Lobby", qsys: block("volunteer", "lobby") },
    ];
    await open("/qsys/manage");
    await wait(60);
    act(() => {
      fireEvent.click(screen.getByLabelText("Settings for Zone 1"));
    });
    await wait(20);
    const box = (name: string) =>
      [...document.querySelectorAll("[data-qsys-siblings] label")].find((l) => l.textContent?.includes(name))!.querySelector("button") as HTMLElement;
    assert.deepEqual([...document.querySelectorAll("[data-qsys-siblings] label")].map((l) => l.textContent?.replace(/\/qsys\/.*/, "")), ["Booth", "Lobby"], "the panel itself, or not every other panel, was offered");
    act(() => {
      fireEvent.click(box("Lobby"));
    });
    act(() => {
      fireEvent.click(box("Booth"));
    });
    act(() => {
      fireEvent.click(box("Booth"));
    });
    const minutes = screen.getByLabelText("Minutes before going back") as HTMLInputElement;
    act(() => {
      fireEvent.change(minutes, { target: { value: "1" } });
    });
    act(() => {
      fireEvent.blur(minutes);
    });
    act(() => {
      fireEvent.click(screen.getByText("Save"));
    });
    await wait(40);
    // The missing sibling is kept, for /qsys/manage to list; the booth was ticked and unticked.
    assert.deepEqual(server.patches.at(-1)?.body, { qsys: { kind: "volunteer", slug: "zone-1", siblings: ["gone", "lobby"], returnAfterMin: 1 } });
  });

  test("the staff PIN section sets, changes and removes the PIN, and never shows it back", async () => {
    render(React.createElement(ConfirmHost));
    await open("/qsys/manage");
    await wait(40);
    const section = () => document.querySelector("[data-qsys-pin]") as HTMLElement;
    assert.equal(section().dataset.qsysPin, "none");
    assert.match(section().textContent ?? "", /No staff PIN is set/);
    const field = () => section().querySelector("input") as HTMLInputElement;
    assert.equal(field().type, "password");
    act(() => {
      fireEvent.change(field(), { target: { value: "12a" } });
    });
    assert.equal(field().value, "12", "a letter got into the PIN");
    assert.equal((screen.getByText("Set PIN").closest("button") as HTMLButtonElement).disabled, true, "three digits could be saved");
    act(() => {
      fireEvent.change(field(), { target: { value: "0123" } });
    });
    act(() => {
      fireEvent.click(screen.getByText("Set PIN"));
    });
    await wait(40);
    assert.deepEqual(server.pinPuts, ["0123"], "the PIN went as a number, or not at all");
    assert.equal(section().dataset.qsysPin, "set");
    assert.equal(field().value, "", "the PIN stayed on the page");
    act(() => {
      fireEvent.click(screen.getByText("Remove PIN"));
    });
    await wait(40);
    act(() => {
      fireEvent.click(screen.getByText("Remove the PIN"));
    });
    await wait(60);
    assert.deepEqual(server.pinPuts, ["0123", null], "the PIN could not be removed");
    assert.equal(section().dataset.qsysPin, "none");
  });

  test("a new panel opens only once the page's own state has it", async () => {
    await open("/qsys/manage");
    await wait(60);
    act(() => {
      fireEvent.click(screen.getByText("New panel"));
    });
    await wait(20);
    act(() => {
      fireEvent.change(screen.getByPlaceholderText("Zone 1"), { target: { value: "Side Stage" } });
    });
    act(() => {
      fireEvent.click(screen.getByText("Make the panel"));
    });
    await wait(40);
    assert.deepEqual(server.posts.at(-1), { name: "Side Stage", kind: "custom", surface: "console", qsys: { kind: "volunteer", slug: "side-stage", siblings: [], returnAfterMin: 5 } });
    assert.equal(document.querySelector("[data-qsys-not-found]") !== null, false, "opened before the view arrived: a not-found page");
    assert.ok(screen.getByText("Make the panel"), "left the dialog before the view arrived");
    const SIDE = { ...ZONE, id: "v-side", name: "Side Stage", qsys: block("volunteer", "side-stage") };
    server.views = [ZONE, BOOTH, SIDE];
    // The shell's live wiring puts a pushed state into this query; done by hand here.
    act(() => client.setQueryData(["stage:getState"], { views: server.views, outputs: [], appName: "Stage Utility" }));
    await wait(80);
    assert.equal(document.querySelector('[data-qsys-panel="side-stage"]') !== null, true, "the new panel did not open");
  });
});
