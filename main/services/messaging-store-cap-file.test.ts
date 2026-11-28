// A messaging.json holding more than the app allows (a restore from a build with
// higher limits): the first entries up to each cap are kept, the rest are left
// out and the log says which rule they broke. Its own file because the file has
// to exist before the module loads.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { captureConsoleDuringAsync } from "./fixtures/capture-console.js";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "messaging-cap-"));
process.env.STAGE_UTILITY_DATA = DATA;

const hex8 = (n: number) => n.toString(16).padStart(8, "0");
fs.writeFileSync(
  path.join(DATA, "messaging.json"),
  JSON.stringify({
    groups: Array.from({ length: 22 }, (_, i) => ({ id: `g-${hex8(i)}`, name: `Group ${i}` })),
    quickMessages: Array.from({ length: 26 }, (_, i) => `message ${i}`),
    quickReplies: Array.from({ length: 14 }, (_, i) => `reply ${i}`),
  }),
);

let loaded!: typeof import("./messaging-store.js");
const warned = await captureConsoleDuringAsync(["warn"], async () => {
  loaded = await import("./messaging-store.js");
  await loaded.messagingStore.init();
});
const { messagingStore } = loaded;

test("keeps the first 20 groups, 24 quick messages and 12 quick replies, and says why the rest went", () => {
  const config = messagingStore.get();
  assert.deepEqual(config.groups.map((g) => g.name), Array.from({ length: 20 }, (_, i) => `Group ${i}`));
  assert.equal(config.quickMessages.length, 24);
  assert.equal(config.quickMessages.at(-1), "message 23");
  assert.equal(config.quickReplies.length, 12);
  assert.equal(config.quickReplies.at(-1), "reply 11");
  const line = warned.find((l) => l.startsWith("[messages] messaging.json")) ?? "";
  assert.match(line, /left out 6 entries/);
  assert.match(line, /groups can hold at most 20/);
  assert.match(line, /quick messages can hold at most 24/);
  assert.match(line, /quick replies can hold at most 12/);
});
