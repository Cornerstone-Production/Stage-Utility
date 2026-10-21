// The public page's WebSocket transport, on its own.
//
// What a reader cannot see by inspection: that frames end in the dispatch the page's
// hooks subscribe through and not somewhere beside it; that when the church was last
// heard from is kept on the page's own monotonic clock and nothing else's, from the socket
// and, with none, over HTTP; that a dead socket is replaced and a quiet church is not
// mistaken for one; that every doc is said to have changed after a (re)connect; and that
// nothing is ever written to the Worker but the word "ping".
//
// The socket, the timers, the monotonic clock and fetch are replaced before the module
// is used, so a backoff of thirty seconds is stepped through, not slept. The freshness
// rules live here and only here: the page's own test keeps what is the notice's.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, mock, test } from "node:test";

import { installDom } from "../test-dom.js";
import { FakeSocket } from "../test-fixtures/fake-socket.js";

const teardown = installDom();
after(teardown);

const g = globalThis as unknown as Record<string, unknown>;
g.WebSocket = FakeSocket;

let perfNow = 10_000;
g.performance = { now: () => perfNow };
g.location = { protocol: "https:", host: "servicecue.example.workers.dev", search: "" };
Math.random = () => 0.5; // jitter factor 0.75 + 0.5 * 0.5 = 1: the delay is exactly the backoff

/** Every fetch the transport made, and how the next one is answered. */
const fetches: { url: string; init: RequestInit | undefined }[] = [];
type Answer = () => Promise<{ ok: boolean; status?: number; text: () => Promise<string> }>;
/** The edge's answer to a read: when the church last sent a heartbeat (null: never) and the edge's clock. */
const edge = (at: number | null, now: number): Answer => async () => ({ ok: true, text: async () => JSON.stringify({ at, now }) });
let answer: Answer = edge(null, 5_000_000);
g.fetch = async (url: unknown, init?: RequestInit) => {
  fetches.push({ url: String(url), init });
  return answer();
};

const warnings: string[] = [];
const logs: string[] = [];
console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));

const live = await import("./public-live.js");
const pageBuild = await import("./public-build.js");

interface Delivered {
  channel: string;
  data: unknown;
}
function deps() {
  const delivered: Delivered[] = [];
  const clock: { edgeMs: number; rttMs: number }[] = [];
  const d: import("./public-live.js").PublicLiveDeps = {
    deliver: (channel, data) => void delivered.push({ channel, data }),
    observeClock: (edgeMs, rttMs) => void clock.push({ edgeMs, rttMs }),
  };
  return { d, delivered, clock };
}

/** Let promise callbacks (a read of the edge) run. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

/** A page that has loaded, started its transport and had its socket accepted. */
async function connected() {
  const x = deps();
  live.startPublicLive(x.d);
  FakeSocket.last.open();
  await settle();
  return x;
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
});
afterEach(() => {
  mock.timers.reset();
  perfNow = 10_000;
  live.__resetPublicLiveForTests();
  FakeSocket.instances = [];
  fetches.length = 0;
  warnings.length = 0;
  logs.length = 0;
  (g.location as { protocol: string }).protocol = "https:";
  answer = edge(null, 5_000_000);
});

describe("connecting", () => {
  test("opens one socket to /api/live on the page's own host, wss on https and ws on http, however often it is started", () => {
    const x = deps();
    live.startPublicLive(x.d);
    live.startPublicLive(x.d);
    live.startPublicLive(x.d);
    assert.equal(FakeSocket.instances.length, 1);
    assert.equal(FakeSocket.last.url, "wss://servicecue.example.workers.dev/api/live");

    live.__resetPublicLiveForTests();
    FakeSocket.instances = [];
    (g.location as { protocol: string }).protocol = "http:";
    live.startPublicLive(deps().d);
    assert.equal(FakeSocket.last.url, "ws://servicecue.example.workers.dev/api/live");
  });

  test("a constructor that throws is said once and retried, not given up on", () => {
    const real = g.WebSocket;
    let attempts = 0;
    g.WebSocket = class {
      constructor() {
        attempts++;
        throw new SyntaxError("blocked");
      }
    };
    try {
      live.startPublicLive(deps().d);
      assert.equal(attempts, 1);
      assert.equal(warnings.filter((w) => w.includes("could not open the live connection")).length, 1);
      mock.timers.tick(live.RECONNECT_MIN_MS);
      assert.equal(attempts, 2, "no retry was scheduled");
      mock.timers.tick(live.RECONNECT_MIN_MS * 2);
      assert.equal(attempts, 3);
      assert.equal(warnings.filter((w) => w.includes("could not open the live connection")).length, 1, "a streak is said once");
    } finally {
      g.WebSocket = real;
    }
  });
});

describe("frames", () => {
  test("every frame, on every channel the Worker sends, goes to deliver as (channel, data)", async () => {
    const x = await connected();
    x.delivered.length = 0; // what the open itself said
    FakeSocket.last.say({ channel: "pco:live", data: { mode: "item" } });
    FakeSocket.last.say({ channel: "spl:history", data: null });
    FakeSocket.last.say({ channel: "stage:state-changed", data: { pcoConfigured: true } });
    FakeSocket.last.say({ channel: "publish:heartbeat", data: { at: 5_000_000 } });
    FakeSocket.last.say({ channel: "publish:docs", data: { keys: ["state"] } });
    assert.deepEqual(x.delivered, [
      { channel: "pco:live", data: { mode: "item" } },
      { channel: "spl:history", data: null },
      { channel: "stage:state-changed", data: { pcoConfigured: true } },
      { channel: "publish:heartbeat", data: { at: 5_000_000 } },
      { channel: "publish:docs", data: { keys: ["state"] } },
    ]);
  });

  test("a replayed frame is delivered like any other", async () => {
    const x = await connected();
    x.delivered.length = 0;
    FakeSocket.last.say({ channel: "pco:live", data: { mode: "none" }, replay: true });
    assert.deepEqual(x.delivered, [{ channel: "pco:live", data: { mode: "none" } }]);
  });

  test("a message that is not a frame is ignored, and one that is not JSON is said", async () => {
    const x = await connected();
    x.delivered.length = 0;
    for (const bad of ["pong", '{"channel":"views:changed","data":{}}', '{"data":{}}', "null", "[]", "3", new ArrayBuffer(4)]) {
      FakeSocket.last.say(bad as unknown as string);
    }
    assert.deepEqual(x.delivered, [], "something that is not a frame on a known channel reached the page");
    FakeSocket.last.say("{not json");
    assert.deepEqual(x.delivered, []);
    assert.equal(warnings.filter((w) => w.includes("not JSON")).length, 1);
  });

  test("a frame arriving on a socket the transport has since replaced is ignored", async () => {
    const x = await connected();
    x.delivered.length = 0;
    const first = FakeSocket.last;
    first.drop();
    mock.timers.tick(live.RECONNECT_MIN_MS);
    assert.equal(FakeSocket.instances.length, 2);
    first.say({ channel: "pco:live", data: { stale: true } });
    assert.deepEqual(x.delivered, []);
  });
});

describe("the edge", () => {
  test("is read when the socket opens, over a request whose round trip is measured, to set the page's clock", async () => {
    const x = deps();
    answer = async () => {
      perfNow += 40; // the request leg
      return {
        ok: true,
        text: async () => {
          perfNow += 60; // the response leg
          return JSON.stringify({ at: null, now: 5_000_000 });
        },
      };
    };
    live.startPublicLive(x.d);
    assert.equal(fetches.length, 0, "the clock was read before the socket had opened");
    FakeSocket.last.open();
    await settle();
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0]!.url, "/api/publish/heartbeat");
    assert.deepEqual(fetches[0]!.init, { cache: "no-store" }, "a clock sample must come from the edge now and not a cache");
    assert.deepEqual(x.clock, [{ edgeMs: 5_000_000, rttMs: 100 }]);
  });

  test("is read again after each reconnect, so a phone that slept does not keep a clock from before", async () => {
    const x = await connected();
    FakeSocket.last.drop();
    mock.timers.tick(live.RECONNECT_MIN_MS);
    FakeSocket.last.open();
    await settle();
    assert.equal(x.clock.length, 2);
  });

  test("a read that fails is said, and leaves the page going", async () => {
    const x = deps();
    for (const failing of [
      async () => ({ ok: false, status: 503, text: async () => "" }),
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => ({ ok: true, text: async () => "not json" }),
    ]) {
      warnings.length = 0;
      answer = failing as Answer;
      live.startPublicLive(x.d);
      FakeSocket.last.open();
      await settle();
      assert.equal(warnings.filter((w) => w.includes("could not read the edge")).length, 1);
      live.__resetPublicLiveForTests();
      FakeSocket.instances = [];
    }
    assert.deepEqual(x.clock, [], "a failed read set the clock");
  });

  test("an answer with no `now` sets nothing", async () => {
    const x = deps();
    answer = async () => ({ ok: true, text: async () => JSON.stringify({ at: 5 }) });
    live.startPublicLive(x.d);
    FakeSocket.last.open();
    await settle();
    assert.deepEqual(x.clock, []);
    assert.equal(live.getPublicFreshness().heardAtMono, null);
    assert.equal(live.getPublicFreshness().edgeOffsetMs, null);
  });
});

describe("when the church was last heard from", () => {
  const freshness = () => live.getPublicFreshness();

  test("is nothing heard, and the page watching since it began", () => {
    assert.deepEqual(freshness(), { heardAtMono: null, watchingSinceMono: 10_000, edgeOffsetMs: null });
  });

  test("a live heartbeat is heard as it arrives, and its `at` ties this page's clock to the edge's", async () => {
    await connected();
    perfNow = 12_000;
    FakeSocket.last.say({ channel: "publish:heartbeat", data: { at: 4_000_000 } });
    assert.equal(freshness().heardAtMono, 12_000);
    assert.equal(freshness().edgeOffsetMs, 4_000_000 - 12_000);
    assert.equal(live.edgeTimeOf(12_000), 4_000_000, "the time the notice prints is the heartbeat's own");
    assert.equal(live.edgeTimeOf(42_000), 4_030_000, "and moves with this page's clock, not the visitor's");
  });

  test("so is a live frame on any channel, the Worker's own notice of a doc included", async () => {
    await connected();
    for (const [i, channel] of ["pco:live", "spl:history", "stage:state-changed", "publish:docs"].entries()) {
      perfNow = 20_000 + i * 1000;
      FakeSocket.last.say({ channel, data: { keys: [] } });
      assert.equal(freshness().heardAtMono, perfNow, channel);
    }
  });

  test("a frame replayed on connect is NOT heard: a page opened long after the church went quiet is not news", async () => {
    await connected();
    for (const channel of ["pco:live", "spl:history", "stage:state-changed"]) {
      FakeSocket.last.say({ channel, data: { mode: "item" }, replay: true });
    }
    assert.equal(freshness().heardAtMono, null);
  });

  test("a heartbeat replayed on connect is aged by the edge's own two numbers, `at` against the `now` it came with", async () => {
    await connected();
    perfNow = 20_000;
    FakeSocket.last.say({ channel: "publish:heartbeat", data: { at: 3_940_000, now: 4_000_000 }, replay: true });
    assert.equal(freshness().heardAtMono, 20_000 - 60_000, "a heartbeat a minute old when it was replayed was heard a minute ago");
    assert.equal(live.edgeTimeOf(freshness().heardAtMono!), 3_940_000);
  });

  test("a replay that has never had a heartbeat, or does not say how old it is, hears nothing", async () => {
    await connected();
    FakeSocket.last.say({ channel: "publish:heartbeat", data: { at: null, now: 4_000_000 }, replay: true });
    assert.equal(freshness().heardAtMono, null);
    assert.equal(freshness().edgeOffsetMs, 4_000_000 - 10_000, "but it did say what time the edge keeps");
    FakeSocket.last.say({ channel: "publish:heartbeat", data: { at: 3_940_000 }, replay: true });
    assert.equal(freshness().heardAtMono, null, "an `at` with no `now` is not aged by a clock of the page's own");
  });

  test("a heartbeat that claims to be from the edge's future is heard now, not later", async () => {
    await connected();
    perfNow = 30_000;
    FakeSocket.last.say({ channel: "publish:heartbeat", data: { at: 4_000_500, now: 4_000_000 }, replay: true });
    assert.equal(freshness().heardAtMono, 30_000);
  });

  test("what is heard only ever moves forward: an older reading after a newer one changes nothing", async () => {
    await connected();
    perfNow = 40_000;
    FakeSocket.last.say({ channel: "publish:heartbeat", data: { at: 4_000_000 } });
    FakeSocket.last.say({ channel: "publish:heartbeat", data: { at: 3_000_000, now: 4_000_000 }, replay: true });
    assert.equal(freshness().heardAtMono, 40_000);
  });

  test("the read at open ages `at` the same way, so a page that opens on a quiet church knows how quiet", async () => {
    answer = edge(3_970_000, 4_000_000);
    live.startPublicLive(deps().d);
    FakeSocket.last.open();
    await settle();
    assert.equal(freshness().heardAtMono, 10_000 - 30_000);
    assert.equal(live.edgeTimeOf(freshness().heardAtMono!), 3_970_000);
  });

  test("the visitor's own clock is used for nothing but a time to print when the edge has never given one", async () => {
    const realNow = Date.now;
    Date.now = () => 9_000_000_000_000; // a visitor's clock hours, days, years out
    try {
      assert.equal(live.edgeTimeOf(10_000), 9_000_000_000_000 - 10_000 + 10_000, "no reading from the edge yet");
      await connected();
      FakeSocket.last.say({ channel: "publish:heartbeat", data: { at: 4_000_000 } });
      assert.equal(live.edgeTimeOf(perfNow), 4_000_000);
      assert.equal(freshness().heardAtMono, perfNow, "and it never moved what was heard");
    } finally {
      Date.now = realNow;
    }
  });

  test("subscribers hear every change, and not a change that changed nothing", async () => {
    await connected();
    let heard = 0;
    const off = live.subscribePublicFreshness(() => void heard++);
    perfNow = 11_000;
    FakeSocket.last.say({ channel: "publish:heartbeat", data: { at: 4_000_000 } });
    const first = heard;
    assert.ok(first >= 1);
    FakeSocket.last.say({ channel: "publish:heartbeat", data: { at: 4_000_000 } }); // the same moment, the same reading
    assert.equal(heard, first);
    perfNow = 12_000;
    FakeSocket.last.say({ channel: "pco:live", data: {} });
    assert.ok(heard > first);
    off();
    const after = heard;
    perfNow = 13_000;
    FakeSocket.last.say({ channel: "pco:live", data: {} });
    assert.equal(heard, after, "an unsubscribed listener was still called");
  });

  test("survives the socket being replaced: what was last heard stays heard", async () => {
    await connected();
    perfNow = 15_000;
    FakeSocket.last.say({ channel: "publish:heartbeat", data: { at: 4_000_000 } });
    FakeSocket.last.drop();
    assert.equal(freshness().heardAtMono, 15_000);
  });
});

describe("with no socket", () => {
  test("a page whose socket opens at once reads the edge once, at open, and not again at load", async () => {
    live.startPublicLive(deps().d);
    FakeSocket.last.open();
    await settle();
    mock.timers.tick(live.FIRST_READ_AFTER_MS + 1);
    await settle();
    assert.equal(fetches.length, 1);
  });

  test("a page whose socket has not opened reads the edge a few seconds after loading", async () => {
    answer = edge(3_880_000, 4_000_000);
    live.startPublicLive(deps().d);
    mock.timers.tick(live.FIRST_READ_AFTER_MS - 1);
    await settle();
    assert.equal(fetches.length, 0);
    perfNow = 13_000;
    mock.timers.tick(1);
    await settle();
    assert.equal(fetches.length, 1);
    assert.equal(live.getPublicFreshness().heardAtMono, 13_000 - 120_000, "the church was last heard two minutes before the page asked");
  });

  test("then every minute, for as long as there is no socket, and never while there is one", async () => {
    live.startPublicLive(deps().d);
    mock.timers.tick(live.FIRST_READ_AFTER_MS);
    await settle();
    assert.equal(fetches.length, 1);
    for (let minute = 1; minute <= 3; minute++) {
      mock.timers.tick(live.READ_EVERY_MS);
      await settle();
    }
    assert.ok(fetches.length >= 4, `a page with no socket asked ${fetches.length} times in three minutes`);

    FakeSocket.last.open();
    await settle();
    const withSocket = fetches.length;
    for (let minute = 1; minute <= 10; minute++) {
      mock.timers.tick(live.READ_EVERY_MS);
      await settle();
    }
    assert.equal(fetches.length, withSocket, "a page with a socket read over HTTP as well");
  });

  test("a read that says the church is quiet is how a page that never connects knows it", async () => {
    answer = edge(3_000_000, 4_000_000);
    live.startPublicLive(deps().d);
    mock.timers.tick(live.FIRST_READ_AFTER_MS);
    perfNow = 14_000;
    await settle();
    const { heardAtMono } = live.getPublicFreshness();
    assert.ok(heardAtMono !== null && 14_000 - heardAtMono >= 1_000_000, "the silence was not as long as the edge said");
  });
});

describe("every doc, after a connect", () => {
  test("is said to have changed when the socket opens, the first time as well as after a reconnect", async () => {
    const x = deps();
    live.startPublicLive(x.d);
    assert.equal(x.delivered.length, 0, "said before there was a socket");
    FakeSocket.last.open();
    assert.deepEqual(x.delivered, [{ channel: "publish:docs", data: { keys: [], all: true } }]);
    FakeSocket.last.drop();
    mock.timers.tick(live.RECONNECT_MIN_MS);
    FakeSocket.last.open();
    assert.equal(x.delivered.filter((d) => d.channel === "publish:docs").length, 2);
  });

  test("is not counted as the church being heard from: nothing was heard", async () => {
    await connected();
    assert.equal(live.getPublicFreshness().heardAtMono, null);
  });
});

describe("the build the Worker says it is serving", () => {
  const PAGE = "aaaaaaaaaaaa";
  const NEXT = "bbbbbbbbbbbb";
  let reloads: number;
  let meta: HTMLElement;
  beforeEach(() => {
    reloads = 0;
    meta = document.createElement("meta");
    meta.setAttribute("name", "servicecue-build");
    meta.setAttribute("content", PAGE);
    document.head.append(meta);
    pageBuild.__setReloadForTests(() => void reloads++);
  });
  afterEach(() => {
    pageBuild.__setReloadForTests(null);
    pageBuild.__resetPublicBuildForTests();
    sessionStorage.clear();
    meta.remove();
  });

  test("a heartbeat's build is put to the page's own reload decision, replayed at connect or live", async () => {
    await connected();
    FakeSocket.last.say({ channel: "publish:heartbeat", data: { at: 4_000_000, now: 4_000_000, build: PAGE }, replay: true });
    assert.equal(reloads, 0, "the page's own build was reloaded for");
    FakeSocket.last.say({ channel: "publish:heartbeat", data: { at: 4_030_000, build: NEXT } });
    assert.equal(reloads, 1);
  });

  test("a heartbeat that names none, or names what is not a string, offers nothing, and is still heard", async () => {
    await connected();
    for (const data of [{ at: 1 }, { at: null }, { at: 1, build: 5 }, { at: 1, build: null }, { at: 1, build: {} }, { at: 1, build: [NEXT] }, null, "x"]) {
      FakeSocket.last.say({ channel: "publish:heartbeat", data });
    }
    assert.equal(reloads, 0);
    assert.notEqual(live.getPublicFreshness().heardAtMono, null);
  });

  test("only a heartbeat can offer one: a build field on another channel's data is just data", async () => {
    await connected();
    for (const channel of ["pco:live", "spl:history", "stage:state-changed", "publish:docs"]) {
      FakeSocket.last.say({ channel, data: { build: NEXT } });
      FakeSocket.last.say({ channel, data: { build: NEXT }, replay: true });
    }
    assert.equal(reloads, 0);
  });
});

describe("reconnecting", () => {
  test("a closed socket is replaced after 1 s, then 2, 4, 8, 16 and no more than 30", () => {
    live.startPublicLive(deps().d);
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      FakeSocket.last.drop();
      const before = FakeSocket.instances.length;
      let waited = 0;
      while (FakeSocket.instances.length === before) {
        mock.timers.tick(1000);
        waited += 1000;
        assert.ok(waited <= 31_000, "never reconnected");
      }
      waits.push(waited);
    }
    assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
  });

  test("a connection that opens resets the backoff", () => {
    live.startPublicLive(deps().d);
    for (let i = 0; i < 4; i++) {
      FakeSocket.last.drop();
      mock.timers.tick(30_000);
    }
    FakeSocket.last.open();
    FakeSocket.last.drop();
    const before = FakeSocket.instances.length;
    mock.timers.tick(live.RECONNECT_MIN_MS);
    assert.equal(FakeSocket.instances.length, before + 1, "the next wait was not back at the minimum");
  });

  test("a streak of failures is said once, and the recovery is said", () => {
    live.startPublicLive(deps().d);
    for (let i = 0; i < 4; i++) {
      FakeSocket.last.drop();
      mock.timers.tick(30_000);
    }
    assert.equal(warnings.filter((w) => w.includes("was lost")).length, 1);
    FakeSocket.last.open();
    assert.equal(logs.filter((l) => l.includes("restored after 4")).length, 1);
  });

  test("a tab brought back to the front reconnects at once, without waiting out the backoff it grew while hidden", () => {
    live.startPublicLive(deps().d);
    for (let i = 0; i < 4; i++) {
      FakeSocket.last.drop();
      mock.timers.tick(30_000);
    }
    FakeSocket.last.drop(); // now waiting out 16 s
    const before = FakeSocket.instances.length;
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(FakeSocket.instances.length, before + 1, "still waiting");
    FakeSocket.last.drop();
    mock.timers.tick(live.RECONNECT_MIN_MS);
    assert.equal(FakeSocket.instances.length, before + 2, "the delay was not reset to the minimum");
  });

  test("a tab hidden is left alone", () => {
    live.startPublicLive(deps().d);
    FakeSocket.last.open();
    const before = FakeSocket.instances.length;
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
    } finally {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    }
    assert.equal(FakeSocket.instances.length, before);
    assert.deepEqual(FakeSocket.last.sent, []);
  });
});

describe("telling a dead connection from a quiet church", () => {
  test("an open socket is asked whether anyone is there every 30 s, and is not replaced while it answers", () => {
    live.startPublicLive(deps().d);
    FakeSocket.last.open();
    const socket = FakeSocket.last;
    for (let i = 0; i < 6; i++) {
      perfNow += live.PING_EVERY_MS;
      mock.timers.tick(live.PING_EVERY_MS);
      socket.say("pong");
    }
    assert.deepEqual(socket.sent, ["ping", "ping", "ping", "ping", "ping", "ping"]);
    assert.equal(FakeSocket.instances.length, 1, "a socket that answered was replaced");
  });

  test("a quiet church does not make a connection look dead: the pong answers the page's own ping", () => {
    live.startPublicLive(deps().d);
    FakeSocket.last.open();
    // Ten minutes in which the church sends nothing at all and the socket only ever carries pongs.
    for (let i = 0; i < 20; i++) {
      perfNow += live.PING_EVERY_MS;
      mock.timers.tick(live.PING_EVERY_MS);
      FakeSocket.last.say("pong");
    }
    assert.equal(FakeSocket.instances.length, 1);
    assert.equal(live.getPublicFreshness().heardAtMono, null, "a pong is not the church");
  });

  test("a socket that has said nothing for 75 s, not even a pong, is replaced", () => {
    live.startPublicLive(deps().d);
    FakeSocket.last.open();
    const first = FakeSocket.last;
    perfNow += live.PING_EVERY_MS;
    mock.timers.tick(live.PING_EVERY_MS); // ping 1, unanswered
    perfNow += live.PING_EVERY_MS;
    mock.timers.tick(live.PING_EVERY_MS); // ping 2, unanswered: 60 s of silence
    assert.equal(FakeSocket.instances.length, 1, "replaced too early");
    perfNow += live.PING_EVERY_MS;
    mock.timers.tick(live.PING_EVERY_MS); // 90 s
    assert.equal(first.readyState, 3, "the dead socket was left open");
    assert.equal(warnings.filter((w) => w.includes("nothing arrived")).length, 1);
    mock.timers.tick(live.RECONNECT_MIN_MS);
    assert.equal(FakeSocket.instances.length, 2, "no replacement was opened");
  });

  test("a ping that cannot be sent replaces the socket", () => {
    live.startPublicLive(deps().d);
    FakeSocket.last.open();
    FakeSocket.last.throwOnSend = true;
    perfNow += live.PING_EVERY_MS;
    mock.timers.tick(live.PING_EVERY_MS);
    assert.equal(warnings.filter((w) => w.includes("a ping could not be sent")).length, 1);
    mock.timers.tick(live.RECONNECT_MIN_MS);
    assert.equal(FakeSocket.instances.length, 2);
  });

  test("a tab brought back to the front asks at once", () => {
    live.startPublicLive(deps().d);
    FakeSocket.last.open();
    document.dispatchEvent(new Event("visibilitychange"));
    assert.deepEqual(FakeSocket.last.sent, ["ping"]);
  });

  test("pinging stops when the socket goes", () => {
    live.startPublicLive(deps().d);
    FakeSocket.last.open();
    const first = FakeSocket.last;
    first.drop();
    perfNow += live.PING_EVERY_MS * 3;
    mock.timers.tick(live.PING_EVERY_MS * 3);
    assert.deepEqual(first.sent, [], "a closed socket was written to");
  });
});

describe("what it writes", () => {
  test("the word ping, and a GET of the heartbeat: nothing else, ever", async () => {
    await connected();
    for (let i = 0; i < 3; i++) {
      perfNow += live.PING_EVERY_MS;
      mock.timers.tick(live.PING_EVERY_MS);
      FakeSocket.last.say("pong");
      FakeSocket.last.say({ channel: "pco:live", data: { mode: "item" } });
    }
    assert.ok(FakeSocket.last.sent.length > 0);
    assert.deepEqual([...new Set(FakeSocket.last.sent)], ["ping"]);
    assert.deepEqual(
      fetches.map((f) => `${f.init?.method ?? "GET"} ${f.url}`),
      ["GET /api/publish/heartbeat"],
    );
  });
});
