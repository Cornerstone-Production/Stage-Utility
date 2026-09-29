// relay-lifecycle.test.ts — the relay's start/stop sequence, driven entirely
// through fakes: no real download, no real port bind, no real child process.
// ensureBinary/busyPorts/the supervisor/the relay are all injected, so the
// only real I/O anywhere in this file is a config file written under a
// throwaway STAGE_UTILITY_DATA — the same tmp dir every other video test
// under this directory writes to.
//
// Includes the reviewer's own probes (A-F, scratchpad/t15probe), turned into
// real assertions rather than console.log observations.

import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test, type TestContext } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-relay-lifecycle-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { RelayLifecycle, relayConnectionState } = await import("./relay-lifecycle.js");
const { videoService } = await import("./video-service.js");
const { videoFeedsStore } = await import("./feed-store.js");
const { restartDelayMs } = await import("./supervisor.js");
const { DEFAULT_VIDEO_PORTS } = await import("../../types/video.js");

type RelayLifecycleDeps = import("./relay-lifecycle.js").RelayLifecycleDeps;
type RelayLifecycleSupervisor = import("./relay-lifecycle.js").RelayLifecycleSupervisor;
type SupervisorStatus = import("./supervisor.js").SupervisorStatus;
type VideoFeed = import("../../types/video.js").VideoFeed;
type VideoRelay = import("./relay.js").VideoRelay;
type RelayFeed = import("./relay.js").RelayFeed;

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Real wall-clock polling, never affected by a test's own mocked
 *  setTimeout: the start sequence's first-ever secretsStore call generates
 *  an encryption key (real crypto), and a single settle() is not always
 *  enough past that. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil() timed out");
    await settle();
  }
}

class FakeSupervisor extends EventEmitter implements RelayLifecycleSupervisor {
  current: SupervisorStatus = { state: "off" };
  ver: string | null = null;
  startCalls: { binary: string; configPath: string }[] = [];
  stopCalls = 0;
  /** item 6/7: one real supervisor.stop() (or, for item 7, makeRelay/
   *  attachRelay) throwing is not a hypothetical — a leftover-kill EPERM,
   *  say — and every caller's OWN reaction to it is what these two items
   *  guard. */
  stopRejectsOnce = false;
  status(): SupervisorStatus {
    return this.current;
  }
  version(): string | null {
    return this.ver;
  }
  setStatus(s: SupervisorStatus): void {
    this.current = s;
    this.emit("status", s);
  }
  async start(binary: string, configPath: string): Promise<void> {
    this.startCalls.push({ binary, configPath });
    this.setStatus({ state: "running", since: Date.now() });
  }
  async stop(): Promise<void> {
    this.stopCalls++;
    if (this.stopRejectsOnce) {
      this.stopRejectsOnce = false;
      throw new Error("stop blew up");
    }
    this.setStatus({ state: "off" });
  }
}

function fakeRelay(reconcile: (feeds: RelayFeed[]) => Promise<void> = async () => {}): VideoRelay {
  return {
    reconcile,
    status: async () => [],
    playback: (feedId) => ({ whep: `/video/${feedId}/whep`, hls: `/video/${feedId}/index.m3u8` }),
    kickPublisher: async () => false,
  };
}

/** Every fake, with an ORDER log shared across all of them — the one thing
 *  carry item 2 (the start sequence) needs proof of. */
function makeDeps(overrides: Partial<RelayLifecycleDeps> = {}): {
  deps: RelayLifecycleDeps;
  order: string[];
  supervisors: FakeSupervisor[];
} {
  const order: string[] = [];
  const supervisors: FakeSupervisor[] = [];
  const deps: RelayLifecycleDeps = {
    ensureBinary: async () => {
      order.push("ensureBinary");
      return { ok: true, path: "/fake/mediamtx" };
    },
    busyPorts: async () => {
      order.push("busyPorts");
      return [];
    },
    makeSupervisor: () => {
      const s = new FakeSupervisor();
      supervisors.push(s);
      return s;
    },
    makeRelay: () =>
      fakeRelay(async () => {
        order.push("reconcile");
      }),
    ...overrides,
  };
  return { deps, order, supervisors };
}

async function setRelayFeeds(count: number, kind: "pull" | "push" = "push"): Promise<void> {
  const feeds: VideoFeed[] = [];
  for (let i = 0; i < count; i++) {
    feeds.push({
      id: `f${i}`,
      name: `Feed ${i}`,
      source: kind === "pull" ? { kind: "pull", url: `rtsp://192.0.2.${i}/s`, username: "" } : { kind: "push", protocol: "rtmp" },
    });
  }
  await videoFeedsStore.update((current) => ({ ...current, feeds }));
}

let active: InstanceType<typeof RelayLifecycle> | null = null;

function activate(lifecycle: InstanceType<typeof RelayLifecycle>): InstanceType<typeof RelayLifecycle> {
  active = lifecycle;
  videoService.setFeedsChangedListener(() => lifecycle.feedsChanged());
  videoService.setPortsChangedListener(() => lifecycle.portsChanged());
  videoService.setRelayStatusListener((relay) => lifecycle.handleRelayStatus(relay));
  return lifecycle;
}

beforeEach(async () => {
  await setRelayFeeds(0);
});

afterEach(async () => {
  if (active) active.setEnabled(false);
  await settle();
  active = null;
  videoService.setFeedsChangedListener(null);
  videoService.setPortsChangedListener(null);
  videoService.setRelayStatusListener(null);
  await videoService.detachRelay();
  videoService.setPreAttachStatus(null);
  await setRelayFeeds(0);
  await videoFeedsStore.update((current) => ({ ...current, ports: DEFAULT_VIDEO_PORTS }));
});

// ── 1. The relay runs exactly when enabled AND at least one relay feed exists,
//       and every public entry point returns AT ONCE (never awaits the start
//       sequence) ──────────────────────────────────────────────────────────

test("setEnabled/feedsChanged/portsChanged return void — a caller can never be made to wait on the start sequence", async () => {
  const { deps } = makeDeps({ ensureBinary: () => new Promise(() => {}) }); // never resolves
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  const returned = lifecycle.setEnabled(true);
  assert.equal(returned, undefined, "setEnabled must return void, not a Promise a caller could await");
  // The test function itself returning proves nothing hung, even with
  // ensureBinary held forever.
});

test("a held ensureBinary never blocks the caller — work still starts in the background", async () => {
  let ensureBinaryCalls = 0;
  let resolveEnsure!: () => void;
  const held = new Promise<void>((resolve) => (resolveEnsure = resolve));
  const { deps, supervisors } = makeDeps({
    ensureBinary: async () => {
      ensureBinaryCalls++;
      await held;
      return { ok: true, path: "/fake/mediamtx" };
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => ensureBinaryCalls > 0);
  assert.equal(supervisors.length, 0, "nothing should have started yet — ensureBinary is still held");
  resolveEnsure();
  await waitUntil(() => supervisors.length > 0);
});

test("enabling with no relay feeds starts nothing", async () => {
  const { deps, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  lifecycle.setEnabled(true);
  await settle();
  assert.equal(supervisors.length, 0, "a supervisor was created with no relay feed to serve");
  assert.equal((await videoService.state()).relay.state, "off");
});

test("adding the first relay feed starts it", async () => {
  const { deps, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  lifecycle.setEnabled(true);
  await settle();
  assert.equal(supervisors.length, 0);

  await setRelayFeeds(1);
  lifecycle.feedsChanged();
  await waitUntil(() => supervisors.length > 0);
  assert.equal(supervisors[0]!.startCalls.length, 1);
  assert.equal((await videoService.state()).relay.state, "running");
});

test("removing the last relay feed stops it", async () => {
  const { deps, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => supervisors.length > 0);

  await setRelayFeeds(0);
  lifecycle.feedsChanged();
  await waitUntil(() => supervisors[0]!.stopCalls > 0);
  assert.equal((await videoService.state()).relay.state, "off");
});

test("disabling stops it, even with relay feeds still present", async () => {
  const { deps, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(2);
  lifecycle.setEnabled(true);
  await waitUntil(() => supervisors.length > 0);

  lifecycle.setEnabled(false);
  await waitUntil(() => supervisors[0]!.stopCalls > 0);
  assert.equal((await videoService.state()).relay.state, "off");
});

test("enabling with a relay feed already present starts it", async () => {
  const { deps, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1, "pull");
  lifecycle.setEnabled(true);
  await waitUntil(() => supervisors.length > 0);
  assert.equal((await videoService.state()).relay.state, "running");
});

// ── 2. The start sequence, in order, and the config file it writes ────────

test("ensureBinary, then busyPorts, then the config file (0o600, real publish users), then supervisor.start, then attachRelay, then reconcile once running", async () => {
  const { deps, order, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => order.includes("reconcile"));

  const supervisor = supervisors[0]!;
  assert.equal(supervisor.startCalls[0]!.binary, "/fake/mediamtx");
  assert.match(supervisor.startCalls[0]!.configPath, /mediamtx\.yml$/);

  const configPath = supervisor.startCalls[0]!.configPath;
  const configRaw = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(configRaw) as {
    rtmpAddress: string;
    webrtcAdditionalHosts: string[];
    authInternalUsers: { user: string; permissions: { action: string; path: string }[] }[];
  };
  assert.equal(config.rtmpAddress, `:${DEFAULT_VIDEO_PORTS.rtmp}`, "the config was not built from the current ports");
  assert.ok(config.webrtcAdditionalHosts[0], "the config carries no lanIp at all");
  // publishUsers(feeds): the fixed reader, plus one "video" user per push
  // feed, permissioned to publish exactly that feed's own path.
  const publishers = config.authInternalUsers.filter((u) => u.permissions.some((p) => p.action === "publish"));
  assert.deepEqual(publishers.map((u) => u.permissions[0]!.path), ["f0"], "the config's publish users do not match the feed list");

  const stat = await fs.stat(configPath);
  assert.equal(stat.mode & 0o777, 0o600, "the config holds every push feed's live publish password in the clear");

  assert.deepEqual(order, ["ensureBinary", "busyPorts", "reconcile"], "the start sequence ran out of order");
  assert.equal((await videoService.state()).relay.state, "running");
});

// ── PROBE D / item 3: a throw anywhere in the pre-supervisor steps must
//    never wedge starting=true forever ─────────────────────────────────────

test("PROBE D: a throwing ensureBinary (not an ok:false return) does not wedge the lifecycle — the next attempt still starts it", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const { deps, supervisors } = makeDeps({
    ensureBinary: async () => {
      calls++;
      if (calls === 1) throw new Error("EACCES: permission denied, mkdir '/data/video-relay/downloads'");
      return { ok: true, path: "/fake/mediamtx" };
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => calls === 1);
  assert.equal(supervisors.length, 0);
  const relay = (await videoService.state()).relay;
  assert.equal(relay.state, "failing", "a thrown error must still report failing, not silently do nothing");
  assert.match((relay as { reason: string }).reason, /could not start the relay: EACCES/);

  t.mock.timers.tick(restartDelayMs(0));
  await waitUntil(() => supervisors.length > 0);
  assert.equal((await videoService.state()).relay.state, "running", "the lifecycle must retry, not stay wedged");
});

test("a throw from busyPorts (not from ensureBinary) is caught the same way, by the one outer try/catch", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const { deps, supervisors } = makeDeps({
    busyPorts: async () => {
      calls++;
      if (calls === 1) throw new Error("EPERM: operation not permitted");
      return [];
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => calls === 1);
  assert.equal((await videoService.state()).relay.state, "failing");
  t.mock.timers.tick(restartDelayMs(0));
  await waitUntil(() => supervisors.length > 0);
});

// ── PROBES A & B / item 2: a pre-supervisor failure must clear when the
//    desire to run goes away, not linger with its retry timer still running ──

test("PROBE A: a busy port, then switched off — the failing status clears and the retry stops", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seen: { state: string; message: string | null }[] = [];
  const { deps } = makeDeps({ busyPorts: async () => [{ port: 1935, proto: "tcp", holder: "OBS Studio" }] });
  const lifecycle = activate(new RelayLifecycle(deps));
  lifecycle.setConnectionListener((state, message) => seen.push({ state, message }));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  // waitUntil() against current()'s synchronous snapshot, not a bare
  // settle(): under a full-suite run's real CPU contention, a single
  // macrotask tick is not always enough for this chain (ensureBinary ->
  // busyPorts -> failPreSupervisor -> publish) to have actually settled by
  // the time the assertion runs — confirmed by this exact test flaking
  // once in a full-suite run and passing every time alone.
  await waitUntil(() => videoService.current().relay.state === "failing");
  assert.equal((await videoService.state()).relay.state, "failing");

  lifecycle.setEnabled(false);
  await waitUntil(() => videoService.current().relay.state === "off");
  assert.equal((await videoService.state()).relay.state, "off", "the failing status must clear once switched off");
  assert.equal(seen.at(-1)?.state, "disconnected");

  // The retry timer must be gone too — ticking past where it would have
  // fired must not resurrect anything (busyPorts would still refuse it).
  const before = seen.length;
  t.mock.timers.tick(restartDelayMs(0) + 1000);
  await settle();
  assert.equal(seen.length, before, "a cancelled retry timer fired anyway");
});

test("PROBE B: a busy port, then the last relay feed removed — same clearing", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { deps } = makeDeps({ busyPorts: async () => [{ port: 1935, proto: "tcp", holder: "OBS Studio" }] });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await settle();
  assert.equal((await videoService.state()).relay.state, "failing");

  await setRelayFeeds(0);
  lifecycle.feedsChanged();
  await settle();
  assert.equal((await videoService.state()).relay.state, "off");
});

// ── 5. Logging: once per outage, never once per retry ──────────────────────

test("a repeated busy-port failure logs once, not once per retry", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logs: string[] = [];
  t.mock.method(console, "warn", (msg: string) => logs.push(msg));
  const { deps } = makeDeps({ busyPorts: async () => [{ port: 1935, proto: "tcp", holder: "OBS Studio" }] });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await settle();
  t.mock.timers.tick(restartDelayMs(0));
  await settle();
  t.mock.timers.tick(restartDelayMs(1));
  await settle();
  const busyLines = logs.filter((l) => l.includes("Port 1935 is in use by OBS Studio"));
  assert.equal(busyLines.length, 1, `expected exactly one busy-port line across three failures, got: ${JSON.stringify(busyLines)}`);
});

test("downloading MediaMTX logs once per download STREAK, not once per retry", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logs: string[] = [];
  t.mock.method(console, "log", (msg: string) => logs.push(msg));
  let ensureBinaryCalls = 0;
  const { deps } = makeDeps({
    ensureBinary: async (opts) => {
      ensureBinaryCalls++;
      opts?.onDownloadStart?.();
      return { ok: false, reason: "download failed: network error", placeArchiveAt: "/x/mediamtx.tar.gz", assetName: "mediamtx.tar.gz" };
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await settle();
  t.mock.timers.tick(restartDelayMs(0));
  await settle();
  t.mock.timers.tick(restartDelayMs(1));
  await settle();
  assert.equal(ensureBinaryCalls, 3, "the retry loop itself must still run three times");
  const downloadLines = logs.filter((l) => l.includes("downloading MediaMTX"));
  assert.equal(downloadLines.length, 1, `expected one "downloading" line across three attempts, got: ${JSON.stringify(downloadLines)}`);
});

test("recovering from a pre-supervisor outage logs once — but only once the recovery has genuinely HELD, per OutageLog's own settle window", async (t: TestContext) => {
  // OutageLog.ok() answers quiet for a success inside its settle window (2
  // minutes by default) — a fast retry succeeding a second later is a gap in
  // one flapping outage, not its end, and the "Date" clock has to move past
  // that window for a recovery line to ever have a CHANCE to print.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const logs: string[] = [];
  t.mock.method(console, "log", (msg: string) => logs.push(msg));
  let attempts = 0;
  const { deps, supervisors } = makeDeps({
    busyPorts: async () => {
      attempts++;
      return attempts === 1 ? [{ port: 1935, proto: "tcp" as const, holder: "OBS Studio" }] : [];
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await settle();
  assert.equal(supervisors.length, 0, "the first attempt must have failed on the busy port");

  t.mock.timers.tick(3 * 60 * 1000); // past the failure AND past the 2-minute settle window
  await waitUntil(() => supervisors.length > 0);
  assert.ok(
    logs.some((l) => l.includes("pre-launch checks are passing again")),
    `expected a recovery line, got: ${JSON.stringify(logs)}`,
  );
});

// ── 3. A ports change restarts an already-running relay on the new ports,
//    and logs its own reason ────────────────────────────────────────────────

test("a ports change restarts a running relay, logging its own reason (not the generic stop line)", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (msg: string) => logs.push(String(msg));
  try {
    const { deps, supervisors } = makeDeps();
    const lifecycle = activate(new RelayLifecycle(deps));
    await setRelayFeeds(1);
    lifecycle.setEnabled(true);
    await waitUntil(() => supervisors.length > 0);

    const r = await videoService.setPorts({ rtmp: 21935, srt: 28890, webrtcUdp: 28189, webrtcHttp: 28889, hls: 28888, api: 29997 });
    assert.ok(r.ok);
    await waitUntil(() => supervisors.length > 1);

    assert.equal(supervisors[0]!.stopCalls, 1, "the ports change never stopped the old process");
    assert.equal(supervisors[1]!.startCalls.length, 1);
    assert.ok(logs.some((l) => l === "[video] relay restarting on new ports"), JSON.stringify(logs));
    assert.equal(logs.some((l) => l.includes("relay stopped (")), false, "the ports-change restart must not ALSO log the generic stop line");

    const relay = (await videoService.state()).relay;
    assert.equal(relay.state, "running");
    assert.equal((relay as { ports: { rtmp: number } }).ports.rtmp, 21935, "the running relay's own ports never followed the change");
  } finally {
    console.log = orig;
  }
});

test("a ports change while the relay is off does not start it", async () => {
  const { deps, supervisors } = makeDeps();
  activate(new RelayLifecycle(deps));
  await setRelayFeeds(0);

  const r = await videoService.setPorts({ rtmp: 21935, srt: 28890, webrtcUdp: 28189, webrtcHttp: 28889, hls: 28888, api: 29997 });
  assert.ok(r.ok);
  await settle();
  assert.equal(supervisors.length, 0);
});

// ── PROBE F / item 7: a ports change that fixes a busy port retries AT ONCE,
//    not on whatever backoff was already scheduled ─────────────────────────

test("PROBE F: a busy port, then a ports change that fixes it — retries immediately, not on the pending backoff", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { deps, supervisors } = makeDeps({
    busyPorts: async (ports) => (ports.rtmp === DEFAULT_VIDEO_PORTS.rtmp ? [{ port: 1935, proto: "tcp" as const, holder: "OBS Studio" }] : []),
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await settle();
  assert.equal((await videoService.state()).relay.state, "failing");
  assert.equal(supervisors.length, 0);

  const r = await videoService.setPorts({ ...DEFAULT_VIDEO_PORTS, rtmp: 21935 });
  assert.ok(r.ok);
  // NO tick() here — proving this does not need the pending 1 s backoff
  // (or any later one) to elapse at all.
  await waitUntil(() => supervisors.length > 0);
  assert.equal((await videoService.state()).relay.state, "running");
});

// item 6 (findings-t15-r2.md): `this.chain.then(fn, onRejected)` catches a
// rejection of the PREVIOUS link, never of `fn` itself — so when a queued
// call's own fn rejects, the rejection propagates unhandled and poisons the
// very NEXT enqueue() call: that one's onRejected fires (catching what it
// takes to be "the previous step" failing) and its OWN fn is skipped
// entirely, silently dropping one real, queued call for every one that
// failed.
test("PROBE G: a rejected chain step (supervisor.stop() throwing) does not drop the NEXT queued call", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { deps, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => supervisors.length > 0);
  assert.equal((await videoService.state()).relay.state, "running");

  supervisors[0]!.stopRejectsOnce = true;
  lifecycle.setEnabled(false); // stopRelay() -> supervisor.stop() rejects
  await settle();
  await settle();

  // The very next queued call — switching back on — must still run, not be
  // silently skipped because the previous one rejected.
  lifecycle.setEnabled(true);
  await waitUntil(() => supervisors.length > 1);
  assert.equal(supervisors.length, 2, "the second setEnabled(true) was dropped — no fresh supervisor was ever created");
  assert.equal((await videoService.state()).relay.state, "running");
});

// item 13 (findings-t15-r3.md): a rejected supervisor.stop() inside
// stopRelay() used to skip detachRelay()/setPreAttachStatus(null)
// entirely — this class had already forgotten the supervisor (its own
// isUp() reads false), but videoService had NOT: it stayed attached to
// the same, now half-stopped supervisor object, still reporting
// "running" (the fake's own status never reaches "off" when stop()
// throws before calling setStatus).
test("item 13: a rejected stop() still detaches videoService and clears preAttachStatus, logging the failure once", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warns: string[] = [];
  t.mock.method(console, "warn", (msg: string) => warns.push(msg));
  const { deps, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => supervisors.length > 0);
  assert.equal((await videoService.state()).relay.state, "running");

  supervisors[0]!.stopRejectsOnce = true;
  lifecycle.setEnabled(false);
  await waitUntil(() => videoService.current().relay.state === "off");
  assert.equal(
    (await videoService.state()).relay.state,
    "off",
    "videoService stayed attached to the half-stopped supervisor",
  );
  const stopFailureLines = warns.filter((w) => w.startsWith("[video] could not stop the relay"));
  assert.equal(stopFailureLines.length, 1, `expected exactly one stop-failure line, got: ${JSON.stringify(warns)}`);
});

// item 7 (findings-t15-r2.md): this.supervisor used to be assigned before
// makeRelay()/attachRelay() ran, so a throw from either left this.supervisor
// pointing at a supervisor with a real, running, UNATTACHED child — isUp()
// true forever, and every later setEnabled()/feedsChanged() believed the
// relay was already up and never tried again.
test("item 7: a throw from attachRelay stops the orphaned supervisor and lets the NEXT attempt actually retry", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let throwOnce = true;
  const { deps, supervisors } = makeDeps({
    makeRelay: () => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("makeRelay blew up");
      }
      return fakeRelay();
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  // Real wall-clock polling, not settle() — the catch this test is
  // exercising is several awaits deep inside startRelay() (ensureBinary,
  // busyPorts, the config write, supervisor.start(), THEN this one), and
  // itself awaits supervisor.stop() — see waitUntil()'s own comment.
  await waitUntil(() => supervisors.length > 0 && supervisors[0]!.stopCalls > 0);

  // The first supervisor DID start (a real child would be running) but was
  // never attached — it must have been stopped, not left running unattached.
  assert.equal(supervisors.length, 1);
  assert.equal(supervisors[0]!.stopCalls, 1, "the orphaned supervisor was never stopped");
  assert.equal((await videoService.state()).relay.state, "failing");

  // The scheduled retry must actually retry — not see isUp() still true
  // from the orphaned supervisor and give up forever.
  t.mock.timers.tick(restartDelayMs(0));
  await waitUntil(() => supervisors.length > 1);
  assert.equal((await videoService.state()).relay.state, "running");
});

// item 7 (findings-t15-r3.md): the orphaned supervisor's own stop() —
// called from the SAME catch item 7 above added — used to be
// `.catch(() => {})`, swallowing a failure there completely. A supervisor
// that will not stop (killLeftover()'s own EPERM, say) is a second real
// fact an operator needs, not silence.
test("item 7: a stop() failure on the orphaned supervisor logs once and is folded into the failing reason, not swallowed", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warns: string[] = [];
  t.mock.method(console, "warn", (msg: string) => warns.push(msg));
  const supervisors: FakeSupervisor[] = [];
  const { deps } = makeDeps({
    makeSupervisor: () => {
      const s = new FakeSupervisor();
      s.stopRejectsOnce = true; // the orphan-cleanup stop() will reject
      supervisors.push(s);
      return s;
    },
    makeRelay: () => {
      throw new Error("makeRelay blew up");
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => (videoService.current().relay as { reason?: string }).reason?.includes("could not stop") === true);

  const relay = (await videoService.state()).relay;
  assert.equal(relay.state, "failing");
  if (relay.state === "failing") {
    assert.match(relay.reason, /could not start the relay: makeRelay blew up/);
    assert.match(relay.reason, /could not stop the orphaned relay process: stop blew up/);
  }
  // The console.warn line itself (the OutageLog-gated one, starting with
  // it), not the (separate) combined failing-reason string that also
  // mentions it — filtering on "includes" alone double-counted that one.
  const stopFailureLines = warns.filter((w) => w.startsWith("[video] could not stop the orphaned relay process"));
  assert.equal(stopFailureLines.length, 1, `expected exactly one stop-failure line, got: ${JSON.stringify(warns)}`);
});

// item 6 (findings-t15-r3.md, PROBE J): this.attempt used to reset to 0
// the moment supervisor.start() itself succeeded, BEFORE the attach try —
// so a makeRelay/attachRelay that keeps throwing always computed its
// backoff from attempt 0 (a flat 1 s floor forever), never accumulating
// like every other repeated pre-supervisor failure. Confirmed empirically
// against the reviewer's own probe before fixing anything: 31 supervisors
// created (and orphaned) in 30 s of mocked time.
test("item 6: a makeRelay that keeps throwing backs off between retries, not a flat 1 s floor forever", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { deps, supervisors } = makeDeps({
    makeRelay: () => {
      throw new Error("makeRelay blew up");
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);

  // Ticked in small, fixed steps with many settle() rounds after EACH one
  // — not two large ticks with a fixed settle() budget in between. The
  // chain a retry firing kicks off (ensureBinary -> busyPorts -> the
  // config write -> supervisor.start -> attach -> catch -> stop()) needs
  // more real event-loop turns to fully resolve than a modest, fixed
  // settle() count reliably provides — confirmed directly: 400 rounds of
  // settle() after one 1 s tick was NOT always enough for the chain
  // triggered by that tick to finish, which made an earlier version of
  // this test pass whether or not the bug it was meant to catch was
  // present. Sampling supervisors.length every 1 s of mocked time for 30 s
  // (mirroring the re-reviewer's own PROBE J) sidesteps needing to know
  // exactly how many turns is "enough" — by second 30, every real
  // continuation the mocked clock could have triggered by then has had
  // ample real time to run.
  const countAt: number[] = [];
  for (let sec = 0; sec < 30; sec++) {
    t.mock.timers.tick(1000);
    for (let i = 0; i < 60; i++) await settle();
    countAt.push(supervisors.length);
  }
  // Every supervisor created was also stopped — none left orphaned.
  for (const s of supervisors) assert.equal(s.stopCalls, 1);

  // The backoff schedule this class uses is 1, 2, 4, 8, 16, 30 (capped at
  // 60 s but restartDelayMs caps at 60 — 30 s of ticking only reaches the
  // 16 s rung), so at most 5 attempts land inside 30 s: at 1, 3, 7, 15,
  // and 31 s (the last just past this window). A flat 1 s floor would
  // instead produce one new supervisor on very nearly every second —
  // roughly 30 over the same window.
  assert.ok(
    supervisors.length <= 6,
    `expected at most ~5 attempts across 30 s of backoff, got ${supervisors.length} — the retry never backed off`,
  );
  assert.ok(supervisors.length >= 4, `expected the backoff schedule to have produced several attempts by 30 s, got ${supervisors.length}`);

  // The gaps between when each new supervisor first appears: the very
  // first attempt fires immediately (no backoff at all) and the second
  // waits restartDelayMs(0) = 1 s, so the first TWO gaps are both "1" on
  // this 1-second sampling grid — expected, not a bug. From the third
  // attempt on the schedule doubles (2, 4, 8, ...); a flat 1 s floor would
  // instead read "1" all the way through.
  const firstSeenAt: number[] = [];
  for (let i = 0; i < countAt.length; i++) {
    if (countAt[i] !== (i > 0 ? countAt[i - 1] : 0)) firstSeenAt.push(i);
  }
  const gaps = firstSeenAt.map((x, i) => (i ? x - firstSeenAt[i - 1]! : x + 1));
  assert.ok(
    gaps.length >= 4,
    `expected at least 4 sampled attempts to compute gaps from, got ${JSON.stringify(gaps)}`,
  );
  assert.deepEqual(gaps.slice(0, 2), [1, 1], `the first two attempts should be ~1 s apart, got ${JSON.stringify(gaps)}`);
  assert.ok(
    gaps.slice(2).every((g, i) => g > (i === 0 ? gaps[1]! : gaps[2 + i - 1]!)),
    `retry gaps must grow from the third attempt on, got ${JSON.stringify(gaps)}`,
  );
});

// item 12 (findings-t15-r2.md, PROBE H): prelaunchOutage was never reset
// when the relay was no longer wanted, so a SECOND busy-port outage after
// switching off and back on read as a continuation of the FIRST (still
// inside its own `spokenAt` window) and stayed silent.
test("PROBE H: a busy-port outage, switch off, switch back on into the SAME busy port — the second outage logs too", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logs: string[] = [];
  t.mock.method(console, "warn", (msg: string) => logs.push(msg));
  const { deps } = makeDeps({ busyPorts: async () => [{ port: 1935, proto: "tcp", holder: "OBS Studio" }] });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  // waitUntil(), not a bare settle() — see PROBE A's own comment on why:
  // this exact assertion flaked in a full-suite run and passed every time
  // run alone.
  await waitUntil(() => videoService.current().relay.state === "failing");

  lifecycle.setEnabled(false);
  await waitUntil(() => videoService.current().relay.state === "off");
  lifecycle.setEnabled(true);
  await waitUntil(() => videoService.current().relay.state === "failing");

  const busyLines = logs.filter((l) => l.includes("Port 1935 is in use by OBS Studio"));
  assert.equal(busyLines.length, 2, `expected the SECOND switch-on's outage to log its own first failure too, got: ${JSON.stringify(busyLines)}`);
});

// ── 10. The readiness poll: backs off between retries, stops on a
//    successful reconcile alone ─────────────────────────────────────────────

test("the readiness poll backs off with restartDelayMs between retries while the relay does not answer", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reconcileCalls = 0;
  const { deps, supervisors } = makeDeps({
    makeRelay: () =>
      fakeRelay(async () => {
        reconcileCalls++;
        if (reconcileCalls < 4) throw new Error("relay unreachable");
      }),
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => supervisors.length > 0);
  await waitUntil(() => reconcileCalls === 1); // the immediate first attempt

  t.mock.timers.tick(restartDelayMs(1));
  await waitUntil(() => reconcileCalls === 2);
  t.mock.timers.tick(restartDelayMs(2) - 1);
  await settle();
  assert.equal(reconcileCalls, 2, "the THIRD attempt must wait restartDelayMs(2), not fire on the same delay as the first retry");
  t.mock.timers.tick(1);
  await waitUntil(() => reconcileCalls === 3);
});

test("the readiness poll stops on a successful reconcile ALONE, even before the version is known", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { deps, order, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => supervisors.length > 0);
  // version() is left null the whole time — reconcile still applied on the
  // very first attempt (the fake relay's reconcile always succeeds), and
  // that alone must be enough to stop the poll.
  await settle();
  const relay = (await videoService.state()).relay;
  assert.equal(relay.state, "running");

  // item 11 (findings-t15-r2.md): relay.state === "running" alone stays
  // green even if the poll were re-gated on loggedStartedThisRun instead of
  // the reconcile itself — the supervisor's OWN status is already
  // "running" regardless of whether the poll noticed and stopped. Counting
  // reconcile calls is the only thing that catches that regression: ticking
  // well past several more backoff windows must add NONE.
  const reconcileCallsAtStop = order.filter((o) => o === "reconcile").length;
  assert.equal(reconcileCallsAtStop, 1, "reconcile ran more than once before the poll had any reason to retry");
  // Several ticks, each with a settle() — a mocked clock's tick() advances
  // time synchronously, but startReadinessPoll()'s own tick() is async
  // (awaits reconcileRelay()); a bare tick() with no settle() in between
  // asserts before that continuation has actually run, which is exactly
  // how this assertion stayed green with the re-gating bug reintroduced —
  // its own reconcile call had not happened yet by the time it ran.
  for (let i = 0; i < 8; i++) {
    t.mock.timers.tick(30_000);
    await settle();
  }
  assert.equal(
    order.filter((o) => o === "reconcile").length,
    reconcileCallsAtStop,
    "the readiness poll kept ticking after its first success — it did not actually stop",
  );
});

// ── 6/9: relayConnectionState — the one place a RelayStatus becomes the
//    integration row ─────────────────────────────────────────────────────────

test("relayConnectionState maps every RelayStatus to the integration row, never a blank version", () => {
  assert.deepEqual(relayConnectionState({ state: "off" }), { state: "disconnected", message: null });
  assert.deepEqual(
    relayConnectionState({ state: "downloading", receivedBytes: 10, totalBytes: 100 }),
    { state: "connecting", message: "Downloading MediaMTX v1.21.1 (10%)" },
  );
  assert.deepEqual(
    relayConnectionState({ state: "starting", version: null }),
    { state: "connecting", message: "Starting the relay" },
  );
  assert.deepEqual(
    relayConnectionState({ state: "running", version: "v1.21.1", ports: DEFAULT_VIDEO_PORTS }),
    { state: "connected", message: "MediaMTX v1.21.1" },
  );
  // PROBE C: a supervisor mid-spawn, version not yet known — must never
  // read "connected: MediaMTX " with nothing after it.
  assert.deepEqual(
    relayConnectionState({ state: "running", version: "", ports: DEFAULT_VIDEO_PORTS }),
    { state: "connected", message: null },
  );
  assert.deepEqual(
    relayConnectionState({ state: "failing", reason: "Port 1935 is in use by OBS.", kind: "port-conflict", retryAt: null }),
    { state: "error", message: "Port 1935 is in use by OBS." },
  );
  assert.deepEqual(
    relayConnectionState({ state: "failing", reason: "The relay is not answering", kind: "not-answering", retryAt: null }),
    { state: "error", message: "The relay is not answering" },
  );
});

test("the connection listener is told every transition, ending in error for a failing relay", async () => {
  const seen: { state: string; message: string | null }[] = [];
  const { deps, supervisors } = makeDeps({
    busyPorts: async () => [{ port: 1935, proto: "tcp", holder: "OBS Studio" }],
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  lifecycle.setConnectionListener((state, message) => seen.push({ state, message }));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => seen.some((s) => s.state === "error"));

  assert.equal(supervisors.length, 0);
  assert.ok(seen.some((s) => s.state === "connecting"), JSON.stringify(seen));
  assert.ok(
    seen.some((s) => s.state === "error" && s.message === "Port 1935 is in use by OBS Studio."),
    JSON.stringify(seen),
  );
});

// item 1 (findings-t15-r2.md): the connection row never reached "connected /
// MediaMTX <version>" when the banner arrived AFTER attach — nothing
// published when the version became known, so the row stuck on "connected"
// with a blank version until some UNRELATED change happened to publish
// again. PROBE C's own real sequence: attach while version() is still
// null, THEN the banner line arrives.
test("item 1: the connection row catches up to the version once the banner line arrives, with no other change forcing it", async () => {
  const seen: { state: string; message: string | null }[] = [];
  const { deps, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  lifecycle.setConnectionListener((state, message) => seen.push({ state, message }));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => supervisors.length > 0);
  assert.equal((await videoService.state()).relay.state, "running");
  assert.equal(
    seen.filter((s) => s.state === "connected" && s.message !== null).length,
    0,
    "the row already shows a version before the banner has even arrived",
  );

  // The banner: supervisor.ts's real attachReader() updates version() BEFORE
  // emitting "line" — this is that same order, on the fake.
  supervisors[0]!.ver = "v1.21.1";
  supervisors[0]!.emit("line", "INF MediaMTX v1.21.1, using config config.yml");

  await waitUntil(() => seen.some((s) => s.state === "connected" && s.message === "MediaMTX v1.21.1"));
});

// ── 9: ensureBinary's discriminator reaches the wire unchanged ─────────────

test("a download failure carries assetName and placeArchiveAt straight through to RelayStatus", async () => {
  const { deps, order } = makeDeps({
    ensureBinary: async () => {
      order.push("ensureBinary");
      return { ok: false, reason: "checksum mismatch", placeArchiveAt: "/data/video-relay/downloads/mediamtx.tar.gz", assetName: "mediamtx.tar.gz" };
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await settle();

  const relay = (await videoService.state()).relay;
  assert.equal(relay.state, "failing");
  assert.equal((relay as { reason: string }).reason, "checksum mismatch");
  assert.equal((relay as { placeArchiveAt?: string }).placeArchiveAt, "/data/video-relay/downloads/mediamtx.tar.gz");
  assert.equal((relay as { assetName?: string }).assetName, "mediamtx.tar.gz");
});

test("an unsupported platform (assetName: null) never invents a hand-place path", async () => {
  const { deps } = makeDeps({
    ensureBinary: async () => ({
      ok: false,
      reason: "Video relay is not available for win32 arm64.",
      placeArchiveAt: "/data/video-relay/downloads",
      assetName: null,
    }),
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  // waitUntil(), not a bare settle() — item 10 (findings-t15-r3.md): the
  // same chain PROBE A and PROBE H were hardened against (a single
  // macrotask tick is not always enough for ensureBinary -> ... ->
  // failPreSupervisor to have actually run under real CPU contention).
  await waitUntil(() => videoService.current().relay.state === "failing");

  const relay = (await videoService.state()).relay;
  assert.equal(relay.state, "failing");
  assert.equal((relay as { assetName?: string }).assetName, undefined);
});

// item 16 (findings-t15-r2.md, Ruling): an unsupported platform never
// retries — no pinned asset exists for this platform/arch, ever, so a
// backoff timer here would retry forever against a fact that cannot
// change, and the page must show no "Next try at" either.
test("item 16: an unsupported platform never retries — no 'Next try at', and ensureBinary is never called again", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let ensureBinaryCalls = 0;
  const { deps } = makeDeps({
    ensureBinary: async () => {
      ensureBinaryCalls++;
      return {
        ok: false,
        reason: "Video relay is not available for win32 arm64.",
        placeArchiveAt: "/data/video-relay/downloads",
        assetName: null,
      };
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await settle();

  const relay = (await videoService.state()).relay;
  assert.equal(relay.state, "failing");
  assert.equal((relay as { retryAt: number | null }).retryAt, null, "an unsupported platform must show no retry time");
  assert.equal(ensureBinaryCalls, 1);

  // Tick well past every backoff this class ever schedules (its cap is
  // 60 s) — a real retry timer would have fired several times by now.
  t.mock.timers.tick(120_000);
  await settle();
  assert.equal(ensureBinaryCalls, 1, "ensureBinary was called again — a retry was scheduled for a platform that can never fix itself");
});

// ── 5 (log wording): the two stop reasons, and the started line ───────────

test("logs relay stopped, naming which of the two reasons", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (msg: string) => logs.push(String(msg));
  try {
    const { deps, supervisors } = makeDeps();
    const lifecycle = activate(new RelayLifecycle(deps));
    await setRelayFeeds(1);
    lifecycle.setEnabled(true);
    await waitUntil(() => supervisors.length > 0);

    lifecycle.setEnabled(false);
    await waitUntil(() => logs.some((l) => l.includes("relay stopped")));
    assert.ok(logs.some((l) => l.includes("relay stopped (video switched off)")), JSON.stringify(logs));

    logs.length = 0;
    lifecycle.setEnabled(true);
    await waitUntil(() => supervisors.length > 1);
    await setRelayFeeds(0);
    lifecycle.feedsChanged();
    await waitUntil(() => logs.some((l) => l.includes("relay stopped")));
    assert.ok(logs.some((l) => l.includes("relay stopped (no relay feeds)")), JSON.stringify(logs));
  } finally {
    console.log = orig;
  }
});

test("logs the relay started line once, with its version and ports, and never again for a mere crash-respawn", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logs: string[] = [];
  t.mock.method(console, "log", (msg: string) => logs.push(msg));
  // The reconcile fake fails until the version is known — the same
  // ordering the real binary always gives (its startup banner, which sets
  // version(), is the very first line it ever prints, strictly before the
  // API opens — relay-facts.md). Without this, a reconcile that succeeds on
  // its very first (version-less) attempt stops the poll before it ever
  // gets a later tick to notice the version arriving, which is a fair thing
  // for a FAKE to do but not for the real relay.
  let versionKnown = false;
  const { deps, supervisors } = makeDeps({
    makeRelay: () =>
      fakeRelay(async () => {
        if (!versionKnown) throw new Error("relay unreachable");
      }),
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => supervisors.length > 0);

  // version() is null until the relay's own startup banner is parsed —
  // the readiness poll's own tick is what notices it flip.
  supervisors[0]!.ver = "v1.21.1";
  versionKnown = true;
  t.mock.timers.tick(restartDelayMs(1));
  await waitUntil(() => logs.some((l) => l.includes("relay started")));

  const started = logs.filter((l) => l.includes("relay started"));
  assert.equal(started.length, 1, `expected exactly one "relay started" line, got: ${JSON.stringify(started)}`);
  assert.match(started[0]!, /relay started: MediaMTX v1\.21\.1, RTMP 1935, SRT 8890, video to screens UDP 8189/);

  // A crash-and-respawn on the SAME started run must not repeat the line —
  // only a fresh startRelay() (setEnabled/feedsChanged reaching a genuinely
  // new attempt) resets loggedStartedThisRun.
  logs.length = 0;
  supervisors[0]!.setStatus({ state: "failing", reason: "exit code 1", retryAt: Date.now() + 1000, neverStarted: false });
  supervisors[0]!.setStatus({ state: "running", since: Date.now() });
  await settle();
  assert.equal(logs.filter((l) => l.includes("relay started")).length, 0, "a crash-respawn re-announced the relay as freshly started");
});

test("the two 'starting' messages are one wording — the connection row and the status line agree", async () => {
  const { deps } = makeDeps({ ensureBinary: () => new Promise(() => {}) });
  const lifecycle = activate(new RelayLifecycle(deps));
  const seen: { state: string; message: string | null }[] = [];
  lifecycle.setConnectionListener((state, message) => seen.push({ state, message }));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => seen.some((s) => s.state === "connecting"));
  assert.equal(seen.find((s) => s.state === "connecting")?.message, "Starting the relay");
});
