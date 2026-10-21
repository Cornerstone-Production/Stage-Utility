// The public ServiceCue viewer, mounted and driven as a visitor would.
//
// Its router (renderer/public/public-router.tsx) over the real ServiceCue pages, in a
// document carrying `data-servicecue-public`, with a stand-in for the Worker: the fetch
// it answers from the docs a church publishes, and the WebSocket it sends frames down.
// jsdom loads no stylesheet and measures nothing, so what the page LOOKS like is not
// asserted here (the screenshots in the PR are that), only what it does: which links it
// draws, which addresses it asks for, what a frame or a changed doc does to it, and when
// it says the church has gone quiet.
//
// The rules of when the church was last heard from are public-live.test.ts's, once; the
// cases here are the notice's own (what it says, where it sits, when it comes and goes)
// and the ones that need a whole page: a church whose clock is wrong, a socket that never
// opens, a doc that changes. The page never asks for an address the Worker has no answer
// for, over every flow below, so a page that began asking for something else fails here
// and not in front of a volunteer.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, mock, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, reply } from "../test-fixtures/fetch-log.js";
import { FakeSocket } from "../test-fixtures/fake-socket.js";

const teardown = installRenderDom();
const g = globalThis as unknown as Record<string, unknown>;
document.documentElement.setAttribute("data-servicecue-public", "");
g.location = { protocol: "https:", host: "servicecue.example.workers.dev", search: "" };
g.WebSocket = FakeSocket;

// jsdom has no matchMedia, and the shell follows the system's light or dark through it.
(window as unknown as Record<string, unknown>).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

// A monotonic clock the test spends: the page's own corrected clock runs off it.
let perfNow = 50_000;
g.performance = { now: () => perfNow };
console.warn = () => {};
console.log = () => {};

const { render, screen, cleanup, act } = await import("@testing-library/react");
const React = await import("react");
const { createMemoryHistory, RouterProvider } = await import("@tanstack/react-router");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { TooltipProvider } = await import("../components/ui/index.js");
const { createPublicRouter } = await import("./public-router.js");
const { StaleNotice } = await import("./stale-notice.js");
const live = await import("../lib/public-live.js");
const pageBuild = await import("../lib/public-build.js");
const { __resetForTests: resetStageState } = await import("../main/use-stage-state.js");
const { __resetReplayCacheForTests } = await import("../lib/api.js");
const { serverClock } = await import("../lib/server-clock.js");
const { formatClock } = await import("../lib/clock-format.js");
const { ASSET_PATH_PREFIX, HEARTBEAT_PATH, PUBLIC_STALE_AFTER_MS, docKeyForRequest } = await import("@main/types/servicecue-publish");

after(() => unmountAndTeardown(cleanup, teardown));

// ── the Worker, as far as the page can tell ───────────────────────────────────

const EDGE = 1_800_000_000_000; // the edge's clock when the page loads
const MINUTE = 60_000;

const STATE = { pcoConfigured: true, timezone: "America/Chicago", hourCycle: "12h", accentColor: null, appLogo: null, appLogoMonochrome: true };
const ITEMS = [
  { id: "i1", title: "Walk-in Playlist", itemType: "media", lengthSec: 600, sequence: 0, notesByCategory: { Audio: "Fade out" }, description: null },
  { id: "s1", title: "Hold Fast", itemType: "song", lengthSec: 270, sequence: 1, notesByCategory: { Band: "Acoustic" }, description: null, songKey: "D" },
  { id: "s2", title: "Better Together", itemType: "song", lengthSec: 285, sequence: 2, notesByCategory: {}, description: null, songKey: "A" },
];
const RUNDOWN = {
  serviceTypeId: "1001",
  planId: "5001",
  planTitle: "Common Ground",
  planSeriesTitle: null,
  planDates: null,
  items: ITEMS,
  noteCategories: ["Audio", "Band"],
  serviceTimes: [new Date(EDGE - 10 * MINUTE).toISOString()],
  timeZone: "America/Chicago",
  isActivePlan: true,
  isDefaultPlan: true,
};
const LAYOUTS = [{ id: "layout-audio", name: "Audio", order: 0, columnRoles: ["role-audio", "role-band"] }];
const ROLES = [
  { id: "role-audio", name: "Audio", members: ["Audio"] },
  { id: "role-band", name: "Band", members: ["Band"] },
];

const requests: { method: string; path: string; search: string }[] = [];
/** How the read of the edge is answered: when the church last sent a heartbeat, and the edge's clock. */
let heartbeatAnswer: () => unknown = () => ok({ at: EDGE - 5_000, now: EDGE });
/** The rundown the Worker holds; a case changes it. */
let rundown: unknown = RUNDOWN;
const countOf = (path: string) => requests.filter((r) => r.path === path).length;

const liveFrame = (itemId: string, startedAgoMs: number, serverNow = EDGE) => ({
  mode: "item",
  currentItemId: itemId,
  label: ITEMS.find((i) => i.id === itemId)!.title,
  itemType: "song",
  lengthSec: 270,
  liveStartAt: new Date(EDGE - startedAgoMs).toISOString(),
  targetAt: null,
  serverNow: new Date(serverNow).toISOString(),
  currentItemTitle: null,
  nextItemTitle: null,
  serviceTimeId: null,
  serviceTimeStartsAt: null,
});

g.fetch = async (input: unknown, init?: RequestInit) => {
  const u = new URL(String(input), "https://servicecue.example.workers.dev");
  requests.push({ method: init?.method ?? "GET", path: u.pathname, search: u.search });
  switch (u.pathname) {
    case "/api/state":
      return ok(STATE);
    case "/api/service-types":
      return ok([{ id: "1001", name: "Weekend" }]);
    case "/api/servicecue/layouts":
      return ok(LAYOUTS);
    case "/api/servicecue/roles":
      return ok(ROLES);
    case "/api/servicecue/config":
      return ok({ serviceTypeIds: ["1001"] });
    case "/api/servicecue/rundown":
      return ok(rundown);
    case "/api/plans/upcoming":
      return ok({ cacheAgeMs: 0, plans: [{ serviceTypeId: "1001", serviceTypeName: "Weekend", planId: "5001", title: "Common Ground", sortDate: new Date(EDGE).toISOString(), dates: "Today", isCurrent: true }] });
    case "/api/pco/live":
      return ok(null);
    case "/api/spl/history/current":
      return ok(null);
    case HEARTBEAT_PATH:
      return heartbeatAnswer();
    default:
      return reply(404, { error: "That is not published" });
  }
};

/**
 * Mount the viewer at `href`, as a fresh page load, and open its socket.
 *
 * A page load is a new document: nothing but the address crosses from the last one,
 * so the transport, the replay cache, the shared state and the clock start again.
 */
async function load(href: string, { socket = true }: { socket?: boolean } = {}) {
  cleanup();
  forgetThePage();
  const router = createPublicRouter(createMemoryHistory({ initialEntries: [href] }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(TooltipProvider, null, React.createElement(RouterProvider, { router })),
    ),
  );
  await settle();
  if (socket) {
    await eventually(() => assert.ok(FakeSocket.instances.length > 0, "the page never opened its socket"));
    await act(async () => FakeSocket.last.open());
    await settle();
  }
  return router;
}

/**
 * Run `body` on a page that is NOT the public one, and leave nothing of it behind.
 *
 * In the church's own mode api.ts arms a 200 ms timer to report its channels to the
 * server every time a subscription comes or goes, and when it fires it posts, whenever
 * that turns out to be: in the NEXT test, if this one has ended first, where it reads
 * as the public page asking for something it must not. So the page is unmounted here,
 * with the flag still off, and the timer waited out, before the flag goes back on.
 */
async function onTheChurchsOwnPage(body: () => Promise<void>) {
  document.documentElement.removeAttribute("data-servicecue-public");
  try {
    await body();
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    document.documentElement.setAttribute("data-servicecue-public", "");
  }
}

/** What a page load throws away: everything the previous document held in memory. */
function forgetThePage() {
  live.__resetPublicLiveForTests();
  __resetReplayCacheForTests();
  resetStageState();
  serverClock.reset();
  FakeSocket.instances = [];
}

/** The Worker sends something on the socket, live unless it is marked a replay. */
const say = (frame: unknown) => act(async () => FakeSocket.last.say(frame));
/** The church's heartbeat, as the Worker sends it: `at` is the edge's clock. */
const beat = (at: number = EDGE) => say({ channel: "publish:heartbeat", data: { at } });
/** Time passes on the page's own clock, and its ticker looks at it. */
const pass = async (ms: number) => {
  perfNow += ms;
  await act(async () => mock.timers.tick(5_000));
};

const linkNamed = (name: string) => screen.queryByRole("link", { name });
const noticeText = () => (screen.queryByRole("status")?.textContent ?? "").replace(/\s+/g, " ").trim();
/** The rows the rundown draws as the live one: its own class, since a table row carries no state of its own to read. */
const liveRows = () => [...document.querySelectorAll("tr, div")].filter((n) => /\bbg-live-9\/10\b/.test(n.className?.toString() ?? ""));

beforeEach(() => {
  perfNow = 50_000;
  heartbeatAnswer = () => ok({ at: EDGE - 5_000, now: EDGE });
  rundown = RUNDOWN;
});
afterEach(() => {
  cleanup();
  mock.timers.reset();
  forgetThePage();
  requests.length = 0;
  document.documentElement.setAttribute("data-servicecue-public", "");
});

describe("what the public page is", () => {
  test("mounts exactly the two ServiceCue pages", () => {
    assert.deepEqual(
      Object.keys(createPublicRouter().routesByPath).sort(),
      ["/servicecue", "/servicecue/$serviceType/$layout"],
      "the router has a route that is not one of the two",
    );
  });
});

describe("the landing page", () => {
  test("lists the service types with their layouts and links each rundown, with no link to edit anything", async () => {
    await load("/servicecue");
    await eventually(() => assert.ok(screen.getByText("Weekend")));
    const open = await eventually(() => screen.getByRole("link", { name: "Open Weekend" }));
    assert.equal(open.getAttribute("href"), "/servicecue/weekend/audio?from=%2Fservicecue");
    assert.equal(linkNamed("Edit column presets"), null, "the public page links to the editor");
    assert.equal(document.querySelector('a[href*="presets"], a[href*="manage"]'), null, "a link into the operator's pages");
  });

  test("it is the flag that hides the link: the same page with the attribute off draws it", async () => {
    await onTheChurchsOwnPage(async () => {
      await load("/servicecue", { socket: false });
      await eventually(() => assert.ok(screen.getByText("Weekend")));
      assert.equal(linkNamed("Edit column presets")?.getAttribute("href"), "/servicecue/presets");
    });
  });
});

describe("a rundown", () => {
  test("is the ServiceCue page: its items, its columns, its plan switcher and its clock", async () => {
    await load("/servicecue/weekend/audio");
    await eventually(() => assert.ok(screen.getByText("Hold Fast")));
    for (const text of ["Walk-in Playlist", "Better Together", "Fade out", "Acoustic"]) assert.ok(screen.getByText(text), text);
    assert.ok(screen.getByRole("combobox", { name: "Layout" }), "no layout switcher");
    assert.ok(screen.getByRole("button", { name: "Larger text" }), "no text size control");
    assert.ok(screen.getByRole("button", { name: "Choose a plan" }), "no plan switcher");
    assert.equal(document.title, "Common Ground · Audio");
  });

  test("a frame on pco:live moves the live highlight, and the next moves it again", async () => {
    await load("/servicecue/weekend/audio");
    await eventually(() => assert.ok(screen.getByText("Hold Fast")));
    assert.equal(liveRows().length, 0, "something was live before any frame");

    await say({ channel: "pco:live", data: liveFrame("s1", 60_000) });
    await eventually(() => assert.equal(liveRows().length, 1));
    assert.match(liveRows()[0]!.textContent ?? "", /Hold Fast/);
    assert.ok(screen.getByText("Live"), "no Live badge");

    await say({ channel: "pco:live", data: liveFrame("s2", 5_000) });
    await eventually(() => assert.match(liveRows()[0]?.textContent ?? "", /Better Together/));
    assert.equal(liveRows().length, 1, "two rows are live");
  });

  test("a frame replayed on connect sets the highlight too: a page opened mid-service does not wait for the next change", async () => {
    await load("/servicecue/weekend/audio");
    await eventually(() => assert.ok(screen.getByText("Hold Fast")));
    await say({ channel: "pco:live", data: liveFrame("s1", 10_000), replay: true });
    await eventually(() => assert.match(liveRows()[0]?.textContent ?? "", /Hold Fast/));
  });
});

describe("what the page asks of the Worker", () => {
  test("only addresses the Worker answers, only by GET: never the church server's events, log, version or settings", async () => {
    await load("/servicecue");
    await eventually(() => assert.ok(screen.getByText("Weekend")));
    await load("/servicecue/weekend/audio");
    await eventually(() => assert.ok(screen.getByText("Hold Fast")));
    await load("/servicecue/weekend/all-columns?plan=5001&text=150");
    await eventually(() => assert.ok(screen.getByText("Hold Fast")));
    await say({ channel: "pco:live", data: liveFrame("s1", 1000) });
    await settle();

    const seen = [...new Set(requests.map((r) => `${r.method} ${r.path}${r.search}`))];
    assert.ok(seen.length >= 8, `the flows did not exercise the page: ${seen.join(", ")}`);
    const unanswered = requests.filter((r) => {
      if (r.method !== "GET") return true;
      if (r.path === HEARTBEAT_PATH) return false;
      if (r.path.startsWith(ASSET_PATH_PREFIX)) return false;
      return docKeyForRequest(r.path, r.search) === null;
    });
    assert.deepEqual(
      unanswered.map((r) => `${r.method} ${r.path}${r.search}`),
      [],
      "the page asked for something the public host has no answer for",
    );
    assert.deepEqual(
      FakeSocket.instances.flatMap((s) => s.sent).filter((m) => m !== "ping"),
      [],
      "the page said something on the socket but ping",
    );
  });

  test("and does not poll the church's event stream whatever its address carries", async () => {
    (g.location as { search: string }).search = "?transport=poll";
    try {
      await load("/servicecue/weekend/audio?transport=poll");
      await eventually(() => assert.ok(screen.getByText("Hold Fast")));
      assert.deepEqual(requests.filter((r) => r.path.startsWith("/api/events")), []);
    } finally {
      (g.location as { search: string }).search = "";
    }
  });
});

describe("a doc that changes", () => {
  const NEW_ITEM = { id: "s3", title: "Still the Same", itemType: "song", lengthSec: 255, sequence: 3, notesByCategory: {}, description: null, songKey: "E" };

  test("is read when the Worker names it, and only then: five minutes with the socket open ask for nothing", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    await load("/servicecue/weekend/audio");
    await eventually(() => assert.ok(screen.getByText("Hold Fast")));
    await settle();
    const before = countOf("/api/servicecue/rundown");

    await act(async () => mock.timers.tick(5 * MINUTE));
    await settle();
    assert.equal(countOf("/api/servicecue/rundown"), before, "a page with a socket read the rundown on the building's minute");

    rundown = { ...RUNDOWN, items: [...ITEMS, NEW_ITEM] };
    await say({ channel: "publish:docs", data: { keys: ["rundown-1001"] } });
    await eventually(() => assert.ok(screen.getByText("Still the Same")));
    assert.equal(countOf("/api/servicecue/rundown"), before + 1, "a changed rundown was read other than once");
  });

  test("the service types are read when their doc is named, and the layouts and roles when either of theirs is", async () => {
    await load("/servicecue/weekend/audio");
    await eventually(() => assert.ok(screen.getByText("Hold Fast")));
    await settle();
    const count = () => ({ types: countOf("/api/service-types"), layouts: countOf("/api/servicecue/layouts"), roles: countOf("/api/servicecue/roles") });
    const before = count();
    await say({ channel: "publish:docs", data: { keys: ["service-types"] } });
    await eventually(() => assert.deepEqual(count(), { ...before, types: before.types + 1 }));
    await say({ channel: "publish:docs", data: { keys: ["servicecue-roles"] } });
    await eventually(() => assert.deepEqual(count(), { types: before.types + 1, layouts: before.layouts + 1, roles: before.roles + 1 }));
  });

  test("is not read for a message that names another doc", async () => {
    await load("/servicecue/weekend/audio");
    await eventually(() => assert.ok(screen.getByText("Hold Fast")));
    await settle();
    const before = { rundown: countOf("/api/servicecue/rundown"), layouts: countOf("/api/servicecue/layouts"), types: countOf("/api/service-types") };
    await say({ channel: "publish:docs", data: { keys: ["rundown-1001-5002", "state", "servicecue-config"] } });
    await settle();
    assert.deepEqual(
      { rundown: countOf("/api/servicecue/rundown"), layouts: countOf("/api/servicecue/layouts"), types: countOf("/api/service-types") },
      before,
    );
  });

  test("the plan list is read again when the plans doc is named", async () => {
    await load("/servicecue/weekend/audio");
    await eventually(() => assert.ok(screen.getByRole("button", { name: "Choose a plan" })));
    await settle();
    const before = countOf("/api/plans/upcoming");
    assert.ok(before >= 1, "the page never read the plan list");
    await say({ channel: "publish:docs", data: { keys: ["plans-upcoming"] } });
    await eventually(() => assert.equal(countOf("/api/plans/upcoming"), before + 1));
  });

  test("everything is read again when the socket reconnects, the docs it was away for included", async () => {
    await load("/servicecue/weekend/audio");
    await eventually(() => assert.ok(screen.getByText("Hold Fast")));
    await settle();
    const before = { rundown: countOf("/api/servicecue/rundown"), layouts: countOf("/api/servicecue/layouts"), types: countOf("/api/service-types") };
    await act(async () => FakeSocket.last.drop());
    await eventually(() => assert.equal(FakeSocket.instances.length, 2, "the page did not reconnect"), 5000);
    await act(async () => FakeSocket.last.open());
    await settle();
    assert.equal(countOf("/api/servicecue/rundown"), before.rundown + 1);
    assert.equal(countOf("/api/servicecue/layouts"), before.layouts + 1);
    assert.equal(countOf("/api/service-types"), before.types + 1);
  });
});

describe('the "Not updating" notice', () => {
  test("is not there while the church is being heard", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    await load("/servicecue/weekend/audio");
    await beat();
    await pass(30_000);
    await beat();
    await pass(30_000);
    await settle();
    assert.equal(noticeText(), "");
  });

  test("says when the church was last heard, in the app's time zone and hour cycle, once it has been silent for two minutes", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    await load("/servicecue/weekend/audio");
    await eventually(() => assert.ok(screen.getByText("Hold Fast")));
    const at = EDGE - 3 * MINUTE;
    await beat(at);
    await pass(2 * MINUTE + 10_000);
    // Read as the page reads it: Intl puts a narrow no-break space before the day
    // period on Linux Node, which the notice text collapses like any other space.
    const expected = formatClock(at, { timeZone: "America/Chicago" }).replace(/\s+/g, " ");
    assert.match(expected, /^\d{1,2}:\d{2} [AP]M$/, "the fixture is supposed to be a 12-hour clock");
    await eventually(() => assert.equal(noticeText(), `Not updating. The last update from the church was at ${expected}. The live item may have moved on.`));
  });

  test("takes a row of its own above the page and covers none of it: not fixed, not absolute, and before the page in the document", async () => {
    // Laid over the page, the bar sat on the back arrow, the plan switcher and the text
    // controls and took the taps meant for them: seen in the browser. jsdom cannot see
    // where a box is, but it can see that nothing here lifts the bar out of the flow.
    mock.timers.enable({ apis: ["setInterval"] });
    await load("/servicecue/weekend/audio");
    await beat();
    await pass(5 * MINUTE);
    const bar = await eventually(() => {
      const found = screen.getByRole("status").firstElementChild;
      assert.ok(found, "no notice");
      return found as HTMLElement;
    });
    assert.doesNotMatch(bar.className, /\b(fixed|absolute|sticky)\b/, "the bar is taken out of the flow and will cover the page");
    const region = screen.getByRole("status");
    const page = document.querySelector("main")!;
    assert.equal(!!(region.compareDocumentPosition(page) & 4 /* DOCUMENT_POSITION_FOLLOWING */), true, "the notice is not above the page");
    assert.ok(!page.contains(region), "the notice is inside the page's own scroller");
  });

  test("goes away by itself when the church is heard again", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    await load("/servicecue/weekend/audio");
    await beat();
    await pass(5 * MINUTE);
    await eventually(() => assert.match(noticeText(), /^Not updating\./));
    await beat(EDGE + 5 * MINUTE);
    await eventually(() => assert.equal(noticeText(), ""));
  });

  test("a page the church has never sent anything to says so in plain words, two minutes after it began watching", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    heartbeatAnswer = () => ok({ at: null, now: EDGE });
    await load("/servicecue/weekend/audio");
    await say({ channel: "publish:heartbeat", data: { at: null, now: EDGE }, replay: true });
    await pass(MINUTE);
    assert.equal(noticeText(), "", "said before two minutes");
    await pass(MINUTE + 10_000);
    await eventually(() => assert.equal(noticeText(), "Not updating. The church has not sent an update yet."));
  });

  test("a page whose socket never opens learns from the Worker over HTTP that the church has gone quiet, and says when", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    heartbeatAnswer = () => ok({ at: EDGE - 7 * MINUTE, now: EDGE });
    await load("/servicecue/weekend/audio", { socket: false });
    await eventually(() => assert.ok(screen.getByText("Hold Fast")));
    assert.equal(FakeSocket.last.readyState, 0, "the socket was supposed never to open");
    // The page reads the edge a few seconds after loading, when no socket has opened.
    await eventually(() => assert.ok(countOf(HEARTBEAT_PATH) >= 1, "the page never asked the Worker"), live.FIRST_READ_AFTER_MS + 3000);
    const expected = formatClock(EDGE - 7 * MINUTE, { timeZone: "America/Chicago" }).replace(/\s+/g, " ");
    await eventually(() => assert.equal(noticeText(), `Not updating. The last update from the church was at ${expected}. The live item may have moved on.`));
  });

  test("a page that can reach the Worker by neither road still says, after two minutes, that it has heard nothing", async () => {
    mock.timers.enable({ apis: ["setInterval"] });
    heartbeatAnswer = () => reply(503, { error: "down" });
    await load("/servicecue/weekend/audio", { socket: false });
    await pass(PUBLIC_STALE_AFTER_MS - 5_000);
    assert.equal(noticeText(), "");
    await pass(10_000);
    await eventually(() => assert.equal(noticeText(), "Not updating. The church has not sent an update yet."));
  });

  for (const [name, skew] of [["fast", 3 * 60 * MINUTE], ["slow", -3 * 60 * MINUTE]] as const) {
    test(`is decided by when things arrived, whatever the church's own clock says: a server three hours ${name}`, async () => {
      mock.timers.enable({ apis: ["setInterval"] });
      // The page's own clock has only the church's word for the time: the Worker cannot be read.
      heartbeatAnswer = () => reply(503, { error: "down" });
      await load("/servicecue/weekend/audio");
      await eventually(() => assert.ok(screen.getByText("Hold Fast")));
      // The church's frames carry its own clock, which runs as the page's does but three hours off.
      const churchSays = () => say({ channel: "pco:live", data: liveFrame("s1", 60_000, EDGE + skew + (perfNow - 50_000)) });
      await churchSays();
      await pass(1_000);
      await churchSays();
      // Two minutes in which the church is heard every thirty seconds: no notice.
      for (let i = 0; i < 4; i++) {
        await pass(30_000);
        await beat();
        await churchSays();
      }
      await settle();
      assert.ok(
        Math.abs(serverClock.now() - (EDGE + skew)) < 10 * MINUTE,
        `the church's clock did not reach the page's (${serverClock.now() - EDGE} ms from the edge's): this proves nothing`,
      );
      assert.equal(noticeText(), "", "a church whose clock is wrong made the page say it had stopped updating");
      // And two minutes of silence is silence, whichever way the church's clock runs.
      await pass(2 * MINUTE + 10_000);
      await eventually(() => assert.match(noticeText(), /^Not updating\./));
    });
  }

  test("takes its threshold as a parameter, and is two minutes by default", async () => {
    // Directly, so a case does not have to wait out two minutes.
    mock.timers.enable({ apis: ["setInterval"] });
    await load("/servicecue/weekend/audio");
    await beat();
    await act(async () => {
      render(React.createElement(StaleNotice, { staleAfterMs: 10_000 }));
    });
    await pass(20_000);
    // Two notices are on the page, in document order: the viewer's own, at the default
    // two minutes, and this one, at ten seconds.
    const [own, short] = await eventually(() => {
      const found = screen.getAllByRole("status");
      assert.equal(found.length, 2);
      return found as [HTMLElement, HTMLElement];
    });
    await eventually(() => assert.match(short.textContent ?? "", /^Not updating\./, "a 10 s threshold did not show a 20 s silence"));
    assert.equal(own.textContent, "", "the viewer's own notice, at two minutes, spoke at 20 s");
  });
});

describe("a page left open across a deploy", () => {
  // That the reload keeps the address (`?plan=`, `?text=`, `?from=`) is location.reload()
  // itself, which jsdom neither does nor lets a test see: it is driven in a browser. What
  // is asserted here is the whole path from a heartbeat to the one reload.
  const OPEN_PAGE = "aaaaaaaaaaaa";
  const DEPLOYED = "bbbbbbbbbbbb";
  const NEXT_DEPLOY = "cccccccccccc";
  const ADDRESS = "/servicecue/weekend/audio?plan=5002&text=2&from=%2Fservicecue";

  let reloads = 0;
  let meta: HTMLElement;
  beforeEach(() => {
    reloads = 0;
    meta = document.createElement("meta");
    meta.setAttribute("name", "servicecue-build");
    meta.setAttribute("content", OPEN_PAGE);
    document.head.append(meta);
    pageBuild.__setReloadForTests(() => void reloads++);
  });
  afterEach(() => {
    pageBuild.__setReloadForTests(null);
    pageBuild.__resetPublicBuildForTests();
    sessionStorage.clear();
    meta.remove();
  });

  /** The Worker says which build it serves, as it does on connect (replay) and on every heartbeat after. */
  const offer = (build: string, replay = true) =>
    say({ channel: "publish:heartbeat", data: { at: EDGE - 5_000, now: EDGE, build }, ...(replay ? { replay: true } : {}) });

  test("reloads once for a build that is not its own, goes nowhere on its own account, and is not reloaded again by the same one", async () => {
    const router = await load(ADDRESS);
    await eventually(() => assert.ok(screen.getByText("Hold Fast")));
    const before = router.state.location.href;
    await offer(DEPLOYED);
    assert.equal(reloads, 1);
    assert.equal(router.state.location.href, before, "the page moved itself instead of reloading where it was");
    assert.match(before, /plan=5002/);
    // The reload brought the same old document back (a cache that has not caught up): a
    // new page load, the tab's storage as it was, hearing the same build named again.
    await load(ADDRESS);
    await offer(DEPLOYED);
    for (let beat = 0; beat < 4; beat++) await offer(DEPLOYED, false);
    assert.equal(reloads, 1, "the page reloaded for a build it had already reloaded for");
    await offer(NEXT_DEPLOY, false);
    assert.equal(reloads, 2, "the next deploy did not get its reload");
  });
});
