// slots.json v4: the boards half, and the writes that span boards.
//
// Driven through the real store in a temp data directory. Every id and name is
// invented.

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-slots-boards-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { slotsStore, normaliseSlotsFile, serialiseSlotsFile } = await import("./slots-store.js");
const { restoreCheckFor } = await import("./stores.js");
const { stripResolvedFields } = await import("./slot-resolver.js");

after(() => {
  fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

const slot = (id: string) => ({ id, channel: "01", order: 0, link: { kind: "empty" } }) as unknown as Slot;
const meta = (name: string) => ({ name, columnWidthIn: null, createdAt: "2026-10-29T00:00:00.000Z" });
let n = 0;
const fresh = () => `b-store-${++n}`;

describe("reading and writing v4", () => {
  it("keeps the boards half through a load and a save", () => {
    const raw = {
      version: 4,
      boards: { "b-1": { name: "Left", columnWidthIn: 3.49, createdAt: "2026-10-29T00:00:00.000Z" } },
      defaults: { "b-1": { st: [slot("a")] } },
      overrides: {},
    };
    const { file, migrated } = normaliseSlotsFile(structuredClone(raw));
    assert.equal(migrated, null);
    assert.deepEqual(serialiseSlotsFile(file), raw);
  });

  it("keeps a v3 file v3 until the boot migration writes it, so a save cannot stamp it v4 with no boards", () => {
    const { file } = normaliseSlotsFile({ version: 3, defaults: { "display-1": { st: [slot("a")] } }, overrides: {} });
    const out = serialiseSlotsFile(file);
    assert.equal(out.version, 3);
    assert.equal("boards" in out, false);
  });

  it("reads a board with a blank name or a bad width as well as it can, rather than dropping its layouts", () => {
    const { file } = normaliseSlotsFile({ version: 4, boards: { "b-1": { name: " ", columnWidthIn: -2 } }, defaults: { "b-1": { st: [slot("a")] } }, overrides: {} });
    assert.deepEqual(file.boards.get("b-1"), { name: "b-1", columnWidthIn: null, createdAt: "" });
    assert.equal(file.defaults.get("b-1")?.get("st")?.length, 1);
  });
});

describe("a restored slots.json", () => {
  const check = async (raw: unknown) => {
    const run = restoreCheckFor("slots.json");
    assert.ok(run, "slots.json has no restore check");
    return run(raw);
  };
  const v4 = (boards: Record<string, unknown>) => ({ version: 4, boards, defaults: {}, overrides: {} });

  it("is accepted with named boards, and as a v3 file from before boards", async () => {
    assert.equal((await check(v4({ "b-1": { name: "Left", columnWidthIn: 3.49, createdAt: "" }, "b-2": { name: "Right", columnWidthIn: null, createdAt: "" } }))).ok, true);
    assert.equal((await check({ version: 3, defaults: { "display-1": { st: [] } }, overrides: {} })).ok, true);
  });

  it("is refused with a board that has no name", async () => {
    const r = await check(v4({ "b-1": { name: "  ", columnWidthIn: null } }));
    assert.equal(r.ok, false);
    assert.match(String((r as { reason?: string }).reason), /slot board b-1 has no name/);
  });

  it("is refused with a column width that is not a positive number", async () => {
    for (const w of [0, -1, "3.49", Number.POSITIVE_INFINITY]) {
      const r = await check(v4({ "b-1": { name: "Left", columnWidthIn: w } }));
      assert.equal(r.ok, false, `accepted a width of ${String(w)}`);
    }
  });

  it("is refused with a board id that reaches the prototype", async () => {
    const r = await check(JSON.parse('{"version":4,"boards":{"__proto__":{"name":"x","columnWidthIn":null}},"defaults":{},"overrides":{}}'));
    assert.equal(r.ok, false);
  });

  it("is refused with an interrupted migration's merge naming a key that reaches the prototype", async () => {
    const ok = { ...v4({ "b-1": { name: "Left", columnWidthIn: null } }), pendingMerges: { "b-2": "b-1" } };
    assert.equal((await check(ok)).ok, true);
    const r = await check(JSON.parse('{"version":4,"boards":{},"defaults":{},"overrides":{},"pendingMerges":{"__proto__":"b-1"}}'));
    assert.equal(r.ok, false);
    assert.match(String((r as { reason?: string }).reason), /pending board merges/);
  });
});

describe("a restored views.json", () => {
  const check = async (raw: unknown) => {
    const run = restoreCheckFor("views.json");
    assert.ok(run, "views.json has no restore check");
    return run(raw);
  };
  const screen = (boardId: unknown) => [{ id: "v1", name: "Main", kind: "slots", createdAt: "", boardId }];

  it("is accepted with a screen pointing at a board, or at none", async () => {
    assert.equal((await check(screen("b-1"))).ok, true);
    assert.equal((await check(screen(null))).ok, true);
  });

  it("is refused with a board id that reaches the prototype, or is not text", async () => {
    const r = await check(screen("__proto__"));
    assert.equal(r.ok, false, "a board id that reaches the prototype was restored");
    assert.match(String((r as { reason?: string }).reason), /slot board id is not allowed/);
    assert.equal((await check(screen(5))).ok, false, "a board id that is a number was restored");
  });
});

describe("boards", () => {
  it("are created, renamed, given a width and deleted", async () => {
    const id = fresh();
    await slotsStore.createBoard(id, meta("Left"));
    assert.deepEqual((await slotsStore.updateBoard(id, { name: "Left wall", columnWidthIn: 3.49 }))?.name, "Left wall");
    assert.equal((await slotsStore.listBoards()).get(id)?.columnWidthIn, 3.49);
    assert.equal(await slotsStore.deleteBoard(id), true);
    assert.equal((await slotsStore.listBoards()).has(id), false);
    assert.equal(await slotsStore.deleteBoard(id), false, "a second delete reported a removal");
  });

  it("refuse an id already in use rather than overwrite a board", async () => {
    const id = fresh();
    await slotsStore.createBoard(id, meta("Left"));
    await slotsStore.setDefault(id, "st", [slot("keep")]);
    await assert.rejects(() => slotsStore.createBoard(id, meta("Other")), /already exists/);
    assert.equal((await slotsStore.getDefault(id, "st"))[0]?.id, "keep");
  });

  it("delete both halves with the board", async () => {
    const id = fresh();
    await slotsStore.createBoard(id, meta("Left"));
    await slotsStore.setDefault(id, "st", [slot("a")]);
    await slotsStore.setOverride(id, "p1", "st", [slot("b")]);
    await slotsStore.deleteBoard(id);
    assert.deepEqual(await slotsStore.getDefault(id, "st"), []);
    assert.equal(await slotsStore.getOverride(id, "p1"), null);
  });
});

describe("saving several boards", () => {
  it("lands every entry, each on its own target", async () => {
    const a = fresh();
    const b = fresh();
    await slotsStore.createBoard(a, meta("A"));
    await slotsStore.createBoard(b, meta("B"));
    await slotsStore.saveMany([
      { boardId: a, target: { kind: "default", serviceTypeId: "st" }, slots: [slot("a1")] },
      { boardId: b, target: { kind: "plan", planId: "p1", serviceTypeId: "st", sortDate: "2026-11-01" }, slots: [slot("b1")] },
    ]);
    assert.equal((await slotsStore.getDefault(a, "st"))[0]?.id, "a1");
    assert.deepEqual(await slotsStore.getOverride(b, "p1"), { serviceTypeId: "st", sortDate: "2026-11-01", slots: stripResolvedFields([slot("b1")]) });
  });

  it("writes nothing when one entry cannot be stored", async () => {
    const a = fresh();
    await slotsStore.createBoard(a, meta("A"));
    await slotsStore.setDefault(a, "st", [slot("before")]);
    await assert.rejects(
      () => slotsStore.saveMany([
        { boardId: a, target: { kind: "default", serviceTypeId: "st" }, slots: [slot("after")] },
        { boardId: a, target: { kind: "plan", planId: "constructor", serviceTypeId: "st" }, slots: [] },
      ]),
      /not an allowed identifier/,
    );
    assert.equal((await slotsStore.getDefault(a, "st"))[0]?.id, "before", "the first entry landed though the save was refused");
  });
});
