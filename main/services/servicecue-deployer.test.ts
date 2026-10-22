// When the server updates the public page, and what it does when that goes wrong, against a fake
// Cloudflare that is a real HTTP server and a bundle folder written to disk. The wire protocol is
// held in servicecue-cloudflare.test.ts; this holds the decisions.

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs";

import { captureConsole } from "./fixtures/capture-console.js";
import { ACCOUNT_ID, API_TOKEN, FakeCloudflare, failure } from "./fixtures/fake-cloudflare.js";
import { BUILD_A, BUILD_B, writeBundle, type WrittenBundle } from "./fixtures/deploy-bundle.js";
import { cloudflareOrigin } from "./servicecue-cloudflare.js";
import { backoffMs } from "./servicecue-publisher.js";
import { DEFAULT_DEPLOY_TIMINGS, ServiceCueDeployer, isOlderVersion, serviceIsLive, type DeployTimings } from "./servicecue-deployer.js";
import type { DeployCredentials } from "./servicecue-deploy-store.js";
import type { PcoLiveDTO } from "../types/stage.js";

let fake: FakeCloudflare;
let bundle: WrittenBundle;

before(async () => {
  fake = await FakeCloudflare.start();
});
after(() => fake.close());

const CREDS: DeployCredentials = { accountId: ACCOUNT_ID, token: API_TOKEN };
/** A live tick: an item is current. */
const LIVE = { mode: "item", currentItemId: "item-1", serviceEnded: false } as unknown as PcoLiveDTO;
const FAST: Partial<DeployTimings> = { backoffMinMs: 30, backoffMaxMs: 60, liveRecheckMs: 15 };

interface World {
  creds: DeployCredentials | null;
  live: PcoLiveDTO | null;
  version: string;
}
let world: World;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, what: string, ms = 4000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`still waiting after ${ms} ms for ${what}`);
    await sleep(5);
  }
}

const deployers: ServiceCueDeployer[] = [];
function makeDeployer(timings: Partial<DeployTimings> = FAST): ServiceCueDeployer {
  const d = new ServiceCueDeployer({
    bundleDir: bundle.dir,
    version: () => world.version,
    live: () => world.live,
    credentials: async () => world.creds,
    apiOrigin: cloudflareOrigin(fake.origin),
    timings,
  });
  deployers.push(d);
  return d;
}

beforeEach(() => {
  fake.reset();
  bundle = writeBundle();
  world = { creds: CREDS, live: null, version: "1.28.0" };
});
afterEach(() => {
  for (const d of deployers.splice(0)) d.stop();
  bundle.remove();
});

const puts = () => fake.puts.length;
const apiCalls = () => fake.requests.length;

describe("when a page differs from the build this server carries", () => {
  it("deploys, with every file new, and the card can say what happened", async (t) => {
    const lines = captureConsole(t, "log", "warn");
    const d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    const s = d.status();
    assert.equal(s.state, "current");
    assert.deepEqual(s.bundle, { build: BUILD_B, version: "1.28.0" });
    assert.equal(s.page?.build, BUILD_B);
    assert.equal(s.page?.version, "1.28.0");
    assert.ok(s.page?.at !== null && s.page?.at !== undefined && Math.abs(s.page.at - Date.now()) < 60_000);
    assert.deepEqual(s.files, { uploaded: 6, held: 0 });
    assert.equal(s.error, null);
    assert.equal(puts(), 1);
    assert.ok(lines.some((l) => l.startsWith("[servicecue-deploy] deploying build bbbbbbbbbbbb as 1.28.0: the page serves build aaaaaaaaaaaa")), lines.join("\n"));
    assert.ok(lines.some((l) => /6 files to upload, 0 already on Cloudflare/.test(l)));
    assert.ok(lines.some((l) => /deployed build bbbbbbbbbbbb as 1\.28\.0: 6 files uploaded, 0 already on Cloudflare/.test(l)));
  });

  it("deploys with nothing new to upload", async () => {
    const { files } = (await import("./servicecue-cloudflare.js")).readBundle(bundle.dir);
    for (const f of files) fake.held.add(f.hash);
    const d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    assert.deepEqual(d.status().files, { uploaded: 0, held: 6 });
    assert.equal(fake.uploaded.size, 0);
    assert.equal(puts(), 1);
  });

  it("uploads only the files that are new", async () => {
    const { files } = (await import("./servicecue-cloudflare.js")).readBundle(bundle.dir);
    for (const f of files.slice(0, 5)) fake.held.add(f.hash);
    const d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    assert.deepEqual(d.status().files, { uploaded: 1, held: 5 });
    assert.equal(fake.uploaded.size, 1);
  });

  it("deploys to a page that reports no build: a Worker from before it did", async () => {
    const d = makeDeployer();
    d.consider(null);
    await d.settled();
    assert.equal(d.status().state, "current");
    assert.equal(puts(), 1);
  });

  it("is told the build is the same after a deploy, and does not deploy again", async (t) => {
    captureConsole(t, "log");
    const d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    // The page's next status read may still show the old build for a moment.
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(puts(), 1, "a second deploy of what was just deployed");
    assert.equal(d.status().state, "current");
  });
});

describe("when the page is already the build this server carries", () => {
  it("does nothing to it, says so once however often it is asked, and reads the deployed version once", async (t) => {
    const lines = captureConsole(t, "log");
    fake.deployed = { tag: BUILD_B, message: "Stage Utility 1.27.0", at: new Date().toISOString() };
    const d = makeDeployer();
    for (let i = 0; i < 4; i++) {
      d.consider(BUILD_B);
      await d.settled();
    }
    assert.equal(puts(), 0);
    assert.equal(fake.to("POST", `/accounts/${ACCOUNT_ID}/workers/scripts/servicecue/assets-upload-session`).length, 0);
    assert.equal(fake.to("GET", `/accounts/${ACCOUNT_ID}/workers/scripts/servicecue/deployments`).length, 1, "what Cloudflare says about the page is read once");
    const s = d.status();
    assert.equal(s.state, "current");
    assert.equal(s.page?.version, "1.27.0");
    assert.ok(s.page?.at);
    assert.equal(lines.filter((l) => /the page is current/.test(l)).length, 1, lines.join("\n"));
  });
});

describe("with no token, or no copy of the page", () => {
  it("does nothing without a token, and says so once", async (t) => {
    world.creds = null;
    const lines = captureConsole(t, "log");
    const d = makeDeployer();
    for (let i = 0; i < 3; i++) {
      d.consider(BUILD_A);
      await d.settled();
    }
    assert.equal(apiCalls(), 0);
    assert.equal(d.status().state, "off");
    assert.equal(d.status().token, "");
    assert.equal(lines.filter((l) => /no Cloudflare API token is set/.test(l)).length, 1);
  });

  it("says there is no copy of the page when this build has no bundle, and why when its bundle failed", async (t) => {
    const lines = captureConsole(t, "log");
    fs.rmSync(bundle.dir, { recursive: true });
    const d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    let s = d.status();
    assert.equal(s.state, "no-bundle");
    assert.equal(s.bundle, null);
    assert.match(s.noBundle ?? "", /this build has no copy of the page: it has no build\/servicecue\/deploy.json/);
    assert.equal(apiCalls(), 0);

    fs.writeFileSync(`${bundle.dir}.failed`, "deadbeef\nvite could not load the config\n");
    d.consider(BUILD_A);
    await d.settled();
    s = d.status();
    assert.match(s.noBundle ?? "", /its bundle failed \(vite could not load the config\)/);
    assert.ok(lines.some((l) => /nothing to deploy: this build has no copy of the page: its bundle failed/.test(l)));
    fs.rmSync(`${bundle.dir}.failed`);
  });
});

describe("the no-downgrade rule", () => {
  const deployedFrom = (version: string) => {
    fake.deployed = { tag: BUILD_A, message: `Stage Utility ${version}`, at: new Date().toISOString() };
  };

  it("leaves a page deployed from a newer version alone, says so once, and does not ask Cloudflare again", async (t) => {
    const lines = captureConsole(t, "log");
    world.version = "1.27.0";
    deployedFrom("1.28.0");
    const d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(d.status().state, "newer");
    assert.equal(puts(), 0);
    assert.equal(d.status().page?.version, "1.28.0");
    assert.equal(d.status().runningVersion, "1.27.0");
    const calls = apiCalls();
    for (let i = 0; i < 3; i++) {
      d.consider(BUILD_A);
      await d.settled();
    }
    assert.equal(apiCalls(), calls, "the same question was put to Cloudflare again");
    assert.equal(lines.filter((l) => /newer than this server's 1\.27\.0/.test(l)).length, 1, lines.join("\n"));
  });

  it("follows semver, a prerelease being older than its release", async (t) => {
    captureConsole(t, "log");
    const cases: [running: string, deployed: string, deploys: boolean][] = [
      ["1.28.0-beta.1", "1.28.0", false],
      ["1.28.0", "1.28.0-beta.3", true],
      ["1.28.0-beta.2", "1.28.0-beta.10", false],
      ["1.28.0-beta.10", "1.28.0-beta.2", true],
      ["1.28.0", "1.28.0", true],
      ["1.9.0", "1.10.0", false],
      ["2.0.0", "1.99.99", true],
    ];
    for (const [running, deployed, deploys] of cases) {
      fake.reset();
      world.version = running;
      deployedFrom(deployed);
      const d = makeDeployer();
      d.consider(BUILD_A);
      await d.settled();
      assert.equal(puts(), deploys ? 1 : 0, `running ${running}, deployed ${deployed}`);
      assert.equal(d.status().state, deploys ? "current" : "newer", `running ${running}, deployed ${deployed}`);
      d.stop();
    }
  });

  it("compares the RUNNING version, not the one deploy.json was made at", async (t) => {
    captureConsole(t, "log");
    // A release that changed nothing the page is built from leaves deploy.json at an earlier version.
    // Stale and lower than the page's: a rule that read it would deploy over a newer page...
    bundle.remove();
    bundle = writeBundle({ manifest: { version: "1.20.0" } });
    world.version = "1.26.0";
    deployedFrom("1.27.0");
    let d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(puts(), 0, "deploy.json's old version let a downgrade through");
    assert.equal(d.status().state, "newer");

    // ...and stale and higher than the page's would refuse a deploy that is no downgrade at all.
    fake.reset();
    bundle.remove();
    bundle = writeBundle({ manifest: { version: "1.99.0" } });
    world.version = "1.28.0";
    deployedFrom("1.27.0");
    d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(puts(), 1, "deploy.json's version blocked a deploy over an older page");
    // What is recorded with the upload is the running version too.
    assert.equal((fake.puts[0].metadata.annotations as Record<string, string>)["workers/message"], "Stage Utility 1.28.0");
  });

  it("deploys over a page it cannot tell the version of: one deployed by hand", async (t) => {
    captureConsole(t, "log");
    fake.deployed = { at: new Date().toISOString() };
    const d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(puts(), 1);
  });
});

describe("a service being live", () => {
  it("is never deployed through: waits, says so once, and goes when the service ends", async (t) => {
    const lines = captureConsole(t, "log");
    world.live = LIVE;
    const d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(d.status().state, "waiting");
    assert.equal(d.status().waiting, "service-live");
    await sleep(100);
    assert.equal(apiCalls(), 0, "Cloudflare was called during a live service");
    assert.equal(lines.filter((l) => /a service is live/.test(l)).length, 1, "said once, however long the wait");

    world.live = null;
    await waitFor(() => d.status().state === "current", "the deploy once the service ended");
    assert.equal(puts(), 1);
    assert.equal(d.status().waiting, null);
  });

  it("is not live before an item is current, nor after the plan's SERVICE END", async (t) => {
    captureConsole(t, "log");
    assert.equal(serviceIsLive(null), false);
    assert.equal(serviceIsLive(LIVE), true);
    assert.equal(serviceIsLive({ ...LIVE, serviceEnded: true } as PcoLiveDTO), false);
    assert.equal(serviceIsLive({ mode: "preservice", currentItemId: null } as unknown as PcoLiveDTO), false);
    assert.equal(serviceIsLive({ mode: "none", currentItemId: null } as unknown as PcoLiveDTO), false);
    assert.equal(serviceIsLive({ mode: "item", currentItemId: null } as unknown as PcoLiveDTO), false);
    world.live = { ...LIVE, serviceEnded: true } as PcoLiveDTO;
    const d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(puts(), 1, "a service past its end is over");
  });

  it("stops waiting when the publisher stops", async (t) => {
    captureConsole(t, "log");
    world.live = LIVE;
    const d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    d.stop();
    world.live = null;
    await sleep(100);
    assert.equal(apiCalls(), 0, "a stopped publisher still deployed");
    assert.equal(d.status().state, "unchecked");
  });
});

describe("a failure", () => {
  it("leaves nothing claiming success, keeps Cloudflare's code and words, and is tried again on the backoff", async (t) => {
    const lines = captureConsole(t, "log", "warn");
    let broken = true;
    fake.respond = (r) => (broken && r.path.startsWith(`/accounts/${ACCOUNT_ID}/workers/assets/upload`) ? failure(500, 10013, "internal error, try again") : undefined);
    const d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    let s = d.status();
    assert.equal(s.state, "failed");
    assert.equal(puts(), 0, "the Worker was uploaded after its files failed");
    assert.equal(s.files, null, "files claimed uploaded");
    assert.notEqual(s.page?.build, BUILD_B, "the page is claimed to be the new build");
    assert.deepEqual({ code: s.error?.code, status: s.error?.status, step: s.error?.step, refused: s.error?.refused }, { code: 10013, status: 500, step: "upload the files", refused: false });
    assert.match(s.error?.message ?? "", /internal error, try again/);
    assert.ok(s.error?.retryAt && s.error.retryAt > Date.now() - 1);
    assert.ok(lines.some((l) => /the update failed at "upload the files" \(HTTP 500, code 10013\): HTTP 500: internal error, try again\. The page is unchanged\. Trying again in/.test(l)), lines.join("\n"));

    broken = false;
    await waitFor(() => d.status().state === "current", "the retry");
    s = d.status();
    assert.equal(s.error, null);
    assert.equal(puts(), 1);
  });

  it("is not tried again before its backoff is up, whatever the page reports", async (t) => {
    captureConsole(t, "log", "warn");
    fake.respond = (r) => (r.path.endsWith("/assets-upload-session") ? failure(500, 1, "down") : undefined);
    const d = makeDeployer({ backoffMinMs: 60_000, backoffMaxMs: 60_000, liveRecheckMs: 15 });
    d.consider(BUILD_A);
    await d.settled();
    const calls = apiCalls();
    for (let i = 0; i < 3; i++) {
      d.consider(BUILD_A);
      await d.settled();
    }
    assert.equal(apiCalls(), calls, "a status read retried inside the backoff");
    assert.ok((d.status().error?.retryAt ?? 0) > Date.now() + 50_000);
  });

  it("doubles its wait up to the ceiling: a minute, then two, to once an hour", () => {
    // The publisher's own function, with the deployer's numbers.
    const waits = [1, 2, 3, 4, 5, 6, 7, 8, 12].map((n) => backoffMs(n, DEFAULT_DEPLOY_TIMINGS.backoffMinMs, DEFAULT_DEPLOY_TIMINGS.backoffMaxMs) / 60_000);
    assert.deepEqual(waits, [1, 2, 4, 8, 16, 32, 60, 60, 60]);
  });

  it("is not retried when the token is refused, until the token changes", async (t) => {
    const lines = captureConsole(t, "log", "warn");
    fake.token = "a-different-token-0123456789abcdef";
    const d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    const s = d.status();
    assert.equal(s.state, "failed");
    assert.equal(s.error?.refused, true);
    assert.equal(s.error?.retryAt, null);
    assert.equal(s.error?.code, 1000);
    assert.equal(puts(), 0);
    assert.ok(lines.some((l) => /Not trying again until the token changes/.test(l)));

    const calls = apiCalls();
    await sleep(120);
    d.consider(BUILD_A);
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(apiCalls(), calls, "a refused token was tried again on its own");

    // The token is replaced: that is the one thing that lifts the hold.
    fake.token = API_TOKEN;
    await d.credentialsChanged();
    await d.settled();
    assert.equal(d.status().state, "current");
    assert.equal(puts(), 1);
  });

  it("is held on a 403 as well, and says the token is refused when reading a page that is current", async (t) => {
    captureConsole(t, "log", "warn");
    fake.respond = (r) => (r.path.endsWith("/deployments") ? failure(403, 10000, "Authentication error") : undefined);
    const d = makeDeployer();
    d.consider(BUILD_B);
    await d.settled();
    const s = d.status();
    assert.equal(s.state, "failed", "a revoked token reads as the token no longer working");
    assert.equal(s.error?.refused, true);
    assert.equal(s.page?.build, BUILD_B, "the page itself is unchanged and current");
    const calls = apiCalls();
    d.consider(BUILD_B);
    await d.settled();
    assert.equal(apiCalls(), calls);
  });

  it("is a failed read and not a failed page when a current page cannot be read about", async (t) => {
    captureConsole(t, "log", "warn");
    fake.respond = (r) => (r.path.endsWith("/deployments") ? failure(500, 1, "down") : undefined);
    const d = makeDeployer({ backoffMinMs: 60_000, backoffMaxMs: 60_000, liveRecheckMs: 15 });
    d.consider(BUILD_B);
    await d.settled();
    const s = d.status();
    assert.equal(s.state, "current");
    assert.equal(s.error?.step, "read the deployed version");
    assert.equal(s.page?.at, null);
  });
});

describe("Update the page now", () => {
  const deployedFrom = (version: string) => {
    fake.deployed = { tag: BUILD_A, message: `Stage Utility ${version}`, at: new Date().toISOString() };
  };

  it("deploys over an older page, without a confirmation", async (t) => {
    captureConsole(t, "log");
    deployedFrom("1.20.0");
    const d = makeDeployer();
    const outcome = await d.deployNow();
    assert.deepEqual(outcome, { kind: "deployed", uploaded: 6, held: 0 });
    assert.equal(puts(), 1);
  });

  it("will not roll a newer page back without confirmDowngrade, and does with it", async (t) => {
    const lines = captureConsole(t, "log");
    world.version = "1.27.0";
    deployedFrom("1.28.0");
    const d = makeDeployer();
    const refused = await d.deployNow();
    assert.deepEqual(refused, { kind: "newer", pageVersion: "1.28.0", runningVersion: "1.27.0" });
    assert.equal(puts(), 0);
    assert.equal(d.status().state, "newer");

    assert.deepEqual(await d.deployNow({ confirmDowngrade: false }), refused);
    assert.equal(puts(), 0);

    const outcome = await d.deployNow({ confirmDowngrade: true });
    assert.equal(outcome.kind, "deployed");
    assert.equal(puts(), 1);
    assert.equal(d.status().state, "current");
    assert.equal(d.status().page?.version, "1.27.0", "what is recorded now is the version that deployed it");
    assert.ok(lines.some((l) => /over a newer page, as confirmed/.test(l)));
  });

  it("is not made during a live service, and says so", async (t) => {
    captureConsole(t, "log");
    world.live = LIVE;
    const d = makeDeployer();
    assert.deepEqual(await d.deployNow({ confirmDowngrade: true }), { kind: "waiting" });
    assert.equal(apiCalls(), 0);
  });

  it("says there is no token, and no copy of the page, without calling Cloudflare", async (t) => {
    captureConsole(t, "log");
    world.creds = null;
    const d = makeDeployer();
    assert.deepEqual(await d.deployNow(), { kind: "off" });
    world.creds = CREDS;
    fs.rmSync(bundle.dir, { recursive: true });
    assert.equal((await d.deployNow()).kind, "no-bundle");
    assert.equal(apiCalls(), 0);
  });

  it("answers current, and uploads nothing, when the page is already this build", async (t) => {
    captureConsole(t, "log");
    const d = makeDeployer();
    d.consider(BUILD_B);
    await d.settled();
    assert.deepEqual(await d.deployNow(), { kind: "current" });
    assert.equal(puts(), 0);
  });

  it("goes ahead of a refused token and of a backoff: somebody asked", async (t) => {
    captureConsole(t, "log", "warn");
    fake.token = "a-different-token-0123456789abcdef";
    const d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(d.status().error?.refused, true);
    fake.token = API_TOKEN;
    assert.equal((await d.deployNow()).kind, "deployed");
  });

  it("reports a failure to the caller", async (t) => {
    captureConsole(t, "log", "warn");
    fake.respond = (r) => (r.method === "PUT" ? failure(400, 10021, "bad module") : undefined);
    const d = makeDeployer();
    const outcome = await d.deployNow();
    assert.equal(outcome.kind, "failed");
    assert.match((outcome as { message: string }).message, /bad module/);
    assert.equal(d.status().state, "failed");
  });
});

describe("one deploy at a time", () => {
  it("shares a deploy between every request that arrives during it", async (t) => {
    captureConsole(t, "log");
    // Slow enough that the others arrive while the first is under way.
    fake.respond = async (r) => {
      if (r.method === "PUT") await sleep(80);
      return undefined;
    };
    const d = makeDeployer();
    d.consider(BUILD_A);
    const [a, b, c] = await Promise.all([d.deployNow(), d.deployNow({ confirmDowngrade: true }), d.deployNow()]);
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(puts(), 1, "two deploys ran at once");
    assert.equal(fake.to("POST", `/accounts/${ACCOUNT_ID}/workers/scripts/servicecue/assets-upload-session`).length, 1);
    for (const o of [a, b, c]) assert.deepEqual(o, { kind: "deployed", uploaded: 6, held: 0 });
  });
});

describe("one deploy at a time, from the publisher too", () => {
  it("does not start a second deploy when the page's status is read again during one", async (t) => {
    captureConsole(t, "log");
    fake.respond = async (r) => {
      if (r.method === "PUT") await sleep(80);
      return undefined;
    };
    const d = makeDeployer();
    d.consider(BUILD_A);
    await waitFor(() => d.status().state === "updating", "the deploy to start");
    // Every status read of the next minute lands in the middle of it.
    d.consider(BUILD_A);
    d.consider(null);
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(puts(), 1, "a status read during a deploy started another");
    assert.equal(fake.to("POST", `/accounts/${ACCOUNT_ID}/workers/scripts/servicecue/assets-upload-session`).length, 1);
  });
});

describe("what the card and the log never carry", () => {
  it("holds neither the API token nor a token Cloudflare handed back, in a status, a log line or a failure", async (t) => {
    const lines = captureConsole(t, "log", "warn", "error");
    const everything: string[] = [];
    const d = makeDeployer();
    const snap = () => everything.push(JSON.stringify(d.status()));

    // A success.
    d.consider(BUILD_A);
    await d.settled();
    snap();

    // A failure that echoes what it was sent, as a careless API could.
    fake.reset();
    fake.respond = (r) => {
      if (r.method !== "PUT") return undefined;
      const jwt = (r.bytes.toString("utf8").match(/"jwt":"([^"]+)"/) ?? [])[1] ?? "";
      return failure(400, 10021, `saw ${API_TOKEN} and ${jwt}`);
    };
    const e = makeDeployer({ backoffMinMs: 60_000, backoffMaxMs: 60_000, liveRecheckMs: 15 });
    e.consider(BUILD_A);
    await e.settled();
    everything.push(JSON.stringify(e.status()));
    assert.match(e.status().error?.message ?? "", /\[removed\]/, "the failure did not pass through the redaction");

    const text = [...lines, ...everything].join("\n");
    assert.doesNotMatch(text, new RegExp(API_TOKEN), "the API token reached a log line or a status");
    assert.doesNotMatch(text, /\.sig\b/, "an upload or completion token (JWT-shaped) reached a log line or a status");
    assert.equal(e.status().token, "••••", "the card is told a token is stored, not what it is");
  });
});

describe("the version rule", () => {
  it("is semver precedence, and a version it cannot read is older", () => {
    assert.equal(isOlderVersion("1.27.0", "1.28.0"), true);
    assert.equal(isOlderVersion("1.28.0", "1.28.0"), false);
    assert.equal(isOlderVersion("1.28.0", "1.28.0-beta.9"), false);
    assert.equal(isOlderVersion("1.28.0-beta.9", "1.28.0"), true);
    assert.equal(isOlderVersion("0.0.0", "1.0.0"), true);
    assert.equal(isOlderVersion("dev", "1.0.0"), true);
  });
});
