// The routes behind "Keep the page up to date": the Cloudflare account ID and API token, and "Update
// the page now". Through the real routes, the real stores and the real secrets file.
//
// What these hold: the token is write-only and never in a file a backup carries, it belongs to the
// address it was saved for and a changed address takes it, and each way the deploy can be refused
// reaches the caller as a status and a code it can act on. The deploy itself is the deployer's own
// test; here `deployNow` is told what to answer.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import { captureConsole } from "../fixtures/capture-console.js";
import { FakeCloudflare } from "../fixtures/fake-cloudflare.js";
import { BUILD_A, BUILD_B, writeBundle } from "../fixtures/deploy-bundle.js";
import { FakeReceiver } from "../fixtures/publish-receiver.js";
import { MASK } from "../mask.js";
import { callRoute } from "./route-harness.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-deploy-routes-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");
// The page's address is on this machine (the receiver sets the switch), and so is "Cloudflare": nothing here leaves it.
const cloudflare = await FakeCloudflare.start();
process.env.STAGE_UTILITY_CLOUDFLARE_API = cloudflare.origin;
// The page's copy: a folder the test writes, so the deploy through the routes has something to send.
const BUNDLE = path.join(TMP, "bundle", "servicecue");
process.env.STAGE_UTILITY_SERVICECUE_BUNDLE = BUNDLE;

const { serviceCuePublishRoutes } = await import("./servicecue-publish-routes.js");
const { servicecuePublisher, servicecueDeployer } = await import("../servicecue-publisher-instance.js");
const { readDeployCredentials, saveDeployCredentials } = await import("../servicecue-deploy-store.js");
const { readPublishToken, servicecuePublishStore } = await import("../servicecue-publish-store.js");
const { secretsStore } = await import("../secrets.js");
const { deployApiOrigin, deployBundleDir } = await import("../servicecue-publisher-instance.js");
const { parsePublishUrl } = await import("../servicecue-publish-rules.js");
const { pkgVersion } = await import("../updater.js");
const { configSnapshot } = await import("../config-snapshot.js");

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const OTHER_ACCOUNT = "fedcba9876543210fedcba9876543210";
const CF_TOKEN = "cf-route-canary-".padEnd(40, "0");
const CF_TOKEN_2 = "cf-route-second-".padEnd(40, "0");
const PUBLISH_TOKEN = "tok-canary-route-".padEnd(40, "0");
const post = (p: string, body: unknown) => callRoute(serviceCuePublishRoutes, p, { method: "POST", body });
const settings = (body: unknown) => post("/api/servicecue/publish", body);
const credentials = (body: unknown) => post("/api/servicecue/publish/deploy-credentials", body);
const deploy = (body: unknown = {}) => post("/api/servicecue/publish/deploy", body);
const get = () => callRoute(serviceCuePublishRoutes, "/api/servicecue/publish");

type Dto = { deploy: { state: string; accountId: string; token: string }; token: string; url: string };

let page: FakeReceiver;
let other: FakeReceiver;

before(async () => {
  page = await FakeReceiver.start();
  other = await FakeReceiver.start();
});

beforeEach(async () => {
  mock.restoreAll();
  servicecuePublisher.stop();
  await servicecueDeployer.settled();
  await servicecuePublishStore.save({ enabled: false, url: "" });
  await secretsStore.clearSecrets("servicecue-publish");
  await secretsStore.clearSecrets("servicecue-deploy");
  await servicecuePublisher.apply();
  await servicecueDeployer.credentialsChanged();
  cloudflare.reset();
  page.requests.length = 0;
});

after(async () => {
  servicecuePublisher.stop();
  await page.close();
  await other.close();
  await cloudflare.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

/** The page's address saved with its publishing token, publishing off. */
const linked = async (origin = page.origin) => assert.equal((await settings({ url: origin, token: PUBLISH_TOKEN })).status, 200);

describe("POST /api/servicecue/publish/deploy-credentials", () => {
  it("stores the account and the token for the page's address, and never returns the token", async (t) => {
    const lines = captureConsole(t, "log", "warn", "error");
    await linked();
    const r = await credentials({ accountId: ACCOUNT, token: CF_TOKEN });
    assert.equal(r.status, 200);
    const body = r.json as Dto;
    assert.deepEqual({ accountId: body.deploy.accountId, token: body.deploy.token }, { accountId: ACCOUNT, token: MASK });
    assert.equal(r.body.includes(CF_TOKEN), false, "the token is in the response");
    assert.equal((await get()).body.includes(CF_TOKEN), false, "the token is in the settings read");
    assert.deepEqual(await readDeployCredentials(page.origin), { accountId: ACCOUNT, token: CF_TOKEN });
    assert.equal(lines.some((l) => l.includes(CF_TOKEN)), false, "the token reached the log");
    assert.ok(lines.some((l) => /a Cloudflare API token is set for this page/.test(l)));
  });

  it("keeps the token out of every file a backup carries, and out of secrets.bin as plain text", async () => {
    await linked();
    await credentials({ accountId: ACCOUNT, token: CF_TOKEN });
    assert.equal((await fs.readFile(path.join(TMP, "secrets.bin"))).includes(CF_TOKEN), false, "the token is in secrets.bin as plain text");
    const file = await fs.readFile(path.join(TMP, "servicecue-publish.json"), "utf8");
    assert.equal(file.includes(CF_TOKEN) || file.includes(ACCOUNT), false);
    const bundle = await configSnapshot.build("test");
    assert.equal(JSON.stringify(bundle).includes(CF_TOKEN), false, "the token is in a backup");
  });

  it("needs a page address first: the token is saved for one", async () => {
    const r = await credentials({ accountId: ACCOUNT, token: CF_TOKEN });
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error: string }).error), /Set the page address first/);
    assert.equal(await readDeployCredentials(page.origin), null);
  });

  it("refuses an account ID or a token that cannot be one, and the two apart, and saves nothing", async () => {
    await linked();
    const cases: [unknown, RegExp][] = [
      [{ accountId: "abc", token: CF_TOKEN }, /account ID is 32 letters and digits/],
      [{ accountId: ACCOUNT, token: "short" }, /20 to 256 characters/],
      [{ accountId: ACCOUNT, token: `${CF_TOKEN} x` }, /only letters, digits/],
      [{ accountId: ACCOUNT }, /together/],
      [{ token: CF_TOKEN }, /together/],
      [{ accountId: 5 }, /accountId must be a string/],
      [{ token: ["x"] }, /token must be a string/],
    ];
    for (const [body, why] of cases) {
      const r = await credentials(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(String((r.json as { error: string }).error), why);
    }
    assert.equal(await readDeployCredentials(page.origin), null);
  });

  it("keeps the token when the form posts the mask back, and changes the account alone", async () => {
    await linked();
    await credentials({ accountId: ACCOUNT, token: CF_TOKEN });
    assert.equal((await credentials({ accountId: ACCOUNT, token: MASK })).status, 200);
    assert.deepEqual(await readDeployCredentials(page.origin), { accountId: ACCOUNT, token: CF_TOKEN }, "the mask was stored as the token");
    assert.equal((await credentials({ accountId: OTHER_ACCOUNT.toUpperCase() })).status, 200);
    assert.deepEqual(await readDeployCredentials(page.origin), { accountId: OTHER_ACCOUNT, token: CF_TOKEN });
    assert.equal((await credentials({ token: CF_TOKEN_2 })).status, 200);
    assert.deepEqual(await readDeployCredentials(page.origin), { accountId: OTHER_ACCOUNT, token: CF_TOKEN_2 });
  });

  it("clears both with an empty token: updating is on exactly while a token is stored", async (t) => {
    const lines = captureConsole(t, "log", "warn", "error");
    await linked();
    await credentials({ accountId: ACCOUNT, token: CF_TOKEN });
    const r = await credentials({ token: "" });
    assert.equal(r.status, 200);
    assert.deepEqual({ ...(r.json as Dto).deploy, now: 0 }.token, "");
    assert.equal((r.json as Dto).deploy.accountId, "");
    assert.equal((r.json as Dto).deploy.state, "off");
    assert.equal(await readDeployCredentials(page.origin), null);
    assert.ok(lines.some((l) => /the Cloudflare API token was cleared/.test(l)));
    // An account ID cleared alone leaves a token with no account: both go.
    await credentials({ accountId: ACCOUNT, token: CF_TOKEN });
    assert.equal((await credentials({ accountId: "" })).status, 200);
    assert.equal(await readDeployCredentials(page.origin), null);
  });

  it("is read back for the address it was saved for, and for no other", async () => {
    await linked();
    await credentials({ accountId: ACCOUNT, token: CF_TOKEN });
    assert.equal(await readDeployCredentials(other.origin), null, "credentials for one page were read for another");
    const parsed = parsePublishUrl(other.origin, true);
    assert.ok(parsed.ok);
    await saveDeployCredentials(parsed.origin, { accountId: OTHER_ACCOUNT, token: CF_TOKEN_2 });
    assert.equal(await readDeployCredentials(page.origin), null, "a save for one address left the other's readable");
    assert.deepEqual(await readDeployCredentials(other.origin), { accountId: OTHER_ACCOUNT, token: CF_TOKEN_2 });
  });
});

describe("a changed page address", () => {
  it("takes the Cloudflare credentials with it, even in a save that brings a publishing token for the new address", async () => {
    await linked();
    await credentials({ accountId: ACCOUNT, token: CF_TOKEN });
    assert.ok(await readDeployCredentials(page.origin));
    const moved = await settings({ url: other.origin, token: "tok-for-the-other-".padEnd(40, "0") });
    assert.equal(moved.status, 200);
    assert.equal(await readDeployCredentials(page.origin), null);
    assert.equal(await readDeployCredentials(other.origin), null);
    assert.equal((moved.json as Dto).deploy.token, "", "the card still shows a token stored");
    assert.equal((moved.json as Dto).deploy.state, "off");
    assert.equal((await fs.readFile(path.join(TMP, "secrets.bin"))).length > 0, true);
  });

  it("takes them when the address is cleared, and keeps them while the address is unchanged", async () => {
    await linked();
    await credentials({ accountId: ACCOUNT, token: CF_TOKEN });
    assert.equal((await settings({ enabled: false })).status, 200);
    assert.equal((await settings({ url: `${page.origin}/servicecue` })).status, 200, "the same address, written another way");
    assert.deepEqual(await readDeployCredentials(page.origin), { accountId: ACCOUNT, token: CF_TOKEN });
    assert.equal((await settings({ url: "" })).status, 200);
    assert.equal(await readDeployCredentials(page.origin), null);
  });

  it("puts them back when the save fails, as the publishing token is", async (t) => {
    captureConsole(t, "log", "warn", "error");
    await linked();
    await credentials({ accountId: ACCOUNT, token: CF_TOKEN });
    mock.method(servicecuePublishStore, "save", async () => {
      throw new Error("disk full");
    });
    await assert.rejects(settings({ url: other.origin, token: "tok-for-the-other-".padEnd(40, "0") }), /disk full/);
    mock.restoreAll();
    assert.deepEqual(await readDeployCredentials(page.origin), { accountId: ACCOUNT, token: CF_TOKEN }, "a failed save lost the credentials");
    assert.equal(await readPublishToken(page.origin), PUBLISH_TOKEN);
  });

  it("leaves the publishing token's own behaviour alone: a publishing token with no Cloudflare credentials saves as before", async () => {
    await linked();
    assert.equal((await settings({ url: other.origin, token: "tok-for-the-other-".padEnd(40, "0") })).status, 200);
    assert.equal(((await get()).json as Dto).token, MASK);
  });
});

describe("POST /api/servicecue/publish/deploy", () => {
  const answers = (outcome: unknown) => {
    const m = mock.method(servicecueDeployer, "deployNow", async () => outcome as never);
    return m;
  };

  it("passes the confirmation on, and only a boolean true is one", async () => {
    const m = answers({ kind: "current" });
    await deploy({});
    await deploy({ confirmDowngrade: false });
    await deploy({ confirmDowngrade: true });
    assert.deepEqual(m.mock.calls.map((c) => c.arguments[0]), [{ confirmDowngrade: false }, { confirmDowngrade: false }, { confirmDowngrade: true }]);
    for (const bad of ["true", 1, null]) assert.equal((await deploy({ confirmDowngrade: bad })).status, 400, JSON.stringify(bad));
    assert.equal(m.mock.callCount(), 3, "a request that was refused for its body deployed");
  });

  it("answers what the server decided: deployed and current are 200 with the status", async () => {
    for (const outcome of [{ kind: "deployed", uploaded: 3, held: 4 }, { kind: "current" }]) {
      answers(outcome);
      const r = await deploy();
      assert.equal(r.status, 200);
      assert.ok((r.json as Dto).deploy, "the answer carries the deploy status");
      mock.restoreAll();
    }
  });

  it("refuses with a status and a code the caller can act on", async () => {
    const table: [unknown, number, string, RegExp][] = [
      [{ kind: "off" }, 400, "no-token", /account ID and API token first/],
      [{ kind: "no-bundle", message: "this build has no copy of the page: it has no build/servicecue/deploy.json" }, 409, "no-bundle", /no copy of the page/],
      [{ kind: "waiting" }, 409, "service-live", /A service is live/],
      [{ kind: "newer", pageVersion: "1.30.0", runningVersion: "1.28.0" }, 409, "newer", /deployed from 1\.30\.0, which is newer than this server's 1\.28\.0.*confirmDowngrade: true/],
      [{ kind: "failed", message: "HTTP 500: down", code: 1, status: 500, step: "upload the files" }, 502, "failed", /could not be updated: HTTP 500: down\. It is unchanged/],
    ];
    for (const [outcome, status, code, message] of table) {
      answers(outcome);
      const r = await deploy();
      const body = r.json as { error: string; code: string; deploy: unknown; pageVersion?: string };
      assert.equal(r.status, status, code);
      assert.equal(body.code, code);
      assert.match(body.error, message);
      assert.ok(body.deploy, `${code}: the answer carries the deploy status`);
      mock.restoreAll();
    }
    answers({ kind: "newer", pageVersion: "1.30.0", runningVersion: "1.28.0" });
    assert.equal(((await deploy()).json as { pageVersion: string }).pageVersion, "1.30.0");
  });

  it("with no token says so, and calls nothing; with a token and no copy of the page says there is none", async () => {
    await linked();
    const none = await deploy();
    assert.equal(none.status, 400);
    assert.equal((none.json as { code: string }).code, "no-token");
    await credentials({ accountId: ACCOUNT, token: CF_TOKEN });
    await fs.rm(path.dirname(BUNDLE), { recursive: true, force: true });
    const noCopy = await deploy();
    assert.equal(noCopy.status, 409);
    assert.equal((noCopy.json as { code: string }).code, "no-bundle");
    assert.equal((noCopy.json as { deploy: { state: string } }).deploy.state, "no-bundle");
    assert.equal(cloudflare.requests.length, 0, "Cloudflare was called with nothing to send");
  });
});

describe("Update the page now, all the way to Cloudflare", () => {
  it("deploys the page's copy, shows it on the card, and is refused a rollback without the confirmation", async (t) => {
    captureConsole(t, "log", "warn", "error");
    const bundle = writeBundle({ dir: BUNDLE, manifest: { build: BUILD_B } });
    t.after(() => bundle.remove());
    cloudflare.token = CF_TOKEN;
    await linked();
    await credentials({ accountId: ACCOUNT, token: CF_TOKEN });

    const first = await deploy();
    assert.equal(first.status, 200, first.body);
    const card = (first.json as Dto & { deploy: { page: { build: string; version: string }; files: { uploaded: number; held: number }; bundle: { build: string } } }).deploy;
    assert.equal(card.state, "current");
    assert.deepEqual({ build: card.page.build, version: card.page.version }, { build: BUILD_B, version: pkgVersion() });
    assert.deepEqual(card.files, { uploaded: 6, held: 0 });
    assert.equal(cloudflare.puts.length, 1);
    assert.equal(first.body.includes(CF_TOKEN), false);
    assert.equal(cloudflare.requests[0]!.authorization, `Bearer ${CF_TOKEN}`, "the token Cloudflare was sent is the one that was saved");

    // The publisher reads the page's status and finds it is this build: asked again, there is nothing to do.
    servicecueDeployer.consider(BUILD_B);
    await servicecueDeployer.settled();
    assert.equal((await deploy()).status, 200);
    assert.equal(cloudflare.puts.length, 1);

    // Another server deployed a newer version over it: not rolled back without being told to.
    cloudflare.deployed = { tag: BUILD_A, message: "Stage Utility 99.0.0", at: new Date().toISOString() };
    servicecueDeployer.consider(BUILD_A);
    await servicecueDeployer.settled();
    assert.equal(cloudflare.puts.length, 1, "left alone by the publisher's own read");
    const refused = await deploy();
    assert.equal(refused.status, 409);
    assert.equal((refused.json as { code: string; pageVersion: string }).code, "newer");
    assert.equal((refused.json as { pageVersion: string }).pageVersion, "99.0.0");
    assert.equal(cloudflare.puts.length, 1);
    const confirmed = await deploy({ confirmDowngrade: true });
    assert.equal(confirmed.status, 200, confirmed.body);
    assert.equal(cloudflare.puts.length, 2);
  });
});

describe("where the server looks for Cloudflare and for the page's copy", () => {
  it("is the real API and build/servicecue/ unless the development switch is on and a place is named", () => {
    const named = { STAGE_UTILITY_CLOUDFLARE_API: "http://127.0.0.1:9", STAGE_UTILITY_SERVICECUE_BUNDLE: "/somewhere/else" };
    assert.equal(deployApiOrigin(named, false), "https://api.cloudflare.com", "a production server was pointed somewhere else");
    assert.equal(deployApiOrigin({}, true), "https://api.cloudflare.com");
    assert.equal(deployApiOrigin(named, true), "http://127.0.0.1:9");
    assert.throws(() => deployApiOrigin({ STAGE_UTILITY_CLOUDFLARE_API: "https://evil.example" }, true), /Cloudflare API address/);
    assert.match(deployBundleDir(named, false), /build[\\/]servicecue$/);
    assert.equal(deployBundleDir(named, true), "/somewhere/else");
  });
});
