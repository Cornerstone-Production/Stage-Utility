// Defaults vs per-plan overrides in slots.json.
//
// Everything here runs the REAL store against a real temp data dir — no source
// scanning, no stubbed file layer. What is under test is the shape on disk and
// the one resolution rule every screen reads through, and both have to be
// observed through load/save to be worth anything.
//
// The migration cases matter most: they run once per install against config
// written by an older version, and landing a v2 board in `overrides` instead of
// `defaults` would silently blank every wall the first time the plan advanced.

import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-slots-targets-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { slotsStore, normaliseSlotsFile, serialiseSlotsFile } = await import("./slots-store.js");

after(() => {
  fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

/** A slot with a v3 link, so the link migration is not what a test observes. */
function slot(id: string, channel: string): Slot {
  return {
    id,
    channel,
    order: 0,
    link: { kind: "pco", matchBy: "position", positions: [{ name: "Vocals" }] },
    deviceBinding: null,
    displayName: null,
    photoUrl: null,
    device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null },
  } as unknown as Slot;
}

/**
 * A key nothing else in this file uses.
 *
 * The store caches the parsed file after its first read, so a test that resets
 * `slots.json` behind it would assert against whatever the previous test left in
 * memory. Isolation comes from unique KEYS instead — which is also how the real
 * thing is isolated, one view id per board.
 */
let keyN = 0;
function freshKey(): string {
  return `v-${++keyN}`;
}

async function readSlotsFile(): Promise<{ overrides: Record<string, Record<string, unknown>> }> {
  return JSON.parse(await fs.readFile(path.join(TMP, "slots.json"), "utf-8"));
}

describe("slots.json v3: normalising what is on disk", () => {
  it("a v2 board becomes a DEFAULT, byte for byte, with no overrides", () => {
    const rows = [slot("s1", "01"), slot("s2", "02")];
    const { file, migrated } = normaliseSlotsFile({ "display-1": { st9: rows } });

    // Asserted through serialiseSlotsFile: the file is nested Maps in memory,
    // and what has to be right is the record envelope that reaches disk.
    const disk = serialiseSlotsFile(file);
    assert.equal(disk.version, 3);
    assert.deepEqual(
      disk.defaults,
      { "display-1": { st9: rows } },
      "a v2 file's boards are the service type's DEFAULTS — the day this lands nothing on any screen may change",
    );
    assert.deepEqual(disk.overrides, {}, "a v2 file has no per-plan exceptions to inherit");
    assert.ok(migrated, "converting v2 is a migration and is logged as one");
  });

  it("a v3 file loads as it is", () => {
    const on_disk = {
      version: 3,
      defaults: { v1: { st9: [slot("a", "01")] } },
      overrides: { v1: { p7: { serviceTypeId: "st9", sortDate: "2026-09-10", slots: [slot("b", "02")] } } },
    };
    const { file, migrated } = normaliseSlotsFile(structuredClone(on_disk));
    assert.deepEqual(serialiseSlotsFile(file), on_disk, "a v3 file round-trips byte for byte");
    assert.equal(migrated, null, "an already-v3 file is not re-migrated on every load");
  });

  it("a v1 service-type map lands under display-1's defaults", () => {
    const { defaults, overrides } = serialiseSlotsFile(normaliseSlotsFile({ st9: [slot("a", "01")] }).file);
    assert.deepEqual(Object.keys(defaults), ["display-1"]);
    assert.deepEqual(Object.keys(defaults["display-1"]), ["st9"]);
    assert.deepEqual(overrides, {});
  });

  it("a v0 flat array lands under display-1/default", () => {
    const { defaults, overrides } = serialiseSlotsFile(normaliseSlotsFile([slot("a", "01")]).file);
    assert.equal(defaults["display-1"].default.length, 1);
    assert.deepEqual(overrides, {});
  });

  it("an empty file is not reported as a migration", () => {
    const { file, migrated } = normaliseSlotsFile({});
    assert.deepEqual(serialiseSlotsFile(file), { version: 3, defaults: {}, overrides: {} });
    assert.equal(migrated, null, "a first run must not write and log a migration of nothing");
  });

  it("still migrates old slot links, in BOTH halves", () => {
    const legacy = { kind: "pco", matchBy: "position", teamPositionName: "Keys", notesStartsWith: "2" };
    const { file } = normaliseSlotsFile({
      version: 3,
      defaults: { v1: { st9: [{ ...slot("a", "01"), link: legacy }] } },
      overrides: { v1: { p7: { serviceTypeId: "st9", sortDate: null, slots: [{ ...slot("b", "02"), link: legacy }] } } },
    });
    const expected = { kind: "pco", matchBy: "position", positions: [{ name: "Keys", notesStartsWith: "2" }] };
    const disk = serialiseSlotsFile(file);
    assert.deepEqual(disk.defaults.v1.st9[0].link, expected);
    assert.deepEqual(
      disk.overrides.v1.p7.slots[0].link,
      expected,
      "an override's slots go through the link migration too — it is the only half a live board may be reading",
    );
  });
});

describe("resolving a board", () => {
  it("prefers the current plan's override over the default", async () => {
    const k = freshKey();
    await slotsStore.setDefault(k, "st9", [slot("d", "01")]);
    await slotsStore.setOverride(k, "p7", "st9", [slot("o", "09")]);

    const resolved = await slotsStore.resolve(k, "st9", "p7");
    assert.equal(resolved.length, 1);
    assert.equal(
      resolved[0].id,
      "o",
      "a board saved for THIS plan is what the plan shows - the default is only what it comes back to",
    );
  });

  it("falls back to the default for a plan with no override", async () => {
    const k = freshKey();
    await slotsStore.setDefault(k, "st9", [slot("d", "01")]);
    await slotsStore.setOverride(k, "p7", "st9", [slot("o", "09")]);

    const resolved = await slotsStore.resolve(k, "st9", "p8");
    assert.equal(resolved[0]?.id, "d", "next week's plan goes back to the service type's default");
  });

  it("falls back to the default when no plan is selected", async () => {
    const k = freshKey();
    await slotsStore.setDefault(k, "st9", [slot("d", "01")]);
    await slotsStore.setOverride(k, "p7", "st9", [slot("o", "09")]);
    assert.equal((await slotsStore.resolve(k, "st9", null))[0]?.id, "d");
  });

  it("is empty with neither", async () => {
    const k = freshKey();
    assert.deepEqual(await slotsStore.resolve(k, "st9", "p7"), []);
    assert.deepEqual(await slotsStore.resolve(k, null, "p7"), []);
  });

  it("ignores an override saved against a different service type", async () => {
    const k = freshKey();
    await slotsStore.setDefault(k, "st9", [slot("d", "01")]);
    await slotsStore.setOverride(k, "p7", "st-other", [slot("o", "09")]);
    assert.equal(
      (await slotsStore.resolve(k, "st9", "p7"))[0]?.id,
      "d",
      "a plan id belongs to a type; a record for another type is not this type's override",
    );
  });
});

describe("reverting and promoting", () => {
  it("clearOverride reports whether there was one, and leaves the default alone", async () => {
    const k = freshKey();
    await slotsStore.setDefault(k, "st9", [slot("d", "01")]);
    await slotsStore.setOverride(k, "p7", "st9", [slot("o", "09")]);

    assert.equal(await slotsStore.clearOverride(k, "p7"), true);
    assert.equal(await slotsStore.clearOverride(k, "p7"), false, "nothing to revert is not a revert");
    assert.equal((await slotsStore.getDefault(k, "st9"))[0]?.id, "d");
    const onDisk = await readSlotsFile();
    assert.equal(k in onDisk.overrides, false, "an emptied key does not linger in the file");
  });

  it("promote copies the override onto the default THEN clears it", async () => {
    const k = freshKey();
    await slotsStore.setDefault(k, "st9", [slot("d", "01")]);
    await slotsStore.setOverride(k, "p7", "st9", [slot("o", "09")]);

    const promoted = await slotsStore.promoteOverride(k, "p7");
    assert.equal(promoted?.serviceTypeId, "st9");
    assert.equal(
      (await slotsStore.getDefault(k, "st9"))[0]?.id,
      "o",
      "Set as default makes this week's board the type's board",
    );
    assert.equal(
      await slotsStore.getOverride(k, "p7"),
      null,
      "the override goes, or the plan keeps a copy that can now drift from the default it just became",
    );
  });

  it("promote takes the service type from the OVERRIDE, not the caller", async () => {
    const k = freshKey();
    await slotsStore.setOverride(k, "p7", "st-youth", [slot("o", "09")]);
    await slotsStore.promoteOverride(k, "p7");
    assert.equal((await slotsStore.getDefault(k, "st-youth"))[0]?.id, "o");
    assert.deepEqual(await slotsStore.getDefault(k, "st9"), [], "no other type's board is touched");
  });

  it("promote on a plan with no override is a no-op", async () => {
    const k = freshKey();
    await slotsStore.setDefault(k, "st9", [slot("d", "01")]);
    assert.equal(await slotsStore.promoteOverride(k, "nope"), null);
    assert.equal((await slotsStore.getDefault(k, "st9"))[0]?.id, "d");
  });
});

describe("pruning overrides", () => {
  it("deletes only what the caller calls expired", async () => {
    const k = freshKey();
    await slotsStore.setOverride(k, `${k}-old`, "st9", [slot("a", "01")], "2020-01-01T00:00:00Z");
    await slotsStore.setOverride(k, `${k}-new`, "st9", [slot("b", "02")], "2099-01-01T00:00:00Z");
    await slotsStore.setDefault(k, "st9", [slot("d", "01")]);

    const pruned = await slotsStore.pruneOverrides((planId) => planId === `${k}-old`);

    assert.equal(pruned, 1);
    assert.equal(await slotsStore.getOverride(k, `${k}-old`), null);
    assert.ok(await slotsStore.getOverride(k, `${k}-new`), "a current plan's board is not old");
    assert.equal(
      (await slotsStore.getDefault(k, "st9"))[0]?.id,
      "d",
      "pruning never touches a default - that is the operator's standing board",
    );
  });

  it("prunes nothing when the caller cannot date anything", async () => {
    const k = freshKey();
    await slotsStore.setOverride(k, `${k}-p7`, "st9", [slot("a", "01")], null);
    assert.equal(await slotsStore.pruneOverrides(() => false), 0);
    assert.ok(await slotsStore.getOverride(k, `${k}-p7`));
  });
});

describe("prototype-reaching keys", () => {
  // Every one of these keys arrives from a request. `map["__proto__"]` is truthy,
  // so a `if (!map[k])` guard passes and the write lands on Object.prototype.
  it("are refused on every write path", async () => {
    await assert.rejects(() => slotsStore.setDefault("__proto__", "st9", []), /not an allowed identifier/);
    await assert.rejects(() => slotsStore.setDefault("v1", "__proto__", []), /not an allowed identifier/);
    await assert.rejects(() => slotsStore.setOverride("__proto__", "p7", "st9", []), /not an allowed identifier/);
    await assert.rejects(() => slotsStore.setOverride("v1", "__proto__", "st9", []), /not an allowed identifier/);
    await assert.rejects(() => slotsStore.setOverride("v1", "p7", "__proto__", []), /not an allowed identifier/);
    await assert.rejects(() => slotsStore.copyKey("v1", "__proto__", () => "x"), /not an allowed identifier/);
    await assert.rejects(() => slotsStore.copyKey("__proto__", "v1", () => "x"), /not an allowed identifier/);
    await assert.rejects(() => slotsStore.removeDisplay("__proto__"), /not an allowed identifier/);
  });

  // The two that got away. `clearOverride("v1", "__proto__")` resolved TRUE with
  // the file untouched — a revert that reported success having deleted nothing —
  // and promoteOverride reached `delete Object.prototype[planId]` and threw a
  // TypeError, which the route then answered as a 404. Both are reachable from
  // the LAN: the planId is a path segment.
  it("are refused on the planId of a revert and a promote, and change nothing on disk", async () => {
    const key = freshKey();
    await slotsStore.setOverride(key, `${key}-p1`, "st9", [slot("keep", "01")], "2026-09-10");
    const before = await fs.readFile(path.join(TMP, "slots.json"), "utf-8");

    for (const bad of ["__proto__", "constructor", "prototype"]) {
      await assert.rejects(() => slotsStore.clearOverride(key, bad), /planId: ".*" is not an allowed identifier/);
      await assert.rejects(() => slotsStore.promoteOverride(key, bad), /planId: ".*" is not an allowed identifier/);
      await assert.rejects(() => slotsStore.getOverride(key, bad), /planId: ".*" is not an allowed identifier/);
    }

    assert.equal(
      await fs.readFile(path.join(TMP, "slots.json"), "utf-8"),
      before,
      "a refused request writes nothing — and reporting a revert that deleted nothing is how an operator loses a board they thought they had put back",
    );
    assert.equal((await slotsStore.getOverride(key, `${key}-p1`))?.slots[0]?.id, "keep");
  });

  // resolve() is the read every screen's rows come through. It skips rather than
  // throws, because an unsafe key reaching it means some caller is confused, not
  // that the wall should go blank.
  it("make resolve fall back rather than throw", async () => {
    const key = freshKey();
    await slotsStore.setDefault(key, "st9", [slot("standing", "01")]);
    assert.equal((await slotsStore.resolve(key, "st9", "__proto__"))[0]?.id, "standing");
    assert.deepEqual(await slotsStore.resolve("__proto__", "st9", null), []);
  });
});

// normaliseSlotsFile decides which of four shapes is on disk, and a v3 envelope
// that has lost its `version` stamp used to fall through to the v2 branch. That
// re-keys the WHOLE envelope under `defaults.defaults`, so every board on every
// wall reads empty — and loadNormalised then persists it in that shape, which
// makes the damage permanent.
describe("a v3 envelope with no version stamp", () => {
  it("is still read as v3, not re-keyed under defaults.defaults", () => {
    const raw = {
      defaults: { "display-1": { st9: [slot("standing", "01")] } },
      overrides: { "display-1": { p1: { serviceTypeId: "st9", sortDate: null, slots: [slot("week", "02")] } } },
    };

    const { file, migrated } = normaliseSlotsFile(raw);
    const disk = serialiseSlotsFile(file);

    assert.equal(disk.defaults["display-1"]?.st9?.[0]?.id, "standing");
    assert.equal(disk.overrides["display-1"]?.p1?.slots[0]?.id, "week");
    assert.equal(
      (disk.defaults as Record<string, unknown>).defaults,
      undefined,
      "the v2 branch would have nested the envelope inside itself and blanked every wall",
    );
    assert.match(String(migrated), /no version stamp/, "and it is restamped on disk, with a line saying so");
  });

  it("still reads a real v2 file as v2", () => {
    const { defaults, overrides } = serialiseSlotsFile(
      normaliseSlotsFile({ "display-1": { st9: [slot("standing", "01")] } }).file,
    );
    assert.equal(defaults["display-1"]?.st9?.[0]?.id, "standing");
    assert.deepEqual(overrides, {}, "a v2 file has no overrides half at all");
  });
});

describe("copying a key", () => {
  it("carries every service type's default AND every override, with fresh ids", async () => {
    const src = freshKey();
    const dst = freshKey();
    await slotsStore.setDefault(src, "st9", [slot("a", "01")]);
    await slotsStore.setDefault(src, "st-youth", [slot("b", "02")]);
    await slotsStore.setOverride(src, `${src}-p7`, "st9", [slot("c", "03")], "2026-09-10");

    let n = 0;
    await slotsStore.copyKey(src, dst, () => `${dst}-fresh-${++n}`);

    assert.equal((await slotsStore.getDefault(dst, "st9"))[0].id, `${dst}-fresh-1`);
    assert.equal((await slotsStore.getDefault(dst, "st-youth"))[0].id, `${dst}-fresh-2`);
    const copied = await slotsStore.getOverride(dst, `${src}-p7`);
    assert.equal(
      copied?.slots[0].id,
      `${dst}-fresh-3`,
      "a duplicate shows what its source shows today, not next week's board",
    );
    assert.equal(copied?.sortDate, "2026-09-10", "the copied override keeps its date, so it still prunes");
    assert.equal((await slotsStore.getDefault(src, "st9"))[0].id, "a", "the source is untouched");
  });
});
