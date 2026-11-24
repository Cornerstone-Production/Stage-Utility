// The Q-SYS routes, driven through the real handler, the real service and watch
// singletons (pointed at the fake Core) and a temporary data directory.
//
// `device` here is "unknown <user agent>": the route harness has no socket, so the
// address half is only exercised against a running server.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, mock, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-qsys-routes-"));
process.env.STAGE_UTILITY_DATA = TMP;
// A hand-broken allowlist on disk before the server first reads it: it names the
// gain, but with min above max, so it must be enforced as no allowlist at all.
await fs.writeFile(
  path.join(TMP, "qsys-allowlist.json"),
  JSON.stringify({ entries: [{ component: "Lobby_Mixer", control: "gain", label: "x", min: 5, max: 0, confirm: "none" }] }),
);
// A write log with one good entry among things no write ever wrote.
await fs.writeFile(
  path.join(TMP, "qsys-write-log.json"),
  JSON.stringify([
    { at: 1, panelId: null, device: "seed", component: "Lobby_Mixer", control: "gain", from: null, to: -1, result: "ok" },
    { at: "yesterday", panelId: null, device: "junk", component: "c", control: "n", from: null, to: 1, result: "ok" },
    null,
    "a line of text",
    { at: 2, panelId: 7, device: "junk", component: "c", control: "n", from: null, to: 1, result: "ok" },
    [1, 2],
  ]),
);

const { qsysRoutes } = await import("./qsys-routes.js");
const { callRoute } = await import("./route-harness.js");
const { ROUTE_MODULES } = await import("../remote-server.js");
const { setNamedSubscriberCheck, subscriptionsChanged } = await import("../broadcaster.js");
const { FakeQrcServer } = await import("../qsys/fake-qrc-server.js");
const { qsysService } = await import("../qsys/qsys-service.js");
const { qsysWatch, watchChannel } = await import("../qsys/qsys-watch.js");
const { qsysWriteLog } = await import("../qsys/qsys-write-log.js");
const { MAX_WRITE_BODY_BYTES } = await import("./qsys-routes.js");
const { BodyTooLargeError } = await import("./context.js");
type AllowEntry = import("../qsys/qsys-allowlist-store.js").AllowEntry;

const fake = new FakeQrcServer();
fake.components.set("Lobby_Mixer", [
  { Name: "gain", Type: "Float", Value: -10, String: "-10dB", Position: 0.5, Direction: "Read/Write", ValueMin: -100, ValueMax: 20 },
  { Name: "mute", Type: "Boolean", Value: false, String: "false", Position: 0, Direction: "Read/Write" },
]);
const named = new Set<string>();
let port = 0;

before(async () => {
  port = await fake.start();
  setNamedSubscriberCheck((ch) => named.has(ch));
});
after(async () => {
  qsysService.stop();
  setNamedSubscriberCheck(() => false);
  await fake.stop();
  await qsysWriteLog.whenIdle();
  await fs.rm(TMP, { recursive: true, force: true });
});

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200000; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function connect(): Promise<void> {
  qsysService.configure({ host: "127.0.0.1", port, user: "", enabled: true, volunteerMeterHz: 10, staffMeterHz: 20 }, null);
  await until(() => qsysService.transport !== null, "connected");
  await qsysWatch.recompute();
}

/** Quiet the [qsys] lines a refusal is meant to write. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const warn = mock.method(console, "warn", () => {});
  const log = mock.method(console, "log", () => {});
  try {
    return await fn();
  } finally {
    warn.mock.restore();
    log.mock.restore();
  }
}

const GAIN: AllowEntry = { component: "Lobby_Mixer", control: "gain", label: "Lobby gain", min: -100, max: 0, confirm: "none" };
const MUTE: AllowEntry = { component: "Lobby_Mixer", control: "mute", label: "Lobby mute", min: null, max: null, confirm: "hold" };

const put = (entries: unknown) => callRoute(qsysRoutes, "/api/qsys/allowlist", { method: "PUT", body: { entries } });
const listed = async () => ((await callRoute(qsysRoutes, "/api/qsys/allowlist")).json as { entries: AllowEntry[] }).entries;
const write = (body: unknown, headers: Record<string, string> = {}) =>
  callRoute(qsysRoutes, "/api/qsys/write", { method: "POST", body, headers });

describe("/api/qsys", () => {
  test("is dispatched by the server", () => {
    assert.ok(ROUTE_MODULES.includes(qsysRoutes));
  });

  test("an allowlist file the validator would refuse is enforced as empty, said, and never silently overwritten", async () => {
    const file = path.join(TMP, "qsys-allowlist.json");
    const warn = mock.method(console, "warn", () => {});
    try {
      const got = (await callRoute(qsysRoutes, "/api/qsys/allowlist")).json as { entries: AllowEntry[]; invalid: string | null };
      assert.deepEqual(got.entries, []);
      assert.match(got.invalid ?? "", /not valid \(entry 1: min must not be above max\)/, "GET did not say the stored file is invalid");
      const r = await write({ component: "Lobby_Mixer", control: "gain", value: -5 });
      assert.equal((r.json as { reason: string }).reason, "not-allowed");
      assert.ok(
        warn.mock.calls.some((c) => String(c.arguments[0]).startsWith("[qsys] qsys-allowlist.json is not a valid allowlist (entry 1: min must not be above max)")),
        "the broken file was not logged",
      );
    } finally {
      warn.mock.restore();
    }
    assert.match(await fs.readFile(file, "utf8"), /"min":5/, "the file was rewritten on read");

    // A save or an import that does not say it replaces the invalid file is refused, and the file kept.
    const plain = await quietly(() => put([MUTE]));
    assert.equal(plain.status, 409, "a save overwrote the invalid file without being told to");
    assert.match((plain.json as { error: string }).error, /replaceInvalid/);
    const exported = { format: "stage-utility-qsys-allowlist", version: 1, entries: [MUTE] };
    const imported = await quietly(() => callRoute(qsysRoutes, "/api/qsys/allowlist/import", { method: "POST", body: exported }));
    assert.equal(imported.status, 409, "an import overwrote the invalid file without being told to");
    assert.match(await fs.readFile(file, "utf8"), /"min":5/, "a refused save changed the file");
    assert.deepEqual(await listed(), [], "a refused save made something writable");
    assert.equal((await quietly(() => callRoute(qsysRoutes, "/api/qsys/allowlist", { method: "PUT", body: { entries: [MUTE], replaceInvalid: "yes" } }))).status, 400);

    // Saying so replaces it, and the invalid file is kept beside it, never deleted.
    const replaced = await quietly(() => callRoute(qsysRoutes, "/api/qsys/allowlist", { method: "PUT", body: { entries: [MUTE], replaceInvalid: true } }));
    assert.equal(replaced.status, 200);
    const kept = (await fs.readdir(TMP)).filter((f) => f.startsWith("qsys-allowlist.json.invalid-"));
    assert.equal(kept.length, 1, `the invalid file was not kept beside: ${kept.join(", ")}`);
    assert.match(await fs.readFile(path.join(TMP, kept[0]), "utf8"), /"min":5/);
    const after = (await callRoute(qsysRoutes, "/api/qsys/allowlist")).json as { entries: AllowEntry[]; invalid: string | null };
    assert.deepEqual(after, { entries: [MUTE], invalid: null });
  });

  test("with no Core: status is not writable, the catalog is 503, and a write is refused offline", async () => {
    const status = (await callRoute(qsysRoutes, "/api/qsys/status")).json as { state: string; writable: boolean };
    assert.equal(status.state, "offline");
    assert.equal(status.writable, false);
    assert.equal((await callRoute(qsysRoutes, "/api/qsys/catalog")).status, 503);
    assert.equal((await callRoute(qsysRoutes, "/api/qsys/catalog/refresh", { method: "POST" })).status, 503);
    assert.equal((await callRoute(qsysRoutes, "/api/qsys/bindings")).status, 503, "an empty list here would read as all clear");
    await quietly(() => put([GAIN]));
    const r = await quietly(() => write({ component: "Lobby_Mixer", control: "gain", value: -5 }));
    assert.equal(r.status, 200);
    assert.deepEqual((r.json as { ok: boolean; reason: string }).reason, "offline");
  });

  test("PUT /api/qsys/allowlist saves a good list and refuses a bad one whole, naming the entry", async () => {
    const ok = await quietly(() => put([GAIN, MUTE]));
    assert.equal(ok.status, 200);
    assert.deepEqual(await listed(), [GAIN, MUTE]);
    const bad = await quietly(() => put([GAIN, { ...MUTE, confirm: "maybe" }]));
    assert.equal(bad.status, 400);
    assert.match((bad.json as { error: string }).error, /entry 2: confirm/);
    assert.deepEqual(await listed(), [GAIN, MUTE], "a refused save changed the list");
    assert.equal((await quietly(() => callRoute(qsysRoutes, "/api/qsys/allowlist", { method: "PUT", raw: "[" }))).status, 400);
  });

  test("allowlist import rejects malformed entries and keeps the old list", async () => {
    await quietly(() => put([GAIN]));
    const exported = (await callRoute(qsysRoutes, "/api/qsys/allowlist/export", { method: "POST" })).json as Record<string, unknown>;
    assert.deepEqual(exported, { format: "stage-utility-qsys-allowlist", version: 1, entries: [GAIN] });

    const malformed: [string, unknown, RegExp][] = [
      ["no format marker", { entries: [MUTE] }, /not a Q-SYS allowlist file/],
      ["a later version", { ...exported, version: 2, entries: [MUTE] }, /version 2/],
      ["entries not a list", { ...exported, entries: { MUTE } }, /entries must be a list/],
      ["min above max", { ...exported, entries: [MUTE, { ...GAIN, min: 5, max: -5 }] }, /entry 2: min must not be above max/],
      ["half a range", { ...exported, entries: [{ ...GAIN, max: null }] }, /both be set or both be null/],
      ["a non-finite limit", { ...exported, entries: [{ ...GAIN, min: "-100" }] }, /entry 1: min must be a number/],
      ["a control character in an address", { ...exported, entries: [{ ...GAIN, component: "Lobby\u0000Mixer" }] }, /entry 1: component/],
      ["a duplicate address", { ...exported, entries: [GAIN, { ...GAIN, label: "again" }] }, /listed twice/],
      ["a missing label", { ...exported, entries: [{ ...GAIN, label: undefined }] }, /label/],
    ];
    for (const [what, file, says] of malformed) {
      const r = await quietly(() => callRoute(qsysRoutes, "/api/qsys/allowlist/import", { method: "POST", body: file }));
      assert.equal(r.status, 400, `${what} was not refused`);
      assert.match((r.json as { error: string }).error, says, what);
      assert.deepEqual(await listed(), [GAIN], `${what} changed the list`);
    }

    const good = await quietly(() =>
      callRoute(qsysRoutes, "/api/qsys/allowlist/import", { method: "POST", body: { ...exported, entries: [MUTE, GAIN] } }),
    );
    assert.equal(good.status, 200);
    assert.deepEqual(await listed(), [MUTE, GAIN]);
  });

  test("POST /api/qsys/write validates the body and returns WriteResult", async () => {
    await quietly(() => put([GAIN, MUTE]));
    const refusals: [string, unknown][] = [
      ["component not text", { component: 5, control: "gain", value: 1 }],
      ["no control", { component: "Lobby_Mixer", value: 1 }],
      ["value an object", { component: "Lobby_Mixer", control: "gain", value: { v: 1 } }],
      ["value missing", { component: "Lobby_Mixer", control: "gain" }],
      ["panelId a number", { component: "Lobby_Mixer", control: "gain", value: 1, panelId: 7 }],
      ["panelId with a newline", { component: "Lobby_Mixer", control: "gain", value: 1, panelId: "a\nb" }],
      ["a list", [1]],
    ];
    for (const [what, body] of refusals) {
      const r = await quietly(() => write(body));
      assert.equal(r.status, 400, `${what} was not a 400`);
    }
    assert.equal(fake.received.filter((r) => r.method === "Component.Set").length, 0);

    await quietly(connect);
    const ok = await quietly(() =>
      write({ component: "Lobby_Mixer", control: "gain", value: 12, panelId: "panel-a" }, { "user-agent": "Pad\r\n[qsys] forged" }),
    );
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true, value: 0, string: "0dB", position: 100 / 120, clamped: true });
    const { entries } = (await callRoute(qsysRoutes, "/api/qsys/write-log")).json as { entries: { device: string; panelId: string; result: string }[] };
    assert.equal(entries[0].device, "unknown Pad  [qsys] forged", "the user agent reached the write log with its line breaks");
    assert.equal(entries[0].panelId, "panel-a");
    assert.equal((entries[0] as { remote?: string }).remote, "unknown", "the remote address was not recorded apart from the user agent");
    assert.equal(entries[0].result, "clamped");

    const notAllowed = await quietly(() => write({ component: "Lobby_Mixer", control: "other", value: 1 }));
    assert.deepEqual((notAllowed.json as { reason: string }).reason, "not-allowed");
    // 1e999 is valid JSON and parses to Infinity: the writer, not JSON, refuses it.
    const inf = await quietly(() =>
      callRoute(qsysRoutes, "/api/qsys/write", { method: "POST", raw: '{"component":"Lobby_Mixer","control":"gain","value":1e999}' }),
    );
    assert.deepEqual((inf.json as { reason: string }).reason, "bad-value");
  });

  test("final must be true or false; a body past 16 KB is refused 413", async () => {
    const bad = await quietly(() => write({ component: "Lobby_Mixer", control: "gain", value: -5, final: "no" }));
    assert.equal(bad.status, 400);
    assert.match((bad.json as { error: string }).error, /final/);
    const ok = await quietly(() => write({ component: "Lobby_Mixer", control: "gain", value: -5, final: false }));
    assert.equal(ok.status, 200);
    assert.equal(MAX_WRITE_BODY_BYTES, 16 * 1024);
    const big = { component: "Lobby_Mixer", control: "gain", value: "x".repeat(MAX_WRITE_BODY_BYTES) };
    await assert.rejects(write(big), (err: unknown) => err instanceof BodyTooLargeError);
  });

  test("a momentary press over the route takes a lease, read from the saved views; renewals over /api/qsys/lease hold it", async () => {
    const { qsysWriter } = await import("../qsys/qsys-write.js");
    const { viewsStore } = await import("../views-store.js");
    // The views as the server reads them (the real store): panel-m has a momentary button on the mute.
    await viewsStore.save([
      {
        id: "panel-m",
        name: "M",
        kind: "custom",
        createdAt: "2026-01-01",
        layout: { version: 1, canvas: {}, objects: [{ id: "b1", x: 0, y: 0, w: 0.1, h: 0.1, z: 0, config: { type: "qsys-button", binding: { component: "Lobby_Mixer", control: "mute" }, label: "Talk", hold: false, press: "momentary" } }] },
      },
    ] as never);
    for (const [what, body] of [
      ["lease not boolean", { component: "Lobby_Mixer", control: "mute", value: true, lease: "yes" }],
      ["cid a number", { component: "Lobby_Mixer", control: "mute", value: true, lease: true, cid: 5 }],
    ] as const) {
      assert.equal((await quietly(() => write(body))).status, 400, `${what} was not a 400`);
    }
    const MUTE_ADDR = { component: "Lobby_Mixer", control: "mute" };
    const mute = () => fake.received.filter((r) => r.method === "Component.Set" && (r.params as { Controls: { Name: string }[] }).Controls[0].Name === "mute").length;
    try {
      const press = await quietly(() => write({ component: "Lobby_Mixer", control: "mute", value: true, lease: true, cid: "page-9", panelId: "panel-m" }));
      assert.equal((press.json as { ok: boolean }).ok, true);
      assert.equal(qsysWriter.leases.has(MUTE_ADDR), true, "the press took no lease");
      const stranger = await callRoute(qsysRoutes, "/api/qsys/lease", { method: "POST", body: { component: "Lobby_Mixer", control: "mute", cid: "page-8" } });
      assert.deepEqual(stranger.json, { held: false }, "another page's stream renewed it");
      const renew = await callRoute(qsysRoutes, "/api/qsys/lease", { method: "POST", body: { component: "Lobby_Mixer", control: "mute", cid: "page-9" } });
      assert.deepEqual(renew.json, { held: true });
      const other = await callRoute(qsysRoutes, "/api/qsys/lease", { method: "POST", body: { component: "Lobby_Mixer", control: "mute" } });
      assert.deepEqual(other.json, { held: false });
      await quietly(() => write({ component: "Lobby_Mixer", control: "mute", value: false }));
      assert.equal(qsysWriter.leases.has(MUTE_ADDR), false, "the page's release did not end the lease");
      // A panel with no momentary button on the control: refused, nothing sent.
      const before = mute();
      const refused = await quietly(() => write({ component: "Lobby_Mixer", control: "mute", value: true, lease: true, cid: "page-9", panelId: "panel-x" }));
      assert.equal((refused.json as { reason?: string }).reason, "no-lease");
      assert.equal(mute(), before, "a press the server will not hold was sent");
    } finally {
      qsysWriter.leases.clear();
    }
  });

  test("the write log serves only entries with the shape one is written with", async () => {
    const { entries } = (await callRoute(qsysRoutes, "/api/qsys/write-log")).json as { entries: { device: string }[] };
    assert.equal(entries.filter((e) => e.device === "seed").length, 1);
    assert.ok(!entries.some((e) => !e || e.device === "junk"), "an entry of the wrong shape was served");
  });

  test("a failed catalog refresh tells the page a fixed phrase and /log the reason", async () => {
    await quietly(connect);
    fake.failNext("StatusGet", 7);
    const warn = mock.method(console, "warn", () => {});
    let r;
    try {
      r = await callRoute(qsysRoutes, "/api/qsys/catalog/refresh", { method: "POST" });
      assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes("forced failure of StatusGet")), "the reason did not reach /log");
    } finally {
      warn.mock.restore();
    }
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { error: "the catalog could not be read from the Core; see /log" });
  });

  test("status, catalog and refresh answer from the live connection", async () => {
    await quietly(connect);
    const status = (await callRoute(qsysRoutes, "/api/qsys/status")).json as { state: string; writable: boolean };
    assert.equal(status.state, "connected");
    assert.equal(status.writable, true);
    const catalog = (await callRoute(qsysRoutes, "/api/qsys/catalog")).json as { components: { name: string }[] };
    assert.deepEqual(catalog.components.map((c) => c.name), ["Lobby_Mixer"]);
    const refreshed = await quietly(() => callRoute(qsysRoutes, "/api/qsys/catalog/refresh", { method: "POST" }));
    assert.equal(refreshed.status, 200);
  });

  test("GET /api/qsys/values hydrates a registered panel from the watch, and 404s an unknown one", async () => {
    await quietly(connect);
    assert.equal((await callRoute(qsysRoutes, "/api/qsys/values")).status, 400);
    assert.equal((await callRoute(qsysRoutes, "/api/qsys/values?panel=nope")).status, 404);
    qsysWatch.setPanels([
      { id: "panel-v", kind: "staff", addresses: [{ component: "Lobby_Mixer", control: "mute" }, { component: "Lobby_Mixer", control: "mute" }] },
    ]);
    named.add(watchChannel("panel-v"));
    subscriptionsChanged();
    await quietly(() => qsysWatch.recompute());
    await until(() => qsysWatch.current([{ component: "Lobby_Mixer", control: "mute" }]).size === 1, "mute read");
    const r = (await callRoute(qsysRoutes, "/api/qsys/values?panel=panel-v")).json as { ready: boolean; values: unknown[] };
    assert.equal(r.ready, true);
    assert.deepEqual(r.values, [{ component: "Lobby_Mixer", control: "mute", value: false, string: "false", position: 0 }]);
  });
  test("GET /api/qsys/bindings reports the views' broken bindings against the live catalog and allowlist", async () => {
    await quietly(connect);
    const { viewsStore } = await import("../views-store.js");
    const object = (id: string, control: string) => ({
      id,
      x: 0,
      y: 0,
      w: 0.1,
      h: 0.1,
      z: 0,
      config: { type: "qsys-mute", binding: { component: "Lobby_Mixer", control } },
    });
    await viewsStore.save([
      { id: "v1", name: "V", kind: "custom", createdAt: "2026-01-01", layout: { version: 1, canvas: {}, objects: [object("ok", "mute"), object("bad", "nope")] } },
    ] as never);
    assert.equal((await put([MUTE])).status, 200);
    // The GET changes nothing: it answers what the subscriptions to the views, the allowlist and the catalog computed.
    const { qsysBindings } = await import("../qsys/qsys-bindings.js");
    await quietly(async () => {
      qsysBindings.start();
      await qsysBindings.refresh();
    });
    const r = await quietly(() => callRoute(qsysRoutes, "/api/qsys/bindings"));
    assert.equal(r.status, 200);
    const setPanels = mock.method(qsysWatch, "setPanels");
    try {
      await quietly(() => callRoute(qsysRoutes, "/api/qsys/bindings"));
      assert.equal(setPanels.mock.callCount(), 0, "a GET reset the watch's panels");
    } finally {
      setPanels.mock.restore();
    }
    assert.deepEqual(r.json, [{ panelId: "v1", objectId: "bad", address: { component: "Lobby_Mixer", control: "nope" }, problem: "missing-control" }]);
  });

  test("GET /api/qsys/bindings answers 503 with the reason while the check cannot read the views, never an empty list", async () => {
    await quietly(connect);
    const { viewsStore } = await import("../views-store.js");
    const { qsysBindings } = await import("../qsys/qsys-bindings.js");
    const failing = mock.method(viewsStore, "loadStrict", async () => {
      throw new Error("views.json: permission denied");
    });
    try {
      await quietly(() => qsysBindings.refresh());
      const r = await callRoute(qsysRoutes, "/api/qsys/bindings");
      assert.equal(r.status, 503, `a check that could not run answered ${r.status} ${JSON.stringify(r.json)}`);
      assert.match((r.json as { error: string }).error, /could not run/);
      assert.equal((r.json as { code?: string }).code, "check-failed", "a page could not tell this 503 from no Core");
    } finally {
      failing.mock.restore();
    }
    await quietly(() => qsysBindings.refresh());
    assert.equal((await callRoute(qsysRoutes, "/api/qsys/bindings")).status, 200, "a good run did not bring the report back");
  });

  test("POST /api/qsys/allowlist/add-panel adds every control the panel writes at the Core's range, and touches no existing entry", async () => {
    await quietly(connect);
    const { viewsStore } = await import("../views-store.js");
    const o = (id: string, config: unknown) => ({ id, x: 0, y: 0, w: 0.1, h: 0.1, z: 0, config });
    await viewsStore.save([
      {
        id: "p1",
        name: "Lobby",
        kind: "custom",
        surface: "console",
        createdAt: "2026-01-01",
        layout: {
          version: 1,
          canvas: {},
          objects: [
            o("f", { type: "qsys-fader", binding: { component: "Lobby_Mixer", control: "gain" }, orientation: "vertical", showDb: true, steps: false, stepDb: 1 }),
            o("m", { type: "qsys-mute", binding: { component: "Lobby_Mixer", control: "mute" } }),
            o("x", { type: "qsys-mute", binding: { component: "Lobby_Mixer", control: "nope" } }),
            // Read only: a meter is never added.
            o("r", { type: "qsys-meter", binding: { component: "Lobby_Mixer", control: "gain" }, form: "bar" }),
          ],
        },
      },
    ] as never);
    const tight = { ...MUTE, label: "set by hand" };
    assert.equal((await quietly(() => put([tight]))).status, 200);
    const r = await quietly(() => callRoute(qsysRoutes, "/api/qsys/allowlist/add-panel", { method: "POST", body: { panelId: "p1" } }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const body = r.json as { entries: AllowEntry[]; added: AllowEntry[]; skipped: unknown[] };
    assert.deepEqual(body.added, [{ component: "Lobby_Mixer", control: "gain", label: "Lobby_Mixer gain", min: -100, max: 20, confirm: "none" }]);
    assert.deepEqual(body.skipped, [{ component: "Lobby_Mixer", control: "nope", reason: "not-in-design" }]);
    assert.deepEqual(await listed(), [tight, body.added[0]], "the hand-set entry changed, or the list was not saved");
    // Again: nothing more to add.
    const again = await quietly(() => callRoute(qsysRoutes, "/api/qsys/allowlist/add-panel", { method: "POST", body: { panelId: "p1" } }));
    assert.deepEqual((again.json as { added: unknown[] }).added, []);
    assert.equal((await callRoute(qsysRoutes, "/api/qsys/allowlist/add-panel", { method: "POST", body: { panelId: "gone" } })).status, 404);
    assert.equal((await callRoute(qsysRoutes, "/api/qsys/allowlist/add-panel", { method: "POST", body: { panelId: 7 } })).status, 400);
  });
});
