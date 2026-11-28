// The writer's views read, against the REAL views store (not a stand-in).
//
// The store does not throw when its file cannot be read: load() serves the
// defaults (no views) and only loadStrict() throws. A momentary's lease and a
// selector's choices are decided from the views, so a writer reading them with
// load() would take an unreadable file for "no panel has a momentary" and press a
// talkback on with nothing to let it go. Its own file, because the store caches
// its first good read for the life of the process.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, mock, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-qsys-write-views-"));
process.env.STAGE_UTILITY_DATA = TMP;
// A directory where the file should be: every read fails, as a permissions fault does.
await fs.mkdir(path.join(TMP, "views.json"));

const { FakeQrcServer } = await import("./fake-qrc-server.js");
const { QsysService } = await import("./qsys-service.js");
const { QsysWatch } = await import("./qsys-watch.js");
const { QsysWriter } = await import("./qsys-write.js");
const { qsysAllowlist } = await import("./qsys-allowlist-store.js");
const { qsysWriteLog } = await import("./qsys-write-log.js");

const MUTE = { component: "Lobby_Mixer", control: "output.1.mute" };
const fake = new FakeQrcServer();
fake.components.set("Lobby_Mixer", [{ Name: "output.1.mute", Type: "Boolean", Value: false, String: "false", Position: 0, Direction: "Read/Write" }]);
const svc = new QsysService();
const watch = new QsysWatch(svc, () => {});
const writer = new QsysWriter(svc, watch);

before(async () => {
  const port = await fake.start();
  await qsysAllowlist.replace([{ ...MUTE, label: "Talk", min: null, max: null, confirm: "none" }]);
  svc.configure({ host: "127.0.0.1", port, user: "", enabled: true, volunteerMeterHz: 10, staffMeterHz: 20 }, null);
  for (let i = 0; i < 200000 && !svc.transport; i++) await new Promise((r) => setImmediate(r));
  await watch.recompute();
});
after(async () => {
  writer.dispose();
  svc.stop();
  await fake.stop();
  await qsysWriteLog.whenIdle();
  await fs.rm(TMP, { recursive: true, force: true });
});

const press = () => writer.write({ ...MUTE, value: true, lease: true, cid: "page-1", panelId: "panel-m", device: "192.0.2.10 T/1", remote: "192.0.2.10" });
const sets = () => fake.received.filter((r) => r.method === "Component.Set").length;

describe("the writer reads the saved views strictly", () => {
  test("an unreadable views file refuses a momentary press (no-lease) and sends nothing; readable again, the press goes with its lease", async () => {
    const quiet = [mock.method(console, "warn", () => {}), mock.method(console, "error", () => {}), mock.method(console, "log", () => {})];
    try {
      const r = await press();
      assert.equal(r.ok ? null : r.reason, "no-lease", `an unreadable views file read as ${JSON.stringify(r)}`);
      // Refused because the views could not be read, not because they read as empty.
      assert.match(r.ok ? "" : r.message, /could not read the saved views/, "an unreadable views file was taken for a panel with no momentary on it");
      assert.equal(sets(), 0, "a momentary was pressed on with nothing able to release it");

      // Positive control: the same press once the file reads, holding a momentary on the mute.
      await fs.rm(path.join(TMP, "views.json"), { recursive: true });
      await fs.writeFile(
        path.join(TMP, "views.json"),
        JSON.stringify([{ id: "panel-m", name: "M", kind: "custom", layout: { version: 1, canvas: {}, objects: [{ id: "b", config: { type: "qsys-button", binding: MUTE, label: "Talk", hold: false, press: "momentary" } }] } }]),
      );
      const ok = await press();
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.equal(writer.leases.has(MUTE), true);
    } finally {
      writer.leases.clear();
      for (const m of quiet) m.mock.restore();
    }
  });
});
