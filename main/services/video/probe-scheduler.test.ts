// probe-scheduler.test.ts — when the cameras are asked, and what is published.
// A fake timer, fake demand and a fake probe: the scheduler's own decisions
// only. The probe itself is probe.test.ts's, and what the log says about an
// answer is video-service-probe.test.ts's.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { VideoFeed, VideoProbeState } from "../../types/video.js";
import type { ProbeResult, ProbeTarget } from "./probe.js";
import { PROBE_INTERVAL_MS, ProbeScheduler } from "./probe-scheduler.js";

const pull = (id: string, url = `rtsp://192.0.2.${id.length}:554/${id}`, username = ""): VideoFeed => ({
  id,
  name: id,
  source: { kind: "pull", url, username },
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

function harness(feeds: VideoFeed[]) {
  const h = {
    demand: false,
    enabled: true,
    feeds,
    ready: new Set<string>(),
    dialling: new Set<string>(),
    /** When set, a read waits for it: how a test holds loadFeeds or getPassword open. */
    feedsGate: null as Promise<void> | null,
    passwordGate: null as Promise<void> | null,
    passwords: new Map<string, string>(),
    /** What each address answers; a function lets a test hold an answer open. */
    answers: new Map<string, ProbeResult | (() => Promise<ProbeResult>)>(),
    asked: [] as ProbeTarget[],
    published: [] as VideoProbeState[],
    reported: [] as { id: string; state: string }[],
    roundErrors: [] as unknown[],
    roundsOk: 0,
    tick: null as (() => void) | null,
    timersSet: 0,
    timersCleared: 0,
    now: 1_000,
  };
  const scheduler = new ProbeScheduler({
    inDemand: () => h.demand,
    isEnabled: () => h.enabled,
    // What each read saw is taken BEFORE its gate, so a held read returns
    // what was true when it began, as a real slow read would.
    loadFeeds: async () => {
      const list = h.feeds;
      await h.feedsGate;
      return list;
    },
    getPassword: async (id) => {
      const password = h.passwords.get(id);
      await h.passwordGate;
      return password;
    },
    isReady: (id) => h.ready.has(id),
    isDialling: (id) => h.dialling.has(id),
    probe: async (target) => {
      h.asked.push(target);
      const a = h.answers.get(target.url) ?? { state: "ready", codec: "H264", width: 1280, height: 720 };
      return typeof a === "function" ? a() : a;
    },
    publish: (state) => h.published.push(structuredClone(state)),
    onResult: (feed, result) => h.reported.push({ id: feed.id, state: result.state }),
    onRoundError: (err) => h.roundErrors.push(err),
    onRoundOk: () => h.roundsOk++,
    setInterval: (fn, ms) => {
      assert.equal(ms, PROBE_INTERVAL_MS);
      h.tick = fn;
      h.timersSet++;
      return {} as NodeJS.Timeout;
    },
    clearInterval: () => {
      h.tick = null;
      h.timersCleared++;
    },
    now: () => h.now,
  });
  const subscribe = (on: boolean) => {
    h.demand = on;
    scheduler.subscriptionsChanged();
  };
  return { h, scheduler, subscribe };
}

test("with nobody subscribed, no probe runs and no timer is set", async () => {
  const { h, scheduler, subscribe } = harness([pull("a")]);
  subscribe(false);
  await settle();
  assert.equal(h.asked.length, 0);
  assert.equal(h.timersSet, 0);
  assert.deepEqual(scheduler.current().feeds, {});
});

test("the first subscriber starts a probe at once, and one every 15 s after", async () => {
  const { h, subscribe } = harness([pull("a"), pull("b")]);
  subscribe(true);
  await settle();
  assert.equal(h.asked.length, 2, "both feeds asked straight away, in parallel");
  assert.equal(h.timersSet, 1);

  h.tick!();
  await settle();
  assert.equal(h.asked.length, 4, "a tick asks every feed again");
  h.tick!();
  await settle();
  assert.equal(h.asked.length, 6);
});

test("a second subscriber does not start a second timer or an extra round", async () => {
  const { h, subscribe } = harness([pull("a")]);
  subscribe(true);
  await settle();
  subscribe(true);
  await settle();
  assert.equal(h.timersSet, 1);
  assert.equal(h.asked.length, 1);
});

test("the last subscriber leaving stops the timer at once and clears what was learned", async () => {
  const { h, scheduler, subscribe } = harness([pull("a")]);
  subscribe(true);
  await settle();
  assert.equal(scheduler.current().feeds.a?.state, "ready");

  subscribe(false);
  assert.equal(h.timersCleared, 1);
  assert.equal(h.tick, null, "no timer is left to fire");
  assert.deepEqual(scheduler.current().feeds, {});
  assert.deepEqual(h.published.at(-1)?.feeds, {}, "late clients are told it is gone");

  await settle();
  assert.equal(h.asked.length, 1, "nothing asked after it stopped");
});

test("an answer that lands after the page left is dropped, not published or logged", async () => {
  let release!: (r: ProbeResult) => void;
  const { h, scheduler, subscribe } = harness([pull("a", "rtsp://192.0.2.1/slow")]);
  h.answers.set("rtsp://192.0.2.1/slow", () => new Promise<ProbeResult>((resolve) => (release = resolve)));
  subscribe(true);
  await settle();
  assert.equal(scheduler.current().feeds.a?.state, "checking");
  subscribe(false);
  release({ state: "failed", reason: "late" });
  await settle();
  assert.deepEqual(scheduler.current().feeds, {});
  assert.deepEqual(h.reported, []);
});

test("a feed starts at checking, and becomes ready with its codec and size", async () => {
  const { h, scheduler, subscribe } = harness([pull("a", "rtsp://192.0.2.1/a")]);
  let release!: (r: ProbeResult) => void;
  h.answers.set("rtsp://192.0.2.1/a", () => new Promise<ProbeResult>((resolve) => (release = resolve)));
  subscribe(true);
  await settle();
  assert.deepEqual(scheduler.current().feeds.a, { state: "checking", checkedAt: 1000 });
  h.now = 5_000;
  release({ state: "ready", codec: "H264", width: 1920, height: 1080 });
  await settle();
  assert.deepEqual(scheduler.current().feeds.a, { state: "ready", codec: "H264", width: 1920, height: 1080, checkedAt: 5000 });
  assert.deepEqual(h.reported, [{ id: "a", state: "ready" }]);
});

test("a busy camera keeps what it showed, and nothing is published or logged for it", async () => {
  const { h, scheduler, subscribe } = harness([pull("a", "rtsp://192.0.2.1/a")]);
  subscribe(true);
  await settle();
  const ready = scheduler.current().feeds.a;
  assert.equal(ready?.state, "ready");
  const published = h.published.length;
  h.answers.set("rtsp://192.0.2.1/a", { state: "busy" });
  h.now = 20_000;
  h.tick!();
  await settle();
  assert.deepEqual(scheduler.current().feeds.a, ready);
  assert.equal(h.published.length, published);
  assert.deepEqual(h.reported, [{ id: "a", state: "ready" }]);
});

test("a failure carries its reason, and `since` holds from the first failed answer while it keeps failing", async () => {
  const { h, scheduler, subscribe } = harness([pull("a", "rtsp://192.0.2.1/a")]);
  h.answers.set("rtsp://192.0.2.1/a", { state: "failed", reason: "No answer from 192.0.2.1 for this path · check the address and path" });
  subscribe(true);
  await settle();
  assert.deepEqual(scheduler.current().feeds.a, {
    state: "failed",
    reason: "No answer from 192.0.2.1 for this path · check the address and path",
    checkedAt: 1000,
    since: 1000,
  });
  h.now = 16_000;
  h.tick!();
  await settle();
  const entry = scheduler.current().feeds.a!;
  assert.equal(entry.checkedAt, 16_000, "checkedAt moves with every answer");
  assert.equal(entry.since, 1000, "since does not");

  h.answers.set("rtsp://192.0.2.1/a", { state: "ready" });
  h.now = 31_000;
  h.tick!();
  await settle();
  h.answers.set("rtsp://192.0.2.1/a", { state: "failed", reason: "again" });
  h.now = 46_000;
  h.tick!();
  await settle();
  assert.equal(scheduler.current().feeds.a!.since, 46_000, "a new failure after a recovery starts a new run");
});

test("every answer is published, so a new checkedAt reaches the page", async () => {
  const { h, subscribe } = harness([pull("a")]);
  subscribe(true);
  await settle();
  const before = h.published.length;
  h.now = 16_000;
  h.tick!();
  await settle();
  assert.ok(h.published.length > before, "an unchanged result still published for its checkedAt");
  assert.equal(h.published.at(-1)!.feeds.a!.checkedAt, 16_000);
});

test("a feed the relay reports ready is not probed, and its old result is kept unseen", async () => {
  const { h, scheduler, subscribe } = harness([pull("live"), pull("idle")]);
  h.ready.add("live");
  subscribe(true);
  await settle();
  assert.deepEqual(h.asked.map((t) => t.url), [pull("idle").source.kind === "pull" ? (pull("idle").source as { url: string }).url : ""]);
  assert.equal(scheduler.current().feeds.live, undefined, "no entry invented for a feed never probed");

  // It was probed once, then went live, then stopped: the entry waits for the next round.
  h.ready.delete("live");
  h.tick!();
  await settle();
  assert.equal(scheduler.current().feeds.live?.state, "ready");
  h.ready.add("live");
  const askedBefore = h.asked.length;
  h.tick!();
  await settle();
  assert.equal(h.asked.length, askedBefore + 1, "only the idle feed is asked while the other is live");
  assert.equal(scheduler.current().feeds.live?.state, "ready", "its last result is untouched");
});

test("an SRT feed is never probed; it is published as unchecked, once", async () => {
  const { h, scheduler, subscribe } = harness([pull("srt", "srt://192.0.2.9:9000")]);
  subscribe(true);
  await settle();
  assert.equal(h.asked.length, 0);
  assert.deepEqual(scheduler.current().feeds.srt, { state: "unchecked", checkedAt: 1000 });
  const published = h.published.length;
  h.now = 16_000;
  h.tick!();
  await settle();
  assert.equal(h.published.length, published, "nothing new to say about it");
  assert.equal(h.asked.length, 0);
});

test("push, embed and external feeds are not probed or listed", async () => {
  const { h, scheduler, subscribe } = harness([
    pull("cam"),
    { id: "push", name: "push", source: { kind: "push", protocol: "srt" } },
    { id: "embed", name: "embed", source: { kind: "embed", player: "resi", ref: "https://resi.example/x" } },
    { id: "ext", name: "ext", source: { kind: "external", url: "https://relay.example/whep" } },
  ]);
  subscribe(true);
  await settle();
  assert.equal(h.asked.length, 1);
  assert.deepEqual(Object.keys(scheduler.current().feeds), ["cam"]);
});

test("with the Video feeds switch off nothing is probed and nothing is claimed", async () => {
  const { h, scheduler, subscribe } = harness([pull("a")]);
  h.enabled = false;
  subscribe(true);
  await settle();
  assert.equal(h.asked.length, 0);
  assert.deepEqual(scheduler.current().feeds, {});

  // Switched on while the page is open: asked at once.
  h.enabled = true;
  scheduler.switchChanged();
  await settle();
  assert.equal(h.asked.length, 1);
  assert.equal(scheduler.current().feeds.a?.state, "ready");

  // And off again: what was learned is withdrawn.
  h.enabled = false;
  scheduler.switchChanged();
  await settle();
  assert.deepEqual(scheduler.current().feeds, {});
  assert.equal(h.asked.length, 1);
});

test("a removed feed is dropped from the snapshot at once", async () => {
  const { h, scheduler, subscribe } = harness([pull("a"), pull("bb")]);
  subscribe(true);
  await settle();
  assert.deepEqual(Object.keys(scheduler.current().feeds).sort(), ["a", "bb"]);
  h.feeds = [pull("a")];
  scheduler.feedsChanged();
  await settle();
  assert.deepEqual(Object.keys(scheduler.current().feeds), ["a"]);
  assert.deepEqual(Object.keys(h.published.at(-1)!.feeds), ["a"], "and the page was told");
});

test("a feed removed while its probe is in flight is neither published nor reported", async () => {
  let release!: (r: ProbeResult) => void;
  const { h, scheduler, subscribe } = harness([pull("a", "rtsp://192.0.2.1/a")]);
  h.answers.set("rtsp://192.0.2.1/a", () => new Promise<ProbeResult>((resolve) => (release = resolve)));
  subscribe(true);
  await settle();
  h.feeds = [];
  scheduler.feedsChanged(); // a round is in flight, so this queues another
  release({ state: "failed", reason: "x" });
  await settle();
  assert.deepEqual(scheduler.current().feeds, {});
  assert.deepEqual(h.reported, [], "a removed feed writes no log line");
});

test("an edited address or login resets the feed to checking and is asked again at once", async () => {
  const { h, scheduler, subscribe } = harness([pull("a", "rtsp://192.0.2.1/old")]);
  h.answers.set("rtsp://192.0.2.1/old", { state: "failed", reason: "old problem" });
  subscribe(true);
  await settle();
  assert.equal(scheduler.current().feeds.a?.state, "failed");

  h.feeds = [pull("a", "rtsp://192.0.2.1/new")];
  scheduler.feedsChanged();
  await settle();
  assert.equal(h.asked.at(-1)!.url, "rtsp://192.0.2.1/new");
  assert.equal(scheduler.current().feeds.a?.state, "ready", "answered for the new address, not the old one's failure");
  assert.ok(h.published.some((p) => p.feeds.a?.state === "checking" && h.published.indexOf(p) > 1), "it passed through checking");

  // A password change alone is an edit too.
  h.passwords.set("a", "new-secret");
  scheduler.feedsChanged();
  await settle();
  assert.equal(h.asked.at(-1)!.password, "new-secret");
});

test("the saved login rides along to the probe, and is never in the published snapshot", async () => {
  const { h, scheduler, subscribe } = harness([pull("a", "rtsp://192.0.2.1/a", "admin")]);
  h.passwords.set("a", "hunter2-secret");
  subscribe(true);
  await settle();
  assert.deepEqual(h.asked[0], { url: "rtsp://192.0.2.1/a", username: "admin", password: "hunter2-secret" });
  assert.equal(JSON.stringify(h.published).includes("hunter2-secret"), false);
  assert.equal(JSON.stringify(scheduler.current()).includes("hunter2-secret"), false);
});

test("a round that cannot load the feeds is reported to the owner, and the timer carries on", async () => {
  const { h, scheduler, subscribe } = harness([pull("a")]);
  const real = h.feeds;
  Object.defineProperty(h, "feeds", {
    get() {
      throw new Error("disk on fire");
    },
    configurable: true,
  });
  subscribe(true);
  await settle();
  assert.equal(h.roundErrors.length, 1);
  assert.match(String(h.roundErrors[0]), /disk on fire/);

  Object.defineProperty(h, "feeds", { value: real, writable: true, configurable: true });
  h.tick!();
  await settle();
  assert.equal(scheduler.current().feeds.a?.state, "ready", "the next tick recovers");
});

test("a tick while the last round is still running does not start a second one", async () => {
  let release!: (r: ProbeResult) => void;
  const { h, subscribe } = harness([pull("a", "rtsp://192.0.2.1/a")]);
  h.answers.set("rtsp://192.0.2.1/a", () => new Promise<ProbeResult>((resolve) => (release = resolve)));
  subscribe(true);
  await settle();
  h.tick!();
  h.tick!();
  await settle();
  assert.equal(h.asked.length, 1, "the camera is not asked again while it is being asked");
  release({ state: "ready" });
  await settle();
});

test("watching that stops and starts again inside a probe joins the probe in flight, never a second one at the camera", async () => {
  // A page connecting reports its channels a moment after it opens, so demand
  // can flap off and on within one probe. A camera that answers a DESCRIBE made
  // while another is open with 406 would read Not answering.
  let release!: (r: ProbeResult) => void;
  const { h, scheduler, subscribe } = harness([pull("a", "rtsp://192.0.2.1/a")]);
  h.answers.set("rtsp://192.0.2.1/a", () => new Promise<ProbeResult>((resolve) => (release = resolve)));
  subscribe(true);
  await settle();
  subscribe(false);
  subscribe(true);
  await settle();
  assert.equal(h.asked.length, 1, "the second round asked the camera again while the first was open");
  release({ state: "ready", codec: "H264" });
  await settle();
  assert.equal(scheduler.current().feeds.a?.state, "ready");
  assert.deepEqual(h.reported, [{ id: "a", state: "ready" }], "reported once, by the round still watching");

  // Done, so the next round does ask.
  h.tick!();
  await settle();
  assert.equal(h.asked.length, 2);
});

test("an edited address is not answered by a probe still open for the old one", async () => {
  let release!: (r: ProbeResult) => void;
  const { h, scheduler, subscribe } = harness([pull("a", "rtsp://192.0.2.1/old")]);
  h.answers.set("rtsp://192.0.2.1/old", () => new Promise<ProbeResult>((resolve) => (release = resolve)));
  subscribe(true);
  await settle();
  h.feeds = [pull("a", "rtsp://192.0.2.1/new")];
  scheduler.feedsChanged(); // queued behind the round in flight
  release({ state: "failed", reason: "the old address" });
  await settle();
  assert.equal(h.asked.at(-1)!.url, "rtsp://192.0.2.1/new", "the new address was asked");
  assert.equal(scheduler.current().feeds.a?.state, "ready", "the old address's answer did not land on the new one");
  assert.deepEqual(h.reported, [{ id: "a", state: "ready" }], "and the old failure was never reported");
});

test("a round joining a probe in flight only joins one made with the same address and login", async () => {
  let releaseOld!: (r: ProbeResult) => void;
  const { h, scheduler, subscribe } = harness([pull("a", "rtsp://192.0.2.1/old")]);
  h.answers.set("rtsp://192.0.2.1/old", () => new Promise<ProbeResult>((resolve) => (releaseOld = resolve)));
  subscribe(true);
  await settle();
  subscribe(false); // the page left, and the feed was edited while nobody watched
  h.feeds = [pull("a", "rtsp://192.0.2.1/new")];
  subscribe(true);
  await settle();
  assert.deepEqual(h.asked.map((t) => t.url), ["rtsp://192.0.2.1/old", "rtsp://192.0.2.1/new"], "the new address is asked, not answered by the old probe");
  assert.equal(scheduler.current().feeds.a?.state, "ready");
  releaseOld({ state: "failed", reason: "the old address" });
  await settle();
  assert.equal(scheduler.current().feeds.a?.state, "ready");
});

// ── Guards on the reads a round makes before it asks ────────────────────────

/** A gate a test opens by hand. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

test("watching that stops while the feed list is still being read asks no camera when the read returns", async () => {
  const { h, scheduler, subscribe } = harness([pull("a")]);
  const g = gate();
  h.feedsGate = g.wait;
  subscribe(true);
  await settle();
  subscribe(false);
  g.open();
  await settle();
  assert.equal(h.asked.length, 0, "a camera was asked on behalf of a page that had already left");
  assert.deepEqual(scheduler.current().feeds, {});
});

test("watching that stops while a password is still being read asks no camera when the read returns", async () => {
  const { h, scheduler, subscribe } = harness([pull("a")]);
  const g = gate();
  h.passwordGate = g.wait;
  subscribe(true);
  await settle();
  subscribe(false);
  g.open();
  await settle();
  assert.equal(h.asked.length, 0, "a camera was asked on behalf of a page that had already left");
  assert.deepEqual(scheduler.current().feeds, {});
});

test("an edit that lands while a password is being read is not asked with the old login", async () => {
  const { h, scheduler, subscribe } = harness([pull("a", "rtsp://192.0.2.1/a", "admin")]);
  h.passwords.set("a", "old-password");
  const g = gate();
  h.passwordGate = g.wait;
  subscribe(true);
  await settle();
  h.passwords.set("a", "new-password");
  scheduler.feedsChanged("a");
  g.open();
  await settle();
  assert.ok(h.asked.length >= 1);
  assert.equal(h.asked.some((t) => t.password === "old-password"), false, "the old password was sent after it had been changed");
  assert.equal(scheduler.current().feeds.a?.state, "ready");
});

// ── Feeds the relay may be dialling ─────────────────────────────────────────

test("a feed the relay was asked for a moment ago is not probed, and is again once it lapses", async () => {
  const { h, scheduler, subscribe } = harness([pull("dial"), pull("idle")]);
  h.dialling.add("dial");
  subscribe(true);
  await settle();
  assert.deepEqual(h.asked.map((t) => t.url.includes("dial")), [false], "only the idle feed was asked");
  assert.equal(scheduler.current().feeds.dial, undefined);
  h.dialling.delete("dial");
  h.tick!();
  await settle();
  assert.equal(scheduler.current().feeds.dial?.state, "ready");
});

// ── A camera busy on first contact ──────────────────────────────────────────

test("a camera that is busy and has never answered says so, still as Checking, and a later answer replaces it", async () => {
  const { h, scheduler, subscribe } = harness([pull("a", "rtsp://192.0.2.1/a")]);
  h.answers.set("rtsp://192.0.2.1/a", { state: "busy" });
  subscribe(true);
  await settle();
  assert.deepEqual(scheduler.current().feeds.a, { state: "checking", checkedAt: 1000, busy: true });
  assert.deepEqual(h.reported, [], "busy is not an answer, so it is never reported");

  h.answers.set("rtsp://192.0.2.1/a", { state: "ready" });
  h.tick!();
  await settle();
  assert.equal(scheduler.current().feeds.a?.state, "ready");
  assert.equal(scheduler.current().feeds.a?.busy, undefined);
});

test("a camera that has answered and is then busy keeps what it showed, with no busy flag", async () => {
  const { h, scheduler, subscribe } = harness([pull("a", "rtsp://192.0.2.1/a")]);
  subscribe(true);
  await settle();
  h.answers.set("rtsp://192.0.2.1/a", { state: "busy" });
  h.tick!();
  await settle();
  assert.equal(scheduler.current().feeds.a?.state, "ready");
  assert.equal(scheduler.current().feeds.a?.busy, undefined);
});

// ── An edit touches only its own feed ───────────────────────────────────────

test("editing one feed drops only its own in-flight answer and asks only it again", async () => {
  const { h, scheduler, subscribe } = harness([pull("a", "rtsp://192.0.2.1/a"), pull("bb", "rtsp://192.0.2.2/b")]);
  const release = new Map<string, (r: ProbeResult) => void>();
  for (const url of ["rtsp://192.0.2.1/a", "rtsp://192.0.2.2/b"]) {
    h.answers.set(url, () => new Promise<ProbeResult>((resolve) => release.set(url, resolve)));
  }
  subscribe(true);
  await settle();
  assert.equal(h.asked.length, 2, "both asked, both held open");

  h.feeds = [pull("a", "rtsp://192.0.2.1/a"), pull("bb", "rtsp://192.0.2.2/b2")];
  h.answers.set("rtsp://192.0.2.2/b2", { state: "ready", codec: "H265" });
  scheduler.feedsChanged("bb");

  release.get("rtsp://192.0.2.1/a")!({ state: "ready", codec: "H264" });
  release.get("rtsp://192.0.2.2/b")!({ state: "failed", reason: "the old address" });
  await settle();

  assert.equal(scheduler.current().feeds.a?.codec, "H264", "the unrelated feed's answer still landed");
  assert.equal(scheduler.current().feeds.bb?.codec, "H265", "the edited feed was asked afresh");
  assert.deepEqual(
    h.asked.map((t) => t.url),
    ["rtsp://192.0.2.1/a", "rtsp://192.0.2.2/b", "rtsp://192.0.2.2/b2"],
    "the unedited camera was not asked a second time",
  );
  assert.deepEqual(h.reported.map((r) => r.id).sort(), ["a", "bb"]);
});

test("a change with no feed named, as an import makes, re-asks every feed", async () => {
  const { h, scheduler, subscribe } = harness([pull("a", "rtsp://192.0.2.1/a"), pull("bb", "rtsp://192.0.2.2/b")]);
  subscribe(true);
  await settle();
  const before = h.asked.length;
  scheduler.feedsChanged();
  await settle();
  assert.equal(h.asked.length, before + 2);
});

test("a stale round whose feed list read finished after watching restarted does not delete the new round's results", async () => {
  const { h, scheduler, subscribe } = harness([pull("a")]);
  const g = gate();
  h.feedsGate = g.wait;
  subscribe(true); // round A takes the list [a] and is held
  await settle();
  subscribe(false);
  h.feeds = [pull("a"), pull("bb")];
  h.feedsGate = null;
  subscribe(true); // round B, a new generation, sees both
  await settle();
  assert.deepEqual(Object.keys(scheduler.current().feeds).sort(), ["a", "bb"]);
  const published = h.published.length;
  g.open(); // A resumes with its stale list
  await settle();
  assert.deepEqual(Object.keys(scheduler.current().feeds).sort(), ["a", "bb"], "the stale round removed a feed the new round had");
  assert.equal(h.published.length, published, "and published that");
});
