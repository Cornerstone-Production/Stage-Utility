// A credential migration that cannot write must not take the box down with it.
//
// applySecretMigration is called from integrationManager.init(), which server.ts
// awaits at MODULE TOP LEVEL. A rejection out of a top-level await surfaces as an
// `uncaughtException` — not an `unhandledRejection`, and this repo's two handlers
// are deliberately different: the rejection handler keeps serving, the exception
// handler calls exitForRestart(100, 1). So a rejecting write meant exit 100, the
// supervisor restarting, the same write failing again, forever — with the HTTP
// server never binding, so /log and /api/version were gone too. That is exactly
// the stretch server.ts's own crash-handler comment calls least diagnosable.
//
// Reachable with a read-only data directory, a full disk, or EACCES after a chown
// during an install. Neither `setManySecrets` nor `removeIntegrationConfigKeys`
// was guarded; only `secretsStore.isUnreadable()` was.
//
// WHAT IS NOT COVERED HERE, said out loud. `integrationManager.init()` cannot be
// called from a unit test — it starts the reconnect timers and never lets the
// process exit — which is the same reason planSecretMigration, applySecretMigration
// and secretMigrationNotes are all pure-or-standalone and exported. So these cases
// drive the three pieces init calls, and the real getStates() that renders the
// result; the single line in init() that wires them together is read, not run.
//
// Every credential below is invented.

import assert from "node:assert/strict";
import { describe, test, before, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-secret-migration-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const {
  planSecretMigration,
  applySecretMigration,
  secretMigrationNotes,
  integrationManager,
} = await import("./integration-manager.js");
const { settingsStore } = await import("./settings-store.js");
const { secretsStore } = await import("./secrets.js");
import { errorMessage } from "./errors.js";
import type { IntegrationState } from "../types/integrations.js";

const SPACE_ID = "ss-invented-never-real-0003";
const VEA_SECRET = "vea-invented-client-secret-0003";

const realSetMany = secretsStore.setManySecrets.bind(secretsStore);
const realError = console.error;
let logs: string[] = [];

/** sensource's stored config as settings.json actually holds it. */
async function sensourceOnDisk(): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await fs.readFile(path.join(TMP, "settings.json"), "utf8")) as {
    integrationConfigs?: Record<string, Record<string, unknown>>;
  };
  return raw.integrationConfigs?.sensource ?? {};
}

describe("a credential migration that cannot write", () => {
  before(async () => {
    // The state an upgrading box is in: credentials still in settings.json.
    await settingsStore.patchIntegrationConfig("sensource", {
      clientId: "cid",
      clientSecret: VEA_SECRET,
      safeSpaceId: SPACE_ID,
    });
  });

  beforeEach(() => {
    logs = [];
    console.error = (...args: unknown[]) => {
      logs.push(args.map((a) => errorMessage(a)).join(" "));
    };
  });

  afterEach(() => {
    console.error = realError;
    secretsStore.setManySecrets = realSetMany;
  });

  test("returns the failure instead of rejecting — the boot-loop guard", async () => {
    // GUARD. With the write unwrapped this rejects, init() rejects, the top-level
    // await turns it into an uncaughtException and server.ts exits 100 on every
    // restart with nothing bound to answer /log.
    const settings = await settingsStore.load();
    const plan = planSecretMigration(settings.integrationConfigs ?? {});
    assert.ok(plan, "the fixture produced no migration to run");
    assert.deepEqual(
      [...plan.moved].sort(),
      ["sensource.clientSecret", "sensource.safeSpaceId"],
      "the fixture did not put both credentials in settings.json",
    );

    secretsStore.setManySecrets = async () => {
      throw Object.assign(new Error("EACCES: permission denied, open 'secrets.bin'"), {
        code: "EACCES",
      });
    };

    const result = await applySecretMigration(plan);

    assert.deepEqual(
      result,
      { moved: false, why: "EACCES: permission denied, open 'secrets.bin'" },
      "the migration did not return its failure as a value",
    );
  });

  test("says so on the log, with the count, the reason and what it means", async () => {
    // An operator at 9am on a Sunday gets one line naming what is still exposed.
    const settings = await settingsStore.load();
    const plan = planSecretMigration(settings.integrationConfigs ?? {})!;
    secretsStore.setManySecrets = async () => {
      throw new Error("ENOSPC: no space left on device");
    };

    await applySecretMigration(plan);

    const lines = logs.filter((l) => l.includes("could not be moved out of"));
    assert.equal(lines.length, 1, `expected exactly one line, got:\n${logs.join("\n")}`);
    assert.match(lines[0], /\[integration-manager\] 2 credential\(s\)/);
    assert.match(lines[0], /ENOSPC: no space left on device/);
    assert.match(lines[0], /remain in every config snapshot/);
  });

  test("leaves the credentials where the next boot looks for them", async () => {
    // The ordering is what makes continuing safe: the secrets are written before
    // settings.json is cleaned, so a failed write leaves BOTH copies in place
    // rather than neither.
    const settings = await settingsStore.load();
    const plan = planSecretMigration(settings.integrationConfigs ?? {})!;
    secretsStore.setManySecrets = async () => {
      throw new Error("EROFS: read-only file system");
    };

    await applySecretMigration(plan);

    const after = await sensourceOnDisk();
    assert.equal(after.clientSecret, VEA_SECRET, "the credential was removed from settings.json anyway");
    assert.equal(after.safeSpaceId, SPACE_ID, "the space id was removed from settings.json anyway");
  });

  test("names exactly the integrations it left behind", async () => {
    const settings = await settingsStore.load();
    const plan = planSecretMigration(settings.integrationConfigs ?? {})!;

    const failed = secretMigrationNotes(plan, { moved: false, why: "EACCES" });
    assert.deepEqual([...failed.keys()], ["sensource"], "the wrong integrations were marked");
    assert.match(failed.get("sensource")!, /still in every config snapshot/);

    // ...and a migration that worked marks nothing at all.
    assert.equal(secretMigrationNotes(plan, { moved: true }).size, 0);
  });
});

describe("the integration row carries the note", () => {
  const manager = integrationManager as unknown as {
    states: Map<string, IntegrationState>;
    migrationNotes: Map<string, string>;
  };
  const NOTE = "stored credentials could not be moved out of settings.json (EACCES), see /log";

  afterEach(() => {
    manager.migrationNotes = new Map();
  });

  const row = (id: string): IntegrationState => integrationManager.getStates().find((s) => s.id === id)!;

  test("appended to a row that is already saying something", () => {
    // GUARD. The note has to survive every connection report, because the
    // integration this is about is usually the one that cannot connect — its
    // credential never reached secrets.bin. Stored in `state.message` it would be
    // overwritten by the first setConnectionState call.
    manager.states.set("sensource", {
      id: "sensource",
      enabled: true,
      connection: "error",
      message: "Authenticating with SenSource Vea",
      config: { clientId: "cid" },
    });
    manager.migrationNotes = new Map([["sensource", NOTE]]);

    assert.equal(row("sensource").message, `Authenticating with SenSource Vea — ${NOTE}`);
  });

  test("stands alone on a row with nothing else to say", () => {
    manager.states.set("sensource", {
      id: "sensource",
      enabled: false,
      connection: "disconnected",
      message: null,
      config: { clientId: "cid" },
    });
    manager.migrationNotes = new Map([["sensource", NOTE]]);

    assert.equal(row("sensource").message, NOTE);
  });

  test("and every other row is untouched", () => {
    manager.states.set("obs", {
      id: "obs",
      enabled: true,
      connection: "connected",
      message: "Connected",
      config: {},
    });
    manager.migrationNotes = new Map([["sensource", NOTE]]);

    assert.equal(row("obs").message, "Connected");
    assert.equal(
      integrationManager.getStates().filter((s) => (s.message ?? "").includes(NOTE)).length,
      1,
      "the note leaked onto rows the migration never touched",
    );
  });
});
