// The version a messaging.json carries is read back as written, and a file with
// none reads as 0. Its own file because the file has to exist before the module
// loads.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "messaging-version-"));
process.env.STAGE_UTILITY_DATA = DATA;

fs.writeFileSync(
  path.join(DATA, "messaging.json"),
  JSON.stringify({ version: 4, groups: [], quickMessages: ["Walk now"], quickReplies: ["Copy"] }),
);

const { messagingStore } = await import("./messaging-store.js");

test("a file's version is read as written, and the next replace builds on it", async () => {
  await messagingStore.init();
  assert.equal(messagingStore.get().version, 4);
  const { config } = await messagingStore.replace({ version: 4, groups: [], quickMessages: [], quickReplies: [] });
  assert.equal(config.version, 5);
});
