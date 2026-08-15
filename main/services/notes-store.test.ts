import assert from "node:assert/strict";
import { describe, it, beforeEach, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-notes-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { notesStore } = await import("./notes-store.js");
const { configFiles, runtimeFiles } = await import("./config-snapshot.js");

// Notes and checklists hold the OPERATOR'S OWN WORK — the pre-service checklist
// someone built over a season, the note left for the next volunteer. That makes
// them config, not runtime, and being config is what puts them in every backup.
//
// The failure this guards is quiet: classified wrongly, they would vanish on a
// reinstall and nothing would say so until someone went looking for a checklist
// that used to be there.

describe("notes store classification", () => {
  it("is carried by config snapshots", async () => {
    await notesStore.init();
    assert.ok(
      configFiles().includes("notes.json"),
      "notes.json must be in the config allowlist, or it is silently absent from every backup",
    );
  });

  it("is NOT classified as runtime", async () => {
    // The other half. A store can only be in one, and the wrong one loses it.
    await notesStore.init();
    assert.ok(!runtimeFiles().includes("notes.json"));
  });
});

describe("notes content", () => {
  beforeEach(async () => {
    await fs.rm(path.join(TMP, "notes.json"), { force: true });
    await notesStore.init();
  });

  it("survives a reload", async () => {
    // The whole point. An in-memory-only note would read as saved right up until
    // the next restart.
    await notesStore.set("obj-1", { text: "sound check at 8" });
    await notesStore.init(); // re-read from disk
    assert.equal(notesStore.get("obj-1").text, "sound check at 8");
  });

  it("keys by object, so two objects do not share content", async () => {
    await notesStore.set("obj-1", { text: "one" });
    await notesStore.set("obj-2", { text: "two" });
    assert.equal(notesStore.get("obj-1").text, "one");
    assert.equal(notesStore.get("obj-2").text, "two");
  });

  it("returns empty content for an object that has none", async () => {
    // Never undefined: the renderer would have to guard every read otherwise.
    assert.deepEqual(notesStore.get("never-written"), {});
  });

  it("stores checklist ticks", async () => {
    await notesStore.set("cl", { items: [{ id: "a", text: "Mics on", done: true }] });
    await notesStore.init();
    assert.equal(notesStore.get("cl").items?.[0].done, true);
  });

  it("forgets content for deleted objects without touching the rest", async () => {
    await notesStore.set("keep", { text: "keep me" });
    await notesStore.set("drop", { text: "delete me" });
    await notesStore.forget(["drop"]);
    await notesStore.init();
    assert.equal(notesStore.get("keep").text, "keep me");
    assert.deepEqual(notesStore.get("drop"), {});
  });

  it("forgetting something absent does not rewrite the file", async () => {
    await notesStore.set("keep", { text: "keep me" });
    const before = await fs.stat(path.join(TMP, "notes.json"));
    await notesStore.forget(["never-existed"]);
    const after = await fs.stat(path.join(TMP, "notes.json"));
    assert.equal(before.mtimeMs, after.mtimeMs, "a no-op must not write");
  });
});

after(() => fs.rm(TMP, { recursive: true, force: true }));
