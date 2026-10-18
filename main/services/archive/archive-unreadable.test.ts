// A raw file that is there and cannot be read is not a file that is absent.
//
// readArchiveRows took every read error for "no such file": a rolled file it
// could not read ended the walk, and the rows after it vanished from every
// reader. A history merge then wrote the rows it could read into the target
// and removed the source directory, unread rows with it, and replaced a target
// file it could not read with the source's rows alone.
//
// A directory where the file should be is the unreadable case here (EISDIR,
// and ENOTDIR for a directory listing), so the tests do not depend on running
// as a user that file permissions apply to.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-arcunread-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { readArchiveRows, rolledFiles } = await import("./archive-rows.js");
const { sampleArchive } = await import("./sample-archive.js");
const { serviceDirPath } = await import("./archive-paths.js");
const { StoreReadError } = await import("../data-store.js");

const DATE = "2026-10-18";

async function dirWith(files: Record<string, string | null>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(TMP, "svc-"));
  for (const [name, body] of Object.entries(files)) {
    if (body === null) await fs.mkdir(path.join(dir, name));
    else await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}

describe("readArchiveRows", () => {
  it("throws for an unreadable rolled file rather than ending the walk at it", async () => {
    const dir = await dirWith({
      "spl.csv": "at,a\n2026-10-18T14:00:00Z,1\n",
      "spl.2.csv": null,
      "spl.3.csv": "at,a,b,c\n2026-10-18T14:20:00Z,3,3,3\n",
    });
    await assert.rejects(readArchiveRows(dir, "spl"), (err: unknown) => {
      assert.ok(err instanceof StoreReadError, `not a StoreReadError: ${String(err)}`);
      assert.equal(err.code, "EISDIR");
      assert.match(err.message, /^spl\.2\.csv in archive folder svc-\S+ could not be read \(EISDIR\)$/);
      return true;
    });
  });

  it("throws for an unreadable first file rather than skipping to the roll", async () => {
    const dir = await dirWith({ "spl.csv": null, "spl.2.csv": "at,a\n2026-10-18T14:10:00Z,2\n" });
    await assert.rejects(readArchiveRows(dir, "spl"), StoreReadError);
  });

  it("still answers null for a source that was never recorded, and reads past a missing first file", async () => {
    const dir = await dirWith({ "spl.2.csv": "at,a\n2026-10-18T14:10:00Z,2\n" });
    assert.equal(await readArchiveRows(dir, "baptism"), null);
    assert.deepEqual(await readArchiveRows(dir, "spl"), [{ at: "2026-10-18T14:10:00Z", a: "2" }]);
  });
});

describe("rolledFiles", () => {
  it("throws when the service folder is there and cannot be listed", async () => {
    const file = path.join(TMP, "not-a-folder");
    await fs.writeFile(file, "x");
    await assert.rejects(rolledFiles(file, "spl"), StoreReadError);
  });

  it("answers none for a folder that does not exist", async () => {
    assert.deepEqual(await rolledFiles(path.join(TMP, "never"), "spl"), []);
  });
});

describe("sampleArchive.mergeInto with a file it cannot read", () => {
  async function seed(n: number) {
    const src = { serviceKey: `st1:p1:src${n}`, serviceDate: DATE };
    const tgt = { serviceKey: `st1:p1:tgt${n}`, serviceDate: DATE };
    const sd = serviceDirPath(src.serviceKey, DATE);
    const td = serviceDirPath(tgt.serviceKey, DATE);
    await fs.mkdir(sd, { recursive: true });
    await fs.mkdir(td, { recursive: true });
    await fs.writeFile(path.join(sd, "spl.csv"), "at,a\n2026-10-18T14:00:00Z,1\n");
    await fs.writeFile(path.join(sd, "attendance.csv"), "at,n\n2026-10-18T14:00:00Z,300\n");
    await fs.writeFile(path.join(td, "spl.csv"), "at,a\n2026-10-18T15:00:00Z,9\n");
    return { src, tgt, sd, td };
  }

  async function snapshot(dir: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const name of await fs.readdir(dir)) {
      const st = await fs.stat(path.join(dir, name));
      out[name] = st.isDirectory() ? "<dir>" : await fs.readFile(path.join(dir, name), "utf8");
    }
    return out;
  }

  it("refuses with nothing changed when a SOURCE file cannot be read", async () => {
    const { src, tgt, sd, td } = await seed(1);
    await fs.mkdir(path.join(sd, "spl.2.csv"));
    const before = { src: await snapshot(sd), tgt: await snapshot(td) };
    await assert.rejects(sampleArchive.mergeInto(src, tgt), StoreReadError);
    assert.deepEqual(await snapshot(sd), before.src, "the source archive was changed or removed");
    assert.deepEqual(await snapshot(td), before.tgt, "the target archive was rewritten");
  });

  it("refuses with nothing changed when a TARGET file cannot be read, even after a source that could merge", async () => {
    // spl merges cleanly; attendance's target is unreadable. Merged source by
    // source, spl was already rewritten when attendance failed.
    const { src, tgt, sd, td } = await seed(2);
    await fs.mkdir(path.join(td, "attendance.csv"));
    const before = { src: await snapshot(sd), tgt: await snapshot(td) };
    await assert.rejects(sampleArchive.mergeInto(src, tgt), StoreReadError);
    assert.deepEqual(await snapshot(sd), before.src, "the source archive was changed or removed");
    assert.deepEqual(await snapshot(td), before.tgt, "the target archive was rewritten");
  });

  it("still merges when every file reads", async () => {
    const { src, tgt, sd, td } = await seed(3);
    assert.deepEqual(await sampleArchive.mergeInto(src, tgt), { spl: 1, attendance: 1 });
    await assert.rejects(fs.stat(sd), { code: "ENOENT" });
    assert.equal(
      await fs.readFile(path.join(td, "spl.csv"), "utf8"),
      "at,a\n2026-10-18T14:00:00Z,1\n2026-10-18T15:00:00Z,9\n",
    );
  });
});
