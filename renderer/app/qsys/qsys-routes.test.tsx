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
const { QsysPanelRoute, OFFLINE_BODY, OFFLINE_TITLE, NO_CORE_TITLE } = await import("./qsys-panel-route.js");
const { QsysTimingContext, QSYS_TIMING } = await import("./qsys-timing.js");
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
  /** Imports sent, and how the next one is answered. */
  imports: Record<string, unknown>[];
  importAnswer: { status: number; body: unknown } | null;
  posts: Record<string, unknown>[];
  allow: { entries: unknown[]; invalid: string | null; rev: string };
  repairs: unknown[];
  pinSet: boolean;
  pinPuts: unknown[];
  dismissed: { url: string; body: unknown }[];
  /** Reads answered 500. */
  failReads: string[];
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
    imports: [],
    importAnswer: null,
    posts: [],
    allow: structuredClone(ALLOW),
    repairs: [],
    pinSet: false,
    pinPuts: [],
    dismissed: [],
    failReads: [],
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
const CATALOG = {
  designCode: "d1",
  components: [
    {
      name: MIX,
      type: "mixer",
      controls: [
        { Name: "mute", Type: "Boolean" },
        { Name: "meter", Type: "Float", ValueMin: -100, ValueMax: 20 },
        // A measured range (-100..+10) and one with no measured taper (-100..+20).
        { Name: "output.1.gain", Type: "Float", ValueMin: -100, ValueMax: 10 },
        { Name: "output.2.gain", Type: "Float", ValueMin: -100, ValueMax: 20 },
        // Read-only: never a control a panel could write, so never offered for the allowlist.
        { Name: "peak", Type: "Float", Direction: "Read", ValueMin: -100, ValueMax: 20 },
      ],
    },
  ],
};

const f = stubFetchWithLog((url, init) => {
  if (server.failReads.includes(url)) return reply(500, { error: "boom" });
  if (url.includes("/api/state")) return ok({ views: server.views, outputs: [], appName: "Stage Utility" });
  if (url.endsWith("/qsys-inactive/dismiss")) {
    server.dismissed.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as unknown });
    return ok({ views: server.views, outputs: [] });
  }
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
  if (url === "/api/qsys/allowlist/export") return ok({ format: "stage-utility-qsys-allowlist", version: 1, entries: server.allow.entries });
  if (url === "/api/qsys/allowlist/import") {
    const sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    // As the server does: an import naming a revision other than the stored one is refused.
    if (sent.rev !== undefined && sent.rev !== server.allow.rev) return reply(409, { error: "the allowlist was changed since this list was read", code: "rev-changed" });
    server.imports.push(sent);
    if (server.importAnswer) return reply(server.importAnswer.status, server.importAnswer.body);
    const entries = (server.imports.at(-1)!.entries ?? []) as unknown[];
    server.allow = { entries, invalid: null, rev: "imported" };
    return ok({ entries, rev: "imported" });
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
  routerRef = router as unknown as typeof routerRef;
  render(
    React.createElement(
      QsysTimingContext.Provider,
      // The offline card after 50 ms without the Core and 150 ms without the page's stream.
      { value: { ...QSYS_TIMING, coreLostAfterMs: 50, pageLostAfterMs: 150 } },
      React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router })),
    ),
  );
  await wait(60);
}

let routerRef: { state: { location: { pathname: string; search: Record<string, unknown> } } };
const where = () => ({ path: routerRef.state.location.pathname, search: { ...routerRef.state.location.search } });

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
      "qsys-timing.ts",
      "use-auto-return.ts",
      "use-dismiss.ts",
      "use-pin-set.ts",
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
    // A volunteer device whose cog took it to the staff panel: no way to settings.
    await open("/qsys/booth?return=zone-1");
    assert.ok(document.querySelector("[data-qsys-no-core]"));
    assert.equal(document.querySelector("[data-qsys-no-core] a") !== null, false, "a volunteer device reached settings through a staff panel");
    cleanup();
    __resetQsysPanelsForTests();
    // And the other way: a volunteer panel stays without the link, whatever its home.
    await open("/qsys/zone-1?return=booth");
    assert.ok(document.querySelector("[data-qsys-no-core]"));
    assert.equal(document.querySelector("[data-qsys-no-core] a") !== null, false, "a volunteer panel got the settings link from a staff home");
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

  test("a save over a list changed elsewhere is refused, shows what changed beside the edits, and Save waits until they are reviewed", async () => {
    await open("/qsys/manage");
    await wait(60);
    act(() => {
      fireEvent.change(screen.getByLabelText(`Max for ${MIX} gain`), { target: { value: "0" } });
      fireEvent.blur(screen.getByLabelText(`Max for ${MIX} gain`));
    });
    // Another operator saves meanwhile: the gain's limits moved and a control was added.
    server.allow = {
      entries: [
        { component: MIX, control: "gain", label: "", min: -50, max: 10, confirm: "none" },
        { component: MIX, control: "mute", label: "", min: null, max: null, confirm: "none" },
        { component: MIX, control: "talk", label: "", min: null, max: null, confirm: "hold" },
      ],
      invalid: null,
      rev: "elsewhere",
    };
    const save = () => screen.getByText("Save the allowlist").closest("button") as HTMLButtonElement;
    act(() => {
      fireEvent.click(save());
    });
    await wait(40);
    assert.equal(server.puts.length, 0, "the save overwrote someone else's list");
    const box = () => document.querySelector("[data-qsys-allowlist-conflict]");
    assert.match(box()?.textContent ?? "", /changed somewhere else/);
    assert.deepEqual(
      [...document.querySelectorAll("[data-qsys-allowlist-changes] li")].map((li) => li.textContent?.replace(/\s+/g, " ").trim()),
      [`${MIX} gain limits, label or hold changed`, `${MIX} talk added`],
    );
    assert.match(document.querySelector("[data-qsys-allowlist-now]")?.textContent ?? "", /talk.*no limits, hold/);
    // The edits stay where they were, beside the new list.
    assert.equal((screen.getByLabelText(`Max for ${MIX} gain`) as HTMLInputElement).value, "0", "the edits were thrown away");
    // A second press sends nothing: Save is off until the operator has looked.
    assert.equal(save().disabled, true, "Save stayed on after a refused save");
    act(() => {
      fireEvent.click(save());
    });
    await wait(40);
    assert.equal(server.puts.length, 0, "a second press saved the stale edits over the new list");
    act(() => {
      fireEvent.click(document.querySelector("[data-qsys-allowlist-reviewed]")!);
    });
    await wait(10);
    assert.equal(save().disabled, false);
    act(() => {
      fireEvent.click(save());
    });
    await wait(40);
    assert.equal(server.puts.length, 1, "the reviewed save did not go");
    assert.equal(server.puts[0].rev, "elsewhere", "the reviewed save did not name the list it was reviewed against");
  });

  test("after a refused save, Discard my edits shows the list as it is now", async () => {
    await open("/qsys/manage");
    await wait(60);
    act(() => {
      fireEvent.change(screen.getByLabelText(`Max for ${MIX} gain`), { target: { value: "0" } });
      fireEvent.blur(screen.getByLabelText(`Max for ${MIX} gain`));
    });
    server.allow = { entries: [{ component: MIX, control: "gain", label: "", min: -50, max: 10, confirm: "none" }], invalid: null, rev: "elsewhere" };
    act(() => {
      fireEvent.click(screen.getByText("Save the allowlist"));
    });
    await wait(40);
    act(() => {
      fireEvent.click(screen.getByText("Discard my edits"));
    });
    await wait(10);
    assert.equal(document.querySelector("[data-qsys-allowlist-conflict]") === null, true);
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
    assert.deepEqual([...box.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim()), ["Dismiss", "Restore as panel", "Dismiss"], "a display was offered a restore");
    act(() => {
      fireEvent.click(screen.getByText("Restore as panel"));
    });
    await wait(40);
    assert.equal(server.patches.at(-1)?.url, "/api/views/v-spare");
    assert.deepEqual(server.patches.at(-1)?.body, { qsys: { kind: "staff", slug: "spare", siblings: [], returnAfterMin: 5 } });
  });

  test("restoring onto a view that is a panel now asks first, saying its settings go aside", async () => {
    render(React.createElement(ConfirmHost));
    const kept = { kind: "staff", slug: "old-zone", siblings: [], returnAfterMin: 5 };
    server.views = [{ ...ZONE, qsysInactive: [kept] }, BOOTH];
    await open("/qsys/manage");
    await wait(60);
    act(() => {
      fireEvent.click(screen.getByText("Restore as panel"));
    });
    await wait(40);
    assert.equal(server.patches.length, 0, "it restored without asking");
    assert.match(document.body.textContent ?? "", /is the panel at \/qsys\/zone-1 now\. Its settings are kept aside/);
    act(() => {
      fireEvent.click(screen.getByText("Restore"));
    });
    await wait(60);
    assert.deepEqual(server.patches.at(-1)?.body, { qsys: kept });
  });

  test("Dismiss forgets kept-aside settings only once confirmed, and sends them whole", async () => {
    render(React.createElement(ConfirmHost));
    const odd = { kind: "guest", slug: "Foyer" };
    server.views = [ZONE, BOOTH, { id: "v-spare", name: "Spare", kind: "custom", surface: "console", createdAt: NOW, layout: layoutWith(), qsysInactive: [odd] }];
    await open("/qsys/manage");
    await wait(60);
    act(() => {
      fireEvent.click(document.querySelector("[data-qsys-dismiss]")!);
    });
    await wait(40);
    assert.deepEqual(server.dismissed, [], "it dismissed without asking");
    act(() => {
      fireEvent.click([...document.querySelectorAll("button")].find((b) => b.textContent === "Dismiss" && !b.hasAttribute("data-qsys-dismiss"))!);
    });
    await wait(60);
    assert.deepEqual(server.dismissed, [{ url: "/api/views/v-spare/qsys-inactive/dismiss", body: { entry: odd } }]);
  });

  test("a read that failed says so: the connection, and the load's repairs", async () => {
    server.failReads = ["/api/qsys/status", "/api/qsys/panel-repairs"];
    await open("/qsys/manage");
    await wait(60);
    assert.equal(document.querySelector("[data-qsys-connection]")?.getAttribute("data-qsys-connection"), "failed");
    assert.match(document.querySelector("[data-qsys-connection]")?.textContent ?? "", /Couldn't read the Q-SYS connection; see \/log/);
    assert.ok(document.querySelector("[data-qsys-repairs-failed]"), "a failed repairs read looked like no repairs");
  });

  test("/qsys/manage/<old address> leads to the renamed panel", async () => {
    server.views = [{ ...ZONE, qsys: { ...block("volunteer", "zone-one"), aliases: ["zone-1"] } }, BOOTH];
    await open("/qsys/manage/zone-1");
    await wait(40);
    assert.equal(where().path, "/qsys/manage/zone-one");
    assert.ok(document.querySelector('[data-qsys-panel="zone-one"]'));
  });

  // Not unit-tested: that the hover Edit pill sits clear of the header's address and kind
  // text. That is layout (jsdom loads no stylesheet and measures every box as 0); it was
  // checked in a browser by comparing the two boxes.
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

  test("/qsys/manage lists the fader ranges with no measured taper, with their controls, and says when there are none", async () => {
    const fader = (control: string) => ({ type: "qsys-fader", binding: { component: MIX, control }, orientation: "vertical", showDb: true, steps: false, stepDb: 1 });
    server.views = [{ ...BOOTH, layout: layoutWith(fader("output.1.gain"), fader("output.2.gain"), MUTE) }];
    await open("/qsys/manage");
    await wait(60);
    const rows = [...document.querySelectorAll("[data-qsys-untapered]")].map((n) => [n.getAttribute("data-qsys-untapered"), n.textContent]);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.equal(rows[0]![0], "mixer -100..20");
    assert.match(rows[0]![1] ?? "", /Lobby_Mixer output\.2\.gain/);
    assert.doesNotMatch(rows[0]![1] ?? "", /output\.1\.gain/, "a fader on a measured range was listed");
    cleanup();
    __resetQsysPanelsForTests();
    server.views = [{ ...BOOTH, layout: layoutWith(fader("output.1.gain")) }];
    await open("/qsys/manage");
    await wait(60);
    assert.match(document.querySelector('[data-qsys-tapers="ok"]')?.textContent ?? "", /Every fader has a measured taper/);
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

  test("Add a control picks from the Core's writable controls, lands as an unsaved row at the Core's range, and saves", async () => {
    await open("/qsys/manage");
    await wait(60);
    const opener = () => screen.getByRole("button", { name: "Add a control" }) as HTMLButtonElement;
    assert.equal(opener().disabled, false);
    act(() => {
      fireEvent.click(opener());
    });
    await wait(40);
    act(() => {
      fireEvent.click(document.querySelector(`[data-qsys-component="${MIX}"]`)!);
    });
    await wait(10);
    const offered = [...document.querySelectorAll("[data-qsys-browser] [data-qsys-control]")].map((b) => (b as HTMLElement).dataset.qsysControl);
    // gain and mute are on the list already; peak is read-only. output.1.gain is bound by no panel.
    assert.deepEqual(offered, ["meter", "output.1.gain", "output.2.gain"]);
    act(() => {
      fireEvent.click(document.querySelector('[data-qsys-control="output.1.gain"]')!);
    });
    await wait(10);
    assert.equal(server.puts.length, 0, "adding saved straight away");
    assert.ok(screen.getByText("Save the allowlist"), "the add is an unsaved edit");
    act(() => {
      fireEvent.click(screen.getByText("Save the allowlist"));
    });
    await wait(40);
    assert.deepEqual(server.puts.at(-1)!.entries, [
      { component: MIX, control: "gain", label: "", min: -100, max: 20, confirm: "none" },
      { component: MIX, control: "mute", label: "", min: null, max: null, confirm: "none" },
      { component: MIX, control: "output.1.gain", label: `${MIX} output.1.gain`, min: -100, max: 10, confirm: "none" },
    ]);
    // Now on the list, it is not offered again.
    act(() => {
      fireEvent.click(opener());
    });
    await wait(40);
    act(() => {
      fireEvent.click(document.querySelector(`[data-qsys-component="${MIX}"]`)!);
    });
    await wait(10);
    assert.equal(document.querySelector('[data-qsys-browser] [data-qsys-control="output.1.gain"]'), null);
  });

  test("Add a control is off, with its reason, while the Core is not connected", async () => {
    server.status = { connected: false, state: "reconnecting", configured: true, designName: null, isEmulator: null };
    await open("/qsys/manage");
    await wait(60);
    assert.equal((screen.getByRole("button", { name: "Add a control" }) as HTMLButtonElement).disabled, true);
    assert.match(document.body.textContent ?? "", /Adding a control needs the Core connected/);
  });

  test("Export downloads the allowlist file; Import sends a file once confirmed and shows the server's answer", async () => {
    render(React.createElement(ConfirmHost));
    const saved: Blob[] = [];
    const urlApi = URL as unknown as { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void };
    const before = { c: urlApi.createObjectURL, r: urlApi.revokeObjectURL };
    urlApi.createObjectURL = (b) => (saved.push(b), "#blob");
    urlApi.revokeObjectURL = () => {};
    try {
      await open("/qsys/manage");
      await wait(60);
      act(() => {
        fireEvent.click(screen.getByText("Export"));
      });
      await wait(40);
      const file = JSON.parse(await saved[0]!.text()) as { format: string; entries: unknown[] };
      assert.equal(file.format, "stage-utility-qsys-allowlist");
      assert.equal(file.entries.length, 2);
    } finally {
      urlApi.createObjectURL = before.c;
      urlApi.revokeObjectURL = before.r;
    }
    const pick = (text: string) => {
      const input = screen.getByLabelText("Allowlist file to import") as HTMLInputElement;
      act(() => {
        fireEvent.change(input, { target: { files: [new File([text], "list.json", { type: "application/json" })] } });
      });
    };
    const body = { format: "stage-utility-qsys-allowlist", version: 1, entries: [{ component: MIX, control: "meter", label: "m", min: -100, max: 20, confirm: "none" }] };
    pick(JSON.stringify(body));
    await wait(40);
    assert.equal(server.imports.length, 0, "it imported without asking");
    act(() => {
      fireEvent.click(screen.getByText("Replace the list"));
    });
    await wait(60);
    assert.deepEqual(server.imports.at(-1), { ...body, rev: "r1" });
    assert.match(document.body.textContent ?? "", /Imported 1 control\./);
    assert.match(document.querySelector("[data-qsys-allowlist]")?.textContent ?? "", /Lobby_Mixer meter/);
    // A refusal is shown as the server said it, and the list stays.
    server.importAnswer = { status: 400, body: { error: "this is not a Q-SYS allowlist file" } };
    pick(JSON.stringify({ nope: true }));
    await wait(40);
    act(() => {
      fireEvent.click(screen.getByText("Replace the list"));
    });
    await wait(60);
    assert.match(screen.getByRole("alert").textContent ?? "", /Nothing was imported: .*not a Q-SYS allowlist file/);
    assert.match(document.querySelector("[data-qsys-allowlist]")?.textContent ?? "", /Lobby_Mixer meter/);
    // A file that is not JSON never reaches the server.
    const sent = server.imports.length;
    pick("{ not json");
    await wait(40);
    assert.equal(server.imports.length, sent);
    assert.match(screen.getByRole("alert").textContent ?? "", /not JSON/);
  });

  test("an import refused because the list changed elsewhere reads it again, so the next try goes through", async () => {
    render(React.createElement(ConfirmHost));
    await open("/qsys/manage");
    await wait(60);
    const body = { format: "stage-utility-qsys-allowlist", version: 1, entries: [{ component: MIX, control: "meter", label: "m", min: -100, max: 20, confirm: "none" }] };
    const importOnce = async () => {
      act(() => {
        fireEvent.change(screen.getByLabelText("Allowlist file to import"), { target: { files: [new File([JSON.stringify(body)], "list.json", { type: "application/json" })] } });
      });
      await wait(40);
      act(() => {
        fireEvent.click(screen.getByText("Replace the list"));
      });
      await wait(60);
    };
    // Someone saves after this page read the list.
    server.allow = { entries: [{ component: MIX, control: "talk", label: "", min: null, max: null, confirm: "none" }], invalid: null, rev: "elsewhere" };
    await importOnce();
    assert.equal(server.imports.length, 0, "the stale import went through");
    assert.match(screen.getByRole("alert").textContent ?? "", /Nothing was imported: .*changed somewhere else/);
    assert.match(document.querySelector("[data-qsys-allowlist]")?.textContent ?? "", /talk/, "the page kept showing the list it read before");
    await importOnce();
    assert.deepEqual(server.imports.at(-1), { ...body, rev: "elsewhere" }, "the retry did not name the list as it is now");
    assert.match(document.body.textContent ?? "", /Imported 1 control\./);
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
    assert.match(document.querySelector("[data-qsys-old-address]")?.textContent ?? "", /\/qsys\/zone-1 keeps leading here/);
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
