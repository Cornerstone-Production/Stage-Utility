// The operator's groups, quick messages and quick replies.
//
// What these pin is the PUT's refusals and the ids. Every limit is asserted by
// sending a body one past it and reading the reason back, and each refusal is
// followed by a read of the stored config, because "refused" that still saved
// is the failure that matters.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, test } from "node:test";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "messaging-store-"));
process.env.STAGE_UTILITY_DATA = DATA;

const { messagingStore, MessagingRefused, MessagingConflict } = await import("./messaging-store.js");
const { configFiles, runtimeFiles } = await import("./config-snapshot.js");
const { GROUP_ID } = await import("../types/messages.js");

const FILE = path.join(DATA, "messaging.json");
const onDisk = () => JSON.parse(fs.readFileSync(FILE, "utf8")) as { version: number; groups: { id: string; name: string }[] };

// Built at the version the store holds NOW, which is what a client that has just
// read the config sends.
const body = (over: Record<string, unknown> = {}) => ({
  version: messagingStore.get().version,
  groups: [],
  quickMessages: ["Walk now"],
  quickReplies: ["Copy"],
  ...over,
});

/** The refusal's reason, or a failure if the body was accepted. */
async function refusal(input: unknown): Promise<string> {
  try {
    await messagingStore.replace(input);
  } catch (err) {
    assert.ok(err instanceof MessagingRefused, `expected a MessagingRefused, got ${String(err)}`);
    return err.message;
  }
  assert.fail("the body was accepted");
}

const names = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Group ${i + 1}` }));

beforeEach(async () => {
  await messagingStore.init();
  await messagingStore.replace(body());
});

describe("classification", () => {
  test("is operator config, carried by a backup", () => {
    assert.ok(configFiles().includes("messaging.json"));
    assert.ok(!runtimeFiles().includes("messaging.json"));
  });
});

describe("replace", () => {
  test("issues an id to a group that has none, and keeps one that has", async () => {
    const first = await messagingStore.replace(body({ groups: [{ name: "Green room" }, { name: "Stage" }] }));
    const [green, stage] = first.config.groups;
    assert.match(green.id, GROUP_ID);
    assert.match(stage.id, GROUP_ID);
    assert.notEqual(green.id, stage.id);

    // Renaming keeps the id: a screen's membership points at it.
    const second = await messagingStore.replace(
      body({ groups: [{ id: green.id, name: "Greenroom" }, { id: stage.id, name: "Stage" }] }),
    );
    assert.deepEqual(second.config.groups.map((g) => g.id), [green.id, stage.id]);
    assert.equal(second.config.groups[0].name, "Greenroom");
    assert.deepEqual(second.removed, []);
  });

  test("returns the groups that are gone, by id and name", async () => {
    const { config } = await messagingStore.replace(
      body({ groups: [{ name: "Green room" }, { name: "Stage" }, { name: "Booth" }] }),
    );
    const [green, stage, booth] = config.groups;
    const out = await messagingStore.replace(body({ groups: [{ id: stage.id, name: "Stage" }] }));
    assert.deepEqual(out.removed, [green, booth]);
    assert.deepEqual(messagingStore.get().groups, [stage]);
  });

  test("trims, and writes what it stored to disk", async () => {
    await messagingStore.replace(body({ groups: [{ name: "  Green room  " }], quickMessages: ["  Walk now  "] }));
    assert.equal(messagingStore.get().groups[0].name, "Green room");
    assert.deepEqual(messagingStore.get().quickMessages, ["Walk now"]);
    assert.equal(onDisk().groups[0].name, "Green room");
  });

  test("get hands out a copy, so a caller cannot edit what the next reader sees", async () => {
    await messagingStore.replace(body({ groups: [{ name: "Stage" }] }));
    messagingStore.get().groups[0].name = "Edited";
    assert.equal(messagingStore.get().groups[0].name, "Stage");
  });
});

describe("a body the limits refuse leaves the stored config alone", () => {
  const cases: [string, () => unknown, RegExp][] = [
    ["a body that is not an object", () => "groups", /body must be/],
    ["a body with no version", () => ({ groups: [], quickMessages: [], quickReplies: [] }), /version \(number\) is required/],
    ["a version that is not a number", () => body({ version: "1" }), /version \(number\) is required/],
    ["groups missing", () => body({ groups: undefined }), /groups \(array\) is required/],
    ["quickMessages missing", () => body({ quickMessages: undefined }), /quickMessages \(array\) is required/],
    ["quickReplies missing", () => body({ quickReplies: undefined }), /quickReplies \(array\) is required/],
    ["a group name that is empty", () => body({ groups: [{ name: "   " }] }), /group name cannot be empty/],
    ["a group name past 40 characters", () => body({ groups: [{ name: "x".repeat(41) }] }), /at most 40/],
    ["21 groups", () => body({ groups: names(21) }), /groups can hold at most 20/],
    ["two groups with one name, in different case", () => body({ groups: [{ name: "Stage" }, { name: "STAGE" }] }), /two groups are named/],
    ["a group named Everyone", () => body({ groups: [{ name: "everyone" }] }), /built in/],
    ["a group that is not an object", () => body({ groups: ["Stage"] }), /every group must be/],
    ["a group name that is not text", () => body({ groups: [{ name: 5 }] }), /group name must be text/],
    ["an id that is not one this app issues", () => body({ groups: [{ id: "g-xyz", name: "Stage" }] }), /not one this app issued/],
    ["an id that is a prototype key", () => body({ groups: [{ id: "__proto__", name: "Stage" }] }), /not one this app issued/],
    ["a well-formed id nobody issued", () => body({ groups: [{ id: "g-00000000", name: "Stage" }] }), /no group has the id g-00000000/],
    ["25 quick messages", () => body({ quickMessages: Array.from({ length: 25 }, (_, i) => `m${i}`) }), /quickMessages can hold at most 24/],
    ["a quick message past 280 characters", () => body({ quickMessages: ["x".repeat(281)] }), /at most 280/],
    ["an empty quick message", () => body({ quickMessages: [""] }), /quick message cannot be empty/],
    ["13 quick replies", () => body({ quickReplies: Array.from({ length: 13 }, (_, i) => `r${i}`) }), /quickReplies can hold at most 12/],
    ["a quick reply past 60 characters", () => body({ quickReplies: ["x".repeat(61)] }), /at most 60/],
    ["a quick reply that is not text", () => body({ quickReplies: [null] }), /quick reply must be text/],
  ];
  for (const [what, make, reason] of cases) {
    test(what, async () => {
      await messagingStore.replace(body({ groups: [{ name: "Kept" }] }));
      const before = JSON.stringify(messagingStore.get());
      assert.match(await refusal(make()), reason);
      assert.equal(JSON.stringify(messagingStore.get()), before, "a refusal changed the live config");
      assert.equal(JSON.stringify(onDisk()), before, "a refusal changed the file");
    });
  }

  test("the limits are inclusive: 20 groups, 24 quick messages, 12 quick replies, 40/280/60 characters", async () => {
    const out = await messagingStore.replace({
      version: messagingStore.get().version,
      groups: [{ name: "x".repeat(40) }, ...names(19)],
      quickMessages: ["m".repeat(280), ...Array.from({ length: 23 }, (_, i) => `m${i}`)],
      quickReplies: ["r".repeat(60), ...Array.from({ length: 11 }, (_, i) => `r${i}`)],
    });
    assert.equal(out.config.groups.length, 20);
    assert.equal(out.config.quickMessages.length, 24);
    assert.equal(out.config.quickReplies.length, 12);
  });

  test("an id the body names twice", async () => {
    const { config } = await messagingStore.replace(body({ groups: [{ name: "Stage" }] }));
    const id = config.groups[0].id;
    // The second has to differ in name or the duplicate-name rule answers first.
    assert.match(await refusal(body({ groups: [{ id, name: "Stage" }, { id, name: "Booth" }] })), /appears twice/);
  });

  test("a group deleted in another tab cannot be brought back by a stale one", async () => {
    const { config } = await messagingStore.replace(body({ groups: [{ name: "Stage" }] }));
    const id = config.groups[0].id;
    await messagingStore.replace(body());
    assert.match(await refusal(body({ groups: [{ id, name: "Stage" }] })), /no group has the id/);
  });
});

describe("a save that fails", () => {
  test("leaves the config every reader sees as it was, and the next save works", async () => {
    const { config } = await messagingStore.replace(body({ groups: [{ name: "Kept" }] }));
    const before = JSON.stringify(messagingStore.get());
    // A file the write cannot replace: the temp file is written, then renamed
    // over a directory, which fails. What a full card or a read-only disk does.
    fs.rmSync(FILE);
    fs.mkdirSync(FILE);
    try {
      await assert.rejects(() => messagingStore.replace(body({ groups: [{ id: config.groups[0].id, name: "Renamed" }, { name: "Added" }] })));
      assert.equal(JSON.stringify(messagingStore.get()), before, "a save that failed changed the config readers are shown");
    } finally {
      fs.rmdirSync(FILE);
    }
    const retried = await messagingStore.replace(body({ groups: [{ id: config.groups[0].id, name: "Renamed" }] }));
    assert.equal(retried.config.version, config.version + 1, "the failed save used up a version");
    assert.deepEqual(onDisk().groups.map((g) => g.name), ["Renamed"]);
  });
});

describe("the version", () => {
  test("starts at 0 for a config that has never been saved, and goes up by one with every replace", async () => {
    const before = messagingStore.get().version;
    const one = await messagingStore.replace(body());
    const two = await messagingStore.replace(body());
    assert.equal(one.config.version, before + 1);
    assert.equal(two.config.version, before + 2);
    assert.equal(messagingStore.get().version, before + 2);
    assert.equal(onDisk().version, before + 2, "the version is in the file");
  });

  test("a body built from an older version is refused as a conflict, and nothing changes", async () => {
    const { config } = await messagingStore.replace(body({ groups: [{ name: "Kept" }] }));
    const stale = config.version - 1;
    const before = JSON.stringify(messagingStore.get());
    await assert.rejects(
      () => messagingStore.replace(body({ version: stale, groups: [], quickMessages: ["Gone"] })),
      (err: unknown) => err instanceof MessagingConflict && /changed in another window/.test(err.message),
    );
    assert.equal(JSON.stringify(messagingStore.get()), before, "a conflict changed the live config");
    assert.equal(JSON.stringify(onDisk()), before, "a conflict changed the file");
  });

  test("a version AHEAD of the stored one is a conflict too", async () => {
    await assert.rejects(() => messagingStore.replace(body({ version: messagingStore.get().version + 1 })), MessagingConflict);
  });

  test("a conflict is decided before the other rules: a stale body that is also invalid says to reload", async () => {
    await assert.rejects(() => messagingStore.replace(body({ version: -1, groups: [{ name: "" }] })), MessagingConflict);
  });
});

describe("concurrent saves", () => {
  test("each decides which groups were removed against the config the one before it left", async () => {
    const { config } = await messagingStore.replace(body({ groups: [{ name: "A" }, { name: "B" }] }));
    const [a, b] = config.groups;
    // Two calls made together, the second built from the version the first will
    // leave: the queue has to run them in order or the second is a conflict.
    const v = config.version;
    const [one, two] = await Promise.all([
      messagingStore.replace(body({ version: v, groups: [b] })),
      messagingStore.replace(body({ version: v + 1, groups: [] })),
    ]);
    assert.deepEqual(one.removed, [a]);
    assert.deepEqual(two.removed, [b], "the second save read the config as it stood before the first");
  });

  test("two saves built from the same version: one lands, the other is a conflict", async () => {
    const v = messagingStore.get().version;
    const results = await Promise.allSettled([
      messagingStore.replace(body({ version: v, groups: [{ name: "First" }] })),
      messagingStore.replace(body({ version: v, groups: [{ name: "Second" }] })),
    ]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected"]);
    assert.ok((results[1] as PromiseRejectedResult).reason instanceof MessagingConflict);
    assert.deepEqual(messagingStore.get().groups.map((g) => g.name), ["First"]);
  });
});
