import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attentionInput } from "../test-input.js";
import { duplicateServer } from "./duplicate-server.js";

const identity = (addresses: string[]) => ({
  serverIdentity: {
    id: "3f2a9c1e-5b7d-4e21-9a0c-6d8e2f41b7a3",
    check: { state: "ok", at: 1 },
    duplicates: addresses.map((address) => ({ address, since: 1 })),
  },
});
const run = (addresses: string[] | null, mood: "live" | "idle" = "idle") =>
  duplicateServer.items(
    attentionInput({ mood, state: (addresses ? identity(addresses) : {}) as unknown as StageState }),
  );

describe("duplicate-server source", () => {
  it("fires once per server heard with this id; critical while live", () => {
    const [item, ...rest] = run(["192.168.1.60"], "live");
    assert.deepEqual(rest, []);
    assert.equal(item.key, "duplicate-server:192.168.1.60");
    assert.equal(item.severity, "critical");
    assert.equal(item.title, "Another server shares this server's id");
    assert.equal(item.detail, "192.168.1.60 answers as this server · screens may jump between the two");
    assert.deepEqual(item.fix, { label: "Open setting", route: "/settings/advanced/network", flash: "server-id" });
  });

  it("is a warn when idle", () => {
    assert.equal(run(["192.168.1.60"])[0].severity, "warn");
  });

  it("lists each address", () => {
    assert.deepEqual(run(["192.168.1.60", "192.168.1.61"]).map((i) => i.key), [
      "duplicate-server:192.168.1.60",
      "duplicate-server:192.168.1.61",
    ]);
  });

  it("does not fire when no other server answers with this id", () => {
    assert.deepEqual(run([]), []);
  });

  it("contributes nothing from a server that does not report it", () => {
    assert.deepEqual(run(null), []);
  });
});
