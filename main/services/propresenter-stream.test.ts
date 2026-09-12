// The held ProPresenter status stream: its framing, its fallback, and its
// liveness.
//
// Every case runs against a REAL http.createServer on an ephemeral port that
// speaks ProPresenter's own wire format — chunked, CRLF-framed, `event:` names
// exactly as 21.3 sends them, and the 1Hz `timer/system_time` heartbeat. The
// service dials it with `http.request`, so what the stub receives is what a booth
// machine would have received. Nothing here knows the address of a real one, and
// nothing in this file streams from one.
//
// The event names in WIRE below are transcribed from a capture of the real
// subscription on ProPresenter 21.3, and they are the point of half this file.
// They are NOT the names that were subscribed:
//
//   subscribed                  arrives as
//   status/slide                /v1/status/slide
//   timers/current              /v1/timers/current
//   playlist/active             /v1/playlist/active
//   timer/system_time           /v1/timer/system_time
//   presentation/slide_index    v1/presentation/slide_index   (no leading slash)
//   presentation/active         v1/presentation/current       (renamed, too)
//
// Three ways to get the dispatch wrong, and each loses a different half of the
// dashboard. The document fixture is a faithful copy of the real shape (15
// groups, 7 arrangements, `current_arrangement` as a bare uuid, `arrangements[]
// .groups` as a list of group uuids) with synthetic names, because the shape is
// what buildStatus reads and the church's song list is not this repo's business.
//
// Timing: frames are fed for real and read back through getStatus(), so every
// wait is a poll-until-true with a bound rather than a fixed sleep.

import assert from "node:assert/strict";
import { afterEach, after, before, describe, it } from "node:test";
import * as http from "node:http";

import { propresenterService, propresenterManager } from "./propresenter-service.js";
import { addBroadcastListener, setSubscriberCheck } from "./broadcaster.js";
import { SSE_MAX_BUFFER } from "./sse-reader.js";
import type { ProPresenterStatusDTO } from "../types/stage.js";

// THE unattended appliance. Without this the broadcaster fails open — its
// documented behaviour before a transport registers a check — and the fallback
// poll's demand gate reads "somebody is watching" for the whole file, which is
// the one state that gate cannot be wrong in.
setSubscriberCheck(() => false);

/** Stands in for an in-process consumer of `propresenter:status`. There is no
 *  real one today; the fallback poll's gate has to be right before there is. */
let ppWanted = false;
propresenterService.addDemandSource(() => ppWanted);

// ── The wire ─────────────────────────────────────────────────────────────────

/** Event names exactly as ProPresenter 21.3 sends them. See the header. */
const WIRE = {
  slide: "/v1/status/slide",
  slideIndex: "v1/presentation/slide_index",
  active: "v1/presentation/current",
  playlist: "/v1/playlist/active",
  timers: "/v1/timers/current",
  heartbeat: "/v1/timer/system_time",
} as const;

/** One SSE block, CRLF-framed the way the capture was. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
}

const PRESENTATION_UUID = "11111111-1111-4111-8111-111111111111";
const ARRANGEMENT_UUID = "22222222-2222-4222-8222-222222222222";
const PLAYLIST_UUID = "33333333-3333-4333-8333-333333333333";

const BLACK = { red: 0, green: 0, blue: 0, alpha: 1 };
const RED = { red: 1, green: 0, blue: 0, alpha: 1 };

/** Groups in document order, with a slide count each, as the real doc has. */
const GROUPS = [
  { name: "Intro", uuid: "g-intro", color: BLACK, texts: [""] },
  { name: "Verse 1", uuid: "g-v1", color: RED, texts: ["line one", "line two"] },
  { name: "Chorus 1", uuid: "g-c1", color: RED, texts: ["chorus one", "chorus two"] },
];

/** The `presentation/active` document, in ProPresenter's own shape. */
function presentationDoc(padTo = 0): unknown {
  const groups = GROUPS.map((g) => ({
    name: g.name,
    color: g.color,
    uuid: g.uuid,
    slides: g.texts.map((text) => ({ enabled: true, notes: "", text, label: "", size: 0 })),
  }));
  const doc = {
    presentation: {
      id: { uuid: PRESENTATION_UUID, name: "Opening Song", index: 4 },
      groups,
      has_timeline: false,
      presentation_path: "",
      destination: "presentation",
      arrangements: [
        { id: { uuid: ARRANGEMENT_UUID, name: "Full Song", index: 0 }, groups: GROUPS.map((g) => g.uuid) },
      ],
      current_arrangement: ARRANGEMENT_UUID,
      type: "presentation",
      is_authorized: true,
      // Only used by the buffer-cap case: a field long enough to push one frame
      // past a cap, standing in for a sermon deck's worth of notes.
      ...(padTo ? { presentation_path: "x".repeat(padTo) } : {}),
    },
  };
  return doc;
}

/** Total slides across the arrangement — what slideCount has to come out as. */
const TOTAL_SLIDES = GROUPS.reduce((n, g) => n + g.texts.length, 0);

const SLIDE_FRAME = {
  current: { text: "line one", notes: "", uuid: "s-1" },
  next: { text: "line two", notes: "", uuid: "s-2" },
};
const SLIDE_INDEX_FRAME = {
  presentation_index: {
    index: 1,
    presentation_id: { uuid: PRESENTATION_UUID, name: "Opening Song", index: 4 },
  },
};
/** The NEXT slide, one group on: index 3 is "Chorus 1"'s first slide. Together
 *  with ADVANCED_INDEX this is one advance, which ProPresenter sends as two
 *  frames — and publishing between them is a frame nobody should ever see. */
const ADVANCED_SLIDE = {
  current: { text: "chorus one", notes: "", uuid: "s-4" },
  next: { text: "chorus two", notes: "", uuid: "s-5" },
};
const ADVANCED_INDEX = {
  presentation_index: {
    index: 3,
    presentation_id: { uuid: PRESENTATION_UUID, name: "Opening Song", index: 4 },
  },
};
const PLAYLIST_FRAME = {
  presentation: {
    playlist: { uuid: PLAYLIST_UUID, name: "Sunday", index: 3 },
    item: { uuid: "i-1", name: "Opening Song", index: 1 },
  },
  announcements: { playlist: null, item: null, playlist_item: null },
};
const TIMERS_FRAME = [
  { id: { uuid: "t-1", name: "Countdown", index: 0 }, time: "00:05:00", state: "running" },
  { id: { uuid: "t-2", name: "Reflection", index: 1 }, time: "00:03:00", state: "stopped" },
];
const PLAYLIST_ITEMS = {
  items: [
    { id: { uuid: "i-1", name: "Opening Song", index: 1 } },
    { id: { uuid: "i-2", name: "Message", index: 2 } },
  ],
};

// ── The stub ─────────────────────────────────────────────────────────────────

let server: http.Server;
let port = 0;

/** Every request the stub saw, as "METHOD path". */
let seen: string[] = [];
/** What the stub answers the subscription with. 200 holds a stream. */
let subscribeStatus = 200;
/** What `/v1/playlist/<uuid>` answers — 404 is what a PCO-linked playlist does. */
let playlistStatus = 200;
/** Held subscription responses, so a case can push frames or hang up. */
let streams: http.ServerResponse[] = [];
/** Heartbeat ticker, armed per held stream. */
let heartbeats: ReturnType<typeof setInterval>[] = [];
/** Send the heartbeat on a new stream? Off is a stream that has gone dead. */
let heartbeatOn = true;
/** Send the six-frame snapshot burst on subscribe, as the real one does? */
let burstOn = true;
/** Accept the subscribe connection and then never answer it at all. */
let stallSubscribe = false;
/** Accept the subscribe connection and then kill the socket, unanswered. */
let resetSubscribe = false;
/** Sockets held open by a stalled subscribe, closed in the reset. */
let stalled: http.ServerResponse[] = [];
/** The body of the last subscription request, so a case can read the endpoints. */
let lastSubscribeBody = "";
/** Hold every /version response until releaseVersion(), parking a connect on it. */
let holdVersion = false;
/** The /version responses currently parked. */
let heldVersion: http.ServerResponse[] = [];
/** Delay on `/v1/playlist/<uuid>`, so a case can hold a real request in flight. */
let playlistDelayMs = 0;
/** When each `/v1/playlist/<uuid>` read reached the stub — the back-off's own
 *  deadlines, measured rather than written by the test. */
let playlistReadAt: number[] = [];

/** Answer every parked /version, letting the connects behind them resume. */
function releaseVersion(): void {
  const parked = heldVersion;
  heldVersion = [];
  for (const res of parked) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ host_description: "ProPresenter 21.3", api_version: "v1" }));
  }
}

/** Push a chunk to every held stream. */
function push(chunk: string): void {
  for (const res of streams) res.write(chunk);
}

/** The snapshot burst ProPresenter sends the moment a subscription opens. */
function snapshotBurst(doc: unknown = presentationDoc()): string {
  return (
    frame(WIRE.slideIndex, SLIDE_INDEX_FRAME) +
    frame(WIRE.slide, SLIDE_FRAME) +
    frame(WIRE.timers, TIMERS_FRAME) +
    frame(WIRE.playlist, PLAYLIST_FRAME) +
    frame(WIRE.heartbeat, 1789176690) +
    frame(WIRE.active, doc)
  );
}

before(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "";
    seen.push(`${req.method} ${url}`);

    if (url === "/version") {
      // Parked, not answered: this is the await a connect() sits on while a
      // reconfigure restarts the instance underneath it.
      if (holdVersion) {
        heldVersion.push(res);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ host_description: "ProPresenter 21.3", api_version: "v1" }));
      return;
    }

    if (req.method === "POST" && url.startsWith("/v1/status/updates")) {
      lastSubscribeBody = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => (lastSubscribeBody += c));
      if (stallSubscribe) {
        // Connected, and then nothing: no status line, no headers, no body.
        stalled.push(res);
        return;
      }
      if (resetSubscribe) {
        // Connected, then the socket dies before any response — a machine that
        // answered /version and went away between the two requests.
        res.destroy();
        return;
      }
      if (subscribeStatus < 200 || subscribeStatus >= 300) {
        res.writeHead(subscribeStatus);
        res.end();
        return;
      }
      // 21.3 answers with `transfer-encoding: chunked` and NO content-type.
      res.writeHead(200, { Connection: "close" });
      streams.push(res);
      res.on("close", () => {
        streams = streams.filter((s) => s !== res);
      });
      if (burstOn) res.write(snapshotBurst());
      if (heartbeatOn) {
        // The real heartbeat: once a second, whatever else is happening. Sped up
        // so a watchdog case does not spend fifteen seconds waiting for silence.
        const tick = setInterval(() => res.write(frame(WIRE.heartbeat, Date.now() / 1000 | 0)), 25);
        heartbeats.push(tick);
        res.on("close", () => clearInterval(tick));
      }
      return;
    }

    if (url.startsWith("/v1/playlist/") && url !== "/v1/playlist/active") {
      playlistReadAt.push(Date.now());
      const answer = (): void => {
        if (playlistStatus !== 200) {
          res.writeHead(playlistStatus);
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(PLAYLIST_ITEMS));
      };
      if (playlistDelayMs) setTimeout(answer, playlistDelayMs);
      else answer();
      return;
    }

    // The endpoints the FALLBACK poll asks for, one GET each.
    const pollBodies: Record<string, unknown> = {
      "/v1/presentation/active": presentationDoc(),
      "/v1/status/slide": SLIDE_FRAME,
      "/v1/presentation/slide_index": SLIDE_INDEX_FRAME,
      "/v1/playlist/active": PLAYLIST_FRAME,
      "/v1/timers/current": TIMERS_FRAME,
    };
    if (url in pollBodies) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(pollBodies[url]));
      return;
    }

    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  propresenterService.stop();
  propresenterManager.apply(null, []);
  for (const t of heartbeats) clearInterval(t);
  for (const s of streams) s.destroy();
  console.log = realLog;
  console.warn = realWarn;
  await new Promise<void>((r) => server.close(() => r()));
});

// ── Log capture ──────────────────────────────────────────────────────────────
//
// Three of the log lines below are the deliverable, not decoration: an operator
// debugging a blank stage display on a Sunday reads exactly these. Captured for
// the whole file rather than per case, both to assert on them and to keep a
// reconnect case from writing forty lines into the run.

const realLog = console.log;
const realWarn = console.warn;
let logged: string[] = [];
console.log = (...a: unknown[]) => logged.push(a.map(String).join(" "));
console.warn = (...a: unknown[]) => logged.push(a.map(String).join(" "));

const loggedMatching = (re: RegExp): string[] => logged.filter((l) => re.test(l));

// ── Broadcast capture ────────────────────────────────────────────────────────
//
// Every frame that actually went out on "propresenter:status", in order. The bus
// has no listener removal, so this is registered once for the file and cleared
// per case, exactly as the log capture is. Two of the cases below assert on the
// COUNT: a coalescing window and a serialised publish are both invisible in the
// final state and visible only in how many frames reached the channel.

let published: ProPresenterStatusDTO[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === "propresenter:status") published.push(payload as ProPresenterStatusDTO);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Comfortably past PUBLISH_COALESCE_MS plus a round trip to the stub. */
const PUBLISH_SETTLE_MS = 60;

interface Reachable {
  streamIdleMs: number;
  streamFallback: boolean;
  playlistRetryAt: number;
  playlistRetryBaseMs: number;
  playlistRetryMaxMs: number;
  pollMs: number;
  req: unknown;
  scheduleIn(ms: number): void;
  connect(): Promise<void>;
  running: boolean;
}
/** The private fields a case needs to reach. Reaching in beats exporting a
 *  test-only setter: every one of these is an implementation detail. */
const inner = (svc: unknown): Reachable => svc as Reachable;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it is true, or fail with `what`. Bounded, never a bare sleep. */
async function until(what: string, fn: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(5);
  }
  assert.fail(`timed out after ${ms}ms waiting for: ${what}`);
}

const status = (): ProPresenterStatusDTO => propresenterService.getStatus();
const subscribes = (): string[] => seen.filter((s) => s.startsWith("POST /v1/status/updates"));
const polls = (): string[] =>
  seen.filter((s) => s.startsWith("GET /v1/") && !s.startsWith("GET /v1/playlist/3"));

/** Configure the primary at the stub and wait until its stream is up. */
async function streaming(): Promise<void> {
  propresenterService.configure("127.0.0.1", port);
  await until("the subscription to reach the stub", () => streams.length > 0);
}

/** Reset everything a case can have changed. */
afterEach(() => {
  propresenterService.stop();
  propresenterManager.apply(null, []);
  for (const t of heartbeats) clearInterval(t);
  heartbeats = [];
  for (const s of streams) s.destroy();
  streams = [];
  seen = [];
  logged = [];
  published = [];
  playlistReadAt = [];
  subscribeStatus = 200;
  playlistStatus = 200;
  playlistDelayMs = 0;
  heartbeatOn = true;
  burstOn = true;
  stallSubscribe = false;
  resetSubscribe = false;
  holdVersion = false;
  for (const r of heldVersion) r.destroy();
  heldVersion = [];
  for (const s of stalled) s.destroy();
  stalled = [];
  propresenterService.configure("", 0);
  propresenterService.stop();
});

// ── The framing ──────────────────────────────────────────────────────────────

describe("the event name ProPresenter actually sends", () => {
  it("fills the whole DTO from one snapshot burst", async () => {
    await streaming();
    await until("the burst to publish", () => status().currentSlideText === "line one");

    const s = status();
    // Every field, because each one comes from a different frame and a dispatch
    // that matched the SUBSCRIBED names ("status/slide", "presentation/active")
    // rather than the version-prefixed ones on the wire matches none of them and
    // leaves all of this null.
    assert.equal(s.connected, true);
    assert.equal(s.currentSlideText, "line one");
    assert.equal(s.nextSlideText, "line two");
    assert.equal(s.slideIndex, 2, "presentation/slide_index did not land");
    assert.equal(s.slideCount, TOTAL_SLIDES, "the presentation document did not land");
    assert.deepEqual(s.currentSection, { name: "Verse 1", colorHex: "#ff0000" });
    assert.equal(s.currentServiceItem, "Opening Song", "playlist/active did not land");
    assert.deepEqual(
      s.timers.map((t) => t.name),
      ["Countdown"],
      "timers/current did not land (only the running one is published)",
    );
  });

  it("accepts the two presentation frames that carry NO leading slash", async () => {
    // Four of the six frames are "/v1/x" and these two are "v1/x". A dispatch
    // that normalised by stripping a required "/v1/" loses exactly the frames
    // that drive sections, slide count and progress — and the other four still
    // land, so the panel looks alive while half of it is blank.
    heartbeatOn = false;
    burstOn = false;
    await streaming();
    push(frame(WIRE.slide, SLIDE_FRAME));
    push(frame("v1/presentation/slide_index", SLIDE_INDEX_FRAME));
    push(frame("v1/presentation/current", presentationDoc()));
    await until("the un-slashed frames to publish", () => status().slideCount != null);

    const s = status();
    assert.equal(s.slideIndex, 2);
    assert.equal(s.slideCount, TOTAL_SLIDES);
    assert.equal(s.slidesRemaining, TOTAL_SLIDES - 2);
    assert.deepEqual(s.currentSection, { name: "Verse 1", colorHex: "#ff0000" });
  });

  it("reads the document from presentation/CURRENT, which is not what was subscribed", async () => {
    // The subscription asks for "presentation/active". The frame comes back named
    // "presentation/current" — a different endpoint name for the same 14KB
    // document. Keying the dispatch on the subscribed name is the natural way to
    // write this and it never matches.
    heartbeatOn = false;
    burstOn = false;
    await streaming();
    assert.match(
      seen.find((s) => s.startsWith("POST")) ?? "",
      /status\/updates\?sse/,
      "the subscription is not the ?sse form, so the event names would be un-prefixed",
    );
    push(frame(WIRE.slide, SLIDE_FRAME));
    push(frame("v1/presentation/current", presentationDoc()));
    await until("the document to publish", () => status().currentItem != null);
    assert.equal(status().currentItem, "Opening Song");
    assert.equal(status().slideCount, TOTAL_SLIDES);
  });

  it("subscribes to all six endpoints, heartbeat included, and says so", async () => {
    await streaming();
    await until("the subscription body to arrive", () => lastSubscribeBody !== "");
    // timer/system_time is the heartbeat the watchdog counts. Dropping it from
    // the list is silent — the panel still works — right up to the Sunday a dead
    // stream is never noticed.
    assert.deepEqual(JSON.parse(lastSubscribeBody), [
      "status/slide",
      "presentation/slide_index",
      "presentation/active",
      "playlist/active",
      "timers/current",
      "timer/system_time",
    ]);
    assert.deepEqual(loggedMatching(/streaming 6 endpoints from 127\.0\.0\.1:/).length, 1);
  });

  // NOT GUARDED, deliberately: handleStreamEvent returns early on
  // `timer/system_time` so a heartbeat does not rebuild the DTO once a second.
  // A guard for it was written, and it stayed GREEN with the early return
  // deleted and `case "timer/system_time": break;` added to the switch — the
  // natural wrong way to write it. Nothing observable changes, because emit()
  // already drops an unchanged frame: the rev does not advance, no broadcast goes
  // out, and no request is made. The only cost is CPU — playOrderSections over
  // the whole document, once a second, per instance — which no assertion here can
  // see. Rather than ship a thirteenth vacuous guard, the guard was deleted and
  // this note left in its place.
});

// ── The point of the change ──────────────────────────────────────────────────

describe("a held stream costs no requests", () => {
  it("makes two requests to connect and none at all thereafter", async () => {
    await streaming();
    await until("the burst to publish", () => status().currentSlideText === "line one");
    // /version, the subscribe, and one playlist read for the items list.
    const atRest = [...seen];
    assert.deepEqual(
      atRest,
      ["GET /version", "POST /v1/status/updates?sse", `GET /v1/playlist/${PLAYLIST_UUID}`],
      "connecting cost more than the probe, the subscribe and one playlist read",
    );

    // Twenty slide advances — the busiest thing a service does.
    for (let i = 0; i < 20; i++) {
      push(frame(WIRE.slide, { current: { text: `line ${i}`, notes: "" }, next: null }));
    }
    await until("the last slide to publish", () => status().currentSlideText === "line 19");
    await sleep(120); // long enough for the old poll to have fired twice

    assert.deepEqual(
      seen,
      atRest,
      `the stream made ${seen.length - atRest.length} further requests — the poll it replaced ` +
        "made six a cycle, and the whole point of holding a stream is that the steady state is zero",
    );
  });

  it("holds the stream open with nobody watching at all", async () => {
    // This REVERSES the poll's demand gate on purpose. With no browser and no
    // in-process consumer, the old code dropped to a five-second keepalive poll;
    // an idle stream is cheaper than that, so it simply stays up.
    await streaming();
    await until("the burst to publish", () => status().currentSlideText === "line one");
    assert.equal(streams.length, 1);

    push(frame(WIRE.slide, { current: { text: "unwatched", notes: "" }, next: null }));
    await until(
      "an unwatched instance to keep publishing",
      () => status().currentSlideText === "unwatched",
    );
    assert.equal(streams.length, 1, "the stream was dropped when nobody was watching");
  });
});

// ── The fallback ─────────────────────────────────────────────────────────────

describe("a ProPresenter that refuses the subscription", () => {
  it("falls back to the poll, and the poll works", async () => {
    subscribeStatus = 404;
    propresenterService.configure("127.0.0.1", port);
    await until("the poll to publish", () => status().currentSlideText === "line one");

    // The fallback is a real path, not a comment: the five GETs went out and the
    // DTO they build is the same one the stream builds.
    assert.deepEqual(polls().sort(), [
      "GET /v1/playlist/active",
      "GET /v1/presentation/active",
      "GET /v1/presentation/slide_index",
      "GET /v1/status/slide",
      "GET /v1/timers/current",
    ]);
    const s = status();
    assert.equal(s.slideCount, TOTAL_SLIDES);
    assert.deepEqual(s.currentSection, { name: "Verse 1", colorHex: "#ff0000" });
    assert.equal(s.currentServiceItem, "Opening Song");
  });

  it("says which status refused it, once", async () => {
    subscribeStatus = 501;
    propresenterService.configure("127.0.0.1", port);
    await until("the poll to publish", () => status().currentSlideText === "line one");
    assert.deepEqual(loggedMatching(/status\/updates unsupported/), [
      "[propresenter] status/updates unsupported (HTTP 501) — falling back to polling",
    ]);
  });

  it("stops re-asking: one refused subscribe, then polls only", async () => {
    subscribeStatus = 404;
    propresenterService.configure("127.0.0.1", port);
    await until("the poll to publish", () => status().currentSlideText === "line one");
    seen = [];
    // Drive two more cycles by hand rather than waiting out the poll interval.
    await inner(propresenterService).connect();
    await inner(propresenterService).connect();
    assert.deepEqual(
      subscribes(),
      [],
      "every poll cycle re-asked for a subscription the machine has already refused",
    );
  });

  it("a transport failure on the subscribe is an outage, NOT an unsupported endpoint", async () => {
    // The distinction matters: pinning the fallback on a machine that merely went
    // away would leave it polling for the rest of the run once it came back. The
    // stub answers /version and then kills the subscribe socket unanswered, which
    // is what a machine rebooting between the two requests does.
    resetSubscribe = true;
    Object.defineProperty(propresenterService, "reconnectBaseMs", {
      get: () => 30,
      configurable: true,
    });
    try {
      propresenterService.configure("127.0.0.1", port);
      await until("the killed subscribe to be retried", () => subscribes().length >= 2);

      assert.equal(
        inner(propresenterService).streamFallback,
        false,
        "a machine that went away was written off as too old to stream — it will poll " +
          "for the rest of the run even once it is back",
      );
      const unsupported = loggedMatching(/unsupported/);
      assert.equal(
        unsupported.length,
        0,
        `an outage was logged as an unsupported endpoint: ${JSON.stringify(unsupported)}`,
      );
      // And it really is retried as a subscribe, not silently downgraded.
      assert.deepEqual(polls(), [], "it fell back to polling instead of re-dialling the stream");
    } finally {
      delete (propresenterService as unknown as Record<string, unknown>).reconnectBaseMs;
    }
  });

  it("a subscribe that fails leaves no dead request handle behind", async () => {
    // The unsupported branch forgets `req` with a comment explaining why. The
    // failed branch did not, and it is the same situation: the caller is about
    // to back off and re-dial, and endStream's ONLY guard is that `stream` and
    // `req` are both null — a late event on a handle left in place tears down
    // and schedules a second reconnect racing the one connect() just armed.
    //
    // The late event itself cannot be staged against a stub, so what is asserted
    // is the invariant it depends on: a subscribe that produced no stream leaves
    // no handle behind. One connect() is driven by hand rather than through the
    // retry loop, because the retry installs a fresh handle within 30ms.
    resetSubscribe = true;
    propresenterService.configure("127.0.0.1", port);
    propresenterService.stop(); // no automatic retry racing the assertion
    const svc = inner(propresenterService);
    svc.running = true;
    await svc.connect();
    const leftBehind = svc.req;
    propresenterService.stop();

    assert.equal(
      leftBehind,
      null,
      "the failed subscribe left its dead request handle in place, so a late " +
        "event on it reaches endStream and schedules a reconnect on top of the " +
        "one the failure already scheduled",
    );
  });

  it("the fallback poll still backs off when nobody is watching", async () => {
    // The demand gate the stream drops still belongs on this path: it really does
    // make five requests a cycle. This is the case demand-gating.test.ts points at
    // now that ProPresenter is out of its table.
    subscribeStatus = 404;
    propresenterService.configure("127.0.0.1", port);
    await until("the poll to publish", () => status().currentSlideText === "line one");

    const svc = inner(propresenterService);
    /** One real poll, reporting the delay it chose next. The timer is never armed
     *  (a live poll against the stub would run for the rest of the file) but the
     *  expression that CHOOSES the delay — the gate — runs for real. */
    const scheduledDelayMs = async (): Promise<number> => {
      const original = svc.scheduleIn.bind(svc);
      let scheduled: number | null = null;
      svc.scheduleIn = (ms: number) => {
        scheduled = ms;
      };
      try {
        await svc.connect();
      } finally {
        svc.scheduleIn = original;
      }
      if (scheduled === null) {
        assert.fail("the fallback poll scheduled nothing at all — it never reached the gate");
      }
      return scheduled;
    };

    ppWanted = false;
    const idle = await scheduledDelayMs();
    ppWanted = true;
    const active = await scheduledDelayMs();
    ppWanted = false;

    assert.ok(
      active < idle,
      `the fallback poll scheduled ${active}ms with a consumer and ${idle}ms with none — ` +
        "the gate is gone from the one path that still makes five requests a cycle",
    );
  });
});

// ── Liveness ─────────────────────────────────────────────────────────────────

describe("a stream that has died without saying so", () => {
  it("is noticed, and re-dialled", async () => {
    // The failure this exists for: a half-open socket — the booth Mac unplugged,
    // its switch port dropped — emits neither 'end' nor 'error'. Nothing closes,
    // nothing errors, and the stage display shows the slide from before the drop
    // for the rest of the service.
    heartbeatOn = false; // a stream that is up, and silent
    Object.defineProperty(propresenterService, "reconnectBaseMs", {
      get: () => 30,
      configurable: true,
    });
    inner(propresenterService).streamIdleMs = 150;
    try {
      await streaming();
      await until("the burst to publish", () => status().currentSlideText === "line one");
      assert.equal(subscribes().length, 1);

      await until(
        "the silent stream to be given up on and re-dialled",
        () => subscribes().length >= 2,
      );
      assert.deepEqual(loggedMatching(/stream ended \(no heartbeat for \d+s\) — reconnecting in \d+s/).length, 1);
    } finally {
      inner(propresenterService).streamIdleMs = 15_000;
      delete (propresenterService as unknown as Record<string, unknown>).reconnectBaseMs;
    }
  });

  it("a heartbeat keeps it alive through a silent sermon", async () => {
    // The other half, and why the watchdog may exist at all: subscribing only to
    // slow-changing endpoints and then timing out on silence would reconnect
    // through every quiet stretch. `timer/system_time` is what makes the timer
    // safe, and the stub ticks it the way ProPresenter does.
    inner(propresenterService).streamIdleMs = 150;
    try {
      await streaming();
      await until("the burst to publish", () => status().currentSlideText === "line one");
      await sleep(500); // >3x the watchdog, with nothing but heartbeats
      assert.equal(
        subscribes().length,
        1,
        "the watchdog fired on a healthy stream — every quiet stretch is a reconnect",
      );
    } finally {
      inner(propresenterService).streamIdleMs = 15_000;
    }
  });

  it("a stream the far end closes is re-dialled, and logged once", async () => {
    Object.defineProperty(propresenterService, "reconnectBaseMs", {
      get: () => 30,
      configurable: true,
    });
    try {
      await streaming();
      await until("the burst to publish", () => status().currentSlideText === "line one");
      for (const s of streams) s.end();
      await until("the closed stream to be re-dialled", () => subscribes().length >= 2);
      assert.ok(
        loggedMatching(/stream ended \(.*\) — reconnecting in \d+s/).length >= 1,
        "a stream ended with nothing in the log to read",
      );
    } finally {
      delete (propresenterService as unknown as Record<string, unknown>).reconnectBaseMs;
    }
  });

  it("a peer that accepts the connection and never answers does not wedge it", async () => {
    // No response headers, ever — a machine mid-crash, or a proxy that connected
    // upstream and stalled. Without a deadline on the HEADERS the subscribe
    // promise never settles: connect() never returns, nothing is scheduled, and
    // the instance sits there for the rest of the service with nothing in the log.
    //
    // The deadline is on the headers and NOT `timeout:` on the request, because
    // that is a socket-inactivity timer and would kill a healthy stream every
    // time the stage went quiet.
    subscribeStatus = 204; // unused; the handler below never replies at all
    stallSubscribe = true;
    Object.defineProperty(propresenterService, "reconnectBaseMs", {
      get: () => 30,
      configurable: true,
    });
    try {
      propresenterService.configure("127.0.0.1", port);
      await until(
        "the stalled subscribe to give up and re-dial",
        () => subscribes().length >= 2,
        12_000,
      );
    } finally {
      delete (propresenterService as unknown as Record<string, unknown>).reconnectBaseMs;
    }
  });

  it("stopping a connecting instance does not log an outage", async () => {
    // stop() destroys the in-flight request, which reaches the same catch a dead
    // machine does. A deliberate shutdown writing "unreachable — backing off" is
    // a false alarm in the one place an operator goes looking for real ones.
    propresenterService.configure("127.0.0.1", port);
    propresenterService.stop();
    await sleep(200);
    const cried = loggedMatching(/unreachable/);
    assert.equal(
      cried.length,
      0,
      `stopping the integration wrote an outage to the log: ${JSON.stringify(cried)}`,
    );
  });

  it("stopping the service leaves no timer and no socket behind", async () => {
    await streaming();
    await until("the burst to publish", () => status().currentSlideText === "line one");
    propresenterService.stop();
    await until("the stub to see the subscription close", () => streams.length === 0);
    seen = [];
    await sleep(150);
    assert.deepEqual(seen, [], "a stopped instance kept dialling");
  });
});

// ── How many publishes, and when ─────────────────────────────────────────────
//
// Three cases about an async gap. None of them changes the state the panel ends
// up in, so none can be seen through getStatus(): they are visible only in how
// many requests went out and how many frames reached the channel.

describe("one run, one publish at a time", () => {
  it("a reconfigure inside the version round trip leaves exactly one stream", async () => {
    // configure() is restart(), which is `stop(); start()` SYNCHRONOUSLY:
    // `running` goes false and back to true inside one tick. A connect() parked
    // on the /version await resumes, sees `running === true`, and subscribes
    // with the host and port it captured before the reconfigure. subscribe()
    // overwrites `stream` and `req`, and whichever assignment loses is never
    // destroyed — closeStream() only knows the last pair. The booth machine is
    // then holding a second server-sent-event stream for the life of the
    // process, its data handler still feeding the same frame buffer.
    //
    // The manager calls configure() on EVERY settings write, a bare
    // poll-interval edit included, so the window is one round trip wide.
    holdVersion = true;
    propresenterService.configure("127.0.0.1", port);
    await until("the first connect to park on /version", () => heldVersion.length === 1);
    propresenterService.configure("127.0.0.1", port, 900); // the poll-interval edit
    await until("the second connect to park on /version", () => heldVersion.length === 2);

    holdVersion = false;
    releaseVersion(); // both parked connects resume

    await until("a stream to be held", () => streams.length > 0);
    await sleep(200); // room for the abandoned run to open a second one

    assert.equal(
      subscribes().length,
      1,
      "two subscriptions went out for one instance — the run the reconfigure " +
        "abandoned resumed anyway and opened a stream nothing will ever close",
    );
    assert.equal(streams.length, 1, "the stub is holding a second, orphaned stream");
  });

  it("holds one publish at a time across a real playlist request", async () => {
    // queuePublish nulls its timer BEFORE publish() runs, so a frame arriving
    // while publish is inside the playlist fetch starts a second publish beside
    // the first. In the steady state that fetch resolves in a microtask and
    // nothing interleaves, which is why no other case here catches it — but the
    // moment the playlist changes there is a real request in flight, and both
    // publishes read an identifier neither has recorded yet: two identical
    // requests, both emitting, and if the first is slower the OLDER frame
    // broadcasts last.
    playlistDelayMs = 250;
    burstOn = false;
    heartbeatOn = false;
    await streaming();

    push(frame(WIRE.playlist, PLAYLIST_FRAME)); // the change → one playlist read
    await until("the playlist read to reach the stub", () => playlistReadAt.length === 1);
    // Frames keep arriving while it is in flight. A service does not pause.
    for (let i = 0; i < 5; i++) {
      push(frame(WIRE.slide, { current: { text: `line ${i}`, notes: "" }, next: null }));
      await sleep(30);
    }
    await until("the delayed playlist to land", () => status().nextServiceItem === "Message");
    await sleep(PUBLISH_SETTLE_MS);

    assert.equal(
      playlistReadAt.length,
      1,
      `one playlist change cost ${playlistReadAt.length} identical requests — publishes ran ` +
        "concurrently across the fetch, each reading an identifier the other had not recorded",
    );
    // And nothing was dropped to get there: re-queued, not discarded.
    assert.equal(
      status().currentSlideText,
      "line 4",
      "the frames that arrived during the fetch were dropped rather than re-queued",
    );
  });

  it("collapses a slide advance into ONE frame, never the mismatched half of one", async () => {
    // A slide advance is status/slide AND presentation/slide_index, sent as two
    // frames. Publishing between them broadcasts the new words against the
    // previous index — wrong section, wrong progress — and because the channel
    // is change-driven that frame really does reach every display and sits
    // there until something else changes.
    burstOn = false;
    heartbeatOn = false;
    await streaming();
    push(
      frame(WIRE.active, presentationDoc()) +
        frame(WIRE.slide, SLIDE_FRAME) +
        frame(WIRE.slideIndex, SLIDE_INDEX_FRAME),
    );
    await until("the first slide to publish", () => status().slideIndex === 2);
    await sleep(PUBLISH_SETTLE_MS);
    published = [];

    // The advance, as ProPresenter sends it.
    push(frame(WIRE.slide, ADVANCED_SLIDE) + frame(WIRE.slideIndex, ADVANCED_INDEX));
    await until("the advance to publish", () => status().slideIndex === 4);
    await sleep(PUBLISH_SETTLE_MS);

    assert.deepEqual(
      published.map((f) => [f.currentSlideText, f.slideIndex, f.currentSection?.name]),
      [["chorus one", 4, "Chorus 1"]],
      "the advance reached the channel as more than one frame, and the first of " +
        "them carries the new slide text against the previous index and section",
    );
  });
});

// ── A frame this app cannot read ─────────────────────────────────────────────

describe("a frame that will not parse", () => {
  /** One block the reader frames correctly and JSON.parse cannot finish. */
  const truncated = (event: string): string =>
    `event: ${event}\r\ndata: {"current":{"text":\r\n\r\n`;

  it("says which endpoint, why, and from where — once per stream", async () => {
    // The degrade is right: one endpoint going stale must not drop a healthy
    // stream. The message is the deliverable. Without the reason an operator
    // cannot tell a truncated frame from a schema change, without the address
    // they cannot tell which auditorium, and without the once-per-stream bound
    // a schema change writes a line per slide advance for the whole service.
    burstOn = false;
    heartbeatOn = false;
    await streaming();
    for (let i = 0; i < 4; i++) {
      push(truncated(WIRE.slide));
      await sleep(20);
    }
    // Everything else still lands: the stream was not dropped over it.
    push(frame(WIRE.active, presentationDoc()) + frame(WIRE.slideIndex, SLIDE_INDEX_FRAME));
    await until("the readable frames to publish", () => status().slideCount != null);

    const lines = loggedMatching(/unreadable/);
    assert.equal(
      lines.length,
      1,
      `logged ${lines.length} times, not once — a malformed frame arrives on every ` +
        `slide advance: ${JSON.stringify(lines)}`,
    );
    assert.match(
      lines[0],
      /^\[propresenter\] unreadable status\/slide frame from 127\.0\.0\.1:\d+ \(.+\) —/,
      "the line does not carry the endpoint, the address and the reason",
    );
    assert.match(lines[0], /JSON/, "the parse error itself is not in the line");
    assert.equal(streams.length, 1, "an unreadable frame dropped the whole stream");
    assert.equal(status().slideCount, TOTAL_SLIDES);
  });

  it("says it again for a different endpoint, and again on a new stream", async () => {
    // Per endpoint, because a schema change on the document must not be hidden
    // by one on the slide; and per stream, because a re-dial is a fresh chance
    // for the operator to see it.
    burstOn = false;
    heartbeatOn = false;
    Object.defineProperty(propresenterService, "reconnectBaseMs", {
      get: () => 30,
      configurable: true,
    });
    try {
      await streaming();
      push(truncated(WIRE.slide) + truncated(WIRE.timers));
      await until("both endpoints to be reported", () => loggedMatching(/unreadable/).length === 2);

      for (const st of streams) st.end();
      await until("the stream to be re-dialled", () => subscribes().length >= 2);
      await until("the new stream to be held", () => streams.length === 1);
      push(truncated(WIRE.slide));
      await until("the new stream to report it too", () => loggedMatching(/unreadable/).length === 3);
    } finally {
      delete (propresenterService as unknown as Record<string, unknown>).reconnectBaseMs;
    }
  });
});

// ── The buffer cap ───────────────────────────────────────────────────────────

describe("the presentation document against the reader's buffer cap", () => {
  it("delivers a document larger than the shared default cap", async () => {
    // presentation/active carries every group, slide, note and arrangement. The
    // shared reader DROPS an unterminated run once it passes its cap, so a cap
    // below the real document size loses the one frame that drives sections,
    // slide count and progress — silently, with the rest of the panel alive.
    burstOn = false;
    heartbeatOn = false;
    await streaming();
    const big = presentationDoc(SSE_MAX_BUFFER + 50_000);
    assert.ok(
      JSON.stringify(big).length > SSE_MAX_BUFFER,
      "the fixture is not actually bigger than the default cap",
    );
    push(frame(WIRE.slide, SLIDE_FRAME));
    push(frame(WIRE.active, big));
    await until("the oversized document to publish", () => status().slideCount != null);
    assert.equal(status().slideCount, TOTAL_SLIDES);
  });
});

// ── The playlist that cannot be read ─────────────────────────────────────────

describe("a playlist the API refuses", () => {
  /** Every `/v1/playlist/<uuid>` read — NOT `/v1/playlist/active`, which is a frame. */
  const playlistReads = (): string[] => seen.filter((s) => s === `GET /v1/playlist/${PLAYLIST_UUID}`);

  /** Push one playlist frame and wait for the publish it causes to settle. */
  async function frameAndSettle(): Promise<void> {
    push(frame(WIRE.playlist, PLAYLIST_FRAME));
    await sleep(PUBLISH_SETTLE_MS);
  }

  it("is read once, not once per frame, for as long as it keeps failing", async () => {
    // The bug: the uuid was recorded only on the success path, so the "has the
    // playlist changed?" guard never became false and the read went out again on
    // every single cycle, for ever. A Planning Center linked playlist answers 404
    // here, so the failing branch is a normal Sunday and not an outage.
    playlistStatus = 404;
    burstOn = false;
    heartbeatOn = false;
    await streaming();

    for (let i = 0; i < 8; i++) await frameAndSettle();

    assert.deepEqual(
      playlistReads(),
      [`GET /v1/playlist/${PLAYLIST_UUID}`],
      `a playlist that 404s was read ${playlistReads().length} times in eight frames — ` +
        "the failure is not recorded, so it is retried for ever with no back-off",
    );
  });

  it("says so once, with the reason and the address", async () => {
    playlistStatus = 404;
    burstOn = false;
    heartbeatOn = false;
    await streaming();
    for (let i = 0; i < 4; i++) await frameAndSettle();

    const lines = loggedMatching(/playlist unreadable/);
    assert.equal(lines.length, 1, `logged ${lines.length} times, not once`);
    assert.match(lines[0], /HTTP 404/);
    assert.match(lines[0], /127\.0\.0\.1:/);
    assert.match(lines[0], /retrying in 30s/);
  });

  it("still publishes everything else, with no next item", async () => {
    // The read is not rethrown: failing the whole status frame because one
    // optional field could not be resolved would blank the slide and the timers
    // with it. The failure comes back as `nextServiceItem: null`.
    playlistStatus = 404;
    await streaming();
    await until("the burst to publish", () => status().currentSlideText === "line one");
    const s = status();
    assert.equal(s.currentServiceItem, "Opening Song");
    assert.equal(s.nextServiceItem, null);
    assert.equal(s.slideCount, TOTAL_SLIDES, "the rest of the frame was lost with the playlist");
  });

  it("does retry once the back-off comes due, and recovers", async () => {
    // The consumer half: the deadline is written here rather than waited out, so
    // this covers the `retryDue` read and the clearing on success. The producer
    // that sets the deadline is guarded separately above.
    playlistStatus = 404;
    burstOn = false;
    heartbeatOn = false;
    await streaming();
    await frameAndSettle();
    assert.equal(playlistReads().length, 1);

    // Bring the retry forward rather than waiting thirty seconds for it.
    inner(propresenterService).playlistRetryAt = Date.now() - 1;
    playlistStatus = 200;
    await frameAndSettle();
    assert.equal(playlistReads().length, 2, "the back-off never came due — one failure is permanent");
    await until("the recovered playlist to publish", () => status().nextServiceItem === "Message");

    // Recovered: the back-off is cleared, so the cache is a cache again.
    for (let i = 0; i < 4; i++) await frameAndSettle();
    assert.equal(playlistReads().length, 2, "a recovered playlist is being re-read every frame");
  });

  it("sets the deadline itself, doubles it, and stops at the ceiling", async () => {
    // The producer half. resolveServiceItems SETS playlistRetryAt and reads it
    // one frame later; the case below writes the field itself, so it exercises
    // only the read half — replacing the line that sets the deadline with
    // `= 0` left all of this file green. Here the real deadlines are allowed to
    // elapse, shortened the way the idle watchdog is, and what is asserted is
    // the gaps between the reads the STUB saw.
    //
    // A Planning Center linked playlist 404s, which the docs describe as the
    // normal Sunday, so a producer that never comes due is not an edge case: it
    // is the next-item name staying null for the rest of the run.
    const BASE = 200;
    const CEILING = 500; // reached at the third failure — 200, 400, 800 capped
    const SLACK = 150; // a deadline is noticed on the next frame, not on the dot
    playlistStatus = 404;
    burstOn = false;
    heartbeatOn = false;
    await streaming();

    const svc = inner(propresenterService);
    svc.playlistRetryBaseMs = BASE;
    svc.playlistRetryMaxMs = CEILING;
    // The retry is frame-driven, so something has to keep sending frames.
    const ticker = setInterval(() => push(frame(WIRE.playlist, PLAYLIST_FRAME)), 10);
    try {
      await until("five playlist reads to come due", () => playlistReadAt.length >= 5, 6000);
    } finally {
      clearInterval(ticker);
      svc.playlistRetryBaseMs = 30_000;
      svc.playlistRetryMaxMs = 10 * 60_000;
    }

    const gaps = playlistReadAt.slice(1).map((at, i) => at - playlistReadAt[i]);
    const wanted = [BASE, BASE * 2, CEILING, CEILING];
    wanted.forEach((want, i) => {
      const why =
        `retry ${i + 2} came ${gaps[i]}ms after retry ${i + 1}, not ${want}ms. ` +
        `All four gaps: ${gaps.join(", ")}ms, against ${wanted.join(", ")}ms — ` +
        "the deadline is set by resolveServiceItems, doubles per consecutive " +
        "failure, and stops at the ceiling rather than reaching 800 and 1600";
      assert.ok(gaps[i] >= want, why);
      assert.ok(gaps[i] < want + SLACK, why);
    });
  });

  it("a DIFFERENT playlist is read at once, not after the broken one's back-off", async () => {
    // The operator switching to a readable playlist must not be made to wait out
    // a timer set by the one that failed.
    playlistStatus = 404;
    burstOn = false;
    heartbeatOn = false;
    await streaming();
    await frameAndSettle();
    assert.equal(playlistReads().length, 1);

    playlistStatus = 200;
    const other = "44444444-4444-4444-8444-444444444444";
    push(
      frame(WIRE.playlist, {
        presentation: {
          playlist: { uuid: other, name: "Second", index: 4 },
          item: { uuid: "i-1", name: "Opening Song", index: 1 },
        },
      }),
    );
    await until(
      "the new playlist to be read immediately",
      () => seen.includes(`GET /v1/playlist/${other}`),
      1000,
    );
  });
});

// ── Multi-instance ───────────────────────────────────────────────────────────

describe("two auditoriums, each on its own stream", () => {
  it("a second instance that is off does not disturb the first", async () => {
    await streaming();
    // Port 9 is discard: nothing listens, which is a booth machine switched off.
    propresenterManager.apply("MA", [
      { id: "chapel", name: "Chapel", host: "127.0.0.1", port: 9, enabled: true },
    ]);
    await sleep(150);
    push(frame(WIRE.slide, { current: { text: "still here", notes: "" }, next: null }));
    await until(
      "the reachable instance to keep publishing",
      () => status().currentSlideText === "still here",
    );
    assert.equal(streams.length, 1, "the primary's stream was dropped by the other instance");
    assert.equal(propresenterManager.getInstancesDto().status.chapel?.connected, false);
    assert.equal(propresenterManager.getInstancesDto().status.default.connected, true);
  });

  it("each instance holds its own stream", async () => {
    await streaming();
    propresenterManager.apply("MA", [
      { id: "chapel", name: "Chapel", host: "127.0.0.1", port, enabled: true },
    ]);
    await until("both subscriptions to be held", () => streams.length === 2);
    assert.equal(subscribes().length, 2);
  });
});
