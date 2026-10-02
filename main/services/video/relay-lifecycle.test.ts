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
import { captureConsole } from "../fixtures/capture-console.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-relay-lifecycle-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { RelayLifecycle, relayConnectionState } = await import("./relay-lifecycle.js");
const { videoService } = await import("./video-service.js");
const { videoFeedsStore, loadFeedsFile: loadRealFeedsFile } = await import("./feed-store.js");
const { restartDelayMs } = await import("./supervisor.js");
const { DEFAULT_VIDEO_PORTS } = await import("../../types/video.js");
const { fakeRelay } = await import("../fixtures/fake-relay.js");

type RelayLifecycleDeps = import("./relay-lifecycle.js").RelayLifecycleDeps;
type RelayLifecycleSupervisor = import("./relay-lifecycle.js").RelayLifecycleSupervisor;
type SupervisorStatus = import("./supervisor.js").SupervisorStatus;
type LeftoverResult = import("./supervisor.js").LeftoverResult;
type VideoFeed = import("../../types/video.js").VideoFeed;

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A busy port's holder, as port-holder.ts reports one. */
const OBS_STUDIO = { kind: "process" as const, program: "OBS Studio", pid: 812 };

/** Real wall-clock polling, never affected by a test's own mocked
 *  setTimeout or Date (performance.now() is neither): the start sequence's
 *  first-ever secretsStore call generates an encryption key (real crypto),
 *  and a single settle() is not always enough past that. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = performance.now();
  for (;;) {
    if (predicate()) return;
    if (performance.now() - start > timeoutMs) throw new Error("waitUntil() timed out");
    await settle();
  }
}

class FakeSupervisor extends EventEmitter implements RelayLifecycleSupervisor {
  current: SupervisorStatus = { state: "off" };
  ver: string | null = null;
  startCalls: { binary: string; configPath: string; beforeRespawn?: () => Promise<void> }[] = [];
  stopCalls = 0;
  /** One real supervisor.stop() (or makeRelay/attachRelay) throwing is
   *  not a hypothetical — a leftover-kill EPERM, say — and every caller's
   *  own reaction to it is what the tests using this guard. */
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
  async start(binary: string, configPath: string, beforeRespawn?: () => Promise<void>): Promise<void> {
    this.startCalls.push({ binary, configPath, beforeRespawn });
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


/** Every fake, with an ORDER log shared across all of them — what the
 *  start-sequence test needs proof of. */
function makeDeps(overrides: Partial<RelayLifecycleDeps> = {}): {
  deps: RelayLifecycleDeps;
  order: string[];
  supervisors: FakeSupervisor[];
} {
  const order: string[] = [];
  const supervisors: FakeSupervisor[] = [];
  const deps: RelayLifecycleDeps = {
    loadFeedsFile: loadRealFeedsFile,
    ensureBinary: async () => {
      order.push("ensureBinary");
      return { ok: true, path: "/fake/mediamtx" };
    },
    busyPorts: async () => {
      order.push("busyPorts");
      return [];
    },
    stopLeftover: async (): Promise<LeftoverResult> => {
      order.push("stopLeftover");
      return { kind: "none" };
    },
    makeSupervisor: () => {
      const s = new FakeSupervisor();
      supervisors.push(s);
      return s;
    },
    makeRelay: () =>
      fakeRelay({ reconcile: async () => {
        order.push("reconcile");
      } }),
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
  videoService.setRelayProcessListener((status) => lifecycle.handleSupervisorStatus(status));
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
  videoService.setRelayProcessListener(null);
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

  assert.deepEqual(order, ["ensureBinary", "stopLeftover", "busyPorts", "reconcile"], "the start sequence ran out of order");
  assert.equal((await videoService.state()).relay.state, "running");
});

test("every start makes a fresh API password: in the config's API user, and handed to the relay client", async () => {
  const handed: string[] = [];
  const { deps, supervisors } = makeDeps({
    makeRelay: (_port, apiPassword) => {
      handed.push(apiPassword);
      return fakeRelay();
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  const apiUserIn = async (configPath: string) => {
    const config = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      authInternalUsers: { user: string; pass: string; ips: string[]; permissions: { action: string }[] }[];
    };
    const withApi = config.authInternalUsers.filter((u) => u.permissions.some((p) => p.action === "api"));
    assert.equal(withApi.length, 1, "exactly one user may use the relay's API");
    assert.deepEqual(withApi[0]!.ips, ["127.0.0.1", "::1"]);
    return withApi[0]!.pass;
  };

  lifecycle.setEnabled(true);
  await waitUntil(() => handed.length === 1);
  const first = await apiUserIn(supervisors[0]!.startCalls[0]!.configPath);
  assert.equal(first, handed[0], "the relay client must authenticate with the password its relay was started with");
  assert.ok(first.length >= 24, `a guessable API password: ${first}`);

  lifecycle.setEnabled(false);
  await waitUntil(() => videoService.current().relay.state === "off");
  lifecycle.setEnabled(true);
  await waitUntil(() => handed.length === 2);
  const second = await apiUserIn(supervisors[1]!.startCalls[0]!.configPath);
  assert.equal(second, handed[1]);
  assert.notEqual(second, first, "a new relay start must not reuse the last start's API password");
});

test("the supervisor is handed a rewrite for every respawn: the feeds and push passwords as they are by then, the same API password", async () => {
  const { deps, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1); // push feed f0
  lifecycle.setEnabled(true);
  await waitUntil(() => supervisors.length > 0);
  const { configPath, beforeRespawn } = supervisors[0]!.startCalls[0]!;
  assert.ok(beforeRespawn, "start() must be handed a way to rewrite the config before a respawn");
  type Config = { authInternalUsers: { user: string; pass: string; permissions: { action: string; path: string }[] }[] };
  const read = async () => JSON.parse(await fs.readFile(configPath, "utf8")) as Config;
  const pushPass = (c: Config) => c.authInternalUsers.find((u) => u.permissions.some((p) => p.action === "publish" && p.path === "f0"))?.pass;
  const apiPass = (c: Config) => c.authInternalUsers.find((u) => u.permissions.some((p) => p.action === "api"))?.pass;
  const before = await read();

  const rotated = await videoService.newPushPassword("f0");
  assert.ok(rotated);
  await beforeRespawn();
  const after = await read();
  assert.equal(pushPass(after), rotated.password, "a respawn must start from the password rotated since the last start");
  assert.notEqual(pushPass(after), pushPass(before));
  assert.equal(apiPass(after), apiPass(before), "the API password stays the one the relay client was handed");
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
});

// A relay left running when the server itself was killed holds every relay
// port. The leftover is stopped BEFORE the port check, or the check finds
// the relay's own ports taken — by the relay — and fails every retry, never
// reaching the supervisor that would have stopped it.
// A checksum failure names the file, both hashes and where to place the
// archive by hand — well past scrub()'s default 200 characters, which cut the
// line off mid-path and mid-hash.
test("a long pre-launch failure reaches the log whole: path, both hashes, where to place it", async (t: TestContext) => {
  const logs = captureConsole(t, "warn");
  const downloads = path.join(TMP, "video-relay", "downloads");
  const reason =
    `hand-placed archive at ${path.join(downloads, "mediamtx_v1.21.1_linux_arm64.tar.gz")} does not match the pinned checksum ` +
    `(expected ${"a".repeat(64)}, got ${"b".repeat(64)})`;
  const { deps } = makeDeps({
    ensureBinary: async () => ({ ok: false, reason, placeArchiveAt: downloads, assetName: "mediamtx_v1.21.1_linux_arm64.tar.gz" }),
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => logs.some((l) => l.includes("hand-placed archive")));
  const line = logs.find((l) => l.includes("hand-placed archive"))!;
  assert.ok(line.includes(`got ${"b".repeat(64)})`), `the line was cut short: ${line}`);
  assert.ok(line.endsWith(`in ${downloads})`), `the hand-place folder was cut short: ${line}`);
});

test("a leftover relay is stopped before the port check, so its ports read free", async () => {
  let leftoverRunning = true;
  const { deps, supervisors } = makeDeps({
    busyPorts: async () => (leftoverRunning ? [{ port: 1935, proto: "tcp" as const, holder: { kind: "process" as const, program: "mediamtx", pid: 4242 } }] : []),
    stopLeftover: async () => {
      leftoverRunning = false;
      return { kind: "stopped", pid: 4242 };
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => supervisors.length > 0 && supervisors[0]!.startCalls.length > 0);
  assert.equal((await videoService.state()).relay.state, "running");
});

test("a leftover that will not stop is the failing reason: its ports are still held", async (t: TestContext) => {
  const logs = captureConsole(t, "warn");
  const { deps, supervisors } = makeDeps({
    stopLeftover: async () => ({ kind: "would-not-stop", pid: 4242, error: "EPERM: operation not permitted" }),
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => videoService.current().relay.state === "failing");
  const relay = (await videoService.state()).relay as { reason: string; kind: string; retryAt: number | null };
  assert.equal(relay.kind, "port-conflict");
  assert.equal(relay.reason, "A relay left over from the last run would not stop, and may still hold the relay's ports.");
  assert.notEqual(relay.retryAt, null);
  assert.equal(supervisors.length, 0, "no relay may be spawned onto ports a leftover still holds");
  assert.ok(logs.some((l) => l.includes("(pid 4242) would not stop: EPERM")), JSON.stringify(logs));
});

// ── A throw anywhere in the pre-supervisor steps must
//    never wedge starting=true forever ─────────────────────────────────────

test("a throwing ensureBinary (not an ok:false return) does not wedge the lifecycle — the next attempt still starts it", async (t: TestContext) => {
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

// ── A pre-supervisor failure must clear when the
//    desire to run goes away, not linger with its retry timer still running ──

test("a busy port, then switched off — the failing status clears and the retry stops", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seen: { state: string; message: string | null }[] = [];
  const { deps } = makeDeps({ busyPorts: async () => [{ port: 1935, proto: "tcp", holder: OBS_STUDIO }] });
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

test("a busy port, then the last relay feed removed — same clearing", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { deps } = makeDeps({ busyPorts: async () => [{ port: 1935, proto: "tcp", holder: OBS_STUDIO }] });
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
  const logs = captureConsole(t, "warn");
  const { deps } = makeDeps({ busyPorts: async () => [{ port: 1935, proto: "tcp", holder: OBS_STUDIO }] });
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

test("a busy port's status names the program only; its pid goes to the server log only", async (t: TestContext) => {
  const logs = captureConsole(t, "warn");
  const { deps } = makeDeps({ busyPorts: async () => [{ port: 1935, proto: "tcp", holder: OBS_STUDIO }] });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => videoService.current().relay.state === "failing");

  const state = await videoService.state();
  assert.equal((state.relay as { reason: string }).reason, "Port 1935 is in use by OBS Studio.");
  // "pid", not the number: a retry timestamp can carry any digits.
  assert.equal(JSON.stringify(state).includes("pid"), false, "a host pid reached the state every LAN client reads");
  assert.ok(logs.some((l) => l.includes("Port 1935 is in use by OBS Studio (pid 812).")), JSON.stringify(logs));
});

test("downloading MediaMTX logs once per download STREAK, not once per retry", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logs = captureConsole(t, "log");
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

test("recovering from a pre-supervisor outage logs once, at the attempt that passes", async (t: TestContext) => {
  // The pre-launch checks succeed once per start, not on a timer, so there
  // is no stream of successes to wait on for one to hold: the attempt that
  // passes ends the run, as it does for the relay's reconcile.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const logs = captureConsole(t, "log");
  let attempts = 0;
  const { deps, supervisors } = makeDeps({
    busyPorts: async () => {
      attempts++;
      return attempts === 1 ? [{ port: 1935, proto: "tcp" as const, holder: OBS_STUDIO }] : [];
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await settle();
  assert.equal(supervisors.length, 0, "the first attempt must have failed on the busy port");

  t.mock.timers.tick(restartDelayMs(0));
  await waitUntil(() => supervisors.length > 0);
  assert.ok(
    logs.some((l) => l.includes("pre-launch checks are passing again")),
    `expected a recovery line, got: ${JSON.stringify(logs)}`,
  );
});

// ── 3. A ports change restarts an already-running relay on the new ports,
//    and logs its own reason ────────────────────────────────────────────────

test("a ports change restarts a running relay, logging its own reason (not the generic stop line)", async (t) => {
  const logs = captureConsole(t, "log");
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

// ── A ports change that fixes a busy port retries AT ONCE,
//    not on whatever backoff was already scheduled ─────────────────────────

test("a busy port, then a ports change that fixes it — retries immediately, not on the pending backoff", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { deps, supervisors } = makeDeps({
    busyPorts: async (ports) => (ports.rtmp === DEFAULT_VIDEO_PORTS.rtmp ? [{ port: 1935, proto: "tcp" as const, holder: OBS_STUDIO }] : []),
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

// `this.chain.then(fn, onRejected)` catches a
// rejection of the PREVIOUS link, never of `fn` itself — so when a queued
// call's own fn rejects, the rejection propagates unhandled and poisons the
// very NEXT enqueue() call: that one's onRejected fires (catching what it
// takes to be "the previous step" failing) and its OWN fn is skipped
// entirely, silently dropping one real, queued call for every one that
// failed.
// A step on the lifecycle's own chain can reject outside every try/catch
// the start sequence has — reading the feed store to decide whether the
// relay is wanted at all. The chain must survive it (the next queued call
// still runs), and the relay must say it is failing and try again, never
// sit silent, or keep showing a "Next try at" that has already passed.
test("a step that rejects on the chain reports failing and is tried again — the next call is never dropped", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const { deps, supervisors } = makeDeps({
    loadFeedsFile: async () => {
      reads++;
      if (reads === 1) throw new Error("EIO: i/o error, read");
      return loadRealFeedsFile();
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => videoService.current().relay.state === "failing");
  const failing = (await videoService.state()).relay as { reason: string; retryAt: number | null };
  assert.match(failing.reason, /EIO: i\/o error, read/);
  assert.notEqual(failing.retryAt, null, "a rejected step must be tried again");

  t.mock.timers.tick(restartDelayMs(0));
  await waitUntil(() => supervisors.length > 0);
  assert.equal((await videoService.state()).relay.state, "running");
});

// A step or a stop that fails while the relay is up opens its own outage run.
// Each says so once, stays quiet on the same failure again, and says it is
// working again on its next success, so a later failure is news once more.
test("a step that rejects while the relay is up logs once, stays quiet on a repeat, and logs its recovery", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lines = captureConsole(t, "warn", "log");
  let failReads = false;
  const { deps, supervisors } = makeDeps({
    loadFeedsFile: async () => {
      if (failReads) throw new Error("EIO: i/o error, read");
      return loadRealFeedsFile();
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => supervisors.length > 0);
  await waitUntil(() => videoService.current().relay.state === "running");
  const stepLines = () => lines.filter((l) => l.includes("EIO") || l.includes("steps are working again"));

  failReads = true;
  lifecycle.feedsChanged();
  await waitUntil(() => stepLines().length === 1);
  lifecycle.feedsChanged(); // the same failure, inside the same run
  await settle();
  await settle();
  assert.deepEqual(stepLines(), ["[video] could not start the relay: EIO: i/o error, read"]);

  failReads = false;
  t.mock.timers.tick(restartDelayMs(1)); // the retry, now able to read
  await waitUntil(() => stepLines().length === 2);
  assert.equal(stepLines()[1], "[video] the relay's start and stop steps are working again after 2 failed attempts (under a minute)");

  failReads = true;
  lifecycle.feedsChanged();
  await waitUntil(() => stepLines().length === 3);
  assert.equal(stepLines()[2], "[video] could not start the relay: EIO: i/o error, read", "a failure after the recovery is a new run");
  assert.equal(supervisors.length, 1, "the relay stayed up throughout");
});

test("a stop that rejects logs once, stays quiet on a repeat, and logs its recovery at the next stop that works", async (t: TestContext) => {
  const lines = captureConsole(t, "warn", "log");
  const { deps, supervisors } = makeDeps();
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => supervisors.length === 1);
  const stopLines = () => lines.filter((l) => l.includes("stop blew up") || l.includes("stopping the relay is working again"));

  // A ports change stops the running relay and starts another, keeping the
  // relay wanted throughout, so nothing forgets the run in between.
  supervisors[0]!.stopRejectsOnce = true;
  lifecycle.portsChanged();
  await waitUntil(() => supervisors.length === 2);
  supervisors[1]!.stopRejectsOnce = true;
  lifecycle.portsChanged();
  await waitUntil(() => supervisors.length === 3);
  assert.deepEqual(stopLines(), ["[video] could not stop the relay: stop blew up"]);

  lifecycle.portsChanged();
  await waitUntil(() => supervisors.length === 4);
  assert.deepEqual(stopLines(), [
    "[video] could not stop the relay: stop blew up",
    "[video] stopping the relay is working again after 2 failed attempts (under a minute)",
  ]);
});

test("a retry whose own step rejects shows the new failure and a new next try, never the passed one", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let busyCalls = 0;
  let failNextRead = false;
  const { deps, supervisors } = makeDeps({
    busyPorts: async () => (++busyCalls === 1 ? [{ port: 1935, proto: "tcp" as const, holder: OBS_STUDIO }] : []),
    loadFeedsFile: async () => {
      if (failNextRead) {
        failNextRead = false;
        throw new Error("EIO: i/o error, read");
      }
      return loadRealFeedsFile();
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => videoService.current().relay.state === "failing");
  const first = (await videoService.state()).relay as { reason: string; retryAt: number };
  assert.match(first.reason, /Port 1935/);

  failNextRead = true; // the retry's own "is the relay wanted" read
  t.mock.timers.tick(restartDelayMs(0));
  await waitUntil(() => /EIO/.test((videoService.current().relay as { reason?: string }).reason ?? ""));
  const second = (await videoService.state()).relay as { reason: string; retryAt: number };
  assert.ok(second.retryAt > first.retryAt, `the next try must move on from the one that passed (${first.retryAt} -> ${second.retryAt})`);

  t.mock.timers.tick(restartDelayMs(1));
  await waitUntil(() => supervisors.length > 0);
});

// A rejected supervisor.stop() inside
// stopRelay() used to skip detachRelay()/setPreAttachStatus(null)
// entirely — this class had already forgotten the supervisor (its own
// isUp() reads false), but videoService had NOT: it stayed attached to
// the same, now half-stopped supervisor object, still reporting
// "running" (the fake's own status never reaches "off" when stop()
// throws before calling setStatus).
test("a rejected stop() still detaches videoService and clears preAttachStatus, logging the failure once", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warns = captureConsole(t, "warn");
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

// this.supervisor used to be assigned before
// makeRelay()/attachRelay() ran, so a throw from either left this.supervisor
// pointing at a supervisor with a real, running, UNATTACHED child — isUp()
// true forever, and every later setEnabled()/feedsChanged() believed the
// relay was already up and never tried again.
test("a throw from attachRelay stops the orphaned supervisor and lets the NEXT attempt actually retry", async (t: TestContext) => {
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

// The orphaned supervisor's own stop() —
// called from the same catch as the test above — used to be
// `.catch(() => {})`, swallowing a failure there completely. A supervisor
// that will not stop (killLeftover()'s own EPERM, say) is a second real
// fact an operator needs, not silence.
test("a stop() failure on the orphaned supervisor logs once and is folded into the failing reason, not swallowed", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warns = captureConsole(t, "warn");
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
  // One line says it: the failing reason, which already carries the stop
  // failure after the attach failure that caused it.
  const stopFailureLines = warns.filter((w) => w.includes("could not stop the orphaned relay process"));
  assert.deepEqual(
    stopFailureLines,
    ["[video] could not start the relay: makeRelay blew up; could not stop the orphaned relay process: stop blew up"],
    "the stop failure must be logged once, in the failing reason",
  );
});

// this.attempt used to reset to 0
// the moment supervisor.start() itself succeeded, BEFORE the attach try —
// so a makeRelay/attachRelay that keeps throwing always computed its
// backoff from attempt 0 (a flat 1 s floor forever), never accumulating
// like every other repeated pre-supervisor failure: 31 supervisors created
// (and orphaned) in 30 s of mocked time.
test("a makeRelay that keeps throwing backs off between retries, not a flat 1 s floor forever", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { deps, supervisors } = makeDeps({
    makeRelay: () => {
      throw new Error("makeRelay blew up");
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);

  // Stepped one attempt at a time, waiting on each attempt's own evidence (a
  // new supervisor, and a fresh failing status naming when it retries) in
  // real time. An earlier version ticked 1 s at a time with a fixed number of
  // settle() rounds after each, and failed on a loaded CI runner (3 attempts
  // by 30 s where 4 were due) because the retry chain had not finished in
  // that many turns. Nothing here depends on how fast the chain runs.
  let lastRetryAt: number | null = null;
  const relay = () => videoService.current().relay as { state: string; retryAt?: number | null };
  const failedAgain = (n: number) => () =>
    supervisors.length === n && relay().state === "failing" && typeof relay().retryAt === "number" && relay().retryAt !== lastRetryAt;

  for (let k = 0; k < 5; k++) {
    await waitUntil(failedAgain(k + 1));
    lastRetryAt = relay().retryAt ?? null;
    if (k === 4) break;
    // The backoff after attempt k+1 is restartDelayMs(k): 1, 2, 4, 8 s. Short
    // of it by 1 ms, nothing may start. A flat 1 s floor starts the next
    // attempt here from the second wait on, which is the bug this guards.
    const delay = restartDelayMs(k);
    t.mock.timers.tick(delay - 1);
    const early = await waitUntil(() => supervisors.length > k + 1, 300).then(() => true, () => false);
    assert.equal(early, false, `attempt ${k + 2} started before its ${delay} ms backoff — the retry never backed off`);
    t.mock.timers.tick(1);
  }

  // Every supervisor created was also stopped — none left orphaned.
  await waitUntil(() => supervisors.every((s) => s.stopCalls === 1));
  assert.equal(supervisors.length, 5);
});

// prelaunchOutage was never reset
// when the relay was no longer wanted, so a SECOND busy-port outage after
// switching off and back on read as a continuation of the FIRST (still
// inside its own `spokenAt` window) and stayed silent.
test("a busy-port outage, switch off, switch back on into the SAME busy port — the second outage logs too", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logs = captureConsole(t, "warn");
  const { deps } = makeDeps({ busyPorts: async () => [{ port: 1935, proto: "tcp", holder: OBS_STUDIO }] });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  // waitUntil(), not a bare settle() — see the switched-off test's comment:
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
      fakeRelay({ reconcile: async () => {
        reconcileCalls++;
        if (reconcileCalls < 4) throw new Error("relay unreachable");
      } }),
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

// Stop landing while a readiness tick is still waiting on its reconcile: the
// tick must not re-arm once it comes back, and the NEXT start must run its
// own poll rather than find the stale timer and assume one is going.
test("a stop during an in-flight readiness tick cancels it, and the next start runs its own poll", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: string[] = [];
  let releaseFirst!: () => void;
  const { deps, supervisors } = makeDeps({
    makeRelay: () => {
      const relayNo = supervisors.length;
      return fakeRelay({ reconcile: async () => {
        calls.push(`reconcile relay ${relayNo}`);
        if (relayNo === 1 && calls.length === 1) {
          await new Promise<void>((resolve) => (releaseFirst = resolve));
          throw new Error("relay unreachable");
        }
      } });
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => calls.length === 1); // the first tick, now in flight

  lifecycle.setEnabled(false);
  await waitUntil(() => videoService.current().relay.state === "off");
  releaseFirst(); // the in-flight reconcile comes back failed, after the stop
  await settle();
  await settle();

  // Switched straight back on, with no time passing: the new relay's own
  // poll must make its first attempt at once. A stale timer re-armed by the
  // stopped tick made startReadinessPoll() believe a poll was already
  // going, so the new relay waited out the old one's backoff instead.
  lifecycle.setEnabled(true);
  await waitUntil(() => supervisors.length === 2);
  await waitUntil(() => calls.includes("reconcile relay 2"));

  // And the stopped tick never comes back: nothing re-armed it, so once the
  // new relay has answered, no stale timer reconciles it again later.
  t.mock.timers.tick(60_000);
  await settle();
  await settle();
  assert.deepEqual(calls, ["reconcile relay 1", "reconcile relay 2"], "the stopped relay's readiness tick re-armed and ran again");
});

test("a respawned relay is reconciled again: its paths went with the process that exited", async () => {
  let reconciles = 0;
  const { deps, supervisors } = makeDeps({ makeRelay: () => fakeRelay({ reconcile: async () => void reconciles++ }) });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => reconciles === 1);
  supervisors[0]!.setStatus({ state: "failing", reason: "exit code 1", retryAt: Date.now() + 1000, neverStarted: false });
  supervisors[0]!.setStatus({ state: "running", since: Date.now() });
  await waitUntil(() => reconciles === 2);
});

// The readiness poll's first tick starts from inside the supervisor's own
// "running" event. A reconcile that succeeds on that first attempt must count
// for the new process, whichever "status" listener the supervisor calls first.
test("a respawn whose first reconcile succeeds serves its feeds, with no feed edit", async () => {
  let reconciles = 0;
  const { deps, supervisors } = makeDeps({ makeRelay: () => fakeRelay({ reconcile: async () => void reconciles++ }) });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1, "pull");
  lifecycle.setEnabled(true);
  await waitUntil(() => reconciles === 1);
  await waitUntil(() => !("refuse" in videoService.relayTarget("f0", "whep")));

  supervisors[0]!.setStatus({ state: "failing", reason: "killed by SIGKILL", retryAt: Date.now() + 1000, neverStarted: false });
  supervisors[0]!.setStatus({ state: "running", since: Date.now() });
  await waitUntil(() => reconciles === 2);
  await waitUntil(() => videoService.current().relay.state === "running");
  await settle();

  assert.deepEqual(videoService.relayTarget("f0", "whep"), {
    host: "127.0.0.1",
    port: DEFAULT_VIDEO_PORTS.webrtcHttp,
    path: "/f0/whep",
  });
});

test("a normal start logs no reconcile failure: the first attempt lands before the relay's API is open", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lines = captureConsole(t, "warn", "log");
  // The API is shut for the first attempt, to every call alike, as a real
  // relay's is for the moment after it spawns.
  let reconcileCalls = 0;
  let apiOpen = false;
  const { deps } = makeDeps({
    makeRelay: () => ({
      ...fakeRelay({ reconcile: async () => {
        reconcileCalls++;
        if (!apiOpen) throw new Error("fetch failed");
      } }),
      status: async () => {
        if (!apiOpen) throw new Error("fetch failed");
        return [];
      },
    }),
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => reconcileCalls === 1);
  apiOpen = true;
  t.mock.timers.tick(restartDelayMs(1));
  await waitUntil(() => reconcileCalls === 2);
  await settle();
  assert.deepEqual(lines.filter((l) => l.includes("reconcil")), [], "the relay opening its API a moment late is not news");
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

  // relay.state === "running" alone stays
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
  // A supervisor mid-spawn, version not yet known — must never
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
    busyPorts: async () => [{ port: 1935, proto: "tcp", holder: OBS_STUDIO }],
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

// The connection row never reached "connected /
// MediaMTX <version>" when the banner arrived AFTER attach — nothing
// published when the version became known, so the row stuck on "connected"
// with a blank version until some UNRELATED change happened to publish
// again. The real sequence: attach while version() is still null, THEN
// the banner line arrives.
test("the connection row catches up to the version once the banner line arrives, with no other change forcing it", async () => {
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

test("a download failure carries assetName and the hand-place folder to RelayStatus, relative to the data folder", async (t: TestContext) => {
  const logs = captureConsole(t, "warn");
  const downloads = path.join(TMP, "video-relay", "downloads");
  const { deps, order } = makeDeps({
    ensureBinary: async () => {
      order.push("ensureBinary");
      return { ok: false, reason: "checksum mismatch", placeArchiveAt: downloads, assetName: "mediamtx.tar.gz" };
    },
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => videoService.current().relay.state === "failing");

  const relay = (await videoService.state()).relay;
  assert.equal(relay.state, "failing");
  assert.equal((relay as { reason: string }).reason, "checksum mismatch");
  assert.equal((relay as { placeArchiveAt?: string }).placeArchiveAt, path.join("video-relay", "downloads"));
  assert.equal((relay as { assetName?: string }).assetName, "mediamtx.tar.gz");
  assert.ok(
    logs.some((l) => l.includes(`to place it by hand: mediamtx.tar.gz in ${downloads}`)),
    `the server log must keep the full path: ${JSON.stringify(logs)}`,
  );
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
  // waitUntil(), not a bare settle() — the
  // same chain the busy-port tests were hardened against (a single
  // macrotask tick is not always enough for ensureBinary -> ... ->
  // failPreSupervisor to have actually run under real CPU contention).
  await waitUntil(() => videoService.current().relay.state === "failing");

  const relay = (await videoService.state()).relay;
  assert.equal(relay.state, "failing");
  assert.equal((relay as { assetName?: string }).assetName, undefined);
});

// An unsupported platform never
// retries — no pinned asset exists for this platform/arch, ever, so a
// backoff timer here would retry forever against a fact that cannot
// change, and the page must show no "Next try at" either.
test("an unsupported platform never retries — no 'Next try at', and ensureBinary is never called again", async (t: TestContext) => {
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

test("logs relay stopped, naming which of the two reasons", async (t) => {
  const logs = captureConsole(t, "log");
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
});

test("logs the relay started line with its version and ports, once per process — a respawn is a new one", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logs = captureConsole(t, "log");
  // The reconcile fake fails until the version is known — the same
  // ordering the real binary always gives (its startup banner, which sets
  // version(), is the very first line it ever prints, strictly before the
  // API opens). Without this, a reconcile that succeeds on
  // its very first (version-less) attempt stops the poll before it ever
  // gets a later tick to notice the version arriving, which is a fair thing
  // for a FAKE to do but not for the real relay.
  let versionKnown = false;
  const { deps, supervisors } = makeDeps({
    makeRelay: () =>
      fakeRelay({ reconcile: async () => {
        if (!versionKnown) throw new Error("relay unreachable");
      } }),
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

  // A respawn is a new process, and the log says it came up: after the
  // exit line, a "relay started" for the process now running.
  logs.length = 0;
  supervisors[0]!.setStatus({ state: "failing", reason: "exited with code 1", retryAt: Date.now() + 1000, neverStarted: false });
  supervisors[0]!.setStatus({ state: "running", since: Date.now() });
  await waitUntil(() => logs.some((l) => l.includes("relay started")));
  await settle();
  assert.equal(logs.filter((l) => l.includes("relay started")).length, 1, "expected the respawned process announced once");
});

test("a respawned process that exits before its API ever answers is not announced as started", async (t: TestContext) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const logs = captureConsole(t, "log");
  let apiOpen = true;
  const { deps, supervisors } = makeDeps({
    makeRelay: () =>
      fakeRelay({ reconcile: async () => {
        if (!apiOpen) throw new Error("fetch failed");
      } }),
  });
  const lifecycle = activate(new RelayLifecycle(deps));
  await setRelayFeeds(1);
  lifecycle.setEnabled(true);
  await waitUntil(() => logs.some((l) => l.includes("relay started")));
  logs.length = 0;

  apiOpen = false; // the respawned process dies before it opens its API
  supervisors[0]!.ver = "v1.21.1";
  supervisors[0]!.setStatus({ state: "failing", reason: "exited with code 1", retryAt: Date.now() + 1000, neverStarted: false });
  supervisors[0]!.setStatus({ state: "running", since: Date.now() });
  await settle();
  await settle();
  supervisors[0]!.setStatus({ state: "failing", reason: "exited with code 1", retryAt: Date.now() + 2000, neverStarted: false });
  await settle();
  assert.deepEqual(logs.filter((l) => l.includes("relay started")), [], "a process that never answered was announced as started");
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
