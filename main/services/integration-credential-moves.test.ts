// A stored integration credential goes only to the address it was entered for.
//
// The settings form posts an unchanged password back as the mask, and the mask
// keeps the stored value. So a save that changed only the host kept the
// credential, and the next connect or Test sent it there: any settings write
// could point ProdCom, OBS, Smaart or PVP at another machine and collect the
// key. Driven through integrationManager.setConfig, the real body of POST
// /api/integrations/:id/config, with each integration left DISABLED so nothing
// is dialled. The state map is seeded as safespace-marker-writes.test.ts does,
// because init() starts timers a test cannot stop.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-credential-moves-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { integrationManager, INTEGRATION_DESCRIPTORS, secretKeysFor } = await import("./integration-manager.js");
const { credentialTargetIds } = await import("./integration-targets.js");
const { secretsStore } = await import("./secrets.js");
const { settingsStore } = await import("./settings-store.js");
const { MASK } = await import("./mask.js");

/** Each integration with a credential sent to a typed address, and a working
 *  config for it. The hosts are documentation addresses: nothing is dialled. */
const CASES = [
  { id: "obs", key: "password", config: { host: "obs-a.example", port: 4455 } },
  { id: "prodcom", key: "apiKey", config: { host: "prodcom-a.example", port: 8000 } },
  { id: "pvp", key: "token", config: { host: "pvp-a.example", port: 50742, https: "on" } },
  { id: "smaart", key: "password", config: { host: "smaart-a.example", port: 26000 } },
] as const;

let warned: string[] = [];
const realWarn = console.warn;

function seedState(id: string): void {
  (integrationManager as unknown as { states: Map<string, unknown> }).states.set(id, {
    id,
    enabled: false,
    connection: "disconnected",
    message: null,
    config: {},
  });
}

const stored = async (id: string, key: string) => (await secretsStore.getSecrets(id))[key];

beforeEach(async () => {
  warned = [];
  console.warn = (...args: unknown[]) => void warned.push(args.join(" "));
  for (const c of CASES) {
    seedState(c.id);
    await secretsStore.setSecrets(c.id, {});
    await settingsStore.removeIntegrationConfigKeys(c.id, ["host", "port", "https"]);
  }
});

afterEach(() => {
  console.warn = realWarn;
});

test("the integrations whose credential follows a typed address are exactly the ones with a host and a password field", () => {
  // Read off the descriptors the server ships, so an integration added with a
  // host and a password cannot be left out of the targets and keep its
  // credential across a move.
  const expected = INTEGRATION_DESCRIPTORS.filter((d) => {
    const keys = d.configSchema.map((f) => f.key);
    return keys.includes("host") && d.configSchema.some((f) => f.type === "password");
  })
    .map((d) => d.id)
    .sort();
  assert.deepEqual(credentialTargetIds(), expected);
  assert.deepEqual(credentialTargetIds(), [
    "obs",
    "prodcom",
    "pvp",
    "smaart",
  ]);
  // Every secret those hold is the one sent to the target, so a restore may
  // clear the whole slot (restore-credentials.ts).
  for (const c of CASES) assert.deepEqual([...secretKeysFor(c.id)], [c.key]);
});

for (const c of CASES) {
  describe(c.id, () => {
    test("a save that moves the host clears the stored credential, and says so", async () => {
      await integrationManager.setConfig(c.id, { ...c.config, [c.key]: "entered-for-a" });
      assert.equal(await stored(c.id, c.key), "entered-for-a", "precondition: the credential was stored");

      const state = await integrationManager.setConfig(c.id, { ...c.config, host: "attacker.example", [c.key]: MASK });
      assert.equal(await stored(c.id, c.key), undefined, "the credential survived a move to another host");
      assert.equal(state.config[c.key], "", "the form should be told the field is empty now");
      const line = warned.find((l) => l.includes(`on ${c.id}:`));
      assert.ok(line, `nothing logged the cleared credential:\n${warned.join("\n")}`);
      assert.match(line, /attacker\.example/);
      assert.ok(!line.includes("entered-for-a"), "the log line carried the credential itself");
    });

    test("so does one that only changes the port", async () => {
      await integrationManager.setConfig(c.id, { ...c.config, [c.key]: "entered-for-a" });
      await integrationManager.setConfig(c.id, { ...c.config, port: 9 });
      assert.equal(await stored(c.id, c.key), undefined);
    });

    test("a move that carries the credential again keeps the new one", async () => {
      await integrationManager.setConfig(c.id, { ...c.config, [c.key]: "entered-for-a" });
      await integrationManager.setConfig(c.id, { ...c.config, host: "moved.example", [c.key]: "entered-for-b" });
      assert.equal(await stored(c.id, c.key), "entered-for-b");
    });

    test("a save that leaves the address alone keeps it, whatever case the host is typed in", async () => {
      await integrationManager.setConfig(c.id, { ...c.config, [c.key]: "entered-for-a" });
      await integrationManager.setConfig(c.id, { ...c.config, host: c.config.host.toUpperCase(), [c.key]: MASK });
      assert.equal(await stored(c.id, c.key), "entered-for-a");
      assert.deepEqual(warned.filter((l) => l.includes("cleared the stored")), []);
    });
  });
}

test("the form posting a default port it seeded is not a move", async () => {
  // The settings form fills an unset port with the integration's default and
  // posts it on every save. A comparison of raw values would read that as a
  // new port and clear the password on a save that changed nothing.
  await integrationManager.setConfig("obs", { host: "obs-a.example", password: "entered-for-a" });
  await integrationManager.setConfig("obs", { host: "obs-a.example", port: 4455, password: MASK });
  assert.equal(await stored("obs", "password"), "entered-for-a");

  await integrationManager.setConfig("smaart", { host: "smaart-a.example", password: "entered-for-a" });
  await integrationManager.setConfig("smaart", { host: "smaart-a.example", port: "26000" });
  assert.equal(await stored("smaart", "password"), "entered-for-a");
});

test("turning PVP's HTTPS off is a move: the token would go to the same host in the clear", async () => {
  await integrationManager.setConfig("pvp", { host: "pvp-a.example", port: 50742, https: "on", token: "entered-for-https" });
  await integrationManager.setConfig("pvp", { host: "pvp-a.example", port: 50742, https: "off", token: MASK });
  assert.equal(await stored("pvp", "token"), undefined);
});

test("turning it on is not: the token goes where it always did, inside TLS", async () => {
  await integrationManager.setConfig("pvp", { host: "pvp-a.example", port: 50742, https: "off", token: "entered-plain" });
  await integrationManager.setConfig("pvp", { host: "pvp-a.example", port: 50742, https: "on", token: MASK });
  assert.equal(await stored("pvp", "token"), "entered-plain");
});

test("a credential that cannot be cleared puts the old address back, so the next boot does not send it to the new one", async () => {
  await integrationManager.setConfig("obs", { host: "obs-a.example", port: 4455, password: "entered-for-a" });
  const realSet = secretsStore.setSecrets.bind(secretsStore);
  secretsStore.setSecrets = (async () => {
    throw new Error("disk full");
  }) as typeof secretsStore.setSecrets;
  try {
    await assert.rejects(integrationManager.setConfig("obs", { host: "attacker.example", port: 4455, password: MASK }), /disk full/);
  } finally {
    secretsStore.setSecrets = realSet;
  }
  // As the next boot would read them: the file, and secrets.bin.
  const onDisk = JSON.parse(await fs.readFile(path.join(TMP, "settings.json"), "utf8")) as {
    integrationConfigs: Record<string, Record<string, unknown>>;
  };
  assert.equal(onDisk.integrationConfigs.obs?.host, "obs-a.example", "the new address stayed on disk beside the old credential");
  assert.equal(await stored("obs", "password"), "entered-for-a");
});

test("an integration whose credential goes to a fixed service keeps it whatever else changes", async () => {
  seedState("resi");
  await integrationManager.setConfig("resi", { username: "someone@example.org", password: "entered-once" });
  await integrationManager.setConfig("resi", { username: "someone-else@example.org", password: MASK });
  assert.equal(await stored("resi", "password"), "entered-once");
});
