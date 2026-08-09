// The Spectera base station's API password used to live in
// wireless-connections.json — a plaintext file listed in CONFIG_FILES, so it was
// written into every config snapshot, while the snapshot's own text told the
// operator "secrets are not included, so the file is safe to store". It was also
// returned unmasked by GET /api/wireless/connections and broadcast over SSE; the
// UI masked it only after the cleartext had already crossed the LAN.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MASK,
  credentialKeys,
  mergeSecrets,
  publicConfig,
  splitConfig,
  withSecrets,
} from "./wireless-credentials.js";

const SPECTERA = "sennheiser-spectera";
const full = { host: "192.168.1.130", port: 443, password: "hunter2" };

describe("credentialKeys", () => {
  it("finds the password field from the provider's own schema", () => {
    assert.deepEqual(credentialKeys(SPECTERA), ["password"]);
  });

  it("is empty for a provider with no credentials, and for an unknown one", () => {
    assert.deepEqual(credentialKeys("shure-ulxd"), []);
    assert.deepEqual(credentialKeys("no-such-provider"), []);
  });
});

describe("splitConfig", () => {
  it("keeps the password out of what gets persisted", () => {
    const { safe, secret } = splitConfig(SPECTERA, full);
    assert.deepEqual(safe, { host: "192.168.1.130", port: 443 });
    assert.equal("password" in safe, false, "password must not survive into the config file");
    assert.deepEqual(secret, { password: "hunter2" });
  });

  it("never stores the mask as if it were a password", () => {
    const { secret } = splitConfig(SPECTERA, { ...full, password: MASK });
    assert.deepEqual(secret, {});
  });

  it("leaves a provider without credentials untouched", () => {
    const cfg = { host: "10.0.0.9", port: 2202 };
    assert.deepEqual(splitConfig("shure-ulxd", cfg).safe, cfg);
  });
});

describe("publicConfig", () => {
  it("masks a set password and never emits the value", () => {
    const out = publicConfig(SPECTERA, full);
    assert.equal(out.password, MASK);
    assert.equal(JSON.stringify(out).includes("hunter2"), false);
  });

  it("shows an unset password as empty, not as a mask", () => {
    // A mask over nothing would tell the operator a password is set when none is.
    assert.equal(publicConfig(SPECTERA, { ...full, password: "" }).password, "");
  });

  it("passes non-credential values through unchanged", () => {
    const out = publicConfig(SPECTERA, full);
    assert.equal(out.host, "192.168.1.130");
    assert.equal(out.port, 443);
  });
});

describe("mergeSecrets", () => {
  const stored = { password: "hunter2" };

  it("keeps the stored password when the form posts back the mask", () => {
    // Editing only the IP must not blank the password.
    const next = mergeSecrets(SPECTERA, { host: "10.1.1.1", password: MASK }, stored);
    assert.deepEqual(next, { password: "hunter2" });
  });

  it("keeps it when the patch does not mention the field at all", () => {
    assert.deepEqual(mergeSecrets(SPECTERA, { host: "10.1.1.1" }, stored), { password: "hunter2" });
  });

  it("replaces it with a genuinely new value", () => {
    assert.deepEqual(mergeSecrets(SPECTERA, { password: "new-pass" }, stored), { password: "new-pass" });
  });

  it("treats an empty string as an explicit clear", () => {
    assert.deepEqual(mergeSecrets(SPECTERA, { password: "" }, stored), {});
  });

  it("recognises the panel's longer mask, not just this module's constant", () => {
    // The panel renders "••••••••" into the field it shows. If only the exact
    // 4-bullet MASK counted, saving any other field would store a row of bullets
    // as the base station's password — and the UI shows bullets either way, so
    // nothing would look wrong until the receiver stopped connecting.
    assert.deepEqual(mergeSecrets(SPECTERA, { password: "••••••••" }, stored), { password: "hunter2" });
    assert.deepEqual(splitConfig(SPECTERA, { ...full, password: "••••••••" }).secret, {});
  });
});

describe("rebuilding a connection's config from a patch", () => {
  // What wireless-manager.updateConnection does. Spreading the patch straight
  // over the existing config cannot CLEAR a credential — an object that merely
  // lacks the key does not delete it — so a cleared password stayed live in
  // memory, the API kept reporting it as set, and the driver kept using it.
  const rebuild = (existing: Record<string, unknown>, patch: Record<string, unknown>) => {
    const merged = mergeSecrets(SPECTERA, patch, splitConfig(SPECTERA, existing).secret);
    return withSecrets(
      { ...splitConfig(SPECTERA, existing).safe, ...splitConfig(SPECTERA, patch).safe },
      merged,
    );
  };

  it("clears the password when the patch clears it", () => {
    const next = rebuild(full, { host: "10.0.0.99", port: 443, password: "" });
    assert.equal(next.password, undefined, "the old password must not survive a clear");
    assert.equal(next.host, "10.0.0.99");
  });

  it("keeps the password when the patch only changes the host", () => {
    const next = rebuild(full, { host: "10.0.0.99", port: 443, password: MASK });
    assert.equal(next.password, "hunter2");
    assert.equal(next.host, "10.0.0.99");
  });

  it("replaces the password when a new one is given", () => {
    assert.equal(rebuild(full, { password: "changed" }).password, "changed");
  });
});

describe("withSecrets", () => {
  it("gives the driver the real password back", () => {
    assert.deepEqual(withSecrets({ host: "h", port: 443 }, { password: "hunter2" }), {
      host: "h",
      port: 443,
      password: "hunter2",
    });
  });

  it("round-trips: split then rejoin is the original config", () => {
    const { safe, secret } = splitConfig(SPECTERA, full);
    assert.deepEqual(withSecrets(safe, secret), full);
  });
});
