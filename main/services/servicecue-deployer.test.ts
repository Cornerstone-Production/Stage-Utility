// When the server updates the public page, and what it does when that goes wrong, against a fake
// Cloudflare that is a real HTTP server and a bundle folder written to disk. The wire protocol is
// held in servicecue-cloudflare.test.ts; this holds the decisions.

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs";

import { captureConsole } from "./fixtures/capture-console.js";
import { sleep } from "./fixtures/publisher-harness.js";
import { within } from "./fixtures/within.js";
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
const FAST: Partial<DeployTimings> = { backoffMinMs: 30, backoffMaxMs: 60, liveRecheckMs: 15, justDeployedMs: 120_000 };

interface World {
  creds: DeployCredentials | null;
  live: PcoLiveDTO | null;
  /** Have the service times been read since the server started? */
  known: boolean;
  version: string;
}
let world: World;

/** Until `check` holds, bounded on the real clock; the poll stops when the wait does. */
async function until(check: () => boolean, what: string): Promise<void> {
  let waiting = true;
  try {
    await within(
      (async () => {
        while (waiting && !check()) await new Promise((r) => setImmediate(r));
      })(),
      what,
    );
  } finally {
    waiting = false;
  }
}
const reaches = (d: ServiceCueDeployer, state: string) => until(() => d.status().state === state, `the state ${state}`);

const deployers: ServiceCueDeployer[] = [];
function makeDeployer(timings: Partial<DeployTimings> = FAST): ServiceCueDeployer {
  const d = new ServiceCueDeployer({
    bundleDir: bundle.dir,
    version: () => world.version,
    live: () => world.live,
    serviceTimesKnown: () => world.known,
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
  world = { creds: CREDS, live: null, known: true, version: "1.28.0" };
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
    assert.equal(d.status().waitingFor, "live");
    await sleep(100);
    assert.equal(apiCalls(), 0, "Cloudflare was called during a live service");
    assert.equal(lines.filter((l) => /a service is live/.test(l)).length, 1, "said once, however long the wait");

    world.live = null;
    await reaches(d, "current");
    assert.equal(d.status().waitingFor, null, "a reason for waiting outlived the wait");
    assert.equal(puts(), 1);
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
    assert.ok(lines.some((l) => /the update failed at "upload the files" \(HTTP 500, code 10013\): internal error, try again\. The page is unchanged\. Trying again in/.test(l)), lines.join("\n"));

    broken = false;
    await reaches(d, "current");
    s = d.status();
    assert.equal(s.error, null);
    assert.equal(puts(), 1);
  });

  it("is still tried again when a status read lands inside the backoff: that read does not take the retry with it", async (t) => {
    captureConsole(t, "log", "warn");
    let broken = true;
    fake.respond = (r) => (broken && r.method === "PUT" ? failure(500, 1, "down") : undefined);
    const d = makeDeployer({ ...FAST, backoffMinMs: 80, backoffMaxMs: 80 });
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(d.status().state, "failed");
    broken = false;
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(d.status().state, "failed", "the backoff was not waited out");
    await reaches(d, "current");
    assert.equal(puts(), 1);
  });

  it("is not tried again before its backoff is up, whatever the page reports", async (t) => {
    captureConsole(t, "log", "warn");
    fake.respond = (r) => (r.path.endsWith("/assets-upload-session") ? failure(500, 1, "down") : undefined);
    const d = makeDeployer({ ...FAST, backoffMinMs: 60_000, backoffMaxMs: 60_000 });
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

  it("is not retried when the token is refused (401 on a deploy, 403 reading a current page) until the token changes", async (t) => {
    const lines = captureConsole(t, "log", "warn");
    const cases: { name: string; page: string; refuse(): void; code: number; mends(): void }[] = [
      { name: "401 on a deploy", page: BUILD_A, refuse: () => void (fake.token = "a-different-token-0123456789abcdef"), code: 1000, mends: () => void (fake.token = API_TOKEN) },
      {
        name: "403 reading a page that is current",
        page: BUILD_B,
        refuse: () => void (fake.respond = (r) => (r.path.endsWith("/deployments") ? failure(403, 10000, "Authentication error") : undefined)),
        code: 10000,
        mends: () => void (fake.respond = () => undefined),
      },
    ];
    for (const c of cases) {
      fake.reset();
      c.refuse();
      const d = makeDeployer();
      d.consider(c.page);
      await d.settled();
      const s = d.status();
      assert.equal(s.state, "failed", c.name);
      assert.equal(s.error?.refused, true, c.name);
      assert.equal(s.error?.retryAt, null, c.name);
      assert.equal(s.error?.code, c.code, c.name);
      assert.equal(puts(), 0);
      assert.ok(lines.some((l) => /Not trying again until the token changes/.test(l)));

      const calls = apiCalls();
      await sleep(120);
      d.consider(c.page);
      d.consider(c.page);
      await d.settled();
      assert.equal(apiCalls(), calls, `${c.name}: a refused token was tried again on its own`);

      // The token is replaced: that is the one thing that lifts the hold.
      c.mends();
      await d.credentialsChanged();
      await d.settled();
      assert.equal(d.status().state, "current", c.name);
      assert.equal(d.status().error, null, c.name);
      d.stop();
    }
  });

  it("is a failed read and not a failed page when a current page cannot be read about", async (t) => {
    captureConsole(t, "log", "warn");
    fake.respond = (r) => (r.path.endsWith("/deployments") ? failure(500, 1, "down") : undefined);
    const d = makeDeployer({ ...FAST, backoffMinMs: 60_000, backoffMaxMs: 60_000 });
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
    assert.ok(lines.some((l) => /over a page left alone until now, as confirmed/.test(l)));
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
    await reaches(d, "updating");
    // Every status read of the next minute lands in the middle of it.
    d.consider(BUILD_A);
    d.consider(null);
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(puts(), 1, "a status read during a deploy started another");
    assert.equal(fake.to("POST", `/accounts/${ACCOUNT_ID}/workers/scripts/servicecue/assets-upload-session`).length, 1);
  });
});

describe("another server at the same version", () => {
  const deployedBy = (build: string, version: string) => {
    fake.deployed = { tag: build, message: `Stage Utility ${version}`, at: new Date().toISOString() };
  };

  it("leaves a page deployed from the same version by another build alone, so two servers do not undo each other", async (t) => {
    const lines = captureConsole(t, "log");
    // The other server's build; this server carries BUILD_B, both at 1.28.0.
    deployedBy(BUILD_A, "1.28.0");
    const d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(d.status().state, "other-build");
    assert.equal(puts(), 0, "a server undid another's deploy at the same version");
    const calls = apiCalls();
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(apiCalls(), calls, "the same question was put to Cloudflare again");
    assert.equal(lines.filter((l) => /another build than its bbbbbbbbbbbb, so it is left as it is/.test(l)).length, 1, lines.join("\n"));
  });

  it("is not a flip-flop between two servers: the one that deployed second is not deployed over by the first", async (t) => {
    captureConsole(t, "log");
    const second = writeBundle({ manifest: { build: BUILD_A } });
    try {
      const first = makeDeployer();
      first.consider("cccccccccccc");
      await first.settled();
      assert.equal(puts(), 1, "the first server deploys over an older page");
      const other = new ServiceCueDeployer({ bundleDir: second.dir, version: () => "1.28.0", live: () => null, serviceTimesKnown: () => true, credentials: async () => CREDS, apiOrigin: cloudflareOrigin(fake.origin), timings: FAST });
      deployers.push(other);
      // The first server's page is what the other reads: another build, the same version.
      other.consider(BUILD_B);
      await other.settled();
      assert.equal(other.status().state, "other-build");
      assert.equal(puts(), 1, "the second server deployed over the first's");
      // And the first, reading its own page, leaves it be.
      first.consider(BUILD_B);
      await first.settled();
      assert.equal(puts(), 1);
    } finally {
      second.remove();
    }
  });

  it("deploys when the version is the same and the page has no recorded build, and over an older prerelease of the same release", async (t) => {
    captureConsole(t, "log");
    fake.deployed = { message: "Stage Utility 1.28.0", at: new Date().toISOString() };
    let d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(puts(), 1);
    fake.reset();
    deployedBy(BUILD_A, "1.28.0-beta.3");
    d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(puts(), 1);
  });

  it("is replaced by Update the page now only with the confirmation", async (t) => {
    captureConsole(t, "log");
    deployedBy(BUILD_A, "1.28.0");
    const d = makeDeployer();
    assert.deepEqual(await d.deployNow(), { kind: "other-build", pageBuild: BUILD_A, version: "1.28.0" });
    assert.equal(puts(), 0);
    assert.equal((await d.deployNow({ confirmDowngrade: true })).kind, "deployed");
    assert.equal(puts(), 1);
  });
});

describe("a live state that is not known", () => {
  it("counts as live on the server's own account: after a restart, or a Planning Center outage, nothing is deployed until the service times are known", async (t) => {
    const lines = captureConsole(t, "log");
    world.live = null; // as getLastLive() is, after a restart, until the first Planning Center read
    world.known = false;
    const d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(d.status().state, "waiting");
    assert.equal(d.status().waitingFor, "unknown");
    await sleep(100);
    assert.equal(apiCalls(), 0, "a deploy went out before the live state was known");
    assert.ok(lines.some((l) => /the service times are not known \(the server has just started, or Planning Center cannot be reached\)/.test(l)));

    world.known = true;
    await reaches(d, "current");
    assert.equal(puts(), 1);
  });

  it("is gone ahead of by an explicit Update the page now, which says so, and never when a service is known to be live", async (t) => {
    const lines = captureConsole(t, "log");
    world.known = false;
    const d = makeDeployer();
    const outcome = await d.deployNow();
    assert.deepEqual(outcome, { kind: "deployed", uploaded: 6, held: 0, serviceStateUnknown: true });
    assert.equal(puts(), 1);
    assert.ok(lines.some((l) => /with the service state unknown, as asked/.test(l)));

    // A live service, known, wins over unknown.
    fake.reset();
    world.live = LIVE;
    const e = makeDeployer({ ...FAST, nowEveryMs: 0 });
    assert.deepEqual(await e.deployNow({ confirmDowngrade: true }), { kind: "waiting" });
    assert.equal(apiCalls(), 0);

    // And known, it carries no such word.
    world.live = null;
    world.known = true;
    const known = await e.deployNow();
    assert.equal(known.kind === "deployed" && "serviceStateUnknown" in known, false);
  });
});

describe("credentials that change under an attempt", () => {
  it("do not leave the new token held by the old token's refusal", async (t) => {
    captureConsole(t, "log", "warn");
    const NEW_TOKEN = "cf-replacement-token-0123456789ABCDEF_-9";
    fake.token = NEW_TOKEN; // the old token has been revoked
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake.respond = async (r) => {
      // The old token's attempt is on the wire when the new one is saved.
      if (r.path === "/user/tokens/verify" && r.authorization === `Bearer ${API_TOKEN}`) await gate;
      return undefined;
    };
    const d = makeDeployer();
    d.consider(BUILD_A);
    await until(() => apiCalls() > 0, "the attempt to reach Cloudflare");
    world.creds = { accountId: ACCOUNT_ID, token: NEW_TOKEN };
    const changed = d.credentialsChanged();
    release();
    await changed;
    await d.settled();
    await d.settled();
    assert.equal(d.status().state, "current", "the stale 401 held the new token");
    assert.equal(d.status().error, null);
    assert.equal(puts(), 1);
  });
});

describe("a deploy that does not change the page", () => {
  /** Deployed by this deployer, and the grace is past: the next reads of the page are the ones that count. */
  async function deployedAndGraceOver(t: Parameters<typeof captureConsole>[0]) {
    const lines = captureConsole(t, "log", "warn");
    const d = makeDeployer({ ...FAST, justDeployedMs: 20 });
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(puts(), 1);
    await sleep(40);
    return { d, lines };
  }
  const read = async (d: ServiceCueDeployer, build: string | null) => {
    d.consider(build);
    await d.settled();
  };

  it("is not the page: two reads past the grace still showing the old build, and Cloudflare holding ours, say so, stop, and never show current", async (t) => {
    const { d, lines } = await deployedAndGraceOver(t);
    await read(d, BUILD_A);
    assert.equal(d.status().state, "current", "one read is not yet a finding");
    assert.equal(d.status().error, null);
    await read(d, BUILD_A);
    const s = d.status();
    assert.equal(s.state, "failed");
    assert.match(s.error?.message ?? "", /^deployed build bbbbbbbbbbbb to Worker 'servicecue', but the page still serves aaaaaaaaaaaa: is that Worker the page\?$/);
    assert.ok(lines.some((l) => /Nothing more is deployed on its own until the credentials or the bundle change/.test(l)));
    const calls = apiCalls();
    const states: string[] = [];
    for (let i = 0; i < 3; i++) {
      await read(d, BUILD_A);
      states.push(d.status().state);
    }
    assert.equal(apiCalls(), calls, "it went on deploying to a Worker that is not the page");
    assert.equal(puts(), 1);
    assert.ok(states.every((x) => x === "failed"), `current was shown: ${states.join(",")}`);

    // New credentials lift it.
    await d.credentialsChanged();
    await d.settled();
    assert.equal(puts(), 2);
  });

  it("is not a finding while the page has had less than the grace to catch up", async (t) => {
    captureConsole(t, "log");
    const d = makeDeployer({ ...FAST, justDeployedMs: 120_000 });
    d.consider(BUILD_A);
    await d.settled();
    for (let i = 0; i < 4; i++) await read(d, BUILD_A);
    assert.equal(d.status().state, "current");
    assert.equal(d.status().error, null);
    assert.equal(puts(), 1);
  });

  it("is lifted when the page later reports this build (slow propagation), whether or not publishing was stopped in between", async (t) => {
    const { d } = await deployedAndGraceOver(t);
    await read(d, BUILD_A);
    await read(d, BUILD_A);
    assert.equal(d.status().state, "failed", "the setup is a server that has said the Worker is not the page");
    d.stop();
    await read(d, BUILD_B);
    assert.equal(d.status().state, "current");
    assert.equal(d.status().error, null);
    const calls = apiCalls();
    await read(d, BUILD_B);
    assert.equal(apiCalls(), calls);
    // And a single old read after that is the start of a new count, not a hold.
    await read(d, BUILD_A);
    assert.notEqual(d.status().state, "failed");
  });

  it("is not tripped, nor cleared, by a read with no build: a Worker whose asset read threw says null", async (t) => {
    const { d } = await deployedAndGraceOver(t);
    for (let i = 0; i < 4; i++) await read(d, null);
    assert.equal(d.status().state, "current");
    assert.equal(d.status().error, null);
    assert.equal(puts(), 1, "a null read made a deploy");
    // Nor does it clear what two real reads found.
    await read(d, BUILD_A);
    await read(d, BUILD_A);
    assert.equal(d.status().state, "failed");
    await read(d, null);
    assert.equal(d.status().state, "failed");
    assert.ok(d.status().error);
  });

  it("is not the Worker's fault when another server has deployed a newer version over it: that is newer", async (t) => {
    const { d, lines } = await deployedAndGraceOver(t);
    fake.deployed = { tag: "cccccccccccc", message: "Stage Utility 99.0.0", at: new Date().toISOString() };
    await read(d, "cccccccccccc");
    await read(d, "cccccccccccc");
    const s = d.status();
    assert.equal(s.state, "newer");
    assert.equal(s.error, null);
    assert.equal(puts(), 1);
    assert.ok(!lines.some((l) => /is that Worker the page/.test(l)), "a newer deploy by another server was called 'not the page'");
  });

  it("is the other-build case when another server at this version deployed over it", async (t) => {
    const { d } = await deployedAndGraceOver(t);
    fake.deployed = { tag: "cccccccccccc", message: "Stage Utility 1.28.0", at: new Date().toISOString() };
    await read(d, "cccccccccccc");
    await read(d, "cccccccccccc");
    assert.equal(d.status().state, "other-build");
    assert.equal(puts(), 1);
  });
});

describe("the state after a decision that deploys nothing", () => {
  it("is the memo's, not whatever came before: newer, then a live service, then its end, is newer again", async (t) => {
    captureConsole(t, "log");
    world.version = "1.27.0";
    fake.deployed = { tag: BUILD_A, message: "Stage Utility 1.28.0", at: new Date().toISOString() };
    const d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(d.status().state, "newer");
    world.live = LIVE;
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(d.status().state, "waiting");
    world.live = null;
    await reaches(d, "newer");
    // Publishing stops and starts: still what it was, never "unchecked" for a page that is known.
    d.stop();
    assert.equal(d.status().state, "newer");
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(d.status().state, "newer");
    assert.equal(puts(), 0);
  });

  it("is failed while a refusal or the backoff holds, not unchecked", async (t) => {
    captureConsole(t, "log", "warn");
    fake.token = "a-different-token-0123456789abcdef";
    const d = makeDeployer();
    d.consider(BUILD_A);
    await d.settled();
    d.stop();
    assert.equal(d.status().state, "failed");
    d.consider(BUILD_A);
    await d.settled();
    assert.equal(d.status().state, "failed");
  });
});

describe("Update the page now, repeated", () => {
  it("does not upload a page that is already this build, and lets one deploy through in a minute", async (t) => {
    captureConsole(t, "log");
    const d = makeDeployer();
    assert.equal((await d.deployNow()).kind, "deployed");
    assert.deepEqual(await d.deployNow(), { kind: "current" }, "the page is the build that was just deployed");
    assert.deepEqual(await d.deployNow(), { kind: "current" });
    assert.equal(puts(), 1, "three presses made more than one deploy");

    // The page reads as another build again (somebody else, or a glitch): still not more often than a minute.
    d.consider(BUILD_A);
    await d.settled();
    const limited = await d.deployNow();
    assert.equal(limited.kind, "limited");
    assert.ok(limited.kind === "limited" && limited.retryAfterSec > 0 && limited.retryAfterSec <= 60);
    assert.equal((await d.deployNow()).kind, "limited");
    assert.equal(puts(), 1);
  });

  it("allows another deploy once the minute is up, and does not count a refusal or a failure against it", async (t) => {
    captureConsole(t, "log", "warn");
    const d = makeDeployer({ ...FAST, nowEveryMs: 40 });
    fake.respond = (r) => (r.method === "PUT" ? failure(500, 1, "down") : undefined);
    assert.equal((await d.deployNow()).kind, "failed");
    fake.respond = () => undefined;
    assert.equal((await d.deployNow()).kind, "deployed", "a failed deploy used up the minute");
    d.consider(BUILD_A);
    await d.settled();
    assert.equal((await d.deployNow()).kind, "limited");
    await sleep(60);
    assert.equal((await d.deployNow()).kind, "deployed");
  });
});

describe("a Worker that is not there", () => {
  it("is a clear failure, and nothing is uploaded: creating a Worker is a manual first step", async (t) => {
    captureConsole(t, "log", "warn");
    fake.missingWorker = true;
    const d = makeDeployer();
    const outcome = await d.deployNow();
    assert.equal(outcome.kind, "failed");
    assert.match((outcome as { message: string }).message, /the Worker 'servicecue' does not exist on this account: create it once by hand/);
    assert.equal(puts(), 0);
    assert.equal(fake.requests.filter((r) => r.method === "PUT" || r.method === "POST").length, 0, "something was sent to a Worker that is not there");
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
    const e = makeDeployer({ ...FAST, backoffMinMs: 60_000, backoffMaxMs: 60_000 });
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
