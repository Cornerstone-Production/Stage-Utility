// A volunteer panel's cog menu, the staff PIN pad and the return banner, through
// the real panel route against a stubbed server.
//
// What is asserted is where each control goes and what it sends: a sibling opens
// with `?return=<home>` and no PIN, "Open Stage Utility" asks the server and
// opens the app only on an explicit yes, and the banner counts down and goes home.
//
// NOT unit-tested here, and checked in a browser instead: how it LOOKS. jsdom
// loads no stylesheet and lays nothing out, so the popover's place over the
// offline card, the 52 px rows, the 44 px "Go back now" and the dots' fill all
// read as nothing here. Those were compared with the approved mockup in a real
// page against a fake Core.
//
// The new files run through the React Compiler, as the built app runs them.
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

const compiled = compileWithReactCompiler((url) => /\/renderer\/app\/qsys\/(qsys-cog-menu|use-auto-return)\.tsx?$/.test(url));
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

const { render, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } = await import("@tanstack/react-router");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { QsysPanelRoute } = await import("./qsys-panel-route.js");
const { HOME_HINT, NO_PIN_NOTE, WRONG_PIN_NOTE } = await import("./qsys-cog-menu.js");
const { QsysTimingContext, QSYS_TIMING } = await import("./qsys-timing.js");
const { __resetForTests: resetStageState } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests, __sseFallback } = await import("../../lib/api.js");
const { __resetQsysPanelsForTests } = await import("../../main/qsys/use-qsys-values.js");

after(() => unmountAndTeardown(cleanup, teardown));

const NOW = "2026-01-01T00:00:00.000Z";
const LAYOUT = { version: 1, canvas: { width: 1920, height: 1080, background: null }, objects: [] };
const panel = (id: string, name: string, kind: "volunteer" | "staff", slug: string, siblings: string[], returnAfterMin = 1) => ({
  id, name, kind: "custom", surface: "console", createdAt: NOW, layout: LAYOUT, qsys: { kind, slug, siblings, returnAfterMin },
});

interface Server {
  views: unknown[];
  /** The PIN the server holds, or null for none. */
  pin: string | null;
  /** When set, what every check answers instead. */
  checkAnswer: { status: number; body: unknown } | null;
  checks: string[];
}
let server: Server;
const freshServer = (): Server => ({
  views: [
    // Zone 1's cog lists the lobby, the booth, and a panel nobody has.
    panel("v-zone", "Zone 1", "volunteer", "zone-1", ["lobby", "booth", "gone"]),
    // The lobby's own cog lists only the nursery: not Zone 1.
    panel("v-lobby", "Lobby", "volunteer", "lobby", ["nursery"]),
    panel("v-nursery", "Nursery", "volunteer", "nursery", []),
    panel("v-booth", "Booth", "staff", "booth", []),
    panel("v-never", "Never back", "volunteer", "never-back", ["lobby"], 0),
  ],
  pin: "2468",
  checkAnswer: null,
  checks: [],
});

const f = stubFetchWithLog((url, init) => {
  if (url.includes("/api/state")) return ok({ views: server.views, outputs: [], appName: "Stage Utility" });
  if (url.startsWith("/api/qsys/values")) return ok({ ready: true, values: [] });
  if (url === "/api/qsys/status") return ok({ connected: true, state: "connected", configured: true, designName: "D", isEmulator: true });
  if (url === "/api/qsys/allowlist") return ok({ entries: [], invalid: null, rev: "r1" });
  if (url === "/api/qsys/catalog") return ok({ designCode: "d1", components: [] });
  if (url === "/api/qsys/pin") return ok({ set: server.pin !== null });
  if (url === "/api/qsys/pin/check") {
    const { pin } = JSON.parse(String(init?.body ?? "{}")) as { pin: string };
    server.checks.push(pin);
    if (server.checkAnswer) return reply(server.checkAnswer.status, server.checkAnswer.body);
    if (server.pin === null) return ok({ ok: false, lockedForMs: 0, notSet: true });
    return ok(pin === server.pin ? { ok: true } : { ok: false, lockedForMs: 0 });
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
  secondMs = QSYS_TIMING.secondMs;
});
afterEach(() => {
  cleanup();
  resetStageState();
});

/** How long a countdown second is for the page `open` mounts next. */
let secondMs = QSYS_TIMING.secondMs;

const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

type Router = { state: { location: { pathname: string; search: Record<string, unknown> } } };
let router: Router;

async function open(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const root = createRootRoute();
  const routes = [
    createRoute({ getParentRoute: () => root, path: "/", component: () => React.createElement("div", { "data-app-home": true }, "The app") }),
    createRoute({ getParentRoute: () => root, path: "/qsys/$slug", component: QsysPanelRoute }),
  ];
  const r = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: [path] }) });
  router = r as unknown as Router;
  render(
    React.createElement(
      QsysTimingContext.Provider,
      { value: { ...QSYS_TIMING, secondMs } },
      React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router: r })),
    ),
  );
  await wait(60);
}

const where = () => ({ path: router.state.location.pathname, search: { ...router.state.location.search } });
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const cog = () => q("[data-qsys-cog]");
const listed = () => [...document.querySelectorAll("[data-qsys-cog-panel]")].map((b) => (b as HTMLElement).dataset.qsysCogPanel);
const homeHinted = () =>
  [...document.querySelectorAll("[data-qsys-cog-panel]")].filter((b) => b.textContent?.includes(HOME_HINT)).map((b) => (b as HTMLElement).dataset.qsysCogPanel);
const note = () => q("[data-qsys-pin-note]")?.textContent ?? "";
const key = (label: string) => q(`[data-qsys-cog-menu] button[aria-label="${label}"]`)!;
async function press(digits: string) {
  for (const d of digits) {
    fireEvent.click(key(d));
    await wait(10);
  }
  await wait(40);
}
async function openPad() {
  fireEvent.click(cog()!);
  await wait(10);
  fireEvent.click(q("[data-qsys-open-app]")!);
  await wait(40);
}

describe("Q-SYS cog menu, PIN and auto-return", () => {
  test("the cog menu and the countdown run through the React Compiler here", () => {
    assert.deepEqual(compiled(), ["qsys-cog-menu.tsx", "use-auto-return.ts"]);
  });

  test("cog lists siblings without a PIN; Open Stage Utility asks for it", async () => {
    await open("/qsys/zone-1");
    assert.ok(cog(), "a volunteer panel has no cog");
    fireEvent.click(cog()!);
    await wait(10);
    // Home first, marked; the missing sibling dropped.
    assert.deepEqual(listed(), ["zone-1", "lobby", "booth"]);
    assert.deepEqual(homeHinted(), ["zone-1"]);
    fireEvent.click(q('[data-qsys-cog-panel="lobby"]')!);
    await wait(60);
    assert.deepEqual(where(), { path: "/qsys/lobby", search: { return: "zone-1" } });
    assert.deepEqual(server.checks, [], "a sibling asked for the PIN");

    // Away on the lobby: the same list as at home, never the lobby's own siblings
    // (the nursery): a cog takes a device no further than its home's list.
    fireEvent.click(cog()!);
    await wait(10);
    assert.deepEqual(listed(), ["zone-1", "lobby", "booth"], "away, the cog listed another panel's siblings");
    assert.deepEqual(homeHinted(), ["zone-1"]);
    fireEvent.click(q('[data-qsys-cog-panel="booth"]')!);
    await wait(60);
    assert.deepEqual(where(), { path: "/qsys/booth", search: { return: "zone-1" } }, "a second sibling forgot the way home");

    await openPad();
    assert.equal(q("[data-qsys-pin-pad]")?.dataset.qsysPinPad, "entry");
    await press("1357");
    assert.deepEqual(server.checks, ["1357"]);
    assert.equal(note(), WRONG_PIN_NOTE);
    assert.equal(where().path, "/qsys/booth", "a wrong PIN opened the app");
    await press("2468");
    assert.equal(where().path, "/", "the right PIN did not open the app");
    assert.ok(q("[data-app-home]"));
  });

  test("the home entry goes home with no return", async () => {
    await open("/qsys/lobby?return=zone-1");
    fireEvent.click(cog()!);
    await wait(10);
    fireEvent.click(q('[data-qsys-cog-panel="zone-1"]')!);
    await wait(60);
    assert.deepEqual(where(), { path: "/qsys/zone-1", search: {} });
  });

  test("with no PIN set, Open Stage Utility says to set one on /qsys/manage, takes no digits, and never opens", async () => {
    server.pin = null;
    await open("/qsys/zone-1");
    await openPad();
    assert.equal(note(), NO_PIN_NOTE);
    assert.equal(key("1").hasAttribute("disabled"), true, "the pad took digits with no PIN set");
    fireEvent.click(key("Cancel"));
    await wait(20);
    assert.ok(q("[data-qsys-open-app]"), "Cancel did not go back to the list");
    assert.equal(where().path, "/qsys/zone-1");
  });

  test("a locked answer says how long and takes no digits; only an explicit ok opens", async () => {
    await open("/qsys/zone-1");
    await openPad();
    server.checkAnswer = { status: 200, body: { ok: false, lockedForMs: 60_000 } };
    await press("2468");
    assert.equal(note(), "Too many wrong tries. Try again in 1:00.");
    assert.equal(key("2").hasAttribute("disabled"), true);
    assert.equal(where().path, "/qsys/zone-1");
  });

  test("an answer that is not an explicit yes never opens the app, and a failed check is not called a wrong PIN", async () => {
    await open("/qsys/zone-1");
    await openPad();
    server.checkAnswer = { status: 200, body: {} };
    await press("2468");
    assert.equal(where().path, "/qsys/zone-1", "an empty answer opened the app");
    // Truthy is not yes: only `ok: true` opens.
    for (const ok of ["yes", 1]) {
      server.checkAnswer = { status: 200, body: { ok } };
      await press("2468");
      assert.equal(where().path, "/qsys/zone-1", `ok: ${JSON.stringify(ok)} opened the app`);
    }
    server.checkAnswer = { status: 500, body: { error: "boom" } };
    await press("2468");
    assert.equal(where().path, "/qsys/zone-1");
    assert.notEqual(note(), WRONG_PIN_NOTE, "a failed check read as a wrong PIN");
    assert.match(note(), /Couldn't check the PIN/);
  });

  test("a staff panel opened full screen has no cog", async () => {
    await open("/qsys/booth");
    assert.equal(cog() === null, true, "a staff panel has a cog");
  });

  test("a staff panel a volunteer cog opened has the cog, and the way home, even with no countdown", async () => {
    // Home never calls back (0 min), so there is no banner: the cog is the only way back.
    server.views.push(panel("v-quiet", "Quiet", "volunteer", "quiet", ["booth"], 0));
    await open("/qsys/booth?return=quiet");
    assert.equal(q("[data-qsys-return]") === null, true);
    assert.ok(cog(), "a device a cog took to a staff panel has no way back");
    fireEvent.click(cog()!);
    await wait(10);
    assert.deepEqual(listed(), ["quiet", "booth"]);
    assert.deepEqual(homeHinted(), ["quiet"]);
    fireEvent.click(q('[data-qsys-cog-panel="quiet"]')!);
    await wait(60);
    assert.deepEqual(where(), { path: "/qsys/quiet", search: {} });
  });

  test("a staff panel with any ?return has the cog, even one naming no panel (its own list, as its own home)", async () => {
    await open("/qsys/booth?return=no-such-panel");
    assert.ok(cog(), "a staff panel a cog opened, whose home has gone, has no way out");
    fireEvent.click(cog()!);
    await wait(10);
    assert.deepEqual(homeHinted(), ["booth"]);
  });

  test("away, the countdown is the home panel's, whatever the open panel's own", async () => {
    secondMs = 5; // a minute is 300 ms
    // The booth's own return time is 30 minutes; home's is 1.
    server.views = server.views.map((v) => ((v as { id: string }).id === "v-booth" ? panel("v-booth", "Booth", "staff", "booth", [], 30) : v));
    await open("/qsys/booth?return=zone-1");
    // Counting down from home's minute (a fast second here), not the booth's thirty.
    assert.match(q("[data-qsys-return-countdown]")?.textContent ?? "", /^[01]:\d\d$/);
    await wait(450);
    assert.deepEqual(where(), { path: "/qsys/zone-1", search: {} }, "it did not go home on the home panel's time");
  });

  test("an old address (a panel renamed) opens the panel and puts the URL right, ?return with it", async () => {
    server.views = server.views.map((v) => {
      const id = (v as { id: string }).id;
      if (id === "v-zone") return { ...panel("v-zone", "Zone 1", "volunteer", "zone-one", ["lobby", "booth"]), qsys: { kind: "volunteer", slug: "zone-one", siblings: ["lobby", "booth"], returnAfterMin: 1, aliases: ["zone-1"] } };
      if (id === "v-lobby") return { ...panel("v-lobby", "Lobby", "volunteer", "front", ["nursery"]), qsys: { kind: "volunteer", slug: "front", siblings: ["nursery"], returnAfterMin: 1, aliases: ["lobby"] } };
      return v;
    });
    await open("/qsys/lobby?return=zone-1");
    assert.deepEqual(where(), { path: "/qsys/front", search: { return: "zone-one" } });
    assert.ok(q('[data-qsys-panel="front"]'), "the renamed panel did not open");
    assert.ok(q("[data-qsys-return]"), "the old home address lost the way home");
  });

  test("Escape closes the menu and puts focus back on the cog; the menu is modal and takes focus", async () => {
    await open("/qsys/zone-1");
    fireEvent.click(cog()!);
    await wait(10);
    const menu = q("[data-qsys-cog-menu]")!;
    assert.equal(menu.getAttribute("aria-modal"), "true");
    assert.equal(menu.contains(document.activeElement), true, "focus did not move into the menu");
    // Tab from the last control goes round to the first, never out to the panel.
    const items = [...menu.querySelectorAll("button")];
    items.at(-1)!.focus();
    fireEvent.keyDown(items.at(-1)!, { key: "Tab" });
    assert.equal(document.activeElement === items[0], true, "Tab left the menu");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await wait(10);
    assert.equal(q("[data-qsys-cog-menu]") === null, true, "Escape left the menu open");
    assert.equal(document.activeElement === cog(), true, "focus did not go back to the cog");
  });

  test("Cancel while a right PIN is being checked opens nothing", async () => {
    await open("/qsys/zone-1");
    await openPad();
    // The check answers late: Cancel lands first.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/qsys/pin/check") await gate;
      return real(input, init);
    }) as typeof fetch;
    try {
      for (const d of "246") fireEvent.click(key(d));
      fireEvent.click(key("8"));
      await wait(10);
      fireEvent.click(key("Cancel"));
      release();
      await wait(80);
    } finally {
      globalThis.fetch = real;
    }
    assert.deepEqual(server.checks, ["2468"]);
    assert.equal(where().path, "/qsys/zone-1", "a check answered after Cancel opened the app");
  });

  test("the lock countdown is set in the mono face", async () => {
    await open("/qsys/zone-1");
    await openPad();
    server.checkAnswer = { status: 200, body: { ok: false, lockedForMs: 60_000 } };
    await press("2468");
    assert.equal(q("[data-qsys-pin-lock-countdown]")?.classList.contains("font-mono"), true);
  });

  test("?return with an unknown slug is ignored: no banner, and this panel is home", async () => {
    await open("/qsys/lobby?return=no-such-panel");
    assert.equal(q("[data-qsys-return]") === null, true);
    fireEvent.click(cog()!);
    await wait(10);
    assert.deepEqual(homeHinted(), ["lobby"]);
  });

  test("opening a sibling adds ?return=<home>; after N minutes with no touch it navigates home", async () => {
    secondMs = 5; // a minute is 300 ms
    await open("/qsys/zone-1");
    assert.equal(q("[data-qsys-return]") === null, true, "home counts down to itself");
    fireEvent.click(cog()!);
    await wait(10);
    fireEvent.click(q('[data-qsys-cog-panel="lobby"]')!);
    await wait(60);
    assert.deepEqual(where(), { path: "/qsys/lobby", search: { return: "zone-1" } });
    assert.ok(q("[data-qsys-return]"), "no banner while away");
    await wait(450);
    assert.deepEqual(where(), { path: "/qsys/zone-1", search: {} }, "it did not go home");
    assert.equal(q("[data-qsys-return]") === null, true);
  });

  test("the banner shows m:ss and Go back now returns immediately", async () => {
    await open("/qsys/lobby?return=zone-1");
    const banner = q("[data-qsys-return]");
    assert.ok(banner, "no banner while away");
    assert.equal(banner.textContent?.replace(/\s+/g, " ").trim(), "Going back to Zone 1 in 1:00 unless someone touches the screen.Go back now");
    assert.equal(q("[data-qsys-return-countdown]")?.textContent, "1:00");
    fireEvent.click([...banner.querySelectorAll("button")].find((b) => b.textContent === "Go back now")!);
    await wait(60);
    assert.deepEqual(where(), { path: "/qsys/zone-1", search: {} });
  });

  test("returnAfterMin 0 never returns", async () => {
    secondMs = 5;
    await open("/qsys/lobby?return=never-back");
    assert.equal(q("[data-qsys-return]") === null, true, "a banner counting down to a home that never calls back");
    await wait(450);
    assert.deepEqual(where(), { path: "/qsys/lobby", search: { return: "never-back" } });
  });
});
