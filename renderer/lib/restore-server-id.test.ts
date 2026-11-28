import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asksReplaces, configServerId, releasesBindings, restoreQuestion, RELEASE_LINE } from "./restore-server-id.js";

const OWN = "3f2a9c1e-5b7d-4e21-9a0c-6d8e2f41b7a3";
const OTHER = "7c1e04ab-92f3-4d6a-b1e8-0f5c3a9d2e64";

describe("asksReplaces", () => {
  it("asks when the config was saved on another server", () => assert.equal(asksReplaces(OTHER, OWN), true));
  it("asks when this server has no id yet", () => assert.equal(asksReplaces(OTHER, null), true));
  it("does not ask when the config is this server's own", () => assert.equal(asksReplaces(OWN, OWN), false));
  it("does not ask when the config names no server", () => {
    assert.equal(asksReplaces(null, OWN), false);
    assert.equal(asksReplaces(undefined, OWN), false);
  });
});

describe("configServerId", () => {
  it("reads the id from the bundle's settings.json", () => {
    assert.equal(configServerId({ files: { "settings.json": { serverId: OTHER } } }), OTHER);
  });
  for (const bundle of [null, {}, { files: null }, { files: {} }, { files: { "settings.json": null } }, { files: { "settings.json": { serverId: 7 } } }, { files: { "settings.json": { serverId: "" } } }]) {
    it(`is null for ${JSON.stringify(bundle)}`, () => assert.equal(configServerId(bundle), null));
  }
});

describe("releasesBindings: the server's rule, seen from the dialog", () => {
  const base = { ownId: OWN, carriesScreens: true, carriesBindings: true, ownBindings: 2 };
  // [what differs from base, ticked?] -> releases this server's bindings
  const CASES: [string, Partial<typeof base> & { configId: string | null }, boolean, boolean][] = [
    ["another server's config, unticked", { configId: OTHER }, false, true],
    ["another server's config, ticked, with its own bindings", { configId: OTHER }, true, false],
    ["another server's config, ticked, with no bindings", { configId: OTHER, carriesBindings: false }, true, true],
    ["a config with no server id", { configId: null }, false, true],
    ["this server's own config", { configId: OWN }, false, false],
    ["this server's own config with no bindings", { configId: OWN, carriesBindings: false }, false, false],
    ["no screens set up here", { configId: OTHER, ownBindings: 0 }, false, false],
    ["a bundle with no screens", { configId: OTHER, carriesScreens: false }, false, false],
    ["screens here unknown", { configId: null, ownBindings: null as unknown as number }, false, true],
  ];
  for (const [what, over, ticked, want] of CASES) {
    it(`${what}${ticked ? " (ticked)" : ""}: ${want ? "releases" : "keeps"}`, () => {
      assert.equal(releasesBindings({ ...base, ...over }, ticked), want);
    });
  }

  it("the dialog carries the line for each answer exactly when that answer releases", () => {
    const q = restoreQuestion({ ...base, configId: OTHER }, "Restore as replacement");
    assert.equal(q.checkbox?.whenUnchecked, RELEASE_LINE);
    assert.equal(q.checkbox?.whenChecked, undefined);
    const quiet = restoreQuestion({ ...base, configId: null }, "Restore as replacement");
    assert.equal(quiet.checkbox, undefined);
    assert.equal(quiet.note, RELEASE_LINE);
  });
});
