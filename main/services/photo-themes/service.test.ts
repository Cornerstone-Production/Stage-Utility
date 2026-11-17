// Photo themes end to end, against a real data directory and a fake OpenAI over
// real HTTP: what is sent and what is not, what each failure leaves behind, what
// screens are given, what is kept and for how long, and where the key goes.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-photo-themes-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { photoThemes, photoFingerprint, PHOTO_THEME_IMAGE_DIR } = await import("./service.js");
const { setAppTimeZone } = await import("../app-timezone.js");
const { addBroadcastListener } = await import("../broadcaster.js");
const { captureConsole } = await import("../fixtures/capture-console.js");
const { errorBody, fakeServer, pcoPhoto, startFakeOpenAi } = await import("./photo-themes-harness.js");
const { THEMED_PHOTO_REF_PREFIX } = await import("../../types/photo-themes.js");
type FakeOpenAi = Awaited<ReturnType<typeof startFakeOpenAi>>;
type FakeServer = Awaited<ReturnType<typeof fakeServer>>;

const KEY = "sk-canary-service-".padEnd(40, "s");
const TYPE = "100";
const PLAN = "2001";
const PLAN_2 = "2002";
const SUNDAY = "2026-12-24T16:00:00Z";

let fake: FakeOpenAi;
let srv: FakeServer;
let now = Date.parse("2026-11-17T12:00:00Z");
const frames: string[] = [];
addBroadcastListener((channel, payload) => frames.push(`${channel} ${JSON.stringify(payload)}`));

const person = (id: string, upload = 1): { personId: string; name: string; photoUrl: string | null } => ({ personId: id, name: `Person ${id}`, photoUrl: pcoPhoto(id, upload) });

before(async () => {
  fake = await startFakeOpenAi();
  process.env.STAGE_UTILITY_OPENAI_BASE_URL = fake.base;
  srv = await fakeServer();
  srv.deps.now = () => now;
  await photoThemes.start(srv.deps, { sweep: false });
});
after(async () => {
  photoThemes.stop();
  await fake.close();
  delete process.env.STAGE_UTILITY_OPENAI_BASE_URL;
});

beforeEach(async () => {
  await photoThemes.idle();
  await fs.rm(path.join(TMP, "photo-themes.json"), { force: true });
  await fs.rm(path.join(TMP, PHOTO_THEME_IMAGE_DIR), { recursive: true, force: true });
  now = Date.parse("2026-11-17T12:00:00Z");
  setAppTimeZone("America/Chicago");
  srv.rosters.clear();
  srv.unreadable.clear();
  srv.loads.length = 0;
  fake.requests.length = 0;
  fake.edit = async () => ({ status: 200, body: { data: [{ b64_json: (await (await import("./photo-themes-harness.js")).webpBytes()).toString("base64") }] } });
  frames.length = 0;
  await photoThemes.reloadForTests();
  await photoThemes.connection.saveKey(KEY);
});

/** A theme on PLAN with these people on it. */
async function themed(people = [person("1"), person("2"), person("3")]) {
  srv.rosters.set(PLAN, people);
  const theme = await photoThemes.createTheme({ name: "Christmas 2026", prompt: "Christmas lights, keep the face the same" });
  await photoThemes.choosePlan(PLAN, { serviceTypeId: TYPE, sortDate: SUNDAY, themeId: theme.id });
  return theme;
}

async function generated(mode: "missing" | "all" = "missing", plan = PLAN) {
  const r = await photoThemes.generate(plan, TYPE, mode);
  await photoThemes.idle();
  return r;
}

const statusOf = (themeId: string, personId: string) =>
  photoThemes.state().themes.find((t) => t.id === themeId)!.people.find((p) => p.personId === personId)?.status ?? "none";

describe("generating", () => {
  it("sends each person once, two at a time, and leaves them for review", async () => {
    const theme = await themed();
    let inFlight = 0;
    let most = 0;
    const base = fake.edit;
    fake.edit = async (r) => {
      most = Math.max(most, ++inFlight);
      await new Promise((res) => setTimeout(res, 30));
      inFlight--;
      return base(r);
    };
    const r = await generated();
    assert.deepEqual(r, { queued: 3, reused: 0, skipped: [] });
    assert.equal(fake.edits(), 3);
    assert.equal(most, 2, "at most two edits at once");
    for (const id of ["1", "2", "3"]) assert.equal(statusOf(theme.id, id), "ready");
    assert.equal(photoThemes.shownPhotos(PLAN).size, 0, "nothing reaches a screen before it is approved");
  });

  it("reuses an approved photo at no cost, on this plan and the next", async () => {
    const theme = await themed();
    await generated();
    assert.equal((await photoThemes.approveAll(PLAN)).approved, 3);
    fake.requests.length = 0;
    srv.loads.length = 0;

    // The same plan again: nobody is sent.
    assert.deepEqual(await generated(), { queued: 0, reused: 3, skipped: [] });
    // Another plan with two of them and somebody new: only the new one is sent.
    srv.rosters.set(PLAN_2, [person("2"), person("3"), person("4")]);
    await photoThemes.choosePlan(PLAN_2, { serviceTypeId: TYPE, sortDate: "2026-12-31T16:00:00Z", themeId: theme.id });
    assert.deepEqual(await generated("missing", PLAN_2), { queued: 1, reused: 2, skipped: [] });
    assert.equal(fake.edits(), 1);
    assert.deepEqual(srv.loads, [pcoPhoto("4", 1)]);
  });

  it("skips somebody with no Planning Center photo, without a request", async () => {
    await themed([person("1"), { personId: "9", name: "No Photo", photoUrl: null }]);
    const r = await generated();
    assert.deepEqual(r.skipped, [{ personId: "9", name: "No Photo", reason: "No Planning Center photo" }]);
    assert.equal(fake.edits(), 1);
  });

  it("refuses with no key, and with a plan whose roster cannot be read", async () => {
    await themed();
    srv.unreadable.set(PLAN, "Planning Center is not configured.");
    await assert.rejects(() => photoThemes.generate(PLAN, TYPE, "missing"), /Could not read who is on this plan: Planning Center is not configured/);
    await photoThemes.connection.clearKey();
    await assert.rejects(() => photoThemes.generate(PLAN, TYPE, "missing"), /OpenAI is not connected/);
    assert.equal(fake.edits(), 0);
  });

  it("records a refusal on the person, with the reason, and logs it", async (t) => {
    const lines = captureConsole(t, "log", "warn", "error");
    const theme = await themed([person("1")]);
    fake.edit = () => ({ status: 400, body: { error: { code: "moderation_blocked", type: "image_generation_user_error" } } });
    await generated();
    const p = photoThemes.state().themes[0]!.people[0]!;
    assert.equal(p.status, "failed");
    assert.equal(p.pending?.reason, "Refused under OpenAI's content policy");
    assert.ok(lines.some((l) => l.includes("[photo-theme] Person 1") && l.includes("Refused under OpenAI's content policy")));
    assert.ok(lines.some((l) => /\[photo-theme\] generate for plan 2001 in "Christmas 2026": 0 made, 1 failed/.test(l)));
    // A failed person is sent again by the next Generate.
    fake.edit = async () => ({ status: 200, body: { data: [{ b64_json: (await (await import("./photo-themes-harness.js")).webpBytes()).toString("base64") }] } });
    assert.equal((await generated()).queued, 1);
    assert.equal(statusOf(theme.id, "1"), "ready");
  });

  it("stops a run on a rejected key without sending the rest, and refuses the next", async () => {
    await themed([person("1"), person("2"), person("3"), person("4"), person("5")]);
    fake.edit = () => ({ status: 401, body: errorBody("invalid_api_key", "invalid_request_error", KEY) });
    await generated();
    assert.equal(fake.edits(), 2, "the two in flight; the other three failed without a request");
    for (const p of photoThemes.state().themes[0]!.people) assert.equal(p.pending?.reason, "OpenAI rejected the API key");
    assert.equal(photoThemes.connection.status().state, "invalid-key");
    await assert.rejects(() => photoThemes.generate(PLAN, TYPE, "missing"), /OpenAI rejected the saved API key/);
  });

  it("stops a run on exhausted credits, and says so on the connection", async () => {
    await themed([person("1"), person("2"), person("3")]);
    fake.edit = () => ({ status: 429, body: errorBody("credit_balance_exhausted", "insufficient_quota") });
    await generated();
    assert.equal(fake.edits(), 2);
    assert.equal(photoThemes.connection.status().state, "out-of-credits");
    assert.equal(photoThemes.state().themes[0]!.people.every((p) => p.pending?.reason === "Out of API credits"), true);
  });

  it("waits out a rate limit for as long as OpenAI asks, then tries again", async () => {
    const theme = await themed([person("1")]);
    let calls = 0;
    const base = fake.edit;
    fake.edit = async (r) => (++calls === 1 ? { status: 429, body: errorBody("rate_limit_exceeded", null), headers: { "retry-after": "1" } } : base(r));
    const started = Date.now();
    await generated();
    assert.equal(calls, 2);
    assert.ok(Date.now() - started >= 950, "the second try waited the second OpenAI asked for");
    assert.equal(statusOf(theme.id, "1"), "ready");
  });
});

describe("what screens are given", () => {
  it("approved photos of a plan set to Themed, and nothing else", async () => {
    const theme = await themed();
    await generated();
    await photoThemes.approve(theme.id, "1");
    const shown = photoThemes.shownPhotos(PLAN);
    assert.deepEqual([...shown.keys()], ["1"], "the two still waiting for review are not shown");
    assert.match(shown.get("1")!, new RegExp(`^${THEMED_PHOTO_REF_PREFIX}[0-9a-f]{16}\\.webp$`));
    assert.equal(photoThemes.shownPhotos(PLAN_2).size, 0, "another plan shows the originals");
    assert.equal(photoThemes.shownPhotos(null).size, 0, "a default board shows the originals");

    await photoThemes.choosePlan(PLAN, { serviceTypeId: TYPE, sortDate: undefined, show: "original" });
    assert.equal(photoThemes.shownPhotos(PLAN).size, 0, "Original shows the originals");
    await photoThemes.choosePlan(PLAN, { serviceTypeId: TYPE, sortDate: undefined, show: "themed" });
    assert.equal(photoThemes.shownPhotos(PLAN).size, 1);
    assert.ok(srv.shownChanges >= 3, "each change redraws the screens");
  });

  it("the first approval turns a plan to Themed", async () => {
    const theme = await themed([person("1")]);
    await photoThemes.choosePlan(PLAN, { serviceTypeId: TYPE, sortDate: undefined, show: "original" });
    await generated();
    await photoThemes.approve(theme.id, "1");
    assert.equal(photoThemes.state().plans[0]!.show, "themed");
  });

  it("keeps the approved photo on screen while a redo is made, until the redo is approved", async () => {
    const theme = await themed([person("1")]);
    await generated();
    await photoThemes.approve(theme.id, "1");
    const before = photoThemes.shownPhotos(PLAN).get("1");
    await photoThemes.redo(theme.id, "1", { planId: PLAN, serviceTypeId: TYPE });
    await photoThemes.idle();
    assert.equal(statusOf(theme.id, "1"), "ready");
    assert.equal(photoThemes.shownPhotos(PLAN).get("1"), before);
    // A different edit, so the approval visibly replaces it.
    fake.edit = async () => ({ status: 200, body: { data: [{ b64_json: Buffer.concat([await (await import("./photo-themes-harness.js")).webpBytes(), Buffer.from("x")]).toString("base64") }] } });
    await photoThemes.redo(theme.id, "1", { planId: PLAN, serviceTypeId: TYPE });
    await photoThemes.idle();
    await photoThemes.approve(theme.id, "1");
    assert.notEqual(photoThemes.shownPhotos(PLAN).get("1"), before);
    assert.equal((await fs.readdir(path.join(TMP, PHOTO_THEME_IMAGE_DIR))).length, 1, "the replaced photo's file is gone");
  });
});

describe("made from an older photo", () => {
  it("is flagged when the Planning Center photo changes, and Keep clears it", async () => {
    const theme = await themed([person("1")]);
    await generated();
    await photoThemes.approve(theme.id, "1");
    assert.equal(statusOf(theme.id, "1"), "approved");
    // The same upload at another size is the same photo.
    assert.equal(photoFingerprint(pcoPhoto("1", 1)), photoFingerprint(pcoPhoto("1", 1).replace("256x256%23", "512x512")));
    srv.rosters.set(PLAN, [person("1", 2)]);
    assert.equal(statusOf(theme.id, "1"), "stale");
    assert.equal(photoThemes.state().themes[0]!.people[0]!.approved!.stale, true);
    await photoThemes.keep(theme.id, "1");
    assert.equal(statusOf(theme.id, "1"), "approved");
    // A later upload is newer than the one kept.
    srv.rosters.set(PLAN, [person("1", 3)]);
    assert.equal(statusOf(theme.id, "1"), "stale");
  });
});

describe("move, copy and remove", () => {
  it("copy shares the file, move takes it out, remove drops it when nothing else holds it", async () => {
    const a = await themed([person("1")]);
    const b = await photoThemes.createTheme({ name: "Easter 2027", prompt: "Spring" });
    const c = await photoThemes.createTheme({ name: "Summer 2027", prompt: "Sun" });
    await generated();
    await photoThemes.approve(a.id, "1");
    const files = () => fs.readdir(path.join(TMP, PHOTO_THEME_IMAGE_DIR));

    await photoThemes.transfer(a.id, "1", b.id, "copy");
    assert.equal(statusOf(a.id, "1"), "approved");
    assert.equal(statusOf(b.id, "1"), "approved");
    assert.equal((await files()).length, 1, "a copy shares the one file");

    await photoThemes.transfer(b.id, "1", c.id, "move");
    assert.equal(statusOf(b.id, "1"), "none");
    assert.equal(statusOf(c.id, "1"), "approved");

    // Copy onto a theme that already has them replaces what was there.
    await photoThemes.redo(c.id, "1", { planId: PLAN, serviceTypeId: TYPE });
    await photoThemes.idle();
    assert.equal(statusOf(c.id, "1"), "ready");
    await photoThemes.transfer(a.id, "1", c.id, "copy");
    assert.equal(statusOf(c.id, "1"), "approved", "the pending redo was replaced");

    await photoThemes.remove(a.id, "1");
    assert.equal(photoThemes.shownPhotos(PLAN).size, 0, "the plan using the theme shows the original again");
    assert.equal((await files()).length, 1, "theme C still holds the file");
    await photoThemes.remove(c.id, "1");
    assert.deepEqual(await files(), [], "nothing holds it now");
  });

  it("refuses to move a photo that has not been approved, or onto its own theme", async () => {
    const a = await themed([person("1")]);
    const b = await photoThemes.createTheme({ name: "Easter 2027", prompt: "Spring" });
    await generated();
    await assert.rejects(() => photoThemes.transfer(a.id, "1", b.id, "move"), /no approved photo/);
    await assert.rejects(() => photoThemes.transfer(a.id, "1", a.id, "copy"), /already in/);
  });

  it("deleting a theme puts its plans back on the originals and removes its photos", async () => {
    const a = await themed([person("1")]);
    await generated();
    await photoThemes.approve(a.id, "1");
    assert.deepEqual(await photoThemes.deleteTheme(a.id), { plans: 1, photos: 1 });
    assert.equal(photoThemes.state().plans[0]!.themeId, null);
    assert.equal(photoThemes.shownPhotos(PLAN).size, 0);
    assert.deepEqual(await fs.readdir(path.join(TMP, PHOTO_THEME_IMAGE_DIR)), []);
  });
});

describe("retention", () => {
  it("keeps photos until three months after the last service, counted in the app's time zone", async (t: TestContext) => {
    const lines = captureConsole(t, "log", "warn");
    const theme = await themed([person("1")]);
    await generated();
    await photoThemes.approve(theme.id, "1");
    assert.equal(photoThemes.state().themes[0]!.keptUntil, "2027-03-24");

    // 03:00 UTC on the 25th is still the 24th in Chicago: kept. A sweep that
    // read the host's UTC date would remove it here.
    now = Date.parse("2027-03-25T03:00:00Z");
    assert.deepEqual(await photoThemes.sweep(), { photos: 0, plans: 0 });
    assert.equal(statusOf(theme.id, "1"), "approved");

    // 06:00 UTC is 01:00 on the 25th in Chicago: past it.
    now = Date.parse("2027-03-25T06:00:00Z");
    assert.deepEqual(await photoThemes.sweep(), { photos: 1, plans: 1 });
    assert.equal(statusOf(theme.id, "1"), "none");
    assert.deepEqual(await fs.readdir(path.join(TMP, PHOTO_THEME_IMAGE_DIR)), []);
    assert.ok(lines.some((l) => l === '[photo-theme] retention: removed 1 photo(s) from "Christmas 2026", kept until 2027-03-24'));
    assert.equal(photoThemes.state().themes.length, 1, "the theme and its prompt stay");
  });

  it("using a theme again pushes the date out, and never back", async () => {
    const theme = await themed([person("1")]);
    await photoThemes.choosePlan(PLAN_2, { serviceTypeId: TYPE, sortDate: "2027-04-04T15:00:00Z", themeId: theme.id });
    assert.equal(photoThemes.state().themes[0]!.keptUntil, "2027-07-04");
    await photoThemes.choosePlan(PLAN_2, { serviceTypeId: TYPE, sortDate: undefined, themeId: null });
    assert.equal(photoThemes.state().themes[0]!.keptUntil, "2027-07-04", "switching a plan away does not shorten it");
    await photoThemes.choosePlan(PLAN, { serviceTypeId: TYPE, sortDate: undefined, show: "themed" });
    assert.equal(photoThemes.state().themes[0]!.keptUntil, "2027-07-04", "touching an earlier plan does not shorten it");
  });

  it("leaves alone a theme a plan with no known date uses", async () => {
    const theme = await themed([person("1")]);
    await generated();
    await photoThemes.approve(theme.id, "1");
    await photoThemes.choosePlan("2003", { serviceTypeId: TYPE, sortDate: null, themeId: theme.id });
    now = Date.parse("2028-01-01T12:00:00Z");
    assert.equal((await photoThemes.sweep()).photos, 0);
  });
});

describe("a file that cannot be used", () => {
  it("is left as it is: nothing is saved over it, and nothing is swept", async (t: TestContext) => {
    const lines = captureConsole(t, "error", "warn");
    const held = JSON.stringify({ version: 2, themes: "from a newer build" });
    await fs.writeFile(path.join(TMP, "photo-themes.json"), held);
    await photoThemes.reloadForTests();
    assert.deepEqual(photoThemes.state().themes, []);
    await assert.rejects(() => photoThemes.createTheme({ name: "X", prompt: "Y" }), /Theme photos are off/);
    assert.deepEqual(await photoThemes.sweep(), { photos: 0, plans: 0 });
    assert.equal(await fs.readFile(path.join(TMP, "photo-themes.json"), "utf8"), held);
    assert.ok(lines.some((l) => l.includes("[photo-theme] photo-themes.json could not be used")));
    await fs.rm(path.join(TMP, "photo-themes.json"));
  });
});

describe("what a save writes is what a load reads", () => {
  it("cleans a roster name and refuses a photo off Planning Center, so the file still loads", async () => {
    const long = { personId: "7", name: `A very\nlong name ${"x".repeat(120)}`, photoUrl: pcoPhoto("7") };
    const elsewhere = { personId: "8", name: "Elsewhere", photoUrl: "https://example.org/face.jpg" };
    const theme = await themed([long, elsewhere]);
    const r = await generated();
    assert.deepEqual(r.skipped, [{ personId: "8", name: "Elsewhere", reason: "Their photo is not on Planning Center" }]);
    assert.equal(statusOf(theme.id, "7"), "ready");
    await photoThemes.reloadForTests();
    const p = photoThemes.state().themes[0]!.people[0]!;
    assert.equal(p.status, "ready", "the file written loads back");
    assert.ok(p.name.length <= 80 && !p.name.includes("\n"));
  });
});

describe("files on disk", () => {
  it("are never removed because the book read empty from a damaged file", async () => {
    const theme = await themed([person("1")]);
    await generated();
    await photoThemes.approve(theme.id, "1");
    const dir = path.join(TMP, PHOTO_THEME_IMAGE_DIR);
    const [file] = await fs.readdir(dir);
    await fs.writeFile(path.join(TMP, "photo-themes.json"), '{"version":1,"themes":[{"id"');
    await photoThemes.reloadForTests();
    await photoThemes.createTheme({ name: "Easter 2027", prompt: "Spring" });
    assert.deepEqual(await fs.readdir(dir), [file], "the edit the quarantined file names is still there");
    for (const f of await fs.readdir(TMP)) if (f.startsWith("photo-themes.json.corrupt-")) await fs.rm(path.join(TMP, f));
  });

  it("an approved photo whose file is missing is not drawn: the person shows their original", async (t: TestContext) => {
    const lines = captureConsole(t, "warn");
    const theme = await themed([person("1")]);
    await generated();
    await photoThemes.approve(theme.id, "1");
    assert.equal(photoThemes.shownPhotos(PLAN).size, 1);
    await fs.rm(path.join(TMP, PHOTO_THEME_IMAGE_DIR), { recursive: true });
    await photoThemes.reloadForTests();
    assert.equal(photoThemes.shownPhotos(PLAN).size, 0);
    assert.ok(lines.some((l) => l.includes("1 stored photo(s) are missing")));
  });

  it("the original is fetched through the photo cache, at 1024 px", async () => {
    const asked: string[] = [];
    const realFetch = globalThis.fetch;
    const jpeg = await (await import("./photo-themes-harness.js")).jpegBytes(90);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("planningcenteronline.com")) {
        asked.push(url);
        return new Response(new Uint8Array(jpeg), { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const { loadOriginal: _injected, ...withoutLoader } = srv.deps;
    try {
      await photoThemes.start(withoutLoader, { sweep: false });
      const theme = await themed([person("5")]);
      await generated();
      assert.equal(statusOf(theme.id, "5"), "ready");
      assert.deepEqual(asked, [pcoPhoto("5").replace("g=256x256%23", "g=1024x1024")]);
    } finally {
      globalThis.fetch = realFetch;
      await photoThemes.start(srv.deps, { sweep: false });
    }
  });
});

describe("the key", () => {
  it("never appears in what the service says, broadcasts or logs", async (t: TestContext) => {
    const lines = captureConsole(t, "log", "warn", "error");
    const theme = await themed([person("1"), person("2")]);
    fake.models = () => ({ status: 401, body: errorBody("invalid_api_key", null, KEY) });
    await photoThemes.connection.test();
    fake.edit = () => ({ status: 401, body: errorBody("invalid_api_key", null, KEY) });
    await photoThemes.connection.saveKey(KEY);
    await generated();
    const said = [
      JSON.stringify(photoThemes.state()),
      JSON.stringify(await photoThemes.planPeople(PLAN, TYPE)),
      JSON.stringify(photoThemes.connection.status()),
      JSON.stringify(photoThemes.changed()),
      JSON.stringify(theme),
      ...frames,
      ...lines,
    ];
    assert.ok(frames.some((f) => f.startsWith("photo-themes:changed")), "the channel was broadcast");
    assert.ok(lines.length > 0);
    for (const s of said) assert.ok(!s.includes(KEY) && !s.includes(KEY.slice(8)), `the key leaked: ${s.slice(0, 200)}`);
    assert.equal(photoThemes.connection.status().hint, "sk-…ssss");
    // It is the key that went to OpenAI, in the one header.
    assert.equal(fake.requests.at(-1)!.authorization, `Bearer ${KEY}`);
  });
});
