// What a restore does to this server's own id.
//
// Kiosks and Mac output helpers bind to a server by its serverId, so the id in
// settings.json decides which screens answer to this box. A restore writes
// settings.json back from the config, and the config's id is the id of the box
// it was saved on. Writing that verbatim onto a second box that also runs makes
// two servers answer discovery as one, and every screen bound to that id flips
// between them. Writing nothing, when the config carries no id, used to leave
// settings.json without one: the store has no default to fill it with, and the
// next start minted a new id, orphaning every screen bound to the old.
//
// Driven through apply() and the files on disk, the way a restore really lands.

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-restore-id-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { configSnapshot, takesConfigId } = await import("./config-snapshot.js");
const { livePoller } = await import("./live-poller.js");
const { stageController } = await import("./stage-controller.js");

const SETTINGS = path.join(TMP, "settings.json");
const DEVICES = path.join(TMP, "kiosk-devices.json");
const OWN = "3f2a9c1e-5b7d-4e21-9a0c-6d8e2f41b7a3";
const OTHER = "7c1e04ab-92f3-4d6a-b1e8-0f5c3a9d2e64";
const KEEP = { replacesOriginal: false };
const REPLACE = { replacesOriginal: true };

function snapshotOf(files: Record<string, unknown>) {
  return { kind: "stage-utility-config", version: 1, createdAt: "2026-11-11T00:00:00.000Z", files };
}

/** apply() pauses the poller and the controller's timers and, on success, leaves
 *  them paused because the process is about to exit. A test process is not. */
function quiet() {
  const poller = livePoller as unknown as { running: boolean; timer: ReturnType<typeof setTimeout> | null };
  poller.running = false;
  if (poller.timer) clearTimeout(poller.timer);
  poller.timer = null;
  const c = stageController as unknown as Record<string, ReturnType<typeof setInterval> | null>;
  for (const k of ["autoRefreshTimer", "updateCheckTimer"]) {
    if (c[k]) clearInterval(c[k]!);
    c[k] = null;
  }
}

async function writtenServerId(): Promise<unknown> {
  return (JSON.parse(await fs.readFile(SETTINGS, "utf8")) as { serverId?: unknown }).serverId;
}

describe("a restore of a config with no server id", () => {
  afterEach(async () => {
    quiet();
    await fs.rm(SETTINGS, { force: true });
  });

  it("KEEPS THIS SERVER'S ID when the config has no serverId key", async () => {
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live", serverId: OWN }), "utf8");
    await configSnapshot.apply(snapshotOf({ "settings.json": { appName: "Restored" } }));
    assert.equal(
      await writtenServerId(),
      OWN,
      "the restore dropped this server's id: the next start mints a new one and every screen bound here is orphaned",
    );
  });

  it("keeps this server's id when the config's serverId is null", async () => {
    // A config saved on a box that never switched discovery on.
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live", serverId: OWN }), "utf8");
    await configSnapshot.apply(snapshotOf({ "settings.json": { appName: "Restored", serverId: null } }));
    assert.equal(await writtenServerId(), OWN);
  });

  it("still restores the rest of settings.json", async () => {
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live", serverId: OWN }), "utf8");
    await configSnapshot.apply(snapshotOf({ "settings.json": { appName: "Restored" } }));
    assert.equal((JSON.parse(await fs.readFile(SETTINGS, "utf8")) as { appName: string }).appName, "Restored");
  });

  it("writes no id onto a box that has none", async () => {
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live" }), "utf8");
    await configSnapshot.apply(snapshotOf({ "settings.json": { appName: "Restored" } }));
    assert.equal(await writtenServerId() ?? null, null);
  });
});

describe("takesConfigId: whose id (and bindings) a restore keeps", () => {
  // [config's id, this server's id, replaces the original?] -> takes the config's
  const CASES: [string | null, string | null, boolean, boolean][] = [
    [OTHER, OWN, false, false],
    [OTHER, OWN, true, true],
    [OWN, OWN, false, true],
    [OWN, OWN, true, true],
    [null, OWN, false, false],
    [null, OWN, true, false],
    [OTHER, null, false, false],
    [OTHER, null, true, true],
    [null, null, true, false],
  ];
  for (const [config, own, replaces, want] of CASES) {
    it(`config ${config?.slice(0, 4) ?? "none"}, own ${own?.slice(0, 4) ?? "none"}, ${replaces ? "replacing" : "not replacing"} -> ${want ? "take" : "keep"}`, () => {
      assert.equal(takesConfigId(config, own, replaces), want);
    });
  }
});

describe("a restore of a config saved on another server", () => {
  const ownDevices = [{ id: "dev-own", token: "", outputId: "1", label: "Here", macs: [] }];
  const theirDevices = [{ id: "dev-theirs", token: "", outputId: "1", label: "There", macs: [] }];

  async function restore(opts: { replacesOriginal: boolean }) {
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live", serverId: OWN }), "utf8");
    await fs.writeFile(DEVICES, JSON.stringify(ownDevices), "utf8");
    await configSnapshot.apply(
      snapshotOf({ "settings.json": { appName: "Restored", serverId: OTHER }, "kiosk-devices.json": theirDevices }),
      opts,
    );
  }

  afterEach(async () => {
    quiet();
    await fs.rm(SETTINGS, { force: true });
    await fs.rm(DEVICES, { force: true });
  });

  it("KEEPS THIS SERVER'S ID unless told it replaces the original", async () => {
    await restore(KEEP);
    assert.equal(
      await writtenServerId(),
      OWN,
      "the restore took the other server's id: both now answer discovery as one, and its screens flip between them",
    );
  });

  it("keeps this server's id when no option is given at all", async () => {
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live", serverId: OWN }), "utf8");
    await configSnapshot.apply(snapshotOf({ "settings.json": { appName: "Restored", serverId: OTHER } }));
    assert.equal(await writtenServerId(), OWN);
  });

  it("takes the config's id when told it replaces the original", async () => {
    await restore(REPLACE);
    assert.equal(await writtenServerId(), OTHER);
  });

  it("writes the config's screen bindings when it replaces the original", async () => {
    await restore(REPLACE);
    assert.deepEqual((JSON.parse(await fs.readFile(DEVICES, "utf8")) as { id: string }[]).map((d) => d.id), ["dev-theirs"]);
  });

  it("writes no id when this server's settings.json cannot be read and it is not replacing", async () => {
    await fs.writeFile(SETTINGS, "{ not json", "utf8");
    await configSnapshot.apply(snapshotOf({ "settings.json": { appName: "Restored", serverId: OTHER } }), KEEP);
    assert.equal(await writtenServerId() ?? null, null, "an unreadable own id must not become the other server's");
  });

  it("recall passes the choice through, and a saved snapshot lists its server id", async () => {
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Saved", serverId: OTHER }), "utf8");
    const meta = await configSnapshot.save("from the other box");
    assert.equal(meta.serverId, OTHER);
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live", serverId: OWN }), "utf8");
    await configSnapshot.recall(meta.id, KEEP);
    assert.equal(await writtenServerId(), OWN);
    quiet();
    await configSnapshot.recall(meta.id, REPLACE);
    assert.equal(await writtenServerId(), OTHER);
    await configSnapshot.delete(meta.id);
  });
});

describe("screen bindings on a restore", () => {
  // Screen ids are counters (display-N) and collide across servers. A binding is
  // a device pointed at a screen id on THIS server; once the config's screens
  // replace this server's, that id is somebody else's screen.
  const lobbyPi = [{ id: "pi-lobby", token: "", outputId: "display-2", label: "Lobby Pi", macs: [] }];
  const theirPi = [{ id: "pi-theirs", token: "", outputId: "display-2", label: "Their Pi", macs: [] }];
  const ourScreens = [{ id: "display-2", name: "Lobby TV", viewId: null }];
  const theirScreens = [{ id: "display-2", name: "Left Mic Display", viewId: null }];
  const logged: string[] = [];
  const realLog = console.log;

  async function live(devices: unknown[]) {
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live", serverId: OWN, outputs: ourScreens }), "utf8");
    await fs.writeFile(DEVICES, JSON.stringify(devices), "utf8");
  }
  const bindings = async () => (JSON.parse(await fs.readFile(DEVICES, "utf8")) as { id: string }[]).map((d) => d.id);

  afterEach(async () => {
    console.log = realLog;
    logged.length = 0;
    quiet();
    await fs.rm(SETTINGS, { force: true });
    await fs.rm(DEVICES, { force: true });
  });

  it("KEEPING THIS SERVER'S ID RELEASES ITS BINDINGS: the Lobby Pi does not end up on the config's display-2", async () => {
    await live(lobbyPi);
    console.log = (...a: unknown[]) => logged.push(a.join(" "));
    await configSnapshot.apply(
      snapshotOf({ "settings.json": { appName: "Restored", serverId: OTHER, outputs: theirScreens }, "kiosk-devices.json": theirPi }),
      KEEP,
    );
    assert.deepEqual(await bindings(), [], "the Lobby Pi is still bound to display-2, which is now the config's Left Mic Display");
    assert.ok(
      logged.some((l) => l.includes("[config-snapshot] restore: released pi-lobby") && l.includes("display-2")),
      `no [config-snapshot] line named the released device: ${JSON.stringify(logged)}`,
    );
  });

  it("A CONFIG WITH NO SERVER ID never writes its bindings, and releases this server's", async () => {
    await live(lobbyPi);
    await configSnapshot.apply(
      snapshotOf({ "settings.json": { appName: "Restored", outputs: theirScreens }, "kiosk-devices.json": theirPi }),
      REPLACE,
    );
    assert.equal(await writtenServerId(), OWN);
    assert.deepEqual(await bindings(), [], "bindings from a config that names no server were written beside this server's id");
  });

  it("A BUNDLE WITH NO settings.json never writes its bindings, and leaves this server's alone", async () => {
    // Its screens are not restored, so this server's screens and their bindings
    // still match; the bundle's bindings are to a server it does not name.
    await live(lobbyPi);
    await configSnapshot.apply(snapshotOf({ "kiosk-devices.json": theirPi }), REPLACE);
    assert.deepEqual(await bindings(), ["pi-lobby"]);
  });

  it("TAKING ANOTHER SERVER'S ID WITH NO BINDINGS IN THE CONFIG releases this server's", async () => {
    // The server the config came from never set up a device, so the bundle has no
    // kiosk-devices.json. Its screens still replace this server's, and the Lobby
    // Pi would otherwise land on the config's display-2.
    await live(lobbyPi);
    console.log = (...a: unknown[]) => logged.push(a.join(" "));
    await configSnapshot.apply(
      snapshotOf({ "settings.json": { appName: "Restored", serverId: OTHER, outputs: theirScreens } }),
      REPLACE,
    );
    assert.equal(await writtenServerId(), OTHER);
    assert.deepEqual(await bindings(), [], "the Lobby Pi is still bound to display-2, which is now the config's Left Mic Display");
    assert.ok(logged.some((l) => l.includes("[config-snapshot] restore: released pi-lobby")), JSON.stringify(logged));
  });

  it("this server's own config with no bindings in it leaves this server's alone", async () => {
    // Same id, same screens: the bindings still name the right ones.
    await live(lobbyPi);
    await configSnapshot.apply(snapshotOf({ "settings.json": { appName: "Restored", serverId: OWN, outputs: ourScreens } }), KEEP);
    assert.deepEqual(await bindings(), ["pi-lobby"]);
  });

  it("taking the config's id takes its bindings", async () => {
    await live(lobbyPi);
    await configSnapshot.apply(
      snapshotOf({ "settings.json": { appName: "Restored", serverId: OTHER, outputs: theirScreens }, "kiosk-devices.json": theirPi }),
      REPLACE,
    );
    assert.deepEqual(await bindings(), ["pi-theirs"]);
  });

  it("this server's own config restores its own bindings", async () => {
    await live([]);
    await configSnapshot.apply(
      snapshotOf({ "settings.json": { appName: "Restored", serverId: OWN, outputs: ourScreens }, "kiosk-devices.json": lobbyPi }),
      KEEP,
    );
    assert.deepEqual(await bindings(), ["pi-lobby"]);
  });
});

// A published venue's secret link follows the same decision. Two servers publishing one
// secret would overwrite each other's plots under one link, and the second could take
// down the first's. Keeping this server's id drops every secret: the venues come back
// unpublished. Taking the config's id (this box replaces that one) keeps them.
describe("stage plot links on a restore", () => {
  const STAGEPLOTS = path.join(TMP, "stageplots.json");
  const SECRET = "A".repeat(42) + "E";
  const published = {
    venues: [
      {
        id: "v-1",
        name: "Main room",
        kind: "home",
        notes: "",
        plotIds: [],
        defaultPlotId: null,
        publish: {
          secret: SECRET,
          origin: "https://servicecue.example.workers.dev",
          publishedAt: "2026-11-12T14:32:00.000Z",
          lastError: null,
          publishedImages: [],
          unpublishedImages: [],
        },
      },
    ],
    backgrounds: [],
    plots: [],
    overrides: [],
  };
  const restoredPublish = async () => (JSON.parse(await fs.readFile(STAGEPLOTS, "utf8")) as typeof published).venues[0]!.publish;
  const logged: string[] = [];
  const originalLog = console.log;

  afterEach(async () => {
    console.log = originalLog;
    logged.length = 0;
    quiet();
    await fs.rm(SETTINGS, { force: true });
    await fs.rm(STAGEPLOTS, { force: true });
  });

  it("KEEPING THIS SERVER'S ID brings the venues back unpublished, and says so", async () => {
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live", serverId: OWN }), "utf8");
    console.log = (...a: unknown[]) => logged.push(a.join(" "));
    await configSnapshot.apply(snapshotOf({ "settings.json": { appName: "Restored", serverId: OTHER }, "stageplots.json": published }), KEEP);
    assert.equal(await restoredPublish(), undefined, "a second server came back publishing the first one's link");
    assert.ok(logged.some((l) => l.includes("[config-snapshot] restore: 1 stage plots venue comes back unpublished")), JSON.stringify(logged));
    assert.equal(logged.some((l) => l.includes(SECRET)), false, "the restore logged a secret");
  });

  it("TAKING THE CONFIG'S ID keeps the links: this box replaces the one that published them", async () => {
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live", serverId: OWN }), "utf8");
    await configSnapshot.apply(snapshotOf({ "settings.json": { appName: "Restored", serverId: OTHER }, "stageplots.json": published }), REPLACE);
    assert.equal((await restoredPublish())?.secret, SECRET);
  });

  it("this server's own config keeps its own links", async () => {
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live", serverId: OWN }), "utf8");
    await configSnapshot.apply(snapshotOf({ "settings.json": { appName: "Restored", serverId: OWN }, "stageplots.json": published }), KEEP);
    assert.equal((await restoredPublish())?.secret, SECRET);
  });

  it("a config with no settings.json says nothing about whose links they are, so they are dropped", async () => {
    await fs.writeFile(SETTINGS, JSON.stringify({ appName: "Live", serverId: OWN }), "utf8");
    await configSnapshot.apply(snapshotOf({ "stageplots.json": published }), REPLACE);
    assert.equal(await restoredPublish(), undefined);
  });
});
