// Merging two recordings has to move the raw rows, or it undoes itself.
//
// The archive is the source of truth, not a copy: forget(targetKey) — which the
// merge calls so the recorder cannot write its stale copy back — is precisely
// what makes the next SPL resume rebuild the record from the raw CSVs. That
// rebuild read the target's own directory, which had never heard of the items
// merged in from the source, so the operator watched the merge succeed and the
// next restart silently put it back.
//
// Two fixes landing on separate branches, each correct alone: the merge learned
// to forget() (#216) and SPL learned to rebuild on resume (#219). Nothing
// exercised the pair until they were both on beta.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-arcmerge-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { sampleArchive } = await import("./sample-archive.js");
const { serviceDirPath } = await import("./archive-paths.js");
const { rebuildSplItems } = await import("./rebuild.js");
const { readArchiveRows } = await import("./archive-rows.js");

const DATE = "2026-07-26";
const SRC = { serviceKey: "st1:plan:9am", serviceDate: DATE };
const TGT = { serviceKey: "st1:plan:11am", serviceDate: DATE };

/** Write a spl.csv by hand — the appender's own path is covered elsewhere, and
 *  fixing the bytes makes the assertions about what survived unambiguous. */
async function writeSpl(ctx: { serviceKey: string; serviceDate: string }, header: string, rows: string[]) {
  const dir = serviceDirPath(ctx.serviceKey, ctx.serviceDate);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "spl.csv"), [header, ...rows].join("\n") + "\n", "utf8");
}

describe("sampleArchive.mergeInto", () => {
  beforeEach(async () => {
    for (const c of [SRC, TGT]) {
      await fs.rm(serviceDirPath(c.serviceKey, c.serviceDate), { recursive: true, force: true });
    }
  });

  it("a rebuild after the merge still holds the source's items", async () => {
    // THE bug. Without the row move, rebuilding the target discards item-a
    // entirely — the merge is gone and nothing reported a failure.
    await writeSpl(TGT, "at,itemId,item,dbA", [
      "2026-07-26T11:10:00.000Z,item-b,Sermon,88",
      "2026-07-26T11:11:00.000Z,item-b,Sermon,90",
    ]);
    await writeSpl(SRC, "at,itemId,item,dbA", [
      "2026-07-26T11:00:00.000Z,item-a,Worship,95",
      "2026-07-26T11:01:00.000Z,item-a,Worship,97",
    ]);

    await sampleArchive.mergeInto(SRC, TGT);

    const items = await rebuildSplItems(TGT.serviceKey, TGT.serviceDate);
    assert.ok(items, "target should still rebuild");
    const ids = items.map((i) => i.itemId).sort();
    assert.deepEqual(ids, ["item-a", "item-b"], "the merged-in item must survive the rebuild");
    const a = items.find((i) => i.itemId === "item-a")!;
    assert.equal(a.metrics.dbA?.max, 97, "the source's samples came with it");
    assert.equal(a.metrics.dbA?.count, 2);
  });

  it("orders the merged rows by time, so an earlier fragment does not land last", async () => {
    // The merge panel offers every same-day recording, so the source is as often
    // the leading fragment as the trailing tail. rebuild takes each item's LAST
    // row as its end, so appending an earlier fragment onto the end would date
    // the whole service to the wrong moment.
    await writeSpl(TGT, "at,itemId,item,dbA", ["2026-07-26T11:30:00.000Z,item-b,Sermon,88"]);
    await writeSpl(SRC, "at,itemId,item,dbA", ["2026-07-26T11:00:00.000Z,item-a,Worship,95"]);

    await sampleArchive.mergeInto(SRC, TGT);

    const rows = await readArchiveRows(serviceDirPath(TGT.serviceKey, TGT.serviceDate), "spl");
    assert.deepEqual(
      rows?.map((r) => r.at),
      ["2026-07-26T11:00:00.000Z", "2026-07-26T11:30:00.000Z"],
      "rows must come out chronological regardless of which side they came from",
    );
  });

  it("widens to the union when the two recordings carry different metrics", async () => {
    // A meter reporting a metric in one service and not the other must not leave
    // a ragged file: every row is rewritten against the union header, so the
    // cells that were never measured are empty rather than misaligned.
    await writeSpl(TGT, "at,itemId,item,dbA", ["2026-07-26T11:30:00.000Z,item-b,Sermon,88"]);
    await writeSpl(SRC, "at,itemId,item,dbC", ["2026-07-26T11:00:00.000Z,item-a,Worship,95"]);

    await sampleArchive.mergeInto(SRC, TGT);

    const rows = await readArchiveRows(serviceDirPath(TGT.serviceKey, TGT.serviceDate), "spl");
    assert.equal(rows?.length, 2);
    const [first, second] = rows!;
    assert.equal(first.dbC, "95", "the source's own metric survived");
    assert.equal(first.dbA, "", "and the column it never measured is empty, not shifted");
    assert.equal(second.dbA, "88");
    assert.equal(second.dbC, "");

    // And the rebuild reads it back as two separate metrics, not one smeared one.
    const items = await rebuildSplItems(TGT.serviceKey, TGT.serviceDate);
    assert.equal(items?.find((i) => i.itemId === "item-a")!.metrics.dbC?.max, 95);
    assert.equal(items?.find((i) => i.itemId === "item-b")!.metrics.dbA?.max, 88);
  });

  it("removes the source directory and restates the target's manifest", async () => {
    await writeSpl(TGT, "at,itemId,item,dbA", ["2026-07-26T11:30:00.000Z,item-b,Sermon,88"]);
    await writeSpl(SRC, "at,itemId,item,dbA", ["2026-07-26T11:00:00.000Z,item-a,Worship,95"]);

    await sampleArchive.mergeInto(SRC, TGT);

    await assert.rejects(
      () => fs.stat(serviceDirPath(SRC.serviceKey, SRC.serviceDate)),
      "the source archive must not outlive the record it belonged to",
    );
    const manifest = JSON.parse(
      await fs.readFile(path.join(serviceDirPath(TGT.serviceKey, TGT.serviceDate), "manifest.json"), "utf8"),
    );
    assert.deepEqual(manifest.files, ["spl.csv"]);
    assert.equal(manifest.serviceKey, TGT.serviceKey);
  });

  it("does nothing when the source never recorded anything", async () => {
    await writeSpl(TGT, "at,itemId,item,dbA", ["2026-07-26T11:30:00.000Z,item-b,Sermon,88"]);
    const moved = await sampleArchive.mergeInto(SRC, TGT);
    assert.deepEqual(moved, {}, "nothing to move");
    const rows = await readArchiveRows(serviceDirPath(TGT.serviceKey, TGT.serviceDate), "spl");
    assert.equal(rows?.length, 1, "the target is untouched");
  });

  it("drops the target's rolled files, so their rows are not read back twice", async () => {
    // The union rewrite puts every row in `spl.csv`. A leftover `spl.2.csv` would
    // be walked by the reader on top of it and each of its rows counted again.
    const dir = serviceDirPath(TGT.serviceKey, TGT.serviceDate);
    await writeSpl(TGT, "at,itemId,item,dbA", ["2026-07-26T11:30:00.000Z,item-b,Sermon,88"]);
    await fs.writeFile(
      path.join(dir, "spl.2.csv"),
      "at,itemId,item,dbC\n2026-07-26T11:31:00.000Z,item-b,Sermon,70\n",
      "utf8",
    );
    await writeSpl(SRC, "at,itemId,item,dbA", ["2026-07-26T11:00:00.000Z,item-a,Worship,95"]);

    await sampleArchive.mergeInto(SRC, TGT);

    const names = await fs.readdir(dir);
    assert.ok(!names.includes("spl.2.csv"), "the rolled file must be gone, not left to double-count");
    const rows = await readArchiveRows(dir, "spl");
    assert.equal(rows?.length, 3, "all three rows, once each");
  });
});
