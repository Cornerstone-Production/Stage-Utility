// Moving video feeds between servers, through the real routes and stores.
//
// Run against the real service, secrets store and feed file in a scratch data
// dir, so what is asserted is what an operator's two servers would do.

import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-transfer-"));
process.env.STAGE_UTILITY_DATA = TMP;
const { callRoute } = await import("./route-harness.js");
const { videoRoutes } = await import("./video-routes.js");
const { secretsStore } = await import("../secrets.js");
const { videoService } = await import("../video/video-service.js");

const PULL = { name: "BOX", source: { kind: "pull", url: "rtsp://192.0.2.31:554/box", username: "admin" }, password: "cam-pass-1" };
const PUSH = { name: "OBS Lobby", source: { kind: "push", protocol: "srt" } };
const EMBED = { name: "Resi", source: { kind: "embed", player: "youtube-video", ref: "dQw4w9WgXcQ" } };
const DEFAULT_PORTS = { rtmp: 1935, srt: 8890, webrtcUdp: 8189, webrtcHttp: 8889, hls: 8888, api: 9997 };
const OTHER_PORTS = { rtmp: 2935, srt: 9890, webrtcUdp: 9189, webrtcHttp: 9889, hls: 9888, api: 10997 };

type Json = Record<string, any>;

async function add(body: unknown): Promise<string> {
  const r = await callRoute(videoRoutes, "/api/video/feeds", { method: "POST", body });
  assert.equal(r.status, 201, r.body);
  return (r.json as Json).feed.id;
}
const pwOf = async (id: string) => (await secretsStore.getSecrets(`video:${id}`)).password;
const state = async () => (await callRoute(videoRoutes, "/api/video/state")).json as Json;
const exportFile = async (query = ""): Promise<Json> => {
  const r = await callRoute(videoRoutes, `/api/video/export${query}`);
  assert.equal(r.status, 200, r.body);
  return r.json as Json;
};
const preview = (bundle: unknown) => callRoute(videoRoutes, "/api/video/import/preview", { method: "POST", body: bundle });
const apply = (body: unknown) => callRoute(videoRoutes, "/api/video/import", { method: "POST", body });
const bundleOf = (feeds: unknown[], extra: Json = {}): Json => ({
  kind: "stage-utility-video-feeds", version: 1, appVersion: "1.0.0", createdAt: "2026-10-01T00:00:00.000Z",
  source: { server: "Prod" }, feeds, ...extra,
});

/** Console lines written while `fn` runs. */
async function logged(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { await fn(); } finally { console.log = real; }
  return lines;
}

beforeEach(async () => {
  for (const f of (await state()).feeds as { id: string }[]) await videoService.removeFeed(f.id);
  await videoService.setPorts(DEFAULT_PORTS);
});

// ── Export ──────────────────────────────────────────────────────────────

test("export keeps feed ids and answers a dated attachment", async () => {
  const pull = await add(PULL);
  await add(EMBED);
  const r = await callRoute(videoRoutes, "/api/video/export");
  assert.equal(r.status, 200);
  assert.match(r.headers["content-disposition"]!, /^attachment; filename="stage-utility-video-feeds-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(r.headers["cache-control"], "no-store");
  const b = r.json as Json;
  assert.equal(b.kind, "stage-utility-video-feeds");
  assert.equal(b.version, 1);
  assert.deepEqual(b.feeds.map((f: Json) => f.id), [pull, "resi"]);
  assert.equal("ports" in b, false, "ports are opt-in");
});

test("export ?feeds= exports just those feeds, and refuses an unknown id", async () => {
  await add(PULL);
  await add(EMBED);
  assert.deepEqual((await exportFile("?feeds=resi")).feeds.map((f: Json) => f.id), ["resi"]);
  const bad = await callRoute(videoRoutes, "/api/video/export?feeds=resi,nope");
  assert.equal(bad.status, 400);
  assert.match((bad.json as Json).error, /No such feed: nope/);
  assert.equal((await callRoute(videoRoutes, "/api/video/export?feeds=")).status, 400);
});

test("export refuses a flag that is not 1 or 0", async () => {
  await add(EMBED);
  for (const q of ["?ports=yes", "?passwords=2"]) {
    const r = await callRoute(videoRoutes, `/api/video/export${q}`);
    assert.equal(r.status, 400, q);
    assert.match((r.json as Json).error, /must be 1 or 0/);
  }
});

test("export carries passwords only with passwords=1, from the secrets store", async () => {
  const pull = await add(PULL);
  const push = await add(PUSH);
  await add(EMBED);
  const pushSecret = (await pwOf(push))!;

  const without = await callRoute(videoRoutes, "/api/video/export");
  assert.equal(without.body.includes("cam-pass-1"), false);
  assert.equal(without.body.includes(pushSecret), false);
  assert.equal(without.body.includes('"password"'), false);

  const withPw = (await exportFile("?passwords=1")).feeds as Json[];
  assert.equal(withPw.find((f) => f.id === pull)!.password, "cam-pass-1");
  assert.equal(withPw.find((f) => f.id === push)!.password, pushSecret);
  assert.equal("password" in withPw.find((f) => f.id === "resi")!, false);
});

test("export never mints a password for a push feed that has none", async () => {
  const push = await add(PUSH);
  await secretsStore.clearSecrets(`video:${push}`);
  const f = (await exportFile("?passwords=1")).feeds[0];
  assert.equal("password" in f, false);
  assert.equal(await pwOf(push), undefined, "the export wrote a secret");
});

test("export carries ports only with ports=1", async () => {
  await add(EMBED);
  await videoService.setPorts(OTHER_PORTS);
  assert.equal("ports" in (await exportFile()), false);
  assert.deepEqual((await exportFile("?ports=1")).ports, OTHER_PORTS);
});

test("export with passwords refuses a cross-origin browser request", async () => {
  await add(PULL);
  const r = await callRoute(videoRoutes, "/api/video/export?passwords=1", {
    headers: { origin: "http://evil.example", host: "localhost:8788" },
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.includes("cam-pass-1"), false);
});

test("export logs one line with the count and flags, never a password", async () => {
  await add(PULL);
  await add(EMBED);
  const lines = await logged(async () => { await exportFile("?passwords=1&ports=1"); });
  assert.deepEqual(lines.filter((l) => l.startsWith("[video-export]")), ["[video-export] exported 2 feeds, with passwords, with relay ports"]);
  assert.equal(lines.some((l) => l.includes("cam-pass-1")), false);
  const plain = await logged(async () => { await exportFile("?feeds=resi"); });
  assert.deepEqual(plain, ["[video-export] exported 1 feed"]);
});

// ── Structural refusals ─────────────────────────────────────────────────

test("a file that is not a usable video feeds export is refused, naming the problem", async () => {
  const cases: [unknown, RegExp][] = [
    [bundleOf([], { kind: "stage-utility-view" }), /"stage-utility-view" file, not a video feeds export/],
    [bundleOf([], { version: 2 }), /version 2; this server reads version 1/],
    [bundleOf([], { feeds: "nope" }), /no list of feeds/],
    [bundleOf([{ id: "Bad Id", name: "x", source: EMBED.source }]), /id this server cannot use/],
    [bundleOf([{ id: "a", name: "x", source: EMBED.source }, { id: "a", name: "y", source: EMBED.source }]), /"a" more than once/],
    [bundleOf([], { ports: { ...DEFAULT_PORTS, rtmp: 80 } }), /relay ports in the file are not usable/],
  ];
  for (const [bundle, message] of cases) {
    for (const [name, call] of [["preview", () => preview(bundle)], ["apply", () => apply({ bundle })]] as const) {
      const r = await call();
      assert.equal(r.status, 400, `${name} ${JSON.stringify(bundle).slice(0, 60)}`);
      assert.match((r.json as Json).error, message, name);
    }
  }
});

// ── Preview ─────────────────────────────────────────────────────────────

test("preview marks each feed new, same, differs or invalid, with fields", async () => {
  await add(PULL);
  await add(EMBED);
  const feeds = [
    { id: "box", name: "BOX", source: { ...PULL.source, url: "rtsp://192.0.2.99:554/box" } },
    { id: "resi", name: "Resi", source: EMBED.source },
    { id: "gym", name: "GYM", source: { kind: "pull", url: "rtsp://192.0.2.50:554/gym", username: "" } },
    { id: "odd", name: "Odd", source: { kind: "teleport" } },
  ];
  const r = await preview(bundleOf(feeds));
  assert.equal(r.status, 200);
  const p = r.json as Json;
  const by = (id: string) => p.feeds.find((f: Json) => f.id === id);
  assert.equal(by("box").status, "differs");
  assert.deepEqual(by("box").differences, [{ field: "url", here: "rtsp://192.0.2.31:554/box", file: "rtsp://192.0.2.99:554/box" }]);
  assert.equal(by("resi").status, "same");
  assert.deepEqual(by("resi").differences, []);
  assert.equal(by("gym").status, "new");
  assert.equal(by("odd").status, "invalid");
  assert.match(by("odd").error, /does not offer teleport/);
  assert.equal(by("odd").kind, "teleport");
  assert.equal(p.server, "Prod");
  assert.equal(p.hasPasswords, false);
  assert.equal("ports" in p, false, "no ports row when the file has none");
});

test("preview names a rename, and a change of kind, as the difference", async () => {
  await add(PULL);
  await add(EMBED);
  const p = (await preview(bundleOf([
    { id: "resi", name: "Resi 2", source: EMBED.source },
    { id: "box", name: "BOX", source: PUSH.source },
  ]))).json as Json;
  assert.deepEqual(p.feeds[0].differences, [{ field: "name", here: "Resi", file: "Resi 2" }]);
  assert.deepEqual(p.feeds[1].differences, [{ field: "kind", here: "pull", file: "push" }]);
});

test("preview names the local feeds the file does not have", async () => {
  await add(PULL);
  await add(EMBED);
  const p = (await preview(bundleOf([{ id: "resi", name: "Resi", source: EMBED.source }]))).json as Json;
  assert.deepEqual(p.absent, ["BOX"]);
});

test("a password difference carries no values, and is compared only when the file has one", async () => {
  const box = await add(PULL);
  const different = { id: box, name: "BOX", source: PULL.source, password: "file-pass-99" };
  const p = (await preview(bundleOf([different]))).json as Json;
  assert.equal(p.hasPasswords, true);
  assert.equal(p.feeds[0].status, "differs");
  assert.deepEqual(p.feeds[0].differences, [{ field: "password" }]);
  const wire = JSON.stringify(p);
  assert.equal(wire.includes("file-pass-99"), false);
  assert.equal(wire.includes("cam-pass-1"), false);

  const same = (await preview(bundleOf([{ ...different, password: "cam-pass-1" }]))).json as Json;
  assert.equal(same.feeds[0].status, "same");
  const none = (await preview(bundleOf([{ id: box, name: "BOX", source: PULL.source }]))).json as Json;
  assert.equal(none.feeds[0].status, "same", "a file with no password says nothing about this server's");
});

test("preview reports ports only when the file has them, and whether they match", async () => {
  await videoService.setPorts(OTHER_PORTS);
  const same = (await preview(bundleOf([], { ports: OTHER_PORTS }))).json as Json;
  assert.deepEqual(same.ports, { file: OTHER_PORTS, here: OTHER_PORTS, same: true });
  const differs = (await preview(bundleOf([], { ports: DEFAULT_PORTS }))).json as Json;
  assert.deepEqual(differs.ports, { file: DEFAULT_PORTS, here: OTHER_PORTS, same: false });
});

test("a push password in the file that this server would not accept makes that feed invalid", async () => {
  const p = (await preview(bundleOf([{ id: "p", name: "P", source: PUSH.source, password: "a b;c" }]))).json as Json;
  assert.equal(p.feeds[0].status, "invalid");
  assert.match(p.feeds[0].error, /publish password/);
});

// ── Apply ───────────────────────────────────────────────────────────────

test("apply adds new feeds under the file's own id", async () => {
  const r = await apply({ bundle: bundleOf([{ id: "gym-cam", name: "GYM", source: { kind: "pull", url: "rtsp://192.0.2.50:554/gym", username: "" } }]) });
  assert.equal(r.status, 200, r.body);
  assert.deepEqual((r.json as Json).added, ["GYM"]);
  assert.deepEqual((await state()).feeds.map((f: Json) => f.id), ["gym-cam"], "the id came from the file, not from the name");
});

test("apply replaces a differing feed by default, and keeps this server's when told to", async () => {
  const box = await add(PULL);
  const file = bundleOf([{ id: box, name: "BOX", source: { ...PULL.source, url: "rtsp://192.0.2.99:554/box" } }]);

  const kept = (await apply({ bundle: file, choices: { [box]: "keep" } })).json as Json;
  assert.deepEqual([kept.kept, kept.replaced], [["BOX"], []]);
  assert.equal((await state()).feeds[0].source.url, "rtsp://192.0.2.31:554/box");

  const replaced = (await apply({ bundle: file })).json as Json;
  assert.deepEqual([replaced.kept, replaced.replaced], [[], ["BOX"]], "no choice given means replace");
  assert.equal((await state()).feeds[0].source.url, "rtsp://192.0.2.99:554/box");

  const again = (await apply({ bundle: file })).json as Json;
  assert.deepEqual(again.same, ["BOX"], "the same file twice changes nothing the second time");
});

test("apply never removes a feed that the file does not carry", async () => {
  await add(PULL);
  await add(EMBED);
  const r = await apply({ bundle: bundleOf([{ id: "extra", name: "Extra", source: { kind: "external", url: "http://h/x/whep" } }]) });
  assert.equal(r.status, 200);
  assert.deepEqual((await state()).feeds.map((f: Json) => f.id).sort(), ["box", "extra", "resi"]);
});

test("apply never flips the integration switch", async () => {
  const { settingsStore } = await import("../settings-store.js");
  const before = JSON.stringify((await settingsStore.load()).integrationEnabled ?? {});
  const r = await apply({ bundle: bundleOf([{ id: "gym", name: "GYM", source: { kind: "pull", url: "rtsp://192.0.2.50:554/gym", username: "" } }]) });
  assert.equal(r.status, 200);
  assert.equal(JSON.stringify((await settingsStore.load()).integrationEnabled ?? {}), before);
});

test("apply writes passwords to the secrets store and never to the feed file", async () => {
  const bundle = bundleOf([
    { id: "cam", name: "Cam", source: PULL.source, password: "from-the-file-1" },
    { id: "obs", name: "OBS", source: PUSH.source, password: "a".repeat(16) },
  ]);
  const r = (await apply({ bundle })).json as Json;
  assert.equal(r.passwordsWritten, 2);
  assert.deepEqual(r.newPushPasswords, []);
  assert.equal(await pwOf("cam"), "from-the-file-1");
  assert.equal(await pwOf("obs"), "a".repeat(16));
  // Raw from disk, so a password folded into any field would still be found.
  const disk = await fs.readFile(path.join(TMP, "video-feeds.json"), "utf-8");
  assert.equal(disk.includes("from-the-file-1"), false);
  assert.equal(disk.includes("a".repeat(16)), false);
});

test("a replaced feed with no password in the file keeps this server's, unless its kind changes", async () => {
  const box = await add(PULL);
  const sameKind = bundleOf([{ id: box, name: "BOX renamed", source: { ...PULL.source, url: "rtsp://192.0.2.99:554/box" } }]);
  assert.equal(((await apply({ bundle: sameKind })).json as Json).replaced.length, 1);
  assert.equal(await pwOf(box), "cam-pass-1", "the local password was lost");

  const toEmbed = bundleOf([{ id: box, name: "BOX", source: EMBED.source }]);
  await apply({ bundle: toEmbed });
  assert.equal(await pwOf(box), undefined, "an embed feed keeps no secret (updateFeedSecret's rule)");

  const toPush = bundleOf([{ id: box, name: "BOX", source: PUSH.source }]);
  const r = (await apply({ bundle: toPush })).json as Json;
  assert.deepEqual(r.newPushPasswords, ["BOX"], "becoming push mints a password the devices need");
  assert.equal(typeof (await pwOf(box)), "string");
});

test("a new push feed with no password gets a minted one and is reported", async () => {
  const r = (await apply({ bundle: bundleOf([{ id: "obs", name: "OBS Lobby", source: PUSH.source }]) })).json as Json;
  assert.deepEqual(r.newPushPasswords, ["OBS Lobby"]);
  assert.equal(r.passwordsWritten, 0);
  assert.match((await pwOf("obs"))!, /^[A-Za-z0-9]{16}$/);
});

test("apply skips an invalid feed with its reason and lands the rest", async () => {
  const r = (await apply({
    bundle: bundleOf([
      { id: "odd", name: "Odd", source: { kind: "teleport" } },
      { id: "resi", name: "Resi", source: EMBED.source },
    ]),
  })).json as Json;
  assert.deepEqual(r.added, ["Resi"]);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].name, "Odd");
  assert.match(r.skipped[0].reason, /does not offer teleport/);
  assert.deepEqual((await state()).feeds.map((f: Json) => f.id), ["resi"]);
});

test("apply changes the ports only when asked", async () => {
  const bundle = bundleOf([], { ports: OTHER_PORTS });
  const off = (await apply({ bundle, ports: false })).json as Json;
  assert.equal(off.portsApplied, false);
  assert.deepEqual((await state()).ports, DEFAULT_PORTS);
  const absent = (await apply({ bundle })).json as Json;
  assert.equal(absent.portsApplied, false, "no ports flag means no change");
  const on = (await apply({ bundle, ports: true })).json as Json;
  assert.equal(on.portsApplied, true);
  assert.deepEqual((await state()).ports, OTHER_PORTS);
  const again = (await apply({ bundle, ports: true })).json as Json;
  assert.equal(again.portsApplied, false, "the same ports are not applied twice");
});

test("apply refuses a body whose choices or ports are malformed", async () => {
  const bundle = bundleOf([]);
  assert.equal((await apply({ bundle, ports: "yes" })).status, 400);
  assert.equal((await apply({ bundle, choices: { a: "delete" } })).status, 400);
  assert.equal((await apply({ bundle, choices: ["a"] })).status, 400);
});

test("apply logs one line with counts, scrubbed names and no password", async () => {
  const lines = await logged(async () => {
    await apply({
      bundle: bundleOf([
        { id: "cam", name: "Cam", source: PULL.source, password: "from-the-file-1" },
        { id: "odd", name: "Odd\n[video] forged", source: { kind: "teleport" } },
      ]),
    });
  });
  const mine = lines.filter((l) => l.startsWith("[video-import]"));
  assert.equal(mine.length, 1);
  assert.match(mine[0]!, /^\[video-import\] added 1, replaced 0, kept 0, same 0, skipped 1, wrote 1 password/);
  assert.equal(mine[0]!.includes("from-the-file-1"), false);
  assert.equal(mine[0]!.includes("\n"), false, "a newline in a feed name forged a log line");
});

test("a secret write that fails takes the import back out and says so", async () => {
  const box = await add(PULL);
  const real = secretsStore.setSecret.bind(secretsStore);
  secretsStore.setSecret = async () => { throw new Error("disk full"); };
  try {
    await assert.rejects(
      apply({
        bundle: bundleOf([
          { id: box, name: "BOX", source: { ...PULL.source, url: "rtsp://192.0.2.99:554/box" }, password: "file-pass-99" },
          { id: "gym", name: "GYM", source: PULL.source, password: "file-pass-98" },
        ]),
      }),
      /disk full/,
      "a failed secret write must reach the caller, not read as success",
    );
  } finally {
    secretsStore.setSecret = real;
  }
  const feeds = (await state()).feeds as Json[];
  assert.deepEqual(feeds.map((f) => f.id), [box], "the added feed was left behind");
  assert.equal(feeds[0].source.url, "rtsp://192.0.2.31:554/box", "the replaced feed was left changed");
  assert.equal(await pwOf(box), "cam-pass-1");
});

test("round trip: export with passwords and ports, import into an empty store, same feeds and passwords", async () => {
  const pull = await add(PULL);
  const push = await add(PUSH);
  await add(EMBED);
  await videoService.setPorts(OTHER_PORTS);
  const exported = await exportFile("?passwords=1&ports=1");
  const feedsBefore = (await state()).feeds.map((f: Json) => [f.id, f.name, f.source]);
  const pushSecret = await pwOf(push);

  for (const f of (await state()).feeds as { id: string }[]) await videoService.removeFeed(f.id);
  await videoService.setPorts(DEFAULT_PORTS);
  assert.deepEqual((await state()).feeds, []);

  const r = (await apply({ bundle: exported, ports: true })).json as Json;
  assert.deepEqual(r.added, ["BOX", "OBS Lobby", "Resi"]);
  assert.deepEqual(r.newPushPasswords, []);
  assert.deepEqual((await state()).feeds.map((f: Json) => [f.id, f.name, f.source]), feedsBefore);
  assert.equal(await pwOf(pull), "cam-pass-1");
  assert.equal(await pwOf(push), pushSecret);
  assert.deepEqual((await state()).ports, OTHER_PORTS);
});

test("both import routes read a body past the ordinary JSON cap, like /api/views/import", async () => {
  // A file edited by hand, or exported beside other data, can outgrow the 8 MB
  // default; the import routes share the config ceiling.
  const { MAX_JSON_BODY_BYTES, MAX_CONFIG_BODY_BYTES } = await import("./context.js");
  const padding = "x".repeat(MAX_JSON_BODY_BYTES + 1024);
  assert.ok(MAX_JSON_BODY_BYTES + 1024 < MAX_CONFIG_BODY_BYTES);
  const bundle = bundleOf([], { padding });
  assert.equal((await preview(bundle)).status, 200);
  assert.equal((await apply({ bundle })).status, 200);
});
