// relay-lifecycle.test.ts — the relay's start/stop sequence, driven entirely
// through fakes: no real download, no real port bind, no real child process.
// ensureBinary/busyPorts/the supervisor/the relay are all injected, so the
// only real I/O anywhere in this file is a config file written under a
// throwaway STAGE_UTILITY_DATA — the same tmp dir every other video test
// under this directory writes to.

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
 *  enough past that. Date.now() is real time here even when a test mocks
 *  setTimeout without also mocking "Date". */
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
  const reconcileCalls: RelayFeed[][] = [];
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
      fakeRelay(async (feeds) => {
        reconcileCalls.push(feeds);
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
  videoService.setFeedsChangedListener(() => void lifecycle.feedsChanged());
  videoService.setPortsChangedListener(() => void lifecycle.portsChanged());
  return lifecycle;
}

beforeEach(async () => {
  await setRelayFeeds(0);
});

afterEach(async () => {
  if (active) await active.setEnabled(false);
  active = null;
  videoService.setFeedsChangedListener(null);
  videoService.setPortsChangedListener(null);
  await videoService.detachRelay();
  await setRelayFeeds(0);
  await videoFeedsStore.update((current) => ({ ...current, ports: DEFAULT_VIDEO_PORTS }));
});

// ── 1. The relay runs exactly when enabled AND at least one relay feed exists ──

test("enabling with no relay feeds starts nothing", async () => {
  const { deps, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  await lifecycle.setEnabled(true);
  await settle();
  assert.equal(supervisors.length, 0, "a supervisor was created with no relay feed to serve");
  assert.equal((await videoService.state()).relay.state, "off");
});

test("adding the first relay feed starts it", async () => {
  const { deps, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  await lifecycle.setEnabled(true);
  await settle();
  assert.equal(supervisors.length, 0);

  await setRelayFeeds(1);
  await lifecycle.feedsChanged();
  await settle();
  assert.equal(supervisors.length, 1, "the first relay feed did not start the relay");
  assert.equal(supervisors[0]!.startCalls.length, 1);
  assert.equal((await videoService.state()).relay.state, "running");
});

test("removing the last relay feed stops it", async () => {
  const { deps, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  await lifecycle.setEnabled(true);
  await settle();
  assert.equal(supervisors.length, 1);

  await setRelayFeeds(0);
  await lifecycle.feedsChanged();
  await settle();
  assert.equal(supervisors[0]!.stopCalls, 1, "the last relay feed's removal never stopped the supervisor");
  assert.equal((await videoService.state()).relay.state, "off");
});

test("disabling stops it, even with relay feeds still present", async () => {
  const { deps, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(2);
  await lifecycle.setEnabled(true);
  await settle();
  assert.equal(supervisors.length, 1);

  await lifecycle.setEnabled(false);
  await settle();
  assert.equal(supervisors[0]!.stopCalls, 1);
  assert.equal((await videoService.state()).relay.state, "off");
});

test("enabling with a relay feed already present starts it", async () => {
  const { deps, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1, "pull");
  await lifecycle.setEnabled(true);
  await settle();
  assert.equal(supervisors.length, 1);
  assert.equal((await videoService.state()).relay.state, "running");
});

// ── 2. The start sequence, in order ────────────────────────────────────────

test("ensureBinary, then busyPorts, then the config file, then supervisor.start, then attachRelay, then reconcile once running", async () => {
  const { deps, order, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  await lifecycle.setEnabled(true);
  await settle();
  // Give the readiness poll's own retry loop a moment — it is what actually
  // calls reconcile, once a tick after attach (see startReadinessPoll()).
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const supervisor = supervisors[0]!;
  assert.equal(supervisor.startCalls[0]!.binary, "/fake/mediamtx");
  assert.match(supervisor.startCalls[0]!.configPath, /mediamtx\.yml$/);

  const configRaw = await fs.readFile(supervisor.startCalls[0]!.configPath, "utf8");
  const config = JSON.parse(configRaw) as { rtmpAddress: string; webrtcAdditionalHosts: string[] };
  assert.equal(config.rtmpAddress, `:${DEFAULT_VIDEO_PORTS.rtmp}`, "the config was not built from the current ports");
  assert.ok(config.webrtcAdditionalHosts[0], "the config carries no lanIp at all");

  assert.deepEqual(order, ["ensureBinary", "busyPorts", "reconcile"], "the start sequence ran out of order");
  assert.equal((await videoService.state()).relay.state, "running");
});

test("a busy port fails before any supervisor is created, and is retried", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const { deps, supervisors } = makeDeps({
    busyPorts: async () => {
      attempts++;
      return attempts === 1 ? [{ port: 1935, proto: "tcp", holder: "OBS Studio" }] : [];
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  await lifecycle.setEnabled(true);
  await settle();

  assert.equal(supervisors.length, 0, "a busy port must not reach supervisor.start()");
  const relay = (await videoService.state()).relay;
  assert.equal(relay.state, "failing");
  assert.equal((relay as { reason: string }).reason, "Port 1935 is in use by OBS Studio.");

  // The same backoff schedule the supervisor itself uses for a crash loop —
  // proves the retry is not on some separate, undocumented cadence.
  t.mock.timers.tick(restartDelayMs(0));
  await waitUntil(() => supervisors.length > 0);
  assert.equal(supervisors.length, 1, "the busy-port failure was never retried");
});

test("a download failure never reaches busyPorts, and names where to place the archive by hand", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { deps, order, supervisors } = makeDeps({
    ensureBinary: async () => {
      order.push("ensureBinary");
      return { ok: false, reason: "checksum mismatch", placeArchiveAt: "/data/video-relay/downloads/mediamtx.tar.gz" };
    },
    busyPorts: async () => {
      order.push("busyPorts");
      return [];
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  await lifecycle.setEnabled(true);
  await settle();

  assert.deepEqual(order, ["ensureBinary"]);
  assert.equal(supervisors.length, 0);
  const relay = (await videoService.state()).relay;
  assert.equal(relay.state, "failing");
  assert.equal((relay as { reason: string }).reason, "checksum mismatch");
  assert.equal((relay as { placeArchiveAt?: string }).placeArchiveAt, "/data/video-relay/downloads/mediamtx.tar.gz");
});

// ── 3. A ports change restarts an already-running relay on the new ports ──

test("PATCH-style ports change restarts a running relay with the new ports, and the proxy target follows", async () => {
  const { deps, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  await lifecycle.setEnabled(true);
  await waitUntil(() => supervisors.length > 0);
  assert.equal(supervisors.length, 1);

  const r = await videoService.setPorts({ rtmp: 21935, srt: 28890, webrtcUdp: 28189, webrtcHttp: 28889, hls: 28888, api: 29997 });
  assert.ok(r.ok);
  await waitUntil(() => supervisors.length > 1);

  assert.equal(supervisors[0]!.stopCalls, 1, "the ports change never stopped the old process");
  assert.equal(supervisors.length, 2, "the ports change never started a new one");
  assert.equal(supervisors[1]!.startCalls.length, 1);

  const relay = (await videoService.state()).relay;
  assert.equal(relay.state, "running");
  assert.equal((relay as { ports: { rtmp: number } }).ports.rtmp, 21935, "the running relay's own ports never followed the change");
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

// ── 5. Logging: decisions and failures only ────────────────────────────────

test("logs the relay started line once, with its version and ports, and never again for a mere crash-respawn", async (t: TestContext) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (msg: string) => logs.push(msg));
  const { deps, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  await lifecycle.setEnabled(true);
  await waitUntil(() => supervisors.length > 0);

  // version() is null until the relay's own startup banner is parsed —
  // the readiness poll's own tick is what notices it flip.
  supervisors[0]!.ver = "v1.21.1";
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const started = logs.filter((l) => l.includes("relay started"));
  assert.equal(started.length, 1, `expected exactly one "relay started" line, got: ${JSON.stringify(started)}`);
  assert.match(started[0]!, /relay started: MediaMTX v1\.21\.1, RTMP 1935, SRT 8890, video to screens UDP 8189/);

  // A crash-and-respawn on the SAME started run must not repeat the line —
  // only a fresh startRelay() (setEnabled/feedsChanged reaching a genuinely
  // new attempt) resets loggedStartedThisRun.
  logs.length = 0;
  supervisors[0]!.setStatus({ state: "failing", reason: "exit code 1", retryAt: Date.now() + 1000 });
  supervisors[0]!.setStatus({ state: "running", since: Date.now() });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(logs.filter((l) => l.includes("relay started")).length, 0, "a crash-respawn re-announced the relay as freshly started");
});

test("logs relay stopped, naming which of the two reasons", async () => {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (msg: string) => logs.push(String(msg));
  try {
    const { deps } = makeDeps();
    const lifecycle = activate(new RelayLifecycle(deps));
    await setRelayFeeds(1);
    await lifecycle.setEnabled(true);
    await settle();

    await lifecycle.setEnabled(false);
    await settle();
    assert.ok(logs.some((l) => l.includes("relay stopped (video switched off)")), JSON.stringify(logs));

    logs.length = 0;
    await lifecycle.setEnabled(true);
    await settle();
    await setRelayFeeds(0);
    await lifecycle.feedsChanged();
    await settle();
    assert.ok(logs.some((l) => l.includes("relay stopped (no relay feeds)")), JSON.stringify(logs));
  } finally {
    console.log = orig;
  }
});

// ── 6. RelayStatus -> the integration manager's connection state ──────────

test("relayConnectionState maps every RelayStatus to the integration row", () => {
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
  assert.deepEqual(
    relayConnectionState({ state: "failing", reason: "Port 1935 is in use by OBS.", retryAt: null }),
    { state: "error", message: "Port 1935 is in use by OBS." },
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
  await lifecycle.setEnabled(true);
  await settle();

  assert.equal(supervisors.length, 0);
  assert.ok(seen.some((s) => s.state === "connecting"), JSON.stringify(seen));
  assert.ok(
    seen.some((s) => s.state === "error" && s.message === "Port 1935 is in use by OBS Studio."),
    JSON.stringify(seen),
  );
});
