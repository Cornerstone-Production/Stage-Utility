// The settings behind "Public link", through the real routes, the real stores and the
// real secrets file, with a real receiver standing in for the page.
//
// What these hold: the token is write-only and never in a file a backup carries, it
// belongs to the address it was saved for (this app has no login, so a route that let
// a stranger point a saved token at an address of their choosing would hand it over),
// and a switch that says "off" asks the page to forget what it was sent.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it, mock } from "node:test";

import { captureConsole } from "../fixtures/capture-console.js";
import { FakeReceiver, PAGE_STATUS, waitFor } from "../fixtures/publish-receiver.js";
import { MASK } from "../mask.js";
import { callRoute } from "./route-harness.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-publish-routes-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

// Dynamic, after the data directory is chosen: these read it when they load.
const { serviceCuePublishRoutes } = await import("./servicecue-publish-routes.js");
const { servicecuePublisher } = await import("../servicecue-publisher-instance.js");
const { PUBLISH_SECRET_SLOT, readPublishToken, savePublishToken, servicecuePublishStore } = await import("../servicecue-publish-store.js");
const { secretsStore } = await import("../secrets.js");
const { configSnapshot } = await import("../config-snapshot.js");

/** Both are longer than the 32 characters the page needs of a token. */
const TOKEN = "tok-canary-route-".padEnd(40, "0");
const TYPED = "tok-typed-over-it-".padEnd(40, "0");
const post = (body: unknown, p = "/api/servicecue/publish") => callRoute(serviceCuePublishRoutes, p, { method: "POST", body });
const get = () => callRoute(serviceCuePublishRoutes, "/api/servicecue/publish");

let page: FakeReceiver;
let other: FakeReceiver;

before(async () => {
  page = await FakeReceiver.start();
  other = await FakeReceiver.start();
});

beforeEach(async () => {
  // Back to a fresh install: off, no address, no token, nothing remembered by the page.
  servicecuePublisher.stop();
  servicecuePublisher.setTimings({ firstCycleMs: 5, nudgeMs: 5 });
  await servicecuePublishStore.save({ enabled: false, url: "" });
  await secretsStore.clearSecrets("servicecue-publish");
  await servicecuePublisher.apply();
  page.requests.length = 0;
  other.requests.length = 0;
  page.respond = (req) => page.worker(req);
});

after(async () => {
  servicecuePublisher.stop();
  await page.close();
  await other.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("GET /api/servicecue/publish", () => {
  it("answers off, with no address and no token, on a fresh install", async () => {
    const r = await get();
    assert.equal(r.status, 200);
    const body = r.json as { enabled: boolean; url: string; token: string; status: { state: string; enabled: boolean } };
    assert.deepEqual({ enabled: body.enabled, url: body.url, token: body.token }, { enabled: false, url: "", token: "" });
    assert.equal(body.status.state, "off");
  });
});

describe("POST /api/servicecue/publish", () => {
  it("refuses an address the rules do not allow, naming the rule, and saves nothing", async () => {
    for (const url of ["http://example.test", "ftp://example.test", "https://user:pw@example.test"]) {
      const r = await post({ url, token: TOKEN });
      assert.equal(r.status, 400, url);
      assert.match(String((r.json as { error: string }).error), /https:\/\/|user name/);
    }
    assert.equal(((await get()).json as { url: string }).url, "");
    assert.equal(await readPublishToken(page.origin), "", "a refused request stored a token");
  });

  it("refuses this machine's own addresses without the development switch, in the save and in the test, and connects to nothing", async (t) => {
    const before = process.env.STAGE_UTILITY_PUBLISH_ALLOW_LOCAL;
    t.after(() => {
      process.env.STAGE_UTILITY_PUBLISH_ALLOW_LOCAL = before;
    });
    delete process.env.STAGE_UTILITY_PUBLISH_ALLOW_LOCAL;
    const saved = await post({ url: page.origin, token: TOKEN, enabled: true });
    assert.equal(saved.status, 400);
    assert.equal((saved.json as { error: string }).error, "The page address has to start with https://.");
    const probed = await callRoute(serviceCuePublishRoutes, "/api/servicecue/publish/test", { method: "POST", body: { url: page.origin, token: TOKEN } });
    assert.deepEqual(probed.json, { ok: false, kind: "config", message: "The page address has to start with https://." });
    assert.equal(page.requests.length, 0, "an address on this machine was dialled");
    assert.equal(((await get()).json as { url: string }).url, "");
  });

  it("refuses to switch on without both an address and a token", async () => {
    const noToken = await post({ url: page.origin, enabled: true });
    assert.equal(noToken.status, 400);
    assert.match(String((noToken.json as { error: string }).error), /address and the publishing token/);
    const noUrl = await post({ token: TOKEN, enabled: true });
    assert.equal(noUrl.status, 400);
    assert.equal(((await get()).json as { enabled: boolean }).enabled, false);
  });

  it("refuses a token under 32 characters with a plain message, and saves nothing", async () => {
    // The page treats a token under 32 characters as not set and answers 503 to everything, so one saved
    // here would look like a page that is down.
    const short = await post({ url: page.origin, token: "x".repeat(31), enabled: true });
    assert.equal(short.status, 400);
    assert.match(String((short.json as { error: string }).error), /at least 32 characters/);
    assert.equal(await readPublishToken(page.origin), "", "a refused token was stored");
    assert.equal(((await get()).json as { url: string; enabled: boolean }).url, "", "the address was saved with a token that was refused");
    assert.equal(page.requests.length, 0);

    // Exactly 32 is a token. And a stored one is kept when a too-short replacement is refused.
    assert.equal((await post({ url: page.origin, token: "x".repeat(32) })).status, 200);
    assert.equal(await readPublishToken(page.origin), "x".repeat(32));
    assert.equal((await post({ token: "y".repeat(31) })).status, 400);
    assert.equal(await readPublishToken(page.origin), "x".repeat(32), "a refused token replaced the one that was stored");
  });

  it("rejects values that are not what they claim to be", async () => {
    for (const body of [{ enabled: "yes" }, { url: 5 }, { token: ["x"] }]) assert.equal((await post(body)).status, 400, JSON.stringify(body));
  });

  it("stores the token encrypted and never returns it, keeps the address, and starts publishing", async () => {
    const r = await post({ url: `${page.origin}/servicecue`, token: TOKEN, enabled: true });
    assert.equal(r.status, 200);
    const body = r.json as { enabled: boolean; url: string; token: string; status: { state: string } };
    assert.equal(body.enabled, true);
    assert.equal(body.url, page.origin, "the address is kept as an origin");
    assert.equal(body.token, MASK);
    assert.equal(r.body.includes(TOKEN), false, "the token is in the response");
    assert.equal((await get()).body.includes(TOKEN), false, "the token is in the settings read");

    // On disk: the settings file has the address and the flag; the token is in secrets.bin, encrypted.
    const file = await fs.readFile(path.join(TMP, "servicecue-publish.json"), "utf8");
    assert.deepEqual(JSON.parse(file), { enabled: true, url: page.origin });
    assert.equal(file.includes(TOKEN), false);
    assert.equal(await readPublishToken(page.origin), TOKEN);
    assert.equal((await fs.readFile(path.join(TMP, "secrets.bin"))).includes(TOKEN), false, "the token is in secrets.bin as plain text");

    // And it is real: the page gets a request carrying it.
    await waitFor(() => page.docs.has("state"), "the first documents", 10000);
    assert.equal(page.requests[0]!.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(((await get()).json as { status: { state: string } }).status.state, "publishing");
  });

  it("is in a config snapshot as the address and the flag, and the token is not", async () => {
    await post({ url: page.origin, token: TOKEN, enabled: true });
    const bundle = await configSnapshot.build("test");
    assert.deepEqual(bundle.files["servicecue-publish.json"], { enabled: true, url: page.origin });
    assert.equal(JSON.stringify(bundle).includes(TOKEN), false, "the token is in a backup");
  });

  it("keeps the token when only the flag changes, and when the form posts the mask back", async () => {
    await post({ url: page.origin, token: TOKEN, enabled: true });
    await post({ enabled: false });
    assert.equal(await readPublishToken(page.origin), TOKEN);
    const r = await post({ token: MASK, enabled: true });
    assert.equal(r.status, 200);
    assert.equal(await readPublishToken(page.origin), TOKEN, "the mask was stored as the token");
    assert.equal(((await get()).json as { token: string }).token, MASK);
  });

  it("sends the token to the address it was saved for, and to no other: a new address needs its own", async (t) => {
    const lines = captureConsole(t, "log", "warn", "error");
    await post({ url: page.origin, token: TOKEN, enabled: true });
    await waitFor(() => page.requests.length > 0, "the first request", 10000);

    // Somebody on the network points the saved token at an address of their own.
    const swap = await post({ url: other.origin });
    assert.equal(swap.status, 400, "publishing stayed on with the token carried over to a new address");
    assert.equal(await readPublishToken(page.origin), TOKEN, "a refused request cleared the token");
    assert.equal(((await get()).json as { url: string }).url, page.origin, "a refused request moved the address");

    const off = await post({ url: other.origin, enabled: false });
    assert.equal(off.status, 200);
    assert.equal(await readPublishToken(page.origin), "", "the token stayed attached to an address it was not saved for");
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(other.requests.length, 0, "the other address was sent something");
    assert.equal(lines.some((l) => l.includes(TOKEN)), false, "the token reached the log");

    // With its own token, the new address is fine.
    const on = await post({ url: other.origin, token: "tok-for-the-other-".padEnd(40, "0"), enabled: true });
    assert.equal(on.status, 200);
    await waitFor(() => other.requests.length > 0, "the request to the new address", 10000);
    assert.equal(other.requests[0]!.headers.authorization, `Bearer ${"tok-for-the-other-".padEnd(40, "0")}`);
  });

  it("clearing the address switches publishing off and takes the token with it", async () => {
    await post({ url: page.origin, token: TOKEN, enabled: true });
    const r = await post({ url: "" });
    assert.equal(r.status, 200);
    const body = r.json as { enabled: boolean; url: string; token: string };
    assert.deepEqual({ enabled: body.enabled, url: body.url, token: body.token }, { enabled: false, url: "", token: "" });
  });

  it("asks the page to drop its copy when switched off, and says whether it did", async () => {
    await post({ url: page.origin, token: TOKEN, enabled: true });
    await waitFor(() => page.docs.has("state"), "documents on the page", 10000);
    const off = await post({ enabled: false });
    assert.deepEqual((off.json as { dropped: unknown }).dropped, { ok: true });
    assert.deepEqual(page.manifests().at(-1), { docs: [], assets: [] });
    assert.equal((off.json as { status: { state: string } }).status.state, "off");

    // On again, then the page cannot be reached when it is switched off.
    await post({ enabled: true });
    await waitFor(() => page.puts().length > 0, "publishing again", 10000);
    await page.close();
    const unreachable = await post({ enabled: false });
    const dropped = (unreachable.json as { dropped: { ok: boolean; message?: string } }).dropped;
    assert.equal(dropped.ok, false);
    assert.ok(dropped.message, "the operator is not told why the page could not be asked");
    page = await FakeReceiver.start();
  });

  it("refuses a token with a space or a character outside printable ASCII, and saves nothing", async () => {
    for (const token of ["a".repeat(20) + " " + "b".repeat(20), "a".repeat(20) + "\n" + "b".repeat(20), "a".repeat(20) + "\u2014" + "b".repeat(20)]) {
      const r = await post({ url: page.origin, token });
      assert.equal(r.status, 400, JSON.stringify(token));
      assert.match(String((r.json as { error: string }).error), /letters, digits and punctuation|no spaces/);
    }
    assert.equal(await readPublishToken(page.origin), "");
    assert.equal(((await get()).json as { url: string }).url, "");
  });

  it("refuses a token that arrives with no address to bind it to", async () => {
    const r = await post({ token: TOKEN });
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error: string }).error), /token is saved for one address/);
    assert.equal(await readPublishToken(page.origin), "");
  });

  it("handles two saves at once one after the other, each reading what the first wrote", async () => {
    // Read apart, the second would see no address and no token yet and be refused.
    const [first, second] = await Promise.all([post({ url: page.origin, token: TOKEN }), post({ enabled: true })]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.deepEqual({ ...(await get()).json as object, status: undefined, deploy: undefined }, { enabled: true, url: page.origin, token: MASK, status: undefined, deploy: undefined });
  });

  it("puts the token back when the settings could not be written, and the save fails out loud", async (t) => {
    captureConsole(t, "log", "warn", "error");
    await post({ url: page.origin, token: TOKEN });
    const failing = mock.method(servicecuePublishStore, "save", async () => {
      throw new Error("disk full");
    });
    try {
      await assert.rejects(post({ url: other.origin, token: TYPED }), /disk full/, "a failed save answered as if it had worked");
    } finally {
      failing.mock.restore();
    }
    assert.equal(await readPublishToken(page.origin), TOKEN, "the saved token was lost with the failed save");
    assert.equal(await readPublishToken(other.origin), "", "a token was left beside an address that was never saved");
    assert.equal(((await get()).json as { url: string }).url, page.origin);
  });

  it("stores the token with the address it was saved for, and reads as none for any other", async () => {
    await servicecuePublishStore.save({ enabled: false, url: page.origin });
    await savePublishToken(other.origin as never, TYPED);
    assert.equal(await readPublishToken(other.origin as never), TYPED);
    assert.equal(await readPublishToken(page.origin as never), "", "a token saved for one address was read back for the address the settings now name");
    const slot = await secretsStore.getSecrets(PUBLISH_SECRET_SLOT);
    assert.deepEqual(Object.keys(slot).sort(), ["origin", "token"]);
  });

  it("asks the old page to drop its copy when the address changes, and the new one is sent nothing of the old", async () => {
    await post({ url: page.origin, token: TOKEN, enabled: true });
    await waitFor(() => page.docs.has("state"), "documents on the first page", 10000);
    const moved = await post({ url: other.origin, token: TYPED });
    assert.equal(moved.status, 200);
    assert.deepEqual((moved.json as { dropped: unknown }).dropped, { ok: true });
    assert.deepEqual(page.manifests().at(-1), { docs: [], assets: [] }, "the old page still holds what was sent it");
    assert.equal(page.requests.at(-1)!.headers.authorization, `Bearer ${TOKEN}`, "the old page was asked with some other token");
    await waitFor(() => other.requests.length > 0, "the new address", 10000);
    assert.equal(other.requests.every((r) => r.headers.authorization === `Bearer ${TYPED}`), true);
  });

  it("says the page may still hold its copy when it is switched off with nowhere to ask", async () => {
    await post({ url: page.origin, token: TOKEN, enabled: true });
    await waitFor(() => page.docs.has("state"), "documents", 10000);
    servicecuePublisher.stop();
    const gone = await post({ url: "" });
    const dropped = (gone.json as { dropped?: { ok: boolean; message?: string } }).dropped;
    assert.equal(dropped?.ok, false);
    assert.match(dropped?.message ?? "", /may still hold/);
  });

  it("publishes again after a restart, from what the stores hold", async () => {
    await post({ url: page.origin, token: TOKEN, enabled: true });
    await waitFor(() => page.puts().length > 0, "publishing", 10000);
    servicecuePublisher.stop();
    page.requests.length = 0;
    await servicecuePublisher.start();
    await waitFor(() => page.requests.length > 0, "publishing after the restart", 10000);
    assert.equal(page.requests[0]!.headers.authorization, `Bearer ${TOKEN}`);
  });
});

describe("POST /api/servicecue/publish/test", () => {
  const testIt = (body: unknown = {}) => post(body, "/api/servicecue/publish/test");

  it("reaches the page, and says what it holds", async () => {
    const docs = Array.from({ length: 12 }, (_, i) => `rundown-100-${1000 + i}`);
    page.respond = () => ({ status: 200, body: JSON.stringify({ ...PAGE_STATUS, docs, assets: ["logo.png"] }) });
    const r = await testIt({ url: page.origin, token: TOKEN });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, message: "Reached the page: it holds 12 documents and 1 image." });
    assert.equal(page.requests[0]!.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(r.body.includes(TOKEN), false);

    page.respond = () => ({ status: 200, body: JSON.stringify({ ...PAGE_STATUS, docs: ["state"] }) });
    assert.deepEqual((await testIt({ url: page.origin, token: TOKEN })).json, { ok: true, message: "Reached the page: it holds 1 document and 0 images." });
  });

  it("refuses a token under 32 characters, as the page would call it not set, and exactly 32 is a token", async () => {
    const short = await testIt({ url: page.origin, token: "x".repeat(31) });
    const body = short.json as { ok: boolean; kind: string; message: string };
    assert.equal(body.ok, false);
    assert.equal(body.kind, "config");
    assert.match(body.message, /at least 32 characters/);
    assert.equal(page.requests.length, 0, "a token the page would not accept was sent to it");
    const exact = await testIt({ url: page.origin, token: "x".repeat(32) });
    assert.equal((exact.json as { ok: boolean }).ok, true);
  });

  it("answers a plain reason, with a 200, for each way it can fail", async () => {
    page.respond = () => ({ status: 401 });
    assert.deepEqual(pick(await testIt({ url: page.origin, token: TOKEN })), { ok: false, kind: "auth", status: 401 });
    page.respond = () => ({ status: 503 });
    assert.deepEqual(pick(await testIt({ url: page.origin, token: TOKEN })), { ok: false, kind: "no-token", status: 503 });
    page.respond = () => ({ status: 403 });
    assert.deepEqual(pick(await testIt({ url: page.origin, token: TOKEN })), { ok: false, kind: "blocked", status: 403 });
    page.respond = () => ({ status: 429 });
    assert.deepEqual(pick(await testIt({ url: page.origin, token: TOKEN })), { ok: false, kind: "limited", status: 429 });
    page.respond = () => ({ status: 502 });
    assert.deepEqual(pick(await testIt({ url: page.origin, token: TOKEN })), { ok: false, kind: "server", status: 502 });
    page.respond = () => ({ status: 404 });
    assert.deepEqual(pick(await testIt({ url: page.origin, token: TOKEN })), { ok: false, kind: "rejected", status: 404 });
    page.respond = () => ({ status: 200, body: JSON.stringify({ ...PAGE_STATUS, protocol: 9 }) });
    assert.deepEqual(pick(await testIt({ url: page.origin, token: TOKEN })), { ok: false, kind: "protocol", status: undefined });
    const closed = await FakeReceiver.start();
    const dead = closed.origin;
    await closed.close();
    assert.deepEqual(pick(await testIt({ url: dead, token: TOKEN })), { ok: false, kind: "unreachable", status: undefined });
    assert.deepEqual(pick(await testIt({ url: "http://example.test", token: TOKEN })), { ok: false, kind: "config", status: undefined });
    assert.deepEqual(pick(await testIt({})), { ok: false, kind: "config", status: undefined });
  });

  it("tests the saved address with the saved token when asked for neither", async () => {
    await post({ url: page.origin, token: TOKEN });
    const r = await testIt({});
    assert.equal((r.json as { ok: boolean }).ok, true);
    assert.equal(page.requests.at(-1)!.headers.authorization, `Bearer ${TOKEN}`);
  });

  it("never sends the saved token to an address it was not saved for", async () => {
    await post({ url: page.origin, token: TOKEN });
    other.requests.length = 0;
    const r = await testIt({ url: other.origin });
    const body = r.json as { ok: boolean; kind: string; message: string };
    assert.equal(body.ok, false);
    assert.equal(body.kind, "config");
    assert.match(body.message, /different address/);
    assert.equal(other.requests.length, 0, "the saved token was sent to an address typed into the test");
    // The mask is not a token either.
    const masked = await testIt({ url: other.origin, token: MASK });
    assert.equal((masked.json as { ok: boolean }).ok, false);
    assert.equal(other.requests.length, 0);
    // With its own token it is tested.
    const typed = await testIt({ url: other.origin, token: TYPED });
    assert.equal((typed.json as { ok: boolean }).ok, true);
    assert.equal(other.requests[0]!.headers.authorization, `Bearer ${TYPED}`);
  });

  it("tests the same address again with the saved token, as the settings page does after an edit", async () => {
    await post({ url: page.origin, token: TOKEN });
    const r = await testIt({ url: `${page.origin}/servicecue` });
    assert.equal((r.json as { ok: boolean }).ok, true);
    assert.equal(page.requests.at(-1)!.headers.authorization, `Bearer ${TOKEN}`);
  });
});

/** The parts of a test answer that say what happened. */
function pick(r: { json: unknown }): { ok: boolean; kind?: string; status?: number } {
  const j = r.json as { ok: boolean; kind?: string; status?: number };
  return { ok: j.ok, kind: j.kind, status: j.status };
}
