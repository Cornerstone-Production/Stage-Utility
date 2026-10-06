// A write that dies halfway must leave nothing at the final name.
//
// Four writers that carry the operator's work or its backup were moved from
// fs.writeFile (which truncates in place) to atomicWrite (a scratch file and a
// rename), and reverting any of them stayed green: nothing simulated the disk
// filling or the power going mid-write. The tear is made at the one seam, as
// image-files-atomic.test.ts does for the image writers: fs.writeFile writes
// three bytes of what it was given and throws.
//
//   config-snapshot.ts  save()   a named snapshot, a new file per save
//   config-snapshot.ts  apply()  a restore, over a live settings file
//   backup-scheduler.ts runNow() the scheduled config bundle
//   backup-scheduler.ts runNow() the scheduled archive zip
//
// A torn snapshot or zip under its final name reads as a backup and fails when
// it is needed; a torn restore is the operator's settings replaced by a fragment.

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";

const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), "atomic-writes-torn-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { configSnapshot, configFiles } = await import("./config-snapshot.js");
const { backupScheduler } = await import("./backup-scheduler.js");

after(() => fsp.rm(TMP, { recursive: true, force: true }));

/** Run `body` with fs.writeFile tearing for any path `which` accepts: it writes 3
 *  bytes of the data, then throws as a full disk does. */
async function tearing(which: (file: string) => boolean, body: () => Promise<void>): Promise<void> {
  const real = fsp.writeFile;
  fsp.writeFile = (async (file: Parameters<typeof real>[0], data: string | Uint8Array, ...rest: unknown[]) => {
    if (!which(String(file))) return (real as (...a: unknown[]) => Promise<void>)(file, data, ...rest);
    await real(file, Buffer.from(data).subarray(0, 3));
    throw new Error("ENOSPC: no space left on device");
  }) as unknown as typeof real;
  syncBuiltinESMExports();
  try {
    await body();
  } finally {
    fsp.writeFile = real;
    syncBuiltinESMExports();
  }
}

/** What is in `dir`, scratch files included. */
const ls = async (dir: string) => (await fsp.readdir(dir).catch(() => [])).sort();

describe("a write that tears partway", () => {
  afterEach(async () => {
    backupScheduler.stop();
    await fsp.rm(path.join(TMP, "backups"), { recursive: true, force: true });
    await fsp.rm(path.join(TMP, "snapshots"), { recursive: true, force: true });
  });

  it("configSnapshot.save leaves no snapshot file, torn or scratch", async () => {
    await tearing(() => true, async () => {
      await assert.rejects(configSnapshot.save("torn"), /ENOSPC/);
    });
    assert.deepEqual(await ls(path.join(TMP, "snapshots")), [], "a torn snapshot or its scratch was left where a restore would list it");
    assert.deepEqual(await configSnapshot.list(), []);
  });

  it("configSnapshot.apply leaves the live file as it was", async () => {
    const target = configFiles()[0];
    const live = JSON.stringify({ live: true });
    await fsp.writeFile(path.join(TMP, target), live);
    await tearing(
      (file) => file.includes(target),
      async () => {
        await assert.rejects(
          configSnapshot.apply({ kind: "stage-utility-config", version: 1, createdAt: "2026-07-26T00:00:00.000Z", files: { [target]: { restored: true } } }),
          /ENOSPC/,
        );
      },
    );
    assert.equal(await fsp.readFile(path.join(TMP, target), "utf8"), live, "the restore truncated the live file in place");
    assert.deepEqual((await ls(TMP)).filter((f) => f.endsWith(".tmp")), [], "scratch left behind");
  });

  it("the scheduled config bundle leaves no torn backup", async () => {
    await backupScheduler.setSchedule({ enabled: false, includeArchive: false });
    backupScheduler.stop();
    const dir = await backupScheduler.destinationDir();
    await tearing(
      (file) => path.basename(file).includes("config-") && file.includes(".json"),
      async () => {
        const result = await backupScheduler.runNow();
        assert.match(String(result.lastError), /ENOSPC/, "the failure must be reported on the schedule");
      },
    );
    assert.deepEqual(await ls(dir), [], "a torn config backup or its scratch was left");
  });

  it("the scheduled archive zip leaves no torn archive", async () => {
    await backupScheduler.setSchedule({ enabled: false, includeArchive: true });
    backupScheduler.stop();
    const dir = await backupScheduler.destinationDir();
    await tearing(
      (file) => file.includes(".zip"),
      async () => {
        const result = await backupScheduler.runNow();
        assert.match(String(result.lastError), /ENOSPC/, "the failure must be reported on the schedule");
      },
    );
    assert.deepEqual((await ls(dir)).filter((f) => f.includes(".zip")), [], "a torn archive or its scratch was left");
  });
});
