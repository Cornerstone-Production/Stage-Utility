// Clearing a wireless password leaves a line in /log.
//
// Clearing a stored credential is an operator decision with no other trace: the
// field reads empty afterwards, which is also what it read while the value was
// still stored. The integrations say so (`[integration-manager] cleared 1 stored
// credential(s) on obs: password`); the wireless fold deleted a Spectera
// password in silence, and skipped a non-string in silence too.
//
// Driven through wirelessManager.updateConnection, the body of its route.
// Connections stay disabled, so nothing is dialled.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-wireless-credential-log-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { wirelessManager } = await import("./wireless-manager.js");
const { wirelessSecretSlot } = await import("./wireless-credentials.js");
const { secretsStore } = await import("./secrets.js");
const { MASK } = await import("./mask.js");

let lines: string[] = [];
const real = { log: console.log, warn: console.warn };
beforeEach(() => {
  lines = [];
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  console.warn = (...args: unknown[]) => void lines.push(args.join(" "));
});
afterEach(() => {
  console.log = real.log;
  console.warn = real.warn;
});

const SECRET = "entered-password";

async function connection(name: string): Promise<string> {
  const list = await wirelessManager.addConnection({ name, providerId: "sennheiser-spectera" });
  const id = list[list.length - 1]!.id;
  await wirelessManager.updateConnection({ id, patch: { config: { host: "spectera.example", password: SECRET } } });
  lines = [];
  return id;
}
const stored = async (id: string) => (await secretsStore.getSecrets(wirelessSecretSlot(id))).password;

describe("a Spectera password", () => {
  test("cleared from the panel says so in /log, by name and never by value", async () => {
    const id = await connection("Base station clear");
    await wirelessManager.updateConnection({ id, patch: { config: { host: "spectera.example", password: "" } } });
    assert.equal(await stored(id), undefined, "precondition: the password was cleared");
    const said = lines.filter((l) => l.startsWith("[wireless] cleared the stored password on Base station clear"));
    assert.equal(said.length, 1, `the password was cleared and /log has no line saying so. Saw: ${JSON.stringify(lines)}`);
    assert.ok(!lines.join("\n").includes(SECRET), "the log carried the password itself");
  });

  test("left as the mask writes no clear line", async () => {
    const id = await connection("Base station keep");
    await wirelessManager.updateConnection({ id, patch: { config: { host: "spectera.example", password: MASK } } });
    assert.equal(await stored(id), SECRET);
    assert.ok(!lines.some((l) => l.includes("cleared")), JSON.stringify(lines));
  });

  test("sent as a non-string is ignored out loud, and the stored one kept", async () => {
    const id = await connection("Base station junk");
    await wirelessManager.updateConnection({ id, patch: { config: { host: "spectera.example", password: 42 } } });
    assert.equal(await stored(id), SECRET, "a non-string replaced or deleted the stored password");
    assert.ok(
      lines.some((l) => l.startsWith("[wireless] ignoring a non-string credential on Base station junk") && l.includes("number")),
      `a junk password value was dropped in silence. Saw: ${JSON.stringify(lines)}`,
    );
    assert.ok(!lines.join("\n").includes(SECRET));
  });

  test("a clear that fails to save is not reported as done", async () => {
    const id = await connection("Base station failed save");
    const save = mock.method(secretsStore, "setManySecrets", async () => {
      throw new Error("disk full");
    });
    try {
      await assert.rejects(
        wirelessManager.updateConnection({ id, patch: { config: { host: "spectera.example", password: "" } } }),
        /disk full/,
      );
    } finally {
      save.mock.restore();
    }
    assert.ok(!lines.some((l) => l.includes("cleared")), `the log says the password was cleared, and the save failed. Saw: ${JSON.stringify(lines)}`);
  });
});
